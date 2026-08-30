/**
 * 宏观经济事件 & Token 解锁日历
 * 
 * 优先级: Finnhub API (自动) → 硬编码兜底
 * Finnhub 免费注册: https://finnhub.io/register
 * Railway Variables 中设置 FINNHUB_API_KEY 即可启用
 */

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const HIGH_KW = ['FOMC','Federal Funds Rate','Interest Rate Decision','CPI','Consumer Price Index',
  'Nonfarm Payrolls','Non-Farm','NFP','Employment Change','GDP','PPI','Producer Price',
  'Retail Sales','PCE','Personal Consumption','Unemployment Rate','Fed Chair','Powell'];
const MED_KW = ['Jobless Claims','PMI','ISM','Trade Balance','Housing','Consumer Confidence','Durable Goods'];

function getIcon(n) {
  const l = n.toLowerCase();
  if (/fomc|interest rate|federal|powell|fed chair/.test(l)) return 'fed';
  if (/cpi|inflation|ppi|pce|producer price/.test(l)) return 'cpi';
  if (/nonfarm|non-farm|nfp|employment|unemployment|jobless/.test(l)) return 'nfp';
  return 'cpi';
}

function getImpact(name, importance) {
  if (importance >= 2) return 'high';
  const u = name.toUpperCase();
  if (HIGH_KW.some(k => u.includes(k.toUpperCase()))) return 'high';
  if (MED_KW.some(k => u.includes(k.toUpperCase()))) return 'medium';
  return 'low';
}

const ZH_MAP = {
  'Interest Rate Decision':'FOMC 利率决议','Federal Funds Rate':'联邦基金利率',
  'FOMC Minutes':'FOMC 会议纪要','FOMC Press Conference':'FOMC 新闻发布会',
  'CPI MoM':'CPI 月率','CPI YoY':'CPI 年率','Core CPI MoM':'核心CPI 月率','Core CPI YoY':'核心CPI 年率',
  'Consumer Price Index':'CPI 通胀数据','Nonfarm Payrolls':'非农就业数据',
  'Non-Farm Employment Change':'非农就业变化','Unemployment Rate':'失业率',
  'Initial Jobless Claims':'初请失业金','GDP Growth Rate QoQ':'GDP 季率','GDP Growth Rate YoY':'GDP 年率',
  'PPI MoM':'PPI 月率','PPI YoY':'PPI 年率','Retail Sales MoM':'零售销售月率',
  'PCE Price Index MoM':'PCE 物价月率','PCE Price Index YoY':'PCE 物价年率',
  'Core PCE Price Index MoM':'核心PCE 月率','Core PCE Price Index YoY':'核心PCE 年率',
  'ISM Manufacturing PMI':'ISM 制造业PMI','Consumer Confidence':'消费者信心指数',
};
function zhName(n) { for (const [en,zh] of Object.entries(ZH_MAP)) { if (n.includes(en)) return zh; } return n; }

async function fetchFromFinnhub(apiKey) {
  const now = new Date();
  const from = now.toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const url = `${FINNHUB_BASE}/calendar/economic?from=${from}&to=${to}&token=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub ${res.status}`);
  const data = await res.json();
  if (!data.economicCalendar) throw new Error('格式异常');
  return data.economicCalendar
    .filter(e => e.country === 'US')
    .map(e => ({
      name: zhName(e.event || ''), nameEn: e.event, icon: getIcon(e.event || ''),
      impact: getImpact(e.event || '', e.importance || 0),
      date: e.time ? `${e.date} ${e.time}` : e.date,
      actual: e.actual, estimate: e.estimate, prev: e.prev,
    }))
    .filter(e => e.impact !== 'low');
}

// ─── 兜底日历 ───
// 只放「日程规则明确、可以放心硬编码」的两类事件：
//   1. FOMC —— 美联储提前一年以上公布，声明在会议第二天 14:00 ET 发布
//   2. 非农 (NFP) —— BLS 固定在每月第一个周五 08:30 ET，可用规则算出来
// CPI 没有严格规则（通常每月 10~13 日之间浮动），故意不在兜底里猜——
// 猜错日期比没有日期更危险（会造成假的否决或漏掉真的否决）。
// CPI 需要 FINNHUB_API_KEY 才能覆盖。
//
// 数据来源: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// 2027 年为美联储公布的暂定日程，会前才最终确认。
// ⚠️ 维护提醒：这张表覆盖到 2027-12。届时请回来续期，或直接配 FINNHUB_API_KEY。
const FOMC_STATEMENTS = [
  '2026-09-16 18:00',  // 9/15-16
  '2026-10-28 18:00',  // 10/27-28
  '2026-12-09 19:00',  // 12/8-9  (冬令时 EST)
  '2027-01-27 19:00',  // 1/26-27 (EST)
  '2027-03-17 18:00',  // 3/16-17
  '2027-04-28 18:00',  // 4/27-28
  '2027-06-09 18:00',  // 6/8-9
  '2027-07-28 18:00',  // 7/27-28
  '2027-09-15 18:00',  // 9/14-15
  '2027-10-27 18:00',  // 10/26-27
  '2027-12-08 19:00',  // 12/7-8  (EST)
];
const FOMC_CALENDAR_ENDS = '2027-12-31';

/**
 * 生成未来 N 个月的非农发布日 (每月第一个周五 08:30 ET)。
 * 夏令时(3月中~11月初)= 12:30 UTC，冬令时 = 13:30 UTC。
 * 对于「距事件是否不足 24h」这个用途，这个精度完全够用。
 */
function computeNFPDates(monthsAhead = 6) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < monthsAhead; i++) {
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + i;
    const first = new Date(Date.UTC(y, m, 1));
    // 0=周日 ... 5=周五
    const offset = (5 - first.getUTCDay() + 7) % 7;
    const d = new Date(Date.UTC(y, m, 1 + offset));
    const month = d.getUTCMonth() + 1;
    const isDST = month >= 4 && month <= 10;   // 保守取值，边界月份差 1 小时无碍
    const hh = isDST ? '12' : '13';
    const pad = (n) => String(n).padStart(2, '0');
    out.push(`${d.getUTCFullYear()}-${pad(month)}-${pad(d.getUTCDate())} ${hh}:30`);
  }
  return out;
}

function buildFallback() {
  return [
    ...FOMC_STATEMENTS.map(date => ({ name: 'FOMC 利率决议', icon: 'fed', impact: 'high', date })),
    ...computeNFPDates(6).map(date => ({ name: '非农就业数据', icon: 'nfp', impact: 'high', date })),
  ];
}

async function fetchAll() {
  console.log('[Macro] 加载宏观事件日历...');
  const now = Date.now();
  let rawEvents = [], source = 'fallback';

  const key = process.env.FINNHUB_API_KEY;
  if (key) {
    try {
      rawEvents = await fetchFromFinnhub(key);
      source = 'finnhub';
      console.log(`  [Finnhub] 获取 ${rawEvents.length} 个美国经济事件`);
    } catch (err) {
      console.warn(`  [Finnhub] 失败: ${err.message}，用兜底日历`);
      rawEvents = buildFallback();
    }
  } else {
    console.log('  未设 FINNHUB_API_KEY，用兜底日历。去 https://finnhub.io/register 免费获取');
    rawEvents = buildFallback();
  }

  const upcoming = rawEvents
    .map(e => {
      const ds = e.date.includes('T') ? e.date : e.date + ' UTC';
      return { ...e, dateObj: new Date(ds) };
    })
    .filter(e => { const t = e.dateObj.getTime(); return t > now && t < now + 30*86400000 && !isNaN(t); })
    .sort((a,b) => a.dateObj - b.dateObj)
    .map(e => {
      const h = Math.floor((e.dateObj - now) / 3600000);
      const d = Math.floor(h / 24), r = h % 24;
      return {
        name: e.name, icon: e.icon, impact: e.impact,
        date: e.dateObj.toISOString(), hoursUntil: h,
        countdown: d > 0 ? `${d}天${r}小时` : `${h}小时`,
        isUrgent: h < 24,
        actual: e.actual||null, estimate: e.estimate||null, prev: e.prev||null,
      };
    });

  const urgent = upcoming.filter(e => e.isUrgent && e.impact === 'high');

  // ── 失效检测 ──
  // 这里过去出过一次静默失效：兜底日历里的日期全部过期后，upcoming 恒为空、
  // hasUrgent 恒为 false，于是「距 FOMC/CPI 不足 24h → 黄灯」这条全局否决
  // 永远不会触发，而界面上看不出任何异常。以下把这种情况显式暴露出来。
  const stale = [];
  if (upcoming.length === 0) {
    stale.push('宏观日历为空：未来 30 天内没有任何事件');
    console.error('  ⚠️ [Macro] 日历为空！宏观否决门当前完全失效。'
      + (source === 'fallback' ? ' 请设置 FINNHUB_API_KEY，或检查兜底日历是否已过期。' : ''));
  }
  if (source === 'fallback') {
    stale.push('未配置 FINNHUB_API_KEY，仅有 FOMC/非农兜底日历，CPI 等事件缺失');
    if (Date.now() > new Date(FOMC_CALENDAR_ENDS + ' UTC').getTime()) {
      stale.push(`兜底 FOMC 日历已到期（覆盖至 ${FOMC_CALENDAR_ENDS}），需要续期`);
      console.error(`  ⚠️ [Macro] 兜底 FOMC 日历已过 ${FOMC_CALENDAR_ENDS}，请更新 FOMC_STATEMENTS`);
    }
  }

  return {
    source,
    events: upcoming.slice(0, 10),
    hasUrgent: urgent.length > 0,
    urgentCount: urgent.length,
    stale: stale.length > 0,
    staleReasons: stale,
    vetoOperational: upcoming.length > 0,   // 宏观否决门此刻是否真的能生效
  };
}

module.exports = { fetchAll };
