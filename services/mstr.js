/**
 * MSTR (Strategy) 指标追踪服务
 * 
 * 数据:
 * - BTC 持仓量 / 最近购买: 抓取 strategy.com 或硬编码最新公开数据
 * - MSTR 股价: Finnhub API (免费)
 * - NAV Premium: 计算 市值 / (BTC持仓 × BTC价格)
 * - SEC 融资公告: Finnhub SEC filings API
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// ─── MSTR BTC 持仓数据 ───
// 来源: https://www.strategy.com/purchases (公开)
// 每次 Saylor 推特公布或 SEC 8-K 更新后，更新此处
// 也可以抓取 treasuries.bitbo.io/microstrategy 获取最新数据
const MSTR_HOLDINGS = {
  totalBTC: 761068,         // 总 BTC 持仓 (2026-03-16)
  avgCostPerBTC: 66385,     // 平均成本
  totalCostUSD: 50.5e9,     // 总投入 (美元)
  sharesOutstanding: 260_000_000, // 流通股数 (近似)
  lastUpdate: '2026-03-16',

  // 最近一次购买
  lastPurchase: {
    btcAmount: 22337,
    totalCost: 1.57e9,
    avgPrice: 70283,
    date: '2026-03-16',
    source: '8-K Filing',
  },

  // 最近的融资公告
  latestOffering: {
    type: 'ATM Equity + Fixed Income',
    amount: '42 Billion USD',
    purpose: 'Purchase Bitcoin',
    date: '2024-10-30',
    isActive: true,
    note: '21/21 Plan: $21B ATM equity + $21B fixed income',
  },
};

// ─── 自动抓取 MSTR BTC 持仓 ───
async function fetchHoldingsFromBitbo() {
  try {
    const res = await fetch('https://treasuries.bitbo.io/microstrategy', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 尝试从页面提取数字 (简单正则)
    const btcMatch = html.match(/owns\s+([\d,]+)\s+bitcoins/i);
    const avgMatch = html.match(/average purchase price as\s+\$([\d,.]+)/i);
    const costMatch = html.match(/total cost of\s+\$([\d.]+)\s+billion/i);

    if (btcMatch) {
      const totalBTC = parseInt(btcMatch[1].replace(/,/g, ''));
      const avgCost = avgMatch ? parseFloat(avgMatch[1].replace(/,/g, '')) : MSTR_HOLDINGS.avgCostPerBTC;
      const totalCost = costMatch ? parseFloat(costMatch[1]) * 1e9 : MSTR_HOLDINGS.totalCostUSD;

      return { totalBTC, avgCostPerBTC: avgCost, totalCostUSD: totalCost };
    }
  } catch (err) {
    console.warn('  [MSTR] Bitbo 抓取失败:', err.message);
  }
  return null;
}

// ─── MSTR 股价 (Finnhub) ───
async function fetchMSTRPrice(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${FINNHUB_BASE}/quote?symbol=MSTR&token=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      price: data.c,       // 当前价
      change: data.dp,     // 涨跌幅 %
      high: data.h,
      low: data.l,
      prevClose: data.pc,
    };
  } catch (err) {
    console.warn('  [MSTR] 股价获取失败:', err.message);
    return null;
  }
}

// ─── MSTR 公司数据 (Finnhub) ───
async function fetchMSTRProfile(apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch(`${FINNHUB_BASE}/stock/profile2?symbol=MSTR&token=${apiKey}`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      marketCap: data.marketCapitalization * 1e6, // Finnhub 返回百万单位
      sharesOutstanding: data.shareOutstanding * 1e6,
    };
  } catch (err) {
    return null;
  }
}

// ─── SEC Filings 检查 (Finnhub) ───
async function fetchSECFilings(apiKey) {
  if (!apiKey) return [];
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${FINNHUB_BASE}/stock/filings?symbol=MSTR&from=${from}&to=${to}&token=${apiKey}`
    );
    if (!res.ok) return [];
    const data = await res.json();

    // 筛选关键融资相关文件
    const keywords = ['S-3', '8-K', 'convertible', 'offering', 'prospectus', 'shelf registration'];
    return (data || [])
      .filter(f => {
        const form = (f.form || '').toUpperCase();
        const title = (f.title || '').toLowerCase();
        return form === '8-K' || form === 'S-3' || form.includes('424B') ||
          keywords.some(kw => title.includes(kw.toLowerCase()));
      })
      .slice(0, 5)
      .map(f => ({
        form: f.form,
        title: f.title || '',
        date: f.filedDate || f.acceptedDate,
        url: f.reportUrl || f.filingUrl,
      }));
  } catch (err) {
    return [];
  }
}

// ─── 计算 NAV Premium ───
function calcNAVPremium(marketCap, totalBTC, btcPrice) {
  if (!marketCap || !totalBTC || !btcPrice) return null;
  const btcValue = totalBTC * btcPrice;
  const navMultiple = marketCap / btcValue;
  return {
    multiple: Math.round(navMultiple * 100) / 100,  // e.g. 1.85x
    btcValue: btcValue,
    marketCap: marketCap,
    premium: Math.round((navMultiple - 1) * 10000) / 100, // e.g. +85%
  };
}

// ─── 信号判断 ───
function getMSTRSignal(navPremium, latestOffering, secFilings) {
  const signals = [];

  // NAV Premium 信号
  if (navPremium) {
    if (navPremium.multiple > 2.0) {
      signals.push({ type: 'danger', msg: `NAV 溢价 ${navPremium.multiple}x 处于历史高位，美股 FOMO 极端，BTC 回调风险大！避免做高卖 (Sell Call)` });
    } else if (navPremium.multiple > 1.5) {
      signals.push({ type: 'warn', msg: `NAV 溢价 ${navPremium.multiple}x 偏高，华尔街情绪偏热` });
    } else if (navPremium.multiple < 1.1) {
      signals.push({ type: 'safe', msg: `NAV 溢价 ${navPremium.multiple}x 回落至合理区间，情绪平稳` });
    } else {
      signals.push({ type: 'safe', msg: `NAV 溢价 ${navPremium.multiple}x 正常` });
    }
  }

  // 融资公告信号
  if (latestOffering && latestOffering.isActive) {
    signals.push({
      type: 'warn',
      msg: `MSTR 正在执行 ${latestOffering.type} (${latestOffering.amount})，预期持续现货买盘，避免做高卖！`
    });
  }

  // 最近 SEC 文件
  const recent8K = secFilings.filter(f => {
    const d = new Date(f.date);
    return (Date.now() - d.getTime()) < 7 * 86400000; // 7天内
  });
  if (recent8K.length > 0) {
    signals.push({
      type: 'warn',
      msg: `MSTR 过去7天提交 ${recent8K.length} 份 SEC 文件，关注是否有新融资/购买公告`
    });
  }

  return signals;
}

// ─── 整合 ───
async function fetchAll(btcPrice) {
  console.log('[MSTR] 拉取 Strategy 指标...');

  const apiKey = process.env.FINNHUB_API_KEY;

  // 1. 尝试自动抓取最新持仓
  const liveHoldings = await fetchHoldingsFromBitbo();
  const holdings = {
    ...MSTR_HOLDINGS,
    ...(liveHoldings || {}),
  };

  // 2. MSTR 股价 & 市值
  const [stockPrice, profile] = await Promise.all([
    fetchMSTRPrice(apiKey),
    fetchMSTRProfile(apiKey),
  ]);

  const marketCap = profile?.marketCap || (stockPrice ? stockPrice.price * holdings.sharesOutstanding : null);

  // 3. NAV Premium
  const navPremium = calcNAVPremium(marketCap, holdings.totalBTC, btcPrice);

  // 4. SEC 文件
  const secFilings = await fetchSECFilings(apiKey);

  // 5. 信号
  const signals = getMSTRSignal(navPremium, holdings.latestOffering, secFilings);

  const result = {
    holdings: {
      totalBTC: holdings.totalBTC,
      avgCostPerBTC: holdings.avgCostPerBTC,
      totalCostUSD: holdings.totalCostUSD,
      unrealizedPnL: btcPrice ? (btcPrice - holdings.avgCostPerBTC) * holdings.totalBTC : null,
      holdingsLastUpdate: holdings.lastUpdate,
      source: liveHoldings ? 'bitbo_live' : 'hardcoded',
    },
    lastPurchase: holdings.lastPurchase,
    latestOffering: holdings.latestOffering,
    stock: stockPrice || null,
    navPremium,
    secFilings,
    signals,
  };

  if (navPremium) {
    console.log(`  ✓ MSTR: ${holdings.totalBTC.toLocaleString()} BTC, NAV ${navPremium.multiple}x, 股价 $${stockPrice?.price || 'N/A'}`);
  } else {
    console.log(`  ✓ MSTR: ${holdings.totalBTC.toLocaleString()} BTC (NAV 计算需要 FINNHUB_API_KEY)`);
  }

  return result;
}

module.exports = { fetchAll };
