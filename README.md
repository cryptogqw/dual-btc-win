# BTC 双币赢决策终端

轻量后端 + 静态前端的 BTC 双币赢辅助决策系统。

## 架构

```
┌─────────────┐    每5分钟     ┌──────────────────────┐
│  Binance    │◄──────────────│                      │
│  (价格/K线)  │               │   Node.js 后端        │
├─────────────┤               │   - 定时拉取数据       │
│  Deribit    │◄──────────────│   - 内存缓存          │──► /api/dashboard
│  (IV/RV)    │  公开API,无需账号│   - 决策引擎计算      │
├─────────────┤               │   - 静态文件托管       │
│  Coinglass  │◄──────────────│                      │
│  (清算数据)  │  可选API Key   └──────────────────────┘
└─────────────┘                        ▲
                                       │ 每60秒读取缓存
                                ┌──────┴──────┐
                                │  前端 HTML   │
                                │  (浏览器)    │
                                └─────────────┘
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
npm start
```

打开浏览器访问 `http://localhost:3000`

### 3. 开发模式（文件修改自动重启）

```bash
npm run dev
```

## 数据来源说明

| 数据 | 来源 | 需要账号? | 说明 |
|------|------|-----------|------|
| BTC 价格 / K线 | Binance 公开API | ❌ 不需要 | 完全免费，无限制 |
| 隐含波动率 (IV) | Deribit 公开API | ❌ 不需要 | public 端点无需认证 |
| 实际波动率 (RV) | Deribit 公开API | ❌ 不需要 | 同上 |
| 波动率偏度 (Skew) | Deribit 公开API | ❌ 不需要 | 同上 |
| ATR / BB / ADX | 后端本地计算 | - | 基于 Binance K线数据 |
| 分形支撑/阻力 | 后端本地计算 | - | 基于 Binance K线数据 |
| 清算热力图 | Coinglass / Binance | 可选 | 有Key用Coinglass，无Key用Binance估算 |
| 宏观事件日历 | 手动维护 | - | 每月更新一次 services/macro.js |

### 可选: Coinglass API Key

如果你想要更精确的清算热力图数据：

1. 注册 [Coinglass](https://coinglass.com) 免费账号
2. 获取 API Key
3. 启动时设置环境变量：

```bash
COINGLASS_API_KEY=your_key_here npm start
```

### 更新宏观事件日历

编辑 `services/macro.js` 中的 `KNOWN_EVENTS` 数组，每月花 1 分钟更新即可：

```js
const KNOWN_EVENTS = [
  { name: 'FOMC 利率决议', icon: 'fed', impact: 'high', date: '2026-04-29 18:00' },
  { name: 'CPI 通胀数据', icon: 'cpi', impact: 'high', date: '2026-04-14 12:30' },
  // ... 添加更多
];
```

## 部署方案

### 方案 A: Railway（推荐，最简单）

1. 注册 [Railway.app](https://railway.app)（有免费额度）
2. 连接你的 GitHub 仓库
3. Railway 自动检测 Node.js 项目并部署
4. 如需 Coinglass Key，在 Railway 变量面板中添加 `COINGLASS_API_KEY`
5. 获得公网地址，手机/电脑随时访问

### 方案 B: Render

1. 注册 [Render.com](https://render.com)
2. 新建 Web Service → 连接 GitHub
3. Build Command: `npm install`
4. Start Command: `npm start`
5. 免费版每 15 分钟无请求会休眠（首次访问需等几秒唤醒）

### 方案 C: 自有服务器 / VPS

```bash
# 克隆代码
git clone <your-repo-url>
cd btc-dual-win

# 安装依赖
npm install

# 使用 PM2 守护进程
npm install -g pm2
pm2 start server.js --name btc-terminal
pm2 save
pm2 startup  # 开机自启
```

### 方案 D: Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

```bash
docker build -t btc-dual-win .
docker run -d -p 3000:3000 --name btc-terminal btc-dual-win
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `GET /api/dashboard` | GET | 获取全部缓存数据（前端使用） |
| `GET /api/decision` | GET | 仅获取决策信号 |
| `POST /api/refresh` | POST | 手动触发后端重新拉取数据 |
| `GET /api/health` | GET | 健康检查 |

## 刷新频率

- **后端→数据源**: 每 5 分钟自动拉取（Binance + Deribit + 清算）
- **后端→宏观事件**: 每小时检查一次
- **前端→后端**: 每 60 秒读取缓存
- **手动刷新**: 点击按钮强制后端重新拉取

## 项目结构

```
btc-dual-win/
├── server.js              # 主服务 (Express + Cron)
├── cache.js               # 内存缓存模块
├── services/
│   ├── binance.js         # 价格 + 技术指标
│   ├── deribit.js         # 波动率 (公开API)
│   ├── coinglass.js       # 清算数据
│   └── macro.js           # 宏观事件日历
├── public/
│   └── index.html         # 前端页面
├── package.json
└── README.md
```

## 环境变量（均为可选）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 3000 |
| `COINGLASS_API_KEY` | Coinglass API 密钥 | 空(使用Binance估算) |
| `TOKEN_UNLOCKS_API_KEY` | TokenUnlocks API 密钥 | 空(使用手动日历) |

## 注意事项

- Deribit 公开 API 有速率限制，但每 5 分钟请求一次完全在安全范围内
- Binance API 免费且无需认证，每分钟 1200 次请求限制，远超我们的需求
- 本工具仅提供辅助决策参考，不构成投资建议
- 双币赢本质上是期权卖方策略，请确保你理解其风险
