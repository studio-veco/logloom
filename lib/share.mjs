// 配るための1枚。
//
// **配る先に、この道具は無い。**サーバも drawio も whisper も無いところで開かれる。
// なので、地図も議事録も書き起こしも、1つの .html に焼き込む。外から読むものは無い。
//
// 中身は会議そのものなので、**URL を知っている人は誰でも読める。**
// 名前は当てられない長さの乱数にして、画面にもそう書く。

import * as mx from './mx.mjs';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 議事録の Markdown を、そのまま読める HTML にする（外の道具は使わない） */
function md2html(md) {
  const out = [];
  let inTable = false;
  const flushTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const inline = (s) => esc(s)
    .replace(/&lt;!--[\s\S]*?--&gt;/g, '')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  for (const line of String(md).split('\n')) {
    const t = line.trim();
    if (/^\|\s*-+/.test(t)) continue;                       // 表の区切り
    if (t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => inline(c.trim()));
      // 見出しの無い表（日時・出席の表）は、空の帯が1本出るだけなので置かない
      if (!cells.some(Boolean)) continue;
      if (!inTable) { out.push('<table><tbody>'); inTable = true; }
      out.push(`<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`);
      continue;
    }
    flushTable();
    if (!t) continue;
    if (t === '---') { out.push('<hr>'); continue; }
    const h = t.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (t.startsWith('- ')) {
      if (out[out.length - 1]?.startsWith('<li')) out.push(`<li>${inline(t.slice(2))}</li>`);
      else out.push(`<li>${inline(t.slice(2))}</li>`);
      continue;
    }
    // 太字だけの行は、論点の見出し。段落ではなく見出しとして置く
    const b = t.match(/^\*\*(.+)\*\*$/);
    if (b) { out.push(`<h4>${inline(b[1])}</h4>`); continue; }
    out.push(`<p>${inline(t)}</p>`);
  }
  flushTable();
  // 続いた <li> を <ul> で包む
  return out.join('\n').replace(/(?:<li>.*?<\/li>\n?)+/gs, (m) => `<ul>${m}</ul>`);
}

const two = (n) => String(n).padStart(2, '0');

export function html(tree, minutes, transcript, { title = '議事録', at = Date.now() } = {}) {
  const d = new Date(at);
  const rows = transcript.map((l) => {
    const t = new Date(l.at);
    return `<li id="${esc(l.id)}"><div class="t">${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`
      + `${l.who ? `<span class="who">${esc(l.who)}</span>` : ''}</div>`
      + `<div class="x">${esc(l.text)}</div></li>`;
  }).join('');

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}｜議事録</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">
<style>
 :root{--ink:#1a1a1a;--sub:#767676;--line:#e6e6e6;--bg:#fff;--surface:#f7f8fa;--primary:#0017c1;--lit:#fffbeb}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.8 'Noto Sans JP',system-ui,sans-serif}
 .wrap{max-width:1040px;margin:0 auto;padding:0 16px 72px}
 header{border-bottom:1px solid var(--line);padding:28px 0 18px;margin-bottom:24px}
 h1{font-size:clamp(20px,4vw,28px);margin:0 0 6px;line-height:1.4}
 .meta{color:var(--sub);font-size:13px}
 nav{position:sticky;top:0;background:rgba(255,255,255,.94);backdrop-filter:blur(6px);
     border-bottom:1px solid var(--line);z-index:5;margin:0 -16px 24px;padding:0 16px}
 nav ul{display:flex;gap:4px;list-style:none;margin:0;padding:0;overflow-x:auto}
 nav a{display:block;padding:12px 14px;min-height:44px;color:var(--sub);text-decoration:none;
       font-size:13px;font-weight:700;border-bottom:2px solid transparent;white-space:nowrap}
 nav a:hover{color:var(--primary)}
 h2{font-size:17px;margin:32px 0 10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
 h3{font-size:15px;margin:22px 0 6px}
 h4{font-size:14px;margin:16px 0 4px}
 p{margin:0 0 10px}
 ul{margin:0 0 12px;padding-left:1.3em}
 li{margin:2px 0}
 table{border-collapse:collapse;width:100%;margin:0 0 14px;font-size:14px}
 td{border:1px solid var(--line);padding:8px 10px;vertical-align:top}
 tr:first-child td{background:var(--surface);font-weight:700}
 hr{border:0;border-top:1px solid var(--line);margin:24px 0}
 .mapbox{border:1px solid var(--line);border-radius:12px;background:var(--surface);
         padding:12px;overflow:auto;max-height:76vh}
 .mapbox svg{display:block;min-width:100%;height:auto}
 .bx.tap{cursor:pointer}
 .bx.tap:hover rect{stroke:var(--primary);stroke-width:2}
 .bx.tap:focus{outline:none}
 .bx.tap:focus rect{stroke:#ffd43d;stroke-width:4}
 .hint{color:var(--sub);font-size:13px;margin:8px 0 0}
 ol.log{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
 ol.log li{padding:10px 12px;border-bottom:1px solid var(--line);scroll-margin-top:72px;border-radius:0 6px 6px 0}
 ol.log li.lit{background:var(--lit);box-shadow:inset 3px 0 0 var(--primary)}
 ol.log .t{font-size:11px;color:var(--sub);font-variant-numeric:tabular-nums}
 ol.log .who{margin-left:8px;border:1px solid var(--line);border-radius:4px;padding:1px 6px}
 ol.log .x{margin-top:2px}
 footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:var(--sub);font-size:12px}
 /* 狭い画面では、原寸のままだと根しか見えない（実測：375px で黒い箱1つだけ）。
    まず全体を入れて、読みたいところは指で広げてもらう */
 @media (max-width:820px){
   .mapbox{max-height:none;padding:8px}
   .mapbox svg{width:100%;min-width:0;height:auto}
 }
</style></head>
<body><div class="wrap">
<header>
  <h1>${esc(title)}</h1>
  <div class="meta">${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${two(d.getHours())}:${two(d.getMinutes())} 開始　／　発言 ${transcript.length} 件</div>
</header>
<nav><ul>
  <li><a href="#map">マインドマップ</a></li>
  <li><a href="#minutes">議事録</a></li>
  <li><a href="#log">書き起こし</a></li>
</ul></nav>

<h2 id="map">マインドマップ</h2>
<div class="mapbox">${mx.svg(tree)}</div>
<p class="hint">要点と、決まったこと・やること・課題の箱を押すと、その場面の書き起こしまで移動します。</p>

<h2 id="minutes">議事録</h2>
${md2html(String(minutes).split('## 書き起こし')[0].replace(/^#\s+.*\n/, ''))}

<h2 id="log">書き起こし</h2>
<ol class="log">${rows}</ol>

<footer>
  この記録は会議の音声から自動で作ったものです。言い回しは読みやすさのために整えてあります。<br>
  このページは、URL を知っている人なら誰でも開けます。中身は会議そのものです。配る先にご注意ください。
</footer>
</div>
<script>
 // 地図の箱を押したら、その場面の書き起こしへ
 var t = null;
 function lightUp(ids){
   document.querySelectorAll('ol.log li.lit').forEach(function(e){ e.classList.remove('lit'); });
   var first = null;
   ids.forEach(function(id){
     var el = document.getElementById(id);
     if (!el) return;
     el.classList.add('lit');
     if (!first) first = el;
   });
   if (!first) return;
   first.scrollIntoView({ block:'center', behavior:'smooth' });
   clearTimeout(t);
   t = setTimeout(function(){
     document.querySelectorAll('ol.log li.lit').forEach(function(e){ e.classList.remove('lit'); });
   }, 6000);
 }
 document.querySelectorAll('.bx.tap').forEach(function(g){
   function go(){ lightUp((g.getAttribute('data-jump')||'').split(',').filter(Boolean)); }
   g.addEventListener('click', go);
   g.addEventListener('keydown', function(e){ if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
 });
</script>
</body></html>`;
}
