# Manual Buy Configuration

## Overview

The manual buy system has **NO SAFETY VALIDATIONS** - it's designed for traders who have done their own research and are ready to accept full risk. Only auto-buy uses the 6-point validation system.

## Configuration Separation

### Auto-Buy (Raydium Pool Listener)

**Triggered by**: Validated pools from `raydiumPoolListener.service.ts`  
**Config Variables**:

- `RAYDIUM_AUTO_BUY=true` - Enable/disable auto-buy
- `RAYDIUM_AUTO_BUY_SOL=0.05` - Fixed amount per auto-buy (0.05 SOL)
- **Price Impact**: Hardcoded 15% max for safety
- **Slippage**: Uses default from Raydium quote

**Identification**: `reason: "raydium_pool_auto_buy"`

### Manual Buy (UI Trades)

**Triggered by**: User-initiated trades from frontend UI  
**Config Variables**:

```env
MANUAL_BUY_DEFAULT_SLIPPAGE_PCT=10   # Default slippage if not specified
```

**Validations**: ❌ NONE - No amount limits, no price impact checks, no safety validations  
**Identification**: `reason: "manual_ui"` or undefined  
**Philosophy**: User has done their own research and accepts all risks

## How It Works

### Decision Logic in `executeManualBuy()`

```typescript
const isAutoBuy = reason === "raydium_pool_auto_buy";
const isManual = !isAutoBuy;

if (isManual) {
  // Manual buy: NO VALIDATIONS
  - No amount checks
  - No price impact blocking (logs warning only)
  - Use MANUAL_BUY_DEFAULT_SLIPPAGE_PCT if not provided
  - User assumes all risk
} else {
  // Auto-buy: STRICT VALIDATIONS
  - Fixed amount (RAYDIUM_AUTO_BUY_SOL)
  - 15% max price impact (blocks trade)
  - 6-point pool safety checks required
}
```

### Key Differences

| Feature          | Auto-Buy             | Manual Buy                            |
| ---------------- | -------------------- | ------------------------------------- |
| **Amount**       | Fixed 0.05 SOL       | Any amount (no limits)                |
| **Price Impact** | 15% max (blocks)     | No limit (logs warning only)          |
| **Slippage**     | Quote default        | 10% default (configurable)            |
| **Validation**   | 6-point pool safety  | ❌ NONE                               |
| **Trigger**      | Validated pool event | User button click                     |
| **Risk**         | Conservative         | User discretion (full responsibility) |

## Configuration Guide

### Manual Trading (Current Setup)

```env
MANUAL_BUY_DEFAULT_SLIPPAGE_PCT=10   # Only configurable parameter
```

**No amount limits** - User can trade any amount  
**No price impact blocking** - Trade executes regardless of impact  
**No safety validations** - User responsibility to check liquidity, authorities, taxes

### Current Setup (Balanced)

```env
MANUAL_BUY_MIN_SOL=0.01
MANUAL_BUY_MAX_SOL=1.0
MANUAL_BUY_DEFAULT_SLIPPAGE_PCT=10
MANUAL_BUY_MAX_PRICE_IMPACT_PCT=20
```

## Safety Features

### Auto-Buy Safety

- Requires passing all 6 validation checks:
  1. Liquidity ≥ 2 SOL
  2. Mint authority disabled
  3. Freeze authority disabled
  4. Buy tax ≤ 5%
  5. Sell tax ≤ 5%
  6. Optional: LP locked
- Conservative 15% price impact limit
- Fixed small amount (0.05 SOL)

### Manual Buy: NO SAFETY FEATURES

- ❌ No amount validation
- ❌ No price impact blocking
- ❌ No liquidity checks
- ❌ No authority checks (mint/freeze)
- ❌ No tax checks
- ✅ Only slippage configuration (user-controlled)
- ⚠️ **User assumes full responsibility for trade safety**

## Error Handling

### Auto-Buy Rejection

```
Auto-buy rejected: Price impact too high: 16.5%
Aborting for safety.
```

### Manual Buy Behavior

```
⚠️ Manual buy proceeding with 45.2% price impact (no restrictions)
✅ Trade executed - user discretion
```

**Manual buys never reject due to price impact** - they only log warnings

## Implementation Details

### Modified Files

1. **backend/.env** - Removed validation variables, kept only MANUAL_BUY_DEFAULT_SLIPPAGE_PCT
2. **backend/src/services/manualBuy.service.ts** - Split logic by `reason` parameter

### Code Flow

````
1. executeManualBuy(params) called
   ├─> Check reason parameter
   │   ├─> "raydium_pool_auto_buy" → Apply 6-point validation + 15% price impact limit
   │   └─> "manual_ui" or undefined → NO VALIDATIONS, execute immediately
   │
2. Apply appropriate configuration
   ├─> Manual: Skip all checks, use default slippage if not provided
   └─> Auto: Strict validation (already passed pool validator)

3. Get Raydium quote with effectiveSlippage

4. Price impact check
   ├─> Auto-buy: Block if >15%
   └─> Manual: Log warning but continue

5. Execute swap with effectiveSlippage

6. Store trade in database with reason field
```## Testing Scenarios

### Test Auto-Buy (Validated Pools Only)

1. Set `RAYDIUM_AUTO_BUY=true`
2. Set `RAYDIUM_AUTO_BUY_SOL=0.05`
3. Wait for pool passing all 6 validation checks
4. Should execute at 0.05 SOL, abort if price impact >15%

### Test Manual Buy (No Restrictions)

1. Try manual buy at 0.001 SOL → ✅ Should succeed (no min)
2. Try manual buy at 10 SOL → ✅ Should succeed (no max)
3. Try token with 50% price impact → ✅ Should succeed (logs warning only)
4. Try token with disabled authorities → ✅ Should succeed (no authority checks)

### Verify Separation

- Auto-buy: Only trades validated pools with <15% price impact
- Manual buy: Trades ANY token at ANY amount with ANY price impact

## Recommended Settings

**Current Setup**:

```env
# Auto-buy: Conservative with 6-point validation
RAYDIUM_AUTO_BUY=true
RAYDIUM_AUTO_BUY_SOL=0.05

# Manual buy: No restrictions, user discretion only
MANUAL_BUY_DEFAULT_SLIPPAGE_PCT=10
````

## Future Enhancements (Optional)

If you want to add **optional** safety features to manual buy later:

- `MANUAL_BUY_REQUIRE_CONFIRMATION=true` - UI confirmation popup
- `MANUAL_BUY_SHOW_WARNINGS=true` - Display risk warnings (but don't block)
- `MANUAL_BUY_LOG_LEVEL=warn` - Extra logging for high-risk trades

**Note**: Current implementation has zero validations by design

## API Endpoint

**POST** `/api/trade/manual-buy`

**Request Body:**

```json
{
  "tokenMint": "string (required)",
  "amountSol": "number (required)",
  "slippage": "number (optional, default: 10)",
  "wallet": "string (optional)"
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "signature": "transaction_signature",
    "tokensReceived": 12345.6789,
    "pricePerToken": 0.00001234,
    "trade": {
      /* database record */
    }
  }
}
```

## Frontend Integration

**Hook:** `useManualBuy()`

```tsx
import { useManualBuy } from "@hooks/useManualBuy";

const { executeManualBuy, loading } = useManualBuy();

await executeManualBuy({
  tokenMint: "ABC123...",
  amountSol: 0.5,
  slippage: 10,
});
```

**Component:** `<ManualBuyPanel />`

- Input: Token mint address
- Input: Amount in SOL (no limits)
- Input: Slippage % (default 10%)
- Warning: Displays risk disclaimer
- Button: Execute manual buy with no validations

## Notes

- **No Interference**: Manual buy has NO validations and does NOT affect auto-buy behavior
- **User Responsibility**: Manual traders must do their own research (DYOR)
- **Risk Warning**: Manual buy can execute on rugs, honeypots, high-tax tokens - user assumes all risk
- **Frontend Hook**: Use `useManualBuy()` hook with `executeManualBuy()` function
- **API Endpoint**: `POST /api/trade/manual-buy` bypasses all safety checks
- **Database Tracking**: All trades store `reason: "manual_ui"` field for analytics
- **Auto-buy Separation**: Auto-buy uses `reason: "raydium_pool_auto_buy"` with full validation

---

**Status**: ✅ Fully Implemented - Backend + Frontend + API  
**Last Updated**: December 9, 2025  
**Files Created/Modified**:

- `backend/src/routes/trade.route.ts` - Added `/api/trade/manual-buy` endpoint
- `backend/src/services/manualBuy.service.ts` - No validation for `reason: "manual_ui"`
- `frontend/hooks/useManualBuy.ts` - React hook for manual buy
- `frontend/components/trading/ManualBuyPanel.tsx` - UI component with warnings
