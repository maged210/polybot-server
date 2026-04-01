// ════════════════════════════════════════════════════════════
//  TECHNICAL ANALYSIS ENGINE
//  Fetches real 5-min candles from exchanges
//  Calculates: EMA 9/21, RSI 14, MACD, Bollinger Bands, Momentum
//  Produces composite BUY/SELL signal for 5-min sniper
// ════════════════════════════════════════════════════════════

// CoinCap gives free candle data, no API key, no geo-blocking
const CANDLE_SOURCES = {
  btc: {
    // CoinGecko OHLC (free, no key)
    coingecko: "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=1",
    // Kraken (free, no geo-block)
    kraken: "https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=5",
  },
  eth: {
    coingecko: "https://api.coingecko.com/api/v3/coins/ethereum/ohlc?vs_currency=usd&days=1",
    kraken: "https://api.kraken.com/0/public/OHLC?pair=ETHUSD&interval=5",
  },
};

class TechnicalAnalysis {
  constructor() {
    this.candles = { btc: [], eth: [] };
    this.lastFetch = { btc: 0, eth: 0 };
    this.fetchCooldown = 15000; // 15 seconds between fetches
  }

  // ── Fetch candles from Kraken (free, no key, no geo-block) ──
  async fetchCandles(asset) {
    const now = Date.now();
    if (now - this.lastFetch[asset] < this.fetchCooldown) return this.candles[asset];

    this.lastFetch[asset] = now;

    try {
      const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
      const url = CANDLE_SOURCES[asset].kraken;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Kraken ${res.status}`);
      const data = await res.json();

      // Kraken returns { result: { "XXBTZUSD": [[timestamp, open, high, low, close, vwap, volume, count], ...] } }
      const key = Object.keys(data.result || {}).find(k => k !== "last");
      if (!key) throw new Error("No candle data");

      const raw = data.result[key];
      this.candles[asset] = raw.map(c => ({
        time: c[0] * 1000,
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        vwap: parseFloat(c[5]),
        volume: parseFloat(c[6]),
      }));

      return this.candles[asset];
    } catch (e) {
      // Fallback: try CoinGecko OHLC
      try {
        const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
        const url = CANDLE_SOURCES[asset].coingecko;
        const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return this.candles[asset];
        const data = await res.json();
        // CoinGecko returns [[timestamp, open, high, low, close], ...]
        this.candles[asset] = data.map(c => ({
          time: c[0],
          open: c[1],
          high: c[2],
          low: c[3],
          close: c[4],
          volume: 0,
        }));
        return this.candles[asset];
      } catch {
        return this.candles[asset];
      }
    }
  }

  // ══════════════════════════════
  //  INDICATOR CALCULATIONS
  // ══════════════════════════════

  // Exponential Moving Average
  calcEMA(prices, period) {
    if (prices.length < period) return [];
    const k = 2 / (period + 1);
    const ema = [prices.slice(0, period).reduce((a, b) => a + b, 0) / period];
    for (let i = period; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
    }
    return ema;
  }

  // Simple Moving Average
  calcSMA(prices, period) {
    const sma = [];
    for (let i = period - 1; i < prices.length; i++) {
      const slice = prices.slice(i - period + 1, i + 1);
      sma.push(slice.reduce((a, b) => a + b, 0) / period);
    }
    return sma;
  }

  // RSI (Relative Strength Index)
  calcRSI(prices, period = 14) {
    if (prices.length < period + 1) return { value: 50, history: [] };
    const changes = [];
    for (let i = 1; i < prices.length; i++) {
      changes.push(prices[i] - prices[i - 1]);
    }

    let avgGain = 0, avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    const rsiHistory = [];
    for (let i = period; i < changes.length; i++) {
      avgGain = (avgGain * (period - 1) + Math.max(0, changes[i])) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(0, -changes[i])) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiHistory.push(100 - (100 / (1 + rs)));
    }

    return {
      value: rsiHistory.length > 0 ? rsiHistory[rsiHistory.length - 1] : 50,
      history: rsiHistory,
    };
  }

  // MACD (12, 26, 9)
  calcMACD(prices) {
    const ema12 = this.calcEMA(prices, 12);
    const ema26 = this.calcEMA(prices, 26);

    if (ema12.length === 0 || ema26.length === 0) return { macd: 0, signal: 0, histogram: 0, crossover: "none" };

    // Align arrays (ema26 starts later)
    const offset = ema12.length - ema26.length;
    const macdLine = [];
    for (let i = 0; i < ema26.length; i++) {
      macdLine.push(ema12[i + offset] - ema26[i]);
    }

    const signalLine = this.calcEMA(macdLine, 9);
    if (signalLine.length === 0) return { macd: 0, signal: 0, histogram: 0, crossover: "none" };

    const signalOffset = macdLine.length - signalLine.length;
    const currentMACD = macdLine[macdLine.length - 1];
    const currentSignal = signalLine[signalLine.length - 1];
    const histogram = currentMACD - currentSignal;

    // Detect crossover
    let crossover = "none";
    if (macdLine.length >= 2 && signalLine.length >= 2) {
      const prevMACD = macdLine[macdLine.length - 2];
      const prevSignal = signalLine[signalLine.length - 2];
      if (prevMACD <= prevSignal && currentMACD > currentSignal) crossover = "bullish";
      if (prevMACD >= prevSignal && currentMACD < currentSignal) crossover = "bearish";
    }

    return { macd: currentMACD, signal: currentSignal, histogram, crossover };
  }

  // Bollinger Bands (20, 2)
  calcBollinger(prices, period = 20, stdDev = 2) {
    if (prices.length < period) return { upper: 0, middle: 0, lower: 0, position: 0.5 };

    const recent = prices.slice(-period);
    const middle = recent.reduce((a, b) => a + b, 0) / period;
    const variance = recent.reduce((s, p) => s + (p - middle) ** 2, 0) / period;
    const std = Math.sqrt(variance);

    const upper = middle + stdDev * std;
    const lower = middle - stdDev * std;
    const currentPrice = prices[prices.length - 1];

    // Position within bands (0 = at lower, 1 = at upper)
    const position = (upper - lower) === 0 ? 0.5 : (currentPrice - lower) / (upper - lower);

    return { upper, middle, lower, position: Math.max(0, Math.min(1, position)) };
  }

  // EMA Crossover (9/21)
  calcEMACrossover(prices) {
    const ema9 = this.calcEMA(prices, 9);
    const ema21 = this.calcEMA(prices, 21);

    if (ema9.length < 2 || ema21.length < 2) return { direction: "neutral", strength: 0 };

    const offset = ema9.length - ema21.length;
    const current9 = ema9[ema9.length - 1];
    const current21 = ema21[ema21.length - 1];
    const prev9 = ema9[ema9.length - 2];
    const prev21 = ema21[ema21.length - 2];

    const spread = (current9 - current21) / current21;
    let direction = "neutral";

    if (prev9 <= prev21 && current9 > current21) direction = "bullish_cross";
    else if (prev9 >= prev21 && current9 < current21) direction = "bearish_cross";
    else if (current9 > current21) direction = "bullish";
    else if (current9 < current21) direction = "bearish";

    return { direction, spread, ema9: current9, ema21: current21 };
  }

  // Momentum (Rate of Change)
  calcMomentum(prices, period = 10) {
    if (prices.length < period + 1) return 0;
    const current = prices[prices.length - 1];
    const past = prices[prices.length - 1 - period];
    return (current - past) / past;
  }

  // Volume trend (is volume increasing?)
  calcVolumeTrend(candles, period = 5) {
    if (candles.length < period * 2) return 0;
    const recent = candles.slice(-period);
    const older = candles.slice(-(period * 2), -period);
    const recentAvg = recent.reduce((s, c) => s + c.volume, 0) / period;
    const olderAvg = older.reduce((s, c) => s + c.volume, 0) / period;
    return olderAvg === 0 ? 0 : (recentAvg - olderAvg) / olderAvg;
  }

  // ══════════════════════════════
  //  COMPOSITE SIGNAL
  // ══════════════════════════════
  async analyze(asset) {
    const candles = await this.fetchCandles(asset);
    if (!candles || candles.length < 30) {
      return { signal: "NEUTRAL", confidence: 0, reason: "Not enough candle data", indicators: {} };
    }

    const closes = candles.map(c => c.close);
    const currentPrice = closes[closes.length - 1];

    // Calculate all indicators
    const rsi = this.calcRSI(closes, 14);
    const macd = this.calcMACD(closes);
    const bb = this.calcBollinger(closes, 20, 2);
    const emaCross = this.calcEMACrossover(closes);
    const momentum = this.calcMomentum(closes, 10);
    const volTrend = this.calcVolumeTrend(candles, 5);

    // ── SIGNAL VOTING ──
    // Each indicator votes UP (+1), DOWN (-1), or NEUTRAL (0)
    const votes = [];
    const details = [];

    // 1. EMA 9/21 Crossover
    if (emaCross.direction.includes("bullish")) { votes.push(1); details.push("EMA9>21 ⬆"); }
    else if (emaCross.direction.includes("bearish")) { votes.push(-1); details.push("EMA9<21 ⬇"); }
    else { votes.push(0); details.push("EMA flat"); }

    // 2. RSI
    if (rsi.value > 60) { votes.push(1); details.push(`RSI ${rsi.value.toFixed(0)} ⬆`); }
    else if (rsi.value < 40) { votes.push(-1); details.push(`RSI ${rsi.value.toFixed(0)} ⬇`); }
    else { votes.push(0); details.push(`RSI ${rsi.value.toFixed(0)} neutral`); }

    // 3. MACD
    if (macd.histogram > 0 && macd.crossover === "bullish") { votes.push(1); details.push("MACD bullish cross ⬆"); }
    else if (macd.histogram > 0) { votes.push(1); details.push("MACD positive ⬆"); }
    else if (macd.histogram < 0 && macd.crossover === "bearish") { votes.push(-1); details.push("MACD bearish cross ⬇"); }
    else if (macd.histogram < 0) { votes.push(-1); details.push("MACD negative ⬇"); }
    else { votes.push(0); details.push("MACD flat"); }

    // 4. Bollinger Bands
    if (bb.position > 0.8) { votes.push(-1); details.push(`BB overbought ${(bb.position*100).toFixed(0)}% ⬇`); } // Mean reversion
    else if (bb.position < 0.2) { votes.push(1); details.push(`BB oversold ${(bb.position*100).toFixed(0)}% ⬆`); }
    else if (bb.position > 0.6) { votes.push(1); details.push(`BB upper trend ⬆`); }
    else if (bb.position < 0.4) { votes.push(-1); details.push(`BB lower trend ⬇`); }
    else { votes.push(0); details.push("BB middle"); }

    // 5. Momentum
    if (momentum > 0.001) { votes.push(1); details.push(`Mom +${(momentum*100).toFixed(2)}% ⬆`); }
    else if (momentum < -0.001) { votes.push(-1); details.push(`Mom ${(momentum*100).toFixed(2)}% ⬇`); }
    else { votes.push(0); details.push("Mom flat"); }

    // 6. Volume confirmation
    if (volTrend > 0.2) { votes.push(votes.filter(v => v !== 0).length > 0 ? votes.filter(v => v !== 0)[0] : 0); details.push("Vol rising ⬆ confirms"); }
    else { votes.push(0); details.push(`Vol ${(volTrend*100).toFixed(0)}%`); }

    // Count votes
    const upVotes = votes.filter(v => v > 0).length;
    const downVotes = votes.filter(v => v < 0).length;
    const totalVotes = votes.length;

    // Determine signal
    let signal = "NEUTRAL";
    let confidence = 0;

    if (upVotes >= 4) { signal = "UP"; confidence = upVotes / totalVotes; }
    else if (downVotes >= 4) { signal = "DOWN"; confidence = downVotes / totalVotes; }
    else if (upVotes >= 3 && downVotes <= 1) { signal = "UP"; confidence = (upVotes - downVotes) / totalVotes; }
    else if (downVotes >= 3 && upVotes <= 1) { signal = "DOWN"; confidence = (downVotes - upVotes) / totalVotes; }

    return {
      signal,
      confidence: +confidence.toFixed(2),
      price: currentPrice,
      indicators: {
        rsi: +rsi.value.toFixed(1),
        macd: { histogram: +macd.histogram.toFixed(2), crossover: macd.crossover },
        bollinger: { position: +bb.position.toFixed(2), upper: +bb.upper.toFixed(2), lower: +bb.lower.toFixed(2) },
        ema: emaCross,
        momentum: +(momentum * 100).toFixed(3),
        volumeTrend: +(volTrend * 100).toFixed(1),
      },
      votes: { up: upVotes, down: downVotes, total: totalVotes },
      details,
      candleCount: candles.length,
    };
  }
}

module.exports = { TechnicalAnalysis };
