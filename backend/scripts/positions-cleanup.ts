// backend/scripts/positions-cleanup.ts
//
// Finds positions the bot has finished with but still carries on its books,
// and (only when asked) tidies them up. Run from the backend folder:
//
//   npx tsx scripts/positions-cleanup.ts                     list every position and its state (changes nothing)
//   npx tsx scripts/positions-cleanup.ts --close-ghosts      mark "ghost" positions closed
//   npx tsx scripts/positions-cleanup.ts --wallet OWNER_ADDRESS --purge          preview what a purge would delete
//   npx tsx scripts/positions-cleanup.ts --wallet OWNER_ADDRESS --purge --yes    ...and actually delete it
//
// OWNER_ADDRESS is the full wallet address (the listing prints them in full at
// the end) — type the real address, not the angle brackets of a placeholder:
// PowerShell reads "<" as a redirect.
//
// States:
//   open    the ledger says open and the trading wallet still holds the token
//   closed  fully exited (or nothing left in the ledger)
//   ghost   the ledger says open but the wallet holds NONE — sold or lost
//           earlier without the position ever being marked closed
//
// --close-ghosts only sets remainingPct to 0 (nothing is deleted, trade history
// is untouched); it is what stops the bot monitoring, counting and offering to
// sell a position that isn't there.
//
// --purge is different: it PERMANENTLY deletes the trade history + monitoring
// record of closed positions for ONE wallet. That changes realized P&L and win
// rate, and lowers the wallet's lifetime trade count (what Max Total Trades
// counts). There is no undo — take a backup first (mongodump), and read the
// preview before adding --yes.
import "../src/utils/env.js"; // loads .env before anything reads it
import dbService, { OPERATOR_WALLET } from "../src/services/db.service.js";
import userWalletService from "../src/services/userWallet.service.js";
import { getTokenBalance } from "../src/services/solana.service.js";
import {
  classifyPosition,
  isOpenPosition,
  type PositionState,
} from "../src/utils/positionState.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const valueOf = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const wallet = valueOf("--wallet");
const closeGhosts = flag("--close-ghosts");
const purge = flag("--purge");
const yes = flag("--yes");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`;

async function holderFor(ownerWallet: string): Promise<string | null> {
  try {
    const uw = await userWalletService.getUserWallet(ownerWallet);
    if (uw) return uw.hotWalletPublicKey;
  } catch {
    // not a valid owner address — fall through
  }
  return ownerWallet === OPERATOR_WALLET ? ownerWallet : null;
}

/**
 * Token balance held by the trading wallet, or null if it can't be read.
 * Retried a few times: public and shared RPC endpoints rate-limit in bursts, and
 * a single failed read used to leave a genuine ghost untouched.
 */
async function heldRaw(holder: string, token: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return (await getTokenBalance(holder, token)).raw;
    } catch {
      if (attempt < 4) await sleep(1500 * attempt);
    }
  }
  return null; // still failing: never conclude "empty" from an error
}

async function main() {
  if (purge && !wallet) {
    console.error(
      "--purge needs --wallet <owner address>: it only ever deletes for one wallet.",
    );
    process.exit(1);
  }

  const positions = (await dbService.getPositions(wallet)).filter(
    (p) => p.custody !== "self", // the user's own manual positions aren't the bot's records
  );

  const rows: {
    wallet: string;
    token: string;
    state: PositionState;
    netSol: number;
    remainingPct: number | undefined;
    note: string;
  }[] = [];

  for (const p of positions) {
    let onChain: string | null = null;
    let note = "";
    if (isOpenPosition(p)) {
      const holder = await holderFor(p.wallet);
      if (!holder) {
        note = "holder unknown — not checked";
      } else {
        onChain = await heldRaw(holder, p.token);
        // A zero is only believed if a second read, a moment later, agrees.
        if (onChain !== null && /^0+$/.test(onChain)) {
          await sleep(2000);
          const again = await heldRaw(holder, p.token);
          if (again === null || !/^0+$/.test(again)) onChain = again;
        }
        if (onChain === null) note = "balance unreadable — not changed";
      }
    }
    rows.push({
      wallet: p.wallet,
      token: p.token,
      state: classifyPosition(p, onChain),
      netSol: p.netSol,
      remainingPct: p.remainingPct,
      note,
    });
  }

  const count = (s: PositionState) => rows.filter((r) => r.state === s).length;
  console.log(
    `\n${rows.length} bot position record(s): ${count("open")} open, ${count("ghost")} ghost, ${count("closed")} closed\n`,
  );
  for (const r of rows) {
    console.log(
      `${r.state.toUpperCase().padEnd(7)} ${short(r.wallet)}  ${short(r.token)}  netSol ${r.netSol.toFixed(4).padStart(9)}  remaining ${String(r.remainingPct ?? "n/a").padStart(4)}%  ${r.note}`,
    );
  }

  // Full owner addresses, so --wallet can be copied from here.
  const owners = [...new Set(rows.map((r) => r.wallet))];
  console.log("\nOwner wallets in this listing:");
  for (const o of owners) {
    const n = rows.filter((r) => r.wallet === o);
    console.log(
      `  ${o}   (${n.filter((r) => r.state === "open").length} open, ${n.filter((r) => r.state === "ghost").length} ghost, ${n.filter((r) => r.state === "closed").length} closed)`,
    );
  }

  if (closeGhosts) {
    const ghosts = rows.filter((r) => r.state === "ghost");
    for (const g of ghosts) {
      await dbService.updatePositionMetadata(g.token, g.wallet, {
        remainingPct: 0,
      });
      g.state = "closed"; // so a purge in the same run can include it
    }
    console.log(
      `\nMarked ${ghosts.length} ghost position(s) closed. Nothing was deleted.`,
    );
  } else if (count("ghost") > 0) {
    console.log(
      "\nRe-run with --close-ghosts to mark the ghost positions closed (deletes nothing).",
    );
  }

  if (purge) {
    const targets = rows.filter(
      (r) => r.state === "closed" && r.wallet === wallet,
    );
    const realized = -targets.reduce((sum, r) => sum + r.netSol, 0);
    console.log(
      `\nPURGE preview for ${wallet}: ${targets.length} closed position(s) — their trade history and monitoring records would be deleted.`,
    );
    console.log(
      `  • realized P&L removed from your history: ${realized >= 0 ? "+" : ""}${realized.toFixed(4)} SOL`,
    );
    console.log(
      `  • lifetime trade count (Max Total Trades) drops by ${targets.length}`,
    );
    if (!yes) {
      console.log(
        "\nDRY RUN — nothing was deleted. Back up first (mongodump), then add --yes to delete.",
      );
    } else if (targets.length === 0) {
      console.log("\nNothing to purge.");
    } else {
      const res = await dbService.purgePositionHistory(
        wallet!,
        targets.map((t) => t.token),
      );
      console.log(
        `\nDeleted ${res.tradesDeleted} trade record(s) and ${res.metadataDeleted} monitoring record(s).`,
      );
    }
  }
}

// Exit after a short pause: on Windows, calling process.exit() while the
// Mongo/RPC sockets are still closing trips a libuv assertion ("Assertion
// failed: !(handle->flags & UV_HANDLE_CLOSING)"). Harmless, but it looks like
// a crash — the work above has already finished by this point.
const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500);
};

main()
  .then(() => finish(0))
  .catch((err) => {
    console.error("positions-cleanup failed:", err);
    finish(1);
  });
