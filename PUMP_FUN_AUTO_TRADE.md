# Pump.fun Auto-Trading Integration

## Overview

The auto-buyer service now supports trading tokens on Pump.fun bonding curves in addition to Raydium pools. This enables automatic purchases of newly launched tokens before they graduate to Raydium.

## Changes Made

### 1. `autoBuyer.service.ts` Updates

#### New Import

```typescript
import { getPumpFunQuote, executePumpFunTrade } from "./pumpfun.service.js";
```

#### Intelligent Routing

The service now detects the token's lifecycle stage and routes trades accordingly:

- **`pump_fun_bonding`** → Trade via Pump.fun
- **`graduated_with_liquidity`** → Trade via Raydium
- **`unknown`** → Defaults to Raydium (backward compatible)

#### Key Logic

```typescript
const lifecycleStage = token.lifecycleStage || "unknown";
const isPumpFun = lifecycleStage === "pump_fun_bonding";

// Get quote from appropriate DEX
if (isPumpFun) {
  quote = await getPumpFunQuote(mint, lamports, true);
} else {
  quote = await getRaydiumQuote(SOL_MINT, mint, lamports, 1);
}

// Execute trade via appropriate route
if (isPumpFun) {
  swap = await executePumpFunTrade(mint, true, lamports, wallet, slippageBps);
} else {
  swap = await executeRaydiumSwap({...});
}
```

## How It Works

### Token Discovery Flow

1. **Token Discovery** (`tokenDiscovery.service.ts`)

   - Fetches new tokens from DexScreener
   - Filters by age, market cap, holder count

2. **Lifecycle Validation** (`tokenLifecycle.service.ts`)

   - Checks if token is on Pump.fun bonding curve
   - Validates Raydium pool existence
   - Sets `lifecycleStage` field on token object

3. **Auto-Buy Execution** (`autoBuyer.service.ts`)
   - Reads `lifecycleStage` from token
   - Routes to Pump.fun or Raydium
   - Executes trade and stores record

### Trade Routing Decision Matrix

| Lifecycle Stage            | Trading Route      | Quote Method        | Swap Method             |
| -------------------------- | ------------------ | ------------------- | ----------------------- |
| `pump_fun_bonding`         | Pump.fun           | `getPumpFunQuote()` | `executePumpFunTrade()` |
| `graduated_with_liquidity` | Raydium            | `getRaydiumQuote()` | `executeRaydiumSwap()`  |
| `graduated_no_liquidity`   | ❌ Skipped         | N/A                 | N/A                     |
| `unknown`                  | Raydium (fallback) | `getRaydiumQuote()` | `executeRaydiumSwap()`  |

## Benefits

### 1. **Earlier Entry Points**

- Trade tokens immediately after launch on Pump.fun
- No need to wait for Raydium graduation
- Access to bonding curve pricing

### 2. **Seamless Migration**

- Automatically switches to Raydium after graduation
- Pool monitoring service notifies when token migrates
- No manual intervention required

### 3. **Backward Compatible**

- Existing tokens without lifecycle data default to Raydium
- No breaking changes to existing functionality
- Graceful fallback for unknown stages

## Logging & Monitoring

### Auto-Buy Logs

```
INFO Auto-buy routing decision {mint, lifecycleStage, route: "Pump.fun"}
INFO AutoBuy stored {mint, price, id, simulated, route: "pump.fun"}
```

### Socket Events

```typescript
io.emit("tradeFeed", {
  ...trade,
  auto: true,
  reason: "auto_buy",
  route: "pump.fun", // or "raydium"
});
```

## Configuration

### Environment Variables

```bash
# Enable real trades (default: simulation mode)
USE_REAL_SWAP=true

# Auto-buy amount per token
BUY_AMOUNT_SOL=0.1

# Slippage tolerance (converted to basis points for Pump.fun)
DEFAULT_SLIPPAGE_PCT=1
```

### Slippage Conversion

- **Raydium**: Uses percentage directly (1 = 1%)
- **Pump.fun**: Converts to basis points (1% → 100 bps)

## Testing

### 1. Simulation Mode (Default)

```bash
# In .env
USE_REAL_SWAP=false
```

- No real transactions executed
- Signatures prefixed with `sim-autoBuy-pumpfun-` or `sim-autoBuy-raydium-`
- Safe for testing routing logic

### 2. Live Mode

```bash
# In .env
USE_REAL_SWAP=true
BACKEND_RECEIVER_WALLET=<your-wallet-pubkey>
BACKEND_PRIVATE_KEY=<base58-private-key>
```

- Real trades executed on-chain
- Requires sufficient SOL balance
- Monitor logs for transaction signatures

### 3. Monitoring Pool Migration

When a Pump.fun token graduates to Raydium:

```
INFO [poolMonitor] Pool available for token XYZ
→ Socket event: poolAvailable {mint, poolId, stage: "graduated_with_liquidity"}
→ Next auto-buy will route to Raydium automatically
```

## Error Handling

### No Quote Available

```
INFO Not tradable / no Pump.fun quote {mint}
→ Token skipped, no trade executed
```

### Insufficient Balance

```
WARN Insufficient balance for auto-buy {wallet, requiredSol, mint}
→ Socket event: tradeError {type: "insufficient_balance", required: 0.1}
```

### Trade Execution Failure

```
ERROR Swap failed {error: "Transaction failed"}
→ Trade not recorded in database
→ No tradeFeed event emitted
```

## Frontend Integration

### Trade Feed Display

The frontend receives enhanced trade events:

```typescript
socket.on("tradeFeed", (trade) => {
  console.log(`Auto-buy executed via ${trade.route}`); // "pump.fun" or "raydium"
});
```

### Token Badge

Tokens display their lifecycle stage in the UI:

- 🟢 **Pump.fun** - On bonding curve
- 🟡 **Migrating** - Pool detected, awaiting liquidity
- 🔵 **Raydium** - Fully graduated

## Architecture Diagram

```
┌─────────────────────┐
│ Token Discovery     │
│ (DexScreener)       │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Lifecycle Validator │
│ - Check Pump.fun    │
│ - Check Raydium     │
│ - Set stage field   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Auto-Buyer Router   │
│ if pump_fun_bonding │
│   → Pump.fun        │
│ else                │
│   → Raydium         │
└──────────┬──────────┘
           │
           ├─────────────────┬─────────────────┐
           ▼                 ▼                 ▼
    ┌──────────┐      ┌──────────┐     ┌──────────┐
    │ Pump.fun │      │ Raydium  │     │ Database │
    │ Execute  │      │ Execute  │     │ Record   │
    └──────────┘      └──────────┘     └──────────┘
```

## Performance Considerations

### 1. **Quote Fetching**

- Pump.fun quotes fetch bonding curve account data (~0.5s)
- Raydium quotes query pool state (~1s with retries)
- Both cached with 5-second TTL

### 2. **Transaction Speed**

- Pump.fun: Direct program instruction (~2-3s confirmation)
- Raydium: AMM swap with multiple accounts (~3-5s confirmation)

### 3. **Rate Limiting**

- Both services respect RPC rate limits
- Exponential backoff on 429 errors
- Connection pooling for concurrent trades

## Troubleshooting

### Issue: "Not tradable / no Pump.fun quote"

**Cause**: Bonding curve account doesn't exist or token already graduated  
**Solution**: Pool monitoring will detect graduation and route to Raydium next cycle

### Issue: "No Raydium pool found"

**Cause**: Token still on Pump.fun, lifecycle stage not updated  
**Solution**: Ensure `tokenLifecycle.service.ts` runs before auto-buyer

### Issue: Duplicate trades via both routes

**Cause**: Lifecycle stage not set or race condition  
**Solution**: Check logs for `lifecycleStage` value, ensure sequential execution

### Issue: High slippage on Pump.fun

**Cause**: Bonding curve pricing volatile at low market caps  
**Solution**: Increase `DEFAULT_SLIPPAGE_PCT` or reduce `BUY_AMOUNT_SOL`

## Future Enhancements

1. **Dynamic Slippage**: Adjust based on bonding curve progress
2. **Multi-Route Quotes**: Compare Pump.fun vs Raydium pricing
3. **Graduated Token Notification**: Alert when token leaves bonding curve
4. **Historical Route Analysis**: Track which route performed better
5. **Custom Route Override**: Manual selection per token

## Related Files

- `backend/src/services/autoBuyer.service.ts` - Main routing logic
- `backend/src/services/pumpfun.service.ts` - Pump.fun trading functions
- `backend/src/services/tokenLifecycle.service.ts` - Lifecycle validation
- `backend/src/services/poolMonitor.service.ts` - Migration detection
- `TOKEN_LIFECYCLE_VALIDATION.md` - Lifecycle stage documentation
- `POOL_MONITORING.md` - Pool availability system

## Support

For issues or questions:

1. Check logs for routing decisions: `grep "Auto-buy routing" logs/app.log`
2. Verify lifecycle stages: `grep "lifecycleStage" logs/app.log`
3. Monitor socket events in browser console
4. Review trade records in MongoDB: `db.trades.find({auto: true})`
