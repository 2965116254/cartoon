// 完整模拟浏览器请求头：Origin/UA/Referer 与 github.io 一致
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function test(name, url, headers) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers });
    const acao = r.headers.get('access-control-allow-origin');
    const txt = await r.text();
    console.log(`${name}: HTTP${r.status} ACAO:${acao||'无'} [${Date.now()-t0}ms] 前50字:${txt.slice(0,50).replace(/\s+/g,' ')}`);
    return txt;
  } catch (e) { console.log(`${name}: ❌ ${e.message} [${Date.now()-t0}ms]`); return ''; }
}
const BROWSER = { 'User-Agent': UA, 'Origin': 'https://2965116254.github.io', 'Referer': 'https://2965116254.github.io/cartoon/', 'Accept': '*/*' };
// 1. 搜索（浏览器同款头）
const s = await test('① 搜索(带Origin)', 'https://bfzyapi.com/api.php/provide/vod?ac=videolist&wd=%E7%81%AB%E5%BD%B1%E5%BF%8D%E8%80%85', BROWSER);
// 2. ac=detail&wd= 一次拿全集？
const d = await test('② ac=detail&wd= (带Origin)', 'https://bfzyapi.com/api.php/provide/vod?ac=detail&wd=%E7%81%AB%E5%BD%B1%E5%BF%8D%E8%80%85', BROWSER);
try {
  const j = JSON.parse(d);
  const hit = (j.list||[]).find(v=>v.vod_name==='火影忍者');
  if (hit) {
    const has = hit.vod_play_url && hit.vod_play_url.includes('m3u8');
    console.log(`② 详情字段检查: vod_play_url ${has ? '✅搜索就带全集地址!' : '❌不带'}`);
    if (has) {
      const pf=String(hit.vod_play_from).split('$$$'), gs=String(hit.vod_play_url).split('$$$');
      let gi=0; for(let i=0;i<pf.length;i++){if(/m3u8/i.test(pf[i]||'')){gi=i;break}}
      const eps=(gs[gi]||'').split('#').filter(Boolean);
      const fe=eps[0]||''; const url=fe.includes('$')?fe.split('$').pop():fe;
      await test('③ 该m3u8直连(带Origin)', url, BROWSER);
    }
  }
} catch(e){ console.log('② 解析失败:', e.message); }
// 3. 传统 detail&ids 再测一次
await test('④ ac=detail&ids= (带Origin)', 'https://bfzyapi.com/api.php/provide/vod?ac=detail&ids=28209', BROWSER);
