# Market Cap Filtering Enhancement

## Overview

Enhanced market cap filtering system with dynamic configuration, min/max ranges, and granular scoring tiers.

---

## Key Improvements

### 1. **Min/Max Range Filtering**

Previously: Only minimum market cap check (2 SOL)  
Now: Both minimum AND maximum filtering with dual SOL/USD support

**Default Ranges:**

- **SOL Range:** 5 - 1,000,000 SOL
- **USD Range:** $1,000 - $200,000,000

**Benefits:**

- Filters out micro-cap scams (< 5 SOL / $1K)
- Filters out mega-cap tokens (> 1M SOL / $200M) that rarely pump
- Focuses on sweet spot for meme coin trading

---

### 2. **Enhanced Scoring System**

Previously: 4 broad tiers ($10M+, $5M+, $1M+, $100K+)  
Now: 9 granular tiers with better distribution

**New Market Cap Scoring (0-20 points):**

| Market Cap (USD) | Points | Description       |
| ---------------- | ------ | ----------------- |
| $50M+            | 20     | Large cap         |
| $10M - $50M      | 18     | Upper mid-cap     |
| $5M - $10M       | 16     | Mid-cap           |
| $1M - $5M        | 13     | Lower mid-cap     |
| $500K - $1M      | 10     | Small cap         |
| $100K - $500K    | 7      | Micro cap         |
| $50K - $100K     | 5      | Very small        |
| $10K - $50K      | 3      | Extremely small   |
| $1K - $10K       | 1      | Minimum threshold |

**Benefits:**

- Better differentiation between token qualities
- More accurate total scores (still 0-100 overall)
- Helps identify best opportunities within range

---

### 3. **Dynamic Configuration (No Restart Required!)**

All market cap settings can now be updated via API without restarting the server.

**Configurable Parameters:**

```typescript
{
  minMarketCapSol: number,      // Min MC in SOL (default: 5)
  maxMarketCapSol: number,      // Max MC in SOL (default: 1000000)
  minMarketCapUsd: number,      // Min MC in USD (default: 1000)
  maxMarketCapUsd: number,      // Max MC in USD (default: 200000000)
  minSecondsSinceLaunch: number, // Earliest launch age (default: 10)
  maxSecondsSinceLaunch: number, // Latest launch age (default: 60)
  minTokenScore: number,        // Min score 0-100 (default: 30)
  takeProfitPct: number,        // TP % (default: 0.1)
  stopLossPct: number           // SL % (default: 0.02)
}
```

---

## API Usage

### Get Current Config

```bash
GET /api/config
```

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

---

### Update Config Dynamically

```bash
PATCH /api/config
Content-Type: application/json

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
    /* updated config with new values */
  },
  "message": "Configuration updated successfully"
}
```

**Side Effect:** Emits `config:update` socket event to all connected clients

---

### Reset to Defaults

```bash
POST /api/config/reset
```

Resets all configuration values to environment defaults (.env file).

---

## Frontend Integration

### Listen for Config Updates

```typescript
import { useEffect, useState } from "react";
import { socket } from "@/lib/socket";

export function useConfig() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);

  useEffect(() => {
    // Fetch initial config
    fetch("/api/config")
      .then((res) => res.json())
      .then((data) => setConfig(data.config));

    // Listen for real-time updates
    socket.on("config:update", (newConfig) => {
      setConfig(newConfig);
      console.log("⚙️ Config updated:", newConfig);
    });

    return () => {
      socket.off("config:update");
    };
  }, []);

  return config;
}
```

### Update Config from UI

```typescript
async function updateMarketCapRange(min: number, max: number) {
  const response = await fetch("/api/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      minMarketCapSol: min,
      maxMarketCapSol: max,
    }),
  });

  const data = await response.json();
  console.log("Updated config:", data.config);
}

// Example: Only show tokens between 10 and 100,000 SOL
updateMarketCapRange(10, 100000);
```

---

## Example Use Cases

### 1. **Conservative Trading (Larger Caps)**

```json
{
  "minMarketCapSol": 50,
  "maxMarketCapSol": 100000,
  "minTokenScore": 50
}
```

Focus on established tokens with proven liquidity.

---

### 2. **Aggressive Trading (Smaller Caps)**

```json
{
  "minMarketCapSol": 1,
  "maxMarketCapSol": 10000,
  "minTokenScore": 20
}
```

Hunt for early-stage moonshots (higher risk).

---

### 3. **Balanced Approach (Mid-Caps)**

```json
{
  "minMarketCapSol": 10,
  "maxMarketCapSol": 50000,
  "minTokenScore": 35
}
```

Sweet spot for most traders (default-ish).

---

## Technical Details

### Filtering Logic

Tokens must meet BOTH conditions to pass:

1. **Meets Minimum:** `mcSol >= minMarketCapSol OR mcUsd >= minMarketCapUsd`
2. **Meets Maximum:** `mcSol <= maxMarketCapSol OR mcUsd <= maxMarketCapUsd`

**Why OR logic?**

- Handles edge cases where one metric might be missing
- Provides redundancy (SOL price can fluctuate)
- More flexible filtering

---

### USD Conversion

For rough USD estimation when exact USD value unavailable:

```typescript
const mcUsd = marketCapSol * 200; // Approximate SOL price
```

**Note:** This is a fallback. DexScreener usually provides accurate USD values.

---

### Runtime Configuration

Configuration is stored in memory and can be updated without restart:

```typescript
// backend/src/routes/config.route.ts
export function getRuntimeConfig() {
  return runtimeConfig; // Returns current in-memory config
}
```

All services use `getRuntimeConfig()` to get latest values dynamically.

---

## Logging

Enhanced logging shows market cap ranges:

```
[TokenDiscovery] Starting token watcher MC_RANGE=5-1000000 SOL ($1000-$200000000) MAX_AGE=24h MIN_SCORE=30

[TokenDiscovery] Candidate meets MC range mint=ABC123... symbol=MOON MC=25.50 SOL ($5100)
```

---

## Environment Variables

Default values in `.env`:

```env
# Market Cap Filters
MIN_MARKETCAP_SOL=5

# Launch Window
MIN_SECONDS_SINCE_LAUNCH=10
MIN_TOKEN_SCORE=30

# Trading Parameters
TP_PCT=0.1
SL_PCT=0.02
```

These are **initial values only**. Runtime updates via API override them until reset.

---

## Benefits Summary

✅ **Better Token Quality** - Min/max ranges filter out extremes  
✅ **More Granular Scoring** - 9 tiers vs 4 for accurate ranking  
✅ **Dynamic Updates** - Change settings without restart  
✅ **Real-time Sync** - Frontend gets config updates via socket  
✅ **Flexible Trading** - Easily adjust for different strategies  
✅ **Better Logging** - See MC ranges in discovery logs  
✅ **API-Driven** - Programmatic configuration management

---

## Next Steps

1. **Test the filtering** - Start backend and verify MC ranges work
2. **Build UI controls** - Add market cap slider to frontend
3. **Monitor performance** - Check if token quality improves
4. **Adjust ranges** - Fine-tune based on real trading data
5. **Add presets** - Conservative/Balanced/Aggressive quick buttons

---

## Related Files

- `backend/src/routes/config.route.ts` - Configuration API
- `backend/src/services/tokenDiscovery.service.ts` - Uses runtime config
- `backend/src/index.ts` - Registers /api/config route
- `backend/.env` - Default configuration values
- `SOCKET_EVENTS.md` - Socket event documentation

---

**Ready to trade smarter! 🚀**
