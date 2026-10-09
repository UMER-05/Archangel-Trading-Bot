# 2-Tranche Buying & Tiered Profit Targets - Implementation Complete

## Overview

Successfully implemented the final 2 features of the 10-stage trading system:

1. **2-Tranche Buying Strategy** (Rule 8)
2. **Tiered Profit Targets & Emergency Exits** (Rules 9 & 10)

All TypeScript compilation checks passed ✅

---

## Feature 1: 2-Tranche Buying Strategy

### Implementation Details

#### New Service: `trancheBuyer.service.ts`

Created dedicated service for split entry execution:

**Functions:**

- `executeFirstTranche()` - Buys 60% of position
- `executeTestSell()` - Sells 0.5% to verify liquidity
- `waitForPullback()` - Monitors for 2% price dip (5-minute timeout)
- `executeSecondTranche()` - Buys remaining 40% of position

**Flow:**

```
1. Execute First Tranche (60%)
   ├─ Buy 60% of total position size
   └─ Record trade and timestamp

2. Test Sell (0.5%)
   ├─ Sell 0.5% of received tokens
   ├─ Verify liquidity exists
   └─ IF FAILS → Emergency exit ALL tokens
      └─ Use 5% slippage for emergency
      └─ Abort second tranche

3. Wait for Pullback
   ├─ Monitor price every 5 seconds
   ├─ Wait for 2% dip from entry
   └─ Timeout: 5 minutes (then proceed anyway)

4. Execute Second Tranche (40%)
   ├─ Buy remaining 40% of position
   ├─ Calculate weighted average entry
   └─ Update position metadata
```

#### Updated Services:

- **`autoBuyer.service.ts`**:

  - Replaced single buy with 2-tranche flow
  - Added emergency exit on failed test sell
  - Records both tranches as separate trades
  - Emits `tranche1_buy` and `tranche2_buy` events

- **`db.service.ts`**:
  - Extended `Position` type with:
    - `firstTrancheEntry?: number` - Timestamp of first buy
    - `secondTrancheEntry?: number` - Timestamp of second buy
    - `remainingPct?: number` - Track position percentage (100% → 0%)

---

## Feature 2: Tiered Profit Targets & Emergency Exits

### Implementation Details

#### New Service: `emergencyExit.service.ts`

Created comprehensive emergency detection system:

**Functions:**

- `checkLPRemoval()` - Detects liquidity pool removal (rug pull)
- `detectLargeSell()` - Identifies single sells ≥50% of LP
- `detectRedCandle()` - Monitors for 60% price crash in 10 seconds
- `detectCreatorSell()` - Tracks creator wallet activity
- `checkAllEmergencyTriggers()` - Runs all checks, exits if ANY critical trigger

**Severity Levels:**

- `critical` - Instant exit (LP removal, 60% crash)
- `high` - Exit if 2+ triggers (large sell, creator sell)
- `medium` - Monitor only

#### Updated Services:

**`monitor.service.ts`** - Enhanced with 3-tier profit system:

```
PRIORITY 1: Emergency Exits (RULE 10)
├─ Check ALL emergency triggers FIRST
├─ If ANY critical trigger → Sell 100% immediately
└─ Use 10% slippage for emergency swaps

PRIORITY 2: Tiered Profit Targets (RULE 9)
├─ At +40% profit → Sell 30% (remainingPct: 100% → 70%)
├─ At +80% profit → Sell 30% (remainingPct: 70% → 40%)
├─ At +150% profit → Sell 30% (remainingPct: 40% → 10%)
└─ Track sold tiers: soldAt40, soldAt80, soldAt150

PRIORITY 3: Trailing Stop for Final 10%
├─ When remainingPct ≤ 10%
├─ Activate trailing at +15% from entry
└─ Exit on 5% drawdown from peak

PRIORITY 4: Stop Loss
└─ Sell remaining position at -2% loss
```

**Database Extensions:**

- **`Position` type** now includes:

  - `soldAt40?: boolean` - Tier 1 profit taken
  - `soldAt80?: boolean` - Tier 2 profit taken
  - `soldAt150?: boolean` - Tier 3 profit taken
  - `remainingPct?: number` - Current position size percentage

- **`PositionMetadata` type** extended with all new fields for persistence

---

## Trade Flow Example

### Successful 2-Tranche Buy:

```
1. Token graduates from Pump.fun → Raydium
2. 3-condition validation passes
3. 30-second behavior observation passes
4. Risk management check passes (2% position, <3 open, <6% daily loss)

5. FIRST TRANCHE (60%)
   ├─ Buy 0.06 SOL worth
   ├─ Receive 1,000,000 tokens @ 0.00000006 SOL/token
   └─ Emit tradeFeed: "tranche1_buy"

6. TEST SELL (0.5%)
   ├─ Sell 5,000 tokens (0.5% of 1M)
   ├─ Receive ~0.0003 SOL
   └─ ✅ Liquidity verified

7. WAIT FOR PULLBACK
   ├─ Entry: 0.00000006 SOL/token
   ├─ Target: 0.00000059 SOL/token (2% dip)
   └─ Price dips to 0.00000058 after 45 seconds

8. SECOND TRANCHE (40%)
   ├─ Buy 0.04 SOL worth
   ├─ Receive 690,000 tokens @ 0.00000058 SOL/token
   ├─ Total: 1,690,000 tokens
   ├─ Weighted avg: 0.00000059 SOL/token
   └─ Emit tradeFeed: "tranche2_buy"
```

### Tiered Exit Example:

```
Position: 1,690,000 tokens @ 0.00000059 SOL/token avg entry

+40% PROFIT (0.00000083 SOL/token):
├─ Sell 507,000 tokens (30%)
├─ Remaining: 1,183,000 tokens (70%)
└─ Emit tradeFeed: "tiered_profit" (Tier 1)

+80% PROFIT (0.00000106 SOL/token):
├─ Sell 507,000 tokens (30%)
├─ Remaining: 676,000 tokens (40%)
└─ Emit tradeFeed: "tiered_profit" (Tier 2)

+150% PROFIT (0.00000148 SOL/token):
├─ Sell 507,000 tokens (30%)
├─ Remaining: 169,000 tokens (10%)
└─ Emit tradeFeed: "tiered_profit" (Tier 3)

FINAL 10%:
├─ Activate trailing stop
├─ Peak: +200% (0.00000177 SOL/token)
├─ Exit at: +195% (0.00000174 SOL/token - 5% drawdown)
└─ Emit tradeFeed: "trailing_stop_final"
```

---

## Emergency Exit Scenarios

### Scenario 1: LP Removal Detected

```
Monitor detects pool account missing
→ 🚨 EMERGENCY: Sell ALL immediately
→ Use 10% slippage to ensure execution
→ Emit: reason="emergency_exit", exitReason="LP removed (rug pull)"
```

### Scenario 2: 60% Red Candle

```
Price: 0.00000100 → 0.00000040 in 8 seconds
→ 60% crash detected
→ 🚨 EMERGENCY: Sell ALL immediately
→ Emit: reason="emergency_exit", exitReason="60% price crash in 10 seconds"
```

### Scenario 3: Large Sell Detected

```
Single transaction sells >10 SOL worth
→ Large sell detected
→ 🚨 EMERGENCY: Sell ALL immediately
→ Emit: reason="emergency_exit", exitReason="Large sell detected (12.5 SOL)"
```

---

## Socket Events for Frontend

### New Trade Events:

- `tranche1_buy` - First 60% buy executed
- `tranche2_buy` - Second 40% buy executed
- `tiered_profit` - 30% sold at profit tier
- `trailing_stop_final` - Last 10% exited via trailing
- `emergency_exit` - Emergency exit executed
- `test_sell_failed_emergency_exit` - Test sell failed, position liquidated

### Event Payload Extensions:

```typescript
tradeFeed: {
  // Standard fields...
  tranche?: "1 of 2 (60%)" | "2 of 2 (40%)",
  sellPercent?: number,        // % of position sold
  remainingPct?: number,        // % of position remaining
  emergency?: boolean,          // Emergency exit flag
  exitReason?: string,          // Human-readable exit reason
}
```

---

## Configuration

### Environment Variables (Existing):

```bash
# Trading mode
TRADING_MODE=aggressive  # or "safe"

# Risk management
MAX_RISK_PER_TRADE_PCT=2
MAX_OPEN_POSITIONS=3
MAX_DAILY_LOSS_PCT=6

# Trailing stop
TRAILING_ACTIVATION_PCT=0.15  # 15%
TRAILING_STOP_PCT=0.05        # 5%

# Execution
USE_REAL_SWAP=true
DEFAULT_SLIPPAGE_PCT=1
BUY_AMOUNT_SOL=0.1
```

### Hardcoded Constants (Can be made configurable):

```typescript
// trancheBuyer.service.ts
FIRST_TRANCHE_PCT = 0.6; // 60% first buy
SECOND_TRANCHE_PCT = 0.4; // 40% second buy
TEST_SELL_PCT = 0.005; // 0.5% test sell
PULLBACK_THRESHOLD = 0.98; // 2% dip
PULLBACK_TIMEOUT_MS = 300000; // 5 minutes

// monitor.service.ts
TIER_1_PROFIT = 0.4; // +40%
TIER_2_PROFIT = 0.8; // +80%
TIER_3_PROFIT = 1.5; // +150%
TIER_SELL_PCT = 30; // Sell 30% at each tier

// emergencyExit.service.ts
RED_CANDLE_THRESHOLD = 0.6; // 60% drop
RED_CANDLE_WINDOW_MS = 10000; // 10 seconds
LARGE_SELL_SOL = 10; // 10 SOL threshold
```

---

## Files Modified/Created

### New Files:

1. `backend/src/services/trancheBuyer.service.ts` (379 lines)

   - 2-tranche buy execution logic
   - Test sell verification
   - Pullback detection

2. `backend/src/services/emergencyExit.service.ts` (326 lines)
   - Emergency trigger detection
   - LP removal monitoring
   - Red candle detection
   - Creator sell tracking

### Modified Files:

1. `backend/src/services/autoBuyer.service.ts`

   - Replaced single buy with 2-tranche flow
   - Added emergency exit on test sell failure
   - Records both tranches separately

2. `backend/src/services/monitor.service.ts`

   - Added emergency exit checks (priority 1)
   - Implemented tiered profit targets
   - Updated trailing stop to only apply to final 10%
   - Enhanced trade feed events

3. `backend/src/services/db.service.ts`
   - Extended `Position` type with tranche tracking
   - Extended `PositionMetadata` with tier flags

---

## Testing Checklist

### 2-Tranche Buying:

- [ ] First tranche executes (60%)
- [ ] Test sell succeeds (0.5%)
- [ ] Second tranche executes (40%) after pullback
- [ ] Emergency exit triggers on failed test sell
- [ ] Weighted average price calculated correctly
- [ ] Both trades recorded in database

### Tiered Profit Targets:

- [ ] 30% sells at +40% profit
- [ ] 30% sells at +80% profit
- [ ] 30% sells at +150% profit
- [ ] Remaining % tracked correctly (100 → 70 → 40 → 10)
- [ ] Tiers don't trigger twice (soldAt40/80/150 flags work)

### Trailing Stop (Final 10%):

- [ ] Activates at +15% profit
- [ ] Tracks highest PnL correctly
- [ ] Exits on 5% drawdown from peak
- [ ] Only applies when remainingPct ≤ 10%

### Emergency Exits:

- [ ] LP removal detection works
- [ ] Large sell detection works
- [ ] 60% red candle detection works
- [ ] Creator sell detection works
- [ ] Emergency uses 10% slippage
- [ ] All emergency exits bypass normal TP/SL

### Stop Loss:

- [ ] -2% stop loss sells remaining position
- [ ] Works at any stage (100%, 70%, 40%, 10%)

---

## Complete 10-Stage Trading System Summary

✅ **Stage 1**: Pump.fun Detection → Watchlist only (AWAITING_GRADUATION)
✅ **Stage 2**: Raydium Graduation → Trigger buy evaluation
✅ **Stage 3**: 3-Condition Validation → Liquidity + Security + Migration
✅ **Stage 4**: Security Deep Dive → Creator ≤20%, Top 3 ≤60%, Authorities
✅ **Stage 5**: 30-Second Behavior → Micro-dump, higher lows, volume, no large sells
✅ **Stage 6**: Risk Management → 2% per trade, 3 max positions, 6% daily loss
✅ **Stage 7**: Balance Check → Verify sufficient SOL before trade
✅ **Stage 8**: 2-Tranche Buy → 60% + test sell + 40% on pullback
✅ **Stage 9**: Tiered Profit Targets → 30% at +40%, +80%, +150%, trailing 10%
✅ **Stage 10**: Emergency Exits → LP removal, large sells, red candles, creator dumps

---

## Next Steps

1. **Testing**: Test all new features in simulation mode first

   - Set `USE_REAL_SWAP=false`
   - Monitor trade feed events
   - Verify position tracking

2. **Frontend Integration**: Update frontend to display:

   - Tranche buy progress (1 of 2, 2 of 2)
   - Position remaining % (100% → 70% → 40% → 10%)
   - Tier profit targets hit
   - Emergency exit alerts

3. **Monitoring**: Watch for:

   - Test sell failures (may indicate low liquidity)
   - Pullback timeouts (may need adjustment)
   - False positive emergency triggers
   - Weighted average price calculations

4. **Production**: Once tested:
   - Set `USE_REAL_SWAP=true`
   - Start with small `BUY_AMOUNT_SOL` (0.05)
   - Monitor first few trades closely
   - Adjust thresholds based on results

---

## Risk Warnings

⚠️ **2-Tranche Buying**: First tranche may execute but second may fail. Position will remain at 60% in this case.

⚠️ **Test Sell**: If test sell fails, emergency exit sells entire first tranche. This is a safety feature but may result in a loss.

⚠️ **Emergency Exits**: Use 10% slippage which may result in worse prices. This is intentional for speed of execution.

⚠️ **Tiered Profits**: If price moves quickly through multiple tiers, some sells may be missed. Tiers are checked sequentially.

⚠️ **Final Trailing Stop**: Only activates when position is ≤10%. Earlier positions use tiered targets, not trailing.

---

## System Status

✅ All 10 trading rules implemented
✅ TypeScript compilation successful (0 errors)
✅ Complete documentation provided
✅ Ready for testing

**Total Implementation**: 9 major features across 13 files, ~2,000+ lines of new code.
