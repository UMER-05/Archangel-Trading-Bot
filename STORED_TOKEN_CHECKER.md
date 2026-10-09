# Stored Token Checker - Delayed Trading Opportunities

## Overview

The **Stored Token Checker** is a background service that periodically re-evaluates previously discovered tokens to identify delayed trading opportunities. This system captures tokens that initially failed immediate trading criteria but may become tradeable later.

## Problem Solved

When a new Raydium pool is created, it may not immediately meet trading criteria:

- **Low Liquidity**: Pool has only 0.03 SOL, but requirement is 0.05 SOL
- **Too Old**: Pool was discovered 10 minutes after creation (max age: 5 minutes)
- **Failed Validation**: Token failed safety checks but conditions improve later

Without the Stored Token Checker, these opportunities would be permanently missed. With it, the bot continuously monitors stored tokens and automatically trades them when conditions improve.

## Architecture

### 1. Token Storage Flow

```
New Raydium Pool Detected
         ↓
Save Token to Database (ALL tokens)
         ↓
Check Immediate Trading Criteria
         ↓
    ┌────────┴────────┐
    ↓                 ↓
Pass Filters    Fail Filters
    ↓                 ↓
Validate Now    Store for Later ← Stored Token Checker
    ↓                 ↓
Auto-Trade      Re-evaluate Periodically
```

### 2. Services

#### `raydiumPoolListener.service.ts`

- **Role**: Primary token discovery
- **Behavior**:
  - Saves ALL detected tokens to database
  - Only validates tokens that pass immediate filters
  - Skipped tokens remain in database for later evaluation

#### `storedTokenChecker.service.ts`

- **Role**: Periodic re-evaluation
- **Behavior**:
  - Runs every 5 minutes (configurable)
  - Queries database for tokens in specific states
  - Re-validates each token against current market conditions
  - Auto-trades qualified tokens

#### `db.service.ts`

- **Role**: Token state persistence
- **Key Methods**:
  - `upsertTokenState()` - Save/update token
  - `getTokensByStates()` - Query tokens by state
  - `getTokenState()` - Get single token

## Configuration

### Environment Variables (.env)

```bash
# Enable/disable the stored token checker
STORED_TOKEN_CHECKER_ENABLED=true

# How often to check stored tokens (milliseconds)
# Default: 300000 (5 minutes)
STORED_TOKEN_CHECK_INTERVAL_MS=300000

# Maximum tokens to check per cycle (prevents overload)
# Default: 20
MAX_TOKENS_PER_CHECK=20

# Minimum time before re-checking same token (milliseconds)
# Default: 900000 (15 minutes)
MIN_TIME_BETWEEN_TOKEN_CHECKS=900000
```

### Token States Checked

The checker evaluates tokens in these states:

- `RAYDIUM_POOL_CREATED` - Pool exists but not traded yet
- `AWAITING_GRADUATION` - Pump.fun tokens waiting for Raydium graduation
- `VALIDATION_FAILED` - Previously failed validation, may pass now

### Filters Applied

Tokens must pass the same filters as immediate trading:

1. **Liquidity**: Pool has ≥ 0.05 SOL liquidity (configurable via `MIN_RAYDIUM_LP_SOL`)
2. **Validation**: Passes all 8 stages of validation pipeline
3. **Rate Limiting**: Not checked more than once per 15 minutes

## Socket Events

### Frontend Events

#### `storedTokenChecker:status`

Emitted on every check cycle

```typescript
{
  timestamp: string;
  totalChecked: number; // Tokens checked in this cycle
  qualified: number; // Tokens that met criteria
  isChecking: boolean; // Currently running check
}
```

#### `storedTokenChecker:qualified`

Emitted when a stored token qualifies

```typescript
{
  timestamp: string;
  token: {
    mint: string;
    symbol: string;
    name: string;
    poolId: string;
  }
  validation: {
    liquiditySol: number;
    isValid: boolean;
  }
}
```

## Frontend Integration

### Hook: `useStoredTokenChecker()`

```typescript
import { useStoredTokenChecker } from "@hooks/useStoredTokenChecker";

function MyComponent() {
  const {
    status, // Current checker status
    qualifiedTokens, // Recently qualified tokens (last 50)
    totalQualified, // Total qualified count
    isActive, // Is checking now
  } = useStoredTokenChecker();

  return (
    <div>
      <p>Checked: {status?.totalChecked}</p>
      <p>Qualified: {status?.qualified}</p>
    </div>
  );
}
```

### Component: `StoredTokenCheckerStatus`

Display real-time checker activity:

```tsx
import { StoredTokenCheckerStatus } from "@components/trading/StoredTokenCheckerStatus";

<StoredTokenCheckerStatus />;
```

## Example Scenarios

### Scenario 1: Liquidity Growth

1. **T+0**: Pool created with 0.03 SOL liquidity
2. **T+0**: Saved to database, skipped for immediate trading
3. **T+5min**: Stored checker runs, pool now has 0.08 SOL
4. **T+5min**: ✅ Qualifies! Validation pipeline starts
5. **T+5min**: Auto-trade executed

### Scenario 2: Delayed Discovery

1. **T+0**: Pool created
2. **T+10min**: Bot discovers pool (too old for immediate trade)
3. **T+10min**: Saved to database
4. **T+15min**: Stored checker validates pool
5. **T+15min**: ✅ Still valid! Auto-trade executed

### Scenario 3: Validation Improvement

1. **T+0**: Pool fails validation (high sell tax)
2. **T+0**: Saved with state `VALIDATION_FAILED`
3. **T+30min**: Developer renounces token, removes sell tax
4. **T+35min**: Stored checker re-validates
5. **T+35min**: ✅ Now passes! Auto-trade executed

## Performance Considerations

### Rate Limiting

- **Per-Token Cooldown**: Tokens checked only once per 15 minutes
- **Batch Limit**: Max 20 tokens per cycle (prevents database overload)
- **Check Interval**: 5 minutes between cycles (configurable)

### Database Query Optimization

```typescript
// Efficient query with filters
getTokensByStates(['RAYDIUM_POOL_CREATED', 'VALIDATION_FAILED'], {
  limit: 20,                              // Limit results
  minCreatedAt: new Date(Date.now() - 7d), // Only recent tokens
  hasRaydiumPool: true                    // Must have pool ID
})
```

### Memory Management

- In-memory map tracks last check times: `Map<mint, timestamp>`
- Automatically cleaned on service restart
- Frontend keeps only last 50 qualified tokens

## Monitoring & Debugging

### Backend Logs

```bash
# Service initialization
[stored-token-checker] 🔍 Stored Token Checker initialized
[stored-token-checker] ✅ Socket.IO connected
[stored-token-checker] 🚀 Starting stored token checker (interval: 300s)

# Check cycle
[stored-token-checker] 🔍 Checking stored tokens for trading opportunities...
[stored-token-checker] 📊 Found 15 stored tokens to evaluate
[stored-token-checker] Evaluating stored token: BONK
[stored-token-checker] ✅ BONK passed pool validation!
[stored-token-checker] 🎯 Starting validation pipeline for stored token BONK...
[stored-token-checker] ✅ Stored token check completed { checked: 15, qualified: 3 }
```

### Frontend Monitoring

Add the status component to your trading dashboard:

```tsx
import { StoredTokenCheckerStatus } from "@components/trading/StoredTokenCheckerStatus";

<div className="grid gap-4">
  <RaydiumPoolStatus />
  <StoredTokenCheckerStatus /> {/* ← Add this */}
</div>;
```

## Disabling the Feature

To disable stored token checking:

```bash
# In .env
STORED_TOKEN_CHECKER_ENABLED=false
```

The raydiumPoolListener will continue saving tokens, but periodic re-evaluation will stop.

## Future Enhancements

1. **Priority Queue**: Check tokens with highest liquidity growth first
2. **ML Predictions**: Predict which tokens are likely to improve
3. **Custom Strategies**: Per-token evaluation strategies
4. **Historical Analysis**: Track success rate of delayed trades vs immediate trades

## Related Documentation

- [Raydium Pool Listener](./RAYDIUM_TRADING_SYSTEM.md)
- [8-Stage Validation Pipeline](./VALIDATION_PIPELINE.md)
- [Token Lifecycle](./TOKEN_LIFECYCLE_VALIDATION.md)
