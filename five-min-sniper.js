// ════════════════════════════════════════════════════════════════════
//  5-MINUTE CONTRACT SNIPER — BTC & ETH Up/Down Markets
//
//  HOW IT WORKS:
//  1. Every 5 minutes, Polymarket opens a new BTC (and ETH) market
//  2. Slug format: btc-updown-5m-{unix_timestamp} (divisible by 300)
//  3. Resolves UP if price at end >= price at start, else DOWN
//  4. Chainlink oracle settles it automatically
//
//  THE STRATEGY:
//  - Wait until final 60 seconds of the window
//  - By then, BTC price direction is ~85% locked in
//  - Check if Polymarket odds have caught up
//  - If not → place MAKER order on the winning side
//  - Zero taker fees + 20% maker rebate
//
//  288 BTC markets + 288 ETH markets = 576 opportunities per day
// ════════════════════════════════════════════════════════════════════

const WINDOW_SECONDS = 300; // 5 minutes
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const { TechnicalAnalysis } = require("./technical-analysis");

const ASSETS = {
  btc: {
    slug_prefix: "btc-updown-5m",
    event_prefix: "btc-updown-5m",
    price_url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    price_key: "bitcoin",
    name: "BTC",
  },
  eth: {
    slug_prefix: "eth-updown-5m",
    event_prefix: "eth-updown-5m",
    price_url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    price_key: "ethereum",
    name: "ETH",
  },
};

const SNIPER_CONFIG = {
  // When to enter (seconds from window start)
  ENTRY_START: 240,    // Start looking at T-60s (4:00 into 5:00)
  ENTRY_END: 290,      // Stop entering at T-10s
  SWEET_SPOT: 260,     // T-40s to T-20s is ideal

  // Minimum price move to trade (prevent flat-market bets)
  MIN_PRICE_MOVE_PCT: 0.015, // 0.015% minimum

  // Order pricing — be a MAKER
  MAKER_PRICE: 0.90,         // Place limit buy at $0.90 on winning side
  FALLBACK_PRICE: 0.85,      // If $0.90 doesn't fill, try $0.85

  // Position sizing
  BET_SIZE: 5,               // $5 per trade (configurable)
  MIN_SHARES: 5,             // Polymarket minimum is 5 shares

  // Risk
  MAX_TRADES_PER_HOUR: 20,
  MAX_CONSECUTIVE_LOSSES: 6,
};

class FiveMinSniper {
  constructor({ clobClient, onLog, onTrade, sendTelegram }) {
    this.clobClient = clobClient;
    this.onLog = onLog || console.log;
    this.onTrade = onTrade || (() => {});
    this.sendTelegram = sendTelegram || (() => {});

    this.running = false;
    this.interval = null;
    this.ta = new TechnicalAnalysis();

    // Price tracking per asset
    this.prices = {
      btc: { current: null, history: [], windowOpen: null },
      eth: { current: null, history: [], windowOpen: null },
    };

    // Window tracking
    this.currentWindow = { start: 0, end: 0 };
    this.tradedThisWindow = {};  // { "btc-123": true, "eth-456": true }

    // Market cache
    this.marketCache = {}; // { "btc-updown-5m-123": { tokenIds, prices, ... } }

    // Stats
    this.stats = {
      windowsScanned: 0,
      tradesPlaced: 0,
      ordersFilled: 0,
      ordersRejected: 0,
      hourlyTrades: 0,
      consecutiveLosses: 0,
      lastHourReset: Date.now(),
    };
  }

  // ── Get current window timestamps ──
  getWindowInfo() {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
    const windowEnd = windowStart + WINDOW_SECONDS;
    const elapsed = now - windowStart;
    const remaining = windowEnd - now;
    const nextWindowStart = windowEnd;

    return { now, windowStart, windowEnd, elapsed, remaining, nextWindowStart };
  }

  // ── Generate slug for a window ──
  getSlug(asset, timestamp) {
    return `${ASSETS[asset].slug_prefix}-${timestamp}`;
  }

  // ── Fetch market from Gamma API by slug ──
  async fetchMarket(asset, timestamp) {
    const slug = this.getSlug(asset, timestamp);
    const cacheKey = slug;

    // Check cache (valid for 60 seconds)
    if (this.marketCache[cacheKey] && Date.now() - this.marketCache[cacheKey]._fetchedAt < 60000) {
      return this.marketCache[cacheKey];
    }

    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

      // Try event endpoint first
      const eventRes = await fetch(`${GAMMA_API}/events?slug=${slug}`, { signal: AbortSignal.timeout(5000) });
      if (eventRes.ok) {
        const events = await eventRes.json();
        if (events.length > 0 && events[0].markets?.length > 0) {
          const market = events[0].markets[0];
          const result = this.parseMarket(market, asset);
          this.marketCache[cacheKey] = { ...result, _fetchedAt: Date.now() };
          return result;
        }
      }

      // Fallback: try markets endpoint with slug
      const marketRes = await fetch(`${GAMMA_API}/markets?slug=${slug}`, { signal: AbortSignal.timeout(5000) });
      if (marketRes.ok) {
        const markets = await marketRes.json();
        if (markets.length > 0) {
          const result = this.parseMarket(markets[0], asset);
          this.marketCache[cacheKey] = { ...result, _fetchedAt: Date.now() };
          return result;
        }
      }

      return null;
    } catch (e) {
      this.onLog(`5M fetch error (${asset}): ${e.message}`, "warn");
      return null;
    }
  }

  // ── Parse market data ──
  parseMarket(market, asset) {
    let tokenIds = { up: null, down: null };
    try {
      let clobIds = market.clobTokenIds;
      if (typeof clobIds === "string") clobIds = JSON.parse(clobIds);
      if (typeof clobIds === "string") clobIds = JSON.parse(clobIds);
      if (Array.isArray(clobIds) && clobIds.length >= 2) {
        tokenIds.up = clobIds[0];   // YES = UP
        tokenIds.down = clobIds[1]; // NO = DOWN
      }
    } catch {}

    let prices = { up: 0.5, down: 0.5 };
    try {
      let op = market.outcomePrices;
      if (typeof op === "string") op = JSON.parse(op);
      if (Array.isArray(op) && op.length >= 2) {
        prices.up = parseFloat(op[0]) || 0.5;
        prices.down = parseFloat(op[1]) || 0.5;
      }
    } catch {}

    return {
      asset,
      slug: market.slug,
      question: market.question,
      tokenIds,
      prices,
      tickSize: market.orderPriceMinTickSize || "0.01",
      negRisk: market.negRisk === true || market.neg_risk === true,
      enableOrderBook: market.enableOrderBook,
      acceptingOrders: market.acceptingOrders !== false,
      volume: parseFloat(market.volume24hr || 0),
      liquidity: parseFloat(market.liquidity || 0),
    };
  }

  // ── Fetch current asset price ──
  async fetchPrice(asset) {
    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const config = ASSETS[asset];
      const res = await fetch(config.price_url, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const data = await res.json();
        const price = data[config.price_key]?.usd;
        if (price) {
          this.prices[asset].current = price;
          this.prices[asset].history.push({ price, time: Date.now() });
          if (this.prices[asset].history.length > 100) this.prices[asset].history.shift();
          return price;
        }
      }
    } catch {}
    return this.prices[asset].current;
  }

  // ── Determine direction from price data ──
  getDirection(asset) {
    const priceData = this.prices[asset];
    if (!priceData.current || !priceData.windowOpen) return null;

    const change = (priceData.current - priceData.windowOpen) / priceData.windowOpen;
    const changePct = Math.abs(change * 100);

    // Not enough movement
    if (changePct < SNIPER_CONFIG.MIN_PRICE_MOVE_PCT) return null;

    return {
      direction: change >= 0 ? "UP" : "DOWN",
      change,
      changePct,
      openPrice: priceData.windowOpen,
      currentPrice: priceData.current,
    };
  }

  // ── Place order on Polymarket ──
  async placeOrder(market, side, betSize) {
    if (!this.clobClient) {
      this.onLog(`5M: No CLOB client — can't place order`, "error");
      return null;
    }

    const tokenId = side === "UP" ? market.tokenIds.up : market.tokenIds.down;
    if (!tokenId) {
      this.onLog(`5M: No token ID for ${side} on ${market.slug}`, "error");
      return null;
    }

    // Place as MAKER at target price
    const tick = parseFloat(market.tickSize) || 0.01;
    const makerPrice = Math.round(SNIPER_CONFIG.MAKER_PRICE / tick) * tick;
    const shares = Math.max(SNIPER_CONFIG.MIN_SHARES, Math.floor(betSize / makerPrice));

    this.onLog(`🎯 5M ORDER: ${market.asset.toUpperCase()} ${side} | ${shares} shares @ $${makerPrice} | ${market.slug}`, "live");

    try {
      const orderResponse = await this.clobClient.createAndPostOrder(
        {
          tokenID: tokenId,
          price: makerPrice,
          side: "BUY",
          size: shares,
        },
        {
          tickSize: market.tickSize,
          negRisk: market.negRisk,
        },
        "GTC"
      );

      const respStr = JSON.stringify(orderResponse).slice(0, 200);
      this.onLog(`5M CLOB response: ${respStr}`, "live");

      if (orderResponse && orderResponse.success !== false && !orderResponse.error) {
        const orderId = orderResponse.orderID || orderResponse.id || "submitted";
        this.stats.ordersFilled++;
        this.onLog(`✅ 5M ORDER FILLED: ${orderId} | ${market.asset.toUpperCase()} ${side} ${shares}@${makerPrice}`, "live");
        await this.sendTelegram(`🎯 5M TRADE\n${market.asset.toUpperCase()} ${side}\n${shares} shares @ $${makerPrice}\nCost: $${(shares * makerPrice).toFixed(2)}\n${market.slug}`);

        return {
          orderId,
          asset: market.asset,
          side,
          shares,
          price: makerPrice,
          cost: shares * makerPrice,
          slug: market.slug,
          timestamp: new Date(),
        };
      } else {
        const err = orderResponse?.error || orderResponse?.message || respStr;
        this.stats.ordersRejected++;
        this.onLog(`❌ 5M ORDER REJECTED: ${err}`, "error");
        return null;
      }
    } catch (e) {
      this.stats.ordersRejected++;
      this.onLog(`❌ 5M ORDER ERROR: ${e.message}`, "error");
      return null;
    }
  }

  // ── Main loop tick ──
  async tick() {
    if (!this.running) return;

    const win = this.getWindowInfo();

    // Reset hourly counter
    if (Date.now() - this.stats.lastHourReset > 3600000) {
      this.stats.hourlyTrades = 0;
      this.stats.lastHourReset = Date.now();
    }

    // New window? Reset tracking and record open prices
    if (win.windowStart !== this.currentWindow.start) {
      this.currentWindow = { start: win.windowStart, end: win.windowEnd };
      this.tradedThisWindow = {};
      this.stats.windowsScanned++;

      // Fetch prices for window open
      for (const asset of Object.keys(ASSETS)) {
        const price = await this.fetchPrice(asset);
        if (price) {
          this.prices[asset].windowOpen = price;
        }
      }

      this.onLog(`⏱ New 5M window: ${win.windowStart} | BTC open: $${this.prices.btc.windowOpen?.toFixed(0) || "?"} | ETH open: $${this.prices.eth.windowOpen?.toFixed(0) || "?"}`, "info");
    }

    // Update prices every tick
    for (const asset of Object.keys(ASSETS)) {
      await this.fetchPrice(asset);
    }

    // Are we in the entry window?
    if (win.elapsed < SNIPER_CONFIG.ENTRY_START || win.elapsed > SNIPER_CONFIG.ENTRY_END) {
      // Log countdown every 30 seconds
      if (win.elapsed % 30 < 3) {
        this.onLog(`⏱ 5M: ${win.remaining}s remaining | BTC $${this.prices.btc.current?.toFixed(0) || "?"} | ETH $${this.prices.eth.current?.toFixed(0) || "?"}`, "info");
      }
      return;
    }

    // Risk checks
    if (this.stats.hourlyTrades >= SNIPER_CONFIG.MAX_TRADES_PER_HOUR) return;
    if (this.stats.consecutiveLosses >= SNIPER_CONFIG.MAX_CONSECUTIVE_LOSSES) {
      this.onLog(`5M: Consecutive loss limit — pausing`, "warn");
      return;
    }

    // ── TRADE EACH ASSET ──
    for (const asset of Object.keys(ASSETS)) {
      const windowKey = `${asset}-${win.windowStart}`;
      if (this.tradedThisWindow[windowKey]) continue;

      // Run full technical analysis
      const ta = await this.ta.analyze(asset);
      if (!ta || ta.signal === "NEUTRAL") {
        if (win.elapsed > 250 && win.elapsed < 255) {
          this.onLog(`5M TA ${asset.toUpperCase()}: NEUTRAL — ${ta?.details?.join(' | ') || 'no data'}`, "info");
        }
        continue;
      }

      // Need at least 50% confidence (3+ indicators agree)
      if (ta.confidence < 0.5) {
        this.onLog(`5M TA ${asset.toUpperCase()}: ${ta.signal} but low conf ${(ta.confidence*100).toFixed(0)}% — skipping`, "info");
        continue;
      }

      // Fetch the market
      const market = await this.fetchMarket(asset, win.windowStart);
      if (!market || !market.tokenIds.up || !market.acceptingOrders) {
        if (win.elapsed > 250 && win.elapsed < 255) {
          this.onLog(`5M: ${asset.toUpperCase()} market not found for window ${win.windowStart}`, "warn");
        }
        continue;
      }

      // Check if market price is lagging (our edge)
      const marketProbUp = market.prices.up;
      const trueProb = ta.signal === "UP" ? 0.5 + (ta.confidence * 0.35) : 0.5 - (ta.confidence * 0.35);
      const edge = ta.signal === "UP"
        ? trueProb - marketProbUp
        : (1 - trueProb) - market.prices.down;

      this.onLog(`🔍 5M TA ${asset.toUpperCase()}: ${ta.signal} ${(ta.confidence*100).toFixed(0)}% conf | ${ta.details.join(' | ')}`, "ai");
      this.onLog(`   Market: UP ${(marketProbUp*100).toFixed(0)}% | TA est: ${(trueProb*100).toFixed(0)}% | Edge: ${(edge*100).toFixed(1)}% | RSI ${ta.indicators.rsi} | MACD ${ta.indicators.macd.crossover}`, "ai");

      // Only trade if there's meaningful edge
      if (edge < 0.05) {
        this.onLog(`5M: Edge too small (${(edge*100).toFixed(1)}%), skipping`, "info");
        continue;
      }

      // Place the order
      this.tradedThisWindow[windowKey] = true;
      this.stats.tradesPlaced++;
      this.stats.hourlyTrades++;

      const result = await this.placeOrder(market, ta.signal, SNIPER_CONFIG.BET_SIZE);
      if (result) {
        result.ta = ta; // Attach TA data to trade
        this.onTrade(result);
      }
    }
  }

  // ── Start the sniper ──
  start() {
    if (this.running) return;
    this.running = true;
    this.onLog(`🎯 5M SNIPER STARTED — BTC + ETH`, "trade");
    this.onLog(`   Entry window: T-60s to T-10s | Maker price: $${SNIPER_CONFIG.MAKER_PRICE}`, "info");
    this.onLog(`   Bet size: $${SNIPER_CONFIG.BET_SIZE} | Min move: ${SNIPER_CONFIG.MIN_PRICE_MOVE_PCT}%`, "info");
    this.sendTelegram(`🎯 5M Sniper started — BTC + ETH`);

    // Tick every 3 seconds for precision
    this.interval = setInterval(() => this.tick(), 3000);
    this.tick(); // Immediate first tick
  }

  // ── Stop ──
  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.onLog(`5M SNIPER STOPPED`, "warn");
    this.sendTelegram(`⏹ 5M Sniper stopped`);
  }

  // ── Status ──
  getStatus() {
    const win = this.getWindowInfo();
    return {
      running: this.running,
      window: {
        start: this.currentWindow.start,
        end: this.currentWindow.end,
        elapsed: win.elapsed,
        remaining: win.remaining,
        inEntryWindow: win.elapsed >= SNIPER_CONFIG.ENTRY_START && win.elapsed <= SNIPER_CONFIG.ENTRY_END,
      },
      prices: {
        btc: { current: this.prices.btc.current, windowOpen: this.prices.btc.windowOpen },
        eth: { current: this.prices.eth.current, windowOpen: this.prices.eth.windowOpen },
      },
      stats: this.stats,
      tradedThisWindow: Object.keys(this.tradedThisWindow),
      config: SNIPER_CONFIG,
    };
  }
}

module.exports = { FiveMinSniper, SNIPER_CONFIG, ASSETS };
