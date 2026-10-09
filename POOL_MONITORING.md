# Pool Monitoring System

## Overview

The Pool Monitoring System automatically tracks tokens that have migrated from Pump.fun to Raydium and notifies users when Raydium pools become available for trading. This solves the timing issue where tokens graduate from Pump.fun but their Raydium pools take 2-5 minutes to be indexed.

## How It Works

### 1. Automatic Detection

When you attempt to trade a token that:

- Is identified as a Pump.fun token (via on-chain bonding curve check)
- Has no available Raydium pool yet

The system automatically starts monitoring that token for you.

### 2. Polling Mechanism

- **Check Interval**: Every 30 seconds
- **Max Duration**: 10 minutes (20 retries)
- **Method**: Queries Raydium for quote availability
- **Cleanup**: Automatically stops after pool found or timeout

### 3. Real-time Notifications

When a pool becomes available or monitoring times out, you receive:

- **Socket.io notification**: Real-time push to your connected browser
- **Toast notification**: Visual alert in the trading dashboard
- **Event details**: Token mint, message, timestamp

## Architecture

### Backend Components

#### `poolMonitor.service.ts`

Main service that manages token monitoring:

```typescript
class PoolMonitorService extends EventEmitter {
  - addToken(tokenMint, inputMint, outputMint, wallet)
  - removeToken(tokenMint)
  - checkAllTokens()
  - getStatus()
  - getMonitoredTokensForWallet(wallet)
}
```

**Key Features:**

- EventEmitter pattern for decoupled notifications
- Map-based storage for monitored tokens
- Automatic retry with exponential backoff
- Per-wallet tracking for multi-user support

**Events Emitted:**

- `poolAvailable`: When Raydium pool becomes available
- `monitoringTimeout`: After 10 minutes without pool

#### `trade.route.ts` Integration

```typescript
// When Raydium quote fails for a Pump.fun token:
if (isPumpFun && !raydiumQuote) {
  poolMonitor.addToken(tokenMint, inputMint, outputMint, wallet);
  return res.status(400).json({
    success: false,
    message:
      "Token has migrated from Pump.fun but no Raydium pool is available yet. We'll monitor the token and notify you when the Raydium pool becomes available.",
    monitoring: true,
  });
}
```

#### `socket.route.ts` Integration

```typescript
poolMonitor.on("poolAvailable", (data) => {
  const socketId = walletSocketMap.get(data.wallet);
  if (socketId) {
    io.to(socketId).emit("poolAvailable", {
      tokenMint: data.tokenMint,
      message: data.message,
      timestamp: data.timestamp,
    });
  }
});

poolMonitor.on("monitoringTimeout", (data) => {
  const socketId = walletSocketMap.get(data.wallet);
  if (socketId) {
    io.to(socketId).emit("poolMonitorTimeout", {
      tokenMint: data.tokenMint,
      message: data.message,
      timestamp: data.timestamp,
    });
  }
});
```

### Frontend Components

#### `useSocket.ts`

Socket hook that listens for monitoring events:

```typescript
socket.on("poolAvailable", (data) =>
  setLastMessage({ event: "poolAvailable", payload: data })
);
socket.on("poolMonitorTimeout", (data) =>
  setLastMessage({ event: "poolMonitorTimeout", payload: data })
);
```

#### `page.tsx` (Trading Dashboard)

Displays toast notifications when events occur:

```typescript
useEffect(() => {
  if (lastMessage?.event === "poolAvailable") {
    toast.success(`🎉 Pool available for ${shortMint}!`, {
      duration: 8000,
      position: "top-right",
    });
  }

  if (lastMessage?.event === "poolMonitorTimeout") {
    toast.error(`⏱️ Monitoring timeout for ${shortMint}`, {
      duration: 6000,
      position: "top-right",
    });
  }
}, [lastMessage]);
```

## API Endpoints

### Check Overall Status

```http
GET /api/trade/pool-monitor/status
```

**Response:**

```json
{
  "success": true,
  "data": {
    "totalMonitored": 3,
    "activePolls": 2,
    "tokens": [
      {
        "tokenMint": "7xKXtg...",
        "inputMint": "So11111...",
        "outputMint": "7xKXtg...",
        "wallet": "DYw8jCT...",
        "startedAt": 1704067200000,
        "retries": 5
      }
    ]
  }
}
```

### Check Wallet's Monitored Tokens

```http
GET /api/trade/pool-monitor/:wallet
```

**Response:**

```json
{
  "success": true,
  "data": {
    "wallet": "DYw8jCT...",
    "monitoredTokens": [
      {
        "tokenMint": "7xKXtg...",
        "inputMint": "So11111...",
        "outputMint": "7xKXtg...",
        "startedAt": 1704067200000,
        "retries": 5
      }
    ]
  }
}
```

## User Experience Flow

### Scenario: Trading a Recently Migrated Token

1. **User Action**: Clicks "Buy Now" on a token that just graduated from Pump.fun
2. **Backend Check**: System detects token is Pump.fun but has no Raydium pool
3. **Automatic Monitoring**: Backend starts monitoring (no user action needed)
4. **User Feedback**: Error message explains: "Token has migrated... We'll notify you when ready"
5. **Waiting Period**: System checks every 30 seconds (user continues using dashboard)
6. **Pool Available**:
   - Backend detects pool via Raydium quote success
   - Emits `poolAvailable` event via Socket.io
   - Frontend shows toast: "🎉 Pool available for 7xKXtg...!"
7. **Retry Trade**: User clicks "Buy Now" again → Trade succeeds on Raydium

### Scenario: Timeout After 10 Minutes

If pool doesn't become available after 10 minutes:

1. Backend stops monitoring (20 retries exhausted)
2. Emits `monitoringTimeout` event
3. Frontend shows toast: "⏱️ Monitoring timeout for 7xKXtg..."
4. User can manually check DexScreener or wait longer before retrying

## Configuration

### Timing Settings

Located in `poolMonitor.service.ts`:

```typescript
const CHECK_INTERVAL_MS = 30000; // 30 seconds between checks
const MAX_RETRIES = 20; // 20 retries = 10 minutes total
```

### Adjusting Parameters

To change monitoring duration:

- **Faster checks**: Reduce `CHECK_INTERVAL_MS` (e.g., 15000 = 15 seconds)
- **Longer monitoring**: Increase `MAX_RETRIES` (e.g., 40 = 20 minutes with 30s interval)

⚠️ **Warning**: Very frequent checks (< 10 seconds) may overload Raydium API

## Technical Details

### Why This Approach?

**Problem:** Tokens graduate from Pump.fun to Raydium instantly on-chain, but DEX aggregators (like Raydium's SDK) take time to index the new pool. Users see "pool not available" errors.

**Solution:** Instead of telling users to "wait and retry manually," we:

1. Automatically detect the timing gap
2. Poll until pool is indexed
3. Notify user immediately when ready

**Alternatives Considered:**

- ❌ Blockchain event monitoring: Too complex, requires archive nodes
- ❌ Manual retry buttons: Poor UX, user forgets to check back
- ✅ Polling with notifications: Simple, reliable, good UX

### Event-Driven Architecture

Uses Node.js EventEmitter pattern for loose coupling:

```
poolMonitor.service.ts (emits)
    ↓
socket.route.ts (listens & forwards)
    ↓
Socket.io (real-time transport)
    ↓
useSocket.ts (receives)
    ↓
page.tsx (displays)
```

Benefits:

- Service doesn't need to know about Socket.io
- Easy to add more listeners (email, SMS, etc.)
- Testable in isolation

### Socket Targeting

Uses `walletSocketMap` for per-user notifications:

```typescript
const walletSocketMap = new Map<string, string>(); // wallet → socketId

// When user connects:
socket.on("identify", (data) => {
  walletSocketMap.set(data.wallet, socket.id);
});

// When pool available:
const socketId = walletSocketMap.get(wallet);
io.to(socketId).emit("poolAvailable", data); // Only to that user
```

This ensures User A doesn't see notifications for User B's tokens.

## Monitoring & Debugging

### Check Service Status

```bash
curl http://localhost:4000/api/trade/pool-monitor/status
```

### Check Your Monitored Tokens

```bash
curl http://localhost:4000/api/trade/pool-monitor/YOUR_WALLET_ADDRESS
```

### Backend Logs

Look for these log entries:

```
[PoolMonitor] Added token 7xKXtg... for monitoring
[PoolMonitor] Checking token 7xKXtg... (attempt 1/20)
[PoolMonitor] Pool available for 7xKXtg... after 5 retries
```

### Frontend Console

Socket events appear in browser console:

```javascript
socket event: poolAvailable
payload: { tokenMint: "7xKXtg...", message: "...", timestamp: 1704067200000 }
```

## Testing

### Manual Test Flow

1. **Find a migrating token:**

   - Look for tokens with high bonding curve % on Pump.fun
   - Check DexScreener for tokens just graduated (< 5 min ago)

2. **Attempt trade:**

   ```bash
   POST /api/trade/prepare
   {
     "inputMint": "So11111...",
     "outputMint": "TOKEN_MINT",
     "amount": 0.01,
     "slippage": 5,
     "wallet": "YOUR_WALLET"
   }
   ```

3. **Expected response:**

   ```json
   {
     "success": false,
     "message": "Token has migrated from Pump.fun but no Raydium pool is available yet. We'll monitor...",
     "monitoring": true
   }
   ```

4. **Check monitoring started:**

   ```bash
   curl http://localhost:4000/api/trade/pool-monitor/YOUR_WALLET
   ```

5. **Wait for notification:**

   - Watch browser for toast notification (2-5 minutes typically)
   - Check backend logs for "Pool available" message

6. **Retry trade:**
   - Should succeed on Raydium

### Automated Tests

```typescript
// poolMonitor.service.test.ts
describe("PoolMonitorService", () => {
  it("should emit poolAvailable when quote succeeds", async () => {
    const poolMonitor = new PoolMonitorService();
    const promise = new Promise((resolve) => {
      poolMonitor.on("poolAvailable", resolve);
    });

    poolMonitor.addToken("mock-token", "SOL", "mock-token", "mock-wallet");
    // Mock raydium.getRaydiumQuote to return success

    const result = await promise;
    expect(result.tokenMint).toBe("mock-token");
  });
});
```

## Troubleshooting

### "Not receiving notifications"

**Check:**

1. Socket connected? Look for "socket connected" in browser console
2. Wallet identified? User must have wallet connected and identified via `socket.emit("identify", { wallet })`
3. Backend running? Service must be started with monitoring service
4. Firewall? Ensure WebSocket port 4000 is open

**Debug:**

```bash
# Check if monitoring started
curl http://localhost:4000/api/trade/pool-monitor/status

# Check browser console for socket errors
# Look for: "socket err" or "disconnect" messages
```

### "Monitoring not starting"

**Possible causes:**

1. Token is not actually Pump.fun (check bonding curve exists)
2. Raydium pool already available (no need to monitor)
3. Trade endpoint not reached (earlier error in request)

**Debug:**

```bash
# Check if token is Pump.fun
curl http://localhost:4000/api/tokens/pump-status/TOKEN_MINT

# Check Raydium quote directly
curl http://localhost:4000/api/raydium/quote?inputMint=SOL&outputMint=TOKEN_MINT&amount=0.01
```

### "Timeout after 10 minutes"

This is **normal behavior** if:

- Pool genuinely never becomes available (failed migration)
- Token uses custom AMM not supported by Raydium SDK
- Network issues preventing pool indexing

**Next steps:**

1. Check DexScreener manually: `https://dexscreener.com/solana/TOKEN_MINT`
2. Verify pool exists on-chain via Solscan
3. If pool exists but quote fails, may need custom integration

## Future Enhancements

### Potential Improvements

1. **Multiple Notification Channels**

   - Email notifications for longer waits
   - Telegram bot integration
   - Discord webhook support

2. **Predictive Monitoring**

   - Start monitoring based on bonding curve % (e.g., > 95%)
   - Predict graduation time using historical data

3. **Enhanced UI**

   - Dedicated "Monitored Tokens" panel in dashboard
   - Progress bar showing retry count
   - Historical monitoring data (average wait time per token)

4. **Advanced Retry Strategies**

   - Exponential backoff (30s → 1m → 2m intervals)
   - Priority queue (high-volume trades monitored more frequently)
   - Multi-pool checking (Raydium + Orca + Meteora)

5. **Analytics**
   - Track average pool availability time
   - Success rate of monitored tokens
   - Most common timeout reasons

## Related Documentation

- [SOCKET_EVENTS.md](./SOCKET_EVENTS.md) - Socket.io event reference
- [TESTING_CONFIG.md](./TESTING_CONFIG.md) - Testing configuration
- [MARKET_CAP_FILTERING.md](./MARKET_CAP_FILTERING.md) - Token filtering logic

## Support

For issues or questions about pool monitoring:

1. Check backend logs for monitoring events
2. Verify socket connection in browser console
3. Test with `/api/trade/pool-monitor/status` endpoint
4. Review this documentation for troubleshooting steps
