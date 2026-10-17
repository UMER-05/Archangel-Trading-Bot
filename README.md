# ArchAngel Trading Bot

A Solana trading bot with automated token discovery, a multi-stage validation pipeline, Jupiter-routed swaps with a native Raydium execution engine, and risk management.

## 🖥️ Desktop App Available!

**ArchAngel is now available as a standalone desktop application!**

- ✅ One-click `.exe` installer for Windows
- ✅ No terminal or Node.js installation required
- ✅ Backend and frontend run automatically
- ✅ System tray integration
- ✅ Clean desktop GUI

👉 **See [docs/desktop/DESKTOP_APP_BUILD.md](docs/desktop/DESKTOP_APP_BUILD.md) for build instructions**

---

## Features

- 🤖 **Automated Trading**: Discovers new tokens from the Solami Blur stream and auto-buys candidates that pass the pipeline
- 🔍 **Pool Monitoring**: Pool availability and tradeability checks before every buy
- 📊 **Multi-Stage Validation**: Safety checks, market-behaviour analysis and Jupiter tradeability validation
- 🛡️ **Risk Management**: Wallet balance monitoring, position monitor and emergency exit
- 📈 **Live P&L Tracking**: Real-time portfolio valuation and stats over Socket.IO
- ⚡ **Jupiter + Native Execution**: Jupiter quotes with a native Raydium CPMM executor (see `docs/`)
- 🎯 **Manual Buy / Sell**: Execute trades directly from the UI

## Architecture

- **Backend**: Node.js/TypeScript with Express.js
- **Frontend**: Next.js with React and TypeScript
- **Blockchain**: Solana (Jupiter routing, Raydium native execution)
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
# Required for the bot to discover and buy tokens (see .env.example for all)
MONGO_URI=your_mongodb_connection_string
SOLAMI_BLUR_API_KEY=your_solami_blur_key   # token discovery
JUPITER_AUTO_BUY=true                      # must be exactly "true"
USE_REAL_SWAP=false                        # "true" = real on-chain buys
SOLANA_RPC_URL=your_rpc_endpoint_here
WALLET_SECRET_KEY=your_wallet_private_key_here
```

On startup the backend logs one `[trading readiness]` line per gate (discovery,
auto-buy, swap mode, RPC, database, operator wallet, global pause) — check
those first if the bot isn't buying.

Each running copy of the bot needs its **own** database — copies sharing one
`MONGO_URI` split the discovered tokens between them.

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
- **Take Profit / Stop Loss**: Exit strategy thresholds

### Validation Pipeline

Tokens go through multiple validation stages:

1. **Token Data Retrieval**: Fetch metadata and account info
2. **Jupiter Routing Test**: Verify buy/sell routes exist
3. **Liquidity Verification**: Ensure sufficient pool liquidity
4. **Security Checks**: Validate token safety metrics

## Project Structure

```
ArchAngel-Bot/
├── backend/
│   ├── src/
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Core business logic
│   │   │   ├── execution/   # Native swap engine (Raydium CPMM, Jito sender)
│   │   │   ├── blurStream.service.ts
│   │   │   ├── candidatePipeline.service.ts
│   │   │   ├── validationPipeline.service.ts
│   │   │   ├── jupiter.service.ts
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

### Emergency Exit

The bot includes emergency exit mechanisms to protect capital:

- Wallet balance monitoring
- Automatic position closure on critical events
- Manual emergency exit button in UI

## API Endpoints

- `POST /api/trade/prepare` - Build a swap transaction for the user's wallet to sign
- `POST /api/trade/confirm` - Confirm a signed swap
- `GET /api/tokens/active` - Tokens currently tracked
- `GET /api/pnl/portfolio` - Portfolio P&L
- `GET /api/positions` - Open positions
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

All documentation lives in [docs/](docs/README.md):

- [Native swap engine specs](docs/native-swap-fund-safety-spec.md)
- [Validation Pipeline](docs/VALIDATION_PIPELINE.md)
- [Risk Management](docs/WALLET_BALANCE_RISK_MANAGEMENT.md)
- [Pool Monitoring](docs/POOL_MONITORING.md)
- [Socket.IO Events](docs/SOCKET_EVENTS.md)
- [Deployment guides](docs/deployment/)

## License

Private repository - All rights reserved

## Support

For issues or questions, please open an issue on GitHub.

---

**⚠️ Trading Disclaimer**: This bot is for educational purposes. Cryptocurrency trading carries significant risk. Never trade with funds you cannot afford to lose.
