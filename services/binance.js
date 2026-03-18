/**
 * Binance 公开 API 服务
 * 获取: BTC价格、K线数据、计算 ATR / BB / ADX
 * 文档: https://binance-docs.github.io/apidocs/spot/en/
 * 
 * 无需 API Key，完全免费
 */

const BASE = 'https://api.binance.com';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── 当前价格 & 24h 变动 ───
async function getPrice() {
  const data = await fetchJSON(`${BASE}/api/v3/ticker/24hr?symbol=BTCUSDT`);
  return {
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChangePercent),
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
    volume24h: parseFloat(data.quoteVolume),
  };
}

// ─── K线数据 ───
async function getKlines(interval = '1d', limit = 100) {
  const data = await fetchJSON(
    `${BASE}/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
  );
  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

// ─── 技术指标计算 ───

/** ATR (Average True Range) */
function calcATR(klines, period = 14) {
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevClose = klines[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trs.push(tr);
  }

  // Wilder's smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }

  const lastPrice = klines[klines.length - 1].close;
  return {
    value: Math.round(atr * 100) / 100,
    pct: Math.round((atr / lastPrice) * 10000) / 100,
    safe15x: Math.round((atr / lastPrice) * 1.5 * 10000) / 100,
  };
}

/** 布林带 (Bollinger Bands) */
function calcBB(klines, period = 20, mult = 2) {
  const closes = klines.map(k => k.close);
  const recent = closes.slice(-period);
  const mean = recent.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(recent.reduce((s, p) => s + (p - mean) ** 2, 0) / period);

  const upper = mean + mult * std;
  const lower = mean - mult * std;
  const width = ((upper - lower) / mean) * 100;

  // 计算过去 90 根 K 线的 BB 宽度，用于判断百分位
  const widths = [];
  for (let i = period; i <= closes.length; i++) {
    const slice = closes.slice(i - period, i);
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const s = Math.sqrt(slice.reduce((sum, p) => sum + (p - m) ** 2, 0) / period);
    widths.push(((m + mult * s) - (m - mult * s)) / m * 100);
  }

  const sorted = [...widths].sort((a, b) => a - b);
  const rank = sorted.findIndex(w => w >= width);
  const percentile = Math.round((rank / sorted.length) * 100);

  return {
    upper: Math.round(upper * 100) / 100,
    lower: Math.round(lower * 100) / 100,
    middle: Math.round(mean * 100) / 100,
    width: Math.round(width * 100) / 100,
    squeeze: percentile < 15,        // 低于 15% 分位视为极度收敛
    percentile,
  };
}

/** ADX (Average Directional Index) */
function calcADX(klines, period = 14) {
  const plusDMs = [];
  const minusDMs = [];
  const trs = [];

  for (let i = 1; i < klines.length; i++) {
    const high = klines[i].high;
    const low = klines[i].low;
    const prevHigh = klines[i - 1].high;
    const prevLow = klines[i - 1].low;
    const prevClose = klines[i - 1].close;

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // Wilder smoothing
  const smooth = (arr, p) => {
    let val = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const result = [val];
    for (let i = p; i < arr.length; i++) {
      val = val - val / p + arr[i];
      result.push(val);
    }
    return result;
  };

  const smoothTR = smooth(trs, period);
  const smoothPlusDM = smooth(plusDMs, period);
  const smoothMinusDM = smooth(minusDMs, period);

  const diPlus = [];
  const diMinus = [];
  const dx = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const mdi = (smoothMinusDM[i] / smoothTR[i]) * 100;
    diPlus.push(pdi);
    diMinus.push(mdi);
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  // ADX = smoothed DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  // 判断 ADX 趋势方向（对比 5 根前）
  const prevADXApprox = dx.length > 5
    ? dx.slice(-10, -5).reduce((a, b) => a + b, 0) / 5
    : adx;

  return {
    value: Math.round(adx * 100) / 100,
    trend: adx > prevADXApprox ? 'rising' : 'flat',
    di_plus: Math.round(diPlus[diPlus.length - 1] * 100) / 100,
    di_minus: Math.round(diMinus[diMinus.length - 1] * 100) / 100,
  };
}

/** 分形高低点 (Fractal Levels) */
function calcFractalLevels(klines, currentPrice) {
  // 在 K 线中寻找分形高/低点（前后各 2 根 K 线）
  const findFractals = (data) => {
    const highs = [];
    const lows = [];

    for (let i = 2; i < data.length - 2; i++) {
      // 分形高点
      if (
        data[i].high > data[i - 1].high &&
        data[i].high > data[i - 2].high &&
        data[i].high > data[i + 1].high &&
        data[i].high > data[i + 2].high
      ) {
        highs.push({ price: data[i].high, index: i });
      }
      // 分形低点
      if (
        data[i].low < data[i - 1].low &&
        data[i].low < data[i - 2].low &&
        data[i].low < data[i + 1].low &&
        data[i].low < data[i + 2].low
      ) {
        lows.push({ price: data[i].low, index: i });
      }
    }

    return { highs, lows };
  };

  const fractals = findFractals(klines);

  // 取最近的几个分形点，按距离现价排序
  const resistances = fractals.highs
    .filter(f => f.price > currentPrice)
    .sort((a, b) => a.price - b.price)
    .slice(0, 3)
    .map((f, i) => ({
      price: Math.round(f.price * 100) / 100,
      tf: i === 0 ? '近端' : i === 1 ? '中端' : '远端',
      pct: Math.round(((f.price - currentPrice) / currentPrice) * 10000) / 100,
    }));

  const supports = fractals.lows
    .filter(f => f.price < currentPrice)
    .sort((a, b) => b.price - a.price)
    .slice(0, 3)
    .map((f, i) => ({
      price: Math.round(f.price * 100) / 100,
      tf: i === 0 ? '近端' : i === 1 ? '中端' : '远端',
      pct: Math.round(((f.price - currentPrice) / currentPrice) * 10000) / 100,
    }));

  return { resistances, supports };
}

// ─── 整合拉取 ───
async function fetchAll() {
  console.log('[Binance] 拉取数据...');

  const [priceData, dailyKlines, h4Klines] = await Promise.all([
    getPrice(),
    getKlines('1d', 100),
    getKlines('4h', 200),
  ]);

  const currentPrice = priceData.price;

  return {
    price: priceData,
    technicals: {
      atr: calcATR(dailyKlines),
      bb: calcBB(dailyKlines),
      adx: calcADX(dailyKlines),
    },
    fractals: calcFractalLevels(dailyKlines, currentPrice),
  };
}

module.exports = { fetchAll };
