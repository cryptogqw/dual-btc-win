/**
 * BTC 双币赢决策终端 - 后端服务
 * 
 * 功能：
 * - 定时拉取 Binance / Deribit / Coinglass 数据
 * - 内存缓存，前端只读缓存
 * - 综合计算决策信号（红绿灯）
 * - 提供 RESTful API 给前端
 * 
 * 启动: npm start
 * 开发: npm run dev (自动重启)
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const cache = require('./cache');

// 服务模块
const binance = require('./services/binance');
const deribit = require('./services/deribit');
const coinglass = require('./services/coinglass');
const macro = require('./services/macro');
const mstr = require('./services/mstr');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── 中间件 ───
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 数据拉取逻辑 ───
async function fetchAndCache() {
  const startTime = Date.now();
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[${new Date().toISOString()}] 开始数据刷新...`);

  const errors = [];

  // 1. Binance 数据 (价格、技术指标、分形)
  try {
    const binanceData = await binance.fetchAll();
    cache.set('binance', binanceData);
    console.log(`  ✓ Binance: 价格 $${binanceData.price.price.toLocaleString()}`);
  } catch (err) {
    errors.push(`Binance: ${err.message}`);
    console.error(`  ✗ Binance 失败:`, err.message);
  }

  // 2. Deribit 数据 (IV, RV, Skew)
  try {
    const deribitData = await deribit.fetchAll();
    cache.set('deribit', deribitData);
    console.log(`  ✓ Deribit: IV=${deribitData.iv}%, RV=${deribitData.rv}%`);
  } catch (err) {
    errors.push(`Deribit: ${err.message}`);
    console.error(`  ✗ Deribit 失败:`, err.message);
  }

  // 3. 清算数据
  try {
    const binanceCache = cache.get('binance');
    const price = binanceCache?.price?.price || 84000;
    const liqData = await coinglass.fetchAll(price);
    cache.set('liquidation', liqData);
    console.log(`  ✓ 清算数据: 来源=${liqData.source}`);
  } catch (err) {
    errors.push(`Liquidation: ${err.message}`);
    console.error(`  ✗ 清算数据失败:`, err.message);
  }

  // 4. 宏观事件
  try {
    const macroData = await macro.fetchAll();
    cache.set('macro', macroData);
    console.log(`  ✓ 宏观事件: ${macroData.events.length} 个即将到来`);
  } catch (err) {
    errors.push(`Macro: ${err.message}`);
    console.error(`  ✗ 宏观事件失败:`, err.message);
  }

  // 5. MSTR 指标
  try {
    const binanceCache = cache.get('binance');
    const btcPrice = binanceCache?.price?.price || 84000;
    const mstrData = await mstr.fetchAll(btcPrice);
    cache.set('mstr', mstrData);
  } catch (err) {
    errors.push(`MSTR: ${err.message}`);
    console.error(`  ✗ MSTR 失败:`, err.message);
  }

  // 6. 计算综合决策
  try {
    const decision = computeDecision();
    cache.set('decision', decision);
    console.log(`  ★ 决策信号: ${decision.signal.toUpperCase()} (评分: ${decision.score})`);
  } catch (err) {
    errors.push(`Decision: ${err.message}`);
    console.error(`  ✗ 决策计算失败:`, err.message);
  }

  const elapsed = Date.now() - startTime;
  console.log(`[完成] 耗时 ${elapsed}ms, 错误: ${errors.length}`);
  if (errors.length > 0) console.log(`  错误详情:`, errors);
  console.log('='.repeat(50));

  cache.set('_meta', {
    lastRefresh: new Date().toISOString(),
    elapsed,
    errors,
  });
}

// ─── 决策引擎 ───
function computeDecision() {
  const b = cache.get('binance');
  const d = cache.get('deribit');
  const m = cache.get('macro');

  if (!b || !d) {
    return { signal: 'yellow', score: 0, reasons: ['数据不完整，等待下次刷新'], advice: '数据加载中...' };
  }

  let score = 0;
  const reasons = [];

  // 1. IV vs RV
  const ivRvSpread = d.ivRvSpread;
  if (ivRvSpread > 10) {
    score += 2;
    reasons.push(`IV溢价丰富 (+${ivRvSpread}%)，卖权有正期望`);
  } else if (ivRvSpread > 0) {
    score += 1;
    reasons.push(`IV略高于RV (+${ivRvSpread}%)，溢价一般`);
  } else {
    score -= 3;
    reasons.push(`⚠ IV < RV (${ivRvSpread}%)，期权卖便宜了`);
  }

  // 2. 布林带
  const bb = b.technicals.bb;
  if (bb.squeeze) {
    score -= 3;
    reasons.push(`⚠ 布林带极度收窄 (${bb.width}%, 百分位${bb.percentile}%)，即将突破`);
  } else if (bb.percentile < 30) {
    score -= 1;
    reasons.push(`布林带偏窄 (百分位${bb.percentile}%)，需留意`);
  } else {
    score += 1;
    reasons.push(`布林带正常 (宽度${bb.width}%)，波动空间充足`);
  }

  // 3. ADX
  const adx = b.technicals.adx;
  if (adx.value < 25) {
    score += 2;
    reasons.push(`ADX=${adx.value} < 25，确认震荡市，印钞机模式`);
  } else if (adx.value > 30) {
    score -= 2;
    reasons.push(`⚠ ADX=${adx.value} > 30，趋势已形成`);
  } else {
    reasons.push(`ADX=${adx.value}，处于过渡区间`);
  }

  // 4. Vol Skew
  if (d.skew.skew > 8) {
    reasons.push(`Put偏度高 (${d.skew.skew}%)，低买年化极丰厚`);
  }

  // 5. 宏观事件
  if (m && m.hasUrgent) {
    score -= 3;
    reasons.push(`⚠ ${m.urgentCount}个重大事件在24h内`);
  }

  // 6. MSTR 信号
  const mstrData = cache.get('mstr');
  if (mstrData && mstrData.navPremium) {
    const nav = mstrData.navPremium.multiple;
    if (nav > 2.0) {
      score -= 1;
      reasons.push(`⚠ MSTR NAV ${nav}x 极度FOMO，避免高卖`);
    } else if (nav < 1.0) {
      reasons.push(`MSTR NAV ${nav}x 折价，市场悲观`);
    }
  }
  if (mstrData && mstrData.latestOffering && mstrData.latestOffering.isActive) {
    reasons.push(`MSTR 正在执行融资购BTC，现货买盘持续，偏向低买`);
  }

  // 生成建议
  let signal, level, advice;
  const safeDist = b.technicals.atr.safe15x;

  if (score >= 3) {
    signal = 'green';
    level = '🟢 绿灯';
    advice = `建议选择距离现价 ${safeDist}% 以外、年化 15-20% 区间的产品，优先执行分形低点外侧的"低买"。`;
  } else if (score >= -1) {
    signal = 'yellow';
    level = '🟡 黄灯';
    advice = `谨慎操作，建议年化降至 10-15%，执行价放远至 ${(safeDist * 1.3).toFixed(1)}% 以外。`;
  } else {
    signal = 'red';
    level = '🔴 红灯';
    advice = '今日暂停购买双币赢！资金保留在法币账户或稳定币活期理财赚取利息。';
  }

  return { signal, level, score, reasons, advice };
}

// ─── API 路由 ───

/** 获取全部数据（前端一次性拉取） */
app.get('/api/dashboard', (req, res) => {
  const binanceData = cache.get('binance');
  const deribitData = cache.get('deribit');
  const liqData = cache.get('liquidation');
  const macroData = cache.get('macro');
  const mstrData = cache.get('mstr');
  const decision = cache.get('decision');
  const meta = cache.get('_meta');

  if (!binanceData) {
    return res.status(503).json({ error: '数据尚未就绪，请稍后重试', meta });
  }

  res.json({
    price: binanceData.price,
    volatility: deribitData || null,
    technicals: binanceData.technicals,
    fractals: binanceData.fractals,
    liquidation: liqData || null,
    macro: macroData || null,
    mstr: mstrData || null,
    decision: decision || null,
    meta,
  });
});

/** 单独获取决策信号 */
app.get('/api/decision', (req, res) => {
  const decision = cache.get('decision');
  res.json(decision || { signal: 'yellow', score: 0, reasons: ['等待数据...'] });
});

/** 手动触发刷新 */
app.post('/api/refresh', async (req, res) => {
  try {
    await fetchAndCache();
    res.json({ ok: true, meta: cache.get('_meta') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** 健康检查 */
app.get('/api/health', (req, res) => {
  const meta = cache.get('_meta');
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    lastRefresh: meta?.lastRefresh || null,
  });
});

/** SPA fallback */
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── 定时任务 ───
// 每 5 分钟刷新一次（Binance + Deribit 数据变化频率适中）
cron.schedule('*/5 * * * *', () => {
  fetchAndCache().catch(err => console.error('[Cron] 刷新失败:', err));
});

// 宏观事件每小时检查一次即可
cron.schedule('0 * * * *', () => {
  macro.fetchAll()
    .then(data => {
      cache.set('macro', data);
      // 重算决策
      const decision = computeDecision();
      cache.set('decision', decision);
    })
    .catch(err => console.error('[Cron] 宏观事件刷新失败:', err));
});

// ─── 启动 ───
app.listen(PORT, async () => {
  console.log(`\n🚀 BTC 双币赢决策终端已启动`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   API:  http://localhost:${PORT}/api/dashboard`);
  console.log(`   刷新周期: 每 5 分钟`);
  console.log('');

  // 首次启动立即拉取数据
  await fetchAndCache();
});
