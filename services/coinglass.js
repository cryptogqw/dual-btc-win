/**
 * Coinglass 公开 API 服务
 * 获取: 清算数据 (Liquidation Heatmap)
 * 
 * Coinglass 免费 API 有限制，这里提供两种模式：
 * 1. 有 API Key: 使用官方 API (https://coinglass.com 注册免费 Key)
 * 2. 无 API Key: 使用 Binance 持仓数据估算清算区间
 * 
 * 在 .env 中设置 COINGLASS_API_KEY 可启用模式 1
 */

const COINGLASS_BASE = 'https://open-api-v3.coinglass.com';
const BINANCE_BASE = 'https://fapi.binance.com';

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}

// ─── 模式 1: Coinglass API (需要免费 Key) ───
async function fetchFromCoinglass(apiKey) {
  try {
    const data = await fetchJSON(
      `${COINGLASS_BASE}/api/futures/liquidation/info?symbol=BTC`,
      { 'CG-API-KEY': apiKey }
    );
    if (data.code === '0' && data.data) {
      return {
        source: 'coinglass',
        data: data.data,
      };
    }
  } catch (err) {
    console.warn('[Coinglass] API 请求失败，回退到估算模式:', err.message);
  }
  return null;
}

// ─── 模式 2: 基于 Binance 合约数据估算清算区间 ───
async function estimateFromBinance(currentPrice) {
  // 获取 Binance 合约的多空比和持仓数据
  const [longShortRatio, openInterest] = await Promise.all([
    fetchJSON(`${BINANCE_BASE}/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=1`),
    fetchJSON(`${BINANCE_BASE}/fapi/v1/openInterest?symbol=BTCUSDT`),
  ]);

  const oi = parseFloat(openInterest.openInterest);
  const lsRatio = longShortRatio[0] ? parseFloat(longShortRatio[0].longShortRatio) : 1;

  // 估算清算区间：高杠杆仓位通常在 ±1%~8% 分布
  // 多头清算在下方，空头清算在上方
  const zones = [];
  const leverages = [125, 100, 50, 25, 20, 10, 5]; // 常见杠杆倍数

  for (const lev of leverages) {
    // 强平价格 ≈ 入场价 × (1 - 1/杠杆) for 多头
    // 强平价格 ≈ 入场价 × (1 + 1/杠杆) for 空头
    const longLiqPct = 1 / lev;
    const shortLiqPct = 1 / lev;

    const longLiqPrice = currentPrice * (1 - longLiqPct);
    const shortLiqPrice = currentPrice * (1 + shortLiqPct);

    // 估算该杠杆倍数的持仓量（高杠杆占比较小）
    const volumeWeight = lev >= 50 ? 0.05 : lev >= 20 ? 0.15 : lev >= 10 ? 0.30 : 0.50;
    const estimatedVolume = oi * volumeWeight * (lsRatio > 1 ? 0.6 : 0.4);

    zones.push({
      price: Math.round(longLiqPrice * 100) / 100,
      volume: Math.round(estimatedVolume * (1 / lev) * 100) / 100,
      side: 'long',
      leverage: lev,
      pctFromPrice: Math.round(-longLiqPct * 10000) / 100,
    });
    zones.push({
      price: Math.round(shortLiqPrice * 100) / 100,
      volume: Math.round(estimatedVolume * (1 / lev) * 100) / 100,
      side: 'short',
      leverage: lev,
      pctFromPrice: Math.round(shortLiqPct * 10000) / 100,
    });
  }

  zones.sort((a, b) => a.price - b.price);

  return {
    source: 'binance_estimate',
    longShortRatio: lsRatio,
    openInterest: oi,
    zones,
  };
}

// ─── 整合拉取 ───
async function fetchAll(currentPrice) {
  console.log('[Liquidation] 拉取清算数据...');

  const apiKey = process.env.COINGLASS_API_KEY;

  // 优先使用 Coinglass
  if (apiKey) {
    const cgData = await fetchFromCoinglass(apiKey);
    if (cgData) return cgData;
  }

  // 回退到 Binance 估算
  return estimateFromBinance(currentPrice);
}

module.exports = { fetchAll };
