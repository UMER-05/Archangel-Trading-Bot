// backend/src/services/userWallet.service.ts
//
// Phase 1 of per-user custodial trading: generates and stores a dedicated
// hot-wallet keypair for each connected "owner" wallet (the wallet a user
// actually connects via Phantom/Solflare in the browser). The bot will
// trade using these generated wallets — funded by the owner depositing SOL
// into them — rather than the single shared ADMIN_WALLET_SECRET. Private
// keys are encrypted at rest (see utils/walletEncryption.ts); nothing here
// yet touches execution (that's a later phase) — this only covers
// generate/lookup/balance.
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { Collection, Db } from "mongodb";
import { getLogger } from "../utils/logger.js";
import { encryptSecret, decryptSecret } from "../utils/walletEncryption.js";
import {
  normalizeWalletAddress,
  getBalanceInSol,
  getConnection,
  getTokenBalance,
} from "./solana.service.js";
import { connect } from "./db.service.js";
import dbService from "./db.service.js";
import {
  isBotManagedOpenPosition,
  isOpenPosition,
} from "../utils/positionState.js";
import { getJupiterQuote, executeJupiterSwap } from "./jupiter.service.js";
import pnlTrackerService from "./pnlTracker.service.js";
import * as positionExitCoordinator from "./execution/positionExitCoordinator.service.js";
import { setAutoTradeEnabled } from "./traderConfig.service.js";
import { emitToWalletOrGlobal } from "../utils/walletSocket.js";
import type { Server } from "socket.io";

// Reserve for the transfer's own network fee — a "withdraw everything"
// request would otherwise try to send a balance that can't also cover the
// fee to send it, and fail.
const WITHDRAWAL_FEE_RESERVE_LAMPORTS = 5000;

const log = getLogger("userWallet.service");

export type UserWallet = {
  ownerWallet: string; // the wallet the user connects in the browser
  hotWalletPublicKey: string; // the bot-generated trading wallet's address
  encryptedSecretKey: string; // AES-256-GCM ciphertext of the base58 secret key
  createdAt: Date;
  // Newest transaction signature depositTracker.service.ts has already
  // classified for this wallet — lets its periodic scan resume from where
  // it left off instead of re-scanning full history every tick.
  lastScannedSignature?: string;
};

export type WalletWithdrawal = {
  ownerWallet: string;
  hotWalletPublicKey: string;
  signature: string;
  amountSol: number;
  timestamp: Date;
};

let col: Collection<UserWallet> | null = null;
let withdrawalsCol: Collection<WalletWithdrawal> | null = null;

async function getWithdrawalsCol(): Promise<Collection<WalletWithdrawal>> {
  if (withdrawalsCol) return withdrawalsCol;
  const db: Db = await connect();
  withdrawalsCol = db.collection<WalletWithdrawal>("walletWithdrawals");
  return withdrawalsCol;
}

async function getCol(): Promise<Collection<UserWallet>> {
  if (col) return col;
  const db: Db = await connect();
  col = db.collection<UserWallet>("userWallets");
  await col.createIndex({ ownerWallet: 1 }, { unique: true });
  await col.createIndex({ hotWalletPublicKey: 1 }, { unique: true });
  return col;
}

/**
 * Returns the existing hot wallet for this owner, generating one on first
 * call. Idempotent — safe to call every time a wallet connects.
 */
export async function getOrCreateUserWallet(
  ownerWalletRaw: string
): Promise<UserWallet> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const c = await getCol();

  const existing = await c.findOne({ ownerWallet });
  if (existing) return existing;

  const keypair = Keypair.generate();
  const doc: UserWallet = {
    ownerWallet,
    hotWalletPublicKey: keypair.publicKey.toBase58(),
    encryptedSecretKey: encryptSecret(bs58.encode(keypair.secretKey)),
    createdAt: new Date(),
  };

  try {
    await c.insertOne(doc);
    log.info(
      { ownerWallet, hotWallet: doc.hotWalletPublicKey },
      "Generated new custodial hot wallet"
    );
    return doc;
  } catch (err: any) {
    // Race: two near-simultaneous requests for the same never-before-seen
    // owner wallet. Unique index on ownerWallet rejects the loser — fetch
    // what the winner actually inserted instead of erroring the request.
    if (err?.code === 11000) {
      const winner = await c.findOne({ ownerWallet });
      if (winner) return winner;
    }
    throw err;
  }
}

export async function getUserWallet(
  ownerWalletRaw: string
): Promise<UserWallet | null> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const c = await getCol();
  return c.findOne({ ownerWallet });
}

/**
 * Decrypts and returns the actual signing keypair. Only for server-side use
 * at execution time (later phase) — never returned from an API response.
 */
export async function getUserWalletKeypair(
  ownerWalletRaw: string
): Promise<Keypair | null> {
  const wallet = await getUserWallet(ownerWalletRaw);
  if (!wallet) return null;
  const secretKey = bs58.decode(decryptSecret(wallet.encryptedSecretKey));
  return Keypair.fromSecretKey(secretKey);
}

export async function getUserWalletBalanceSol(
  ownerWalletRaw: string
): Promise<{ hotWalletPublicKey: string; balanceSol: number } | null> {
  const wallet = await getOrCreateUserWallet(ownerWalletRaw);
  const balanceSol = await getBalanceInSol(wallet.hotWalletPublicKey);
  return { hotWalletPublicKey: wallet.hotWalletPublicKey, balanceSol };
}

/**
 * Withdraws SOL from an owner's custodial hot wallet back to that SAME
 * owner's own connected wallet — never to an arbitrary caller-supplied
 * address, which is what makes this safe to expose even given a verified
 * signature: the destination is always the wallet that proved it owns this
 * hot wallet, so there's no address to trick the API into draining funds to.
 * Caller (the route) is responsible for verifying wallet-signature auth
 * BEFORE calling this — this function trusts ownerWalletRaw completely.
 */
export async function withdrawToOwner(
  ownerWalletRaw: string,
  amountSol: number
): Promise<{ signature: string; amountSol: number }> {
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    throw new Error("Withdrawal amount must be a positive number");
  }

  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);
  const wallet = await getUserWallet(ownerWallet);
  if (!wallet) {
    throw new Error("No trading wallet found for this owner");
  }

  const keypair = await getUserWalletKeypair(ownerWallet);
  if (!keypair) {
    throw new Error("Failed to load trading wallet keypair");
  }

  const balanceLamports = Math.round(
    (await getBalanceInSol(wallet.hotWalletPublicKey)) * LAMPORTS_PER_SOL
  );
  const requestedLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const maxWithdrawableLamports = balanceLamports - WITHDRAWAL_FEE_RESERVE_LAMPORTS;

  if (maxWithdrawableLamports <= 0) {
    throw new Error("Balance too low to cover the network fee");
  }
  if (requestedLamports > maxWithdrawableLamports) {
    throw new Error(
      `Requested ${amountSol} SOL exceeds withdrawable balance of ${(
        maxWithdrawableLamports / LAMPORTS_PER_SOL
      ).toFixed(6)} SOL (after reserving the network fee)`
    );
  }

  const conn = getConnection();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: new PublicKey(ownerWallet),
      lamports: requestedLamports,
    })
  );

  const latest = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = latest.blockhash;
  tx.feePayer = keypair.publicKey;
  tx.sign(keypair);

  const signature = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await conn.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  log.info(
    { ownerWallet, hotWallet: wallet.hotWalletPublicKey, amountSol, signature },
    "Withdrawal completed"
  );

  // Recorded directly here (not detected from chain, unlike deposits) —
  // this is our own app-initiated transfer, so we already know everything
  // about it. depositTracker.service.ts checks this collection so a
  // withdrawal is never mistaken for an external deposit.
  const withdrawals = await getWithdrawalsCol();
  await withdrawals.insertOne({
    ownerWallet,
    hotWalletPublicKey: wallet.hotWalletPublicKey,
    signature,
    amountSol: requestedLamports / LAMPORTS_PER_SOL,
    timestamp: new Date(),
  });

  return { signature, amountSol: requestedLamports / LAMPORTS_PER_SOL };
}

/** All owner wallets with a funded (non-dust) hot wallet — used by the
 * execution fan-out in a later phase to know who's actually eligible to
 * receive an auto-buy. Not used yet. */
export async function listAllUserWallets(): Promise<UserWallet[]> {
  const c = await getCol();
  return c.find({}).toArray();
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
export interface StopAutoTradeResult {
  disabledAutoTrade: boolean;
  sold: { token: string; signature: string | null; amountSol: number }[];
  failed: { token: string; error: string }[];
  // Records that still read as open but held nothing on-chain (already sold or
  // lost earlier, never marked closed). They are marked closed now rather than
  // reported as failed sells — there was nothing to sell.
  alreadyClosed: string[];
}

export type SellPositionOutcome =
  | { status: "sold"; token: string; signature: string | null; amountSol: number }
  | { status: "already_closed"; token: string }
  | { status: "failed"; token: string; error: string };

/**
 * Sells ONE bot-held (custodial) position in full from the owner's trading
 * wallet. Shared by "Sell All & Stop" (looping over every position) and the
 * single-position Sell button, so both behave identically.
 *
 * It takes the same position-exit claim the monitor takes before any of ITS
 * sells (execution/positionExitCoordinator.service.ts), so a manual sell can
 * never race a take-profit / stop-loss exit for the same position — whichever
 * gets the claim goes first, the other reports "already in flight".
 */
async function sellOneCustodialPosition(
  ownerWallet: string,
  pos: { token: string; avgBuyPrice?: number | undefined },
  keypair: Keypair,
  io: Server | undefined,
  reason: "stop_auto_trade" | "manual_sell"
): Promise<SellPositionOutcome> {
  const token = pos.token;

  const claimed = await positionExitCoordinator.claimPositionExit(
    token,
    ownerWallet
  );
  if (!claimed) {
    return {
      status: "failed",
      token,
      error: "The bot is already selling this position — try again in a moment",
    };
  }

  let sold = false;
  try {
    // Sell the real on-chain balance, not a DB-derived approximation —
    // avoids leaving unsellable dust behind from any drift between the two.
    const { raw, uiAmount } = await getTokenBalance(
      keypair.publicKey.toBase58(),
      token
    );
    if (!raw || raw === "0") {
      // Nothing held: the record is stale, not a failed sale. Close it so it
      // stops being monitored, counted and offered for sale.
      await dbService.updatePositionMetadata(token, ownerWallet, {
        remainingPct: 0,
      });
      pnlTrackerService.stopTracking(token, ownerWallet);
      return { status: "already_closed", token };
    }

    const quote = await getJupiterQuote(token, SOL_MINT, raw, 1000);
    if (!quote?.outAmount) {
      return { status: "failed", token, error: "No Jupiter route available" };
    }

    const swap = await executeJupiterSwap({
      inputMint: token,
      outputMint: SOL_MINT,
      amount: raw,
      userPublicKey: keypair.publicKey.toBase58(),
      slippageBps: 1000,
      signer: keypair,
    });
    if (!swap.success) {
      return { status: "failed", token, error: swap.error || "Swap failed" };
    }
    sold = true;

    const amountSol = Number(quote.outAmount) / 1e9;
    // What this sale actually realized, so stats and the trade feed reflect
    // it (this used to record the entry price and a 0% result).
    const exitPrice = uiAmount > 0 ? amountSol / uiAmount : (pos.avgBuyPrice ?? 0);
    const pnl =
      pos.avgBuyPrice && pos.avgBuyPrice > 0 && exitPrice > 0
        ? exitPrice / pos.avgBuyPrice - 1
        : 0;

    const trade = await dbService.addTrade({
      type: "sell",
      token,
      inputMint: token,
      outputMint: SOL_MINT,
      amount: Number(quote.outAmount),
      price: exitPrice,
      pnl,
      wallet: ownerWallet,
      simulated: false,
      signature: swap.signature ?? null,
      timestamp: new Date(),
      custody: "custodial",
    });

    // Sold in full: mark the position closed. Without this a sale at a loss
    // left it reading as open (netSol stays positive), so the monitor kept
    // trying to manage — and sell — tokens that were no longer there.
    await dbService.updatePositionMetadata(token, ownerWallet, {
      remainingPct: 0,
    });

    pnlTrackerService.stopTracking(token, ownerWallet);
    emitToWalletOrGlobal(io, ownerWallet, "tradeFeed", {
      ...trade,
      // "auto" = the bot's own trade (gets its own popup); a sale the user
      // asked for is announced like any other manual trade.
      auto: reason === "stop_auto_trade",
      reason,
    });

    return {
      status: "sold",
      token,
      signature: swap.signature ?? null,
      amountSol,
    };
  } catch (err: any) {
    return { status: "failed", token, error: err?.message || "Unknown error" };
  } finally {
    // Completed on a sale (blocks a duplicate exit), released otherwise so a
    // retry — or the monitor — can try again straight away.
    if (sold) {
      await positionExitCoordinator.completePositionExit(token, ownerWallet);
    } else {
      await positionExitCoordinator.releasePositionExit(token, ownerWallet);
    }
  }
}

/**
 * The single-position Sell button: sells one open bot position for this
 * owner. (A self-custody/manual position lives in the user's own wallet,
 * which only they can sign for — never the server; those use the Sell page.)
 */
export async function sellCustodialPosition(
  ownerWalletRaw: string,
  token: string,
  io?: Server
): Promise<SellPositionOutcome> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);

  const positions = await dbService.getPositions(ownerWallet);
  // custody !== "self" — the SAME test isBotManagedOpenPosition uses, and
  // that the monitor's own auto-sell loop and the Positions panel's decision
  // to show a Sell button both use. This used to require custody === exactly
  // "custodial", which excluded legacy positions bought before that field
  // existed (custody is null/undefined for those, per db.service.ts's
  // Position type) — every other part of the app already treated them as the
  // bot's, so the Sell button appeared for them but calling it always failed.
  const pos = positions.find(
    (p) => p.token === token && isBotManagedOpenPosition(p)
  );
  if (!pos) {
    return {
      status: "failed",
      token,
      error: "No open bot position found for this token",
    };
  }

  const keypair = await getUserWalletKeypair(ownerWallet);
  if (!keypair) {
    return { status: "failed", token, error: "No custodial signer available" };
  }

  return sellOneCustodialPosition(ownerWallet, pos, keypair, io, "manual_sell");
}

/**
 * "Stop Auto Trade": disables future auto-buys for this wallet AND
 * liquidates every open position the bot has already bought for it
 * (custody === "custodial" only — a self-custody/manual position lives in
 * the user's own wallet, which only they can sign for, never the server).
 * Disabling happens first, before any selling starts, so the bot can't
 * rebuy on its next discovery tick while this is still in progress.
 */
export async function stopAutoTradeAndLiquidate(
  ownerWalletRaw: string,
  io?: Server
): Promise<StopAutoTradeResult> {
  const ownerWallet = normalizeWalletAddress(ownerWalletRaw);

  await setAutoTradeEnabled(ownerWallet, false, io);
  const result: StopAutoTradeResult = {
    disabledAutoTrade: true,
    sold: [],
    failed: [],
    alreadyClosed: [],
  };

  const positions = await dbService.getPositions(ownerWallet);
  // Same fix as sellCustodialPosition above: custody !== "self", not
  // === "custodial", so legacy positions bought before custody was tracked
  // are still liquidated here instead of being silently left running with
  // auto-trade turned off.
  //
  // Wrapped in an arrow rather than passed directly — see the identical note
  // in monitor.service.ts's tick(): Array.filter's (element, index, array)
  // callback shape would otherwise feed the array INDEX into this function's
  // `dust` parameter, corrupting the check for every position past the first.
  const custodialOpen = positions.filter((p) => isBotManagedOpenPosition(p));
  if (custodialOpen.length === 0) return result;

  const keypair = await getUserWalletKeypair(ownerWallet);
  if (!keypair) {
    for (const p of custodialOpen) {
      result.failed.push({ token: p.token, error: "No custodial signer available" });
    }
    return result;
  }

  for (const pos of custodialOpen) {
    const outcome = await sellOneCustodialPosition(
      ownerWallet,
      pos,
      keypair,
      io,
      "stop_auto_trade"
    );
    if (outcome.status === "sold") {
      result.sold.push({
        token: outcome.token,
        signature: outcome.signature,
        amountSol: outcome.amountSol,
      });
    } else if (outcome.status === "already_closed") {
      result.alreadyClosed.push(outcome.token);
    } else {
      result.failed.push({ token: outcome.token, error: outcome.error });
    }
  }

  return result;
}

export default {
  getOrCreateUserWallet,
  getUserWallet,
  getUserWalletKeypair,
  getUserWalletBalanceSol,
  withdrawToOwner,
  listAllUserWallets,
  stopAutoTradeAndLiquidate,
  sellCustodialPosition,
};