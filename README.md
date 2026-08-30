# BTC 双币赢决策终端（dual-btc-win）

轻量 Node.js 后端 + 单页静态前端的 BTC 双币赢辅助决策系统。聚合 Binance、Deribit、Coinglass、Finnhub 的公开数据，在服务端跑一套**双轨独立评分引擎**（低买 Sell Put / 高卖 Sell Call 各自 0–100 分），输出五档风控档位、动态执行价、以及「期限 × APR」联合建议矩阵。

- **线上地址**：https://dualhedge.ai
- **部署平台**：Railway（NIXPACKS，配置见 `railway.json`）
- **仓库**：`cryptogqw/dual-btc-win`（Public）
- **姊妹项目**：https://dualwin.ai（`cryptogqw/btc-dual-investment`）—— 做的是 Binance/OKX/Bitget 三家产品比价与个人持仓追踪，Python/Flask + SQLite。两个项目仓库分开、部署分开、数据不互通。定位差异：**dualwin 回答「买哪个产品」，dualhedge 回答「今天该不该做、做多远、做多大」**。

---

## 一、技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 运行时 | Node.js ≥ 18 | `package.json` 里 `engines` 有约束 |
| 框架 | Express 4.18 | 兼做 API 与静态文件托管 |
| 定时任务 | node-cron 3.0 | 5 分钟拉数据，1 小时刷宏观 |
| 跨域 | cors 2.8 | 当前全开 |
| **状态存储** | **纯内存**（`cache.js` 里的 `Map`） | **没有数据库**。重启即全部丢失，下次拉取重建 |
| 前端 | 单个 `public/index.html`，1747 行 | 无框架、无构建步骤，内联 CSS + JS |
| 前端存储 | localStorage | 只存两项：`dualwin-lang`（语言）、`dualwin-fs`（字号） |

> **无持久化层**是有意为之：所有数据都是可再获取的行情快照，没有用户数据，重启后 5 分钟内自动恢复。这一点和姊妹项目 dualwin 正相反（那边有 SQLite 存个人持仓，必须挂 Volume）。

---

## 二、目录结构

```
dual-btc-win/
├── server.js               # 入口：Express + Cron + 决策引擎（498 行，核心）
├── cache.js                # 内存缓存类：set/get/getAge/snapshot（44 行）
├── services/
│   ├── binance.js          # 现货价 + K线 + ATR/BB/ADX/分形（254 行）
│   ├── deribit.js          # IV / RV / Vol Skew / Max Pain（236 行）
│   ├── derivatives.js      # 资金费率 / OI / 现货-合约 CVD（163 行）
│   ├── coinglass.js        # 清算热力图，双模式（111 行）
│   ├── mstr.js             # MSTR 持仓 / NAV 溢价 / SEC 备案（249 行）
│   └── macro.js            # 宏观事件日历（117 行）
├── public/
│   └── index.html          # 全部前端（1747 行，含中英 i18n）
├── package.json
├── railway.json            # Railway 部署配置（含健康检查）
├── Dockerfile              # 备选部署方式
├── DEPLOY.md               # 面向零命令行用户的部署图文步骤
└── README.md
```

---

## 三、架构

```
        每 5 分钟 (cron */5 * * * *)
   ┌──────────────────────────────────────────────┐
   │              fetchAndCache()                 │
   │  逐个 try/catch，单个数据源失败不影响其他       │
   └──┬───────┬───────┬───────┬───────┬───────────┘
      ▼       ▼       ▼       ▼       ▼
  Binance  Deribit Coinglass MSTR  Finnhub
  现货/K线  IV/RV/  清算热力  持仓/  宏观日历
  技术指标  Skew/   (可选Key) NAV/   (可选Key)
  Binance  MaxPain          SEC
  Futures
  费率/OI/CVD
      │       │       │       │       │
      └───────┴───┬───┴───────┴───────┘
                  ▼
        ┌───────────────────┐
        │  cache (内存 Map)  │  key: binance / deribit / liquidation /
        │                   │       macro / mstr / derivatives /
        └─────────┬─────────┘       decision / _meta
                  ▼
        ┌───────────────────────────┐
        │  computeDecision()        │  ← 每次拉取后立即重算
        │  双轨评分 + 五档风控        │
        │  + 期限矩阵 + 仓位建议      │
        └─────────┬─────────────────┘
                  ▼
             cache['decision']
                  │
                  │  GET /api/dashboard
                  ▼          ▲
        ┌─────────────────────────┐
        │  public/index.html       │  每 60 秒轮询一次缓存
        │  六大模块 + 中英切换       │  手动刷新走 POST /api/refresh
        └─────────────────────────┘
```

关键点：**前端从不直接碰任何交易所**。所有外部请求都在服务端完成，前端只读一个已经算好的缓存快照。这是为什么日本本地网络访问 Binance 受限也不影响使用。

---

## 四、决策引擎（`server.js` 的 `computeDecision()`）

这是整个项目的核心，也是最值得先读的部分。

### 4.1 全局否决门（两轨共用）

任一触发就压制评分档位：

| 条件 | 级别 | 含义 | 动作 |
|---|---|---|---|
| `IV < RV`（IV-RV 价差为负） | 🔴 红 | 期权折价，卖方期望为负 | 空仓 |
| 24h 内有 high-impact 宏观事件 | 🟡 黄 | FOMC / CPI / 非农临近 | 仅极保守单 |
| BB 百分位 < 5 且 ADX > 30 且上升 | 🔴 红 | 布林极度收窄 + 趋势启动 = 单边爆发前夜 | 暂停 |

### 4.2 双轨评分权重（各 100 分）

两轨用**同样的四个维度、同样的权重**，但每一档的判据是镜像且**不对称**的：

| 维度 | 分值 | Sell Put（低买） | Sell Call（高卖） |
|---|---|---|---|
| 波动率环境 | 35 | IV 溢价 20 + Put 偏度 15 | IV 溢价 15 + Call 偏度 15 + CVD 背离 10 |
| 市场趋势 | 25 | ADX 震荡 15 + 下方支撑密度 10 | ADX 震荡 15 + 上方阻力密度 10 |
| 执行价微观清算结构 | 30 | 相对多头清算墙的位置 | 相对空头清算墙的位置 |
| 费率辅助 | 10 | 负费率加分（反转信号） | 正费率加分（多头拥挤） |

### 4.3 Vol Skew 跷跷板（不对称的核心）

`skewDiff = putIV − callIV`，两轨读同一个数但结论相反，且**惩罚力度刻意不对称**：

| skewDiff | 市场状态 | Sell Put 得分 | Sell Call 得分 |
|---|---|---|---|
| > +20 | 极端恐慌 | **−15**（熔断，禁止接飞刀） | −3 |
| +5 ~ +20 | 适度恐慌 | **+15**（最佳窗口） | +2 |
| −2 ~ +5 | 中性 | +8 | +8 |
| −5 ~ −2 | 轻度 FOMO | −3 | +8 |
| −20 ~ −5 | FOMO | −3 | **+15**（最佳窗口） |
| < −20 | 极端 FOMO | −10 | **−8**（注意：不是 −15） |

**设计意图**：高卖侧的所有惩罚都比低买侧轻。极端 FOMO 下卖 Call 最坏结果是「卖飞」（少赚），极端恐慌下卖 Put 最坏结果是「在暴跌中接盘」（真亏）。所以低买侧设熔断，高卖侧只降分。

### 4.4 清算墙不对称惩罚（30 分项）

在现价 ±1.5×ATR 范围内找最大的清算簇，看预估执行价落在墙的哪一侧：

**Sell Put**（找现价下方的多头清算墙）

| 位置 | 得分 | 含义 |
|---|---|---|
| 执行价 **高于**清算墙 | **−30** | 挡在猎杀路线上，会成为扫损炮灰 |
| 紧贴墙下沿（距离 < 1%） | −20 | 爆仓滑点可直接穿透 |
| 藏在墙下方 1%–5% | +20 ~ +30 | 🛡 护城河：爆仓盘替你做肉盾 |
| 距离 > 5% | +8 | 安全，但没吃到护城河红利 |
| 无清算墙 | +5 | 中性 |

**Sell Call**（找现价上方的空头清算墙）逻辑镜像，但最重惩罚是 **−20** 而非 −30，紧贴区惩罚是 **−5** 而非 −20——同样是高卖放宽的体现。

### 4.5 五档风控

| 分数 | 档位 | 目标年化 | 建议仓位 | 执行价距离 |
|---|---|---|---|---|
| 85–100 | ❇️ 深绿进攻 | 20–30% | 100% | 0.8 × ATR |
| 70–84 | 🟩 绿灯标准 | 15–20% | 80–100% | 1.2 × ATR |
| 50–69 | 🟢 绿灯保守 | 10–15% | 50–60% | 1.5 × ATR |
| 30–49 | 🟡 黄灯防守 | 5–10% | 20–30% | 2.5 × ATR |
| < 30 | 🔴 红灯暂停 | 0% | 0% | — |
| 一票否决 | 🚫 熔断 | 0% | 0% | — |

有黄灯全局否决时，执行价距离强制不低于 2.5×ATR。

### 4.6 高卖专属一票否决

`MSTR 在 24h 内宣布购买 BTC` → 高卖直接熔断（现货买盘冲击中，卖 Call 容易被拉穿）。
`MSTR 正在执行融资计划` → 不熔断，罚 −5 分并告警。

### 4.7 期限 × APR 矩阵

按档位 × 24/48/72/96 小时生成建议，并且**感知星期几**：

- **周一至周四**：50% 做 24h + 50% 做 48h；72h/96h 多数档位不建议。
- **周五**：75% 做 72h（周一交割）+ 25% 做 96h（周二交割），执行价距离额外放宽（周末流动性真空）。
- **周末**：不做新单，资金回活期。

### 4.8 宽跨式检测

无红灯、无黄灯、高卖未熔断，且两轨都 ≥ 60 分时，输出双卖建议（同时挂低买和高卖）。

---

## 五、数据源

| 数据 | 来源 | 需要 Key | 说明 |
|---|---|---|---|
| BTC 价格 / K 线 | Binance 现货公开 API | ❌ | 免费，1200 req/min 限额 |
| ATR / BB / ADX / 分形 | 本地计算 | — | 基于上面的 K 线 |
| IV / RV / Vol Skew / Max Pain | Deribit 公开 API | ❌ | 全部是 `public/` 端点 |
| 资金费率 / OI / CVD | Binance Futures 公开 API | ❌ | `fapi.binance.com` |
| 清算热力图 | Coinglass / Binance 估算 | 可选 | 有 Key 用 Coinglass，无 Key 用 Binance 合约数据估算 |
| MSTR 股价 / SEC 备案 | Finnhub | 可选 | 无 Key 则跳过 |
| MSTR BTC 持仓 | bitbo 抓取 / 硬编码兜底 | ❌ | 见「已知问题 1」 |
| 宏观事件日历 | Finnhub / 硬编码兜底 | 可选 | 见「已知问题 1」 |

---

## 六、API 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/dashboard` | GET | 全量缓存快照，前端唯一的数据入口。缓存未就绪返回 503 |
| `/api/decision` | GET | 仅决策结果，适合做告警脚本 |
| `/api/refresh` | POST | 强制重新拉取全部数据源并重算 |
| `/api/health` | GET | 健康检查，返回 uptime 与 lastRefresh。**Railway 的 healthcheckPath 指向它** |
| `*` | GET | 兜底返回 `index.html` |

---

## 七、环境变量（全部可选）

| 变量 | 默认 | 影响 |
|---|---|---|
| `PORT` | 3000 | Railway 自动注入 |
| `COINGLASS_API_KEY` | 空 | 不设则清算热力图退化为 Binance 估算 |
| `FINNHUB_API_KEY` | 空 | **不设则宏观事件日历完全失效**，见「已知问题 1」。同时 MSTR 股价与 SEC 备案也不可用 |

> 旧版 README 里列的 `TOKEN_UNLOCKS_API_KEY` 在代码里并不存在，已删除。`FINNHUB_API_KEY` 才是真正被读取的那个，之前漏写了。

---

## 八、本地运行与部署

```bash
npm install
npm start          # http://localhost:3000
npm run dev        # node --watch，改文件自动重启
```

**Railway**（当前生产方式）：连 GitHub 仓库即可，`railway.json` 已配好 NIXPACKS 构建、`node server.js` 启动、`/api/health` 健康检查（30 秒超时）、失败重启最多 5 次。需要 Key 的话在 Variables 面板加。

**Docker**：`docker build -t dual-btc-win . && docker run -d -p 3000:3000 dual-btc-win`。

零命令行的图文步骤见 `DEPLOY.md`。

---

## 九、刷新节奏

| 环节 | 频率 |
|---|---|
| 后端 → 全部数据源 | 每 5 分钟（cron `*/5 * * * *`） |
| 后端 → 宏观日历 | 每小时（cron `0 * * * *`），并重算决策 |
| 前端 → 后端 | 每 60 秒 |
| 启动时 | `app.listen` 回调里立刻跑一次 `fetchAndCache()` |

---

## 十、已知问题

### 1. 🔴 硬编码兜底数据已全部过期，宏观否决门实际是失效的

`services/macro.js` 的 `FALLBACK` 数组里最晚的事件是 **2026-05-13**，全部在过去。`fetchAll()` 会过滤掉所有已过期事件，所以在**没有设 `FINNHUB_API_KEY` 的情况下，返回的是 0 个事件、`hasUrgent` 恒为 false**。实测确认过。

后果：`computeDecision()` 里那条「距 FOMC/CPI 不足 24h → 黄灯」的全局否决**永远不会触发**。你会在 FOMC 当天拿到一个正常的绿灯评分。这是目前最危险的一处。

同样地，`services/mstr.js` 的 `MSTR_HOLDINGS` 硬编码于 **2026-03-16**，`lastPurchase.date` 也停在那天。`mstrBuyWithin24h` 因此恒为 false，高卖侧的 MSTR 熔断也不会触发（`latestOffering.isActive: true` 是写死的，所以 −5 分那条倒是一直生效——但它反映的是 2024-10-30 的融资公告，早已不是当前状态）。

**处理**（按性价比排序）：
1. 去 finnhub.io 注册免费 Key，在 Railway 加 `FINNHUB_API_KEY`。这一步就能救活宏观日历。
2. 在 `fetchAll()` 里加一条：兜底日历过滤后为 0 时打 `console.warn`，并在 `/api/dashboard` 的 `meta` 里带一个 `macroStale: true`，前端显眼位置标出来——否则这种「静默失效」下次还会发生。
3. MSTR 那块要么定期手动更新常量，要么让 `fetchHoldingsFromBitbo()` 的结果在抓取成功时真正覆盖硬编码值，并在失败时明确降级标记。

### 2. 🟡 决策引擎全部挤在 `server.js` 里

`computeDecision()` 一个函数约 300 行，评分、分档、执行价、期限矩阵、仓位建议全在里面。改任何一处权重都要在长函数里翻找，且没有任何测试。

**建议**：拆成 `engine/scoring.js`（双轨打分）、`engine/tenor.js`（期限矩阵）、`engine/veto.js`（否决门），把权重表提成常量对象。拆完至少能对「给定一组输入 → 期望分数」写几个断言。

### 3. 🟡 CORS 全开

`app.use(cors())` 允许任意来源。这个项目没有用户数据，风险远小于姊妹项目，但 `/api/refresh` 是 POST 且无鉴权——任何页面都能触发你的服务器去打一轮全部外部 API。Binance/Deribit 的限额很宽，但被人循环调用还是会浪费配额。

**处理**：给 `/api/refresh` 加个最小间隔（比如 30 秒内重复调用直接返回缓存结果），或者限制 CORS 来源为 dualhedge.ai。

### 4. 🟢 单个数据源失败会静默降级

`fetchAndCache()` 里每个数据源独立 try/catch，失败只 push 到 `errors` 数组。`computeDecision()` 遇到 `deriv`、`mstrData`、`liqData` 为空时会走「中性」分支照常给分。也就是说 Coinglass 挂了，清算墙那 30 分会变成 +5 的中性分，评分照样输出，前端不一定看得出来。

`_meta.errors` 有传到前端，但界面上是否醒目值得确认一下。

### 5. 🟢 内存缓存无 TTL

`cache.js` 有 `getAge()` 但没人调用它做过期判断。如果 cron 卡住或某个源连续失败，前端会一直显示旧数据，只能靠 `_meta.lastRefresh` 自己看时间。可以在 `/api/dashboard` 里对超过 15 分钟的数据打 stale 标记。

---

## 十一、快速定位表

| 我想改… | 去哪 |
|---|---|
| 评分权重 / 各档判据 | `server.js` 的 `computeDecision()`，低买段从「📉 低买评分」注释起，高卖段从「📈 高卖评分」起 |
| 五档阈值与目标年化 | `server.js` 的 `gradeFromScore()` |
| 执行价 ATR 倍数 | `server.js` 的 `calcStrike()`（单点）与 `buildTenorMatrix()`（矩阵），**两处都要改** |
| 周五 / 周末的仓位分配 | `server.js` 里 `positionAdvice` 那段 |
| 全局否决条件 | `computeDecision()` 开头的「全局否决」块 |
| 技术指标算法 | `services/binance.js` 的 `calcATR` / `calcBB` / `calcADX` / `calcFractalLevels` |
| Vol Skew / Max Pain 算法 | `services/deribit.js` 的 `calcVolSkew` / `calcMaxPain` |
| 宏观事件兜底列表 | `services/macro.js` 的 `FALLBACK` |
| MSTR 持仓常量 | `services/mstr.js` 的 `MSTR_HOLDINGS` |
| 中英文案 | `public/index.html` 的 `I18N` 对象（约 380 行起） |
| 拉取频率 | `server.js` 末尾的两条 `cron.schedule` |

---

## 十二、免责声明

本工具仅提供辅助决策参考，不构成投资建议。双币赢本质是期权卖方策略，收益有上限而风险无下限，请确保理解其风险后再使用。
