# ArchAngel Documentation

Everything that still describes the current codebase lives here. Documents for
removed systems (Pump.fun auto-trade, Raydium pool listener, tranche buyer,
stored-token checker, manual-buy panel) were deleted in October 2026.

## Trading engine

- [Native Swap Engine — Fund-Safety Spec](native-swap-fund-safety-spec.md) — WSOL, ATA and minimum-out rules the executors in `backend/src/services/execution/` are checked against
- [Native Swap Engine — Compute-Unit Budgeting Spec](compute-unit-budget-spec.md)
- [Native Swap Engine — MEV / Jito Routing](mev-jito-routing-spec.md)
- [Validation Pipeline](VALIDATION_PIPELINE.md) — partially historical, see status note at top
- [Token Lifecycle Validation](TOKEN_LIFECYCLE_VALIDATION.md) — partially historical, see status note at top
- [Pool Monitoring](POOL_MONITORING.md)
- [Wallet Balance Sync & Risk Management](WALLET_BALANCE_RISK_MANAGEMENT.md)

## Integration

- [Socket.IO Events](SOCKET_EVENTS.md) — backend → frontend event reference
- [Testing Dynamic Configuration](TESTING_CONFIG.md)
- [Devnet Smoke Test Guide](devnet-smoke-test-guide.md) — companion to `backend/scripts/devnet-smoke-test.ts` and `mainnet-dry-run.ts`

## Deployment

- [Azure Deployment Guide](deployment/AZURE_DEPLOYMENT.md)
- [Azure Quick Reference](deployment/AZURE_QUICKSTART.md)
- [InterServer Deployment](deployment/DEPLOYMENT_INTERSERVER.md)

## Desktop (Electron) — not used by the web deployment

- [Desktop App Build Guide](desktop/DESKTOP_APP_BUILD.md)
- [Desktop Quick Start](desktop/QUICKSTART_BUILD.md)
