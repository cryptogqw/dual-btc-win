/**
 * 衍生品指标服务
 * - 加权资金费率 (Funding Rate annualized)
 * - OI/市值占比 (Open Interest / Market Cap)
 * - 现货 CVD vs 合约 CVD (Cumulative Volume Delta)
 * 
 * 数据源: Binance Futures 公开 API (无需Key)
 */

const FAPI = 'https://fapi.binance.com';
const SPOT = 'https://api.binance.com';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── 资金费率 ───
async function getFundingRate() {
  // 当前费率
  const [current, history] = await Promise.all([
    fetchJSON(`${FAPI}/fapi/v1/premiumIndex?symbol=BTCUSDT`),
    fetchJSON(`${FAPI}/fapi/v1/fundingRate?symbol=BTCUSDT&limit=30`),
  ]);

  const rate = parseFloat(current.lastFundingRate);
  // 年化: rate * 3(次/天) * 365
  const annualized = rate * 3 * 365 * 100;

  // 历史费率 (最近30期=10天)
  const rates = history.map(h => ({
    time: h.fundingTime,
    rate: parseFloat(h.fundingRate),
    annualized: parseFloat(h.fundingRate) * 3 * 365 * 100,
  }));

  const avgRate = rates.reduce((s, r) => s + r.annualized, 0) / rates.length;

  return {
    current: Math.round(rate * 10000) / 10000,       // 原始费率 e.g. 0.0001
    annualized: Math.round(annualized * 100) / 100,   // 年化 % e.g. 10.95
    avg10d: Math.round(avgRate * 100) / 100,
    isExtreme: Math.abs(annualized) > 50,              // >50% 年化视为极端
    isNegative: annualized < -10,                      // 负费率 = 做空情绪浓
    history: rates.slice(-10),
    nextFundingTime: current.nextFundingTime,
  };
}

// ─── 未平仓合约 (OI) ───
async function getOpenInterest(btcPrice) {
  const [oiData, tickerData] = await Promise.all([
    fetchJSON(`${FAPI}/fapi/v1/openInterest?symbol=BTCUSDT`),
    fetchJSON(`${FAPI}/futures/data/openInterestHist?symbol=BTCUSDT&period=1d&limit=30`),
  ]);

  const oiBTC = parseFloat(oiData.openInterest);
  const oiUSD = oiBTC * btcPrice;

  // BTC 流通供应量约 1970 万，粗估市值
  const btcMarketCap = btcPrice * 19_700_000;
  const oiMarketCapRatio = (oiUSD / btcMarketCap) * 100;

  // 历史 OI (计算增速)
  const oiHistory = tickerData.map(d => ({
    time: d.timestamp,
    oi: parseFloat(d.sumOpenInterest),
    oiValue: parseFloat(d.sumOpenInterestValue),
  }));

  // OI 3日增速
  let oiGrowth3d = 0;
  if (oiHistory.length >= 4) {
    const recent = oiHistory[oiHistory.length - 1].oiValue;
    const prev3d = oiHistory[oiHistory.length - 4].oiValue;
    oiGrowth3d = ((recent - prev3d) / prev3d) * 100;
  }

  // 判断 OI/市值是否处于高位 (>3.5% 视为高风险)
  const isHighOI = oiMarketCapRatio > 3.5;

  return {
    oiBTC: Math.round(oiBTC),
    oiUSD: Math.round(oiUSD),
    oiMarketCapRatio: Math.round(oiMarketCapRatio * 100) / 100,
    oiGrowth3d: Math.round(oiGrowth3d * 100) / 100,
    isHighOI,
    history: oiHistory.slice(-14),
  };
}

// ─── 现货 CVD vs 合约 CVD ───
async function getCVD() {
  // 使用最近 4 小时的 1 分钟 K 线的 taker buy/sell 来近似 CVD
  const [spotKlines, futuresKlines] = await Promise.all([
    fetchJSON(`${SPOT}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=48`),  // 4h of 5min
    fetchJSON(`${FAPI}/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=48`),
  ]);

  // CVD = Σ(taker_buy_volume - taker_sell_volume)
  // Binance K线: [open_time, o, h, l, c, volume, close_time, quote_vol, trades, taker_buy_base, taker_buy_quote, ...]
  let spotCVD = 0, futuresCVD = 0;
  const spotCVDSeries = [], futuresCVDSeries = [];

  for (const k of spotKlines) {
    const totalVol = parseFloat(k[5]);
    const takerBuyVol = parseFloat(k[9]);
    const takerSellVol = totalVol - takerBuyVol;
    spotCVD += (takerBuyVol - takerSellVol);
    spotCVDSeries.push({ time: k[0], cvd: spotCVD });
  }

  for (const k of futuresKlines) {
    const totalVol = parseFloat(k[5]);
    const takerBuyVol = parseFloat(k[9]);
    const takerSellVol = totalVol - takerBuyVol;
    futuresCVD += (takerBuyVol - takerSellVol);
    futuresCVDSeries.push({ time: k[0], cvd: futuresCVD });
  }

  // 判断背离: 价格涨但现货CVD跌 = 假突破
  const spotTrend = spotCVD > 0 ? 'buying' : 'selling';
  const futuresTrend = futuresCVD > 0 ? 'buying' : 'selling';

  // 背离检测: 合约推动 vs 现货抛售
  const divergence = (futuresCVD > 0 && spotCVD < 0) ? 'bearish_divergence'
    : (futuresCVD < 0 && spotCVD > 0) ? 'bullish_divergence'
    : 'aligned';

  return {
    spotCVD: Math.round(spotCVD * 100) / 100,
    futuresCVD: Math.round(futuresCVD * 100) / 100,
    spotTrend,
    futuresTrend,
    divergence,
    divergenceLabel: divergence === 'bearish_divergence' ? '⚠ 合约拉盘 + 现货抛售 = 假突破风险'
      : divergence === 'bullish_divergence' ? '现货吸筹 + 合约做空 = 潜在轧空'
      : '现货与合约方向一致',
    window: '4h',
    spotSeries: spotCVDSeries.filter((_, i) => i % 4 === 0), // downsample
    futuresSeries: futuresCVDSeries.filter((_, i) => i % 4 === 0),
  };
}

// ─── 整合 ───
async function fetchAll(btcPrice) {
  console.log('[Derivatives] 拉取衍生品指标...');

  const [funding, oi, cvd] = await Promise.all([
    getFundingRate(),
    getOpenInterest(btcPrice),
    getCVD(),
  ]);

  console.log(`  ✓ 资金费率: 年化 ${funding.annualized}%`);
  console.log(`  ✓ OI/市值: ${oi.oiMarketCapRatio}%, 3日增速 ${oi.oiGrowth3d}%`);
  console.log(`  ✓ CVD: 现货${cvd.spotTrend} / 合约${cvd.futuresTrend} → ${cvd.divergence}`);

  return { funding, oi, cvd };
}

module.exports = { fetchAll };
