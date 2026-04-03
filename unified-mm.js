// ════════════════════════════════════════════════════════════════════
//  UNIFIED MARKET MAKER — Polymarket + Kalshi
//  
//  Runs both platforms simultaneously:
//  - Polymarket: BTC/ETH 5-min contracts (crypto, no fees, maker rebate)
//  - Kalshi: Weather, economics, politics (regulated, USD, per-contract fees)
//
//  Same core strategy: buy BOTH sides below combined $1.00, collect spread
//  Platform-specific adjustments for fees and market structure
// ════════════════════════════════════════════════════════════════════

const GAMMA_API = "https://gamma-api.polymarket.com";

const UMM_CONFIG = {
  // Polymarket settings (zero fees + rebate)
  poly: {
    bidUp: 0.45,
    bidDown: 0.45,
    shares: 10,
    minSpread: 0.06,  // Minimum $0.06 profit per pair
  },

  // Kalshi settings (fees eat into spread)
  kalshi: {
    bidYes: 0.42,     // Lower bids to account for $0.07/contract fee
    bidNo: 0.42,
    contracts: 5,
    minSpread: 0.10,  // Need wider spread to cover fees ($0.14 total)
    feePerContract: 0.07,
    categories: ["Economics", "Climate and Weather", "Financials", "Tech"],
  },

  // Global
  maxOpenPairs: 30,
  dailyLossLimit: 100,
  refreshInterval: 10000, // 10 seconds
};

class UnifiedMarketMaker {
  constructor({ polyClobClient, kalshiClient, onLog, onTrade, sendTelegram, mode }) {
    this.polyClobClient = polyClobClient;
    this.kalshiClient = kalshiClient;
    this.onLog = onLog || console.log;
    this.onTrade = onTrade || (() => {});
    this.sendTelegram = sendTelegram || (() => {});
    this.mode = mode || "paper";

    this.running = false;
    this.interval = null;

    // Track orders per platform
    this.polyOrders = {};   // Window-based tracking for 5-min markets
    this.kalshiOrders = {}; // Ticker-based tracking

    // Combined stats
    this.stats = {
      poly: { pairsPlaced: 0, pairsCompleted: 0, partials: 0, profit: 0, rebates: 0 },
      kalshi: { pairsPlaced: 0, pairsCompleted: 0, partials: 0, profit: 0, fees: 0 },
      totalProfit: 0,
      dailyPnl: 0,
      errors: 0,
      lastReset: Date.now(),
    };

    // Current Polymarket window
    this.currentPolyWindow = 0;

    // Kalshi opportunity cache
    this.kalshiOpportunities = [];
    this.lastKalshiScan = 0;
  }

  // ══════════════════════════════
  //  POLYMARKET MARKET MAKING
  //  (5-min BTC/ETH, zero fees)
  // ══════════════════════════════

  getPolyWindow() {
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / 300) * 300;
    return { start, end: start + 300, elapsed: now - start, remaining: start + 300 - now };
  }

  async fetchPolyMarket(asset, timestamp) {
    const slug = `${asset}-updown-5m-${timestamp}`;
    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const res = await fetch(`${GAMMA_API}/events?slug=${slug}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const events = await res.json();
      if (!events.length || !events[0].markets?.length) return null;

      const market = events[0].markets[0];
      let tokenIds = { up: null, down: null };
      try {
        let ids = market.clobTokenIds;
        if (typeof ids === "string") ids = JSON.parse(ids);
        if (typeof ids === "string") ids = JSON.parse(ids);
        if (Array.isArray(ids) && ids.length >= 2) { tokenIds.up = ids[0]; tokenIds.down = ids[1]; }
      } catch {}

      let prices = { up: 0.5, down: 0.5 };
      try {
        let op = market.outcomePrices;
        if (typeof op === "string") op = JSON.parse(op);
        if (Array.isArray(op)) { prices.up = parseFloat(op[0]) || 0.5; prices.down = parseFloat(op[1]) || 0.5; }
      } catch {}

      return { slug, tokenIds, prices, tickSize: market.orderPriceMinTickSize || "0.01", negRisk: market.negRisk === true, acceptingOrders: market.acceptingOrders !== false };
    } catch { return null; }
  }

  async placePolyPair(asset, market) {
    const key = `${asset}-${this.currentPolyWindow}`;
    if (this.polyOrders[key]) return;

    const cfg = UMM_CONFIG.poly;
    const spread = 1 - cfg.bidUp - cfg.bidDown;

    if (spread < cfg.minSpread) return;

    this.onLog(`📊 POLY MM ${asset.toUpperCase()}: UP $${cfg.bidUp} + DOWN $${cfg.bidDown} | Spread: $${spread.toFixed(2)} | ${cfg.shares} shares`, "trade");

    let upResult = null, downResult = null;

    if (this.mode === "live" && this.polyClobClient) {
      // Place real orders on Polymarket
      const tick = parseFloat(market.tickSize) || 0.01;
      try {
        const upRes = await this.polyClobClient.createAndPostOrder(
          { tokenID: market.tokenIds.up, price: Math.round(cfg.bidUp / tick) * tick, side: "BUY", size: cfg.shares },
          { tickSize: market.tickSize, negRisk: market.negRisk }, "GTC"
        );
        upResult = { orderId: upRes?.orderID || upRes?.id, filled: upRes?.status === "matched", price: cfg.bidUp };
        this.onLog(`  POLY UP: ${upResult.filled ? "FILLED ✅" : "POSTED"} ${upResult.orderId || ""}`, "live");
      } catch (e) { this.onLog(`  POLY UP error: ${e.message}`, "error"); this.stats.errors++; }

      try {
        const downRes = await this.polyClobClient.createAndPostOrder(
          { tokenID: market.tokenIds.down, price: Math.round(cfg.bidDown / tick) * tick, side: "BUY", size: cfg.shares },
          { tickSize: market.tickSize, negRisk: market.negRisk }, "GTC"
        );
        downResult = { orderId: downRes?.orderID || downRes?.id, filled: downRes?.status === "matched", price: cfg.bidDown };
        this.onLog(`  POLY DOWN: ${downResult.filled ? "FILLED ✅" : "POSTED"} ${downResult.orderId || ""}`, "live");
      } catch (e) { this.onLog(`  POLY DOWN error: ${e.message}`, "error"); this.stats.errors++; }
    } else {
      // Paper simulation
      const fillProb = cfg.bidUp * 1.4;
      upResult = { orderId: `paper-up-${Date.now()}`, filled: Math.random() < fillProb, price: cfg.bidUp };
      downResult = { orderId: `paper-dn-${Date.now()}`, filled: Math.random() < fillProb, price: cfg.bidDown };
      this.onLog(`  📝 UP: ${upResult.filled ? "FILLED" : "open"} | DOWN: ${downResult.filled ? "FILLED" : "open"}`, "info");
    }

    this.polyOrders[key] = { asset, upResult, downResult, placedAt: Date.now(), settled: false };
    this.stats.poly.pairsPlaced++;

    if (upResult?.filled && downResult?.filled) {
      const profit = spread * cfg.shares;
      const rebate = (cfg.bidUp + cfg.bidDown) * cfg.shares * 0.002; // ~0.2% rebate estimate
      this.stats.poly.pairsCompleted++;
      this.stats.poly.profit += profit;
      this.stats.poly.rebates += rebate;
      this.stats.totalProfit += profit + rebate;
      this.stats.dailyPnl += profit + rebate;
      this.onLog(`💰 POLY PAIR: +$${profit.toFixed(2)} spread + $${rebate.toFixed(3)} rebate | ${asset.toUpperCase()}`, "trade");
      this.polyOrders[key].settled = true;
    } else if (upResult?.filled || downResult?.filled) {
      this.stats.poly.partials++;
    }

    this.onTrade({
      platform: "polymarket",
      strategy: "MM_POLY",
      market: `${asset.toUpperCase()} 5M MAKER`,
      side: "BOTH",
      upFilled: upResult?.filled, downFilled: downResult?.filled,
      upPrice: cfg.bidUp, downPrice: cfg.bidDown,
      spread, shares: cfg.shares, cost: (cfg.bidUp + cfg.bidDown) * cfg.shares,
      mode: this.mode,
    });
  }

  // ══════════════════════════════
  //  KALSHI MARKET MAKING
  //  (Weather, economics, etc)
  // ══════════════════════════════

  async scanKalshiOpportunities() {
    if (!this.kalshiClient || Date.now() - this.lastKalshiScan < 60000) return;
    this.lastKalshiScan = Date.now();

    try {
      this.kalshiOpportunities = await this.kalshiClient.findMakingOpportunities({
        minVolume: 500,
        categories: UMM_CONFIG.kalshi.categories,
      });

      if (this.kalshiOpportunities.length > 0) {
        this.onLog(`🏛 KALSHI: Found ${this.kalshiOpportunities.length} making opportunities`, "info");
        this.kalshiOpportunities.slice(0, 3).forEach(opp => {
          this.onLog(`   ${opp.ticker}: spread $${opp.spread.toFixed(3)} (net $${opp.netSpread.toFixed(3)}) | vol ${opp.volume} | ${opp.title?.slice(0, 40)}`, "ai");
        });
      }
    } catch (e) {
      this.onLog(`Kalshi scan error: ${e.message}`, "error");
    }
  }

  async placeKalshiPair(opp) {
    if (this.kalshiOrders[opp.ticker]) return;

    const cfg = UMM_CONFIG.kalshi;
    const contracts = cfg.contracts;
    const totalFees = cfg.feePerContract * contracts * 2;
    const netProfit = (opp.spread * contracts) - totalFees;

    if (netProfit <= 0) return;

    this.onLog(`🏛 KALSHI MM: ${opp.ticker} | YES $${opp.yesPrice.toFixed(2)} + NO $${opp.noPrice.toFixed(2)} | Spread $${opp.spread.toFixed(3)} | Net $${netProfit.toFixed(2)} after fees`, "trade");

    let yesResult = null, noResult = null;

    if (this.mode === "live" && this.kalshiClient) {
      // Place real orders on Kalshi
      yesResult = await this.kalshiClient.placeOrder({
        ticker: opp.ticker, side: "yes", type: "limit",
        count: contracts, yesPrice: cfg.bidYes,
      });
      noResult = await this.kalshiClient.placeOrder({
        ticker: opp.ticker, side: "no", type: "limit",
        count: contracts, noPrice: cfg.bidNo,
      });

      if (yesResult) this.onLog(`  KALSHI YES: ${yesResult.status} | ${yesResult.orderId}`, "live");
      if (noResult) this.onLog(`  KALSHI NO: ${noResult.status} | ${noResult.orderId}`, "live");
    } else {
      // Paper simulation
      const fillProb = 0.4; // Kalshi fills less often
      yesResult = { orderId: `k-yes-${Date.now()}`, filled: Math.random() < fillProb, price: cfg.bidYes };
      noResult = { orderId: `k-no-${Date.now()}`, filled: Math.random() < fillProb, price: cfg.bidNo };
      this.onLog(`  📝 YES: ${yesResult.filled ? "FILLED" : "open"} | NO: ${noResult.filled ? "FILLED" : "open"}`, "info");
    }

    this.kalshiOrders[opp.ticker] = { opp, yesResult, noResult, placedAt: Date.now(), settled: false };
    this.stats.kalshi.pairsPlaced++;

    if (yesResult?.filled && noResult?.filled) {
      this.stats.kalshi.pairsCompleted++;
      this.stats.kalshi.profit += netProfit;
      this.stats.kalshi.fees += totalFees;
      this.stats.totalProfit += netProfit;
      this.stats.dailyPnl += netProfit;
      this.onLog(`💰 KALSHI PAIR: +$${netProfit.toFixed(2)} (after $${totalFees.toFixed(2)} fees) | ${opp.ticker}`, "trade");
      this.kalshiOrders[opp.ticker].settled = true;
    } else if (yesResult?.filled || noResult?.filled) {
      this.stats.kalshi.partials++;
    }

    this.onTrade({
      platform: "kalshi",
      strategy: "MM_KALSHI",
      market: opp.title || opp.ticker,
      side: "BOTH",
      upFilled: yesResult?.filled, downFilled: noResult?.filled,
      upPrice: cfg.bidYes, downPrice: cfg.bidNo,
      spread: opp.spread, shares: contracts,
      cost: (cfg.bidYes + cfg.bidNo) * contracts,
      mode: this.mode,
    });
  }

  // ══════════════════════════════
  //  MAIN LOOP
  // ══════════════════════════════

  async tick() {
    if (!this.running) return;

    // Daily reset
    if (Date.now() - this.stats.lastReset > 86400000) {
      this.stats.dailyPnl = 0;
      this.stats.lastReset = Date.now();
    }

    // Daily loss limit
    if (this.stats.dailyPnl <= -UMM_CONFIG.dailyLossLimit) return;

    const polyWin = this.getPolyWindow();

    // ── POLYMARKET: 5-min BTC + ETH ──
    if (polyWin.start !== this.currentPolyWindow) {
      this.currentPolyWindow = polyWin.start;

      // Settle previous window's unsettled partial fills
      Object.entries(this.polyOrders).forEach(([key, pair]) => {
        if (pair.settled) return;
        // Simulate partial settlement (50/50 on direction)
        if (pair.upResult?.filled && !pair.downResult?.filled) {
          const won = Math.random() < 0.5;
          const pnl = won ? (1 - pair.upResult.price) * UMM_CONFIG.poly.shares : -pair.upResult.price * UMM_CONFIG.poly.shares;
          this.stats.poly.profit += pnl;
          this.stats.totalProfit += pnl;
          this.stats.dailyPnl += pnl;
          pair.settled = true;
        } else if (pair.downResult?.filled && !pair.upResult?.filled) {
          const won = Math.random() < 0.5;
          const pnl = won ? (1 - pair.downResult.price) * UMM_CONFIG.poly.shares : -pair.downResult.price * UMM_CONFIG.poly.shares;
          this.stats.poly.profit += pnl;
          this.stats.totalProfit += pnl;
          this.stats.dailyPnl += pnl;
          pair.settled = true;
        }
      });

      // Clean old orders
      const keys = Object.keys(this.polyOrders);
      if (keys.length > 100) keys.slice(0, keys.length - 50).forEach(k => delete this.polyOrders[k]);
    }

    // Place Polymarket pairs after 15 seconds into window
    if (polyWin.elapsed >= 15 && polyWin.elapsed <= 240) {
      for (const asset of ["btc", "eth"]) {
        const key = `${asset}-${this.currentPolyWindow}`;
        if (this.polyOrders[key]) continue;

        const market = await this.fetchPolyMarket(asset, this.currentPolyWindow);
        if (!market || !market.tokenIds.up || !market.acceptingOrders) continue;

        await this.placePolyPair(asset, market);
      }
    }

    // ── KALSHI: Scan and trade ──
    if (this.kalshiClient) {
      await this.scanKalshiOpportunities();

      // Place pairs on best opportunities
      for (const opp of this.kalshiOpportunities.slice(0, 5)) {
        if (this.kalshiOrders[opp.ticker]) continue;
        if (opp.netSpread < UMM_CONFIG.kalshi.minSpread) continue;
        await this.placeKalshiPair(opp);
      }
    }

    // Log status every 60 seconds
    if (polyWin.elapsed % 60 < 5) {
      const p = this.stats.poly;
      const k = this.stats.kalshi;
      this.onLog(`💎 MM STATUS | Poly: ${p.pairsCompleted}/${p.pairsPlaced} pairs +$${p.profit.toFixed(2)} | Kalshi: ${k.pairsCompleted}/${k.pairsPlaced} pairs +$${k.profit.toFixed(2)} | Total: $${this.stats.totalProfit.toFixed(2)}`, "trade");
    }
  }

  // ── Start / Stop ──
  start() {
    if (this.running) return;
    this.running = true;
    this.onLog(`💎 UNIFIED MARKET MAKER STARTED — ${this.mode.toUpperCase()}`, "trade");
    this.onLog(`   Polymarket: BTC+ETH 5-min | UP $${UMM_CONFIG.poly.bidUp} + DOWN $${UMM_CONFIG.poly.bidDown}`, "info");
    if (this.kalshiClient) {
      this.onLog(`   Kalshi: ${UMM_CONFIG.kalshi.categories.join(", ")} | YES $${UMM_CONFIG.kalshi.bidYes} + NO $${UMM_CONFIG.kalshi.bidNo}`, "info");
    }
    this.sendTelegram(`💎 Unified Market Maker started — ${this.mode}`);
    this.interval = setInterval(() => this.tick(), UMM_CONFIG.refreshInterval);
    this.tick();
  }

  stop() {
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.onLog(`Market Maker stopped | Total P&L: $${this.stats.totalProfit.toFixed(2)}`, "warn");
    this.sendTelegram(`⏹ MM stopped | P&L: $${this.stats.totalProfit.toFixed(2)}`);
  }

  getStatus() {
    const polyWin = this.getPolyWindow();
    return {
      running: this.running,
      mode: this.mode,
      platforms: {
        polymarket: { active: !!this.polyClobClient, stats: this.stats.poly },
        kalshi: {
          active: !!this.kalshiClient,
          authenticated: this.kalshiClient?.getStatus()?.authenticated || false,
          stats: this.stats.kalshi,
          opportunities: this.kalshiOpportunities.length,
        },
      },
      polyWindow: { elapsed: polyWin.elapsed, remaining: polyWin.remaining },
      stats: this.stats,
      config: UMM_CONFIG,
    };
  }
}

module.exports = { UnifiedMarketMaker, UMM_CONFIG };
