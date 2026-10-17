# Wallet Balance Sync & Risk Management System

## Overview

The trading bot now includes:

1. **Continuous Wallet Balance Syncing** - Automatic real-time balance updates every 5 seconds
2. **Risk-Based Trade Sizing** - Calculate position sizes based on percentage or fixed amount
3. **Real-Time PnL Tracking** - Portfolio dashboard reflects live profit/loss fluctuations
4. **Smart Risk Management** - Pre-configured risk profiles (Conservative/Moderate/Aggressive)

## Features

### 1. Automatic Wallet Balance Syncing

**Backend Service:** `walletBalance.service.ts`

#### How It Works

- Starts automatically when wallet connects via Socket.io
- Polls Solana RPC every 5 seconds for balance updates
- Calculates real-time PnL against initial balance
- Emits updates only when balance changes (> 0.00001 SOL difference)
- Stops automatically on wallet disconnect

#### Socket Events

**`wallet:balance` Event (Backend → Frontend)**

```typescript
{
  wallet: string; // Wallet address
  balance: number; // Current balance in SOL
  initialBalance: number; // Balance when connected
  pnl: {
    sol: number; // Profit/Loss in SOL
    percent: number; // Profit/Loss percentage
  }
  timestamp: number; // Unix timestamp
}
```

#### Service Methods

```typescript
// Start balance syncing for a wallet
startWalletBalanceSync(io, wallet, socketId, {
  intervalMs: 5000, // Sync every 5 seconds
  initialBalance: 10.5, // Optional initial balance
});

// Stop syncing
stopWalletBalanceSync(wallet);

// Update socket ID (on reconnection)
updateWalletSocketId(wallet, newSocketId);

// Get sync info
getWalletSyncInfo(wallet);

// Get all active syncs
getAllActiveWalletSyncs();

// Stop all syncs (shutdown)
stopAllWalletSyncs();
```

### 2. Risk Management System

**Backend Endpoint:** `POST /api/trade/calculate-risk`

#### Request

```json
{
  "balance": 10.5, // Wallet balance in SOL
  "riskPercent": 2, // OR
  "riskAmount": 0.21 // Fixed SOL amount
}
```

#### Response

```json
{
  "success": true,
  "data": {
    "balance": 10.5,
    "riskPercent": 2, // Calculated percentage
    "riskAmount": 0.21, // Calculated amount
    "amountLamports": 210000000,
    "recommendation": {
      "conservative": 0.105, // 1% of balance
      "moderate": 0.2625, // 2.5% of balance
      "aggressive": 0.525 // 5% of balance
    }
  }
}
```

#### Risk Calculation Logic

**Method 1: Percentage-Based**

```typescript
riskAmount = (balance * riskPercent) / 100;
```

**Method 2: Fixed Amount**

```typescript
riskPercent = (riskAmount / balance) * 100;
```

**Validation:**

- Minimum: 0.001 SOL
- Maximum: 100% of balance
- Default: 1% if no parameters provided

**Risk Levels:**

- **Conservative:** ≤ 2% (Green)
- **Moderate:** 2-5% (Yellow)
- **Aggressive:** > 5% (Red)

### 3. Frontend Components

#### `useRiskManagement` Hook

```typescript
const {
  riskPercent, // Current risk percentage
  riskAmount, // Current risk amount in SOL
  setRiskPercent, // Set risk by percentage
  setRiskAmount, // Set risk by fixed amount
  calculateRisk, // Trigger calculation
  tradeAmountLamports, // Amount in lamports for transaction
  isCalculating, // Loading state
  recommendation, // Risk presets
} = useRiskManagement();
```

**Auto-calculation:** Automatically recalculates when balance or risk parameters change.

#### `RiskManagementPanel` Component

**Features:**

- Display current wallet balance
- Input fields for risk % or fixed SOL amount
- Quick preset buttons (Conservative/Moderate/Aggressive)
- Real-time risk level indicator
- Trade amount summary
- Remaining balance calculator
- High-risk warning (> 10%)
- Educational info tooltips

**Usage:**

```tsx
<RiskManagementPanel
  onAmountChange={(amount, lamports) => {
    // Update trade amount
    setTradeAmount(lamports);
  }}
/>
```

### 4. Portfolio Dashboard Updates

#### `usePortfolio` Hook Enhancements

Now listens to `wallet:balance` events from backend:

```typescript
useEffect(() => {
  if (lastMessage.event === "wallet:balance") {
    const { balance, initialBalance, pnl } = lastMessage.payload;

    updateStats({
      portfolioValue: balance,
      initialBalance: initialBalance,
      totalProfitSol: pnl.sol,
      totalProfitPercent: pnl.percent,
    });
  }
}, [lastMessage]);
```

**Real-Time PnL Updates:**

- Balance updates every 5 seconds
- PnL calculated server-side
- No manual refresh needed
- Reflects trade outcomes immediately

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────┐
│ 1. Wallet Connection                                │
│    Frontend → Socket.io → Backend                   │
│    emit("identify", { wallet, balance, ... })       │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 2. Start Balance Sync                               │
│    Backend: startWalletBalanceSync()                │
│    - Create 5-second polling interval               │
│    - Store sync info in Map                         │
│    - Query Solana RPC for balance                   │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 3. Continuous Sync Loop (every 5s)                  │
│    - getBalance() from Solana                       │
│    - Calculate PnL vs initial balance               │
│    - If changed: emit("wallet:balance")             │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 4. Frontend Receives Update                         │
│    - useSocket listens to wallet:balance            │
│    - usePortfolio updates stats                     │
│    - Dashboard re-renders with new PnL              │
└─────────────────────────────────────────────────────┘
```

### Risk Calculation Flow

```
┌─────────────────────────────────────────────────────┐
│ 1. User Adjusts Risk                                │
│    - Slider: 2% of balance                          │
│    - OR Fixed: 0.5 SOL                              │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 2. Auto-Calculate (useEffect)                       │
│    POST /api/trade/calculate-risk                   │
│    { balance: 10, riskPercent: 2 }                  │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 3. Backend Validates & Calculates                   │
│    - Amount = balance * 0.02 = 0.2 SOL              │
│    - Lamports = 0.2 * 1e9 = 200,000,000             │
│    - Generate recommendations                        │
└────────────────┬────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────┐
│ 4. Frontend Updates                                 │
│    - Display: 0.2 SOL (2%)                          │
│    - Risk Level: Conservative (Green)               │
│    - Pass lamports to trade function                │
└─────────────────────────────────────────────────────┘
```

## Usage Examples

### Example 1: Connect Wallet & Auto-Sync

```typescript
// Frontend automatically starts syncing on wallet connect
const { connectWallet } = useWallet();
await connectWallet();

// Backend automatically:
// 1. Receives identify event
// 2. Starts balance sync service
// 3. Begins emitting wallet:balance every 5s

// Frontend usePortfolio automatically updates:
usePortfolio(); // Stats update in real-time
```

### Example 2: Calculate Risk for Trade

```typescript
// User sets 2.5% risk
const { setRiskPercent, tradeAmountLamports } = useRiskManagement();
setRiskPercent(2.5);

// Automatically calculates and provides lamports
// Use in trade execution:
await executeTrade("buy", tokenMint, tradeAmountLamports);
```

### Example 3: Quick Preset Selection

```tsx
<RiskManagementPanel
  onAmountChange={(amount, lamports) => {
    console.log(`Trade amount set: ${amount} SOL (${lamports} lamports)`);
    setTradeConfig({ amount, amountLamports: lamports });
  }}
/>

// User clicks "Moderate" preset
// → Automatically sets 2.5% of balance
// → Calculates exact lamports
// → Triggers onAmountChange callback
```

## Configuration

### Balance Sync Interval

```typescript
// Default: 5 seconds
await startWalletBalanceSync(io, wallet, socketId, {
  intervalMs: 3000, // Change to 3 seconds
});
```

**Recommendations:**

- **Fast:** 3 seconds (high RPC usage, most responsive)
- **Default:** 5 seconds (balanced)
- **Conservative:** 10 seconds (low RPC usage, slower updates)

### Risk Calculation Limits

```typescript
// In trade.route.ts
const MIN_TRADE_SIZE = 0.001; // 0.001 SOL
const MAX_RISK_PERCENT = 100; // 100% of balance
const DEFAULT_RISK_PERCENT = 1; // 1% if not specified
```

## API Reference

### Backend Endpoints

#### Calculate Risk

```http
POST /api/trade/calculate-risk
Content-Type: application/json

{
  "balance": 10.5,
  "riskPercent": 2
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "balance": 10.5,
    "riskPercent": 2,
    "riskAmount": 0.21,
    "amountLamports": 210000000,
    "recommendation": {
      "conservative": 0.105,
      "moderate": 0.2625,
      "aggressive": 0.525
    }
  }
}
```

### Socket Events

#### Client → Server

**`identify`** - Register wallet and start syncing

```typescript
socket.emit("identify", {
  wallet: "DYw8jCT...",
  balanceSol: 10.5,
  autoMode: true,
  manualAmountSol: 0.1,
});
```

#### Server → Client

**`wallet:balance`** - Real-time balance update

```typescript
socket.on("wallet:balance", (data) => {
  console.log("Balance:", data.balance);
  console.log("PnL:", data.pnl.sol, "SOL");
  console.log("PnL %:", data.pnl.percent, "%");
});
```

## Testing

### Manual Testing

**Test 1: Balance Sync Start**

```bash
# 1. Connect wallet in frontend
# 2. Check backend logs:
"🔄 Starting balance sync for wallet DYw8jCT..."
"✅ Balance sync started for DYw8jCT... (1 active syncs)"

# 3. Check frontend console every 5 seconds:
"💰 Real-time balance update from backend: {...}"
```

**Test 2: Risk Calculation**

```bash
# 1. Set balance = 10 SOL
# 2. Set risk = 5%
# 3. Expected output:
#    - riskAmount: 0.5 SOL
#    - riskPercent: 5%
#    - Level: Moderate (Yellow)
#    - Remaining: 9.5 SOL
```

**Test 3: Trade Execution with Risk**

```bash
# 1. Set risk to "Conservative" (1%)
# 2. Click "Buy Now"
# 3. Verify trade uses correct amount:
#    If balance = 10 SOL → trade size = 0.1 SOL
```

**Test 4: Real-Time PnL**

```bash
# 1. Note initial balance: 10 SOL
# 2. Execute a trade (buy 0.1 SOL worth)
# 3. Wait 5 seconds
# 4. Backend should detect balance change
# 5. Frontend portfolio should update automatically
# 6. PnL should reflect new balance vs initial
```

### Automated Tests

```typescript
// walletBalance.service.test.ts
describe("Wallet Balance Sync", () => {
  it("should start syncing and emit initial balance", async () => {
    const io = mockSocketServer();
    const wallet = "DYw8jCT...";
    const socketId = "socket123";

    await startWalletBalanceSync(io, wallet, socketId);

    expect(io.to).toHaveBeenCalledWith(socketId);
    expect(io.to().emit).toHaveBeenCalledWith(
      "wallet:balance",
      expect.objectContaining({
        wallet,
        balance: expect.any(Number),
      })
    );
  });

  it("should stop syncing on disconnect", () => {
    stopWalletBalanceSync("DYw8jCT...");

    const sync = getWalletSyncInfo("DYw8jCT...");
    expect(sync).toBeUndefined();
  });
});

// useRiskManagement.test.ts
describe("Risk Management Hook", () => {
  it("should calculate 2% risk correctly", async () => {
    const { result } = renderHook(() => useRiskManagement(), {
      wrapper: ({ children }) => (
        <WalletProvider balance={10}>{children}</WalletProvider>
      ),
    });

    act(() => {
      result.current.setRiskPercent(2);
    });

    await waitFor(() => {
      expect(result.current.riskAmount).toBe(0.2);
      expect(result.current.tradeAmountLamports).toBe(200_000_000);
    });
  });
});
```

## Troubleshooting

### Issue: Balance not updating

**Check:**

1. Wallet connected? (`useWallet().connected`)
2. Backend logs show sync started?
3. Socket connected? (check browser console)
4. RPC endpoint responding? (check backend logs)

**Debug:**

```typescript
// Frontend console
socket.on("wallet:balance", (data) => {
  console.log("✅ Received balance update:", data);
});

// Backend logs
[walletBalance] 🔄 Starting balance sync for wallet...
[walletBalance] 💰 Balance updated for DYw8jCT...: 10.5234 SOL
```

### Issue: Risk calculation incorrect

**Check:**

1. Balance > 0?
2. Risk percent/amount > minimum?
3. Backend endpoint accessible?

**Debug:**

```bash
curl -X POST http://localhost:4000/api/trade/calculate-risk \
  -H "Content-Type: application/json" \
  -d '{"balance": 10, "riskPercent": 2}'
```

### Issue: PnL not reflecting trades

**Possible causes:**

1. Balance hasn't updated yet (wait 5 seconds)
2. Trade failed (check transaction signature)
3. Initial balance not set correctly

**Solution:**

- Ensure initial balance captured on connection
- Wait for balance sync interval
- Check that trades are on-chain confirmed

## Performance Considerations

### RPC Rate Limits

**Balance sync makes 1 RPC call every 5 seconds per wallet:**

- 1 wallet = 12 calls/minute = 720 calls/hour
- 10 wallets = 120 calls/minute = 7,200 calls/hour
- 100 wallets = 1,200 calls/minute = 72,000 calls/hour

**Recommendations:**

- Use paid RPC for > 20 concurrent users
- Increase interval to 10s for > 50 users
- Implement RPC request pooling for > 100 users

### Memory Usage

**Each active sync stores:**

- Wallet address (32 bytes)
- Socket ID (~20 bytes)
- Interval handle (~8 bytes)
- Balance data (~16 bytes)
- **Total: ~76 bytes per wallet**

**Example:**

- 100 active wallets = ~7.6 KB
- 1,000 active wallets = ~76 KB
- 10,000 active wallets = ~760 KB

### CPU Usage

**Minimal impact:**

- Interval callbacks are lightweight
- Balance comparison is simple math
- Socket emission is event-driven
- No heavy computation

## Future Enhancements

### Planned Features

1. **Position Size Recommendations**

   - Based on token volatility
   - Based on holder count
   - Based on liquidity depth

2. **Risk Profiles**

   - Save custom risk profiles
   - Per-token risk settings
   - Time-based risk adjustment

3. **Advanced PnL Tracking**

   - Per-token PnL breakdown
   - Historical PnL charts
   - Winning/losing streak tracking

4. **Stop-Loss Integration**

   - Auto-calculate stop-loss from risk %
   - Monitor positions for stop triggers
   - Execute stop-loss trades automatically

5. **Multi-Wallet Support**
   - Sync multiple wallets simultaneously
   - Aggregate portfolio view
   - Cross-wallet risk management

## Related Documentation

- [POOL_MONITORING.md](./POOL_MONITORING.md) - Pool availability monitoring
- [TOKEN_LIFECYCLE_VALIDATION.md](./TOKEN_LIFECYCLE_VALIDATION.md) - Token validation
- [SOCKET_EVENTS.md](./SOCKET_EVENTS.md) - Complete socket event reference
