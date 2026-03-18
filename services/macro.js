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

const FALLBACK = [
  { name:'FOMC 利率决议', icon:'fed', impact:'high', date:'2026-05-06 18:00' },
  { name:'CPI 通胀数据', icon:'cpi', impact:'high', date:'2026-04-14 12:30' },
  { name:'非农就业数据', icon:'nfp', impact:'high', date:'2026-04-03 12:30' },
  { name:'CPI 通胀数据', icon:'cpi', impact:'high', date:'2026-05-13 12:30' },
  { name:'非农就业数据', icon:'nfp', impact:'high', date:'2026-05-08 12:30' },
];

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
      rawEvents = FALLBACK;
    }
  } else {
    console.log('  未设 FINNHUB_API_KEY，用兜底日历。去 https://finnhub.io/register 免费获取');
    rawEvents = FALLBACK;
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
  return { source, events: upcoming.slice(0,10), hasUrgent: urgent.length > 0, urgentCount: urgent.length };
}

module.exports = { fetchAll };
