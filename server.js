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
const derivatives = require('./services/derivatives');

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

  // 6. 衍生品指标 (Funding, OI, CVD)
  try {
    const binanceCache = cache.get('binance');
    const btcPrice = binanceCache?.price?.price || 84000;
    const derivData = await derivatives.fetchAll(btcPrice);
    cache.set('derivatives', derivData);
  } catch (err) {
    errors.push(`Derivatives: ${err.message}`);
    console.error(`  ✗ 衍生品指标失败:`, err.message);
  }

  // 7. 计算综合决策
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

// ─── 决策引擎 v2: 约束主导型 (Constraint-Led) ───
function computeDecision() {
  const b = cache.get('binance');
  const d = cache.get('deribit');
  const m = cache.get('macro');
  const deriv = cache.get('derivatives');
  const mstrData = cache.get('mstr');

  if (!b || !d) {
    return { signal: 'yellow', level: '🟡 数据加载中', score: 0, targetAPY: '5-10%',
      strikeDist: '10%', bottleneck: '数据不完整，等待刷新', positives: [], vetoes: [],
      factors: {}, reasons: ['数据不完整'], advice: '等待数据加载...' };
  }

  const atr = b.technicals.atr;
  const bb = b.technicals.bb;
  const adx = b.technicals.adx;
  const ivRvSpread = d.ivRvSpread;
  const currentPrice = b.price?.price || 0;

  // ═══════════════════════════════════════════════
  // 第一阶段: 一票否决 (Hard Constraints / Vetoes)
  // 只要触发任意一条，直接输出红灯或黄灯降级
  // ═══════════════════════════════════════════════
  const vetoes = [];

  // 否决1: IV < RV → 红灯
  if (ivRvSpread < 0) {
    vetoes.push({
      severity: 'red',
      tag: '负期望',
      reason: `IV (${d.iv}%) < RV (${d.rv}%)，期权在折价卖，承担风险无溢价补偿`,
      action: '空仓，转入稳定币借贷协议赚取无风险收益',
    });
  }

  // 否决2: 宏观事件 24h 内 → 黄灯
  if (m && m.hasUrgent && m.urgentCount > 0) {
    const urgentNames = (m.events || []).filter(e => e.isUrgent && e.impact === 'high')
      .map(e => `${e.name}(${e.countdown})`).join('、');
    vetoes.push({
      severity: 'yellow',
      tag: '宏观风险',
      reason: `距 ${urgentNames} 不足24h，数据公布瞬间将出现无序宽幅震荡`,
      action: '仅允许现价±10%以外、年化5%的极保守单，或空仓',
    });
  }

  // 否决3: BB极度收窄 + ADX突破30 → 红灯
  if (bb.percentile < 5 && adx.value > 30 && adx.trend === 'rising') {
    vetoes.push({
      severity: 'red',
      tag: '单边爆发',
      reason: `布林带处于5%极低分位 (${bb.percentile}%) 且 ADX=${adx.value} 向上发散，单边趋势正在成型`,
      action: '暂停交易，等待趋势确立后再做顺势单边双币赢',
    });
  } else if (bb.squeeze) {
    vetoes.push({
      severity: 'yellow',
      tag: '波动压缩',
      reason: `布林带极度收窄 (宽度${bb.width}%, 百分位${bb.percentile}%)，即将突破`,
      action: '降级至年化5-10%，执行价放极宽',
    });
  }

  // 否决4: 资金费率极端 → 黄灯
  if (deriv && deriv.funding && deriv.funding.isExtreme) {
    vetoes.push({
      severity: 'yellow',
      tag: '杠杆过热',
      reason: `资金费率年化 ${deriv.funding.annualized}% (>50%)，多头极度拥挤，随时踩踏`,
      action: '低买执行价必须放极深 (现价-10%)，或暂停',
    });
  }

  // 否决5: OI/市值极端 → 黄灯
  if (deriv && deriv.oi && deriv.oi.isHighOI) {
    vetoes.push({
      severity: 'yellow',
      tag: '杠杆堆积',
      reason: `OI/市值占比 ${deriv.oi.oiMarketCapRatio}% (>3.5%)，杠杆风暴即将来临`,
      action: '降低仓位或只接年化5%的极低风险单',
    });
  }

  // 判断否决结果
  const hasRedVeto = vetoes.some(v => v.severity === 'red');
  const hasYellowVeto = vetoes.some(v => v.severity === 'yellow');

  if (hasRedVeto) {
    const mainVeto = vetoes.find(v => v.severity === 'red');
    return {
      signal: 'red',
      level: '🔴 红灯停止交易',
      score: 0,
      targetAPY: '0%',
      strikeDist: '∞',
      bottleneck: `【${mainVeto.tag}】${mainVeto.reason}`,
      bottleneckAction: mainVeto.action,
      positives: [],
      vetoes,
      alerts: vetoes.map(v => ({ level: v.severity === 'red' ? 'danger' : 'warn', module: v.tag, msg: v.reason })),
      factors: {},
      reasons: vetoes.map(v => `⛔ [${v.tag}] ${v.reason}`),
      advice: mainVeto.action,
    };
  }

  if (hasYellowVeto) {
    const mainVeto = vetoes.find(v => v.severity === 'yellow');
    const vetoStrikeDist = Math.max(8, atr.safe15x * 1.5);
    const vetoLow = currentPrice > 0 ? Math.round(currentPrice * (1 - vetoStrikeDist / 100)) : 0;
    const vetoHigh = currentPrice > 0 ? Math.round(currentPrice * (1 + vetoStrikeDist / 100)) : 0;
    return {
      signal: 'yellow',
      level: '🟡 黄灯降级交易',
      score: 0,
      targetAPY: '5-10%',
      strikeDist: `${vetoStrikeDist.toFixed(0)}%`,
      strikeAbsolute: { low: vetoLow, high: vetoHigh, onlyLow: false },
      bottleneck: `【${mainVeto.tag}】${mainVeto.reason}`,
      bottleneckAction: mainVeto.action,
      positives: [],
      vetoes,
      alerts: vetoes.map(v => ({ level: v.severity === 'red' ? 'danger' : 'warn', module: v.tag, msg: v.reason })),
      factors: {},
      reasons: vetoes.map(v => `⚠ [${v.tag}] ${v.reason}`),
      advice: currentPrice > 0
        ? `${mainVeto.action}。低买 < $${vetoLow.toLocaleString()} · 高卖 > $${vetoHigh.toLocaleString()} (±${vetoStrikeDist.toFixed(0)}%)`
        : mainVeto.action,
    };
  }

  // ═══════════════════════════════════════════════
  // 第二阶段: 权重打分 (满分100，决定年化目标)
  // 通过一票否决 = 绿灯，但要决定进攻强度
  // ═══════════════════════════════════════════════
  const factors = {};
  const alerts = []; // 底层警报透传

  // 因子1: 波动率溢价 (权重40%) — IV/RV Spread
  let volScore = 0;
  if (ivRvSpread >= 20) volScore = 40;
  else if (ivRvSpread >= 15) volScore = 35;
  else if (ivRvSpread >= 10) volScore = 30;
  else if (ivRvSpread >= 5) volScore = 20;
  else volScore = 10;
  factors.volatility = { score: volScore, max: 40, detail: `IV-RV=${ivRvSpread}%` };

  // 因子2: 市场震荡 (权重30%) — ADX + BB
  // ★ ADX 缓冲带: 20-25且上升 = 酝酿突破期，不再视为安全震荡
  let rangeScore = 0;
  if (adx.value < 20) {
    rangeScore += 20; // 真正的印钞机震荡
  } else if (adx.value < 25 && adx.trend !== 'rising') {
    rangeScore += 15; // 低ADX但没在上升，尚可
  } else if (adx.value < 25 && adx.trend === 'rising') {
    rangeScore += 8;  // ★ 酝酿突破: ADX 20-25 且上升
    alerts.push({
      level: 'warn', module: 'M2',
      msg: `ADX=${adx.value} 距警戒线25仅差 ${(25-adx.value).toFixed(1)} 且上升中，趋势正在酝酿，建议缩短期限至24h或降低年化`,
    });
  } else if (adx.value < 28) {
    rangeScore += 5;
    alerts.push({ level: 'warn', module: 'M2', msg: `ADX=${adx.value} 进入过渡区间，趋势可能正在形成` });
  } else {
    rangeScore += 2;
    alerts.push({ level: 'danger', module: 'M2', msg: `ADX=${adx.value} 趋势已确立，双币赢被击穿风险高` });
  }
  // BB 正常范围加分
  if (bb.percentile > 30 && bb.percentile < 70) rangeScore += 10;
  else if (bb.percentile > 15) rangeScore += 5;
  else {
    alerts.push({ level: 'warn', module: 'M2', msg: `布林带宽度处于 ${bb.percentile}% 低分位，波动可能骤增` });
  }
  rangeScore = Math.min(30, rangeScore);
  factors.range = { score: rangeScore, max: 30, detail: `ADX=${adx.value}(${adx.trend}), BB=${bb.percentile}%分位` };

  // 因子3: 微观结构安全边际 (权重30%)
  let safetyScore = 0;
  if (atr.safe15x >= 5) safetyScore += 10;
  else if (atr.safe15x >= 3.5) safetyScore += 7;
  else safetyScore += 3;
  // 分形防护
  const fractals = b.fractals;
  if (fractals.supports.length >= 2 && fractals.resistances.length >= 2) safetyScore += 8;
  else if (fractals.supports.length >= 1) safetyScore += 4;
  // CVD 一致性
  if (deriv && deriv.cvd && deriv.cvd.divergence === 'aligned') {
    safetyScore += 7;
  } else if (deriv && deriv.cvd && deriv.cvd.divergence === 'bearish_divergence') {
    safetyScore += 2;
    alerts.push({
      level: 'danger', module: 'M6-CVD',
      msg: '合约现货 CVD 背离：合约拉盘但现货在抛售，上涨极脆弱，典型假突破信号',
    });
  } else if (deriv && deriv.cvd && deriv.cvd.divergence === 'bullish_divergence') {
    safetyScore += 5;
    alerts.push({ level: 'info', module: 'M6-CVD', msg: '现货吸筹但合约做空，存在潜在轧空机会' });
  } else {
    safetyScore += 5;
  }
  // 资金费率健康
  if (deriv && deriv.funding && Math.abs(deriv.funding.annualized) < 15) {
    safetyScore += 5;
  } else if (deriv && deriv.funding) {
    safetyScore += 2;
    if (deriv.funding.annualized > 30) {
      alerts.push({ level: 'warn', module: 'M6-FR', msg: `资金费率年化 ${deriv.funding.annualized.toFixed(0)}%，多头拥挤` });
    }
  }
  safetyScore = Math.min(30, safetyScore);
  factors.safety = { score: safetyScore, max: 30, detail: `ATR=${atr.safe15x}%, CVD=${deriv?.cvd?.divergence || 'N/A'}` };

  const totalScore = volScore + rangeScore + safetyScore;

  // ═══════════════════════════════════════════════
  // 第三阶段: 信号冲突检测 (Divergence Alert)
  // 当底层因子出现严重多空互斥时，强制拉宽执行价
  // ═══════════════════════════════════════════════
  let conflictPenalty = false;
  let conflictMsg = '';

  // 检测: CVD=假突破(利空) + MaxPain向上引力/MSTR利多 = 严重冲突
  const cvdBearish = deriv?.cvd?.divergence === 'bearish_divergence';
  const maxPainBullish = d.maxPain && d.maxPain.direction === 'above';
  const mstrBullish = mstrData?.latestOffering?.isActive;

  if (cvdBearish && (maxPainBullish || mstrBullish)) {
    conflictPenalty = true;
    const bullSources = [];
    if (maxPainBullish) bullSources.push(`Max Pain 在上方 $${d.maxPain.strike.toLocaleString()}`);
    if (mstrBullish) bullSources.push('MSTR 持续买入');
    conflictMsg = `多空信号严重冲突：CVD 显示假突破(利空)，但 ${bullSources.join(' + ')} (利多)。上涨是纯杠杆推动，极脆弱。`;
    alerts.push({ level: 'danger', module: '冲突检测', msg: conflictMsg });
  }

  // 检测: 资金费率高+CVD背离 = 杠杆假繁荣
  if (deriv?.funding?.annualized > 30 && cvdBearish) {
    if (!conflictPenalty) {
      conflictPenalty = true;
      conflictMsg = `杠杆假繁荣：资金费率 ${deriv.funding.annualized.toFixed(0)}% 偏高 + 现货 CVD 抛售，上涨全靠合约撑，极不稳定。`;
      alerts.push({ level: 'danger', module: '冲突检测', msg: conflictMsg });
    }
  }

  // 生成正面因子列表
  const positives = [];
  if (ivRvSpread >= 10) positives.push(`IV溢价充足 (IV-RV=+${ivRvSpread}%)`);
  if (adx.value < 20) positives.push(`ADX=${adx.value} 深度震荡，印钞机模式`);
  else if (adx.value < 25 && adx.trend !== 'rising') positives.push(`ADX=${adx.value} 低位震荡`);
  if (bb.percentile > 30 && bb.percentile < 70) positives.push(`布林带宽度正常`);
  if (deriv?.cvd?.divergence === 'aligned') positives.push(`现货与合约方向一致`);
  if (deriv?.funding && Math.abs(deriv.funding.annualized) < 15) positives.push(`资金费率健康`);

  // 映射决策（冲突时强制降级执行价）
  let targetAPY, strikeDist, level;
  const baseStrike15 = atr.safe15x;

  if (conflictPenalty) {
    // 冲突: 分数不变，但执行价强制拉宽，且只建议低买
    const conflictStrike = Math.max(8, baseStrike15 * 1.4);
    if (totalScore > 80) {
      targetAPY = '15-20%';
      level = '🟡 绿灯但有冲突';
    } else if (totalScore > 50) {
      targetAPY = '10-15%';
      level = '🟡 绿灯但有冲突';
    } else {
      targetAPY = '5-10%';
      level = '🟡 绿灯但有冲突';
    }
    strikeDist = `${conflictStrike.toFixed(1)}%`;
  } else if (totalScore > 80) {
    targetAPY = '20-30%';
    strikeDist = `${atr.pct.toFixed(1)}%`;
    level = '🟢 绿灯最佳窗口';
  } else if (totalScore > 50) {
    targetAPY = '15-20%';
    strikeDist = `${baseStrike15.toFixed(1)}%`;
    level = '🟢 绿灯可做';
  } else {
    targetAPY = '10-15%';
    strikeDist = `${(baseStrike15 * 1.3).toFixed(1)}%`;
    level = '🟢 绿灯保守';
  }

  // 方向建议
  let directionHint = '';
  if (conflictPenalty) {
    directionHint = '⚠ 只做极深低买 (Sell Put)，不碰高卖';
  } else if (mstrData?.latestOffering?.isActive) {
    directionHint = '偏向低买 (MSTR持续买入现货)';
  }
  if (mstrData?.navPremium?.multiple > 2.0) {
    directionHint = '避免高卖 (MSTR NAV极度FOMO)';
  }
  if (cvdBearish && !conflictPenalty) {
    directionHint += (directionHint ? ' · ' : '') + '做高卖胜率高 (CVD假突破)';
  }

  // Max Pain 提示
  let maxPainHint = '';
  if (d.maxPain) {
    const mpDir = d.maxPain.direction === 'above' ? '上方↑价格被向上吸引' : '下方↓价格被向下拽';
    maxPainHint = `周五 Max Pain: $${d.maxPain.strike.toLocaleString()} (${mpDir}, 距现价${d.maxPain.distPct > 0 ? '+' : ''}${d.maxPain.distPct}%)`;
  }

  // Compute absolute strike prices for the advice
  const strikeDistNum = parseFloat(strikeDist) || 0;
  const lowStrikePrice = currentPrice > 0 ? Math.round(currentPrice * (1 - strikeDistNum / 100)) : 0;
  const highStrikePrice = currentPrice > 0 ? Math.round(currentPrice * (1 + strikeDistNum / 100)) : 0;
  const onlyLowBuy = conflictPenalty || (directionHint && (directionHint.includes('只做') || directionHint.includes('低买') || directionHint.includes('避免高卖')));

  let adviceText;
  if (onlyLowBuy && currentPrice > 0) {
    adviceText = `建议年化 ${targetAPY}，仅做低买 (Sell Put)，挂单价 < $${lowStrikePrice.toLocaleString()} (距现价>${strikeDistNum}%)。${directionHint ? directionHint + '。' : ''}`;
  } else if (currentPrice > 0) {
    adviceText = `建议年化 ${targetAPY}。低买挂单 < $${lowStrikePrice.toLocaleString()} · 高卖挂单 > $${highStrikePrice.toLocaleString()} (±${strikeDistNum}%)。${directionHint ? directionHint + '。' : ''}`;
  } else {
    adviceText = `建议年化 ${targetAPY}，执行价距离现价 ±${strikeDist} 以外。`;
  }

  return {
    signal: conflictPenalty ? 'yellow' : 'green',
    level,
    score: totalScore,
    targetAPY,
    strikeDist,
    strikeAbsolute: { low: lowStrikePrice, high: highStrikePrice, onlyLow: !!onlyLowBuy },
    bottleneck: conflictPenalty ? conflictMsg : null,
    bottleneckAction: conflictPenalty ? '执行价强制拉宽，仅做极深低买' : null,
    positives,
    vetoes: [],
    alerts,
    factors,
    directionHint,
    maxPainHint,
    reasons: [
      `综合评分 ${totalScore}/100: 波动率${volScore}/40 + 震荡${rangeScore}/30 + 安全${safetyScore}/30`,
      ...positives.map(p => `✅ ${p}`),
      ...alerts.filter(a => a.level === 'danger').map(a => `🚨 [${a.module}] ${a.msg}`),
      directionHint ? `📊 ${directionHint}` : null,
      maxPainHint ? `🎯 ${maxPainHint}` : null,
    ].filter(Boolean),
    advice: adviceText,
  };
}

// ─── API 路由 ───

/** 获取全部数据（前端一次性拉取） */
app.get('/api/dashboard', (req, res) => {
  const binanceData = cache.get('binance');
  const deribitData = cache.get('deribit');
  const liqData = cache.get('liquidation');
  const macroData = cache.get('macro');
  const mstrData = cache.get('mstr');
  const derivData = cache.get('derivatives');
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
    derivatives: derivData || null,
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
