/**
 * 宏观经济事件 & Token 解锁日历
 * 
 * 数据来源策略：
 * 1. 核心事件（FOMC/CPI/NFP）通过抓取 ForexFactory 或手动维护日历
 * 2. Token 解锁数据可从 TokenUnlocks.app API 获取
 * 3. 此处提供一个混合方案：已知事件硬编码 + API 拉取增强
 * 
 * 你可以每月初更新一次 KNOWN_EVENTS 数组，或接入 API 自动获取
 */

// ─── 手动维护的核心宏观事件日历 ───
// 每月只需维护 3-5 个关键事件，耗时 < 1 分钟
// 日期格式: 'YYYY-MM-DD HH:mm' (UTC 时间)
const KNOWN_EVENTS = [
  // ===== 请根据实际日期更新以下内容 =====
  // 美联储 FOMC
  { name: 'FOMC 利率决议', icon: 'fed', impact: 'high', date: '2026-03-18 18:00' },
  { name: 'FOMC 会议纪要', icon: 'fed', impact: 'medium', date: '2026-04-09 18:00' },
  { name: 'FOMC 利率决议', icon: 'fed', impact: 'high', date: '2026-05-06 18:00' },

  // CPI 通胀
  { name: 'CPI 通胀数据 (3月)', icon: 'cpi', impact: 'high', date: '2026-04-14 12:30' },
  { name: 'CPI 通胀数据 (4月)', icon: 'cpi', impact: 'high', date: '2026-05-13 12:30' },

  // 非农就业
  { name: '非农就业数据 (3月)', icon: 'nfp', impact: 'high', date: '2026-04-03 12:30' },
  { name: '非农就业数据 (4月)', icon: 'nfp', impact: 'high', date: '2026-05-08 12:30' },

  // PPI
  { name: 'PPI 生产者物价指数', icon: 'cpi', impact: 'medium', date: '2026-04-15 12:30' },

  // Token 解锁 (手动添加或从 API 获取)
  { name: 'ARB 代币解锁 (~1.1亿枚)', icon: 'token', impact: 'medium', date: '2026-03-25 00:00' },
  { name: 'OP 代币解锁 (~3100万枚)', icon: 'token', impact: 'medium', date: '2026-03-31 00:00' },
  // ===== 更新到此 =====
];

// ─── 尝试从 API 获取 Token 解锁数据 ───
async function fetchTokenUnlocks() {
  try {
    // TokenUnlocks API (如有 Key)
    const apiKey = process.env.TOKEN_UNLOCKS_API_KEY;
    if (!apiKey) return [];

    const res = await fetch(
      'https://api.tokenunlocks.app/api/v1/unlocks?limit=10',
      { headers: { 'Authorization': `Bearer ${apiKey}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();

    return (data.data || [])
      .filter(u => u.usd_value > 10_000_000) // 只关注千万美元以上的解锁
      .map(u => ({
        name: `${u.token_symbol} 代币解锁 ($${Math.round(u.usd_value / 1e6)}M)`,
        icon: 'token',
        impact: u.usd_value > 100_000_000 ? 'high' : 'medium',
        date: new Date(u.unlock_date).toISOString().slice(0, 16).replace('T', ' '),
      }));
  } catch (err) {
    console.warn('[TokenUnlocks] API 拉取失败:', err.message);
    return [];
  }
}

// ─── 整合 ───
async function fetchAll() {
  console.log('[Macro] 加载宏观事件日历...');

  const now = Date.now();
  const lookAhead = 30 * 86400000; // 未来 30 天

  // 合并手动事件 + API 事件
  const tokenEvents = await fetchTokenUnlocks();
  const allEvents = [...KNOWN_EVENTS, ...tokenEvents];

  const upcoming = allEvents
    .map(e => ({
      ...e,
      dateObj: new Date(e.date + ' UTC'),
    }))
    .filter(e => {
      const t = e.dateObj.getTime();
      return t > now && t < now + lookAhead;
    })
    .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
    .map(e => {
      const diffMs = e.dateObj.getTime() - now;
      const hours = Math.floor(diffMs / 3600000);
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;

      return {
        name: e.name,
        icon: e.icon,
        impact: e.impact,
        date: e.dateObj.toISOString(),
        hoursUntil: hours,
        countdown: days > 0 ? `${days}天${remHours}小时` : `${hours}小时`,
        isUrgent: hours < 24,
      };
    });

  // 最近 24h 内是否有高影响事件
  const urgentHighImpact = upcoming.filter(e => e.isUrgent && e.impact === 'high');

  return {
    events: upcoming.slice(0, 8), // 最多返回 8 个
    hasUrgent: urgentHighImpact.length > 0,
    urgentCount: urgentHighImpact.length,
  };
}

module.exports = { fetchAll };
