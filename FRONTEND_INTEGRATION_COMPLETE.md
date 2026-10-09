# Frontend Integration - 2-Tranche Buying & Tiered Profits

## ✅ Status: Complete

All new backend socket events are now properly handled and displayed in the frontend.

---

## Socket Events Integrated

### 1. **Tranche Buy Events**

- `tranche1_buy` - First 60% entry
- `tranche2_buy` - Second 40% entry

**Payload Fields:**

```typescript
{
  ...trade,
  auto: true,
  reason: "tranche1_buy" | "tranche2_buy",
  route: "pump.fun" | "raydium",
  tranche: "1 of 2 (60%)" | "2 of 2 (40%)"
}
```

**Frontend Display:**

- `LiveTrades.tsx` - Shows "BUY 1 of 2 (60%)" or "BUY 2 of 2 (40%)"
- `live-feed.tsx` - Enhanced message with tranche info
- Green styling for buy events

---

### 2. **Tiered Profit Events**

- `tiered_profit` - 30% sells at profit targets

**Payload Fields:**

```typescript
{
  ...trade,
  auto: true,
  reason: "tiered_profit",
  exitReason: "Tier 1: +40% profit" | "Tier 2: +80% profit" | "Tier 3: +150% profit",
  sellPercent: 30,
  remainingPct: 70 | 40 | 10
}
```

**Frontend Display:**

- `LiveTrades.tsx` - Shows "SELL 30% (Tier X) - 70% remaining"
- `live-feed.tsx` - "SELL 30% at Tier 1: +40% profit (70% left)"
- Red styling for sell events

---

### 3. **Emergency Exit Events**

- `emergency_exit` - Critical exit triggers

**Payload Fields:**

```typescript
{
  ...trade,
  auto: true,
  reason: "emergency_exit",
  exitReason: "LP removed (rug pull)" | "60% price crash" | "Large sell detected" | "Creator wallet activity",
  emergency: true
}
```

**Frontend Display:**

- `LiveTrades.tsx` - Shows "🚨 EMERGENCY EXIT: [reason]" with red border
- `live-feed.tsx` - "🚨 EMERGENCY: [reason]"
- `EmergencyAlert.tsx` - Pop-up notification (top-right)
- Critical red styling with border

---

### 4. **Trailing Stop Events**

- `trailing_stop_final` - Last 10% exit via trailing
- `position:trailingUpdate` - Trailing activation updates

**Payload Fields:**

```typescript
// tradeFeed
{
  ...trade,
  auto: true,
  reason: "trailing_stop_final",
  exitReason: "Trailing stop on final 10% (peak: +200%, current: +195%)",
  sellPercent: 10,
  remainingPct: 0,
  highestPnlPct: 2.0
}

// position:trailingUpdate
{
  token: string,
  currentPnlPct: number,
  highestPnlPct: number,
  trailingActivated: boolean,
  trailingStopPct: number,
  trailingActivationPct: number,
  drawdownFromPeak: number,
  timestamp: number
}
```

**Frontend Display:**

- `LiveTrades.tsx` - "SELL (Trailing Stop - Final 10%)"
- `EmergencyAlert.tsx` - Warning notification when trailing activates
- Yellow/blue styling

---

### 5. **Trade Error Events**

- `tradeError` - Failed trades and test sell failures

**Payload Fields:**

```typescript
{
  type: "test_sell_failed_emergency_exit" | "tranche1_failed" | "insufficient_balance",
  mint: string,
  error?: string,
  message: string,
  reason?: string,
  emergencyExitSignature?: string
}
```

**Frontend Display:**

- `EmergencyAlert.tsx` - Error notification
- Orange styling for errors

---

## New Components Created

### 1. **EmergencyAlert.tsx**

Pop-up notification system for critical events.

**Features:**

- Fixed position (top-right)
- Auto-dismisses after 10 seconds
- Manual dismiss button
- 3 severity levels: emergency (red), error (orange), warning (yellow)
- Animated entrance/exit
- Stacks multiple alerts

**Location:** `frontend/components/trading/EmergencyAlert.tsx`

**Usage:** Added to main trading page layout

---

### 2. **TrancheProgress.tsx**

Visual progress tracker for tranche entry and tiered exits.

**Features:**

- Tranche entry status (1/2 complete, 2/2 complete)
- Position remaining % (100% → 70% → 40% → 10% → 0%)
- Profit tier badges (Tier 1/2/3 with checkmarks)
- Progress bar to next tier
- Trailing stop indicator (when active on final 10%)
- Peak PnL tracking

**Props:**

```typescript
{
  token: string,
  firstTrancheEntry?: number,
  secondTrancheEntry?: number,
  remainingPct?: number,
  soldAt40?: boolean,
  soldAt80?: boolean,
  soldAt150?: boolean,
  currentPnl?: number,
  trailingActivated?: boolean,
  highestPnlPct?: number
}
```

**Location:** `frontend/components/trading/TrancheProgress.tsx`

**Usage:** Can be integrated into PositionsPanel or individual position cards

---

## Files Modified

### Hooks:

1. **`useSocket.ts`**

   - Added listeners for `position:trailingUpdate`
   - Added listeners for `tradeError`

2. **`useTrailingStop.tsx`**
   - Fixed import to use `useSocket` instead of non-existent `SocketProvider`

### Components:

3. **`LiveTrades.tsx`**

   - Enhanced message builder for tranches, tiers, emergencies
   - Added emergency styling (red border + bold)
   - Shows tranche info (1 of 2, 2 of 2)
   - Shows tier info (30% sold, X% remaining)

4. **`live-feed.tsx`**

   - Enhanced message builder matching LiveTrades
   - Shows detailed tranche/tier information
   - Emergency warnings

5. **`page.tsx`** (trading dashboard)
   - Imported and added `EmergencyAlert` component
   - Positioned at top of page for visibility

---

## Visual Examples

### Tranche Buy Display:

```
🟢 12:34:56 — BUY 1 of 2 (60%) - PUMP...abc123
🟢 12:35:42 — BUY 2 of 2 (40%) - PUMP...abc123
```

### Tiered Profit Display:

```
🔴 12:40:15 — SELL 30% (Tier 1: +40% profit) - 70% remaining  +45.2%
🔴 12:52:30 — SELL 30% (Tier 2: +80% profit) - 40% remaining  +85.7%
🔴 13:15:20 — SELL 30% (Tier 3: +150% profit) - 10% remaining +155.3%
```

### Emergency Exit Display:

```
┌────────────────────────────────────────────────┐
│ 🚨 EMERGENCY EXIT: LP removed (rug pull)      │
│ ────────────────────────────────────────────── │
│ 12:45:30                               [X]     │
└────────────────────────────────────────────────┘
```

### Trailing Stop Display:

```
🔴 13:30:45 — SELL (Trailing Stop - Final 10%) - Position Fully Exited  +195.8%

┌────────────────────────────────────────────────┐
│ 📉 Trailing Stop Active: PUMP...abc123        │
│ Peak: +200.5% | Current: +195.8%              │
│ ────────────────────────────────────────────── │
│ 13:30:40                               [X]     │
└────────────────────────────────────────────────┘
```

---

## Integration Status

| Feature                     | Backend | Frontend | Status       |
| --------------------------- | ------- | -------- | ------------ |
| 2-Tranche Buying            | ✅      | ✅       | **Complete** |
| Test Sell                   | ✅      | ✅       | **Complete** |
| Emergency Exit on Test Fail | ✅      | ✅       | **Complete** |
| Tiered Profit Targets (30%) | ✅      | ✅       | **Complete** |
| Trailing Stop (Final 10%)   | ✅      | ✅       | **Complete** |
| LP Removal Detection        | ✅      | ✅       | **Complete** |
| Large Sell Detection        | ✅      | ✅       | **Complete** |
| 60% Red Candle Detection    | ✅      | ✅       | **Complete** |
| Creator Sell Detection      | ✅      | ✅       | **Complete** |
| Position Tracking           | ✅      | ✅       | **Complete** |

---

## Testing Checklist

### Real-time Events:

- [ ] Tranche 1 buy displays with "1 of 2 (60%)"
- [ ] Tranche 2 buy displays with "2 of 2 (40%)"
- [ ] Test sell failure triggers emergency alert
- [ ] Tier 1 (+40%) displays "SELL 30% - 70% remaining"
- [ ] Tier 2 (+80%) displays "SELL 30% - 40% remaining"
- [ ] Tier 3 (+150%) displays "SELL 30% - 10% remaining"
- [ ] Trailing stop activates on final 10%
- [ ] Emergency exits show 🚨 with red border
- [ ] Emergency alert pops up top-right
- [ ] Alerts auto-dismiss after 10 seconds

### Visual Styling:

- [ ] Tranche buys = green background
- [ ] Tier sells = red background
- [ ] Emergency exits = red border + bold
- [ ] Trailing activations = yellow/blue warning
- [ ] Alert colors match severity (red/orange/yellow)

---

## Next Steps

### Optional Enhancements:

1. **Integrate TrancheProgress Component**

   - Add to PositionsPanel for each open position
   - Shows visual progress of entry and exit strategy

2. **Position Details Modal**

   - Click on position to see full tranche/tier history
   - Timeline view of entry and exit events

3. **Analytics Dashboard**

   - Track average tranche entry efficiency
   - Tier hit rates (how often each tier is reached)
   - Emergency exit frequency and causes

4. **Sound Notifications**

   - Play sound on emergency exits
   - Different tones for each tier hit

5. **Mobile Responsiveness**
   - Optimize EmergencyAlert for mobile screens
   - Adjust TrancheProgress for smaller viewports

---

## Summary

✅ **All backend socket events are now properly integrated into the frontend**

The frontend will now display:

- **Tranche information** for split entries
- **Tier progress** for partial exits
- **Emergency warnings** for critical situations
- **Trailing stop updates** for final position
- **Error notifications** for failed trades

All events are styled appropriately and provide clear visual feedback to the user about the automated trading system's actions.

**Build Status:** ✅ Successful (no errors)
**Type Safety:** ✅ All TypeScript types validated
**Socket Events:** ✅ All 5 event types handled
