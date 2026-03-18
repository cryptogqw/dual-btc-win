# 部署指南：GitHub + Railway

## 前置条件

- 一个 GitHub 账号（免费）
- 一个 Railway 账号（免费，用 GitHub 登录即可）

总耗时约 **10 分钟**，全程不需要写任何命令行。

---

## 第一步：上传代码到 GitHub

### 1.1 创建新仓库

1. 打开 https://github.com/new
2. 填写仓库名称：`btc-dual-win`（或任何你喜欢的名字）
3. 选择 **Private**（私有，推荐）或 Public
4. **不要**勾选 "Add a README file"（我们已经有了）
5. 点击 **Create repository**

### 1.2 上传项目文件

在新建仓库的页面，你会看到一个空仓库的引导页面。

**方式 A：网页上传（最简单，不用装 Git）**

1. 点击页面上的 **"uploading an existing file"** 链接
2. 把解压后的 `btc-dual-win` 文件夹里的 **所有文件和文件夹** 拖进上传区域：
   ```
   需要上传的文件/文件夹：
   ├── server.js
   ├── cache.js
   ├── package.json
   ├── railway.json        ← Railway 配置，很重要
   ├── Dockerfile
   ├── .gitignore
   ├── .env.example
   ├── README.md
   ├── DEPLOY.md
   ├── services/
   │   ├── binance.js
   │   ├── deribit.js
   │   ├── coinglass.js
   │   └── macro.js
   └── public/
       └── index.html
   ```
3. 在下方 "Commit changes" 写个说明，比如 `初始上传`
4. 点击 **Commit changes**

**方式 B：用 Git 命令行（更灵活）**

```bash
cd btc-dual-win
git init
git add .
git commit -m "初始提交"
git branch -M main
git remote add origin https://github.com/你的用户名/btc-dual-win.git
git push -u origin main
```

### 1.3 验证上传成功

刷新 GitHub 仓库页面，你应该能看到所有文件已经在仓库里了。
确认 `server.js`、`package.json`、`railway.json` 都在根目录。

---

## 第二步：部署到 Railway

### 2.1 登录 Railway

1. 打开 https://railway.com
2. 点击右上角 **Login**
3. 选择 **Login with GitHub**（用你的 GitHub 账号授权登录）

### 2.2 创建新项目

1. 登录后，点击 **New Project**（或 Dashboard 页面的 "+" 按钮）
2. 选择 **Deploy from GitHub repo**
3. 在弹出的仓库列表中找到 `btc-dual-win`
   - 如果看不到你的仓库，点击 **Configure GitHub App** 授权 Railway 访问你的仓库
4. 点击选中 `btc-dual-win` 仓库

### 2.3 等待自动部署

Railway 会自动：
- 检测到这是一个 Node.js 项目（通过 package.json）
- 运行 `npm install` 安装依赖
- 执行 `node server.js` 启动服务

部署过程通常需要 **1-3 分钟**。你可以在 Railway 的 Deployments 面板看到实时日志。

当看到类似这样的日志时，说明部署成功了：

```
🚀 BTC 双币赢决策终端已启动
   地址: http://localhost:3000
   刷新周期: 每 5 分钟
[Binance] 拉取数据...
[Deribit] 拉取波动率数据 (公开API, 无需账号)...
  ✓ Binance: 价格 $84,521
  ✓ Deribit: IV=52.3%, RV=41.1%
```

### 2.4 生成公网域名

部署成功后，你需要生成一个可以外部访问的域名：

1. 点击你的服务（在 Railway 项目画布中）
2. 点击上方的 **Settings** 标签页
3. 滚动到 **Networking** 部分
4. 点击 **Generate Domain**
5. Railway 会分配一个类似 `btc-dual-win-production-xxxx.up.railway.app` 的域名

**这个域名就是你的决策终端地址！** 在手机或任何电脑的浏览器中输入即可访问。

### 2.5 （可选）添加环境变量

如果你有 Coinglass API Key，想要更精确的清算数据：

1. 点击你的服务
2. 点击 **Variables** 标签页
3. 点击 **New Variable**
4. Name: `COINGLASS_API_KEY`，Value: 你的 Key
5. Railway 会自动重新部署

---

## 第三步：手机设置

拿到 Railway 分配的域名后：

### iOS (iPhone/iPad)

1. 用 **Safari** 打开你的 Railway 域名
2. 点击底部的 **分享按钮** (方框+箭头图标)
3. 滚动找到 **添加到主屏幕**
4. 给它起个名字，比如 "BTC决策"
5. 点击 **添加**

现在桌面上会出现一个图标，点开就是全屏的决策终端！

### Android

1. 用 **Chrome** 打开你的 Railway 域名
2. 点击右上角 **三个点** 菜单
3. 选择 **添加到主屏幕** / **安装应用**
4. 确认添加

---

## 后续维护

### 更新宏观事件日历

每月初花 1 分钟更新一次：

1. 在 GitHub 仓库中打开 `services/macro.js`
2. 点击右上角的 **铅笔图标**（编辑）
3. 修改 `KNOWN_EVENTS` 数组中的日期
4. 点击 **Commit changes**
5. Railway 检测到 GitHub 更新后会 **自动重新部署**（通常 1-2 分钟）

### 更新代码

任何时候你在 GitHub 上修改了代码，Railway 都会自动重新部署，无需手动操作。

### 查看运行状态

- Railway 仪表板可以看到 CPU、内存使用情况
- 访问 `你的域名/api/health` 可以查看服务状态
- 访问 `你的域名/api/dashboard` 可以看到原始 API 数据

---

## 常见问题

**Q: Railway 免费吗？**
A: Railway 提供试用额度（$5 credit）。这个项目资源占用极低（<100MB 内存），
   试用额度用完后，Hobby 计划 $5/月。如果觉得贵，可以改用 Render.com 
   的免费计划（缺点是 15 分钟无访问会休眠）。

**Q: 部署失败怎么办？**
A: 在 Railway 的 Deployments 标签页查看日志。最常见的问题是文件结构不对，
   确保 `package.json` 和 `server.js` 在仓库的根目录（不是在子文件夹里）。

**Q: 数据不更新？**
A: 访问 `你的域名/api/health` 检查 `lastRefresh` 时间。
   如果长时间没更新，在 Railway 仪表板检查服务是否正常运行。

**Q: 如何绑定自己的域名？**
A: 在 Railway Settings → Networking → Custom Domain 中添加你的域名，
   然后在你的域名 DNS 中添加 Railway 提供的 CNAME 记录。
