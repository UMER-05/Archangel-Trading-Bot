# Raydium-Only Trading System

## 🎯 Overview

This is the **professional trader's setup** - focusing exclusively on Raydium pools for guaranteed liquidity, fewer rugs, and faster execution.

## ✅ Why Raydium-Only?

### Advantages:

- ✅ **Guaranteed liquidity at entry** - LP already exists when you buy
- ✅ **Fewer rugs than Pump.fun** - Tokens have already graduated
- ✅ **Cleaner technical setups** - More mature price action
- ✅ **Faster execution** - No graduation delays or bonding curve issues
- ✅ **No false "tradable" status** - Every pool is guaranteed swappable

### The Problem This Solves:

On Pump.fun, you can encounter:

- Tokens that appear tradable but have no LP yet
- Graduation delays causing failed swaps
- Extreme volatility during bonding curve phase
- Higher rug pull risk before graduation

With Raydium-only, these issues **never happen**.

---

## 🏗️ System Architecture

```
Raydium Pool Listener (Real-Time WebSocket)
        ↓
Pool Safety Validator (6 Critical Checks)
        ↓
Liquidity Filter (Minimum LP Size)
        ↓
Auto Buy Engine (Optional)
        ↓
PnL & Portfolio Tracker
```

---

## 🔧 Core Components

### 1. **Raydium Pool Listener** (`raydiumPoolListener.service.ts`)

- Listens for `initializePool` / `createPool` events in real-time
- Uses WebSocket connection for instant detection
- Tracks all detected pools to avoid duplicates
- Configurable via environment variables

### 2. **Pool Safety Validator** (`raydiumPoolValidator.service.ts`)

Performs 6 critical safety checks:

| Check                | Purpose                           | Recommended Value |
| -------------------- | --------------------------------- | ----------------- |
| **Liquidity**        | Ensures sufficient LP for trading | ≥ 20-50 SOL       |
| **Mint Authority**   | Prevents unlimited minting        | ❌ Disabled       |
| **Freeze Authority** | Prevents token freezing           | ❌ Disabled       |
| **Buy Tax**          | Avoids excessive fees             | ≤ 5%              |
| **Sell Tax**         | Ensures you can exit              | ≤ 5%              |
| **Honeypot**         | Detects scam tokens               | ❌ Not a honeypot |

**Optional Check:**

- **LP Locked/Burned** - Prevents rug pulls (may filter some good tokens)

### 3. **Manual Buy Service** (`manualBuy.service.ts`)

- Executes instant buys on validated pools
- Price impact protection (aborts if >15%)
- Configurable slippage (8-12%)
- Position tracking with live PnL
- Supports both real and simulated trades

---

## 🚀 Quick Setup

### 1. Environment Configuration

Copy `.env.example` to `.env` and configure:

```bash
# Enable Raydium pool listener
RAYDIUM_POOL_LISTENER=true

# Minimum LP size (20-50 SOL recommended)
MIN_RAYDIUM_LP_SOL=20

# Maximum taxes
MAX_BUY_TAX_PCT=5
MAX_SELL_TAX_PCT=5

# Safety requirements
REQUIRE_MINT_DISABLED=true
REQUIRE_FREEZE_DISABLED=true
REQUIRE_LP_LOCKED=false  # Optional but safer

# Auto-buy (CAREFUL - starts with false)
RAYDIUM_AUTO_BUY=false
RAYDIUM_AUTO_BUY_SOL=0.1

# WebSocket RPC for real-time events
WS_RPC_URL=wss://api.mainnet-beta.solana.com
```

### 2. Start the Backend

```bash
cd backend
npm install
npm start
```

The Raydium pool listener will start automatically if `RAYDIUM_POOL_LISTENER=true`.

### 3. Frontend Component

Add the `RaydiumPoolListener` component to your trading page:

```tsx
import { RaydiumPoolListener } from "@components/trading/RaydiumPoolListener";

export default function TradingPage() {
  return (
    <div>
      <RaydiumPoolListener />
      {/* Other components */}
    </div>
  );
}
```

---

## 📊 How It Works

### Real-Time Detection Flow:

1. **New Pool Created on Raydium**

   - Raydium program emits `initializePool` event
   - Listener catches event via WebSocket

2. **Extract Pool Information**

   - Pool ID
   - Token mint address
   - Initial LP size in SOL

3. **Validate Pool (6 Checks)**

   ```typescript
   ✅ LP ≥ 20 SOL
   ✅ Mint authority disabled
   ✅ Freeze authority disabled
   ✅ Buy tax ≤ 5%
   ✅ Sell tax ≤ 5%
   ✅ Not a honeypot
   ```

4. **Store in Database**

   - State: `DETECTED_ON_RAYDIUM` or `BLACKLISTED`
   - Save validation results for tracking

5. **Auto-Buy (Optional)**
   - If enabled and all checks pass
   - Execute instant buy at configured amount
   - Track position with live PnL

---

## 🎮 Manual Controls

### Via Frontend Component:

- **Start/Stop Listener** - Toggle real-time detection
- **Configure Filters** - Adjust safety parameters
- **Enable/Disable Auto-Buy** - Control automatic purchases
- **Monitor Stats** - View detected pools count

### Via API:

```bash
# Get status
GET /api/raydium-listener/status

# Start listener
POST /api/raydium-listener/start

# Stop listener
POST /api/raydium-listener/stop

# Update configuration
POST /api/raydium-listener/config
{
  "minLiquiditySol": 30,
  "maxBuyTax": 3,
  "autoBuyEnabled": true
}
```

---

## 🛡️ Safety Features

### Built-In Protection:

1. **Price Impact Check**

   - Aborts if price impact > 15%
   - Prevents buying illiquid pools

2. **Slippage Protection**

   - Configurable 8-12% max slippage
   - Applied to all swaps

3. **Authority Verification**

   - Checks mint/freeze authorities on-chain
   - Filters tokens with dangerous permissions

4. **Tax Validation**

   - Queries RugCheck API for buy/sell taxes
   - Blocks tokens with excessive fees

5. **Honeypot Detection**

   - Checks for known scam patterns
   - Prevents buying unsellable tokens

6. **Duplicate Prevention**
   - Tracks all detected pools
   - Avoids reprocessing same pool

---

## 📈 Position Tracking

All trades are automatically tracked with:

- Entry price
- Token amount
- SOL invested
- Current PnL (live updates)
- Portfolio impact

Access via:

- Frontend dashboard
- `/api/positions` endpoint
- Real-time Socket.IO events

---

## ⚠️ Important Notes

### Auto-Buy Feature:

**USE WITH EXTREME CAUTION!**

- Start with `RAYDIUM_AUTO_BUY=false`
- Test with simulation mode first (`USE_REAL_SWAP=false`)
- Use small amounts initially
- Monitor closely for the first few detections

### WebSocket RPC:

- Required for real-time event detection
- Free tier: `wss://api.mainnet-beta.solana.com`
- For production, consider paid RPC providers:
  - Helius
  - QuickNode
  - Alchemy

### LP Locked Check:

- Currently simplified (always returns false)
- Full implementation requires:
  - LP token distribution analysis
  - Known locker address checking
  - Burn address verification

---

## 🔥 Advanced Usage

### Dynamic Position Sizing:

```typescript
import { calculatePositionSize, getSolBalance } from "./manualBuy.service";

const wallet = "YourWalletAddress";
const balance = await getSolBalance(wallet);
const riskPercent = 2; // 2% risk per trade

const buyAmount = await calculatePositionSize(balance, riskPercent);
// If balance = 10 SOL, buyAmount = 0.2 SOL
```

### Custom Validation Logic:

Extend `raydiumPoolValidator.service.ts` with additional checks:

- Holder distribution analysis
- Creator wallet scanning
- Historical LP tracking
- Social sentiment scoring

---

## 🐛 Troubleshooting

### Listener Not Starting:

- Check `RAYDIUM_POOL_LISTENER=true` in `.env`
- Verify WebSocket RPC URL is accessible
- Check backend logs for connection errors

### No Pools Detected:

- Ensure WebSocket connection is active
- Verify Raydium program ID is correct
- Check if filters are too strict

### Auto-Buy Not Working:

- Confirm `RAYDIUM_AUTO_BUY=true`
- Check `USE_REAL_SWAP=true` for real trades
- Verify wallet has sufficient SOL balance
- Review validation logs for failed checks

---

## 📚 API Reference

### Listen Events:

```typescript
socket.on("raydium:newPool", (data) => {
  console.log("New pool detected:", data);
});

socket.on("raydium:validatedPool", (data) => {
  console.log("Pool passed validation:", data);
});

socket.on("raydium:autoBuyExecuted", (data) => {
  console.log("Auto-buy successful:", data);
});
```

---

## 🎯 Best Practices

1. **Start Conservative**

   - Begin with high min LP (50+ SOL)
   - Require all safety checks
   - Disable auto-buy initially

2. **Gradual Optimization**

   - Lower filters as you gain confidence
   - Enable auto-buy with small amounts
   - Increase position sizes slowly

3. **Monitor Performance**

   - Track hit rate of validated pools
   - Analyze PnL of auto-buys
   - Adjust filters based on results

4. **Risk Management**
   - Never exceed 2-3% per trade
   - Set hard stop losses
   - Diversify across multiple tokens

---

## 🚀 Future Enhancements

Potential additions:

- [ ] MEV protection integration
- [ ] Multi-pool basket buying
- [ ] Advanced holder analysis
- [ ] LP lock verification (full implementation)
- [ ] Machine learning risk scoring
- [ ] Social sentiment integration
- [ ] Copy trading functionality

---

## 📞 Support

For issues or questions:

1. Check backend logs: Look for `raydium-pool-listener` module
2. Review validation results in database
3. Test with simulation mode first
4. Adjust filters incrementally

---

**Remember: This is a professional trading tool. Start small, test thoroughly, and never risk more than you can afford to lose.**
