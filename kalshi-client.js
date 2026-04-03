// ════════════════════════════════════════════════════════════════════
//  KALSHI API CLIENT
//  CFTC-regulated prediction market — USD accounts, no crypto needed
//
//  API: https://docs.kalshi.com
//  Base URL: https://api.elections.kalshi.com/trade-api/v2
//  Demo URL: https://demo-api.kalshi.com/trade-api/v2
//
//  Auth: Email + Password → JWT token
//  Funding: Bank transfer, wire, debit card (USD)
//  Fees: Up to $0.07 per contract
// ════════════════════════════════════════════════════════════════════

const KALSHI_CONFIG = {
  PROD_URL: "https://api.elections.kalshi.com/trade-api/v2",
  DEMO_URL: "https://demo-api.kalshi.com/trade-api/v2",
};

class KalshiClient {
  constructor({ email, password, apiKey, privateKey, demo = true, onLog }) {
    this.email = email || "";
    this.password = password || "";
    this.apiKey = apiKey || "";
    this.privateKey = privateKey || "";
    this.demo = demo;
    this.baseUrl = demo ? KALSHI_CONFIG.DEMO_URL : KALSHI_CONFIG.PROD_URL;
    this.token = null;
    this.memberId = null;
    this.onLog = onLog || console.log;
    this.lastAuth = 0;
    this.tokenExpiry = 0;
  }

  // ── Authentication ──
  async login() {
    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const res = await fetch(`${this.baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: this.email, password: this.password }),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Login failed ${res.status}: ${err}`);
      }

      const data = await res.json();
      this.token = data.token;
      this.memberId = data.member_id;
      this.lastAuth = Date.now();
      this.tokenExpiry = Date.now() + 3600000; // 1 hour

      this.onLog(`Kalshi auth OK — member: ${this.memberId} | ${this.demo ? "DEMO" : "PROD"}`, "trade");
      return true;
    } catch (e) {
      this.onLog(`Kalshi login error: ${e.message}`, "error");
      return false;
    }
  }

  // ── Ensure authenticated ──
  async ensureAuth() {
    if (!this.token || Date.now() > this.tokenExpiry - 60000) {
      return await this.login();
    }
    return true;
  }

  // ── API request helper ──
  async request(method, path, body = null) {
    if (!await this.ensureAuth()) return null;

    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const opts = {
        method,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.token}`,
        },
        signal: AbortSignal.timeout(8000),
      };
      if (body) opts.body = JSON.stringify(body);

      const res = await fetch(`${this.baseUrl}${path}`, opts);
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Kalshi API ${res.status}: ${errText.slice(0, 150)}`);
      }
      return await res.json();
    } catch (e) {
      this.onLog(`Kalshi API error (${method} ${path}): ${e.message}`, "error");
      return null;
    }
  }

  // ══════════════════════════════
  //  MARKET DATA
  // ══════════════════════════════

  // Get account balance (in cents)
  async getBalance() {
    const data = await this.request("GET", "/portfolio/balance");
    if (!data) return null;
    return {
      balance: (data.balance || 0) / 100, // Convert cents to dollars
      available: (data.payout || data.available_balance || 0) / 100,
    };
  }

  // Get events (top level — each event has multiple markets)
  async getEvents({ limit = 20, status = "open", cursor = null, seriesTicker = null } = {}) {
    let url = `/events?limit=${limit}&status=${status}`;
    if (cursor) url += `&cursor=${cursor}`;
    if (seriesTicker) url += `&series_ticker=${seriesTicker}`;
    return await this.request("GET", url);
  }

  // Get markets for an event
  async getMarkets({ eventTicker, limit = 50, cursor = null, status = "open" } = {}) {
    let url = `/markets?limit=${limit}&status=${status}`;
    if (eventTicker) url += `&event_ticker=${eventTicker}`;
    if (cursor) url += `&cursor=${cursor}`;
    return await this.request("GET", url);
  }

  // Get single market details
  async getMarket(ticker) {
    return await this.request("GET", `/markets/${ticker}`);
  }

  // Get order book
  async getOrderBook(ticker, depth = 10) {
    return await this.request("GET", `/markets/${ticker}/orderbook?depth=${depth}`);
  }

  // Get candlestick data
  async getCandlesticks(seriesTicker, ticker, { periodInterval = 5, startTs, endTs } = {}) {
    let url = `/series/${seriesTicker}/markets/${ticker}/candlesticks?period_interval=${periodInterval}`;
    if (startTs) url += `&start_ts=${startTs}`;
    if (endTs) url += `&end_ts=${endTs}`;
    return await this.request("GET", url);
  }

  // ══════════════════════════════
  //  TRADING
  // ══════════════════════════════

  // Place an order
  async placeOrder({ ticker, side, type = "limit", count = 1, yesPrice = null, noPrice = null, expiration = null }) {
    // Kalshi prices are in cents (1-99)
    const body = {
      ticker,
      action: "buy",
      side, // "yes" or "no"
      type, // "limit" or "market"
      count, // Number of contracts
    };

    if (type === "limit") {
      if (side === "yes" && yesPrice) body.yes_price = Math.round(yesPrice * 100); // Convert to cents
      if (side === "no" && noPrice) body.no_price = Math.round(noPrice * 100);
    }

    if (expiration) body.expiration_ts = expiration;

    const data = await this.request("POST", "/portfolio/orders", body);
    if (data && data.order) {
      return {
        orderId: data.order.order_id,
        ticker: data.order.ticker,
        side: data.order.side,
        status: data.order.status,
        price: (data.order.yes_price || data.order.no_price || 0) / 100,
        count: data.order.count || count,
        filledCount: data.order.remaining_count ? count - data.order.remaining_count : 0,
      };
    }
    return null;
  }

  // Cancel an order
  async cancelOrder(orderId) {
    return await this.request("DELETE", `/portfolio/orders/${orderId}`);
  }

  // Get open orders
  async getOrders({ ticker = null, status = "resting" } = {}) {
    let url = `/portfolio/orders?status=${status}`;
    if (ticker) url += `&ticker=${ticker}`;
    return await this.request("GET", url);
  }

  // Get positions
  async getPositions({ limit = 100, cursor = null, eventTicker = null } = {}) {
    let url = `/portfolio/positions?limit=${limit}&settlement_status=unsettled`;
    if (cursor) url += `&cursor=${cursor}`;
    if (eventTicker) url += `&event_ticker=${eventTicker}`;
    return await this.request("GET", url);
  }

  // Get trade history
  async getTrades({ limit = 50, cursor = null, ticker = null } = {}) {
    let url = `/portfolio/fills?limit=${limit}`;
    if (cursor) url += `&cursor=${cursor}`;
    if (ticker) url += `&ticker=${ticker}`;
    return await this.request("GET", url);
  }

  // ══════════════════════════════
  //  MARKET DISCOVERY
  // ══════════════════════════════

  // Find high-volume markets suitable for market making
  async findMakingOpportunities({ minVolume = 1000, categories = [] } = {}) {
    const opportunities = [];

    try {
      const eventsData = await this.getEvents({ limit: 50, status: "open" });
      if (!eventsData || !eventsData.events) return opportunities;

      for (const event of eventsData.events) {
        // Filter by category if specified
        if (categories.length > 0 && !categories.includes(event.category)) continue;

        const marketsData = await this.getMarkets({ eventTicker: event.event_ticker, limit: 20 });
        if (!marketsData || !marketsData.markets) continue;

        for (const market of marketsData.markets) {
          if (market.status !== "open") continue;

          const volume = market.volume_24h || market.volume || 0;
          const yesPrice = (market.yes_bid || 0) / 100;
          const noPrice = (market.no_bid || 0) / 100;
          const yesAsk = (market.yes_ask || 0) / 100;
          const noAsk = (market.no_ask || 0) / 100;

          // Check if there's a viable spread
          const combinedBid = yesPrice + noPrice;
          const spread = 1 - combinedBid;

          // Fee per contract on Kalshi (up to $0.07)
          const feePerContract = 0.07;
          const netSpread = spread - (feePerContract * 2); // Fees on both sides

          if (netSpread > 0 && volume >= minVolume) {
            opportunities.push({
              event: event.title,
              eventTicker: event.event_ticker,
              ticker: market.ticker,
              title: market.subtitle || market.title || market.ticker,
              yesPrice,
              noPrice,
              yesAsk,
              noAsk,
              spread,
              netSpread,
              volume,
              category: event.category,
              closeTime: market.close_time || market.expiration_time,
            });
          }
        }
      }

      // Sort by net spread (best opportunities first)
      opportunities.sort((a, b) => b.netSpread - a.netSpread);
      return opportunities;
    } catch (e) {
      this.onLog(`Kalshi discovery error: ${e.message}`, "error");
      return opportunities;
    }
  }

  // ══════════════════════════════
  //  STATUS
  // ══════════════════════════════
  getStatus() {
    return {
      authenticated: !!this.token,
      demo: this.demo,
      memberId: this.memberId,
      tokenValid: Date.now() < this.tokenExpiry,
      baseUrl: this.baseUrl,
    };
  }
}

module.exports = { KalshiClient, KALSHI_CONFIG };
