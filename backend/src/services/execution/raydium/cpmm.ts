// backend/src/services/execution/raydium/cpmm.ts
//
// The first (and, on purpose, only) native executor implemented so far —
// see docs/native-swap-fund-safety-spec.md, which this file is checked
// against line by line. CPMM specifically because it's the simplest
// Raydium pool type (constant-product, no tick math), matching doc 13's
// "prove it on CPMM first, with small real position sizes, before
// touching AMM V4 or CLMM."
//
// Compiles clean against the installed @raydium-io/raydium-sdk-v2 as of
// this writing. `isCreatorFeeOnInput` (see deriveIsCreatorFeeOnInput) is
// derived from a real, live-confirmed API field value now, not hardcoded —
// but one of its two branches was inferred from naming convention rather
// than independently observed; see that function's own comment for exactly
// which part still carries residual uncertainty.
//
// A real bug was found and fixed on the first-ever live trade:
// associatedOnly: false (originally set to work around a documented SDK
// ATA-creation issue) caused the SDK to create and use its OWN
// non-standard token account for swap proceeds, separate from the
// canonical ATA this file's own buildEnsureAtaInstruction had already
// created — tokens landed in an account this code didn't know to look
// for, and the canonical ATA sat empty. Now associatedOnly: true, so the
// SDK is forced to use only the standard ATA our own instruction already
// guarantees exists. If you're reading this after another live trade
// behaved unexpectedly, re-verify this specific interaction first.
//
// Send/confirm goes through transaction/sender.ts, which handles
// retry-with-fresh-blockhash, landed-but-reverted detection, and a
// double-execution guard — a single send()+confirmTransaction() call was
// the original gap doc 12/13 flagged, since a hand-built executor has none
// of Jupiter's own resilience (doc 13 point 12).
//
// This module never gets imported by anything at startup on its own —
// registerNativeExecutors.ts is what conditionally wires it into
// NATIVE_EXECUTOR_REGISTRY, gated by RAYDIUM_CPMM_EXECUTOR_ENABLED, which
// is independent of (and layered under) executionRouter.service.ts's own
// RAYDIUM_NATIVE_EXECUTION_ENABLED — both must be true before this ever
// runs for a real candidate.
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  CurveCalculator,
  Raydium,
  TxVersion,
} from "@raydium-io/raydium-sdk-v2";
import { getConnection } from "../../solana.service.js";
import { getLogger } from "../../../utils/logger.js";
import {
  buildWrapSolInstructions,
  buildUnwrapSolInstruction,
  NATIVE_MINT,
} from "../transaction/wsol.js";
import { buildEnsureAtaInstruction } from "../transaction/ata.js";
import { computeMinimumAmountOut } from "../transaction/minOut.js";
import { sendAndConfirmWithRetry } from "../transaction/sender.js";
import type { TxBuilder } from "../transaction/sender.js";
import {
  buildJitoTipInstruction,
  getJitoTipLamports,
  sendViaJitoBundle,
} from "../transaction/jitoSender.js";
import { RAYDIUM_PROGRAM_IDS } from "../raydiumProgramIds.js";
import type {
  NativeExecutionResult,
  NativeExecutor,
  NativeExecutorContext,
} from "../nativeExecutor.types.js";
import type { CandidateMint } from "../../tokenExtraction.service.js";

const LOG = getLogger("cpmm-executor");
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Default slippage tolerance for a fresh-pool snipe buy. Deliberately
// configurable via env rather than hardcoded, since this is exactly the
// kind of number that needs tuning from real observed fill data — see the
// spec's §3 pass/fail test.
function getSlippage(): number {
  const pct = Number(process.env.RAYDIUM_CPMM_SLIPPAGE_PCT ?? "2");
  return pct / 100;
}

// Real fix for what used to be a hardcoded `false` here. Confirmed via a
// live Raydium API response (a real WSOL/USDC pool) that poolInfo.feeOn is
// the string "Both" — matching the SDK's own internal
// `isCreatorFeeOnInput = feeOn === FeeOn.BothToken || feeOn === FeeOn.OnlyTokenB`
// (see raydium-sdk-v2's cpmm.ts on GitHub). "Both" is independently
// confirmed; the exact string for the OnlyTokenB case was not, so this
// accepts a couple of plausible spellings rather than picking one and
// silently getting it wrong, and logs loudly on anything unrecognized so
// a genuinely new value surfaces during testing instead of silently
// miscalculating the swap quote.
function deriveIsCreatorFeeOnInput(feeOn: string | undefined): boolean {
  const normalized = (feeOn ?? "").trim();
  if (normalized === "Both" || normalized === "BothToken") return true;
  if (normalized === "OnlyTokenB" || normalized === "OnlyB") return true;
  if (
    normalized === "OnlyTokenA" ||
    normalized === "OnlyA" ||
    normalized === ""
  ) {
    return false;
  }
  LOG.warn(
    { feeOn },
    "Unrecognized poolInfo.feeOn value — defaulting isCreatorFeeOnInput to false, verify this pool's fee config manually",
  );
  return false;
}

// See docs/mev-jito-routing-spec.md. "rpc" (default, today's existing
// behavior, untouched) or "jito" (append a tip instruction, submit via
// Jito's Block Engine instead of a plain RPC call — see jitoSender.ts).
// Deliberately just two values, read fresh each call rather than cached,
// so flipping the env var takes effect on the next trade without a
// restart-dependent cache to worry about.
type SendStrategy = "rpc" | "jito";
function getSendStrategy(): SendStrategy {
  return process.env.RAYDIUM_SEND_STRATEGY === "jito" ? "jito" : "rpc";
}

/**
 * Rebuilds `original`'s instruction list with instructions inserted before
 * and/or after it, then recompiles to a fresh V0 message. Used instead of
 * trusting raydium-sdk-v2's own config.associatedOnly/checkCreateATAOwner
 * flags as the sole source of WSOL/ATA instructions — see the fund-safety
 * spec §1 for the documented SDK issue that motivates this. Decompiling
 * and recompiling a V0 message (rather than hand-parsing raw bytes) is
 * standard @solana/web3.js API, not something specific to raydium-sdk-v2's
 * internals.
 *
 * `append` matters for the sell path specifically: the WSOL-unwrap/close
 * instruction (spec §1) has to run AFTER the swap instruction, since it's
 * unwrapping the SOL the swap itself just produced — putting it in
 * `prepend` would close the account before the swap ever deposits into it.
 */
async function rebuildTransaction(
  connection: Connection,
  original: VersionedTransaction,
  payer: PublicKey,
  extra: {
    prepend?: TransactionInstruction[];
    append?: TransactionInstruction[];
  },
  blockhash: { blockhash: string; lastValidBlockHeight: number },
): Promise<VersionedTransaction> {
  const lookupTableAccounts: AddressLookupTableAccount[] = [];
  for (const lookup of original.message.addressTableLookups) {
    const res = await connection.getAddressLookupTable(lookup.accountKey);
    if (res.value) lookupTableAccounts.push(res.value);
  }

  const decompiled = TransactionMessage.decompile(original.message, {
    addressLookupTableAccounts: lookupTableAccounts,
  });

  // Use a freshly-fetched blockhash (paired with its own
  // lastValidBlockHeight) rather than whatever the SDK's internally-built
  // transaction happened to carry — we need the two values to come from
  // the SAME getLatestBlockhash() call so confirmTransaction's expiry
  // check is checking the blockhash we actually signed, not a mismatched
  // pair that can make a perfectly valid send look expired (or worse,
  // silently mis-time out).
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash.blockhash,
    instructions: [
      ...(extra.prepend ?? []),
      ...decompiled.instructions,
      ...(extra.append ?? []),
    ],
  }).compileToV0Message(lookupTableAccounts);

  return new VersionedTransaction(message);
}

// Implements docs/compute-unit-budget-spec.md §3a. Solana charges
// computeUnitLimit × computeUnitPriceMicroLamports regardless of units
// actually consumed — a static global guess is either a silent overpay
// (limit too high) or an outright ComputeBudgetExceeded failure after
// already paying the network fee (limit too low). This runs one
// simulation with a generous probe limit, reads back real
// `unitsConsumed`, and returns that plus a safety margin — determined
// ONCE per buy()/sell() call and then held fixed across every
// sendAndConfirmWithRetry attempt for that same call (retries change
// blockhash/priority fee, not what the transaction is actually doing).
const MAX_COMPUTE_UNITS = 1_400_000; // Solana's per-transaction CU ceiling.
const COMPUTE_UNIT_SAFETY_MARGIN = 1.2; // 20% headroom over measured usage.
const MIN_COMPUTE_UNIT_LIMIT = 20_000;

export async function determineComputeUnitLimit(
  connection: Connection,
  transaction: VersionedTransaction,
  keypair: Keypair,
  extra: {
    prepend?: TransactionInstruction[];
    append?: TransactionInstruction[];
  },
  label: string,
): Promise<number> {
  const configuredFallback = Number(
    process.env.RAYDIUM_CPMM_COMPUTE_UNIT_LIMIT ?? 300_000,
  );

  try {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const probeTx = await rebuildTransaction(
      connection,
      transaction,
      keypair.publicKey,
      {
        prepend: [
          // A generous probe limit so the simulation itself never
          // truncates execution early — we want to see the REAL cost,
          // not a cost capped by an already-wrong guess.
          ComputeBudgetProgram.setComputeUnitLimit({
            units: MAX_COMPUTE_UNITS,
          }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }),
          ...(extra.prepend ?? []),
        ],
        ...(extra.append ? { append: extra.append } : {}),
      },
      latestBlockhash,
    );
    probeTx.sign([keypair]);

    const { value } = await connection.simulateTransaction(probeTx, {
      commitment: "confirmed",
      sigVerify: false,
    });

    if (value.err) {
      // Don't treat this as fatal here — the real send below will hit the
      // same error and report it properly through the normal
      // simulate/send path. This function's only job is picking a CU
      // limit; if the transaction is broken for some other reason, that's
      // not this function's failure to report.
      LOG.warn(
        { label, err: value.err },
        "Compute-unit probe simulation failed — falling back to configured/default limit",
      );
      return configuredFallback;
    }

    if (value.unitsConsumed === undefined || value.unitsConsumed === null) {
      LOG.warn(
        { label },
        "Simulation did not report unitsConsumed — falling back to configured/default limit",
      );
      return configuredFallback;
    }

    const tuned = Math.min(
      MAX_COMPUTE_UNITS,
      Math.max(
        MIN_COMPUTE_UNIT_LIMIT,
        Math.ceil(value.unitsConsumed * COMPUTE_UNIT_SAFETY_MARGIN),
      ),
    );
    LOG.info(
      { label, unitsConsumed: value.unitsConsumed, tunedLimit: tuned },
      "Compute-unit probe complete — using measured limit for this send",
    );
    return tuned;
  } catch (err: any) {
    LOG.warn(
      { label, err: err?.message },
      "Compute-unit probe threw — falling back to configured/default limit",
    );
    return configuredFallback;
  }
}

// Spec §4's pass/fail test wants ACTUAL post-confirmation unitsConsumed
// logged alongside the signature, not just the pre-send probe's estimate —
// that's the real data §3b's future per-pool-type constants get tuned
// from. Best-effort only: this runs after the trade already succeeded, so
// a failure here must never affect the caller's result.
async function logActualComputeUnitsConsumed(
  connection: Connection,
  signature: string,
  label: string,
): Promise<void> {
  try {
    const tx = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    LOG.info(
      { label, signature, actualUnitsConsumed: tx?.meta?.computeUnitsConsumed },
      "Actual on-chain compute units consumed",
    );
  } catch (err: any) {
    LOG.debug(
      { label, signature, err: err?.message },
      "Could not fetch actual computeUnitsConsumed (non-fatal)",
    );
  }
}

async function buy(
  candidate: CandidateMint,
  amountSol: number,
  ctx: NativeExecutorContext,
): Promise<NativeExecutionResult> {
  if (ctx.keypair.publicKey.toBase58() !== ctx.ownerWallet) {
    // Same custody-safety rule as jupiter.service.ts's executeSwap: never
    // sign with a keypair that doesn't match the wallet we believe we're
    // trading for.
    return {
      success: false,
      reason: "Signer does not match ownerWallet — refusing to sign",
    };
  }

  const connection = getConnection();
  const owner = ctx.keypair.publicKey;
  const slippage = getSlippage();

  LOG.info(
    {
      mint: candidate.mint.slice(0, 8),
      poolAddress: candidate.poolAddress,
      amountSol,
    },
    "🛠️ CPMM native buy — building transaction",
  );

  const raydium = await Raydium.load({ connection, owner });

  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(
    candidate.poolAddress,
  );

  // Defense-in-depth: even though poolVerification.service.ts already
  // confirmed this on-chain before the router selected this executor,
  // re-assert it here too — this function must be safe to call directly in
  // a future test/backtest harness without depending on the router having
  // run first.
  if (poolInfo.programId !== RAYDIUM_PROGRAM_IDS["raydium-cpmm"]) {
    return {
      success: false,
      reason: `Pool programId ${poolInfo.programId} does not match pinned raydium-cpmm program`,
    };
  }

  const baseIn = SOL_MINT === poolInfo.mintA.address;
  const inputLamports = new BN(Math.round(amountSol * 1_000_000_000));

  // rpcData.configInfo is typed as possibly undefined by the SDK (a pool
  // whose on-chain config account it couldn't fetch/decode) — not
  // something to fall back or guess past, since every fee rate below
  // (and therefore the whole swapResult/minimumAmountOut chain) depends
  // on it.
  if (!rpcData.configInfo) {
    return {
      success: false,
      reason: "Pool rpcData.configInfo missing — cannot compute swap safely",
    };
  }
  const { tradeFeeRate, creatorFeeRate, protocolFeeRate, fundFeeRate } =
    rpcData.configInfo;

  // See deriveIsCreatorFeeOnInput's comment for what this replaced and why.
  const isCreatorFeeOnInput = deriveIsCreatorFeeOnInput(
    (poolInfo as any).feeOn,
  );

  const swapResult = CurveCalculator.swapBaseInput(
    inputLamports,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    tradeFeeRate,
    creatorFeeRate,
    protocolFeeRate,
    fundFeeRate,
    isCreatorFeeOnInput,
  );

  // Independent cross-check per spec §3. NOTE: this is logged, not
  // assertible against the SDK's own internal minimumAmountOut — raydium.
  // cpmm.swap() returns a built transaction, not a discrete minAmountOut
  // value we can diff against before sending. Treat this log line as the
  // artifact a post-mortem uses to tell "the guard was set correctly and
  // the fill was still bad" from "the guard itself was wrong" (spec §3) —
  // if you need a pre-send hard assertion instead of a post-hoc log, that
  // requires decoding the built instruction's own data, which needs the
  // exact CPMM instruction layout and is deliberately not attempted here.
  const expectedMinOut = computeMinimumAmountOut(
    swapResult.outputAmount,
    slippage,
  );
  LOG.info(
    {
      mint: candidate.mint.slice(0, 8),
      expectedOutput: swapResult.outputAmount.toString(),
      expectedMinOut: expectedMinOut.toString(),
      slippage,
    },
    "Computed expected output / minimum-out for pre-flight cross-check",
  );

  const outputMint = new PublicKey(
    baseIn ? poolInfo.mintB.address : poolInfo.mintA.address,
  );
  const { instruction: ensureOutputAtaIx } = buildEnsureAtaInstruction(
    owner,
    outputMint,
  );
  const { instructions: wrapSolIxs } = buildWrapSolInstructions(
    owner,
    BigInt(inputLamports.toString()),
  );

  // Built once, outside the retry loop below — none of this depends on
  // blockhash or priority fee, only on pool state we already fetched.
  const { transaction } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    baseIn,
    swapResult,
    inputAmount: inputLamports,
    slippage,
    txVersion: TxVersion.V0,
    config: {
      // Real bug found on the first live trade: associatedOnly: false
      // means "you're allowed to create and use your own non-standard
      // token account" — and the SDK did exactly that, depositing swap
      // proceeds into a second, self-created account instead of the
      // canonical ATA our own buildEnsureAtaInstruction had already
      // created. Two independent defensive measures (this flag, and our
      // own explicit ATA-ensure instruction) fought each other and
      // produced a WORSE outcome than either alone — the canonical ATA
      // sat empty, unused, wasted rent, while proceeds landed somewhere
      // our own sell() doesn't know to look. associatedOnly: true forces
      // the SDK to use only the standard ATA, which our own idempotent
      // instruction already guarantees exists — the two layers now agree
      // instead of conflicting.
      associatedOnly: true,
      checkCreateATAOwner: true,
    },
  });

  const sendStrategy = getSendStrategy();

  const computeUnitLimit = await determineComputeUnitLimit(
    connection,
    transaction as VersionedTransaction,
    ctx.keypair,
    {
      prepend: [...wrapSolIxs, ensureOutputAtaIx],
      // Included in the probe too, so the measured units reflect the real,
      // final instruction set — the tip instruction isn't free of compute
      // cost even if it's cheap.
      ...(sendStrategy === "jito"
        ? {
            append: [
              await buildJitoTipInstruction(owner, getJitoTipLamports()),
            ],
          }
        : {}),
    },
    "cpmm-buy",
  );

  // Rebuilt fresh on every send attempt by sendAndConfirmWithRetry — this
  // is what lets a retry carry a new blockhash and a bumped priority fee
  // without re-running the swap quote or re-fetching pool state.
  // computeUnitLimit itself, however, is NOT re-determined per retry — see
  // determineComputeUnitLimit's own comment on why it's fixed once per call.
  // A fresh tip instruction (new random tip account) IS built per attempt
  // when sendStrategy is "jito" — see docs/mev-jito-routing-spec.md §3 on
  // why each bundle attempt needs its own tip.
  const buildTx: TxBuilder = async ({
    blockhash,
    lastValidBlockHeight,
    computeUnitPriceMicroLamports,
  }) => {
    const tx = await rebuildTransaction(
      connection,
      transaction as VersionedTransaction,
      owner,
      {
        prepend: [
          ComputeBudgetProgram.setComputeUnitLimit({
            units: computeUnitLimit,
          }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: computeUnitPriceMicroLamports,
          }),
          ...wrapSolIxs,
          ensureOutputAtaIx,
        ],
        ...(sendStrategy === "jito"
          ? {
              append: [
                await buildJitoTipInstruction(owner, getJitoTipLamports()),
              ],
            }
          : {}),
      },
      { blockhash, lastValidBlockHeight },
    );
    tx.sign([ctx.keypair]);
    return tx;
  };

  const useReal = process.env.USE_REAL_SWAP === "true";
  if (!useReal) {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const simTx = await buildTx({
      ...latestBlockhash,
      computeUnitPriceMicroLamports: getInitialPriorityFee(),
    });
    const { value } = await connection.simulateTransaction(simTx, {
      commitment: "confirmed",
      sigVerify: false,
    });
    if (value.err) {
      return {
        success: false,
        reason: `Simulation failed: ${JSON.stringify(value.err)}`,
      };
    }
    return { success: true, signature: `sim-${candidate.mint.slice(0, 8)}` };
  }

  // See transaction/sender.ts — handles retry-with-fresh-blockhash,
  // landed-but-reverted detection, and the double-execution guard (never
  // resend without first re-checking the prior attempt's own signature
  // status) that a single send()+confirmTransaction() call doesn't give you.
  const result = await sendAndConfirmWithRetry(connection, buildTx, {
    initialComputeUnitPriceMicroLamports: getInitialPriorityFee(),
    ...(sendStrategy === "jito" ? { send: sendViaJitoBundle } : {}),
  });

  if (result.outcome === "confirmed") {
    LOG.info(
      {
        signature: result.signature,
        mint: candidate.mint.slice(0, 8),
        attempts: result.attempts,
      },
      "✅ CPMM native buy confirmed",
    );
    // Best-effort, doesn't block the return — see the function's own
    // comment on why a failure here must never affect the caller's result.
    void logActualComputeUnitsConsumed(
      connection,
      result.signature,
      "cpmm-buy",
    );
    return {
      success: true,
      signature: result.signature,
      amountSol,
      tokensReceived: Number(swapResult.outputAmount.toString()),
    };
  }

  if (result.outcome === "reverted") {
    LOG.warn(
      {
        signature: result.signature,
        mint: candidate.mint.slice(0, 8),
        error: result.error,
      },
      "CPMM native buy landed but reverted on-chain",
    );
    return {
      success: false,
      signature: result.signature,
      reason: `Transaction reverted on-chain: ${result.error}`,
    };
  }

  // outcome === "unknown" — the genuinely ambiguous case. Do not report
  // this as a plain failure the caller can treat as "safe to try again
  // fresh" without checking — see sender.ts's SendAndConfirmResult comment.
  LOG.error(
    {
      lastSignature: result.lastSignature,
      mint: candidate.mint.slice(0, 8),
      reason: result.reason,
    },
    "🚨 CPMM native buy outcome unknown after retries — reconcile before assuming no funds moved",
  );
  return {
    success: false,
    ...(result.lastSignature ? { signature: result.lastSignature } : {}),
    reason: result.reason,
  };
}

// Starting priority fee for a CPMM attempt. Unlike the compute-unit limit
// above (now measured per-call via determineComputeUnitLimit), this is
// still a global env-configurable guess — priority-fee tuning is explicitly
// out of scope for docs/compute-unit-budget-spec.md (see its §5) and has
// its own bump-on-retry logic in sender.ts instead.
function getInitialPriorityFee(): number {
  return Number(process.env.RAYDIUM_CPMM_PRIORITY_FEE_MICROLAMPORTS ?? 50_000);
}

async function sell(
  candidate: CandidateMint,
  tokenAmountRaw: BN,
  ctx: NativeExecutorContext,
): Promise<NativeExecutionResult> {
  if (ctx.keypair.publicKey.toBase58() !== ctx.ownerWallet) {
    return {
      success: false,
      reason: "Signer does not match ownerWallet — refusing to sign",
    };
  }

  // NOTE: the position-exit claim/lease guard (doc 13 point 9) is NOT
  // acquired here. It used to be, but that was wrong: a guard living only
  // inside this native executor can't stop a concurrent JUPITER-path sell
  // for the same position from racing it — Jupiter sells never call this
  // function at all. The guard has to sit at the one place that decides
  // between native and Jupiter for a given sell attempt, before either
  // path runs — see sellExecutionRouter.service.ts, which is the only
  // intended caller of this function in production. Calling sell()
  // directly (tests, a future backtest harness) bypasses the guard
  // entirely; that's an accepted trade-off for this function staying
  // callable on its own, not an oversight.
  const connection = getConnection();
  const owner = ctx.keypair.publicKey;
  const slippage = getSlippage();

  LOG.info(
    {
      mint: candidate.mint.slice(0, 8),
      poolAddress: candidate.poolAddress,
      tokenAmountRaw: tokenAmountRaw.toString(),
    },
    "🛠️ CPMM native sell — building transaction",
  );

  const raydium = await Raydium.load({ connection, owner });
  const { poolInfo, poolKeys, rpcData } = await raydium.cpmm.getPoolInfoFromRpc(
    candidate.poolAddress,
  );

  if (poolInfo.programId !== RAYDIUM_PROGRAM_IDS["raydium-cpmm"]) {
    return {
      success: false,
      reason: `Pool programId ${poolInfo.programId} does not match pinned raydium-cpmm program`,
    };
  }

  if (!rpcData.configInfo) {
    return {
      success: false,
      reason: "Pool rpcData.configInfo missing — cannot compute swap safely",
    };
  }
  const { tradeFeeRate, creatorFeeRate, protocolFeeRate, fundFeeRate } =
    rpcData.configInfo;

  // Selling means the TOKEN is the input side now — the inverse of buy()'s
  // baseIn. isCreatorFeeOnInput itself doesn't depend on trade direction —
  // it's a pool-level config, not a per-trade one — so this reuses the same
  // helper buy() does, off the same feeOn field.
  const baseIn = candidate.mint === poolInfo.mintA.address;
  const isCreatorFeeOnInput = deriveIsCreatorFeeOnInput(
    (poolInfo as any).feeOn,
  );

  const swapResult = CurveCalculator.swapBaseInput(
    tokenAmountRaw,
    baseIn ? rpcData.baseReserve : rpcData.quoteReserve,
    baseIn ? rpcData.quoteReserve : rpcData.baseReserve,
    tradeFeeRate,
    creatorFeeRate,
    protocolFeeRate,
    fundFeeRate,
    isCreatorFeeOnInput,
  );

  const expectedMinOut = computeMinimumAmountOut(
    swapResult.outputAmount,
    slippage,
  );
  LOG.info(
    {
      mint: candidate.mint.slice(0, 8),
      expectedSolOut: swapResult.outputAmount.toString(),
      expectedMinSolOut: expectedMinOut.toString(),
      slippage,
    },
    "Computed expected SOL output / minimum-out for pre-flight cross-check",
  );

  const inputMint = new PublicKey(candidate.mint);
  // Idempotent — the input token ATA should already exist from the
  // original buy, but this is cheap defense-in-depth per spec §2 rather
  // than assuming a prior buy() call always left it in place.
  const { instruction: ensureInputAtaIx } = buildEnsureAtaInstruction(
    owner,
    inputMint,
  );
  // Output is SOL, paid into the WSOL ATA by the swap, then unwrapped
  // (closed) back to native SOL — see spec §1. The ensure-instruction goes
  // BEFORE the swap (prepend); the unwrap has to go AFTER it (append),
  // since it's closing the account the swap just funded.
  const { instruction: ensureWsolAtaIx } = buildEnsureAtaInstruction(
    owner,
    NATIVE_MINT,
  );
  const { instruction: unwrapIx } = buildUnwrapSolInstruction(owner);

  const { transaction } = await raydium.cpmm.swap({
    poolInfo,
    poolKeys,
    baseIn,
    swapResult,
    inputAmount: tokenAmountRaw,
    slippage,
    txVersion: TxVersion.V0,
    config: {
      // See buy()'s identical comment — real bug found on the first live
      // trade, same fix applies here.
      associatedOnly: true,
      checkCreateATAOwner: true,
    },
  });

  const sendStrategy = getSendStrategy();

  const computeUnitLimit = await determineComputeUnitLimit(
    connection,
    transaction as VersionedTransaction,
    ctx.keypair,
    {
      prepend: [ensureInputAtaIx, ensureWsolAtaIx],
      append:
        sendStrategy === "jito"
          ? [
              unwrapIx,
              await buildJitoTipInstruction(owner, getJitoTipLamports()),
            ]
          : [unwrapIx],
    },
    "cpmm-sell",
  );

  const buildTx: TxBuilder = async ({
    blockhash,
    lastValidBlockHeight,
    computeUnitPriceMicroLamports,
  }) => {
    const tx = await rebuildTransaction(
      connection,
      transaction as VersionedTransaction,
      owner,
      {
        prepend: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: computeUnitPriceMicroLamports,
          }),
          ensureInputAtaIx,
          ensureWsolAtaIx,
        ],
        append:
          sendStrategy === "jito"
            ? [
                unwrapIx,
                await buildJitoTipInstruction(owner, getJitoTipLamports()),
              ]
            : [unwrapIx],
      },
      { blockhash, lastValidBlockHeight },
    );
    tx.sign([ctx.keypair]);
    return tx;
  };

  const useReal = process.env.USE_REAL_SWAP === "true";
  if (!useReal) {
    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    const simTx = await buildTx({
      ...latestBlockhash,
      computeUnitPriceMicroLamports: getInitialPriorityFee(),
    });
    const { value } = await connection.simulateTransaction(simTx, {
      commitment: "confirmed",
      sigVerify: false,
    });
    if (value.err) {
      return {
        success: false,
        reason: `Simulation failed: ${JSON.stringify(value.err)}`,
      };
    }
    return {
      success: true,
      signature: `sim-sell-${candidate.mint.slice(0, 8)}`,
    };
  }

  const result = await sendAndConfirmWithRetry(connection, buildTx, {
    initialComputeUnitPriceMicroLamports: getInitialPriorityFee(),
    ...(sendStrategy === "jito" ? { send: sendViaJitoBundle } : {}),
  });

  if (result.outcome === "confirmed") {
    LOG.info(
      {
        signature: result.signature,
        mint: candidate.mint.slice(0, 8),
        attempts: result.attempts,
      },
      "✅ CPMM native sell confirmed",
    );
    void logActualComputeUnitsConsumed(
      connection,
      result.signature,
      "cpmm-sell",
    );
    return {
      success: true,
      signature: result.signature,
      tokensSold: Number(tokenAmountRaw.toString()),
      amountSol: Number(swapResult.outputAmount.toString()) / 1_000_000_000,
    };
  }

  if (result.outcome === "reverted") {
    LOG.warn(
      {
        signature: result.signature,
        mint: candidate.mint.slice(0, 8),
        error: result.error,
      },
      "CPMM native sell landed but reverted on-chain",
    );
    return {
      success: false,
      signature: result.signature,
      reason: `Transaction reverted on-chain: ${result.error}`,
    };
  }

  LOG.error(
    {
      lastSignature: result.lastSignature,
      mint: candidate.mint.slice(0, 8),
      reason: result.reason,
    },
    "🚨 CPMM native sell outcome unknown after retries — reconcile before assuming no funds moved",
  );
  return {
    success: false,
    ...(result.lastSignature ? { signature: result.lastSignature } : {}),
    reason: result.reason,
  };
}

export const cpmmExecutor: NativeExecutor = {
  poolType: "raydium-cpmm",
  buy,
  sell,
};
