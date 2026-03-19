/**
 * BTC 双币赢决策终端 - 后端服务 v3
 * 双轨独立评分: Sell Put / Sell Call
 */

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const cache = require('./cache');

const binance = require('./services/binance');
const deribit = require('./services/deribit');
const coinglass = require('./services/coinglass');
const macro = require('./services/macro');
const mstr = require('./services/mstr');
const derivatives = require('./services/derivatives');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 数据拉取 ───
async function fetchAndCache() {
  const t = Date.now();
  console.log(`\n${'='.repeat(50)}\n[${new Date().toISOString()}] 数据刷新...`);
  const errors = [];

  try { const d = await binance.fetchAll(); cache.set('binance', d); console.log(`  ✓ Binance $${d.price.price.toLocaleString()}`); } catch(e) { errors.push(`Binance: ${e.message}`); console.error(`  ✗ Binance:`, e.message); }
  try { const d = await deribit.fetchAll(); cache.set('deribit', d); console.log(`  ✓ Deribit IV=${d.iv}% RV=${d.rv}%`); } catch(e) { errors.push(`Deribit: ${e.message}`); console.error(`  ✗ Deribit:`, e.message); }
  try { const p = cache.get('binance')?.price?.price||84000; const d = await coinglass.fetchAll(p); cache.set('liquidation', d); console.log(`  ✓ 清算: ${d.source}`); } catch(e) { errors.push(e.message); }
  try { const d = await macro.fetchAll(); cache.set('macro', d); console.log(`  ✓ 宏观: ${d.events.length}事件`); } catch(e) { errors.push(e.message); }
  try { const p = cache.get('binance')?.price?.price||84000; const d = await mstr.fetchAll(p); cache.set('mstr', d); } catch(e) { errors.push(e.message); }
  try { const p = cache.get('binance')?.price?.price||84000; const d = await derivatives.fetchAll(p); cache.set('derivatives', d); } catch(e) { errors.push(e.message); }

  try {
    const decision = computeDecision();
    cache.set('decision', decision);
    console.log(`  ★ 低买 ${decision.sellPut.score}/100 (${decision.sellPut.grade}) | 高卖 ${decision.sellCall.score}/100 (${decision.sellCall.grade})`);
  } catch(e) { errors.push(`Decision: ${e.message}`); console.error(`  ✗ 决策:`, e.message); }

  console.log(`[完成] ${Date.now()-t}ms, 错误: ${errors.length}\n${'='.repeat(50)}`);
  cache.set('_meta', { lastRefresh: new Date().toISOString(), elapsed: Date.now()-t, errors });
}

// ═══════════════════════════════════════════════════════════════
// 决策引擎 v3: 双轨独立评分 (Sell Put / Sell Call)
// ═══════════════════════════════════════════════════════════════
function computeDecision() {
  const b = cache.get('binance'), d = cache.get('deribit'), m = cache.get('macro');
  const deriv = cache.get('derivatives'), mstrData = cache.get('mstr'), liqData = cache.get('liquidation');

  const empty = { score:0, grade:'加载中', color:'yellow', apy:'0%', factors:[], vetoes:[], alerts:[], strike:{pct:0,price:0} };
  if (!b || !d) return { sellPut:{...empty}, sellCall:{...empty}, strangle:null, globalVetoes:[], topAdvice:[], maxPainHint:null, meta:{signal:'yellow'} };

  const atr=b.technicals.atr, bb=b.technicals.bb, adx=b.technicals.adx;
  const ivRvSpread=d.ivRvSpread, price=b.price?.price||0;
  const fractals=b.fractals||{supports:[],resistances:[]};
  const funding=deriv?.funding, oi=deriv?.oi, cvd=deriv?.cvd, skew=d.skew||{}, maxPain=d.maxPain;

  // ── 全局否决 ──
  const gv = [];
  if (ivRvSpread < 0) gv.push({severity:'red', tag:'负期望', reason:`IV(${d.iv}%)<RV(${d.rv}%)，期权折价`, action:'空仓'});
  if (m?.hasUrgent) { const n=(m.events||[]).filter(e=>e.isUrgent&&e.impact==='high').map(e=>e.name).join('、'); gv.push({severity:'yellow', tag:'宏观风险', reason:`距 ${n} 不足24h`, action:'仅极保守单'}); }
  if (bb.percentile<5 && adx.value>30 && adx.trend==='rising') gv.push({severity:'red', tag:'单边爆发', reason:`BB极低+ADX=${adx.value}↑`, action:'暂停'});
  const hasRed=gv.some(v=>v.severity==='red'), hasYellow=gv.some(v=>v.severity==='yellow');

  // ── 通用评分工具 ──
  function gradeFromScore(s, vetoed) {
    if (vetoed) return {grade:'🚫 熔断', apy:'0%', color:'red'};
    if (hasRed) return {grade:'⛔ 全局停止', apy:'0%', color:'red'};
    if (hasYellow) return {grade:'⚠ 降级', apy:'5-10%', color:'yellow'};
    if (s>=80) return {grade:'🟢 强烈推荐', apy:'20-30%', color:'green'};
    if (s>=60) return {grade:'🟢 推荐', apy:'15-20%', color:'green'};
    if (s>=40) return {grade:'🟡 一般', apy:'10-15%', color:'yellow'};
    return {grade:'🔴 不推荐', apy:'5-10%', color:'red'};
  }
  function calcStrike(s, dir, vetoed) {
    if (vetoed||hasRed) return {pct:0, price:0};
    let pct;
    if (hasYellow) pct=Math.max(10, atr.safe15x*1.5);
    else if (s>=80) pct=atr.pct;
    else if (s>=60) pct=atr.safe15x;
    else if (s>=40) pct=atr.safe15x*1.3;
    else pct=atr.safe15x*1.6;
    pct=Math.round(pct*10)/10;
    return { pct, price: Math.round(price*(dir==='put'? 1-pct/100 : 1+pct/100)) };
  }

  // ═══ 📉 低买评分 (Sell Put) ═══
  // 新权重: 波动率35 + 趋势25 + 微观清算结构30 + 费率辅助10 = 100
  let ps=0; const pf=[], pa=[];
  const zones = liqData?.zones || [];
  const atrAbs = atr.value || (price * atr.pct / 100);

  // 预估执行价 (用 1.5x ATR 作为基准，后续 calcStrike 会微调)
  const estPutStrike = Math.round(price * (1 - atr.safe15x / 100));

  // ── 波动率环境 (35分) ──
  // A. IV溢价 (20)
  if(ivRvSpread>=15){ps+=20;pf.push({n:'IV溢价丰富',s:20,m:20,d:`+${ivRvSpread}%`});}
  else if(ivRvSpread>=8){ps+=15;pf.push({n:'IV溢价充足',s:15,m:20});}
  else if(ivRvSpread>=3){ps+=8;pf.push({n:'IV溢价一般',s:8,m:20});}
  else{ps+=3;pf.push({n:'IV溢价薄弱',s:3,m:20});}

  // B. Put Skew溢价 (15)
  const putPrem=(skew.putIV||0)-(skew.callIV||0);
  if(putPrem>8){ps+=15;pf.push({n:'Put高溢价',s:15,m:15,d:`+${putPrem.toFixed(1)}%`});}
  else if(putPrem>3){ps+=10;pf.push({n:'Put偏度正常',s:10,m:15});}
  else{ps+=5;pf.push({n:'Put偏度平淡',s:5,m:15});}

  // ── 市场趋势 (25分) ──
  // C. ADX震荡 (15)
  if(adx.value<20){ps+=15;pf.push({n:'深度震荡',s:15,m:15});}
  else if(adx.value<25&&adx.trend!=='rising'){ps+=11;pf.push({n:'震荡',s:11,m:15});}
  else if(adx.value<25){ps+=6;pf.push({n:'酝酿突破⚡',s:6,m:15,d:`ADX=${adx.value}↑`});pa.push({level:'warn',msg:`ADX=${adx.value}距25仅差${(25-adx.value).toFixed(1)}且上升`});}
  else if(adx.value<30){ps+=3;pf.push({n:'趋势过渡',s:3,m:15});}
  else{ps+=0;pf.push({n:'⚠强趋势',s:0,m:15});}

  // D. 下方支撑密度 (10)
  const nSup=fractals.supports.filter(s=>Math.abs(s.pct)<8).length;
  if(nSup>=3){ps+=10;pf.push({n:'下方支撑密集',s:10,m:10,d:`${nSup}个`});}
  else if(nSup>=2){ps+=7;pf.push({n:'下方支撑',s:7,m:10});}
  else if(nSup>=1){ps+=3;pf.push({n:'支撑稀疏',s:3,m:10});}
  else{pf.push({n:'无支撑⚠',s:0,m:10});pa.push({level:'warn',msg:'下方无分形支撑'});}

  // ── 执行价微观清算结构 (30分) — 不对称惩罚机制 ──
  // 寻找现价下方、1.5倍ATR范围内的大型多头清算墙
  const longClusters = zones.filter(z =>
    z.side === 'long' && z.price < price && z.price >= (price - 1.5 * atrAbs)
  ).sort((a,b) => b.volume - a.volume);

  if (longClusters.length === 0) {
    // 无清算墙：中性
    ps += 5;
    pf.push({n:'清算结构中性',s:5,m:30,d:'无大型清算墙'});
  } else {
    const maxWall = longClusters[0];
    const wallPriceFmt = '$' + fmt(maxWall.price);
    // 执行价与清算墙的位置关系
    if (estPutStrike > maxWall.price) {
      // 【致命】执行价在清算墙之上 → 挡在猎杀路线上
      const penalty = -30;
      ps += penalty;
      const shown = Math.max(0, 30 + penalty);
      pf.push({n:'🚨挡在猎杀路线', s:shown, m:30, d:`执行价>${wallPriceFmt}`});
      pa.push({level:'danger', msg:`多头清算墙 ${wallPriceFmt}，你的执行价 $${fmt(estPutStrike)} 在其上方，会成为扫损炮灰！执行价必须低于 ${wallPriceFmt}`});
    } else {
      const distPct = (estPutStrike - maxWall.price) / maxWall.price;
      if (distPct >= -0.01) {
        // 【极危】紧贴清算墙下沿，滑点可穿透
        ps += -20;
        pf.push({n:'⚠紧贴清算墙', s:0, m:30, d:`距 ${wallPriceFmt} 仅${(distPct*100).toFixed(1)}%`});
        pa.push({level:'danger', msg:`执行价紧贴清算墙 ${wallPriceFmt} 下沿，爆仓滑点可直接穿透`});
      } else if (distPct >= -0.05) {
        // 【极佳】藏在清算墙下方 1%-5%，完美护城河
        const volBonus = Math.min(10, longClusters.length * 3);
        const score = 20 + volBonus;
        ps += score;
        pf.push({n:'🛡清算墙护城河', s:Math.min(30,score), m:30, d:`${wallPriceFmt} 做肉盾 (${longClusters.length}簇)`});
      } else {
        // 执行价很深，安全但没吃到护城河红利
        ps += 8;
        pf.push({n:'清算墙较远', s:8, m:30, d:`距 ${wallPriceFmt} >${Math.abs(distPct*100).toFixed(1)}%`});
      }
    }
  }

  // ── 费率辅助 (10分) ──
  if(funding?.annualized<-20){ps+=10;pf.push({n:'极度负费率(反转)',s:10,m:10,d:`${funding.annualized.toFixed(0)}%`});}
  else if(funding?.annualized<-5){ps+=7;pf.push({n:'负费率',s:7,m:10});}
  else if(funding?.annualized<15){ps+=5;pf.push({n:'费率正常',s:5,m:10});}
  else if(funding?.annualized>50){ps+=0;pf.push({n:'⚠多头过热',s:0,m:10,d:`${funding.annualized.toFixed(0)}%`});pa.push({level:'danger',msg:`资金费率${funding.annualized.toFixed(0)}%极端`});}
  else{ps+=2;pf.push({n:'费率偏高',s:2,m:10});}

  // Max Pain低买提示
  if(maxPain?.direction==='below'&&Math.abs(maxPain.distPct)<3) pa.push({level:'danger',msg:`Max Pain $${maxPain.strike.toLocaleString()} 在下方仅${maxPain.distPct}%，低买执行价须低于此`});

  ps=Math.max(0, Math.min(100, ps));

  // ═══ 📈 高卖评分 (Sell Call) ═══
  // 新权重: 波动率35 + 趋势25 + 微观清算结构30 + 费率辅助10 = 100
  let cs=0; const cf=[], cv=[], ca=[];
  const estCallStrike = Math.round(price * (1 + atr.safe15x / 100));

  // 高卖一票否决
  const mstrLastBuy = mstrData?.lastPurchase?.date ? new Date(mstrData.lastPurchase.date) : null;
  const mstrBuyWithin24h = mstrLastBuy && (Date.now() - mstrLastBuy.getTime()) < 24 * 3600000;
  if (mstrBuyWithin24h) {
    cv.push({tag:'MSTR 24h内购买',reason:`MSTR ${mstrLastBuy.toISOString().slice(0,10)} 刚购入 ${mstrData.lastPurchase.btcAmount?.toLocaleString()||''} BTC，现货买盘冲击中`});
    ca.push({level:'danger',msg:'MSTR 24h内宣布购买BTC，高卖熔断'});
  } else if (mstrData?.latestOffering?.isActive) {
    ca.push({level:'danger',msg:'MSTR正在执行融资计划购BTC，高卖需极度谨慎（非熔断）'});
  }
  const callVetoed=cv.length>0;

  // ── 波动率环境 (35分) ──
  // A. IV溢价 (15)
  if(ivRvSpread>=15){cs+=15;cf.push({n:'IV溢价丰富',s:15,m:15});}
  else if(ivRvSpread>=8){cs+=10;cf.push({n:'IV溢价充足',s:10,m:15});}
  else if(ivRvSpread>=3){cs+=6;cf.push({n:'IV溢价一般',s:6,m:15});}
  else{cs+=2;cf.push({n:'IV溢价薄弱',s:2,m:15});}

  // B. Call Skew FOMO (10)
  const callPrem=(skew.callIV||0)-(skew.putIV||0);
  if(callPrem>5){cs+=10;cf.push({n:'Call FOMO溢价',s:10,m:10,d:`+${callPrem.toFixed(1)}%`});}
  else if(callPrem>0){cs+=6;cf.push({n:'Call偏度轻微',s:6,m:10});}
  else{cs+=2;cf.push({n:'无Call溢价',s:2,m:10});}

  // C. CVD 背离=假突破 (10)
  if(cvd?.divergence==='bearish_divergence'){cs+=10;cf.push({n:'假突破(CVD背离)',s:10,m:10,d:'合约拉盘+现货抛售'});}
  else if(cvd?.divergence==='aligned'&&cvd.spotTrend==='selling'){cs+=6;cf.push({n:'现货在卖',s:6,m:10});}
  else if(cvd?.divergence==='aligned'){cs+=2;cf.push({n:'上涨真实⚠',s:2,m:10});ca.push({level:'warn',msg:'CVD一致，上涨有真实动能'});}
  else{cs+=5;cf.push({n:'CVD中性',s:5,m:10});}

  // ── 市场趋势 (25分) ──
  // D. ADX震荡 (15)
  if(adx.value<20){cs+=15;cf.push({n:'深度震荡',s:15,m:15});}
  else if(adx.value<25&&adx.trend!=='rising'){cs+=11;cf.push({n:'震荡',s:11,m:15});}
  else if(adx.value<25){cs+=6;cf.push({n:'酝酿突破',s:6,m:15});}
  else if(adx.value<30){cs+=3;cf.push({n:'趋势过渡',s:3,m:15});}
  else{cs+=0;cf.push({n:'⚠强趋势',s:0,m:15});}

  // E. 上方阻力密度 (10)
  const nRes=fractals.resistances.filter(r=>Math.abs(r.pct)<8).length;
  if(nRes>=3){cs+=10;cf.push({n:'阻力沉重',s:10,m:10,d:`${nRes}个`});}
  else if(nRes>=2){cs+=7;cf.push({n:'有阻力',s:7,m:10});}
  else if(nRes>=1){cs+=3;cf.push({n:'阻力稀疏',s:3,m:10});}
  else{cf.push({n:'无阻力⚠',s:0,m:10});ca.push({level:'warn',msg:'上方无阻力，卖飞风险高'});}

  // ── 执行价微观清算结构 (30分) — 不对称惩罚机制 ──
  // 寻找现价上方、1.5倍ATR范围内的大型空头清算墙
  // 轧空比踩踏更剧烈（上行无理论天花板），惩罚更重
  const shortClusters = zones.filter(z =>
    z.side === 'short' && z.price > price && z.price <= (price + 1.5 * atrAbs)
  ).sort((a,b) => b.volume - a.volume);

  if (shortClusters.length === 0) {
    // 无轧空风险，略加分
    cs += 8;
    cf.push({n:'无轧空风险',s:8,m:30,d:'上方无大型空头清算'});
  } else {
    const maxWall = shortClusters[0];
    const wallPriceFmt = '$' + fmt(maxWall.price);

    if (estCallStrike < maxWall.price) {
      // 【致命】执行价在轧空目标价下方，爆拉行情会直接击穿
      const penalty = -40;
      cs += penalty;
      const shown = Math.max(0, 30 + penalty);
      cf.push({n:'🚨轧空猎杀路线', s:shown, m:30, d:`执行价<${wallPriceFmt}`});
      ca.push({level:'danger', msg:`空头清算墙 ${wallPriceFmt}，你的执行价 $${fmt(estCallStrike)} 在其下方！做市商拉爆空头时你会被直接击穿卖飞！执行价必须高于 ${wallPriceFmt}`});
    } else {
      const distPct = (estCallStrike - maxWall.price) / maxWall.price;
      if (distPct <= 0.015) {
        // 【危险】紧贴清算墙上方，轧空的市价买盘可冲破
        cs += -15;
        cf.push({n:'⚠紧贴轧空区', s:0, m:30, d:`距 ${wallPriceFmt} 仅+${(distPct*100).toFixed(1)}%`});
        ca.push({level:'danger', msg:`执行价紧贴空头清算墙 ${wallPriceFmt} 上方，轧空上影线可穿透`});
      } else if (distPct <= 0.08) {
        // 【安全】藏在轧空高潮点上方 >1.5%，庄家猎杀完通常回落
        const volBonus = Math.min(8, shortClusters.length * 2);
        const score = 18 + volBonus;
        cs += score;
        cf.push({n:'🛡轧空天花板护盾', s:Math.min(30,score), m:30, d:`${wallPriceFmt} 轧空后回落保护 (${shortClusters.length}簇)`});
      } else {
        // 执行价很高，安全但没吃到护盾红利
        cs += 6;
        cf.push({n:'清算结构较远', s:6, m:30, d:`距 ${wallPriceFmt} >${(distPct*100).toFixed(1)}%`});
      }
    }
  }

  // ── 费率辅助 (10分) ──
  if(funding?.annualized>50){cs+=10;cf.push({n:'多头极拥挤',s:10,m:10,d:`${funding.annualized.toFixed(0)}%`});}
  else if(funding?.annualized>25){cs+=7;cf.push({n:'多头偏拥挤',s:7,m:10});}
  else if(funding?.annualized>10){cs+=3;cf.push({n:'费率正常',s:3,m:10});}
  else{cs+=0;cf.push({n:'费率低/负',s:0,m:10});}

  // MSTR 现货买盘风险 (罚分项，非熔断)
  if (mstrBuyWithin24h) {
    // 已在否决区处理
  } else if (mstrData?.latestOffering?.isActive) {
    cs = Math.max(0, cs - 15);
    cf.push({n:'⚠MSTR融资买入中', s:0, m:15, d:'罚-15分'});
  }

  if(maxPain?.direction==='above'&&Math.abs(maxPain.distPct)<3) ca.push({level:'danger',msg:`Max Pain $${maxPain.strike.toLocaleString()} 在上方仅${maxPain.distPct}%，高卖须高于此`});

  cs=Math.max(0, Math.min(100, cs));

  // ── 生成建议 ──
  const pg=gradeFromScore(ps,false), cg=gradeFromScore(cs,callVetoed);
  const pStrike=calcStrike(ps,'put',false), cStrike=calcStrike(cs,'call',callVetoed);

  const topAdvice=[];
  if(callVetoed) topAdvice.push(`高卖熔断: ${cv.map(v=>v.reason).join('; ')}`);
  if(maxPain) topAdvice.push(`周五 Max Pain: $${maxPain.strike.toLocaleString()} (${maxPain.direction==='above'?'上方↑':'下方↓'} ${maxPain.distPct>0?'+':''}${maxPain.distPct}%)`);

  // 宽跨式检测
  let strangle=null;
  if(!hasRed&&!hasYellow&&!callVetoed&&ps>=60&&cs>=60) {
    strangle={recommended:true, putStrike:pStrike.price, callStrike:cStrike.price,
      note:`双向收租: 低买<$${pStrike.price.toLocaleString()} 且 高卖>$${cStrike.price.toLocaleString()}`};
  }

  return {
    sellPut: { score:ps, ...pg, factors:pf, vetoes:[...gv], alerts:pa, strike:pStrike },
    sellCall: { score:cs, ...cg, factors:cf, vetoes:[...gv,...cv], callVetoed, alerts:ca, strike:cStrike },
    strangle, globalVetoes:gv, topAdvice,
    maxPainHint: maxPain ? `Max Pain: $${maxPain.strike.toLocaleString()} (${maxPain.direction==='above'?'上方':'下方'} ${maxPain.distPct>0?'+':''}${maxPain.distPct}%)` : null,
    meta: { signal: hasRed?'red':hasYellow?'yellow':(callVetoed&&ps<40)?'yellow':'green', currentPrice:price },
  };
}

// ─── API ───
app.get('/api/dashboard', (req, res) => {
  const b=cache.get('binance'); if(!b) return res.status(503).json({error:'数据未就绪'});
  res.json({
    price:b.price, volatility:cache.get('deribit'), technicals:b.technicals, fractals:b.fractals,
    liquidation:cache.get('liquidation'), macro:cache.get('macro'), mstr:cache.get('mstr'),
    derivatives:cache.get('derivatives'), decision:cache.get('decision'), meta:cache.get('_meta'),
  });
});
app.get('/api/decision', (req,res) => res.json(cache.get('decision')||{meta:{signal:'yellow'}}));
app.post('/api/refresh', async(req,res) => { try{await fetchAndCache();res.json({ok:true});}catch(e){res.status(500).json({error:e.message});} });
app.get('/api/health', (req,res) => { const m=cache.get('_meta'); res.json({status:'ok',uptime:process.uptime(),lastRefresh:m?.lastRefresh}); });
app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ─── Cron ───
cron.schedule('*/5 * * * *', () => fetchAndCache().catch(e=>console.error('[Cron]',e)));
cron.schedule('0 * * * *', () => {
  macro.fetchAll().then(d=>{cache.set('macro',d);cache.set('decision',computeDecision());}).catch(()=>{});
});

app.listen(PORT, async () => {
  console.log(`\n🚀 BTC 双币赢决策终端 v3 (双轨评分)`);
  console.log(`   http://localhost:${PORT}\n`);
  await fetchAndCache();
});
