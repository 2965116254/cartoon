/* ==========================================================
 * 喵呜动漫 · 多渠道动漫搜索与播放
 * 数据源：公开的苹果CMS(CMS10) vod JSON 接口聚合
 * 核心流程：搜索(多渠道并行) → 合并去重 → 播放前可用性检测
 *          → 检测通过才允许播放 → 失败自动换源
 * ========================================================== */
'use strict';

/* ---------------- 渠道配置（增删渠道只需改这里） ----------------
 * cors: 该渠道 API 是否自带 Access-Control-Allow-Origin: *（实测 2026-10-26）
 *   - 本地 serve.py：所有渠道都能用（走 /proxy 本地代理）
 *   - GitHub Pages 线上：只有 cors:true 的渠道可直连搜索/播放；
 *     其余渠道 API 无跨域许可，浏览器直接拦截（线上会自动跳过，不浪费时间）
 */
const CHANNELS = [
  { key: 'baofeng',   name: '暴风源',   api: 'https://bfzyapi.com/api.php/provide/vod', cors: true },
  { key: 'zy360',     name: '360源',    api: 'https://360zy.com/api.php/provide/vod', cors: false },
  { key: 'zy360alt',  name: '360备用',  api: 'https://360zy5.com/api.php/provide/vod', cors: false },
  { key: 'zuida',     name: '最大源',   api: 'https://api.zuidapi.com/api.php/provide/vod', cors: false },
  { key: 'hongniu',   name: '红牛源',   api: 'https://www.hongniuzy3.com/api.php/provide/vod', cors: false },
  { key: 'jrs',       name: 'JRS源',    api: 'https://jszyapi.com/api.php/provide/vod', cors: false },
  { key: 'subo',      name: '速播源',   api: 'https://www.subozy.com/api.php/provide/vod', cors: false },
  { key: 'uku',       name: 'uku源',    api: 'https://api.ukuapi88.com/api.php/provide/vod', cors: false },
];

const TIMEOUT_SEARCH = 6000;   // 搜索单请求超时 6s（渐进式渲染，慢渠道不阻塞出结果）
const SEARCH_DEADLINE = 6500;  // 搜索总时限：到点先展示已到的结果，慢渠道后台继续补
const TIMEOUT_DETECT = 8000;   // 播放检测超时 8s（保证播放可靠性，不压缩）
const LS_HISTORY = 'meow_anime_history';

/* ---------------- 运行环境与代理策略 ----------------
 * 1. 本地 serve.py（localhost）：一切走 /proxy?url= 本地代理，全渠道可用，最稳；
 * 2. GitHub Pages 线上（https）：无本地代理，公共 CORS 代理已实测全灭
 *    （corsproxy.io 要 key、codetabs/allorigins 国内超时）→ 策略改为「直连 + 开放跨域渠道优先」：
 *    cors:true 渠道（如暴风）API 和视频 CDN 都自带跨域许可，直连即可完整搜+播；
 * 3. file:// 直开：全部直连，大部分渠道会被浏览器拦截（不推荐，会弹提示）。
 */
const IS_LOCAL_SERVER = ['127.0.0.1', 'localhost'].includes(location.hostname)
  && location.protocol.startsWith('http');
const IS_REMOTE = location.protocol === 'https:' && !IS_LOCAL_SERVER;

function px(url) {
  return IS_LOCAL_SERVER ? '/proxy?url=' + encodeURIComponent(url) : url;
}

/* 线上模式的补救通道：若本机恰好运行着 serve.py（默认 8081 端口），
 * 页面可以借用 http://127.0.0.1:8081/proxy 转发（serve.py 的代理自带跨域许可，
 * 且 Chrome/Edge 允许 https 页面访问 localhost）。
 * 典型场景：电脑开了 Clash 等系统代理，浏览器直连国内视频 CDN 被代理带出国被拒，
 * 而本机 serve.py 是强制直连的 —— 借道即可播放。其他设备无 serve.py 时自动跳过。 */
const LOCAL_PROXIES = ['http://127.0.0.1:8081/proxy?url='];

/** 一次请求的候选地址：[{u, wrap}] wrap= 把任意地址转成该通道地址的函数(null=直连) */
function candidateUrls(url) {
  if (IS_LOCAL_SERVER) return [{ u: px(url), wrap: null }];
  if (IS_REMOTE) {
    const list = [{ u: url, wrap: null }];   // 先直连（开放跨域的渠道直接成功）
    for (const b of LOCAL_PROXIES) list.push({ u: b + encodeURIComponent(url), wrap: u2 => b + encodeURIComponent(u2) });
    return list;
  }
  return [{ u: url, wrap: null }];
}

/* ---------------- 工具 ---------------- */
const $ = (id) => document.getElementById(id);

function toast(msg, type = '', ms = 2600) {
  const box = $('toastBox');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** 带超时的 fetch */
async function fetchTimeout(url, ms = TIMEOUT_SEARCH) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 标题归一化：去空格、书名号、常见干扰词，用于跨渠道合并同一部番 */
function normalizeTitle(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[《》\s·：:，,。.！!？?~～\-—_（）()'\"]/g, '')
    .replace(/第[一二三四五六七八九十\d]+季/g, '')
    .replace(/(剧场版|国语|日语|中字|未删减|完整版|4k|hd|blue?ray)/g, '');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 搜索：多渠道并行 ----------------
 * 用 ac=detail&wd= 一步到位：搜索结果自带全部剧集地址(vod_play_url)，
 * 播放时无需再请求 ac=detail&ids=（实测暴风该接口不带 ACAO 跨域头，线上会被拦，
 * 且响应极慢 50s+），整个流程压缩为「1 次搜索 + 1 次视频探测」。 */
async function searchChannel(ch, query) {
  const url = `${ch.api}?ac=detail&wd=${encodeURIComponent(query)}`;
  let data = null;
  let cands = candidateUrls(url);
  // 线上模式：未开放跨域的渠道直连必被浏览器拦，直接先走本机代理候选，省一次注定失败的请求
  if (IS_REMOTE && !ch.cors) cands = [...cands.filter(c => c.wrap), ...cands.filter(c => !c.wrap)];
  for (const { u } of cands) {
    if (data) break;
    try {
      const res = await fetchTimeout(u);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      console.warn(`[渠道 ${ch.name}] 请求失败:`, e.message);
    }
  }
  if (!data) return [];   // JSONP 已实测各接口均不支持（callback 参数被忽略），不再浪费时间兜底
  const list = (data && data.list) || [];
  return list.map(v => ({
    id: String(v.vod_id),
    name: String(v.vod_name || '').trim(),
    pic: v.vod_pic || '',
    remark: String(v.vod_remarks || '').trim(),
    year: String(v.vod_year || '').trim(),
    cls: String(v.vod_class || '').trim(),
    channel: ch,
    episodes: parseEpisodes(v),   // 搜索时预解析剧集，播放时免再查详情
  })).filter(v => v.name);
}

/** 搜索并按标题合并多渠道结果（渐进式：每有个渠道返回就回调 onPartial，不等全部）
 *  返回 Promise<完整列表>；总时限 SEARCH_DEADLINE 到点先行返回，慢渠道后台继续补渲染 */
async function searchAll(query, onPartial) {
  const map = new Map();

  const merged = () => {
    const list = [...map.values()];
    // 渠道排序：开放跨域的渠道（线上可直连）排前面，优先检测优先播放
    for (const it of list) {
      it.channels.sort((a, b) => (b.channel.cors ? 1 : 0) - (a.channel.cors ? 1 : 0));
    }
    return list;
  };

  /** 把一个渠道的结果并进 map */
  const absorb = (results) => {
    for (const v of results) {
      const key = normalizeTitle(v.name);
      if (!key) continue;
      if (!map.has(key)) {
        map.set(key, { ...v, channels: [{ id: v.id, channel: v.channel, episodes: v.episodes }], sources: [v.channel.name] });
      } else {
        const item = map.get(key);
        // 优先保留带封面的那条作为展示主体
        if (!item.pic && v.pic) Object.assign(item, { pic: v.pic, remark: v.remark || item.remark, year: v.year || item.year });
        if (!item.episodes || !item.episodes.length) item.episodes = v.episodes;
        if (!item.channels.some(c => c.channel.key === v.channel.key)) {
          item.channels.push({ id: v.id, channel: v.channel, episodes: v.episodes });
          item.sources.push(v.channel.name);
        }
      }
    }
  };

  let doneCount = 0;
  const jobs = CHANNELS.map(async (ch) => {
    try {
      const results = await searchChannel(ch, query).catch(() => []);
      if (results.length) {
        absorb(results);
        if (onPartial) onPartial(merged(), ch, CHANNELS.length - doneCount - 1);
      }
    } finally {
      doneCount++;
    }
  });

  // 总时限兜底：到点先把已有结果交出去；未完成的渠道在后台继续，结果仍会经 onPartial 增量补上
  await Promise.race([Promise.all(jobs), new Promise(r => setTimeout(r, SEARCH_DEADLINE))]);
  return merged();
}

/* ---------------- 详情与解析 ---------------- */
async function fetchDetail(ch, id) {
  const url = `${ch.api}?ac=videolist&ids=${encodeURIComponent(id)}`;
  let data = null;
  for (const { u } of candidateUrls(url)) {
    if (data) break;
    try {
      const res = await fetchTimeout(u);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) { /* 试下一个候选 */ }
  }
  if (!data) throw new Error('详情接口不可达');
  const v = data && data.list && data.list[0];
  if (!v) throw new Error('详情为空');
  return v;
}

/**
 * 解析苹果CMS play_url：
 * 格式 "源1$$$源2"，每组内 "第01集$url#第02集$url2"
 * 返回 [{ name, url }]
 */
function parseEpisodes(vod) {
  const playUrl = String(vod.vod_play_url || '');
  const playFrom = String(vod.vod_play_from || '').split('$$$');
  const groups = playUrl.split('$$$');
  // 优先挑 m3u8 播放源
  let bestIdx = 0;
  for (let i = 0; i < playFrom.length; i++) {
    if (/m3u8/i.test(playFrom[i] || '')) { bestIdx = i; break; }
  }
  const raw = (groups[bestIdx] || groups[0] || '');
  const eps = raw.split('#').map(s => {
    const idx = s.indexOf('$');
    if (idx === -1) return { name: '第?集', url: s.trim() };
    return { name: s.slice(0, idx).trim(), url: s.slice(idx + 1).trim() };
  }).filter(e => /^(https?:)?\/\//.test(e.url));
  return eps;
}

/* ---------------- 播放前可用性检测（核心） ---------------- */
const availCache = new Map(); // key: `${ch.key}:${id}:${epIdx|all}` -> {ok, episodes}

/**
 * 检测某个渠道某部番是否真的可播：
 * 1) 有剧集数据（搜索时已带 或 现查详情）
 * 2) 剧集列表非空且含视频地址
 * 3) 探测目标集视频地址确实可达（HTTP 200 且有内容）
 * 全部通过才返回 ok
 */
async function detectChannel(ch, id, epIdx = 0, preEpisodes = null) {
  const cacheKey = `${ch.key}:${id}:${epIdx}`;
  if (availCache.has(cacheKey)) return availCache.get(cacheKey);

  let result = { ok: false, episodes: [], note: '' };
  try {
    let episodes = (preEpisodes && preEpisodes.length) ? preEpisodes : null;
    if (!episodes) {
      const vod = await fetchDetail(ch, id);
      episodes = parseEpisodes(vod);
    }
    if (!episodes.length) {
      result.note = '无剧集资源';
    } else {
      const ep = episodes[Math.min(epIdx, episodes.length - 1)];
      const probe = await probeVideoUrl(ep.url);
      if (probe.ok) {
        // 若探测是借道本机代理成功的，把该渠道全部剧集地址都改写为同一通道
        if (probe.wrap) episodes = episodes.map(e => ({ ...e, url: probe.wrap(e.url) }));
        result = { ok: true, episodes, note: '' };
      } else {
        result.note = probe.note;
      }
    }
  } catch (e) {
    result.note = e.message || '接口异常';
  }
  availCache.set(cacheKey, result);
  return result;
}

/** 探测视频地址：请求成功且拿到首块内容才算可用。
 *  线上直连失败时自动尝试借用本机 serve.py 代理（127.0.0.1:8081）；
 *  返回 wrap（成功的通道函数），调用方用它改写全部剧集地址。 */
async function probeVideoUrl(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_DETECT);
  let lastNote = '';
  try {
    for (const { u, wrap } of candidateUrls(url)) {
      try {
        const res = await fetch(u, { signal: ctrl.signal });
        if (!res.ok) { lastNote = 'HTTP ' + res.status; continue; }
        // m3u8 必须是文本且包含片段；mp4 拿到响应即可
        if (/\.m3u8/i.test(url)) {
          const text = await res.text();
          if (!/#EXTM3U|#EXT-X/i.test(text)) { lastNote = 'm3u8 内容无效'; continue; }
        }
        return { ok: true, wrap };
      } catch (e) {
        lastNote = e.name === 'AbortError'
          ? '响应超时'
          : '网络受限/不可达（若电脑开着 VPN/Clash 等代理，请关闭或把视频域名设为直连再试）';
      }
    }
    return { ok: false, note: lastNote || '不可达' };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 播放器（hls.js） ---------------- */
let hlsInstance = null;
let currentEpisodes = [];
let currentEpIdx = 0;

function destroyHls() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  const v = $('videoPlayer');
  v.removeAttribute('src');
  v.load();
}

async function playVideo(url) {
  const v = $('videoPlayer');
  destroyHls();
  if (window.Hls && Hls.isSupported() && /\.m3u8/i.test(url)) {
    hlsInstance = new Hls({ maxBufferLength: 30 });
    hlsInstance.loadSource(px(url));
    hlsInstance.attachMedia(v);
    hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
    hlsInstance.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        toast('播放出错了，试试换一个渠道喵…', 'err');
        autoSwitchChannel();
      }
    });
  } else {
    v.src = px(url);
    v.play().catch(() => {});
    v.onerror = () => { toast('播放出错了，试试换一个渠道喵…', 'err'); autoSwitchChannel(); };
  }
}

/* ---------------- 横屏播放 ----------------
 * 两种环境：
 *  1. 手机（iOS + 安卓）：CSS 伪横屏 —— 容器旋转 90° 铺满整屏，不受系统「竖排方向锁」限制。
 *     特意不用 requestFullscreen：安卓 Chrome 进入真全屏会弹无法由网页控制的系统提示条，
 *     伪横屏视觉效果相同且不触发任何浏览器提示；
 *  2. 桌面浏览器：普通全屏（F11 那种）。
 */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobile/i.test(navigator.userAgent);
let pseudoLandscape = false;

function playerWrap() { return document.querySelector('.player-wrap'); }

function updateRotateBtn() {
  const on = pseudoLandscape || !!document.fullscreenElement;
  const btn = $('rotateBtn');
  if (!btn) return;
  btn.textContent = on ? '⤡ 竖屏' : '⤢ 横屏';
  btn.title = on ? '退出横屏' : '横屏观看';
}

function enterPseudoLandscape() {
  const wrap = playerWrap();
  if (!wrap) return;
  pseudoLandscape = true;
  wrap.classList.add('pseudo-landscape');
  document.body.classList.add('pl-on');
  $('lsExit').classList.remove('hidden');
  updateRotateBtn();
}

function exitPseudoLandscape() {
  const wrap = playerWrap();
  pseudoLandscape = false;
  if (wrap) wrap.classList.remove('pseudo-landscape');
  document.body.classList.remove('pl-on');
  const exit = $('lsExit');
  if (exit) exit.classList.add('hidden');
  updateRotateBtn();
}

async function toggleLandscape() {
  // 已横屏 → 退出
  if (pseudoLandscape) { exitPseudoLandscape(); return; }
  if (document.fullscreenElement) {
    try { await document.exitFullscreen(); } catch (e) { /* ignore */ }
    updateRotateBtn();
    return;
  }

  // 手机（iOS + 安卓）：统一走伪横屏。
  // 不用 requestFullscreen —— 安卓 Chrome 进入真全屏会弹无法关闭权限的系统提示条，
  // 伪横屏视觉效果相同（容器旋转 90° 铺满整屏）且不触发任何浏览器提示。
  if (IS_MOBILE) { enterPseudoLandscape(); return; }

  // 桌面：普通全屏
  const wrap = playerWrap();
  if (!wrap) return;
  try { await wrap.requestFullscreen(); } catch (e) { toast('当前浏览器不支持全屏喵…', 'warn'); }
  updateRotateBtn();
}

/** 彻底退出横屏（关弹窗时调用） */
async function exitLandscapeAll() {
  if (pseudoLandscape) exitPseudoLandscape();
  if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (e) { /* ignore */ } }
  if (screen.orientation && screen.orientation.unlock) { try { screen.orientation.unlock(); } catch (e) { /* ignore */ } }
  updateRotateBtn();
}

/* ---------------- 弹窗与渠道管理 ---------------- */
let modalItem = null;          // 当前弹窗对应的条目
let modalChannelIdx = 0;       // 当前尝试的渠道序号
let channelStatus = [];        // 各渠道检测状态

function openModal(item) {
  modalItem = item;
  modalChannelIdx = 0;
  channelStatus = item.channels.map(() => 'pending');
  $('mCover').src = item.pic || placeholderImg(item.name);
  $('mTitle').textContent = item.name;
  $('mMeta').textContent = [item.year, item.remark, item.cls].filter(Boolean).join(' · ');
  $('playerModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderChannelTabs();
  tryChannel(0);
}

function placeholderImg(name) {
  // 无封面时画一个可爱的占位
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="240">
      <rect width="180" height="240" fill="#ffe3ef"/>
      <text x="90" y="110" font-size="52" text-anchor="middle">🐱</text>
      <text x="90" y="160" font-size="15" text-anchor="middle" fill="#e5608f">${(name || '').slice(0, 8)}</text>
    </svg>`);
}

function closeModal() {
  exitLandscapeAll();   // 关弹窗前先退出横屏/全屏，避免旋转残留
  $('playerModal').classList.add('hidden');
  document.body.style.overflow = '';
  destroyHls();
  modalItem = null;
}

function renderChannelTabs() {
  const box = $('channelTabs');
  box.innerHTML = '';
  modalItem.channels.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'ch-tab' + (i === modalChannelIdx ? ' active' : '');
    const icon = { pending: '⏳', ok: '✅', fail: '❌', current: '▶️' }[channelStatus[i]] || '⏳';
    // 🌐=线上可直连的渠道 / 💻=仅本地代理模式可用
    const env = c.channel.cors ? '🌐' : '💻';
    btn.title = c.channel.cors ? '该渠道开放跨域，线上/本地都能播' : '该渠道需本地代理（python serve.py），线上不可用';
    btn.innerHTML = `<span class="dot">${icon}</span>${env}${escapeHtml(c.channel.name)}`;
    btn.onclick = () => {
      if (channelStatus[i] === 'fail') { toast(`${c.channel.name} 检测不可用，已跳过喵`, 'warn'); return; }
      tryChannel(i);
    };
    box.appendChild(btn);
  });
}

function setPanel(name) {
  ['detectPanel', 'failPanel', 'playPanel'].forEach(p => $(p).classList.add('hidden'));
  if (name) $(name).classList.remove('hidden');
}

/**
 * 尝试某个渠道：检测 → 通过则播放；不通过自动切下一个
 */
async function tryChannel(idx, epIdx = 0) {
  if (!modalItem) return;
  const channels = modalItem.channels;
  if (idx >= channels.length) {
    // 全部渠道失败
    channelStatus = channelStatus.map(() => 'fail');
    renderChannelTabs();
    setPanel('failPanel');
    $('failText').textContent = '所有渠道都暂时播不了这部番喵… 请稍后点「换源重试」再试一次';
    return;
  }
  modalChannelIdx = idx;
  channelStatus[idx] = 'pending';
  renderChannelTabs();
  setPanel('detectPanel');
  $('detectText').textContent = `正在检测「${channels[idx].channel.name}」的播放源是否真的可播…`;

  const det = await detectChannel(channels[idx].channel, channels[idx].id, epIdx, channels[idx].episodes);

  if (det.ok) {
    channelStatus[idx] = 'ok';
    renderChannelTabs();
    setPanel('playPanel');
    currentEpisodes = det.episodes;
    currentEpIdx = Math.min(epIdx, det.episodes.length - 1);
    renderEpList();
    playEpisode(currentEpIdx);
    toast(`检测通过！已从「${channels[idx].channel.name}」开始播放`, 'ok');
  } else {
    channelStatus[idx] = 'fail';
    renderChannelTabs();
    toast(`「${channels[idx].channel.name}」不可播（${det.note}），自动换源中…`, 'warn');
    tryChannel(idx + 1, epIdx);   // 自动换源
  }
}

/** 播放出错时被 hls 回调触发：换下一个可用渠道 */
function autoSwitchChannel() {
  if (!modalItem) return;
  const next = modalChannelIdx + 1;
  if (next < modalItem.channels.length && channelStatus[next] !== 'fail') {
    tryChannel(next, currentEpIdx);
  } else {
    setPanel('failPanel');
    $('failText').textContent = '播放中断且没有其他可用渠道了喵… 点「换源重试」再试试';
  }
}

function renderEpList() {
  const box = $('epList');
  box.innerHTML = '';
  $('epCount').textContent = `共 ${currentEpisodes.length} 集`;
  currentEpisodes.forEach((ep, i) => {
    const b = document.createElement('button');
    b.className = 'ep-item' + (i === currentEpIdx ? ' current' : '');
    b.textContent = ep.name || `第${i + 1}集`;
    b.title = ep.name;
    b.onclick = () => {
      if (i === currentEpIdx) return;
      playEpisode(i, true);
    };
    box.appendChild(b);
  });
  $('prevEp').disabled = currentEpIdx <= 0;
  $('nextEp').disabled = currentEpIdx >= currentEpisodes.length - 1;
}

async function playEpisode(i, reprobe = false) {
  currentEpIdx = i;
  renderEpList();
  $('epNow').textContent = currentEpisodes[i].name || `第${i + 1}集`;
  const ch = modalItem.channels[modalChannelIdx];
  if (reprobe) {
    // 换集时也先快速探测一下这一集
    setPanel('detectPanel');
    $('detectText').textContent = '正在检测这一集是否可播…';
    const probe = await probeVideoUrl(currentEpisodes[i].url);
    if (!probe.ok) {
      toast(`「${currentEpisodes[i].name}」这一集不可播（${probe.note}）`, 'err');
      setPanel('playPanel');
      return;
    }
    setPanel('playPanel');
  }
  playVideo(currentEpisodes[i].url);
  saveHistory({ name: modalItem.name, pic: modalItem.pic, channel: ch.channel.name, epIdx: i, epName: currentEpisodes[i].name });
}

/* ---------------- 播放历史 ---------------- */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch { return []; }
}
function saveHistory(entry) {
  const list = loadHistory().filter(h => h.name !== entry.name);
  list.unshift({ ...entry, time: Date.now() });
  localStorage.setItem(LS_HISTORY, JSON.stringify(list.slice(0, 8)));
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  const sec = $('historySection');
  if (!list.length) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  const box = $('historyList');
  box.innerHTML = '';
  list.forEach(h => {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.innerHTML = `
      <img src="${escapeHtml(h.pic || '')}" onerror="this.style.visibility='hidden'">
      <div><div class="hi-name">${escapeHtml(h.name)}</div>
      <div class="hi-ep">${escapeHtml(h.channel || '')} · ${escapeHtml(h.epName || '')}</div></div>
      <span class="hi-x" title="删除">✖</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains('hi-x')) return;
      // 从历史直接恢复播放：重新搜索定位
      doSearch(h.name).then(() => {
        const target = lastResults.find(r => normalizeTitle(r.name) === normalizeTitle(h.name));
        if (target) openModal(target, h.epIdx);
        else toast('没有重新找到这部番喵…', 'warn');
      });
    };
    el.querySelector('.hi-x').onclick = (e) => {
      e.stopPropagation();
      localStorage.setItem(LS_HISTORY, JSON.stringify(loadHistory().filter(x => x.name !== h.name)));
      renderHistory();
    };
    box.appendChild(el);
  });
}

// openModal 支持起始集数（从历史恢复用）
let resumeEpIdx = 0;
const _openModal = openModal;
openModal = function (item, epIdx = 0) {
  resumeEpIdx = epIdx || 0;
  modalItem = item;
  modalChannelIdx = 0;
  channelStatus = item.channels.map(() => 'pending');
  $('mCover').src = item.pic || placeholderImg(item.name);
  $('mTitle').textContent = item.name;
  $('mMeta').textContent = [item.year, item.remark, item.cls].filter(Boolean).join(' · ');
  $('playerModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  renderChannelTabs();
  updateRotateBtn();
  tryChannel(0, resumeEpIdx);
};

/* ---------------- 排序 ---------------- */
function getYear(v) {
  const m = String(v || '').match(/(\d{4})/);
  return m ? +m[1] : -1;
}

/** 按筛选框排序；无年份的条目始终排在最后 */
function sortResults(items, mode) {
  const withYear = [], noYear = [];
  for (const it of items) (getYear(it.year) < 0 ? noYear : withYear).push(it);
  switch (mode) {
    case 'year-asc':
      withYear.sort((a, b) => getYear(a.year) - getYear(b.year));
      break;
    case 'src-desc':
      withYear.sort((a, b) => b.channels.length - a.channels.length);
      noYear.sort((a, b) => b.channels.length - a.channels.length);
      break;
    case 'name-asc':
      withYear.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      noYear.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      break;
    default: // year-desc（默认）
      withYear.sort((a, b) => getYear(b.year) - getYear(a.year));
  }
  return [...withYear, ...noYear];
}

/* ---------------- 渲染搜索结果 ---------------- */
let lastResults = [];

function renderResults(items) {
  const mode = $('sortSelect') ? $('sortSelect').value : 'year-desc';
  const sorted = sortResults(items, mode).slice(0, 36);
  const grid = $('resultGrid');
  grid.innerHTML = '';
  $('resultCount').textContent = `${items.length} 部`;
  sorted.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = (i * 0.05) + 's';
    card.innerHTML = `
      <div class="poster-wrap">
        <img class="poster" src="${escapeHtml(item.pic || '')}" alt="${escapeHtml(item.name)}"
             onerror="this.src='${placeholderImg(item.name).replace(/'/g, '&#39')}'">
        ${item.remark ? `<span class="remarks">${escapeHtml(item.remark)}</span>` : ''}
      </div>
      <div class="card-body">
        <div class="card-name">${escapeHtml(item.name)}</div>
        <div class="card-meta"><span>${escapeHtml(item.year || '')}</span></div>
        <div class="src-count">📺 ${item.sources.length} 个渠道可查</div>
      </div>`;
    card.onclick = () => openModal(item);
    grid.appendChild(card);
  });
  $('resultSection').classList.remove('hidden');
}

/* ---------------- 番名联想（输入前几个字实时推荐番名） ----------------
 * 用轻量接口 ac=videolist（响应小、不带剧集，比播放用的 ac=detail 快得多），
 * 多渠道并行、渐进合并，先到的先显示；点击直接搜。 */
const SUGGEST_DEBOUNCE = 300;    // 停止输入 300ms 才请求
const SUGGEST_TIMEOUT = 3500;    // 联想单请求超时（比正式搜索更短，保证跟手）
const SUGGEST_MAX = 12;          // 下拉最多展示条数
const SUGGEST_MIN_CHARS = 2;     // 至少输入 2 个字才联想
let suggestSeq = 0;
let suggestTimer = null;
let sugActiveIdx = -1;           // 键盘高亮行
const sugCache = new Map();      // 前缀 -> 候选列表（同一前缀不重复请求）

/** 轻量搜索，仅供联想（不解析剧集） */
async function suggestChannel(ch, query) {
  const url = `${ch.api}?ac=videolist&wd=${encodeURIComponent(query)}`;
  let data = null;
  let cands = candidateUrls(url);
  if (IS_REMOTE && !ch.cors) cands = [...cands.filter(c => c.wrap), ...cands.filter(c => !c.wrap)];
  for (const { u } of cands) {
    if (data) break;
    try {
      const res = await fetchTimeout(u, SUGGEST_TIMEOUT);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) { /* 试下一个候选 */ }
  }
  return (((data && data.list) || []))
    .map(v => ({
      name: String(v.vod_name || '').trim(),
      pic: v.vod_pic || '',
      remark: String(v.vod_remarks || '').trim(),
      year: String(v.vod_year || '').trim(),
    }))
    .filter(v => v.name);
}

function suggestMatch(name, query) {
  const n = normalizeTitle(name).toLowerCase();
  const q = normalizeTitle(query).toLowerCase();
  return n.includes(q) || q.includes(n.slice(0, Math.max(2, q.length - 1)));
}

/** 渐进式联想：每个渠道先回来就先刷新下拉 */
async function requestSuggestions(query) {
  const seq = ++suggestSeq;
  const cached = sugCache.get(query);
  if (cached) { renderSuggestions(cached, query); return; }

  const merged = new Map();
  const flush = () => {
    if (seq !== suggestSeq) return;
    const items = [...merged.values()];
    if (sugCache.size > 40) sugCache.clear();   // 简易防膨胀
    sugCache.set(query, items);
    renderSuggestions(items, query);
  };

  CHANNELS.forEach(async (ch) => {
    const r = await suggestChannel(ch, query).catch(() => []);
    if (seq !== suggestSeq) return;
    const rel = r.filter(it => suggestMatch(it.name, query));
    for (const it of (rel.length ? rel : r)) {
      const key = normalizeTitle(it.name);
      if (key && !merged.has(key)) merged.set(key, it);
    }
    flush();
  });
}

function highlightName(name, query) {
  const idx = name.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return escapeHtml(name);
  return escapeHtml(name.slice(0, idx)) + '<b>' +
    escapeHtml(name.slice(idx, idx + query.length)) + '</b>' +
    escapeHtml(name.slice(idx + query.length));
}

function renderSuggestions(items, query) {
  const box = $('suggestBox');
  if (!items.length) { hideSuggestions(); return; }
  sugActiveIdx = -1;
  box.innerHTML = items.slice(0, SUGGEST_MAX).map(it => {
    const thumb = it.pic
      ? `<img class="sg-thumb" src="${escapeHtml(it.pic)}" loading="lazy" onerror="this.outerHTML='<div class=&quot;sg-emoji&quot;>🐱</div>'">`
      : `<div class="sg-emoji">🐱</div>`;
    return `<div class="suggest-item" data-name="${escapeHtml(it.name)}">
      ${thumb}
      <div class="sg-info">
        <div class="sg-name">${highlightName(it.name, query)}</div>
        <div class="sg-meta">${escapeHtml([it.year, it.remark].filter(Boolean).join(' · ') || '点击直接搜')}</div>
      </div>
    </div>`;
  }).join('') + (items.length > SUGGEST_MAX ? '<div class="suggest-more">…还有更多，回车直接搜</div>' : '');
  box.classList.remove('hidden');
  // mousedown + preventDefault：抢在 input blur 隐藏下拉之前完成点选
  box.querySelectorAll('.suggest-item').forEach(el => {
    el.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggestion(el.dataset.name); });
  });
}

function pickSuggestion(name) {
  hideSuggestions();
  $('searchInput').value = name;
  doSearch(name);
}

function hideSuggestions() {
  const box = $('suggestBox');
  box.classList.add('hidden');
  box.innerHTML = '';
  sugActiveIdx = -1;
}

/** 输入框防抖入口 + 键盘上下选择 */
function onSearchInput(value) {
  clearTimeout(suggestTimer);
  const q = String(value || '').trim();
  if (q.length < SUGGEST_MIN_CHARS) { hideSuggestions(); return; }
  suggestTimer = setTimeout(() => requestSuggestions(q), SUGGEST_DEBOUNCE);
}

/** 键盘在联想下拉里移动高亮，返回当前高亮的番名（没有则 null） */
function suggestKeynav(key) {
  const box = $('suggestBox');
  if (box.classList.contains('hidden')) return null;
  const items = [...box.querySelectorAll('.suggest-item')];
  if (!items.length) return null;
  if (key === 'ArrowDown') sugActiveIdx = (sugActiveIdx + 1) % items.length;
  else if (key === 'ArrowUp') sugActiveIdx = (sugActiveIdx - 1 + items.length) % items.length;
  else return null;
  items.forEach((el, i) => el.classList.toggle('active', i === sugActiveIdx));
  items[sugActiveIdx].scrollIntoView({ block: 'nearest' });
  return items[sugActiveIdx].dataset.name;
}

/* ---------------- 搜索入口 ---------------- */
let searching = false;
let searchSeq = 0;   // 搜索序号：过期搜索（被新搜索取代/超时后后台补结果）不再渲染

/** 过滤 + 存 lastResults（doSearch 与渐进回调共用） */
function applyResults(items, query) {
  const q = normalizeTitle(query);
  const related = items.filter(it => {
    const n = it.name.toLowerCase();
    return normalizeTitle(n).includes(q.slice(0, Math.max(2, q.length - 1))) ||
           q.includes(normalizeTitle(n).slice(0, Math.max(2, n.length - 1)));
  });
  lastResults = related.length ? related : items;   // 保留全量，排序/截断交给 renderResults
  return lastResults;
}

async function doSearch(query) {
  query = String(query || '').trim();
  if (!query) { toast('先输入想看的动漫名字喵～', 'warn'); return; }
  if (searching) return;
  searching = true;
  const seq = ++searchSeq;
  hideSuggestions();

  $('resultSection').classList.add('hidden');
  $('emptyArea').classList.add('hidden');
  $('statusArea').classList.remove('hidden');
  $('statusText').textContent = `正在翻遍 ${CHANNELS.length} 个渠道找「${query}」…`;
  $('searchInput').value = query;

  // 渐进式渲染：任一渠道先回来就先出卡片，不等最慢的渠道
  const onPartial = (partial, _ch, pending) => {
    if (seq !== searchSeq) return;   // 已被更新的搜索取代
    const list = applyResults(partial, query);
    if (list.length) {
      $('emptyArea').classList.add('hidden');
      renderResults(list);
    }
    if (pending > 0) {
      $('statusArea').classList.remove('hidden');
      $('statusText').textContent = `🌸 已找到 ${list.length} 部，还在翻剩余 ${pending} 个渠道…`;
    } else {
      $('statusArea').classList.add('hidden');
    }
  };

  try {
    const items = await searchAll(query, onPartial);
    if (seq !== searchSeq) return;
    const list = applyResults(items, query);
    $('statusArea').classList.add('hidden');
    if (!list.length) {
      $('emptyArea').classList.remove('hidden');
      $('emptyText').textContent = `没有在 ${CHANNELS.length} 个渠道找到「${query}」喵… 换个名字试试？`;
    } else {
      renderResults(list);
    }
  } finally {
    if (seq === searchSeq) searching = false;
  }
}

/* ---------------- 事件绑定 ---------------- */
$('searchBtn').onclick = () => { hideSuggestions(); doSearch($('searchInput').value); };
$('searchInput').addEventListener('input', (e) => onSearchInput(e.target.value));
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const picked = suggestKeynav(e.key);
    if (picked) { e.preventDefault(); return; }   // 联想高亮中：不移动光标，回车时选中
  }
  if (e.key === 'Enter') {
    const box = $('suggestBox');
    const active = !box.classList.contains('hidden') && sugActiveIdx >= 0
      ? box.querySelectorAll('.suggest-item')[sugActiveIdx] : null;
    hideSuggestions();
    doSearch(active ? active.dataset.name : e.target.value);
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.search-wrap')) hideSuggestions(); });
document.querySelectorAll('.chip').forEach(c => c.onclick = () => doSearch(c.dataset.q));
$('modalClose').onclick = closeModal;
$('modalMask').onclick = closeModal;
$('retryBtn').onclick = () => {
  if (!modalItem) return;
  channelStatus = modalItem.channels.map(() => 'pending');
  availCache.clear();   // 重试时清掉缓存的失败结果，全部重新检测
  tryChannel(0, 0);
};
$('prevEp').onclick = () => { if (currentEpIdx > 0) playEpisode(currentEpIdx - 1, true); };
$('nextEp').onclick = () => { if (currentEpIdx < currentEpisodes.length - 1) playEpisode(currentEpIdx + 1, true); };
$('rotateBtn').onclick = toggleLandscape;
$('lsExit').onclick = () => exitPseudoLandscape();
document.addEventListener('fullscreenchange', updateRotateBtn);
document.addEventListener('webkitfullscreenchange', updateRotateBtn);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (pseudoLandscape) { exitPseudoLandscape(); return; }   // 横屏时 Esc 先退横屏
  if (!$('playerModal').classList.contains('hidden')) closeModal();
});
$('sortSelect').onchange = () => renderResults(lastResults);

renderHistory();

// file:// 直开模式下大部分渠道会被浏览器 CORS 拦截，提醒用户
if (!IS_LOCAL_SERVER && !IS_REMOTE) {
  toast('当前是直接打开模式，多渠道会被浏览器拦截喵！请用 python serve.py 启动，或部署到 GitHub Pages 观看', 'warn', 8000);
} else if (IS_REMOTE) {
  toast('线上模式：🌐 渠道可直连播放；💻 渠道需要本地代理，线上会自动跳过', '', 5000);
}
