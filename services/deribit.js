/**
 * Deribit 公开 API 服务
 * 获取: 隐含波动率(IV)、实际波动率(RV)、波动率偏度(Vol Skew)
 * 文档: https://docs.deribit.com/
 * 
 * ★ 所有使用的端点均为 public 方法，无需注册账号或 API Key ★
 */

const BASE = 'https://www.deribit.com/api/v2';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Deribit API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  if (data.error) throw new Error(`Deribit: ${data.error.message}`);
  return data.result;
}

// ─── 历史波动率 (RV) ───
// public/get_historical_volatility 返回多个时间窗口的年化 RV
async function getHistoricalVolatility() {
  const result = await fetchJSON(
    `${BASE}/public/get_historical_volatility?currency=BTC`
  );
  // result 是一个数组: [[timestamp, rv], [timestamp, rv], ...]
  // rv 已经是年化百分比
  if (Array.isArray(result) && result.length > 0) {
    const latest = result[result.length - 1];
    return {
      rv: Math.round(latest[1] * 100) / 100,
      history: result.slice(-30).map(r => ({
        timestamp: r[0],
        rv: Math.round(r[1] * 100) / 100,
      })),
    };
  }
  return { rv: 0, history: [] };
}

// ─── 获取 BTC 期权汇总 → 提取 ATM IV ───
// public/get_book_summary_by_currency 返回所有期权的 mark_iv
async function getOptionsSummary() {
  const result = await fetchJSON(
    `${BASE}/public/get_book_summary_by_currency?currency=BTC&kind=option`
  );
  return result;
}

// ─── 获取 BTC 指数价格 ───
async function getIndexPrice() {
  const result = await fetchJSON(
    `${BASE}/public/get_index_price?index_name=btc_usd`
  );
  return result.index_price;
}

// ─── 计算 ATM 隐含波动率 ───
function calcATMIV(options, indexPrice) {
  // 筛选 7-30 天到期的期权（最有代表性）
  const now = Date.now();
  const minExpiry = now + 7 * 86400000;
  const maxExpiry = now + 30 * 86400000;

  const relevantOptions = options.filter(o => {
    if (!o.mark_iv || o.mark_iv <= 0) return false;
    // instrument_name 格式: BTC-28MAR25-85000-C
    const parts = o.instrument_name.split('-');
    const strike = parseFloat(parts[2]);
    // 只选 ATM 附近 (±10%) 的期权
    const moneyness = Math.abs(strike - indexPrice) / indexPrice;
    return moneyness < 0.10;
  });

  if (relevantOptions.length === 0) {
    // fallback: 取所有有效期权的中位数 IV
    const allIVs = options.filter(o => o.mark_iv > 0).map(o => o.mark_iv).sort((a, b) => a - b);
    return allIVs.length > 0 ? allIVs[Math.floor(allIVs.length / 2)] : 50;
  }

  const ivs = relevantOptions.map(o => o.mark_iv);
  return Math.round((ivs.reduce((a, b) => a + b, 0) / ivs.length) * 100) / 100;
}

// ─── 计算波动率偏度 (Vol Skew) ───
function calcVolSkew(options, indexPrice) {
  const now = Date.now();

  // 选 7-30 天到期的 OTM 期权
  const relevant = options.filter(o => {
    if (!o.mark_iv || o.mark_iv <= 0) return false;
    const parts = o.instrument_name.split('-');
    const strike = parseFloat(parts[2]);
    const moneyness = Math.abs(strike - indexPrice) / indexPrice;
    return moneyness > 0.02 && moneyness < 0.15;
  });

  const puts = relevant.filter(o => o.instrument_name.endsWith('-P'));
  const calls = relevant.filter(o => o.instrument_name.endsWith('-C'));

  const avgIV = (arr) => {
    if (arr.length === 0) return 0;
    return arr.reduce((s, o) => s + o.mark_iv, 0) / arr.length;
  };

  const putIV = Math.round(avgIV(puts) * 100) / 100;
  const callIV = Math.round(avgIV(calls) * 100) / 100;

  return {
    putIV,
    callIV,
    skew: Math.round((putIV - callIV) * 100) / 100,
  };
}

// ─── 计算期权最大痛点 (Max Pain) ───
function calcMaxPain(options, indexPrice) {
  // 找到本周五到期的期权
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const daysToFriday = (5 - dayOfWeek + 7) % 7 || 7;
  const nextFriday = new Date(now.getTime() + daysToFriday * 86400000);
  const fridayStr = nextFriday.toISOString().slice(0, 10);

  // Deribit 到期日格式: BTC-28MAR25-85000-C → 提取日期部分
  const monthMap = {JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
    JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12'};

  function parseExpiry(name) {
    const parts = name.split('-');
    if (parts.length < 4) return null;
    const dateStr = parts[1]; // e.g. "28MAR25"
    const day = dateStr.slice(0, dateStr.search(/[A-Z]/));
    const mon = dateStr.replace(/[0-9]/g, '');
    const yr = dateStr.slice(-2);
    if (!monthMap[mon]) return null;
    return `20${yr}-${monthMap[mon]}-${day.padStart(2, '0')}`;
  }

  // 按到期日分组，选最近到期的一组
  const byExpiry = {};
  for (const o of options) {
    if (!o.instrument_name || !o.open_interest) continue;
    const expiry = parseExpiry(o.instrument_name);
    if (!expiry) continue;
    if (!byExpiry[expiry]) byExpiry[expiry] = [];
    byExpiry[expiry].push(o);
  }

  // 选最近的周五或最近的到期日
  const expiries = Object.keys(byExpiry).sort();
  const futureExpiries = expiries.filter(e => e >= now.toISOString().slice(0, 10));
  if (futureExpiries.length === 0) return null;

  // 优先选7天内到期的
  const target = futureExpiries.find(e => {
    const diff = (new Date(e + 'T08:00:00Z').getTime() - now.getTime()) / 86400000;
    return diff <= 7 && diff >= 0;
  }) || futureExpiries[0];

  const targetOptions = byExpiry[target];
  if (!targetOptions || targetOptions.length < 4) return null;

  // 提取 strikes
  const strikes = new Set();
  for (const o of targetOptions) {
    const parts = o.instrument_name.split('-');
    strikes.add(parseFloat(parts[2]));
  }
  const sortedStrikes = [...strikes].sort((a, b) => a - b);

  // 计算每个 strike 作为结算价时的总痛值
  let minPain = Infinity, maxPainStrike = 0;

  for (const settlePrice of sortedStrikes) {
    let totalPain = 0;
    for (const o of targetOptions) {
      const parts = o.instrument_name.split('-');
      const strike = parseFloat(parts[2]);
      const type = parts[3]; // C or P
      const oi = o.open_interest || 0;

      if (type === 'C') {
        totalPain += Math.max(0, settlePrice - strike) * oi;
      } else {
        totalPain += Math.max(0, strike - settlePrice) * oi;
      }
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = settlePrice;
    }
  }

  const distFromCurrent = ((maxPainStrike - indexPrice) / indexPrice) * 100;

  return {
    strike: maxPainStrike,
    expiry: target,
    distPct: Math.round(distFromCurrent * 100) / 100,
    direction: maxPainStrike > indexPrice ? 'above' : 'below',
    totalOI: targetOptions.reduce((s, o) => s + (o.open_interest || 0), 0),
    optionCount: targetOptions.length,
  };
}

// ─── 整合拉取 ───
async function fetchAll() {
  console.log('[Deribit] 拉取波动率数据 (公开API, 无需账号)...');

  const [rvData, options, indexPrice] = await Promise.all([
    getHistoricalVolatility(),
    getOptionsSummary(),
    getIndexPrice(),
  ]);

  const iv = calcATMIV(options, indexPrice);
  const skew = calcVolSkew(options, indexPrice);
  const maxPain = calcMaxPain(options, indexPrice);

  if (maxPain) {
    console.log(`  ✓ Max Pain: $${maxPain.strike.toLocaleString()} (${maxPain.expiry}, 距现价 ${maxPain.distPct}%)`);
  }

  return {
    iv,
    rv: rvData.rv,
    ivRvSpread: Math.round((iv - rvData.rv) * 100) / 100,
    skew,
    maxPain,
    rvHistory: rvData.history,
    optionCount: options.length,
    indexPrice,
  };
}

module.exports = { fetchAll };
