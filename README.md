# ArchAngel Trading Bot

A sophisticated Solana trading bot with automated token discovery, validation pipeline, and risk management features for trading on Raydium and Pump.fun.

## 🖥️ Desktop App Available!

**ArchAngel is now available as a standalone desktop application!**

- ✅ One-click `.exe` installer for Windows
- ✅ No terminal or Node.js installation required
- ✅ Backend and frontend run automatically
- ✅ System tray integration
- ✅ Clean desktop GUI

👉 **See [DESKTOP_APP_BUILD.md](DESKTOP_APP_BUILD.md) for build instructions**

---

## Features

- 🤖 **Automated Trading**: Auto-buy newly graduated tokens from Pump.fun to Raydium
- 🔍 **Pool Monitoring**: Real-time Raydium pool detection and validation
- 📊 **Multi-Stage Validation**: Comprehensive token validation pipeline
- 💰 **Tranche Buying**: Split large buys into multiple tranches to minimize price impact
- 🛡️ **Risk Management**: Wallet balance monitoring and emergency exit mechanisms
- 📈 **Live P&L Tracking**: Real-time portfolio performance monitoring
- ⚡ **Fast Mode Trading**: Optimized quote fetching for manual trades (3 retries ~900ms)
- 🎯 **Manual Buy Panel**: Execute trades directly from the UI with timeout optimization

## Architecture

- **Backend**: Node.js/TypeScript with Express.js
- **Frontend**: Next.js with React and TypeScript
- **Blockchain**: Solana (Raydium DEX integration)
- **Real-time**: Socket.io for live updates

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Solana wallet with SOL for trading
- RPC endpoint (Helius, QuickNode, or similar)

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/Victor-droid-ux/ArchAngel.git
cd ArchAngel-Bot
```

### 2. Backend Setup

```bash
cd backend
npm install
```

#### Configure Environment Variables

Copy the example environment file and configure it:

```bash
cp .env.example .env
```

Edit `backend/.env` with your configuration:

```env
# Solana Configuration
SOLANA_RPC_URL=your_rpc_endpoint_here
WALLET_PRIVATE_KEY=your_wallet_private_key_here

# Trading Configuration
AUTO_BUY_ENABLED=false
DEFAULT_BUY_AMOUNT=0.01

# Optional Services
BIRDEYE_API_KEY=your_birdeye_api_key
HELIUS_API_KEY=your_helius_api_key
```

#### Generate mainnet.json (IMPORTANT)

The `backend/config/mainnet.json` file contains Solana program account data and is **NOT included in version control** due to its large size (>800MB). You need to generate or download this file locally:

**Option 1: Generate from RPC (Recommended)**

This file is typically generated automatically when the bot starts by fetching Raydium program accounts from your RPC endpoint. Simply start the backend and it will create the file:

```bash
npm run dev
```

**Option 2: Download Pre-generated File**

If you have access to a pre-generated mainnet.json file, place it in:

```
backend/config/mainnet.json
```

**Note**: This file is excluded by `.gitignore` and should never be committed to version control. Each developer/server needs to generate it locally.

#### Build Backend

```bash
npm run build
```

### 3. Frontend Setup

```bash
cd ../frontend
npm install
```

Configure frontend environment (if needed):

```bash
cp .env.example .env.local
```

Build frontend:

```bash
npm run build
```

## Running the Application

### Development Mode

**Backend:**

```bash
cd backend
npm run dev
```

**Frontend:**

```bash
cd frontend
npm run dev
```

Access the application at `http://localhost:3000`

### Production Mode

**Backend:**

```bash
cd backend
npm run build
npm start
```

**Frontend:**

```bash
cd frontend
npm run build
npm start
```

## Configuration

### Trading Parameters

Configure trading parameters in the UI or via the trader config modal:

- **Auto-Buy Amount**: SOL amount per automatic purchase
- **Min Liquidity**: Minimum pool liquidity (SOL) required
- **Max Slippage**: Maximum allowed slippage percentage
- **Tranche Count**: Number of splits for large orders
- **Take Profit / Stop Loss**: Exit strategy thresholds

### Validation Pipeline

Tokens go through multiple validation stages:

1. **Token Data Retrieval**: Fetch metadata and account info
2. **Raydium Routing Test**: Verify buy/sell routes exist
3. **Liquidity Verification**: Ensure sufficient pool liquidity
4. **Security Checks**: Validate token safety metrics

## Project Structure

```
ArchAngel-Bot/
├── backend/
│   ├── src/
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Core business logic
│   │   │   ├── raydium/     # Raydium DEX integration
│   │   │   ├── validationPipeline.service.ts
│   │   │   ├── raydiumPoolListener.service.ts
│   │   │   ├── trancheBuyer.service.ts
│   │   │   └── ...
│   │   ├── types/           # TypeScript definitions
│   │   └── utils/           # Helper functions
│   ├── config/
│   │   └── mainnet.json     # (Generated locally, not in git)
│   └── package.json
├── frontend/
│   ├── app/                 # Next.js pages
│   ├── components/          # React components
│   ├── hooks/               # Custom React hooks
│   ├── lib/                 # Utilities
│   └── package.json
└── README.md
```

## Key Features Explained

### Fast Mode Trading

Manual trades from the UI use an optimized "fast mode" with only 3 retry attempts (~900ms timeout) for quick response times, while the auto-trader uses full 20-retry mode (~6s timeout) to catch newly created pools.

### Tranche Buying

Large buy orders are automatically split into multiple smaller transactions to:

- Minimize price impact
- Reduce slippage
- Improve execution price

### Emergency Exit

The bot includes emergency exit mechanisms to protect capital:

- Wallet balance monitoring
- Automatic position closure on critical events
- Manual emergency exit button in UI

## API Endpoints

- `POST /api/trade/prepare` - Prepare trade (fast mode)
- `POST /api/trade/execute` - Execute prepared trade
- `GET /api/tokens/discovered` - Get discovered tokens
- `GET /api/portfolio/pnl` - Get P&L data
- `GET /api/config/trader` - Get trader configuration
- WebSocket events for real-time updates

## Troubleshooting

### Backend won't start

1. Ensure mainnet.json is generated (see Installation section)
2. Check RPC endpoint is accessible
3. Verify wallet private key is valid
4. Check all environment variables are set

### Trades timing out

- Increase RPC endpoint rate limits
- Use a premium RPC provider (Helius, QuickNode)
- Check network connectivity
- Verify pool has sufficient liquidity

### mainnet.json is missing

This file is intentionally not included in git due to its size (892MB). Generate it by:

1. Starting the backend server (it will fetch from RPC)
2. Or manually downloading Raydium program account data

## Security Notes

⚠️ **Never commit sensitive files:**

- `.env` files with private keys
- `mainnet.json` (too large for GitHub)
- Any files containing API keys or secrets

These are excluded via `.gitignore` for your protection.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## Documentation

Additional documentation available in the repository:

- [Raydium Trading System](RAYDIUM_TRADING_SYSTEM.md)
- [Validation Pipeline](VALIDATION_PIPELINE.md)
- [Tranche Buying Implementation](2_TRANCHE_BUYING_IMPLEMENTATION.md)
- [Risk Management](WALLET_BALANCE_RISK_MANAGEMENT.md)
- [Pool Monitoring](POOL_MONITORING.md)

## License

Private repository - All rights reserved

## Support

For issues or questions, please open an issue on GitHub.

---

**⚠️ Trading Disclaimer**: This bot is for educational purposes. Cryptocurrency trading carries significant risk. Never trade with funds you cannot afford to lose.
