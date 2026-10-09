// app/providers/SocketProvider.tsx
"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Socket } from "socket.io-client";
import { socket } from "@lib/socket";

interface SocketData {
  event: string;
  payload: any;
}

interface SocketContextValue {
  connected: boolean;
  lastMessage: SocketData | null;
  send: (event: string, payload?: any) => void;
  socket?: Socket | null;
}

const SocketContext = createContext<SocketContextValue>({
  connected: false,
  lastMessage: null,
  send: () => {},
  socket: null,
});

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<SocketData | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Attach to the shared singleton (frontend/lib/socket.ts) rather than
    // creating a new connection here — see that file for why.
    socketRef.current = socket;
    if (socket.connected) setConnected(true);

    // This provider and every useSocket() call elsewhere in the app (21+
    // components) all attach listeners to this one shared singleton, several
    // for the same event names ("connect", "tradeFeed", "pnl:update", etc).
    // The cleanup below used to call socket.off("eventName") with no handler
    // reference, which removes EVERY listener for that event — including
    // every other still-mounted useSocket() instance's — not just this
    // provider's own. In dev, React 18 Strict Mode's mount->cleanup->remount
    // cycle alone was enough to trigger this and silently kill live updates
    // elsewhere in the app. Named handlers + matching off() calls fix it.
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onConnectError = () => setConnected(false);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
    };
  }, []);

  // Wallet identification lives in WalletDataProvider now: the server
  // requires a signed proof of the wallet (or a session token from one), and
  // this provider used to emit an unauthenticated identify of its own.

  const send = (event: string, payload?: any) => {
    if (socketRef.current && socketRef.current.connected) {
      socketRef.current.emit(event, payload);
    }
  };

  return (
    <SocketContext.Provider
      value={{ connected, lastMessage, send, socket: socketRef.current }}
    >
      {children}
    </SocketContext.Provider>
  );
};

export const useSocketContext = () => useContext(SocketContext);
