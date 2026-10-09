# Token Lifecycle Validation System

## Overview

The Token Lifecycle Validation system provides comprehensive post-launch validation for newly discovered tokens. It automatically detects tokens originating from Pump.fun, verifies their bonding and graduation status, confirms Raydium pool creation, and validates active liquidity. Tokens are then classified into "Tradable" and "Not Tradable" groups based on their lifecycle stage.

## Lifecycle Stages

### 1. `PUMP_FUN_BONDING`

- **Status**: ✅ Tradable
- **Description**: Token is active on Pump.fun bonding curve
- **Characteristics**:
  - Bonding curve account exists on-chain
  - Can be traded directly on Pump.fun
  - Has not yet graduated to Raydium
- **Trading**: Use Pump.fun DEX

### 2. `FULLY_TRADABLE`

- **Status**: ✅ Tradable
- **Description**: Graduated to Raydium with active, non-zero liquidity
- **Characteristics**:
  - Successfully graduated from Pump.fun
  - Raydium pool exists and is indexed
  - Pool has active SOL liquidity (> 0)
  - Can fetch valid trading quotes
- **Trading**: Use Raydium DEX

### 3. `GRADUATED_NO_POOL`

- **Status**: ⏳ Not Tradable (temporary)
- **Description**: Graduated from Pump.fun but Raydium pool not yet available
- **Characteristics**:
  - Bonding curve no longer exists
  - Raydium pool not yet indexed (2-5 minute delay typical)
  - Quote requests fail
- **Action**: Pool monitoring system automatically activates
- **Expected Resolution**: 2-10 minutes

### 4. `GRADUATED_ZERO_LIQUIDITY`

- **Status**: ⚠️ Not Tradable
- **Description**: Raydium pool exists but has zero or invalid liquidity
- **Characteristics**:
  - Pool found on Raydium
  - Liquidity = 0 SOL or unable to verify
  - Quote may succeed but trades will fail
- **Risk**: Potential rug pull or failed migration

### 5. `UNKNOWN`

- **Status**: ❓ Not Tradable
- **Description**: Unable to determine token status
- **Characteristics**:
  - Not a Pump.fun token, OR
  - Validation failed due to RPC errors, OR
  - Token from different DEX/protocol
- **Action**: Manual investigation required

## Architecture

### Backend Components

#### `tokenLifecycle.service.ts`

Main service providing lifecycle validation logic.

**Key Functions:**

```typescript
// Validate single token
validateTokenLifecycle(tokenMint: string): Promise<TokenLifecycleResult>

// Batch validate multiple tokens
validateTokenBatch(tokenMints: string[]): Promise<{
  tradable: TokenLifecycleResult[];
  notTradable: TokenLifecycleResult[];
  summary: ValidationSummary;
}>

// Get human-readable status message
getLifecycleStatusMessage(result: TokenLifecycleResult): string
```

**Validation Flow:**

```
1. Check Pump.fun bonding curve exists
   ├─ YES → Stage: PUMP_FUN_BONDING (Tradable)
   └─ NO → Continue to step 2

2. Check Raydium pool liquidity
   ├─ Has liquidity > 0 → Stage: FULLY_TRADABLE (Tradable)
   ├─ Has liquidity = 0 → Stage: GRADUATED_ZERO_LIQUIDITY (Not Tradable)
   └─ No pool found → Stage: UNKNOWN (Not Tradable)
```

**Result Structure:**

```typescript
interface TokenLifecycleResult {
  mint: string;
  stage: TokenLifecycleStage;
  isPumpFun: boolean; // Originated from Pump.fun
  hasBondingCurve: boolean; // Still on bonding curve
  hasGraduated: boolean; // Graduated to Raydium
  hasRaydiumPool: boolean; // Pool exists on Raydium
  hasLiquidity: boolean; // Pool has active liquidity
  liquiditySOL?: number; // SOL liquidity amount
  poolAddress?: string; // Raydium pool address
  isTradable: boolean; // Can be traded right now
  errorMessage?: string; // Error details if validation failed
  timestamp: number; // Validation timestamp
}
```

#### `tokenDiscovery.service.ts` Integration

The token discovery pipeline now includes lifecycle validation as a standard step.

**Enhanced Discovery Flow:**

```
1. Fetch tokens from DexScreener (boosted/trending)
   ↓
2. Filter by age, holders, score, risk level
   ↓
3. === NEW: Lifecycle Validation ===
   ├─ Batch validate all tokens
   ├─ Classify into tradable/notTradable
   └─ Enrich with lifecycle data
   ↓
4. Emit to frontend with lifecycle info
   ↓
5. Register ONLY tradable tokens for auto-buy
```

**Updated CandidateToken Type:**

```typescript
export type CandidateToken = {
  // ... existing fields ...

  // Lifecycle validation fields (new)
  lifecycleStage?: TokenLifecycleStage;
  lifecycleValidated?: boolean;
  isTradable?: boolean;
  hasGraduated?: boolean;
  hasLiquidity?: boolean;
  liquiditySOL?: number;
  poolAddress?: string;
};
```

**Enhanced Socket Emission:**

```typescript
io.emit("tokenFeed", {
  tokens: validatedCandidates, // All tokens with lifecycle data
  tradable: tradableTokens, // Only tradable tokens
  notTradable: notTradableTokens, // Non-tradable tokens
  lifecycleSummary: {
    // Validation statistics
    total: number,
    tradableCount: number,
    pumpFunBonding: number,
    fullyGraduated: number,
    graduatedNoPool: number,
    graduatedZeroLiquidity: number,
    unknown: number,
  },
});
```

### API Endpoints

#### Validate Single Token

```http
GET /api/tokens/lifecycle/:tokenMint
```

**Response:**

```json
{
  "success": true,
  "data": {
    "mint": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "stage": "fully_tradable",
    "isPumpFun": true,
    "hasBondingCurve": false,
    "hasGraduated": true,
    "hasRaydiumPool": true,
    "hasLiquidity": true,
    "liquiditySOL": 45.67,
    "poolAddress": "8sLbNZoA1cfn...",
    "isTradable": true,
    "timestamp": 1733529600000,
    "statusMessage": "✅ Graduated to Raydium with 45.67 SOL liquidity - Tradable"
  }
}
```

#### Validate Single Token (POST)

```http
POST /api/tokens/lifecycle/validate
Content-Type: application/json

{
  "tokenMint": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
}
```

**Response:** Same as GET endpoint

#### Batch Validate Tokens

```http
POST /api/tokens/lifecycle/validate
Content-Type: application/json

{
  "tokenMints": [
    "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump",
    "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump"
  ]
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "tradable": [
      {
        "mint": "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        "stage": "fully_tradable",
        "isTradable": true,
        "liquiditySOL": 45.67,
        "statusMessage": "✅ Graduated to Raydium with 45.67 SOL liquidity - Tradable"
      },
      {
        "mint": "9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump",
        "stage": "pump_fun_bonding",
        "isTradable": true,
        "statusMessage": "✅ Active on Pump.fun bonding curve - Tradable"
      }
    ],
    "notTradable": [
      {
        "mint": "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump",
        "stage": "graduated_zero_liquidity",
        "isTradable": false,
        "statusMessage": "⚠️ Graduated but pool has zero liquidity - Not Tradable"
      }
    ],
    "summary": {
      "total": 3,
      "tradableCount": 2,
      "pumpFunBonding": 1,
      "fullyGraduated": 1,
      "graduatedNoPool": 0,
      "graduatedZeroLiquidity": 1,
      "unknown": 0
    }
  }
}
```

## Frontend Integration

### Socket Listener Updates

The frontend receives enhanced token feeds with lifecycle data:

```typescript
// In useSocket.ts or token display component
socket.on("tokenFeed", (data) => {
  const { tokens, tradable, notTradable, lifecycleSummary } = data;

  // Display tradable tokens prominently
  renderTradableTokens(tradable);

  // Show non-tradable tokens with warnings
  renderNotTradableTokens(notTradable);

  // Display summary statistics
  console.log(`Lifecycle Summary:
    Total: ${lifecycleSummary.total}
    Tradable: ${lifecycleSummary.tradableCount}
    - On Pump.fun: ${lifecycleSummary.pumpFunBonding}
    - Graduated: ${lifecycleSummary.fullyGraduated}
    Not Tradable: ${lifecycleSummary.total - lifecycleSummary.tradableCount}
    - Zero Liquidity: ${lifecycleSummary.graduatedZeroLiquidity}
    - Unknown: ${lifecycleSummary.unknown}
  `);
});
```

### UI Display Recommendations

**Tradable Tokens:**

```tsx
<TokenCard className="border-green-500">
  <Badge variant="success">
    {token.lifecycleStage === "pump_fun_bonding" ? "🔥 Pump.fun" : "✅ Raydium"}
  </Badge>
  <TokenInfo>
    {token.symbol} - {token.name}
  </TokenInfo>
  {token.liquiditySOL && (
    <LiquidityInfo>{token.liquiditySOL.toFixed(2)} SOL liquidity</LiquidityInfo>
  )}
  <BuyButton>Buy Now</BuyButton>
</TokenCard>
```

**Not Tradable Tokens:**

```tsx
<TokenCard className="border-yellow-500 opacity-60">
  <Badge variant="warning">
    {token.lifecycleStage === "graduated_no_pool"
      ? "⏳ Pool Pending"
      : "⚠️ No Liquidity"}
  </Badge>
  <TokenInfo>
    {token.symbol} - {token.name}
  </TokenInfo>
  <StatusMessage>{token.statusMessage}</StatusMessage>
  <DisabledButton>Not Available</DisabledButton>
</TokenCard>
```

## Auto-Buy Integration

The auto-buyer now respects lifecycle validation:

```typescript
// In tokenDiscovery.service.ts
for (const tk of validatedCandidates) {
  if (!tk.isTradable) {
    log.info(
      `Skipping non-tradable token: ${tk.symbol} - Stage: ${tk.lifecycleStage}`
    );
    continue; // Skip registration for auto-buy
  }

  // Only register tradable tokens
  registerAutoBuyCandidate(io, tk);
}
```

**Benefits:**

- Prevents auto-buy attempts on tokens without liquidity
- Avoids wasted gas on failed transactions
- Improves success rate of auto-buy trades
- Reduces user frustration from non-executable trades

## Validation Performance

### Optimization Strategies

**1. Batch Processing**

- Validates multiple tokens in parallel using `Promise.all()`
- Typical batch size: 10-50 tokens
- Average validation time: 2-3 seconds per batch

**2. Caching**

- Pump.fun bonding curve checks cached for 30 seconds
- Raydium pool data cached for 10 seconds
- Reduces redundant RPC calls

**3. Early Exit**

- If bonding curve exists → immediately return PUMP_FUN_BONDING
- Avoids unnecessary Raydium checks for non-graduated tokens

### Performance Metrics

| Operation               | Time       | RPC Calls |
| ----------------------- | ---------- | --------- |
| Single token validation | ~200-500ms | 2-3       |
| Batch 10 tokens         | ~2-3s      | 20-30     |
| Batch 50 tokens         | ~8-12s     | 100-150   |

## Error Handling

### Common Errors and Solutions

#### RPC Rate Limiting

```typescript
// Error: 429 Too Many Requests
// Solution: Implement exponential backoff and retry
```

The system automatically retries with delays (1s, 2s, 4s) on rate limit errors.

#### Network Timeouts

```typescript
// Error: Request timeout
// Solution: Tokens marked as UNKNOWN, validation retried on next discovery cycle
```

#### Invalid Token Address

```typescript
// Error: Invalid public key
// Solution: Token filtered out in discovery phase, won't reach validation
```

## Testing

### Manual Testing

**Test Case 1: Pump.fun Token (Bonding)**

```bash
# Find a token still on bonding curve (< 85% progress)
curl http://localhost:4000/api/tokens/lifecycle/TOKEN_MINT

# Expected: stage = "pump_fun_bonding", isTradable = true
```

**Test Case 2: Graduated Token (Raydium)**

```bash
# Find a token that recently graduated (check DexScreener)
curl http://localhost:4000/api/tokens/lifecycle/TOKEN_MINT

# Expected: stage = "fully_tradable", hasLiquidity = true
```

**Test Case 3: Graduated, No Pool Yet**

```bash
# Find a token that just graduated (within 2 minutes)
curl http://localhost:4000/api/tokens/lifecycle/TOKEN_MINT

# Expected: stage = "graduated_no_pool"
# Check again after 5 minutes
# Expected: stage should change to "fully_tradable"
```

**Test Case 4: Batch Validation**

```bash
curl -X POST http://localhost:4000/api/tokens/lifecycle/validate \
  -H "Content-Type: application/json" \
  -d '{
    "tokenMints": [
      "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      "9PR7nCP9DpcUotnDPVLUBUZKu5WAYkwrCUx9wDnSpump"
    ]
  }'

# Expected: tradable and notTradable arrays with summary
```

### Automated Testing

```typescript
// tokenLifecycle.service.test.ts
describe("Token Lifecycle Validation", () => {
  it("should identify Pump.fun bonding tokens", async () => {
    const result = await validateTokenLifecycle("PUMP_FUN_TOKEN_MINT");
    expect(result.stage).toBe(TokenLifecycleStage.PUMP_FUN_BONDING);
    expect(result.isTradable).toBe(true);
  });

  it("should identify fully graduated tokens", async () => {
    const result = await validateTokenLifecycle("GRADUATED_TOKEN_MINT");
    expect(result.stage).toBe(TokenLifecycleStage.FULLY_TRADABLE);
    expect(result.hasLiquidity).toBe(true);
  });

  it("should batch validate multiple tokens", async () => {
    const mints = ["TOKEN1", "TOKEN2", "TOKEN3"];
    const results = await validateTokenBatch(mints);
    expect(results.tradable.length + results.notTradable.length).toBe(3);
  });
});
```

## Monitoring & Logging

### Log Messages

**Successful Validation:**

```
[tokenLifecycle] Validating lifecycle for token 7xKXtg2C...
[tokenLifecycle] Token 7xKXtg2C... is fully graduated with 45.67 SOL liquidity (tradable)
```

**Bonding Curve Detection:**

```
[tokenLifecycle] Token 9PR7nCP9... is on Pump.fun bonding curve (tradable)
```

**No Pool Yet:**

```
[tokenLifecycle] Token Df6yfrKC... has no Raydium pool (not tradable)
```

**Batch Validation:**

```
[tokenLifecycle] Batch validating 25 tokens...
[tokenLifecycle] ✅ Lifecycle validation complete: 18 tradable, 7 not tradable
[tokenLifecycle]    - 12 on Pump.fun bonding curve
[tokenLifecycle]    - 6 fully graduated with liquidity
[tokenLifecycle]    - 5 graduated but zero liquidity
[tokenLifecycle]    - 2 unknown/unverified
```

### Discovery Integration Logs:\*\*

```
[tokenDiscovery] Processing 50 tokens from DexScreener
[tokenDiscovery] Running lifecycle validation on 50 tokens...
[tokenDiscovery] ✅ Lifecycle validation complete: 35 tradable, 15 not tradable
[tokenDiscovery] ✅ Tradable candidate meets MC range: BONK (9PR7nCP9...) MC=1.23 SOL Stage: pump_fun_bonding
[tokenDiscovery] Skipping non-tradable token: SCAM (Df6yfrKC...) - Stage: graduated_zero_liquidity
```

## Troubleshooting

### Problem: All tokens showing as UNKNOWN

**Possible Causes:**

1. RPC endpoint not responding
2. Pump.fun program not found (wrong network)
3. Raydium service configuration error

**Debug Steps:**

```bash
# Check RPC connection
curl http://localhost:4000/api/config

# Verify Pump.fun detection
curl http://localhost:4000/api/tokens/lifecycle/KNOWN_PUMPFUN_TOKEN

# Check backend logs for detailed errors
```

### Problem: Graduated tokens showing zero liquidity

**Possible Causes:**

1. Pool just created (< 30 seconds old)
2. Liquidity removed (rug pull)
3. Pool data parsing error

**Debug Steps:**

1. Wait 30 seconds and retry validation
2. Check DexScreener manually: `https://dexscreener.com/solana/TOKEN_MINT`
3. Verify pool address on Solscan
4. Check backend logs for parsing errors

### Problem: Lifecycle validation taking too long

**Possible Causes:**

1. Large batch size (> 50 tokens)
2. RPC rate limiting
3. Network latency

**Solutions:**

1. Reduce batch size in token discovery
2. Implement caching (already done)
3. Use higher-tier RPC endpoint
4. Add request timeout limits

## Future Enhancements

### Planned Features

1. **Historical Lifecycle Tracking**

   - Store lifecycle transitions in database
   - Show graduation timeline in UI
   - Analytics: average time to graduate, success rates

2. **Predictive Graduation**

   - Monitor bonding curve progress (%)
   - Alert when token near graduation (> 90%)
   - Auto-prepare Raydium monitoring

3. **Multi-DEX Support**

   - Orca pool detection
   - Meteora pool detection
   - Jupiter aggregator integration

4. **Enhanced Liquidity Metrics**

   - Volume/liquidity ratio
   - Liquidity depth analysis
   - Impermanent loss calculation

5. **Automated Revalidation**
   - Periodic revalidation of UNKNOWN tokens
   - Auto-update when pools become available
   - Websocket updates for real-time changes

## Related Documentation

- [POOL_MONITORING.md](./POOL_MONITORING.md) - Pool availability monitoring system
- [SOCKET_EVENTS.md](./SOCKET_EVENTS.md) - Socket.io event reference
- [MARKET_CAP_FILTERING.md](./MARKET_CAP_FILTERING.md) - Token filtering logic

## Support

For issues or questions about lifecycle validation:

1. Check backend logs: `backend/logs/tokenLifecycle.log`
2. Test validation endpoint: `/api/tokens/lifecycle/:tokenMint`
3. Review this documentation for troubleshooting steps
4. Verify RPC endpoint is operational
