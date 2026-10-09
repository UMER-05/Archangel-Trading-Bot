// frontend/src/lib/socket.ts
import { io, Socket } from "socket.io-client";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:4000";

// Single shared connection for the whole app. Must be created at module scope
// (not inside a component's useEffect) — React 18 Strict Mode mounts every
// effect twice in dev, and a socket created+disconnected per-component-mount
// races its own handshake, producing "WebSocket is closed before the
// connection is established" on the first attempt every time.
export const socket: Socket = io(BACKEND_URL, {
  transports: ["websocket"],
  reconnection: true,
  reconnectionDelay: 2000,
});
