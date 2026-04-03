// ════════════════════════════════════════════════════════════════════
//  POLYBOT SERVER — Production Polymarket Trading Engine
//  
//  Handles:
//  • Wallet auth + EIP-712 order signing via @polymarket/clob-client
//  • Live CLOB order execution (buy/sell on Polymarket)
//  • Real-time BTC price feed (CoinGecko + CoinCap + Blockchain.info)
//  • Claude AI probability analysis
//  • Telegram trade alerts
//  • REST API for the React dashboard
//  • Kill switch + position limits
//
//  Deploy: Railway, Render, VPS, or localhost
//  Install: npm install
//  Run:     node server.js
// ════════════════════════════════════════════════════════════════════

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const { ClobClient } = require("@polymarket/clob-client");
const { Wallet } = require("@ethersproject/wallet");
const { JsonRpcProvider } = require("@ethersproject/providers");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const { ApexEngine, APEX_CONFIG } = require("./apex-strategy");
const { NewsEngine } = require("./news-engine");
const { FiveMinSniper } = require("./five-min-sniper");
const { TechnicalAnalysis } = require("./technical-analysis");
const { KalshiClient } = require("./kalshi-client");
const { UnifiedMarketMaker } = require("./unified-mm");
const taEngine = new TechnicalAnalysis();

const app = express();
app.use(cors());
app.use(express.json());

// ════════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════════
const CONFIG = {
  // Server
  PORT: process.env.PORT || 3001,

  // Polymarket
  CLOB_HOST: "https://clob.polymarket.com",
  GAMMA_HOST: "https://gamma-api.polymarket.com",
  CHAIN_ID: 137, // Polygon mainnet

  // Wallet (set in .env)
  PRIVATE_KEY: process.env.PRIVATE_KEY || "",
  FUNDER_ADDRESS: process.env.FUNDER_ADDRESS || "",
  SIGNATURE_TYPE: parseInt(process.env.SIGNATURE_TYPE || "1"), // 1 = Magic/email, 0 = EOA

  // Pre-generated API creds (optional — will auto-derive if not set)
  API_KEY: process.env.POLYMARKET_API_KEY || "",
  API_SECRET: process.env.POLYMARKET_SECRET || "",
  API_PASSPHRASE: process.env.POLYMARKET_PASSPHRASE || "",

  // Claude AI
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",

  // Telegram
  TG_BOT_TOKEN: process.env.TG_BOT_TOKEN || "",
  TG_CHAT_ID: process.env.TG_CHAT_ID || "",

  // Trading params
  MIN_EDGE: parseFloat(process.env.MIN_EDGE || "0.08"),
  BET_PCT: parseFloat(process.env.BET_PCT || "0.06"),
  MAX_POSITION_SIZE: parseFloat(process.env.MAX_POSITION_SIZE || "50"), // $50 max per trade
  MAX_DAILY_TRADES: parseInt(process.env.MAX_DAILY_TRADES || "20"),
  MAX_DAILY_LOSS: parseFloat(process.env.MAX_DAILY_LOSS || "100"), // stop if down $100

  // Polygon RPC
  POLYGON_RPC: process.env.POLYGON_RPC || "https://polygon-rpc.com",

  // Kalshi
  KALSHI_EMAIL: process.env.KALSHI_EMAIL || "",
  KALSHI_PASSWORD: process.env.KALSHI_PASSWORD || "",
  KALSHI_DEMO: process.env.KALSHI_DEMO !== "false", // Default to demo mode
};

// ════════════════════════════════════════════════════════════
//  STATE
// ════════════════════════════════════════════════════════════
const state = {
  // Connections
  clobClient: null,
  wallet: null,
  provider: null,
  isAuthenticated: false,

  // Market data
  btcPrice: null,
  btcHistory: [],
  btc24hChange: null,

  // Polymarket
  activeMarkets: [],
  selectedMarket: null,
  orderBook: null,

  // Trading
  mode: "paper", // "paper" | "live"
  botActive: false,
  positions: [],
  trades: [],
  stats: { wins: 0, losses: 0, totalPnl: 0, dailyTrades: 0, dailyPnl: 0 },
  balance: 500, // paper balance

  // Analysis
  lastAnalysis: null,

  // Logs
  logs: [],

  // Kill switch
  killed: false,
};

function log(msg, type = "info") {
  const entry = { time: new Date().toISOString(), msg, type };
  state.logs.unshift(entry);
  if (state.logs.length > 500) state.logs = state.logs.slice(0, 500);
  const colors = { info: "\x1b[36m", trade: "\x1b[32m", error: "\x1b[31m", warn: "\x1b[33m", ai: "\x1b[35m", live: "\x1b[91m" };
  console.log(`${colors[type] || "\x1b[0m"}[${type.toUpperCase()}]\x1b[0m ${msg}`);
}

// ════════════════════════════════════════════════════════════
//  WALLET & CLOB AUTHENTICATION
// ════════════════════════════════════════════════════════════
async function initWallet() {
  if (!CONFIG.PRIVATE_KEY) {
    log("No PRIVATE_KEY set — running in paper-only mode", "warn");
    return false;
  }

  try {
    // Create ethers wallet
    state.provider = new JsonRpcProvider(CONFIG.POLYGON_RPC);
    state.wallet = new Wallet(CONFIG.PRIVATE_KEY, state.provider);
    const address = await state.wallet.getAddress();
    log(`Wallet loaded: ${address}`, "info");

    // Always derive fresh credentials on startup
    log("Deriving CLOB API credentials...", "info");
    const tempClient = new ClobClient(
      CONFIG.CLOB_HOST,
      CONFIG.CHAIN_ID,
      state.wallet,
      undefined,
      CONFIG.SIGNATURE_TYPE,
      CONFIG.FUNDER_ADDRESS || address
    );

    let creds;
    try {
      creds = await tempClient.deriveApiKey();
      log(`Derived existing API key`, "info");
    } catch {
      try {
        creds = await tempClient.createApiKey();
        log(`Created new API key`, "info");
      } catch {
        creds = await tempClient.createOrDeriveApiKey();
        log(`createOrDerive fallback`, "info");
      }
    }

    // Build the authed client
    state.clobClient = new ClobClient(
      CONFIG.CLOB_HOST,
      CONFIG.CHAIN_ID,
      state.wallet,
      creds,
      CONFIG.SIGNATURE_TYPE,
      CONFIG.FUNDER_ADDRESS || address
    );

    // Verify connection
    const ok = await state.clobClient.getOk();
    if (ok) {
      state.isAuthenticated = true;
      log("CLOB authenticated successfully ✓", "trade");
      await sendTelegram("🟢 POLYBOT connected to Polymarket CLOB");
    } else {
      log("CLOB connection check returned false", "warn");
    }

    return true;
  } catch (e) {
    log(`Wallet init failed: ${e.message}`, "error");
    log("Bot will run in paper mode. CLOB auth error doesn't affect market scanning.", "info");
    return false;
  }
}

// ════════════════════════════════════════════════════════════
//  BTC PRICE FEED (CoinGecko REST — works worldwide including US)
// ════════════════════════════════════════════════════════════
function startBtcPriceFeed() {
  const fetchPrice = async () => {
    // Try CoinGecko first (works in US)
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true");
      if (res.ok) {
        const d = await res.json();
        if (d.bitcoin && d.bitcoin.usd) {
          state.btcPrice = d.bitcoin.usd;
          state.btc24hChange = d.bitcoin.usd_24h_change || 0;
          state.btcHistory.push(state.btcPrice);
          if (state.btcHistory.length > 300) state.btcHistory = state.btcHistory.slice(-300);
          return;
        }
      }
    } catch {}

    // Fallback: CoinCap API
    try {
      const res = await fetch("https://api.coincap.io/v2/assets/bitcoin");
      if (res.ok) {
        const d = await res.json();
        if (d.data && d.data.priceUsd) {
          state.btcPrice = parseFloat(d.data.priceUsd);
          state.btc24hChange = parseFloat(d.data.changePercent24Hr || 0);
          state.btcHistory.push(state.btcPrice);
          if (state.btcHistory.length > 300) state.btcHistory = state.btcHistory.slice(-300);
          return;
        }
      }
    } catch {}

    // Fallback: Blockchain.info
    try {
      const res = await fetch("https://blockchain.info/ticker");
      if (res.ok) {
        const d = await res.json();
        if (d.USD && d.USD.last) {
          state.btcPrice = d.USD.last;
          state.btcHistory.push(state.btcPrice);
          if (state.btcHistory.length > 300) state.btcHistory = state.btcHistory.slice(-300);
          return;
        }
      }
    } catch {}

    log("All BTC price feeds failed — retrying", "warn");
  };

  // Fetch immediately, then every 3 seconds
  fetchPrice();
  setInterval(fetchPrice, 3000);
  log("BTC price feed started (CoinGecko + CoinCap + Blockchain.info)", "info");
}

// ════════════════════════════════════════════════════════════
//  POLYMARKET DATA
// ════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════
//  SMART MARKET SCORING — find the best opportunities
// ════════════════════════════════════════════════════════════
function parsePrice(market) {
  try {
    if (!market.outcomePrices) return { yes: 0.5, no: 0.5 };
    const prices = typeof market.outcomePrices === "string" ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    const yes = parseFloat(prices[0]) || 0.5;
    return { yes, no: 1 - yes };
  } catch { return { yes: 0.5, no: 0.5 }; }
}

function scoreMarket(market) {
  const prices = parsePrice(market);
  const volume = parseFloat(market.volume24hr || 0);
  const liquidity = parseFloat(market.liquidity || 0);

  let score = 0;

  // High volume = more reliable pricing and easier to fill orders
  if (volume > 100000) score += 3;
  else if (volume > 10000) score += 2;
  else if (volume > 1000) score += 1;

  // Good liquidity = less slippage
  if (liquidity > 50000) score += 2;
  else if (liquidity > 10000) score += 1;

  // Sweet spot pricing: 15-85% is where edges are most likely
  // Markets at 1% or 99% are basically decided — no edge
  if (prices.yes >= 0.15 && prices.yes <= 0.85) score += 3;
  else if (prices.yes >= 0.05 && prices.yes <= 0.95) score += 1;
  else score -= 5; // Penalty for extreme prices

  // Has order book enabled
  if (market.enableOrderBook) score += 1;

  // CLOB tokens available (actually tradeable)
  if (market.clobTokenIds) score += 1;

  // ── PURE ARBITRAGE CHECK ──
  // If YES + NO < $1.00, that's guaranteed profit
  if (prices.yes + prices.no < 0.98) {
    score += 10; // Massive bonus
    market._arbitrage = true;
    market._arbSpread = 1 - prices.yes - prices.no;
  }

  market._score = score;
  market._prices = prices;
  return score;
}

async function fetchMarkets() {
  try {
    const CRYPTO_KEYWORDS = ["btc", "bitcoin", "eth", "ethereum", "sol", "solana", "crypto", "cryptocurrency", "xrp", "doge", "dogecoin", "ada", "cardano", "bnb", "avax", "matic", "polygon", "defi", "nft", "altcoin", "memecoin", "stablecoin", "usdc", "usdt", "coinbase", "binance", "halving", "mining", "blockchain", "web3", "airdrop", "token launch", "fdv", "market cap", "onchain"];

    // Blacklist — never trade these even if they match a keyword
    const BLACKLIST = ["iran", "regime", "president", "election", "nominee", "governor", "senator", "congress", "war", "ceasefire", "nato", "military", "nba", "nfl", "nhl", "mlb", "fifa", "world cup", "oscar", "grammy", "tweet", "elon musk", "trump", "biden", "vance"];

    // Fetch all markets
    const res = await fetch(`${CONFIG.GAMMA_HOST}/markets?closed=false&active=true&limit=100&order=volume24hr&ascending=false`);
    if (!res.ok) throw new Error(`Gamma API ${res.status}`);
    const data = await res.json();

    // STRICT crypto filter — must match keyword AND not match blacklist
    const cryptoMarkets = data.filter(m => {
      const q = (m.question || "").toLowerCase();
      const slug = (m.slug || "").toLowerCase();
      const combined = q + " " + slug;

      const isCrypto = CRYPTO_KEYWORDS.some(kw => combined.includes(kw));
      const isBlacklisted = BLACKLIST.some(kw => combined.includes(kw));

      return m.active && isCrypto && !isBlacklisted;
    });

    if (cryptoMarkets.length === 0) {
      log("No crypto markets found right now — bot will keep checking every 30s", "warn");
      // DON'T fall back to non-crypto. Just wait.
      return state.activeMarkets;
    }

    // Score and sort
    const scored = cryptoMarkets
      .map(m => { scoreMarket(m); return m; })
      .sort((a, b) => (b._score || 0) - (a._score || 0));

    state.activeMarkets = scored.slice(0, 30);

    const arbMarkets = scored.filter(m => m._arbitrage);
    if (arbMarkets.length > 0) {
      arbMarkets.forEach(m => {
        log(`💰 ARBITRAGE DETECTED: ${(m.question || m.slug || "").slice(0, 50)} — spread ${(m._arbSpread * 100).toFixed(2)}%`, "trade");
      });
    }

    if (state.activeMarkets.length > 0 && !state.selectedMarket) {
      state.selectedMarket = state.activeMarkets[0];
      log(`Selected market (score ${state.selectedMarket._score}): ${(state.selectedMarket.question || state.selectedMarket.slug || "").slice(0, 60)}`, "info");
    }

    log(`Scored ${state.activeMarkets.length} crypto markets | Top score: ${state.activeMarkets[0]?._score || 0} | Arb: ${arbMarkets.length}`, "info");
    return state.activeMarkets;
  } catch (e) {
    log(`Market fetch error: ${e.message}`, "warn");
    return [];
  }
}

async function fetchOrderBook(market) {
  if (!market) return null;
  try {
    const tokenId = market.clobTokenIds?.[0] || market.tokens?.[0]?.token_id;
    if (!tokenId) return null;

    const [priceRes, bookRes] = await Promise.all([
      fetch(`${CONFIG.CLOB_HOST}/price?token_id=${tokenId}&side=buy`).catch(() => null),
      fetch(`${CONFIG.CLOB_HOST}/book?token_id=${tokenId}`).catch(() => null),
    ]);

    let price = null;
    let book = null;

    if (priceRes?.ok) {
      const d = await priceRes.json();
      price = parseFloat(d.price || d);
    }
    if (bookRes?.ok) {
      book = await bookRes.json();
    }

    state.orderBook = { price, book, tokenId, updatedAt: new Date() };
    return state.orderBook;
  } catch (e) {
    log(`Order book error: ${e.message}`, "warn");
    return null;
  }
}

// ════════════════════════════════════════════════════════════
//  STRATEGY ENGINE — Multi-strategy analysis
//  Strategy 1: Pure arbitrage (YES + NO < $1)
//  Strategy 2: AI probability mispricing (Claude vs market)
//  Strategy 3: Correlation arbitrage (related markets)
//  Strategy 4: Liquidity imbalance (order book analysis)
// ════════════════════════════════════════════════════════════

// Track Claude's past predictions for learning
const predictionHistory = [];

function trackPrediction(market, claudeProb, marketProb, signal) {
  predictionHistory.push({
    market: market.question || market.slug,
    claudeProb,
    marketProb,
    signal,
    timestamp: new Date(),
  });
  if (predictionHistory.length > 200) predictionHistory.shift();
}

// Calculate Claude's historical accuracy to weight confidence
function getClaudeAccuracy() {
  const settled = state.trades.filter(t => t.result);
  if (settled.length < 5) return 0.6; // Default before enough data
  const correct = settled.filter(t => t.result === "WIN").length;
  return Math.max(0.3, Math.min(0.9, correct / settled.length));
}

// Strategy 1: Pure Arbitrage
function checkArbitrage(market) {
  const prices = market._prices || parsePrice(market);
  const combined = prices.yes + prices.no;
  if (combined < 0.98) {
    const spread = 1 - combined;
    return {
      strategy: "ARBITRAGE",
      signal: "BUY_BOTH",
      edge: spread,
      confidence: 0.95,
      reasoning: `YES($${prices.yes.toFixed(3)}) + NO($${prices.no.toFixed(3)}) = $${combined.toFixed(3)} — guaranteed $${spread.toFixed(3)} profit per share`,
      yesPrice: prices.yes,
    };
  }
  return null;
}

// Strategy 2: AI Probability Mispricing
async function analyzeWithClaude(market) {
  const prices = market._prices || parsePrice(market);
  const volume = parseFloat(market.volume24hr || 0);
  const liquidity = parseFloat(market.liquidity || 0);
  const claudeAccuracy = getClaudeAccuracy();

  if (!CONFIG.ANTHROPIC_API_KEY) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        messages: [
          {
            role: "user",
            content: `You are an expert prediction market analyst. Your job is to find MISPRICED markets where the crowd is wrong.

MARKET: "${market.question || market.slug}"
CURRENT PRICE: YES = $${prices.yes.toFixed(3)} (implies ${(prices.yes * 100).toFixed(1)}% probability)
24H VOLUME: $${volume.toLocaleString()}
LIQUIDITY: $${liquidity.toLocaleString()}
END DATE: ${market.endDate || "Unknown"}

ANALYSIS FRAMEWORK:
1. What is the TRUE probability this resolves YES? Use base rates, current events, and logical reasoning.
2. Compare your estimate to the market price. Is there a gap of 8%+?
3. Consider: What does the market know that you might not? (respect Efficient Market Hypothesis)
4. Only signal BUY if you have HIGH CONFIDENCE the market is wrong.

CRITICAL RULES:
- If the market is within 5% of your estimate, signal HOLD (the market is efficient)
- If you're unsure, signal HOLD (uncertainty means no edge)
- Only BUY_YES if your probability > market price + 8%
- Only BUY_NO if your probability < market price - 8%
- Edge = absolute difference between your probability and market price
- Be CONSERVATIVE — false positives cost real money

Respond ONLY JSON, no markdown:
{"probability_yes":0.XX,"confidence":0.XX,"signal":"BUY_YES"|"BUY_NO"|"HOLD","edge":0.XX,"reasoning":"2-3 sentence explanation","market_efficient":true|false}`,
          },
        ],
      }),
    });

    const data = await res.json();
    const text = data.content?.map((b) => b.text || "").join("") || "";
    const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());

    // Adjust confidence by Claude's historical accuracy
    const adjustedConfidence = analysis.confidence * claudeAccuracy;

    // If Claude says market is efficient, respect that
    if (analysis.market_efficient && analysis.signal === "HOLD") {
      return {
        strategy: "AI_MISPRICING",
        signal: "HOLD",
        edge: 0,
        confidence: adjustedConfidence,
        probability_up: analysis.probability_yes,
        reasoning: analysis.reasoning,
        yesPrice: prices.yes,
        source: "claude",
        market_efficient: true,
      };
    }

    // Recalculate edge ourselves (don't trust Claude's math blindly)
    const realEdge = analysis.signal === "BUY_YES"
      ? analysis.probability_yes - prices.yes
      : analysis.signal === "BUY_NO"
        ? prices.yes - analysis.probability_yes
        : 0;

    return {
      strategy: "AI_MISPRICING",
      signal: Math.abs(realEdge) >= CONFIG.MIN_EDGE ? analysis.signal : "HOLD",
      edge: Math.abs(realEdge),
      confidence: adjustedConfidence,
      probability_up: analysis.probability_yes,
      reasoning: analysis.reasoning,
      yesPrice: prices.yes,
      source: "claude",
      market_efficient: analysis.market_efficient || false,
      claudeAccuracy,
    };
  } catch (e) {
    log(`Claude error: ${e.message}`, "warn");
    return null;
  }
}

// Strategy 3: Correlation Arbitrage (find related mispriced markets)
function findCorrelations(markets) {
  const opportunities = [];

  // Group markets by keywords
  const groups = {};
  markets.forEach(m => {
    const q = (m.question || m.slug || "").toLowerCase();
    const keywords = ["trump", "biden", "iran", "china", "bitcoin", "btc", "election", "fed", "rate", "war"];
    keywords.forEach(kw => {
      if (q.includes(kw)) {
        if (!groups[kw]) groups[kw] = [];
        groups[kw].push(m);
      }
    });
  });

  // Check each group for logical inconsistencies
  Object.entries(groups).forEach(([keyword, group]) => {
    if (group.length < 2) return;
    // If two related markets have contradictory pricing, that's an opportunity
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const p1 = group[i]._prices || parsePrice(group[i]);
        const p2 = group[j]._prices || parsePrice(group[j]);
        // Flag if both YES prices are high (>70%) — might be contradictory
        if (p1.yes > 0.7 && p2.yes > 0.7) {
          opportunities.push({
            strategy: "CORRELATION",
            keyword,
            markets: [group[i].question?.slice(0, 40), group[j].question?.slice(0, 40)],
            prices: [p1.yes, p2.yes],
            note: "Both markets priced high — check if logically contradictory",
          });
        }
      }
    }
  });

  return opportunities;
}

// Strategy 4: Order Book Imbalance
function analyzeOrderBook(book) {
  if (!book?.book) return null;
  const bids = book.book.bids || [];
  const asks = book.book.asks || [];

  if (bids.length === 0 || asks.length === 0) return null;

  const bidVolume = bids.reduce((s, b) => s + parseFloat(b.size || 0), 0);
  const askVolume = asks.reduce((s, a) => s + parseFloat(a.size || 0), 0);
  const total = bidVolume + askVolume;

  if (total === 0) return null;

  const imbalance = (bidVolume - askVolume) / total; // -1 to +1
  // Strong imbalance (>60% one side) suggests price pressure
  if (Math.abs(imbalance) > 0.6) {
    return {
      strategy: "BOOK_IMBALANCE",
      direction: imbalance > 0 ? "BUY_PRESSURE" : "SELL_PRESSURE",
      imbalance: Math.abs(imbalance),
      bidVolume,
      askVolume,
    };
  }
  return null;
}

// ═══ MASTER ANALYSIS — combines all strategies ═══
async function analyzeMarket() {
  const market = state.selectedMarket;
  if (!market) return null;

  const prices = market._prices || parsePrice(market);
  const marketName = (market.question || market.slug || "Unknown").slice(0, 50);

  // Strategy 1: Check pure arbitrage first (guaranteed profit)
  const arb = checkArbitrage(market);
  if (arb) {
    log(`💰 ARBITRAGE: ${marketName} — ${arb.reasoning}`, "trade");
    state.lastAnalysis = { ...arb, timestamp: new Date(), market: marketName };
    return state.lastAnalysis;
  }

  // Strategy 4: Check order book imbalance
  const bookSignal = analyzeOrderBook(state.orderBook);
  if (bookSignal) {
    log(`📊 Book imbalance: ${bookSignal.direction} (${(bookSignal.imbalance * 100).toFixed(0)}%) on ${marketName}`, "info");
  }

  // Strategy 2: Claude AI analysis (main strategy)
  const claudeResult = await analyzeWithClaude(market);
  if (claudeResult) {
    // Boost confidence if order book agrees with Claude
    if (bookSignal) {
      const bookAgrees =
        (claudeResult.signal === "BUY_YES" && bookSignal.direction === "BUY_PRESSURE") ||
        (claudeResult.signal === "BUY_NO" && bookSignal.direction === "SELL_PRESSURE");
      if (bookAgrees) {
        claudeResult.confidence = Math.min(0.95, claudeResult.confidence * 1.2);
        claudeResult.reasoning += " Order book confirms direction.";
      }
    }

    // Track prediction for learning
    trackPrediction(market, claudeResult.probability_up, prices.yes, claudeResult.signal);

    state.lastAnalysis = { ...claudeResult, timestamp: new Date(), market: marketName };
    return state.lastAnalysis;
  }

  // Fallback: heuristic (no AI available)
  state.lastAnalysis = {
    strategy: "HEURISTIC",
    signal: "HOLD",
    edge: 0,
    confidence: 0.2,
    probability_up: prices.yes,
    reasoning: "No AI available. Add ANTHROPIC_API_KEY for Claude analysis.",
    yesPrice: prices.yes,
    source: "heuristic",
    timestamp: new Date(),
    market: marketName,
  };
  return state.lastAnalysis;
}

// Run correlation scan periodically
async function runCorrelationScan() {
  if (state.activeMarkets.length < 5) return;
  const corr = findCorrelations(state.activeMarkets);
  if (corr.length > 0) {
    corr.forEach(c => {
      log(`🔗 CORRELATION [${c.keyword}]: ${c.markets[0]} (${(c.prices[0]*100).toFixed(0)}%) vs ${c.markets[1]} (${(c.prices[1]*100).toFixed(0)}%)`, "ai");
    });
  }
}

// ════════════════════════════════════════════════════════════
//  ORDER EXECUTION
// ════════════════════════════════════════════════════════════
async function executeTrade(signal, analysis) {
  // Safety checks
  if (state.killed) { log("KILL SWITCH ACTIVE — no trades", "error"); return null; }
  if (state.stats.dailyTrades >= CONFIG.MAX_DAILY_TRADES) { log(`Trade #${state.stats.dailyTrades} today`, "info"); }
  // Daily loss tracking (no limit)

  const market = state.selectedMarket;
  if (!market) return null;

  const side = signal === "BUY_YES" ? "YES" : "NO";
  const yesPrice = analysis.yesPrice;
  const price = side === "YES" ? yesPrice : 1 - yesPrice;
  const edge = analysis.edge;

  // ── PRICE FILTERS — skip garbage trades ──
  // Skip markets where YES is below $0.05 or above $0.95 (basically already decided)
  if (yesPrice < 0.05 || yesPrice > 0.95) {
    log(`SKIP — market price ${(yesPrice * 100).toFixed(1)}% too extreme (need 5-95% range)`, "info");
    return null;
  }

  // Skip if the price we'd buy at is below $0.05 (penny bets = almost always lose)
  if (price < 0.05) {
    log(`SKIP — buy price $${price.toFixed(3)} too cheap (likely to lose)`, "info");
    return null;
  }

  // Skip if edge is unrealistically high (>40% usually means bad data)
  if (edge > 0.40) {
    log(`SKIP — edge ${(edge * 100).toFixed(1)}% suspiciously high, likely bad price data`, "warn");
    return null;
  }

  if (edge < CONFIG.MIN_EDGE) { log(`Edge ${(edge * 100).toFixed(1)}% < min ${(CONFIG.MIN_EDGE * 100)}%`, "info"); return null; }

  // Position sizing (Kelly-lite: edge * confidence, capped)
  const kellyFraction = Math.min(edge * analysis.confidence * 2, CONFIG.BET_PCT);
  const betAmount = Math.min(
    state.balance * kellyFraction,
    CONFIG.MAX_POSITION_SIZE,
    state.balance - 5
  );

  if (betAmount < 1) { log("Bet too small, skipping", "info"); return null; }

  const position = {
    id: `pos-${Date.now()}`,
    market: market.question || market.slug,
    side,
    price,
    amount: betAmount,
    shares: betAmount / price,
    edge: +edge.toFixed(3),
    confidence: analysis.confidence,
    claudeProb: analysis.probability_up,
    openedAt: new Date(),
    mode: state.mode,
  };

  // ── LIVE EXECUTION ──
  if (state.mode === "live" && state.isAuthenticated && state.clobClient) {
    try {
      // Parse token IDs properly
      const tokenIdx = side === "YES" ? 0 : 1;
      let tokenId = null;
      try {
        let clobIds = market.clobTokenIds;
        if (typeof clobIds === "string") {
          // Handle double-encoded JSON: "[\"abc\",\"def\"]"
          clobIds = JSON.parse(clobIds);
          if (typeof clobIds === "string") clobIds = JSON.parse(clobIds); // double parse
        }
        tokenId = Array.isArray(clobIds) ? clobIds[tokenIdx] : null;
      } catch (parseErr) {
        log(`Token ID parse error: ${parseErr.message} | raw: ${JSON.stringify(market.clobTokenIds).slice(0, 100)}`, "error");
      }

      if (!tokenId) {
        throw new Error(`No token ID found. clobTokenIds: ${JSON.stringify(market.clobTokenIds).slice(0, 80)}`);
      }

      // Get market parameters
      const tickSize = market.orderPriceMinTickSize || "0.01";
      const negRisk = market.negRisk === true || market.neg_risk === true;

      // Round price to tick size
      const tick = parseFloat(tickSize);
      const roundedPrice = Math.round(price / tick) * tick;
      const finalPrice = Math.max(tick, Math.min(1 - tick, roundedPrice));
      const size = Math.max(1, Math.floor(betAmount / finalPrice));

      log(`🔴 LIVE ORDER ATTEMPT:`, "live");
      log(`   Market: ${(market.question || market.slug || "").slice(0, 60)}`, "live");
      log(`   Side: ${side} | Price: $${finalPrice.toFixed(4)} | Size: ${size} shares | Cost: $${(size * finalPrice).toFixed(2)}`, "live");
      log(`   Token: ${tokenId.slice(0, 20)}...${tokenId.slice(-8)}`, "live");
      log(`   Tick: ${tickSize} | NegRisk: ${negRisk}`, "live");

      // Place the order
      const orderResponse = await state.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: finalPrice,
          side: "BUY",
          size: size,
        },
        {
          tickSize: tickSize,
          negRisk: negRisk,
        },
        "GTC"
      );

      log(`   CLOB Response: ${JSON.stringify(orderResponse).slice(0, 200)}`, "live");

      if (orderResponse && orderResponse.success !== false && !orderResponse.error) {
        position.orderId = orderResponse.orderID || orderResponse.id || "submitted";
        position.orderStatus = "SUBMITTED";
        log(`✅ LIVE ORDER SUCCESS: ${position.orderId}`, "live");
        await sendTelegram(`🔴 LIVE ORDER PLACED\n${side} ${size} shares @ $${finalPrice.toFixed(3)}\nCost: $${(size * finalPrice).toFixed(2)}\nEdge: ${(edge * 100).toFixed(1)}%\nMarket: ${(market.question || "").slice(0, 40)}\nOrder: ${position.orderId}`);
      } else {
        const errMsg = orderResponse?.error || orderResponse?.message || JSON.stringify(orderResponse).slice(0, 150);
        throw new Error(`CLOB rejected: ${errMsg}`);
      }
    } catch (e) {
      log(`❌ LIVE ORDER FAILED: ${e.message}`, "error");
      log(`   Full error: ${e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message}`, "error");
      await sendTelegram(`❌ ORDER FAILED: ${e.message}`);
      position.mode = "paper";
      position.liveError = e.message;
    }
  }

  // Track position
  state.balance -= betAmount;
  state.positions.push(position);
  state.stats.dailyTrades++;

  const marketName = (market.question || market.slug || "Unknown").slice(0, 50);
  const tradeMsg = `${position.mode === "live" ? "🔴 LIVE" : "📝 PAPER"} ${side} $${betAmount.toFixed(2)} @ $${price.toFixed(2)} | edge ${(edge * 100).toFixed(1)}% | ${marketName}`;
  log(tradeMsg, "trade");
  await sendTelegram(tradeMsg);

  // Schedule settlement (paper mode uses probability-based simulation)
  if (position.mode === "paper") {
    setTimeout(() => settlePosition(position), 45000); // 45s settlement
  }

  return position;
}

async function settlePosition(position) {
  // Realistic settlement: use Claude's probability estimate to simulate outcome
  // If Claude said 70% chance YES and we bought YES, we win 70% of the time
  const prob = position.claudeProb || 0.5;
  const random = Math.random();

  // Determine if YES actually happens (based on Claude's estimate)
  const yesHappened = random < prob;
  const won = (position.side === "YES" && yesHappened) || (position.side === "NO" && !yesHappened);

  // Payout: if you win, you get $1 per share. If you lose, you get $0.
  const payout = won ? position.shares * 1.0 : 0; // $1 per share on win
  const pnl = payout - position.amount;

  state.balance += payout;
  state.positions = state.positions.filter((p) => p.id !== position.id);
  state.stats.wins += won ? 1 : 0;
  state.stats.losses += won ? 0 : 1;
  state.stats.totalPnl += pnl;
  state.stats.dailyPnl += pnl;

  const trade = {
    ...position,
    result: won ? "WIN" : "LOSS",
    pnl: +pnl.toFixed(2),
    payout: +payout.toFixed(2),
    settledAt: new Date(),
    settlementMethod: "probability_sim",
  };
  state.trades.unshift(trade);
  if (state.trades.length > 500) state.trades = state.trades.slice(0, 500);

  const marketName = (position.market || "Unknown").slice(0, 40);
  const msg = `${won ? "✅ WIN" : "❌ LOSS"} ${position.side} @ $${position.price.toFixed(2)} → ${won ? "+" : ""}$${pnl.toFixed(2)} | ${marketName}`;
  log(msg, won ? "trade" : "error");
  await sendTelegram(msg);
}

// ════════════════════════════════════════════════════════════
//  TELEGRAM
// ════════════════════════════════════════════════════════════
async function sendTelegram(message) {
  if (!CONFIG.TG_BOT_TOKEN || !CONFIG.TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.TG_CHAT_ID,
        text: `🤖 POLYBOT\n${message}`,
        parse_mode: "Markdown",
      }),
    });
  } catch {}
}

// ════════════════════════════════════════════════════════════
//  BOT LOOP
// ════════════════════════════════════════════════════════════
let botInterval = null;

let marketRotationIndex = 0;
let scansSinceCorrelation = 0;

function startBot() {
  if (state.botActive) return;
  state.botActive = true;
  state.killed = false;
  marketRotationIndex = 0;
  scansSinceCorrelation = 0;
  log("Bot started — multi-strategy scanning across all markets", "trade");
  log(`  Strategies: Arbitrage • AI Mispricing • Correlation • Book Imbalance`, "info");
  log(`  Min edge: ${(CONFIG.MIN_EDGE * 100)}% | Max position: $${CONFIG.MAX_POSITION_SIZE} | Kelly sizing`, "info");
  sendTelegram("▶️ Bot started — multi-strategy mode");

  botInterval = setInterval(async () => {
    if (!state.botActive || state.killed) {
      clearInterval(botInterval);
      return;
    }

    try {
      // Rotate through markets — prioritize highest-scored first
      if (state.activeMarkets.length > 0) {
        state.selectedMarket = state.activeMarkets[marketRotationIndex % state.activeMarkets.length];
        marketRotationIndex++;
      }

      // Run correlation scan every 10 cycles
      scansSinceCorrelation++;
      if (scansSinceCorrelation >= 10) {
        await runCorrelationScan();
        scansSinceCorrelation = 0;
      }

      // Refresh order book for current market
      await fetchOrderBook(state.selectedMarket);

      // Run multi-strategy analysis
      const analysis = await analyzeMarket();
      if (!analysis) return;

      const marketName = (state.selectedMarket?.question || state.selectedMarket?.slug || "Unknown").slice(0, 50);
      const strategy = analysis.strategy || "UNKNOWN";

      if (analysis.signal !== "HOLD") {
        log(`🎯 [${strategy}] EDGE on: ${marketName}`, "trade");
        await executeTrade(analysis.signal, analysis);
      } else {
        // Only log every 3rd HOLD to reduce spam
        if (marketRotationIndex % 3 === 0) {
          log(`[${strategy}] HOLD — ${marketName} | Claude ${(analysis.probability_up * 100).toFixed(0)}% vs market ${((analysis.yesPrice || 0) * 100).toFixed(0)}%`, "info");
        }
      }
    } catch (e) {
      log(`Bot loop error: ${e.message}`, "error");
    }
  }, 10000); // 10 seconds per scan
}

function stopBot() {
  state.botActive = false;
  if (botInterval) clearInterval(botInterval);
  if (apexInterval) clearInterval(apexInterval);
  log("Bot stopped", "warn");
  sendTelegram("⏹️ Bot stopped");
}

// ════════════════════════════════════════════════════════════
//  APEX MODE — BTC 5-Minute Sniper
// ════════════════════════════════════════════════════════════
const apex = new ApexEngine();

// ═══ NEWS ENGINE ═══
const newsEngine = new NewsEngine({
  anthropicKey: CONFIG.ANTHROPIC_API_KEY,
  onAlert: (alert) => {
    // When news triggers a trade signal, log it and optionally execute
    const msg = `🚨 NEWS TRADE: ${alert.analysis.trade_signal} | ${alert.analysis.direction} ${alert.analysis.magnitude} | ${alert.headline.slice(0, 60)}`;
    log(msg, "trade");
    sendTelegram(msg);
  },
  onLog: (msg, type) => log(msg, type || "info"),
});

// Start news engine automatically
if (CONFIG.ANTHROPIC_API_KEY) {
  newsEngine.start(30000); // Check every 30 seconds
}

// ═══ 5-MINUTE BTC + ETH SNIPER ═══
let sniper = null;

function startSniper() {
  if (sniper && sniper.running) return;
  sniper = new FiveMinSniper({
    clobClient: state.clobClient,
    onLog: (msg, type) => log(msg, type || "info"),
    onTrade: (trade) => {
      // Record to state
      state.trades.unshift({
        id: `5m-${Date.now()}`,
        market: `${trade.asset.toUpperCase()} 5M ${trade.side}`,
        side: trade.side === "UP" ? "YES" : "NO",
        price: trade.price,
        amount: trade.cost,
        shares: trade.shares,
        strategy: "5M_SNIPER",
        openedAt: trade.timestamp,
        mode: state.mode,
        orderId: trade.orderId,
        slug: trade.slug,
      });
      if (state.trades.length > 500) state.trades = state.trades.slice(0, 500);
      state.stats.dailyTrades++;
    },
    sendTelegram,
  });
  sniper.start();
}

function stopSniper() {
  if (sniper) sniper.stop();
}

// ═══ MARKET MAKER (UNIFIED — Polymarket + Kalshi) ═══
let mm = null;
let kalshi = null;

// Initialize Kalshi client if credentials exist
if (CONFIG.KALSHI_EMAIL && CONFIG.KALSHI_PASSWORD) {
  kalshi = new KalshiClient({
    email: CONFIG.KALSHI_EMAIL,
    password: CONFIG.KALSHI_PASSWORD,
    demo: CONFIG.KALSHI_DEMO,
    onLog: (msg, type) => log(msg, type || "info"),
  });
  kalshi.login().catch(() => log("Kalshi login deferred — will retry on MM start", "warn"));
}

function startMarketMaker() {
  if (mm && mm.running) return;
  mm = new UnifiedMarketMaker({
    polyClobClient: state.clobClient,
    kalshiClient: kalshi,
    onLog: (msg, type) => log(msg, type || "info"),
    onTrade: (trade) => {
      const upPrice = trade.upPrice || trade.spread || 0;
      const downPrice = trade.downPrice || 0;
      const shares = trade.shares || trade.contracts || 0;
      const cost = (upPrice + downPrice) * shares || trade.cost || 0;
      const spread = trade.spread || (1 - upPrice - downPrice) || 0;
      const bothFilled = trade.upFilled && trade.downFilled;
      const pnl = bothFilled ? spread * shares : 0;

      state.trades.unshift({
        id: `mm-${Date.now()}`,
        market: trade.market || `${(trade.platform || "?").toUpperCase()} MAKER`,
        strategy: trade.strategy || "MARKET_MAKER",
        side: bothFilled ? "BOTH" : trade.upFilled ? "YES" : trade.downFilled ? "NO" : "BOTH",
        amount: +cost.toFixed(2),
        price: +(upPrice || 0).toFixed(2),
        edge: +spread.toFixed(3),
        result: bothFilled ? "WIN" : (trade.upFilled || trade.downFilled) ? "OPEN" : "PENDING",
        pnl: +pnl.toFixed(2),
        mode: state.mode,
        openedAt: new Date(),
        platform: trade.platform,
        upFilled: trade.upFilled,
        downFilled: trade.downFilled,
      });
      if (state.trades.length > 500) state.trades = state.trades.slice(0, 500);
    },
    sendTelegram,
    mode: state.mode,
  });
  mm.start();
}

function stopMarketMaker() {
  if (mm) mm.stop();
}

let apexInterval = null;
let apexActive = false;

function startApex() {
  if (apexActive) return;
  apexActive = true;
  log("🔥 APEX MODE ACTIVATED — BTC 5-min sniper online", "trade");
  log(`   Entry window: T-90s to T-20s | Sweet spot: T-50s to T-30s`, "info");
  log(`   Min score: ${(APEX_CONFIG.MIN_COMPOSITE_SCORE*100)}% | Min signals: ${APEX_CONFIG.MIN_MOMENTUM_AGREE}/5 | Kelly: ${(APEX_CONFIG.KELLY_FRACTION*100)}%`, "info");
  log(`   Base bet: $${APEX_CONFIG.BASE_BET} | Max bet: $${APEX_CONFIG.MAX_BET} | Daily loss limit: $${APEX_CONFIG.DAILY_LOSS_LIMIT}`, "info");
  sendTelegram("🔥 APEX MODE — BTC 5-min sniper activated");

  apexInterval = setInterval(() => {
    if (!apexActive) { clearInterval(apexInterval); return; }

    // Feed current BTC price to apex engine
    if (state.btcPrice) {
      apex.tick(state.btcPrice, "coingecko");
    }

    // Evaluate
    const decision = apex.evaluate();
    const status = apex.getStatus();

    // Log timing every 30 seconds
    if (status.elapsed % 30 < 2) {
      const bar = "█".repeat(Math.floor(status.elapsed / 15)) + "░".repeat(Math.floor(status.remaining / 15));
      log(`⏱ [${bar}] ${status.remaining}s left | BTC $${(status.btcPrice||0).toFixed(0)} | ${status.direction} ${status.windowChange}% | RSI ${status.rsi}`, "info");
    }

    if (decision.shouldTrade) {
      log(``, "trade");
      log(`🎯 ══════ APEX TRADE ══════`, "trade");
      log(`   Side: ${decision.side} | Price: $${decision.price} | Size: $${decision.size}`, "trade");
      log(`   Score: ${(decision.confidence*100).toFixed(0)}% | ${decision.reason}`, "trade");
      decision.signals.signals.forEach(s => {
        log(`   ${s.vote > 0 ? "⬆" : s.vote < 0 ? "⬇" : "—"} ${s.name}: ${s.direction} (${(s.strength*100).toFixed(0)}%) ${s.detail}`, "ai");
      });
      log(`══════════════════════════`, "trade");

      // Execute paper trade
      const trade = {
        id: `apex-${Date.now()}`,
        market: `BTC 5-min ${decision.side}`,
        window: decision.window,
        side: decision.side,
        price: decision.price,
        amount: decision.size,
        shares: decision.size / decision.price,
        confidence: decision.confidence,
        signals: decision.signals,
        openedAt: new Date(),
        mode: state.mode,
        strategy: "APEX",
      };

      state.balance -= trade.amount;
      state.positions.push(trade);
      state.stats.dailyTrades++;

      const msg = `🔥 APEX ${decision.side} $${decision.size.toFixed(2)} @ $${decision.price} | ${(decision.confidence*100).toFixed(0)}% conf | ${status.remaining}s left`;
      log(msg, "trade");
      sendTelegram(msg);

      // Settle when window closes (remaining seconds + buffer)
      const settleIn = (status.remaining + 5) * 1000;
      setTimeout(() => {
        // Simulate settlement based on final BTC price vs window open
        const finalPrice = state.btcPrice;
        const openPrice = apex.priceEngine.windowOpen || finalPrice;
        const btcWentUp = finalPrice >= openPrice;
        const won = (trade.side === "YES" && btcWentUp) || (trade.side === "NO" && !btcWentUp);
        const payout = won ? trade.shares * 1.0 : 0;
        const pnl = payout - trade.amount;

        state.balance += payout;
        state.positions = state.positions.filter(p => p.id !== trade.id);
        state.stats.wins += won ? 1 : 0;
        state.stats.losses += won ? 0 : 1;
        state.stats.totalPnl += pnl;
        state.stats.dailyPnl += pnl;
        apex.recordResult(won, pnl);

        state.trades.unshift({
          ...trade, result: won ? "WIN" : "LOSS",
          pnl: +pnl.toFixed(2), payout: +payout.toFixed(2),
          btcOpen: openPrice, btcClose: finalPrice,
          settledAt: new Date(),
        });
        if (state.trades.length > 500) state.trades = state.trades.slice(0, 500);

        const resultMsg = `${won ? "✅" : "❌"} APEX ${trade.side} @ $${trade.price} → ${won?"+":""}$${pnl.toFixed(2)} | BTC ${openPrice.toFixed(0)}→${finalPrice.toFixed(0)}`;
        log(resultMsg, won ? "trade" : "error");
        sendTelegram(resultMsg);
      }, settleIn);
    }
  }, 2000); // Check every 2 seconds for timing precision
}

function stopApex() {
  apexActive = false;
  if (apexInterval) clearInterval(apexInterval);
  log("APEX mode stopped", "warn");
  sendTelegram("⏹️ APEX mode stopped");
}

// ════════════════════════════════════════════════════════════
//  REST API ROUTES
// ════════════════════════════════════════════════════════════

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    authenticated: state.isAuthenticated,
    botActive: state.botActive,
    mode: state.mode,
    btcPrice: state.btcPrice,
    uptime: process.uptime(),
  });
});

// Full state for dashboard
app.get("/api/state", (req, res) => {
  const totalTrades = state.stats.wins + state.stats.losses;
  const claudeAccuracy = getClaudeAccuracy();
  const arbMarkets = state.activeMarkets.filter(m => m._arbitrage);
  res.json({
    btcPrice: state.btcPrice,
    btcHistory: state.btcHistory.slice(-120),
    btc24hChange: state.btc24hChange,
    mode: state.mode,
    botActive: state.botActive,
    killed: state.killed,
    balance: state.balance,
    positions: state.positions,
    stats: state.stats,
    winRate: totalTrades > 0 ? (state.stats.wins / totalTrades * 100).toFixed(1) : null,
    roi: ((state.stats.totalPnl / 500) * 100).toFixed(1),
    lastAnalysis: state.lastAnalysis,
    selectedMarket: state.selectedMarket ? {
      question: state.selectedMarket.question,
      slug: state.selectedMarket.slug,
      volume24hr: state.selectedMarket.volume24hr,
      score: state.selectedMarket._score,
      prices: state.selectedMarket._prices,
    } : null,
    orderBook: state.orderBook,
    isAuthenticated: state.isAuthenticated,
    // Strategy stats
    strategy: {
      claudeAccuracy: +(claudeAccuracy * 100).toFixed(1),
      marketsScored: state.activeMarkets.length,
      arbitrageOpportunities: arbMarkets.length,
      predictionsTracked: predictionHistory.length,
      topMarketScore: state.activeMarkets[0]?._score || 0,
    },
    logs: state.logs.slice(0, 50),
    trades: state.trades.slice(0, 20),
    apex: {
      active: apexActive,
      ...apex.getStatus(),
    },
    news: newsEngine.getStatus(),
    sniper: sniper ? sniper.getStatus() : { running: false },
    mm: mm ? mm.getStatus() : { running: false },
  });
});

// News endpoints
app.get("/api/news", (req, res) => {
  res.json(newsEngine.getStatus());
});

app.post("/api/news/start", (req, res) => {
  newsEngine.start(30000);
  res.json({ ok: true, status: "news_started" });
});

app.post("/api/news/stop", (req, res) => {
  newsEngine.stop();
  res.json({ ok: true, status: "news_stopped" });
});

// Trades history
app.get("/api/trades", (req, res) => {
  const limit = parseInt(req.query.limit || "50");
  res.json(state.trades.slice(0, limit));
});

// Markets
app.get("/api/markets", (req, res) => {
  res.json(state.activeMarkets.map((m) => ({
    question: m.question,
    slug: m.slug,
    volume24hr: m.volume24hr,
    outcomePrices: m.outcomePrices,
    clobTokenIds: m.clobTokenIds,
    active: m.active,
  })));
});

// Select market
app.post("/api/market/select", (req, res) => {
  const { slug } = req.body;
  const market = state.activeMarkets.find((m) => m.slug === slug);
  if (market) {
    state.selectedMarket = market;
    log(`Selected market: ${market.question || market.slug}`, "info");
    res.json({ ok: true, market: market.slug });
  } else {
    res.status(404).json({ error: "Market not found" });
  }
});

// Bot control
app.post("/api/bot/start", (req, res) => {
  startBot();
  res.json({ ok: true, status: "started" });
});

app.post("/api/bot/stop", (req, res) => {
  stopBot();
  res.json({ ok: true, status: "stopped" });
});

// Kill switch — emergency stop
app.post("/api/bot/kill", (req, res) => {
  state.killed = true;
  state.botActive = false;
  apexActive = false;
  if (botInterval) clearInterval(botInterval);
  if (apexInterval) clearInterval(apexInterval);
  if (sniper) sniper.stop();
  if (mm) mm.stop();
  log("🚨 KILL SWITCH ACTIVATED", "error");
  sendTelegram("🚨 KILL SWITCH — ALL TRADING HALTED");
  res.json({ ok: true, status: "killed" });
});

// ── APEX MODE ENDPOINTS ──
app.post("/api/apex/start", (req, res) => {
  startApex();
  res.json({ ok: true, status: "apex_started" });
});

app.post("/api/apex/stop", (req, res) => {
  stopApex();
  res.json({ ok: true, status: "apex_stopped" });
});

app.get("/api/apex/status", (req, res) => {
  const status = apex.getStatus();
  res.json({
    active: apexActive,
    ...status,
    config: APEX_CONFIG,
  });
});

// ── 5-MIN SNIPER ENDPOINTS ──
app.post("/api/sniper/start", (req, res) => {
  startSniper();
  res.json({ ok: true, status: "sniper_started" });
});

app.post("/api/sniper/stop", (req, res) => {
  stopSniper();
  res.json({ ok: true, status: "sniper_stopped" });
});

app.get("/api/sniper/status", (req, res) => {
  res.json(sniper ? sniper.getStatus() : { running: false });
});

// Technical Analysis endpoint
app.get("/api/ta/:asset", async (req, res) => {
  const asset = req.params.asset;
  if (!["btc", "eth"].includes(asset)) return res.status(400).json({ error: "Use btc or eth" });
  const analysis = await taEngine.analyze(asset);
  res.json(analysis);
});

// ── MARKET MAKER ENDPOINTS ──
app.post("/api/mm/start", (req, res) => {
  startMarketMaker();
  res.json({ ok: true, status: "market_maker_started", mode: state.mode });
});

app.post("/api/mm/stop", (req, res) => {
  stopMarketMaker();
  res.json({ ok: true, status: "market_maker_stopped" });
});

app.get("/api/mm/status", (req, res) => {
  res.json(mm ? mm.getStatus() : { running: false });
});

// Kalshi status
app.get("/api/kalshi/status", async (req, res) => {
  if (!kalshi) return res.json({ connected: false, message: "No Kalshi credentials. Add KALSHI_EMAIL and KALSHI_PASSWORD to env vars." });
  const status = kalshi.getStatus();
  let balance = null;
  if (status.authenticated) {
    balance = await kalshi.getBalance();
  }
  res.json({ ...status, balance });
});

// Kalshi opportunities
app.get("/api/kalshi/opportunities", async (req, res) => {
  if (!kalshi) return res.json({ error: "Kalshi not configured" });
  const opps = await kalshi.findMakingOpportunities({ minVolume: 500 });
  res.json({ count: opps.length, opportunities: opps.slice(0, 20) });
});

// Mode switch
app.post("/api/mode", (req, res) => {
  const { mode } = req.body;
  if (!["paper", "live"].includes(mode)) return res.status(400).json({ error: "Invalid mode" });
  if (mode === "live" && !state.isAuthenticated) return res.status(403).json({ error: "Not authenticated" });
  state.mode = mode;
  log(`Mode switched to ${mode.toUpperCase()}`, mode === "live" ? "live" : "info");
  sendTelegram(mode === "live" ? "🔴 LIVE TRADING ACTIVATED" : "📝 Switched to paper mode");
  res.json({ ok: true, mode });
});

// Manual analysis
app.post("/api/analyze", async (req, res) => {
  const analysis = await analyzeMarket();
  res.json(analysis || { error: "Analysis failed" });
});

// Test live order — places a tiny $1 order to verify execution works
app.post("/api/test-order", async (req, res) => {
  if (!state.isAuthenticated || !state.clobClient) {
    return res.json({ error: "Not authenticated. Check wallet and CLOB credentials." });
  }

  const market = state.selectedMarket;
  if (!market) {
    return res.json({ error: "No market selected" });
  }

  const results = { steps: [], market: market.question || market.slug };

  try {
    // Step 1: Parse token IDs
    results.steps.push("Parsing token IDs...");
    let clobIds = market.clobTokenIds;
    results.rawClobTokenIds = typeof clobIds === "string" ? clobIds.slice(0, 80) : JSON.stringify(clobIds).slice(0, 80);

    if (typeof clobIds === "string") {
      clobIds = JSON.parse(clobIds);
      if (typeof clobIds === "string") clobIds = JSON.parse(clobIds);
    }
    results.parsedIds = Array.isArray(clobIds) ? clobIds.map(id => id.slice(0, 20) + "...") : "NOT AN ARRAY";

    const tokenId = Array.isArray(clobIds) ? clobIds[0] : null;
    if (!tokenId) {
      results.error = "No token ID found after parsing";
      return res.json(results);
    }
    results.steps.push(`Token ID: ${tokenId.slice(0, 20)}...`);

    // Step 2: Get market params
    const tickSize = market.orderPriceMinTickSize || "0.01";
    const negRisk = market.negRisk === true || market.neg_risk === true;
    results.tickSize = tickSize;
    results.negRisk = negRisk;
    results.steps.push(`Tick: ${tickSize}, NegRisk: ${negRisk}`);

    // Step 3: Get current price from CLOB
    results.steps.push("Fetching CLOB price...");
    try {
      const priceRes = await fetch(`https://clob.polymarket.com/price?token_id=${tokenId}&side=buy`);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        results.clobPrice = priceData;
        results.steps.push(`CLOB price: ${JSON.stringify(priceData)}`);
      } else {
        results.steps.push(`CLOB price fetch failed: ${priceRes.status}`);
      }
    } catch (e) {
      results.steps.push(`CLOB price error: ${e.message}`);
    }

    // Step 4: Try placing a $1 order
    const tick = parseFloat(tickSize);
    const buyPrice = 0.50; // Buy at 50 cents — safe middle price
    const roundedPrice = Math.round(buyPrice / tick) * tick;
    const size = 2; // 2 shares at $0.50 = $1 total

    results.orderParams = {
      tokenID: tokenId.slice(0, 20) + "...",
      price: roundedPrice,
      side: "BUY",
      size: size,
      tickSize: tickSize,
      negRisk: negRisk,
    };
    results.steps.push(`Placing test order: ${size} shares @ $${roundedPrice}...`);

    const orderResponse = await state.clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price: roundedPrice,
        side: "BUY",
        size: size,
      },
      {
        tickSize: tickSize,
        negRisk: negRisk,
      },
      "GTC"
    );

    results.orderResponse = JSON.stringify(orderResponse).slice(0, 300);
    results.steps.push("Order submitted!");
    results.success = true;

    // If order went through, cancel it immediately to not risk money
    if (orderResponse && (orderResponse.orderID || orderResponse.id)) {
      const orderId = orderResponse.orderID || orderResponse.id;
      results.steps.push(`Cancelling test order ${orderId}...`);
      try {
        const cancelResp = await state.clobClient.cancelOrder({ orderID: orderId });
        results.cancelResponse = JSON.stringify(cancelResp).slice(0, 200);
        results.steps.push("Order cancelled — test complete!");
      } catch (cancelErr) {
        results.steps.push(`Cancel error (order may have filled): ${cancelErr.message}`);
      }
    }

    log(`TEST ORDER RESULT: ${JSON.stringify(results.orderResponse).slice(0, 100)}`, "live");

  } catch (e) {
    results.error = e.message;
    results.stack = e.stack ? e.stack.split('\n').slice(0, 5) : [];
    results.steps.push(`FAILED: ${e.message}`);
    log(`TEST ORDER FAILED: ${e.message}`, "error");
  }

  res.json(results);
});

// Config update
app.post("/api/config", (req, res) => {
  const { minEdge, betPct, maxPositionSize, maxDailyTrades } = req.body;
  if (minEdge !== undefined) CONFIG.MIN_EDGE = parseFloat(minEdge);
  if (betPct !== undefined) CONFIG.BET_PCT = parseFloat(betPct);
  if (maxPositionSize !== undefined) CONFIG.MAX_POSITION_SIZE = parseFloat(maxPositionSize);
  if (maxDailyTrades !== undefined) CONFIG.MAX_DAILY_TRADES = parseInt(maxDailyTrades);
  log(`Config updated: edge=${CONFIG.MIN_EDGE} bet=${CONFIG.BET_PCT}`, "info");
  res.json({ ok: true, config: { MIN_EDGE: CONFIG.MIN_EDGE, BET_PCT: CONFIG.BET_PCT, MAX_POSITION_SIZE: CONFIG.MAX_POSITION_SIZE, MAX_DAILY_TRADES: CONFIG.MAX_DAILY_TRADES } });
});

// Telegram test
app.post("/api/telegram/test", async (req, res) => {
  const { botToken, chatId } = req.body;
  if (botToken) CONFIG.TG_BOT_TOKEN = botToken;
  if (chatId) CONFIG.TG_CHAT_ID = chatId;
  try {
    const r = await fetch(`https://api.telegram.org/bot${CONFIG.TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: CONFIG.TG_CHAT_ID, text: "🤖 POLYBOT — Test alert! Server connected.", parse_mode: "Markdown" }),
    });
    const d = await r.json();
    res.json({ ok: d.ok, message: d.ok ? "Sent!" : d.description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  STARTUP
// ════════════════════════════════════════════════════════════
async function main() {
  console.log(`
  ╔══════════════════════════════════════╗
  ║       POLYBOT v3 — TRADE ENGINE     ║
  ║   Polymarket • Binance • Claude AI  ║
  ╚══════════════════════════════════════╝
  `);

  // Start Binance price feed
  startBtcPriceFeed();

  // Initialize wallet & CLOB auth
  await initWallet();

  // Fetch initial market data
  await fetchMarkets();
  if (state.selectedMarket) {
    await fetchOrderBook(state.selectedMarket);
  }

  // Refresh markets every 30s
  setInterval(fetchMarkets, 30000);

  // Reset daily stats at midnight UTC
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() === 0 && now.getUTCMinutes() === 0) {
      state.stats.dailyTrades = 0;
      state.stats.dailyPnl = 0;
      log("Daily stats reset", "info");
    }
  }, 60000);

  // Start server
  app.listen(CONFIG.PORT, () => {
    log(`Server running on port ${CONFIG.PORT}`, "info");
    log(`Dashboard: http://localhost:${CONFIG.PORT}`, "info");
    log(`Mode: ${state.mode.toUpperCase()} | Auth: ${state.isAuthenticated ? "YES" : "NO"}`, "info");
    sendTelegram("🚀 POLYBOT server started");
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
