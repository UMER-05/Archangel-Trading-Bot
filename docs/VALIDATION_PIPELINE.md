# 8-Stage Validation Pipeline Implementation

## Overview

This document describes the complete 8-stage validation pipeline for auto-buy functionality in the Archangel sniper bot. The pipeline integrates **RAYDIUM → BIRDEYE → FLUX** for comprehensive token safety and execution.

---

## Architecture

### Pipeline Flow

```
RAYDIUM Discovery → RAYDIUM Routing → BIRDEYE Honeypot → BIRDEYE Market Health
    ↓
FLUX Pre-Execution → FLUX Buy → P&L Tracking → FLUX Sell
```

### New Services Created

1. **`birdeye.service.ts`** - Birdeye API integration

   - Honeypot detection (Stage 3)
   - Market health checks (Stage 4)
   - Live P&L tracking (Stage 7)
   - Pre-sell validation (Stage 8)

2. **`flux.service.ts`** - Flux Beam execution

   - Pre-execution checks (Stage 5)
   - Buy execution (Stage 6)
   - Sell execution (Stage 8)
   - Balance validation

3. **`validationPipeline.service.ts`** - Pipeline orchestration

   - Runs all 8 stages sequentially
   - Logs failures at each stage
   - Returns comprehensive results

4. **`pnlTracker.service.ts`** - Live P&L tracking
   - Polls Birdeye every 2 seconds
   - Broadcasts updates via WebSocket
   - Tracks multiple positions

---

## Stage Details

### 🔍 Stage 1: RAYDIUM DISCOVERY

**Goal:** Only detect tokens that truly exist AND have actual LP

**Checks:**

- ✅ Pool exists on-chain
- ✅ LP > MIN_RAYDIUM_LP_SOL (default: 0.5 SOL)
- ✅ LP not exactly 0 (fake pool detection)

**Fail Conditions:**

- Pool LP = 0 → skip
- Pool LP < 0.5 SOL → skip

**Environment Variables:**

```bash
MIN_RAYDIUM_LP_SOL=0.5
```

---

### 🔍 Stage 2: RAYDIUM ROUTING TEST

**Goal:** Make sure Raydium can actually perform swaps

**Checks:**

- ✅ Valid BUY route exists
- ✅ Valid SELL route exists (bidirectional)
- ✅ Slippage < 49%
- ✅ No swap instruction errors

**Fail Conditions:**

- No buy route → skip
- No sell route → honeypot detected
- Slippage > 49% → too risky

---

### 🔍 Stage 3: BIRDEYE HONEYPOT CHECK

**Goal:** Full safety analysis using Birdeye API

**Checks:**

- ✅ Sell simulation passes
- ✅ Sell tax < Buy tax \* 3
- ✅ Owner holds < 20% supply
- ✅ Mint authority revoked
- ✅ Freeze authority disabled
- ✅ LP locked or burnt
- ✅ No blacklist logic
- ✅ No transfer restrictions
- ✅ Birdeye risk score > 60

**API Endpoint (placeholder):**

```
GET https://public-api.birdeye.so/defi/token_security?address={tokenMint}
```

**Environment Variables:**

```bash
BIRDEYE_API_KEY=your_api_key_here
BIRDEYE_BASE_URL=https://public-api.birdeye.so
```

---

### 🔍 Stage 4: BIRDEYE MARKET HEALTH CHECK

**Goal:** Ensure token is tradeable and worth entering

**Checks:**

- ✅ Price impact < 30% for buy size
- ✅ FDV not insanely inflated (< 3M with LP > 2 SOL)
- ✅ Volume > 1 SOL in last 5 minutes
- ✅ No soft-rug indicators
- ✅ No suspicious massive sells
- ✅ No bot-only wash trading

**API Endpoint (placeholder):**

```
GET https://public-api.birdeye.so/defi/token_overview?address={tokenMint}
```

**Environment Variables:**

```bash
PIPELINE_MAX_PRICE_IMPACT_PCT=30
PIPELINE_MIN_VOLUME_5M_SOL=1
PIPELINE_MAX_FDV_TO_LP_RATIO=1500000
```

---

### 🔍 Stage 5: FLUX PRE-EXECUTION CHECK

**Goal:** Make sure Flux can execute the trade without failure

**Checks:**

- ✅ Flux route available
- ✅ Priority fees calculated
- ✅ Sufficient wallet balance
- ✅ Gas budget OK
- ✅ Slippage acceptable
- ✅ Simulation passes

**API Endpoint (placeholder):**

```
POST https://api.fluxbeam.xyz/v1/swap/quote
```

**Environment Variables:**

```bash
FLUX_API_KEY=your_flux_api_key_here
FLUX_BASE_URL=https://api.fluxbeam.xyz
```

---

### 🚀 Stage 6: FLUX EXECUTION (BUY)

**Goal:** Execute the buy instantly with no reverts

**Process:**

1. Construct buy transaction
2. Send through FLUX
3. Monitor confirmation
4. Record entry price
5. Validate token balance increase

**API Endpoint (placeholder):**

```
POST https://api.fluxbeam.xyz/v1/swap/execute
```

**Environment Variables:**

```bash
AUTO_BUY_AMOUNT=0.05
AUTO_BUY_SLIPPAGE_PCT=10
WALLET_PUBLIC_KEY=your_wallet_address
```

---

### 📊 Stage 7: LIVE P&L TRACKING

**Goal:** Auto-sync unrealized PnL via Birdeye

**Process:**

- Poll Birdeye every 2 seconds
- Track: price, price impact, unrealized PnL, % change, liquidity, trend
- Broadcast updates via WebSocket

**WebSocket Event:**

```javascript
io.emit("pnl:update", {
  tokenMint: string,
  entryPrice: number,
  currentPrice: number,
  unrealizedPnL: number,
  percentChange: number,
  trendDirection: "up" | "down" | "stable",
});
```

---

### 🚀 Stage 8: FLUX EXECUTION (SELL)

**Goal:** Validate sell BEFORE sending it

**Pre-sell Checks:**

- ✅ Birdeye sell simulation passes
- ✅ Raydium route valid
- ✅ Price impact < 40%
- ✅ LP hasn't rugged
- ✅ No token transfer restrictions

**Environment Variables:**

```bash
PIPELINE_MAX_SELL_SLIPPAGE_PCT=40
```

---

## Configuration

### Required Environment Variables

```bash
# ========================
# PIPELINE CONFIGURATION
# ========================

# Birdeye API
BIRDEYE_API_KEY=your_birdeye_api_key_here
BIRDEYE_BASE_URL=https://public-api.birdeye.so

# Flux Beam API
FLUX_API_KEY=your_flux_api_key_here
FLUX_BASE_URL=https://api.fluxbeam.xyz

# Pipeline Thresholds
PIPELINE_MAX_PRICE_IMPACT_PCT=30
PIPELINE_MIN_VOLUME_5M_SOL=1
PIPELINE_MAX_FDV_TO_LP_RATIO=1500000
PIPELINE_MAX_SELL_SLIPPAGE_PCT=40

# Auto-buy Configuration
AUTO_BUY_AMOUNT=0.05
AUTO_BUY_SLIPPAGE_PCT=10
WALLET_PUBLIC_KEY=your_wallet_address

# Raydium Settings
MIN_RAYDIUM_LP_SOL=0.5
RAYDIUM_AUTO_BUY=true
```

---

## WebSocket Events

### Frontend Integration

The pipeline emits several real-time events:

#### 1. Pipeline Failed

```javascript
socket.on("raydium:pipeline_failed", (data) => {
  console.log("Stage:", data.failedStage);
  console.log("Reason:", data.reason);
  console.log("Results:", data.results);
});
```

#### 2. Pipeline Success

```javascript
socket.on("raydium:pipeline_success", (data) => {
  console.log("Buy executed:", data.signature);
  console.log("Tokens received:", data.tokensReceived);
  console.log("Price:", data.actualPrice);
});
```

#### 3. P&L Updates

```javascript
socket.on("pnl:update", (data) => {
  console.log("Current price:", data.currentPrice);
  console.log("P&L:", data.unrealizedPnL);
  console.log("% Change:", data.percentChange);
});
```

---

## Database Schema

### Failed Token Logging

Tokens that fail at any stage are logged for analysis:

```typescript
interface FailedToken {
  tokenMint: string;
  stage: number;
  stageName: string;
  reason: string;
  timestamp: Date;
}
```

---

## Testing the Pipeline

### 1. Check Configuration

```bash
# Verify environment variables are set
echo $BIRDEYE_API_KEY
echo $FLUX_API_KEY
```

### 2. Monitor Logs

```bash
# Watch for pipeline events
tail -f logs/backend.log | grep "validation-pipeline"
```

### 3. Test with Known Token

```bash
# Manually trigger validation (for testing)
curl -X POST http://localhost:4000/api/test/pipeline \
  -H "Content-Type: application/json" \
  -d '{"tokenMint": "your_test_token"}'
```

---

## TODO: API Integration

### Birdeye API Endpoints

Replace placeholder endpoints in `birdeye.service.ts`:

1. **Honeypot Check:** `/defi/token_security`
2. **Market Health:** `/defi/token_overview`
3. **P&L Data:** `/defi/price`
4. **Sell Simulation:** `/defi/simulate_sell`

### Flux API Endpoints

Replace placeholder endpoints in `flux.service.ts`:

1. **Quote:** `/v1/swap/quote`
2. **Execute:** `/v1/swap/execute`

---

## Performance Metrics

### Expected Timings (per stage)

| Stage | Name                  | Expected Time |
| ----- | --------------------- | ------------- |
| 1     | Raydium Discovery     | < 100ms       |
| 2     | Routing Test          | 500ms - 1s    |
| 3     | Honeypot Check        | 1-2s          |
| 4     | Market Health         | 1-2s          |
| 5     | Pre-Execution         | 500ms - 1s    |
| 6     | Buy Execution         | 2-5s          |
| 7     | P&L Tracking          | Continuous    |
| 8     | Sell (when triggered) | 2-5s          |

**Total pipeline time:** ~5-12 seconds from detection to execution

---

## Troubleshooting

### Common Issues

1. **Pipeline fails at Stage 3/4**

   - Check BIRDEYE_API_KEY is valid
   - Verify API rate limits
   - Check token actually exists on Birdeye

2. **Pipeline fails at Stage 5**

   - Check FLUX_API_KEY is valid
   - Verify wallet has sufficient SOL
   - Check Flux service is available

3. **No P&L updates**
   - Verify P&L tracker is initialized
   - Check Socket.IO connection
   - Ensure position was added to tracker

---

## Manual Buy vs Auto-Buy

| Feature     | Manual Buy          | Auto-Buy (Pipeline) |
| ----------- | ------------------- | ------------------- |
| Validations | ❌ None             | ✅ 8-stage pipeline |
| Execution   | Raydium             | Flux                |
| Speed       | Fast                | Thorough (~5-12s)   |
| Safety      | User responsibility | Maximum safety      |
| Use Case    | Experienced traders | Automated sniping   |

---

## Success Metrics

A successful pipeline execution includes:

✅ All 8 stages passed
✅ Buy executed on Flux
✅ Token balance validated
✅ P&L tracking started
✅ No errors or reverts

---

## Next Steps

1. **Get API Keys:**

   - Birdeye API key from https://birdeye.so
   - Flux API key from https://fluxbeam.xyz

2. **Update Environment:**

   - Add API keys to `.env`
   - Configure thresholds

3. **Test Pipeline:**

   - Start with low amounts
   - Monitor logs for each stage
   - Verify WebSocket events

4. **Monitor Performance:**
   - Track success rate per stage
   - Analyze failed tokens
   - Optimize thresholds

---

## Support

For issues or questions:

- Check logs: `logs/backend.log`
- Monitor WebSocket events in browser console
- Review failed tokens in database
