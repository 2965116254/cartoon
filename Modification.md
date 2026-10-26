# 喵呜动漫 🌸 · 修改记录（Modification.md）

> 项目：多渠道动漫搜索播放网页（纯前端 + 本地 Python 服务）
> 线上地址：https://2965116254.github.io/cartoon/
> 仓库：https://github.com/2965116254/cartoon
> 记录时间：2026-10-26

版本号规则：`index.html` 里 `app.js?v=N` / `style.css?v=N`，每次改动同步递增，防止浏览器缓存。

---

## v1 · 初版（2026-10-26 上午）

**第一次实现，按用户提示词完成整个网页。**

- 新建 `index.html` / `style.css` / `app.js` / `serve.py` / `README.md` / `_selftest.js`
- 核心功能：多渠道并行搜索（接入苹果CMS vod JSON 接口）→ 按标题智能合并同一部番 → **播放前三关检测**（详情有数据 / 剧集非空 / m3u8 内容实测可达，8s 超时）→ 检测不过自动换源 → hls.js 内嵌播放
- 初版 6 渠道：暴风 / 360 / 最大 / 红牛 / JRS / 速播（量子、卧龙、魔爪、天涯等网上流传接口实测已死）
- 可爱卡通风 UI：Q版猫娘看板娘（SVG）、粉嫩渐变背景、果冻按钮、漂浮云朵星星、手机端适配
- `serve.py`：本地预览服务（端口 8081，避开其他项目占用），带 no-cache 头
- 实测坑：电影类（如千与千寻）首个播放组常是 HTML 播放页，`parseEpisodes` 必须按 `vod_play_from` 优先挑含 m3u8 的组

## v2 · 修复"点击卡片无反应"

- **根因**：`app.js` 里 4 处获取弹窗元素写成了 `$('modal')`，而 HTML 中实际 id 是 `playerModal`，取到 null 后脚本直接报错
- 修复：全局替换为 `$('playerModal')`；用脚本核对 JS 引用的全部元素 id 与 HTML 定义一一对应
- 教训：新增 DOM 后必须核对 id 引用一致性

## v3 · 修复"没有资源"（CORS 根因）

- **根因**：浏览器跨域（CORS）限制。Node 自测没有跨域限制所以全通，浏览器里页面 JS 直连接口和 m3u8 全被拦——搜索看似正常（部分接口碰巧放行），点进去检测全部失败
- **serve.py 新增 `/proxy?url=` 通用转发代理**：搜索、详情、探测、视频流全部经它中转；m3u8 由服务端自动重写内部分片地址（实测一部番重写 297 处），hls.js 零配置可播
- 踩坑记录：
  - urllib 默认读系统代理环境变量（Clash）导致 502 → 必须 `build_opener(ProxyHandler({}))` 强制直连
  - `parse_qs` 把 %XX 解码回中文后再请求会报编码错 → 必须重新 `quote`
- 渠道扩到 **8 个**（全部实测搜索→详情→m3u8 可播）：暴风 / 360 / 360备用 / 最大 / 红牛 / JRS / 速播 / uku

## v4 · 搜索结果筛选排序框

- 搜索结果标题右侧新增筛选下拉 `sortSelect`：**最近时间 ↓（默认）**、最早时间 ↑、渠道最多 ↓、名称 A→Z
- 无年份信息的条目始终沉底，不搅乱排序；切换选项即时重渲染，无需重新搜索
- 结构调整：排序 + 截断（36 条）全部移到 `renderResults`，`doSearch` 只保留全量 `lastResults`

## v5 · 首次提交并部署 GitHub Pages

- 新建 git 仓库，推送 `index.html / style.css / app.js / serve.py / README.md / .gitignore`
- 开启 GitHub Pages（API 配置 main 分支根目录），线上地址 `https://2965116254.github.io/cartoon/`
- **线上模式改造**（Pages 上没有本地代理）：接口优先 JSONP + 三个公共 CORS 代理轮询（corsproxy.io / codetabs / allorigins），hls.js 用 `xhrSetup` 包代理
- 环境识别：`IS_LOCAL_SERVER`（localhost → 本地代理）/ `IS_REMOTE`（https 线上）/ `file://` 直开（弹提示）

## v6 · 线上播放修复（一）：废弃公共代理，改直连

- **真相**：三个公共代理全灭（corsproxy.io 强制要 key 401、codetabs / allorigins 国内超时、其余 429 限流）
- **关键实测**：扫描 23+ 资源站发现 **暴风源 API 与其视频 CDN 全链路自带 `Access-Control-Allow-Origin: *`**——线上直连即可完整搜+播（720 集火影验证）；红牛/JRS 的 m3u8 CDN 也开放但查询 API 不开放
- 修改：`CHANNELS` 增加 `cors: true` 标记；线上模式直连 + 开放跨域渠道排序优先；渠道标签加 **🌐（线上可直连播放）/ 💻（仅本地代理可用）** 标识

## v7 · 线上播放修复（二）：绕开坏接口

- **真凶**（用户截图 `jsonp error` 定位）：暴风源同一域名下接口 CORS 头不一致——
  | 接口 | 跨域许可 | 结论 |
  |---|---|---|
  | `ac=videolist&wd=` 搜索 | ✅ ACAO:* | 正常 |
  | `ac=detail&ids=` 取详情 | ❌ 无 + 响应 50s+ | 点播放必挂 |
  | `ac=detail&wd=` 按词查详情 | ✅ ACAO:* | 一条请求自带全集地址 |
- 修改：播放流程从"搜索→查详情→探测"改为 **`ac=detail&wd=` 一次搜索即得全部剧集**，坏接口彻底绕开；搜索结果预解析剧集（`item.channels[i].episodes`），检测时优先用预解析、缺失才回退详情接口；搜索请求加 1 次重试
- 排查手法沉淀：node fetch 带上 `Origin: https://xxx.github.io` + 浏览器 UA 逐接口复现对比 ACAO 头

## v8 · 线上播放修复（三）：借道本机代理

- **现象**：报错变"网络受限/不可达"，卡在浏览器直连视频 CDN——用户电脑跑 Clash 系统代理，浏览器请求国内 CDN 被代理带出国遭拒（本机绕过代理直连同地址是通的）
- **修改**：新增候选通道机制 `candidateUrls()`——线上先直连，失败自动尝试借用**本机正在运行的 serve.py**（`http://127.0.0.1:8081/proxy`，自带跨域许可且强制直连，Chrome 允许 https 页面访问 localhost）；借道成功后该渠道全部剧集地址自动切到同一通道
- 报错信息附带排查提示（"若开着 VPN/Clash 请关闭或把视频域名设为直连"）

## v9 · 搜索提速（渐进式渲染）

- **用户反馈**：搜索转圈太久
- **根因**：`Promise.all` 等全部 8 渠道返回才渲染；失败渠道要烧完超时 + 无效 JSONP 兜底，最长 14–16 秒拖住整个搜索
- 修改：
  1. `searchAll` 改**渐进式**：任一渠道先回来就先合并渲染出卡片，实测首个结果约 **1.3 秒**出现
  2. 总时限 `SEARCH_DEADLINE = 6.5s` 兜底：到点先展示已有结果，慢渠道后台继续跑，回来后增量补进列表（状态栏显示"还在翻剩余 N 个渠道"）
  3. 移除 JSONP 兜底（CMS 接口实测均不支持 callback 参数，纯浪费 8s/渠道）
  4. 搜索单请求超时 8s → 6s
  5. 线上模式未开放跨域的渠道候选顺序改为"本机代理优先"，跳过注定失败的直连
  6. `searchSeq` 搜索序号防过期渲染（后台补结果 vs 新搜索竞态）
- 播放链路（预解析剧集 / 8s 探测 / 自动换源）完全未动

## v10 · 番名联想（搜索推荐）

- **用户需求**：不知道番剧全名，输入前几个字就给番名推荐，方便查找
- 实现：
  - 输入防抖 300ms、至少 2 字才触发；并行请求**轻量接口 `ac=videolist`**（不带剧集，响应小速度快），单请求超时 3.5s
  - 渐进合并：谁先回来谁先显示；`normalizeTitle` 跨渠道去重 + 相关性过滤（过滤后为空则退回原始结果）
  - 命中片段粉色加粗高亮；下拉项带封面缩略图 + 年份/备注
  - 交互：点击直接搜；键盘 **↑↓** 选择、**Enter** 确认、**Esc** 收起；点击页面其他处收起
  - 缓存 `sugCache`（前缀 → 候选，超 40 条清空）；`suggestSeq` 防过期渲染
  - 下拉项用 `mousedown + preventDefault` 抢在 input blur 之前完成点选（用 click 会因 blur 先触发而丢事件）
- 实测：输入"鬼灭"约 1.6s 出 8 条候选（含剧场版、各季篇名）

## v11 · 横屏播放

- **用户反馈**：手机全屏播放不能横屏
- **分析**：截图中的是 iPhone 系统原生播放器，其旋转受系统「竖排方向锁」控制，网页无权干预；且 iOS 不支持 `screen.orientation.lock`，iPhone Safari 也不支持元素级 `requestFullscreen`
- **三档方案**（按设备自动选择）：
  | 设备 | 行为 |
  |---|---|
  | iPhone / iPad | CSS 伪横屏：`.player-wrap` 旋转 90°（`width:100vh; height:100vw + translate(-50%,-50%) rotate(90deg)`）铺满整屏，**不受方向锁限制**；画面右上角有「⤡ 退出横屏」按钮 |
  | 安卓 | 真全屏 + `screen.orientation.lock('landscape')` 真锁横屏；锁失败自动回退伪横屏 |
  | 桌面 | 普通全屏，再点退出 |
- 细节：横屏时隐藏标题/选集/关闭按钮防误触；Esc 先退横屏再关弹窗；关闭播放弹窗统一走 `exitLandscapeAll()` 清理横屏/全屏/方向锁状态；工具栏按钮文字随状态切换（⤢ 横屏 ↔ ⤡ 竖屏）
- 环境判断 `IS_IOS` 覆盖 iPadOS（MacIntel + maxTouchPoints > 1 的特例）

---

## 当前架构速览

```
cartoon/
├── index.html      # 页面骨架（搜索框+联想下拉 / 结果网格 / 播放弹窗 / Toast）
├── style.css       # 可爱卡通风样式（含伪横屏样式）
├── app.js          # 核心逻辑：渠道配置 / 渐进式搜索 / 番名联想 /
│                   #   播放前三关检测 / 自动换源 / hls.js 播放 / 横屏 / 历史
├── serve.py        # 本地服务：静态文件(no-cache) + /proxy 跨域代理(m3u8 重写)
├── README.md       # 使用说明
├── _selftest.js    # 端到端自测脚本（node _selftest.js 片名）
└── Modification.md # 本文件
```

- **渠道配置**：`app.js` 顶部 `CHANNELS` 数组，`cors: true` 表示 API 与视频 CDN 开放跨域（线上可直连）
- **本地运行**：`python serve.py` → http://127.0.0.1:8081 （全部渠道可用，最稳）
- **线上运行**：GitHub Pages（🌐 渠道直连；💻 渠道线上自动跳过；开着本机 serve.py 时可借道）
- **更新流程**：改代码 → 版本号 `?v=N` 递增 → `git add . && git commit && git push` → Pages 自动构建

## 已知限制

- 线上可用渠道比本地少（目前暴风一家全链路开放跨域），是免费静态托管的跨域天然限制
- 公共网络环境下渠道接口偶发超时属正常，"检测 + 自动换源"机制自动兜底
- 视频源来自公开网络资源聚合，仅供学习交流，建议支持正版
