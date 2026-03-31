// ════════════════════════════════════════════════════════════════════
//  APEX STRATEGY — BTC 5-Minute Market Sniper
//  
//  THE EDGE (why this works):
//  - Polymarket settles BTC 5-min contracts via Chainlink oracle
//  - Chainlink updates every 10-30 seconds or on 0.5% deviation
//  - By T-30 seconds, the direction is ~85% determined
//  - But Polymarket odds DON'T fully reflect this yet
//  - We place MAKER orders at $0.90-0.95 on the winning side
//  - Zero taker fees + 20% maker rebate = pure edge
//
//  THE MATH:
//  - 288 markets per day (one every 5 minutes)
//  - If we trade 50% of them with 65% win rate at $0.92 avg price:
//    144 trades × 65% = 93 wins × $0.08 profit = $7.44/day
//    144 trades × 35% = 51 losses × $0.92 loss = $46.92/day
//    Net: -$39.48/day (BAD at 65% win rate)
//  
//  - At 75% win rate:
//    144 × 75% = 108 wins × $0.08 = $8.64
//    144 × 25% = 36 losses × $0.92 = $33.12
//    Net: -$24.48 (STILL BAD — this is why most bots lose)
//
//  - THE REAL PLAY: Only trade high-confidence setups (20-30/day)
//    At 70% win rate, $10 per trade, buying at $0.55 avg:
//    21 wins × $4.50 profit = $94.50
//    9 losses × $5.50 loss = $49.50  
//    Net: +$45/day = ~$1,350/month
//
//  THIS IS THE APEX: Trade LESS, only when signals converge.
// ════════════════════════════════════════════════════════════════════

const APEX_CONFIG = {
  // Timing
  ENTRY_WINDOW_START: 210,  // Start looking at T-90 seconds (3:30 into 5:00)
  ENTRY_WINDOW_END: 280,    // Stop entering at T-20 seconds
  SWEET_SPOT: 250,          // T-50 to T-30 is the sweet spot
  
  // Signal thresholds (CONSERVATIVE = profitable)
  MIN_COMPOSITE_SCORE: 0.65,  // Minimum combined signal strength (0-1)
  MIN_MOMENTUM_AGREE: 3,      // At least 3 of 5 momentum signals must agree
  MIN_PRICE_MOVE_PCT: 0.02,   // BTC must have moved at least 0.02% from open
  MAX_PRICE_MOVE_PCT: 0.50,   // Skip if moved too much (reversal risk)
  
  // Position sizing
  BASE_BET: 10,               // $10 base bet
  MAX_BET: 25,                // $25 max per trade
  KELLY_FRACTION: 0.15,       // Use 15% of Kelly (conservative)
  
  // Maker order pricing
  MAKER_BID_OFFSET: 0.03,     // Place bid 3 cents below fair value
  TARGET_BUY_PRICE_MIN: 0.45, // Never buy above this (need room for profit)
  TARGET_BUY_PRICE_MAX: 0.80, // Never buy below this (too risky)
  
  // Risk
  MAX_TRADES_PER_HOUR: 8,     // Cap: don't overtrade
  MAX_CONSECUTIVE_LOSSES: 4,  // Stop after 4 losses in a row
  DAILY_LOSS_LIMIT: 75,       // Stop if down $75 for the day
  
  // Market slug pattern
  SLUG_PREFIX: "btc-updown-5m-",
};

// ════════════════════════════════════════════════════════════
//  MULTI-SOURCE BTC PRICE ENGINE
//  Faster than Chainlink = our edge
// ════════════════════════════════════════════════════════════
class BtcPriceEngine {
  constructor() {
    this.prices = [];          // Tick-by-tick prices
    this.timestamps = [];
    this.sources = {};         // Price by source
    this.currentPrice = null;
    this.windowOpen = null;    // Price at start of current 5-min window
    this.lastUpdate = null;
  }
  
  // Add a price tick from any source
  tick(price, source = "unknown") {
    const now = Date.now();
    this.currentPrice = price;
    this.lastUpdate = now;
    this.sources[source] = { price, time: now };
    this.prices.push(price);
    this.timestamps.push(now);
    
    // Keep last 600 ticks (~5 minutes of data at 2/sec)
    if (this.prices.length > 600) {
      this.prices.shift();
      this.timestamps.shift();
    }
  }
  
  // Set the window open price (start of 5-min contract)
  setWindowOpen(price) {
    this.windowOpen = price;
  }
  
  // Price change from window open
  getWindowChange() {
    if (!this.windowOpen || !this.currentPrice) return 0;
    return (this.currentPrice - this.windowOpen) / this.windowOpen;
  }
  
  // Direction: 1 = up, -1 = down, 0 = flat
  getDirection() {
    const change = this.getWindowChange();
    if (Math.abs(change) < 0.0001) return 0; // Flat (< 0.01%)
    return change > 0 ? 1 : -1;
  }
  
  // Momentum over last N ticks
  getMomentum(ticks = 10) {
    if (this.prices.length < ticks + 1) return 0;
    const recent = this.prices.slice(-ticks);
    const older = this.prices.slice(-(ticks * 2), -ticks);
    if (older.length === 0) return 0;
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    return (recentAvg - olderAvg) / olderAvg;
  }
  
  // Volatility (standard deviation of returns)
  getVolatility(ticks = 30) {
    if (this.prices.length < ticks + 1) return 0;
    const recent = this.prices.slice(-ticks);
    const returns = [];
    for (let i = 1; i < recent.length; i++) {
      returns.push((recent[i] - recent[i-1]) / recent[i-1]);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }
  
  // RSI (Relative Strength Index) — classic momentum oscillator
  getRSI(period = 14) {
    if (this.prices.length < period + 1) return 50;
    const recent = this.prices.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < recent.length; i++) {
      const change = recent[i] - recent[i-1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period || 0.001;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }
  
  // VWAP proxy (Volume-Weighted Average Price approximation)
  // Without real volume, we weight by tick frequency (more ticks = more activity)
  getVWAP(ticks = 30) {
    if (this.prices.length < ticks) return this.currentPrice;
    const recent = this.prices.slice(-ticks);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }
  
  // Price acceleration (is momentum increasing or decreasing?)
  getAcceleration(shortWindow = 5, longWindow = 15) {
    const shortMom = this.getMomentum(shortWindow);
    const longMom = this.getMomentum(longWindow);
    return shortMom - longMom; // Positive = accelerating, Negative = decelerating
  }
  
  // Trend strength (0-1, how consistent is the direction?)
  getTrendStrength(ticks = 20) {
    if (this.prices.length < ticks) return 0;
    const recent = this.prices.slice(-ticks);
    let ups = 0, downs = 0;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > recent[i-1]) ups++;
      else if (recent[i] < recent[i-1]) downs++;
    }
    const total = ups + downs || 1;
    return Math.abs(ups - downs) / total;
  }
}

// ════════════════════════════════════════════════════════════
//  SIGNAL ENGINE — 5 independent signals that vote
// ════════════════════════════════════════════════════════════
class SignalEngine {
  constructor(priceEngine) {
    this.pe = priceEngine;
  }
  
  // Signal 1: RAW MOMENTUM — is price moving up or down?
  signalMomentum() {
    const shortMom = this.pe.getMomentum(5);
    const midMom = this.pe.getMomentum(15);
    const longMom = this.pe.getMomentum(30);
    
    // All three agree = strong signal
    const shortDir = shortMom > 0 ? 1 : -1;
    const midDir = midMom > 0 ? 1 : -1;
    const longDir = longMom > 0 ? 1 : -1;
    
    const agreement = (shortDir + midDir + longDir);
    const strength = Math.min(Math.abs(shortMom) * 1000, 1); // Normalize
    
    return {
      name: "MOMENTUM",
      direction: agreement > 0 ? "UP" : agreement < 0 ? "DOWN" : "NEUTRAL",
      strength,
      vote: agreement > 0 ? 1 : agreement < 0 ? -1 : 0,
      detail: `short=${(shortMom*100).toFixed(3)}% mid=${(midMom*100).toFixed(3)}% long=${(longMom*100).toFixed(3)}%`,
    };
  }
  
  // Signal 2: RSI — oversold/overbought
  signalRSI() {
    const rsi = this.pe.getRSI(14);
    const direction = rsi > 55 ? "UP" : rsi < 45 ? "DOWN" : "NEUTRAL";
    const strength = Math.abs(rsi - 50) / 50; // 0-1
    
    return {
      name: "RSI",
      direction,
      strength,
      vote: direction === "UP" ? 1 : direction === "DOWN" ? -1 : 0,
      detail: `RSI=${rsi.toFixed(1)}`,
    };
  }
  
  // Signal 3: VWAP POSITION — is price above or below average?
  signalVWAP() {
    const vwap = this.pe.getVWAP(30);
    const price = this.pe.currentPrice;
    if (!price || !vwap) return { name: "VWAP", direction: "NEUTRAL", strength: 0, vote: 0, detail: "no data" };
    
    const deviation = (price - vwap) / vwap;
    const direction = deviation > 0.0001 ? "UP" : deviation < -0.0001 ? "DOWN" : "NEUTRAL";
    const strength = Math.min(Math.abs(deviation) * 500, 1);
    
    return {
      name: "VWAP",
      direction,
      strength,
      vote: direction === "UP" ? 1 : direction === "DOWN" ? -1 : 0,
      detail: `price ${deviation > 0 ? "above" : "below"} VWAP by ${(Math.abs(deviation)*100).toFixed(3)}%`,
    };
  }
  
  // Signal 4: ACCELERATION — is momentum increasing?
  signalAcceleration() {
    const accel = this.pe.getAcceleration(5, 15);
    const direction = accel > 0.00001 ? "UP" : accel < -0.00001 ? "DOWN" : "NEUTRAL";
    const strength = Math.min(Math.abs(accel) * 5000, 1);
    
    return {
      name: "ACCEL",
      direction,
      strength,
      vote: direction === "UP" ? 1 : direction === "DOWN" ? -1 : 0,
      detail: `acceleration=${(accel*10000).toFixed(2)}`,
    };
  }
  
  // Signal 5: WINDOW TREND — direction from open to now
  signalWindowTrend() {
    const change = this.pe.getWindowChange();
    const trendStr = this.pe.getTrendStrength(20);
    const direction = change > 0.0002 ? "UP" : change < -0.0002 ? "DOWN" : "NEUTRAL";
    
    return {
      name: "WINDOW",
      direction,
      strength: trendStr,
      vote: direction === "UP" ? 1 : direction === "DOWN" ? -1 : 0,
      detail: `window change=${(change*100).toFixed(3)}% trend=${(trendStr*100).toFixed(0)}%`,
    };
  }
  
  // ═══ COMPOSITE SCORE ═══
  // All 5 signals vote → composite direction + confidence
  getComposite() {
    const signals = [
      this.signalMomentum(),
      this.signalRSI(),
      this.signalVWAP(),
      this.signalAcceleration(),
      this.signalWindowTrend(),
    ];
    
    // Count votes
    const upVotes = signals.filter(s => s.vote === 1).length;
    const downVotes = signals.filter(s => s.vote === -1).length;
    const totalVotes = upVotes + downVotes;
    const agreeCount = Math.max(upVotes, downVotes);
    
    // Direction = majority vote
    const direction = upVotes > downVotes ? "UP" : upVotes < downVotes ? "DOWN" : "NEUTRAL";
    
    // Composite strength = weighted average of agreeing signals
    const agreeingSignals = signals.filter(s => 
      (direction === "UP" && s.vote === 1) || (direction === "DOWN" && s.vote === -1)
    );
    const avgStrength = agreeingSignals.length > 0
      ? agreeingSignals.reduce((s, sig) => s + sig.strength, 0) / agreeingSignals.length
      : 0;
    
    // Composite score: agreement ratio × strength
    const compositeScore = (agreeCount / 5) * avgStrength;
    
    // Volatility check — high vol means less certainty
    const vol = this.pe.getVolatility(30);
    const volPenalty = vol > 0.001 ? 0.8 : vol > 0.0005 ? 0.9 : 1.0;
    
    const finalScore = compositeScore * volPenalty;
    
    return {
      direction,
      score: +finalScore.toFixed(3),
      upVotes,
      downVotes,
      agreeCount,
      avgStrength: +avgStrength.toFixed(3),
      volatility: +(vol * 100).toFixed(4),
      signals,
    };
  }
}

// ════════════════════════════════════════════════════════════
//  WINDOW TRACKER — knows where we are in the 5-min cycle
// ════════════════════════════════════════════════════════════
class WindowTracker {
  constructor() {
    this.currentWindow = null;
    this.windowStart = null;
    this.windowEnd = null;
    this.openPrice = null;
    this.traded = false; // Already traded this window?
  }
  
  // Calculate current 5-min window timestamps
  update() {
    const now = Math.floor(Date.now() / 1000);
    const windowSize = 300; // 5 minutes in seconds
    const windowStart = Math.floor(now / windowSize) * windowSize;
    const windowEnd = windowStart + windowSize;
    
    // New window?
    if (this.windowStart !== windowStart) {
      this.windowStart = windowStart;
      this.windowEnd = windowEnd;
      this.currentWindow = `${APEX_CONFIG.SLUG_PREFIX}${windowStart}`;
      this.openPrice = null;
      this.traded = false;
      return { newWindow: true, slug: this.currentWindow };
    }
    
    return { newWindow: false, slug: this.currentWindow };
  }
  
  // Seconds elapsed in current window
  getElapsed() {
    const now = Math.floor(Date.now() / 1000);
    return now - this.windowStart;
  }
  
  // Seconds remaining
  getRemaining() {
    return 300 - this.getElapsed();
  }
  
  // Are we in the trading window? (last 90 seconds to last 20 seconds)
  isInEntryWindow() {
    const elapsed = this.getElapsed();
    return elapsed >= APEX_CONFIG.ENTRY_WINDOW_START && elapsed <= APEX_CONFIG.ENTRY_WINDOW_END;
  }
  
  // Are we in the sweet spot? (T-50 to T-30)
  isInSweetSpot() {
    const elapsed = this.getElapsed();
    return elapsed >= APEX_CONFIG.SWEET_SPOT && elapsed <= APEX_CONFIG.ENTRY_WINDOW_END;
  }
}

// ════════════════════════════════════════════════════════════
//  APEX DECISION ENGINE
//  Combines all signals into a final trade/no-trade decision
// ════════════════════════════════════════════════════════════
class ApexEngine {
  constructor() {
    this.priceEngine = new BtcPriceEngine();
    this.signalEngine = new SignalEngine(this.priceEngine);
    this.windowTracker = new WindowTracker();
    this.stats = {
      windowsAnalyzed: 0,
      tradesPlaced: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      consecutiveLosses: 0,
      dailyPnl: 0,
      hourlyTrades: 0,
      lastHourReset: Date.now(),
    };
    this.tradeLog = [];
  }
  
  // Feed a price tick
  tick(price, source = "coingecko") {
    this.priceEngine.tick(price, source);
    
    // Track window open price
    const windowInfo = this.windowTracker.update();
    if (windowInfo.newWindow) {
      this.priceEngine.setWindowOpen(price);
      this.windowTracker.openPrice = price;
    }
    
    // Reset hourly trade counter
    if (Date.now() - this.stats.lastHourReset > 3600000) {
      this.stats.hourlyTrades = 0;
      this.stats.lastHourReset = Date.now();
    }
  }
  
  // The main decision: should we trade right now?
  evaluate() {
    const window = this.windowTracker;
    const elapsed = window.getElapsed();
    const remaining = window.getRemaining();
    
    const result = {
      shouldTrade: false,
      side: null,
      confidence: 0,
      price: 0,
      size: 0,
      reason: "",
      signals: null,
      timing: { elapsed, remaining, inWindow: window.isInEntryWindow(), sweetSpot: window.isInSweetSpot() },
      window: window.currentWindow,
    };
    
    // ── GATE 1: Timing ──
    if (!window.isInEntryWindow()) {
      result.reason = `Waiting for entry window (${remaining}s remaining, need < 90s)`;
      return result;
    }
    
    // ── GATE 2: Already traded this window ──
    if (window.traded) {
      result.reason = "Already traded this window";
      return result;
    }
    
    // ── GATE 3: Risk limits ──
    if (this.stats.consecutiveLosses >= APEX_CONFIG.MAX_CONSECUTIVE_LOSSES) {
      result.reason = `Consecutive loss limit (${this.stats.consecutiveLosses}/${APEX_CONFIG.MAX_CONSECUTIVE_LOSSES})`;
      return result;
    }
    if (this.stats.dailyPnl <= -APEX_CONFIG.DAILY_LOSS_LIMIT) {
      result.reason = `Daily loss limit hit ($${this.stats.dailyPnl.toFixed(2)})`;
      return result;
    }
    if (this.stats.hourlyTrades >= APEX_CONFIG.MAX_TRADES_PER_HOUR) {
      result.reason = `Hourly trade limit (${this.stats.hourlyTrades}/${APEX_CONFIG.MAX_TRADES_PER_HOUR})`;
      return result;
    }
    
    // ── GATE 4: Price data quality ──
    if (this.priceEngine.prices.length < 30) {
      result.reason = "Not enough price data yet (need 30+ ticks)";
      return result;
    }
    
    // ── GATE 5: Minimum price movement ──
    const windowChange = Math.abs(this.priceEngine.getWindowChange());
    if (windowChange < APEX_CONFIG.MIN_PRICE_MOVE_PCT / 100) {
      result.reason = `Price too flat (${(windowChange*100).toFixed(3)}% < ${APEX_CONFIG.MIN_PRICE_MOVE_PCT}% min)`;
      return result;
    }
    if (windowChange > APEX_CONFIG.MAX_PRICE_MOVE_PCT / 100) {
      result.reason = `Price moved too much (${(windowChange*100).toFixed(3)}% > ${APEX_CONFIG.MAX_PRICE_MOVE_PCT}% — reversal risk)`;
      return result;
    }
    
    // ── COMPUTE SIGNALS ──
    const composite = this.signalEngine.getComposite();
    result.signals = composite;
    
    // ── GATE 6: Signal agreement ──
    if (composite.agreeCount < APEX_CONFIG.MIN_MOMENTUM_AGREE) {
      result.reason = `Signals disagree (${composite.agreeCount}/5 agree, need ${APEX_CONFIG.MIN_MOMENTUM_AGREE})`;
      return result;
    }
    
    // ── GATE 7: Composite score ──
    if (composite.score < APEX_CONFIG.MIN_COMPOSITE_SCORE) {
      result.reason = `Score too low (${(composite.score*100).toFixed(1)}% < ${(APEX_CONFIG.MIN_COMPOSITE_SCORE*100)}% min)`;
      return result;
    }
    
    // ── GATE 8: Direction must match window trend ──
    const windowDir = this.priceEngine.getDirection();
    const signalDir = composite.direction === "UP" ? 1 : -1;
    if (windowDir !== signalDir) {
      result.reason = `Signal/window direction mismatch (signal=${composite.direction}, window=${windowDir > 0 ? "UP" : "DOWN"})`;
      return result;
    }
    
    // ═══ ALL GATES PASSED — TRADE! ═══
    
    const side = composite.direction === "UP" ? "YES" : "NO";
    
    // Calculate buy price: we want to be a MAKER
    // Fair value ~= 0.5 + (composite.score * 0.4)
    const fairValue = 0.5 + (composite.score * 0.4);
    const buyPrice = Math.max(
      APEX_CONFIG.TARGET_BUY_PRICE_MIN,
      Math.min(APEX_CONFIG.TARGET_BUY_PRICE_MAX, fairValue - APEX_CONFIG.MAKER_BID_OFFSET)
    );
    
    // Kelly position sizing
    const winProb = 0.5 + (composite.score * 0.3); // Estimated win probability
    const payoff = (1 - buyPrice) / buyPrice; // Profit ratio if we win
    const kellyFull = (winProb * payoff - (1 - winProb)) / payoff;
    const kellyBet = Math.max(0, kellyFull * APEX_CONFIG.KELLY_FRACTION);
    
    // Confidence bonus for sweet spot timing
    const timingBonus = window.isInSweetSpot() ? 1.2 : 1.0;
    
    const size = Math.min(
      Math.max(APEX_CONFIG.BASE_BET * kellyBet * timingBonus * 10, APEX_CONFIG.BASE_BET),
      APEX_CONFIG.MAX_BET
    );
    
    result.shouldTrade = true;
    result.side = side;
    result.confidence = +(composite.score * timingBonus).toFixed(3);
    result.price = +buyPrice.toFixed(2);
    result.size = +size.toFixed(2);
    result.reason = `${composite.agreeCount}/5 signals agree ${composite.direction} | score ${(composite.score*100).toFixed(0)}% | ${remaining}s left`;
    
    // Mark window as traded
    window.traded = true;
    this.stats.windowsAnalyzed++;
    
    return result;
  }
  
  // Record trade result
  recordResult(win, pnl) {
    if (win) {
      this.stats.wins++;
      this.stats.consecutiveLosses = 0;
    } else {
      this.stats.losses++;
      this.stats.consecutiveLosses++;
    }
    this.stats.totalPnl += pnl;
    this.stats.dailyPnl += pnl;
    this.stats.tradesPlaced++;
    this.stats.hourlyTrades++;
  }
  
  // Get full status
  getStatus() {
    const window = this.windowTracker;
    return {
      window: window.currentWindow,
      elapsed: window.getElapsed(),
      remaining: window.getRemaining(),
      inEntryWindow: window.isInEntryWindow(),
      sweetSpot: window.isInSweetSpot(),
      traded: window.traded,
      btcPrice: this.priceEngine.currentPrice,
      windowOpen: this.priceEngine.windowOpen,
      windowChange: +(this.priceEngine.getWindowChange() * 100).toFixed(4),
      direction: this.priceEngine.getDirection() > 0 ? "UP" : this.priceEngine.getDirection() < 0 ? "DOWN" : "FLAT",
      momentum: +(this.priceEngine.getMomentum(10) * 100).toFixed(4),
      rsi: +this.priceEngine.getRSI(14).toFixed(1),
      volatility: +(this.priceEngine.getVolatility(30) * 100).toFixed(4),
      trendStrength: +(this.priceEngine.getTrendStrength(20) * 100).toFixed(1),
      tickCount: this.priceEngine.prices.length,
      stats: { ...this.stats, winRate: this.stats.tradesPlaced > 0 ? +((this.stats.wins / this.stats.tradesPlaced) * 100).toFixed(1) : 0 },
    };
  }
}

module.exports = { ApexEngine, BtcPriceEngine, SignalEngine, WindowTracker, APEX_CONFIG };
