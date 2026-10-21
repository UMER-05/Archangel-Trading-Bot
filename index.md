# ArchAngel Backend — All Files Touched This Session

## NEW FILES (the consolidated candidate pipeline)
| File | Purpose |
|---|---|
| `routes/quicknode.route.ts` | Phase 1 — receives QuickNode webhook deliveries |
| `services/tokenExtraction.service.ts` | Phase 2 — extracts candidate mint(s) from a webhook event |
| `services/jupiterTradeability.service.ts` | Phase 3 — Jupiter-only tradeability check (quote-based, no catalog fetch) |
| `services/tokenFiltering.service.ts` | Phase 4 — 7 ArchAngel filters (authority, tax, honeypot, holder concentration); no Birdeye |
| `services/candidatePipeline.service.ts` | The single orchestrator tying Phases 1–7 together |





## MODIFIED FILES
| File | What changed |
|---|---|
| `app.ts` | Mounted the new QuickNode webhook route |
| `index.ts` | Removed the 3 old polling loops; wired up the webhook-driven pipeline instead |
| `routes/trade.route.ts` | Market-cap trigger + swap decimals: Jupiter catalog → on-chain + quote-implied price |
| `routes/positions.route.ts` | Live position price: Birdeye → quote-implied price |
| `routes/admin.route.ts` | Stale comment cleanup only |
| `routes/userWallet.route.ts` | Stale comment cleanup only |
| `services/validationPipeline.service.ts` | Stripped duplicate stages 1–4; added the 5-check Jupiter execution gate (buy route / liquidity / price impact / expected output / quote freshness), run twice — pre-check and again on a fresh quote right before the swap |
| `services/multiUserExecution.service.ts` | Comment cleanup reflecting the consolidated pipeline |
| `services/jupiter.service.ts` | Removed ALL catalog/metadata fetch (`getTokenInfo`, `getTokenInfoBatch`, `getRecentTokens`) — now purely quotes + execution. Added `getQuoteImpliedPriceSol()`, the shared fair-value-price helper used everywhere Birdeye used to be |
| `services/monitor.service.ts` | Live position pricing: Jupiter catalog → Birdeye → now quote-implied price. Also fixed a bug where fully-closed positions were still fetched every tick |
| `services/db.service.ts` | Extended `TokenState.source` to include `"quicknode"`; added `setLaunchMarketCapIfUnset()` (works around a `$setOnInsert` timing gap) |
| `services/tokenLifecycle.service.ts` | Rewritten: no more Jupiter catalog lookup, no more `poolAddress` field |
| `services/emergencyExit.service.ts` | Liquidity check: Jupiter catalog → quote-implied liquidity estimate |
| `services/tradeValidation.service.ts` | Authority checks → on-chain; removed dead `checkNoEarlyDump` (Birdeye price history, never had a working substitute) |
| `services/portfolioValuation.service.ts` | Batch pricing: Birdeye → quote-implied price, deduped per mint |
| `services/pnlTracker.service.ts` | Rewritten off Birdeye's `getPnLData` — now quote-implied price only (dropped `priceImpact`/`liquidityMovement`/`trendDirection`, no non-Birdeye equivalent) |
| `services/tokenSafetyChecks.service.ts` | Added `getOnChainMintSupply()` (decimals + circulating supply straight from the mint account) |
| `services/tokenChart.service.ts` | No working price-history source anymore (Birdeye removed) — degrades to empty rather than crashing |
| `services/price.service.ts` | Simplified; dead Birdeye-only functions removed; live watchlist-alert pricing converted to quote-implied price |
| `services/tokenPrice.service.ts` | Removed an entire Birdeye-polling loop that turned out to have zero callers already (pre-existing dead code) |
| `strategies/utils.ts` | Same graceful-degradation treatment as tokenChart.service.ts |
| `utils/walletMutex.ts` | Comment cleanup reflecting the consolidated pipeline |
| `__tests__/routes.test.ts` | Updated mocks to match the new pricing source |
| `__tests__/postEntryMonitoring.test.ts` | Removed a stale mock key |

## DELETED FILES (not included below — nothing to view)
- `services/jupiterDiscovery.service.ts`
- `services/tokenDiscovery.service.ts`
- `services/autoBuyer.service.ts`
- `services/trancheBuyer.service.ts`
- `services/storedTokenChecker.service.ts`
- `services/jupiterTokenValidator.service.ts`
- `services/birdeye.service.ts`

## Known open items
- Chart/price-history features (`tokenChart.service.ts`, `strategies/utils.ts`) have no working data source until a new provider (DexScreener, GeckoTerminal, etc.) is wired in — Jupiter has no historical price API.
- No DEX allowlist/denylist exists — PumpSwap/Fluxbeam candidates flow through the same pipeline as Raydium/Orca. Flag if you want certain DEXs excluded.
- Frontend: `pnl:update` socket payload lost `priceImpact`/`liquidityMovement`/`trendDirection` fields — worth checking nothing renders those.