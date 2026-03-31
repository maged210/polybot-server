// ════════════════════════════════════════════════════════════════════
//  NEWS SPEED ENGINE — React to breaking news faster than the market
//
//  THE EDGE: When breaking crypto news drops, Polymarket takes
//  1-8 minutes to fully reprice. This engine:
//  1. Polls multiple news APIs every 30 seconds
//  2. Detects NEW headlines not seen before
//  3. Sends them to Claude for instant impact analysis
//  4. If Claude says a market should move, trades BEFORE the crowd
//
//  Sources: CryptoNews API, CoinGecko news, RSS feeds
// ════════════════════════════════════════════════════════════════════

const NEWS_SOURCES = {
  // CoinGecko status/trending — always free, no key
  COINGECKO_TRENDING: "https://api.coingecko.com/api/v3/search/trending",
  // Free RSS-to-JSON converters for crypto news
  COINDESK_RSS: "https://api.rss2json.com/v1/api.json?rss_url=https://www.coindesk.com/arc/outboundfeeds/rss/",
  COINTELEGRAPH_RSS: "https://api.rss2json.com/v1/api.json?rss_url=https://cointelegraph.com/rss",
  BITCOIN_NEWS_RSS: "https://api.rss2json.com/v1/api.json?rss_url=https://news.bitcoin.com/feed/",
};

// Keywords that signal market-moving news
const IMPACT_KEYWORDS = {
  critical: [
    "hack", "hacked", "exploit", "stolen", "breach", "rug pull",
    "sec lawsuit", "sec charges", "ban", "banned", "crash",
    "etf approved", "etf approval", "etf rejected", "etf denied",
    "halving", "fork", "emergency", "shutdown", "insolvent",
    "bankruptcy", "arrest", "indicted", "fraud",
  ],
  high: [
    "regulation", "regulated", "defi", "whale", "liquidat",
    "billion", "million dollar", "partnership", "acquisition",
    "listing", "delist", "launch", "mainnet", "upgrade",
    "fed rate", "interest rate", "inflation", "cpi", "gdp",
    "tariff", "sanctions", "war", "attack",
  ],
  medium: [
    "bullish", "bearish", "rally", "dump", "surge", "plunge",
    "all-time high", "ath", "support", "resistance", "breakout",
    "volume", "sentiment", "fear", "greed", "adoption",
  ],
};

// Specific coins to track with heightened sensitivity
const TRACKED_COINS = [
  "bitcoin", "btc", "ethereum", "eth", "solana", "sol",
  "xrp", "ripple", "dogecoin", "doge", "cardano", "ada",
  "polygon", "matic", "avalanche", "avax", "chainlink", "link",
];

class NewsEngine {
  constructor(config = {}) {
    this.anthropicKey = config.anthropicKey || "";
    this.seenHeadlines = new Set();
    this.newsHistory = [];
    this.alerts = [];
    this.lastFetch = {};
    this.isRunning = false;
    this.pollInterval = null;
    this.onAlert = config.onAlert || (() => {});
    this.onLog = config.onLog || console.log;

    // Rate limiting
    this.lastClaudeCall = 0;
    this.claudeCooldown = 5000; // 5 seconds between Claude calls

    // Stats
    this.stats = {
      newsChecked: 0,
      newHeadlines: 0,
      alertsTriggered: 0,
      tradesTriggered: 0,
    };
  }

  // ── Start monitoring ──
  start(intervalMs = 30000) {
    if (this.isRunning) return;
    this.isRunning = true;
    this.onLog("📰 News speed engine started — monitoring crypto feeds", "info");
    this.onLog(`   Polling every ${intervalMs / 1000}s | ${Object.keys(NEWS_SOURCES).length} sources | Claude analysis enabled: ${!!this.anthropicKey}`, "info");

    // Initial fetch
    this.checkAllSources();

    // Poll regularly
    this.pollInterval = setInterval(() => this.checkAllSources(), intervalMs);
  }

  stop() {
    this.isRunning = false;
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.onLog("📰 News engine stopped", "warn");
  }

  // ── Check all news sources ──
  async checkAllSources() {
    const allHeadlines = [];

    // Fetch from each source in parallel
    const results = await Promise.allSettled([
      this.fetchRSS(NEWS_SOURCES.COINDESK_RSS, "CoinDesk"),
      this.fetchRSS(NEWS_SOURCES.COINTELEGRAPH_RSS, "CoinTelegraph"),
      this.fetchRSS(NEWS_SOURCES.BITCOIN_NEWS_RSS, "Bitcoin.com"),
    ]);

    results.forEach(r => {
      if (r.status === "fulfilled" && r.value) {
        allHeadlines.push(...r.value);
      }
    });

    this.stats.newsChecked += allHeadlines.length;

    // Filter to NEW headlines only
    const newHeadlines = allHeadlines.filter(h => {
      const key = h.title.toLowerCase().trim().slice(0, 80);
      if (this.seenHeadlines.has(key)) return false;
      this.seenHeadlines.add(key);
      // Keep seen set manageable
      if (this.seenHeadlines.size > 5000) {
        const arr = [...this.seenHeadlines];
        this.seenHeadlines = new Set(arr.slice(-3000));
      }
      return true;
    });

    if (newHeadlines.length === 0) return;

    this.stats.newHeadlines += newHeadlines.length;

    // Score each headline for potential market impact
    const scored = newHeadlines.map(h => ({
      ...h,
      impact: this.scoreImpact(h.title),
    }));

    // Sort by impact score
    scored.sort((a, b) => b.impact.score - a.impact.score);

    // Log new headlines
    scored.slice(0, 5).forEach(h => {
      if (h.impact.score >= 2) {
        this.onLog(`📰 [${h.impact.level}] ${h.title.slice(0, 80)}`, "ai");
      }
    });

    // Send high-impact headlines to Claude for analysis
    const highImpact = scored.filter(h => h.impact.score >= 3);
    if (highImpact.length > 0 && this.anthropicKey) {
      for (const headline of highImpact.slice(0, 3)) {
        await this.analyzeWithClaude(headline);
      }
    }

    // Store history
    this.newsHistory.unshift(...scored.slice(0, 20));
    if (this.newsHistory.length > 200) this.newsHistory = this.newsHistory.slice(0, 200);
  }

  // ── Score headline impact ──
  scoreImpact(title) {
    const lower = title.toLowerCase();
    let score = 0;
    let level = "low";
    const triggers = [];

    // Check critical keywords
    IMPACT_KEYWORDS.critical.forEach(kw => {
      if (lower.includes(kw)) { score += 5; triggers.push(kw); }
    });

    // Check high keywords
    IMPACT_KEYWORDS.high.forEach(kw => {
      if (lower.includes(kw)) { score += 2; triggers.push(kw); }
    });

    // Check medium keywords
    IMPACT_KEYWORDS.medium.forEach(kw => {
      if (lower.includes(kw)) { score += 1; triggers.push(kw); }
    });

    // Boost if mentions tracked coins
    TRACKED_COINS.forEach(coin => {
      if (lower.includes(coin)) { score += 1; }
    });

    if (score >= 5) level = "CRITICAL";
    else if (score >= 3) level = "HIGH";
    else if (score >= 2) level = "MEDIUM";

    return { score, level, triggers };
  }

  // ── Claude analysis of breaking news ──
  async analyzeWithClaude(headline) {
    // Rate limiting
    const now = Date.now();
    if (now - this.lastClaudeCall < this.claudeCooldown) return null;
    this.lastClaudeCall = now;

    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropicKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: `You are a crypto news trading analyst. A breaking headline just dropped. Your job is to determine:
1. Will this move the crypto market? (up, down, or neutral)
2. How much? (magnitude: small <1%, medium 1-3%, large 3%+)
3. How fast? (instant, minutes, hours)
4. Which assets are most affected?
5. Is there a tradeable edge on Polymarket prediction markets?

BREAKING HEADLINE: "${headline.title}"
SOURCE: ${headline.source || "Unknown"}
TIME: ${headline.publishedAt || "Just now"}

Think about which Polymarket crypto markets would be affected. If Bitcoin is likely to go up, markets asking "Will BTC be above $X" should be bought YES. If a hack/exploit headline drops, the affected token's markets should be sold.

Respond ONLY JSON, no markdown:
{"direction":"up"|"down"|"neutral","magnitude":"small"|"medium"|"large","speed":"instant"|"minutes"|"hours","affected_coins":["btc","eth"],"confidence":0.XX,"trade_signal":"BUY_YES"|"BUY_NO"|"HOLD","reasoning":"one sentence","urgency":"trade_now"|"watch"|"ignore"}`,
          }],
        }),
      });

      const data = await res.json();
      const text = data.content?.map(b => b.text || "").join("") || "";
      const analysis = JSON.parse(text.replace(/```json|```/g, "").trim());

      const alert = {
        headline: headline.title,
        source: headline.source,
        impact: headline.impact,
        analysis,
        timestamp: new Date(),
      };

      this.alerts.unshift(alert);
      if (this.alerts.length > 100) this.alerts = this.alerts.slice(0, 100);
      this.stats.alertsTriggered++;

      // Log the analysis
      const emoji = analysis.direction === "up" ? "🟢" : analysis.direction === "down" ? "🔴" : "⚪";
      this.onLog(`${emoji} NEWS IMPACT: ${analysis.direction.toUpperCase()} ${analysis.magnitude} | ${analysis.reasoning}`, "ai");

      if (analysis.urgency === "trade_now" && analysis.confidence >= 0.6) {
        this.onLog(`🚨 TRADE NOW SIGNAL: ${analysis.trade_signal} | conf ${(analysis.confidence * 100).toFixed(0)}% | ${headline.title.slice(0, 60)}`, "trade");
        this.stats.tradesTriggered++;
        // Fire the callback
        this.onAlert(alert);
      }

      return alert;
    } catch (e) {
      this.onLog(`News analysis error: ${e.message}`, "warn");
      return null;
    }
  }

  // ── Fetch from RSS-to-JSON feed ──
  async fetchRSS(url, sourceName) {
    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.items || []).slice(0, 15).map(a => ({
        title: a.title || "",
        source: sourceName,
        url: a.link || a.url || "",
        publishedAt: a.pubDate || a.published || "",
      })).filter(a => a.title.length > 10);
    } catch (e) {
      this.onLog(`News fetch error (${sourceName}): ${e.message}`, "warn");
      return [];
    }
  }

  // ── Get current status ──
  getStatus() {
    return {
      running: this.isRunning,
      stats: this.stats,
      recentAlerts: this.alerts.slice(0, 10),
      recentNews: this.newsHistory.slice(0, 20).map(h => ({
        title: h.title.slice(0, 80),
        source: h.source,
        impact: h.impact?.level || "low",
        score: h.impact?.score || 0,
      })),
      seenCount: this.seenHeadlines.size,
    };
  }
}

module.exports = { NewsEngine };
