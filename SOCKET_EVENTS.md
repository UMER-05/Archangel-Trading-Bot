# Socket.IO Events - Backend to Frontend

## Overview

All new features added (P&L tracking, watchlist, price alerts, caching) are now emitting real-time updates to the frontend via Socket.IO.

## Socket Events Reference

### 🔄 Existing Events (Already Working)

| Event          | Payload                                    | Description                            |
| -------------- | ------------------------------------------ | -------------------------------------- |
| `connection`   | `{ status: "connected" }`                  | Connection confirmation                |
| `tokenFeed`    | `{ tokens: CandidateToken[] }`             | New token discoveries with scores/risk |
| `tradeFeed`    | `TradeRecord`                              | Trade execution (buy/sell) with P&L    |
| `stats:update` | `StatsDoc`                                 | Portfolio statistics update            |
| `priceUpdate`  | `{ [mint: string]: { price, liquidity } }` | Price updates                          |
| `tradeError`   | `{ error, mint, reason }`                  | Trade execution errors                 |
| `identified`   | `{ wallet, success }`                      | Wallet identification confirmation     |

---

### ✨ New Events (Just Added)

#### **Configuration Events**

| Event           | Payload         | Description                       | Frequency |
| --------------- | --------------- | --------------------------------- | --------- |
| `config:update` | `RuntimeConfig` | Configuration updated dynamically | On change |

**RuntimeConfig Fields:**

```typescript
{
  minMarketCapSol: number; // Min market cap in SOL
  maxMarketCapSol: number; // Max market cap in SOL
  minMarketCapUsd: number; // Min market cap in USD
  maxMarketCapUsd: number; // Max market cap in USD
  minSecondsSinceLaunch: number; // Earliest launch age in seconds
  maxSecondsSinceLaunch: number; // Latest launch age in seconds
  minTokenScore: number; // Min score (0-100)
  takeProfitPct: number; // Take profit percentage
  stopLossPct: number; // Stop loss percentage
}
```

---

#### **Portfolio P&L Events**

| Event               | Payload        | Description                            | Frequency        |
| ------------------- | -------------- | -------------------------------------- | ---------------- |
| `pnl:update`        | `PortfolioPnL` | Complete portfolio metrics (13 fields) | Every 30s (auto) |
| `pnl:tokens:update` | `TokenPnL[]`   | Per-token P&L breakdown                | On request       |

**PortfolioPnL Fields:**

```typescript
{
  totalInvestedSol: number;
  totalReturnedSol: number;
  unrealizedPnlSol: number;
  realizedPnlSol: number;
  totalPnlSol: number;
  totalPnlPercent: number;
  winningTrades: number;
  losingTrades: number;
  totalTrades: number;
  winRate: number;
  averageWinSol: number;
  averageLossSol: number;
  largestWinSol: number;
  largestLossSol: number;
  openPositionsValue: number;
  closedPositionsValue: number;
  roi: number;
}
```

#### **Watchlist Events**

| Event                  | Payload                                   | Description            | Trigger               |
| ---------------------- | ----------------------------------------- | ---------------------- | --------------------- |
| `watchlist:update`     | `WatchlistToken[]`                        | Updated watchlist      | On add/remove/request |
| `priceAlert:set`       | `{ mint, userId, priceAlert, timestamp }` | Price alert configured | On alert setup        |
| `priceAlert:triggered` | Alert details with current price          | Price target reached   | When condition met    |

**Price Alert Trigger Payload:**

```typescript
{
  mint: string
  symbol: string
  name: string
  userId?: string
  currentPrice: number
  targetPrice: number
  condition: "above" | "below"
  timestamp: string
}
```

---

## Frontend Socket Listeners

### Client-Side Events to Listen For

```typescript
// Connection
socket.on("connection", (data) => {
  console.log("Connected:", data.status);
});

// Token Discovery
socket.on("tokenFeed", ({ tokens }) => {
  // Update token list with scores/risk levels
  tokens.forEach((token) => {
    console.log(
      `${token.symbol}: Score ${token.score}, Risk ${token.riskLevel}`,
    );
  });
});

// Trades
socket.on("tradeFeed", (trade) => {
  console.log(
    `Trade: ${trade.type} ${trade.symbol} - P&L: ${trade.pnlSol} SOL`,
  );
});

// Portfolio P&L (Auto-broadcast every 30s)
socket.on("pnl:update", (pnl) => {
  console.log(
    `Portfolio P&L: ${pnl.totalPnlSol} SOL (${pnl.winRate}% win rate)`,
  );
});

// Watchlist
socket.on("watchlist:update", (tokens) => {
  console.log(`Watchlist updated: ${tokens.length} tokens`);
});

// Price Alerts
socket.on("priceAlert:triggered", (alert) => {
  console.log(
    `🚨 Alert: ${alert.symbol} ${alert.condition} $${alert.targetPrice}`,
  );
  // Show notification to user
});

socket.on("priceAlert:set", (data) => {
  console.log(`Alert set for ${data.mint}`);
});

// Statistics
socket.on("stats:update", (stats) => {
  console.log(`Stats: ${stats.totalTrades} trades`);
});

// Price Updates
socket.on("priceUpdate", (prices) => {
  // Update token prices in UI
});

// Errors
socket.on("tradeError", (error) => {
  console.error("Trade failed:", error);
});
```

---

## Client-Side Events to Emit (Requests)

```typescript
// Identify wallet
socket.emit("identify", {
  wallet: "YOUR_WALLET_ADDRESS",
  autoMode: true,
  manualAmountSol: 0.1,
});

// Request current stats
socket.emit("stats:request");

// Request portfolio P&L
socket.emit("pnl:request");

// Request per-token P&L
socket.emit("pnl:tokens:request");

// Request watchlist
socket.emit("watchlist:request", { userId: "optional_user_id" });
```

---

## Background Services Broadcasting Updates

| Service                 | Event                       | Frequency       |
| ----------------------- | --------------------------- | --------------- |
| **Token Discovery**     | `tokenFeed`                 | Every 30s       |
| **Position Monitor**    | `tradeFeed` (auto-sell)     | Every 5s check  |
| **Price Alert Monitor** | `priceAlert:triggered`      | Every 60s check |
| **P&L Broadcaster**     | `pnl:update`                | Every 30s       |
| **Trade Execution**     | `tradeFeed`, `stats:update` | On trade        |
| **Watchlist Changes**   | `watchlist:update`          | On API call     |

---

## HTTP API Endpoints with Socket Emission

### Watchlist Routes

- `POST /api/watchlist` → Emits `watchlist:update`
- `DELETE /api/watchlist/:mint` → Emits `watchlist:update`
- `PATCH /api/watchlist/:mint/alert` → Emits `priceAlert:set`

### P&L Routes (Request-only, no auto-emit)

- `GET /api/pnl/portfolio` → Returns portfolio P&L
- `GET /api/pnl/tokens` → Returns per-token P&L
- `GET /api/pnl/history?days=30` → Returns historical P&L

### Cache Routes (Admin/Debug)

- `GET /api/cache/stats` → Returns cache statistics
- `POST /api/cache/clear` → Clears cache
- `DELETE /api/cache/:key` → Removes cache entry

---

## Integration Notes

### 1. **Real-Time P&L**

- Portfolio P&L automatically broadcasts every 30 seconds
- Frontend can request immediate update via `pnl:request`
- Includes win rate, ROI, realized/unrealized P&L

### 2. **Watchlist Sync**

- Any watchlist change (add/remove/alert) broadcasts to all clients
- Multi-user support with `userId` parameter
- Price alerts trigger notifications when conditions met

### 3. **Caching Performance**

- All API calls benefit from in-memory caching
- Reduces external API hits to DexScreener, Birdeye, Raydium
- Cache stats available at `/api/cache/stats`

### 4. **Token Scoring**

- Every token in `tokenFeed` includes:
  - `score` (0-100 quality rating)
  - `riskLevel` (low/medium/high rug pull risk)
  - `age` (hours since launch)
  - `volume24h`, `priceChange24h`

### 5. **Trade Events**

- Include P&L data: `pnl` (percent), `pnlSol` (absolute SOL)
- Reason field for auto-sells: `"take_profit"` or `"stop_loss"`
- Stats automatically update after each trade

---

## Testing Socket Events

```bash
# Start backend
cd backend && npm run build && node dist/index.js

# Connect with Socket.IO client
npm install socket.io-client

# Test script
node test-socket.js
```

**test-socket.js:**

```javascript
const io = require("socket.io-client");
const socket = io("http://localhost:4000");

socket.on("connect", () => {
  console.log("✅ Connected");

  // Request P&L
  socket.emit("pnl:request");

  // Request watchlist
  socket.emit("watchlist:request");
});

socket.on("pnl:update", (data) => {
  console.log("📊 P&L:", data);
});

socket.on("watchlist:update", (data) => {
  console.log("⭐ Watchlist:", data);
});

socket.on("priceAlert:triggered", (alert) => {
  console.log("🚨 ALERT:", alert);
});

socket.on("tokenFeed", ({ tokens }) => {
  console.log(
    `🪙 ${tokens.length} tokens (avg score: ${
      tokens.reduce((sum, t) => sum + (t.score || 0), 0) / tokens.length
    })`,
  );
});
```

---

## Environment Variables

```env
# Cache TTL (milliseconds)
CACHE_TOKEN_METADATA_TTL=300000   # 5 min
CACHE_TOKEN_PRICE_TTL=10000       # 10 sec
CACHE_TOKEN_DISCOVERY_TTL=30000   # 30 sec
CACHE_QUOTE_TTL=5000              # 5 sec

# Service intervals
TOKEN_DISCOVERY_INTERVAL_MS=30000  # 30 sec
POSITION_MONITOR_INTERVAL_MS=5000  # 5 sec
```

---

## REST API Endpoints

### Configuration Management

#### `GET /api/config`

Get current runtime configuration.

**Response:**

```json
{
  "success": true,
  "config": {
    "minMarketCapSol": 5,
    "maxMarketCapSol": 1000000,
    "minMarketCapUsd": 1000,
    "maxMarketCapUsd": 200000000,
    "minSecondsSinceLaunch": 10,
    "maxSecondsSinceLaunch": 60,
    "minTokenScore": 30,
    "takeProfitPct": 0.1,
    "stopLossPct": 0.02
  }
}
```

#### `PATCH /api/config`

Update configuration dynamically (no restart required).

**Request Body:**

```json
{
  "minMarketCapSol": 10,
  "maxMarketCapSol": 500000,
  "minTokenScore": 40
}
```

**Response:**

```json
{
  "success": true,
  "config": {
    /* updated config */
  },
  "message": "Configuration updated successfully"
}
```

**Side Effect:** Emits `config:update` to all connected clients.

#### `POST /api/config/reset`

Reset configuration to environment defaults.

**Response:**

```json
{
  "success": true,
  "config": {
    /* default config */
  },
  "message": "Configuration reset to defaults"
}
```

---

## Summary

✅ **All features now emit to frontend:**

- ✅ Token scoring/ranking → `tokenFeed` with `score` and `riskLevel`
- ✅ Rug pull detection → included in token feed
- ✅ TP/SL automation → `tradeFeed` with reason
- ✅ API retry logic → transparent (reduces errors)
- ✅ Token age filtering → tokens have `age` field
- ✅ Balance checks → `tradeError` on insufficient funds
- ✅ Watchlist → `watchlist:update` on all changes
- ✅ Price alerts → `priceAlert:triggered` when conditions met
- ✅ P&L tracking → `pnl:update` every 30s
- ✅ Caching → improves all response times
- ✅ **Dynamic config → `config:update` on changes (no restart needed!)**

**Frontend receives real-time updates for everything! 🚀**
