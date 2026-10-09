# ArchAngel Bot - Azure Deployment Quick Reference

## ✅ Azure-Ready Checklist

### Backend Configuration

- [x] Health check endpoint (`/health`)
- [x] Readiness check endpoint (`/ready`)
- [x] Azure port detection (`PORT` or `WEBSITES_PORT`)
- [x] web.config for IIS/iisnode
- [x] PM2 ecosystem configuration
- [x] GitHub Actions workflow (`.github/workflows/azure-backend.yml`)
- [x] Build script with postinstall hook
- [x] WebSocket support enabled
- [x] CORS configured for Azure domains

### Frontend Configuration

- [x] Static export mode (Next.js)
- [x] Azure Static Web Apps config (`staticwebapp.config.json`)
- [x] GitHub Actions workflow (`.github/workflows/azure-frontend.yml`)
- [x] Environment variables for Azure URLs
- [x] Routing fallback for SPA
- [x] Security headers

### Infrastructure

- [x] Bicep template (`azure-resources.bicep`)
- [x] Resource definitions:
  - App Service Plan (B1 tier)
  - Backend App Service (Node 18)
  - Frontend Static Web App
  - Application Insights

## 🚀 Deployment Commands

### Option 1: Automated (Recommended)

```bash
# 1. Push to GitHub (triggers workflows)
git add .
git commit -m "Deploy to Azure"
git push origin main

# Workflows automatically:
# - Build & test
# - Deploy backend to App Service
# - Deploy frontend to Static Web Apps
```

### Option 2: Manual Azure CLI

```bash
# Login
az login

# Create resources
az group create --name archangel-rg --location eastus
az deployment group create \
  --resource-group archangel-rg \
  --template-file azure-resources.bicep

# Deploy backend
cd backend && npm run build
az webapp deployment source config-zip \
  --resource-group archangel-rg \
  --name archangel-backend \
  --src dist.zip

# Deploy frontend
cd frontend && npm run build
az staticwebapp create --name archangel-frontend \
  --resource-group archangel-rg \
  --source . \
  --branch main
```

## 🔑 Required GitHub Secrets

Add in: Repository → Settings → Secrets and variables → Actions

### Backend Secrets

| Secret Name                     | Description            | How to Get                                                                |
| ------------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `AZURE_BACKEND_PUBLISH_PROFILE` | Deployment credentials | Azure Portal → App Service → Deployment Center → Download publish profile |

### Frontend Secrets

| Secret Name                       | Description      | How to Get                                              |
| --------------------------------- | ---------------- | ------------------------------------------------------- |
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | Deployment token | Azure Portal → Static Web App → Manage deployment token |
| `AZURE_API_BASE_URL`              | Backend API URL  | `https://archangel-backend.azurewebsites.net/api`       |
| `AZURE_SOCKET_URL`                | WebSocket URL    | `https://archangel-backend.azurewebsites.net`           |

## 🔧 Environment Variables (App Service)

Set in: Azure Portal → App Service → Configuration → Application settings

### Required

```bash
NODE_ENV=production
MONGO_URI=<mongodb-connection-string>
MONGO_DB_NAME=archangel
HELIUS_RPC_URL=wss://mainnet.helius-rpc.com/?api-key=<key>
WALLET_PRIVATE_KEY=<base58-encoded-private-key>
WALLET_PUBLIC_KEY=<wallet-address>
```

### Trading Configuration

```bash
RAYDIUM_POOL_LISTENER=true
RAYDIUM_AUTO_BUY=true
RAYDIUM_AUTO_BUY_SOL=0.05
MIN_RAYDIUM_LP_SOL=0.05
MAX_BUY_TAX_PCT=5
MAX_SELL_TAX_PCT=5
REQUIRE_MINT_DISABLED=true
REQUIRE_FREEZE_DISABLED=true
```

### Token Checker

```bash
STORED_TOKEN_CHECKER_ENABLED=true
STORED_TOKEN_CHECK_INTERVAL_MS=300000
MAX_TOKENS_PER_CHECK=20
MIN_TIME_BETWEEN_TOKEN_CHECKS=900000
```

### Notifications

```bash
TELEGRAM_BOT_TOKEN=<bot-token>
TELEGRAM_CHAT_ID=<chat-id>
```

## 📊 Monitoring URLs

- **Backend Health**: `https://archangel-backend.azurewebsites.net/health`
- **Backend Readiness**: `https://archangel-backend.azurewebsites.net/ready`
- **Frontend**: `https://archangel-frontend.azurestaticapps.net`
- **Logs**: Azure Portal → App Service → Log stream

## 💰 Cost Estimate

| Service              | Tier       | Monthly Cost      |
| -------------------- | ---------- | ----------------- |
| App Service Plan     | B1 (Basic) | ~$13              |
| Static Web App       | Free       | $0                |
| Application Insights | Basic      | ~$2-5             |
| **Total**            |            | **~$15-20/month** |

### Cost Optimization

```bash
# Scale down when not trading
az appservice plan update \
  --name archangel-plan \
  --resource-group archangel-rg \
  --sku B1 \
  --number-of-workers 1

# Or use Free tier (60 min/day limit)
az appservice plan update \
  --name archangel-plan \
  --resource-group archangel-rg \
  --sku F1
```

## 🐛 Troubleshooting

### View Logs

```bash
# Real-time logs
az webapp log tail --resource-group archangel-rg --name archangel-backend

# Download logs
az webapp log download --resource-group archangel-rg --name archangel-backend
```

### Restart App

```bash
az webapp restart --resource-group archangel-rg --name archangel-backend
```

### Test Endpoints

```bash
curl https://archangel-backend.azurewebsites.net/health
curl https://archangel-backend.azurewebsites.net/api/stats
```

### Common Issues

**Issue**: WebSocket not connecting
**Fix**: Enable WebSocket in App Service Configuration → General Settings

**Issue**: App slow to start
**Fix**: Enable "Always On" in App Service Configuration → General Settings

**Issue**: Environment variables not working
**Fix**: Restart app after setting environment variables

**Issue**: Build fails
**Fix**: Check Node.js version matches (18.x) in App Service Configuration

## 🔒 Security Checklist

- [ ] HTTPS only (enabled by default)
- [ ] Environment variables in App Service (not in code)
- [ ] CORS configured properly
- [ ] Application Insights enabled
- [ ] Regular security updates
- [ ] Private key stored securely
- [ ] MongoDB connection string encrypted

## 📚 Documentation

- [Full Deployment Guide](./AZURE_DEPLOYMENT.md)
- [Token Storage System](./STORED_TOKEN_CHECKER.md)
- [Raydium Trading System](./RAYDIUM_TRADING_SYSTEM.md)
- [Validation Pipeline](./VALIDATION_PIPELINE.md)

## 🆘 Support

- Azure Docs: https://docs.microsoft.com/azure
- GitHub Issues: https://github.com/Victor-droid-ux/ArchAngel/issues
- Azure Support: https://portal.azure.com/#blade/Microsoft_Azure_Support
