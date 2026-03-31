# POLYBOT v3 — Polymarket AI Trading Engine

Automated prediction market trading bot that uses Claude AI to identify mispriced contracts on Polymarket and execute trades via the CLOB API.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Binance     │     │  Polymarket  │     │   Claude AI  │
│   WebSocket   │     │  Gamma/CLOB  │     │   Sonnet     │
│   (BTC feed)  │     │  (markets)   │     │  (analysis)  │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────┐
│                    POLYBOT SERVER                        │
│                                                         │
│  Scanner ──▶ Brain (Claude) ──▶ Executor ──▶ CLOB API  │
│                                                         │
│  Paper Trading ◄──────────────────────▶ Live Trading    │
│  (simulated)                          (real USDC)       │
└──────────────────────┬──────────────────────────────────┘
       │               │               │
       ▼               ▼               ▼
┌──────────┐    ┌──────────┐    ┌──────────┐
│ Dashboard │    │ Telegram │    │   REST   │
│  (React)  │    │  Alerts  │    │   API    │
└──────────┘    └──────────┘    └──────────┘
```

## Quick Start (Paper Trading)

Paper trading requires NO wallet and NO USDC. Perfect for testing.

```bash
# Clone and install
cd polybot-server
npm install

# Minimal config — just need Claude for AI analysis (optional)
cp .env.example .env
# Edit .env → add ANTHROPIC_API_KEY (optional)

# Start
npm start
```

The bot starts in paper mode with $500 simulated balance.
Visit `http://localhost:3001/api/state` to see live data.

## Going Live (Real Money)

### Step 1: Set up a Polygon wallet

You need a wallet with USDC on the Polygon network.

1. Create a wallet (MetaMask, or generate a new one)
2. Fund it with USDC on Polygon ($50-100 to start)
3. Send a small amount of POL for gas fees (~0.1 POL)
4. Export your private key

### Step 2: Configure

```bash
cp .env.example .env
```

Fill in:
- `PRIVATE_KEY` — your Polygon wallet private key
- `FUNDER_ADDRESS` — your wallet address
- `ANTHROPIC_API_KEY` — for Claude AI analysis
- `TG_BOT_TOKEN` + `TG_CHAT_ID` — for phone alerts

### Step 3: Approve contracts (one-time)

```bash
npm run approve
```

This approves Polymarket's exchange contracts to interact with your USDC and conditional tokens. Costs ~0.01 POL in gas.

### Step 4: Derive API credentials

```bash
npm run derive-keys
```

This performs EIP-712 authentication and generates your CLOB API key/secret/passphrase. Copy the output into your `.env` file.

### Step 5: Start trading

```bash
npm start
```

The bot starts in paper mode by default. To switch to live:

```bash
# Via API
curl -X POST http://localhost:3001/api/mode -H "Content-Type: application/json" -d '{"mode":"live"}'

# Start the bot
curl -X POST http://localhost:3001/api/bot/start
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Server status |
| `/api/state` | GET | Full dashboard state |
| `/api/trades` | GET | Trade history |
| `/api/markets` | GET | Active Polymarket contracts |
| `/api/market/select` | POST | Select a market to trade |
| `/api/bot/start` | POST | Start the trading bot |
| `/api/bot/stop` | POST | Stop the trading bot |
| `/api/bot/kill` | POST | Emergency kill switch |
| `/api/mode` | POST | Switch paper/live mode |
| `/api/analyze` | POST | Run one-shot analysis |
| `/api/config` | POST | Update trading params |
| `/api/telegram/test` | POST | Test Telegram alerts |

## Safety Features

- **Paper mode default** — bot never touches real money until explicitly switched
- **Daily trade limit** — max 20 trades/day (configurable)
- **Daily loss limit** — auto-stops at $100 loss (configurable)
- **Position size cap** — max $50 per trade (configurable)
- **Kill switch** — `POST /api/bot/kill` halts everything instantly
- **Telegram alerts** — every trade, win/loss, and error sent to your phone

## Strategy

The bot exploits a known inefficiency: Polymarket contract prices update slower than actual BTC price movement. When BTC is clearly trending in one direction but Polymarket's YES/NO prices haven't caught up, there's an arbitrage window.

1. **Scanner** — Monitors BTC price via Binance WebSocket and Polymarket YES/NO prices via CLOB API
2. **Brain** — Claude AI analyzes momentum, volatility, and the gap between true probability and market price
3. **Executor** — If edge exceeds minimum threshold (default 8%), places a trade via EIP-712 signed order

Position sizing uses a modified Kelly criterion: `bet = edge × confidence × 2`, capped at the configured maximum.

## Deployment

### Railway (recommended)
```bash
# Install Railway CLI
npm i -g @railway/cli

# Deploy
railway init
railway up
```

Set environment variables in the Railway dashboard.

### Render
Push to GitHub, connect to Render, set env vars.

### VPS (DigitalOcean, AWS, etc.)
```bash
ssh your-server
git clone <your-repo>
cd polybot-server
npm install
cp .env.example .env
# Edit .env with your keys
pm2 start server.js --name polybot
```

## Disclaimer

This bot is for educational purposes. Trading prediction markets involves real financial risk. Never trade with money you can't afford to lose. Past performance of any strategy does not guarantee future results. You are solely responsible for your trading decisions.
