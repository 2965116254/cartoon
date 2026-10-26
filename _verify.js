(async()=>{
  const r = await fetch('https://bfzyapi.com/api.php/provide/vod?ac=detail&wd='+encodeURIComponent('千与千寻'), {headers:{'Origin':'https://2965116254.github.io'}});
  const j = await r.json();
  const hit = j.list.find(v=>v.vod_name.includes('千与千寻'));
  const pf=String(hit.vod_play_from).split('$$$'), gs=String(hit.vod_play_url).split('$$$');
  let gi=0; for(let i=0;i<pf.length;i++){if(/m3u8/i.test(pf[i]||'')){gi=i;break}}
  const eps=(gs[gi]||'').split('#').map(s=>{const i=s.indexOf('$');return i<0?{name:'?',url:s}:{name:s.slice(0,i),url:s.slice(i+1)}}).filter(e=>/^https?:/.test(e.url));
  console.log('搜索即得剧集:', hit.vod_name, eps.length+'集', '| 首集:', eps[0].name);
  const p = await fetch(eps[0].url, {headers:{'Origin':'https://2965116254.github.io'}});
  const t = await p.text();
  console.log('首集探测:', p.headers.get('access-control-allow-origin')==='*'?'ACAO:*✅':'无CORS❌', /#EXTM3U/.test(t)?'内容✅':'内容❌');
})()
