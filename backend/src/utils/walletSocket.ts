// backend/src/utils/walletSocket.ts
//
// Emits a wallet-attributed event to only that wallet's own connections —
// sockets join a room named after their owner wallet on "identify" (see
// socket.route.ts). This includes the bot's own operator-wallet activity:
// it is that wallet's own private activity too, exactly like any custodial
// user's, visible only to a socket that has identified as that same wallet
// — never a global broadcast. (This function used to special-case the
// operator wallet as an always-public broadcast; that made the operator's
// trade history/PnL visible to every visitor, connected or not, which is
// exactly the leak this was rewritten to close.)
import { Server } from "socket.io";
import { getLogger } from "./logger.js";

const log = getLogger("walletSocket");

export const OPERATOR_WALLET =
  process.env.ADMIN_WALLET_PUBKEY || process.env.WALLET_PUBLIC_KEY || "";

export function emitToWalletOrGlobal(
  io: Server | null | undefined,
  wallet: string | undefined,
  event: string,
  payload: unknown
): void {
  if (!io) return;
  if (!wallet) {
    // No identified wallet to scope this to — silently drop rather than
    // broadcasting globally, which would leak this activity to every
    // connected visitor regardless of what (if anything) they've connected.
    return;
  }
  io.to(wallet).emit(event, payload);
  log.debug({ wallet, event }, "Emitted wallet-scoped socket event");
}
