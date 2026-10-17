# Azure Deployment Guide for ArchAngel Bot

## Prerequisites

1. **Azure Account**: [Create free account](https://azure.microsoft.com/free/)
2. **Azure CLI**: [Install Azure CLI](https://docs.microsoft.com/cli/azure/install-azure-cli)
3. **GitHub Account**: For CI/CD workflows

## Quick Deployment Steps

### 1. Create Azure Resources

```bash
# Login to Azure
az login

# Create resource group
az group create --name archangel-rg --location eastus

# Deploy infrastructure (creates App Service + Static Web App)
az deployment group create \
  --resource-group archangel-rg \
  --template-file azure-resources.bicep \
  --parameters namePrefix=archangel appServicePlanSku=B1
```

### 2. Configure Backend App Service

```bash
# Set environment variables in Azure App Service
az webapp config appsettings set \
  --resource-group archangel-rg \
  --name archangel-backend \
  --settings \
    NODE_ENV=production \
    MONGO_URI="<your-mongodb-connection-string>" \
    MONGO_DB_NAME="archangel" \
    HELIUS_RPC_URL="<your-helius-rpc-url>" \
    WALLET_PRIVATE_KEY="<your-wallet-private-key>" \
    RAYDIUM_POOL_LISTENER=true \
    RAYDIUM_AUTO_BUY=true \
    RAYDIUM_AUTO_BUY_SOL=0.05 \
    MIN_RAYDIUM_LP_SOL=0.05 \
    STORED_TOKEN_CHECKER_ENABLED=true \
    TELEGRAM_BOT_TOKEN="<your-telegram-token>" \
    TELEGRAM_CHAT_ID="<your-telegram-chat-id>"

# Enable WebSocket and Always On
az webapp config set \
  --resource-group archangel-rg \
  --name archangel-backend \
  --web-sockets-enabled true \
  --always-on true
```

### 3. Setup GitHub Secrets for CI/CD

Go to your GitHub repository → Settings → Secrets and add:

**Backend Secrets:**

- `AZURE_BACKEND_PUBLISH_PROFILE`: Get from Azure Portal (App Service → Deployment Center → Manage publish profile)

**Frontend Secrets:**

- `AZURE_STATIC_WEB_APPS_API_TOKEN`: Get from Azure Portal (Static Web App → Manage deployment token)
- `AZURE_API_BASE_URL`: `https://archangel-backend.azurewebsites.net/api`
- `AZURE_SOCKET_URL`: `https://archangel-backend.azurewebsites.net`

### 4. Deploy via GitHub Actions

Push to main branch:

```bash
git add .
git commit -m "Configure Azure deployment"
git push origin main
```

GitHub Actions will automatically:

- Build backend TypeScript
- Deploy backend to Azure App Service
- Build frontend Next.js
- Deploy frontend to Azure Static Web Apps

## Manual Deployment (Alternative)

### Backend Manual Deployment

```bash
# Build locally
cd backend
npm install
npm run build

# Deploy using Azure CLI
az webapp deployment source config-zip \
  --resource-group archangel-rg \
  --name archangel-backend \
  --src deploy.zip
```

### Frontend Manual Deployment

```bash
# Build locally
cd frontend
npm install
NEXT_PUBLIC_API_BASE_URL=https://archangel-backend.azurewebsites.net/api \
NEXT_PUBLIC_SOCKET_URL=https://archangel-backend.azurewebsites.net \
npm run build

# Deploy to Azure Static Web Apps
az staticwebapp create \
  --name archangel-frontend \
  --resource-group archangel-rg \
  --source frontend \
  --location eastus \
  --branch main \
  --app-location "/frontend" \
  --output-location "out"
```

## Monitoring

### View Logs

```bash
# Backend logs (real-time)
az webapp log tail --resource-group archangel-rg --name archangel-backend

# Download logs
az webapp log download --resource-group archangel-rg --name archangel-backend
```

### Application Insights

```bash
# Get instrumentation key
az monitor app-insights component show \
  --app archangel-insights \
  --resource-group archangel-rg \
  --query instrumentationKey
```

Add to backend environment variables:

```bash
az webapp config appsettings set \
  --resource-group archangel-rg \
  --name archangel-backend \
  --settings APPINSIGHTS_INSTRUMENTATIONKEY="<key>"
```

## Cost Optimization

**Estimated Monthly Costs:**

- App Service Plan (B1): ~$13/month
- Static Web App (Free tier): $0
- Application Insights: ~$2-5/month
- **Total**: ~$15-20/month

**To reduce costs:**

```bash
# Use Free tier App Service (limited to 60 min/day)
az appservice plan update \
  --name archangel-plan \
  --resource-group archangel-rg \
  --sku F1

# Or scale down when not trading
az appservice plan update \
  --name archangel-plan \
  --resource-group archangel-rg \
  --sku B1 \
  --number-of-workers 1
```

## Scaling

### Auto-scaling (Premium tiers only)

```bash
# Enable autoscale
az monitor autoscale create \
  --resource-group archangel-rg \
  --resource archangel-backend \
  --resource-type Microsoft.Web/serverfarms \
  --name archangel-autoscale \
  --min-count 1 \
  --max-count 3 \
  --count 1

# Add CPU-based rule
az monitor autoscale rule create \
  --resource-group archangel-rg \
  --autoscale-name archangel-autoscale \
  --condition "Percentage CPU > 70 avg 5m" \
  --scale out 1
```

## Troubleshooting

### Check App Service Status

```bash
az webapp show \
  --resource-group archangel-rg \
  --name archangel-backend \
  --query state
```

### Restart App Service

```bash
az webapp restart \
  --resource-group archangel-rg \
  --name archangel-backend
```

### Test Endpoints

```bash
# Health check
curl https://archangel-backend.azurewebsites.net/health

# Readiness check
curl https://archangel-backend.azurewebsites.net/ready

# API test
curl https://archangel-backend.azurewebsites.net/api/stats
```

## Security Best Practices

1. **Enable HTTPS Only** (already configured in bicep)
2. **Use Managed Identity** for database access
3. **Store secrets in Azure Key Vault**
4. **Enable Application Insights** for monitoring
5. **Set up Azure DDoS Protection**
6. **Configure CORS** properly in App Service

## Custom Domain (Optional)

```bash
# Add custom domain
az webapp config hostname add \
  --resource-group archangel-rg \
  --webapp-name archangel-backend \
  --hostname api.yourdomain.com

# Enable SSL
az webapp config ssl bind \
  --resource-group archangel-rg \
  --name archangel-backend \
  --certificate-thumbprint <thumbprint> \
  --ssl-type SNI
```

## Cleanup

To delete all Azure resources:

```bash
az group delete --name archangel-rg --yes --no-wait
```

## Support

- Azure Documentation: https://docs.microsoft.com/azure
- Azure Support: https://azure.microsoft.com/support
- GitHub Issues: https://github.com/Victor-droid-ux/ArchAngel/issues
