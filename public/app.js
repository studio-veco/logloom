// 画面。サーバから押されてくるものを、マインドマップと書き起こしに流すだけ。

const $ = (id) => document.getElementById(id);
const mapFrame = $('map');

let mapReady = false;
let pendingXml = null;
let pendingExtent = null;
let loadedOnce = false;
let listening = false;
let lastWords = [];
let lastStatus = null;

const icon = (name, cls = 'i') =>
  `<svg class="${cls}" aria-hidden="true" focusable="false"><use href="#i-${name}"></use></svg>`;

// ---- マインドマップ（drawio） -------------------------------------------------
//
// 埋め込みの drawio は postMessage で話す。init が来たら load、そのあとは merge。
// **merge にするのは、見ている場所を動かさないため。**毎回 load すると、
// 枝が増えるたびに拡大率と位置が戻り、さっきまで読んでいた所を見失う。

// **図形の棚と書式の欄を、地図の側では閉じておく。**
// drawio は棚の幅を localStorage（.drawio-config）に覚える。「drawio で開いて整える」で
// 一度開くと、埋め込んだ地図でも開いたままになり、絵がほとんど隠れた（実測）。
// 親と中身は同じ出どころなので、読み込ませる前にこちらで書き換えられる。
(function openMapFrame() {
  // 幅を 0 に書き換えても、覚え書きを消しても閉じなかった。
  // 図形の棚と書式の欄は**浮いた窓（.mxWindow）**で、開き方は URL でも覚え書きでも変えられない。
  // 地図の側では出しておく意味がないので、読み込めたところで隠す。
  // 手で並べ替えたいときは「drawio で開いて整える」のほうで、ふつうの drawio が開く。
  try { localStorage.removeItem('.drawio-config'); } catch { /* 使えない所でも地図は出す */ }
  mapFrame.addEventListener('load', () => {
    try {
      const d = mapFrame.contentDocument;
      if (!d || d.getElementById('logloom-style')) return;
      const st = d.createElement('style');
      st.id = 'logloom-style';
      st.textContent = '.mxWindow{display:none!important}';
      d.head.appendChild(st);
      // **図の実体を、組まれる瞬間に捕まえる。**
      // drawio は EditorUi の実体を窓に出さないので、名前で拾えない（窓の中を探して0件）。
      // 図を組む init を包んで、通りがかりに控えておく。これが無いと、
      // 終点を押しても「どの箱か」が分からない
      const w = mapFrame.contentWindow;
      if (w.Graph && !w.__logloomHooked) {
        w.__logloomHooked = true;
        // **図は1つではない。**drawio は下書き用や見本用にもう1つ作る。
        // 先に来たほうを掴んでいたとき、中身が空のまま（図形2つ）だった。全部控えて、
        // 押されたときに中身のあるほうを選ぶ
        w.__logloomGraphs = [];
        const orig = w.Graph.prototype.init;
        w.Graph.prototype.init = function hooked(...args) {
          w.__logloomGraphs.push(this);
          return orig.apply(this, args);
        };
      }
    } catch { /* 出どころが違えば触れない。そのときは窓が出たままになる */ }
  });
  mapFrame.src = mapFrame.dataset.src;
})();

window.addEventListener('message', (e) => {
  if (e.source !== mapFrame.contentWindow) return;
  let msg;
  try { msg = JSON.parse(e.data); } catch { return; }
  if (msg.event === 'init') {
    mapReady = true;
    $('mapWait').hidden = true;
    if (pendingXml) sendMap(pendingXml, pendingExtent);
    watchTaps();
  }
});

// ---- 地図の終点を押したら、その場面の書き起こしへ ------------------------------
//
// 地図は「何が話されたか」しか出せない。**誰がどう言ったのかは、書き起こしにしかない。**
// 要点と振り分けの箱には、もとにした発言の番号を持たせてある（lib/mx.mjs の object）。
// 押された箱からそれを読んで、右の書き起こしをその場所まで送り、印を付ける。
//
// drawio は同じ生まれ（/drawio/）で出しているので、中の図を直に触れる。
// 出どころが違うと触れないので、そのときは何も起きない（地図は今までどおり動く）。
let tapsOn = false;
function watchTaps() {
  if (tapsOn) return;
  try {
    const w = mapFrame.contentWindow;
    const graphs = w.__logloomGraphs || [];
    if (!graphs.length || !w.mxEvent) return;
    for (const graph of graphs) graph.addListener(w.mxEvent.CLICK, (_s, evt) => {
      let cell = evt.getProperty('cell');
      while (cell) {
        const ids = cell.value?.getAttribute?.('jump');
        if (ids) {
          showUtterances(ids.split(',').filter(Boolean));
          // 押した箱を選んだままにしない（青い取っ手が出て、地図が編集中に見える）
          try { graph.clearSelection(); } catch { /* 選べない figure でも進む */ }
          evt.consume();
          return;
        }
        cell = cell.parent;
      }
    });
    tapsOn = true;
  } catch { /* 触れない所では、地図はそのまま見るだけになる */ }
}

/** 書き起こしを、その発言まで送って印を付ける */
function showUtterances(ids) {
  if (!ids.length) return;
  if (document.body.classList.contains('folded')) setFold(false);
  for (const el of document.querySelectorAll('#log li.lit')) el.classList.remove('lit');
  let first = null;
  for (const id of ids) {
    const have = seen.get(id);
    if (!have) continue;
    have.el.classList.add('lit');
    if (!first) first = have.el;
  }
  if (!first) return;
  first.scrollIntoView({ block: 'center', behavior: 'smooth' });
  // **消える印にする。**付けっぱなしだと、次に押したときどちらが今のものか分からない
  clearTimeout(showUtterances.t);
  showUtterances.t = setTimeout(() => {
    for (const el of document.querySelectorAll('#log li.lit')) el.classList.remove('lit');
  }, 6000);
}

// **枝が増えたら、全体が見えるところまで引く。**
//
// merge は差分を足すだけで、見ている所を動かさない。そのおかげで手で動かした位置は
// 保たれるが、放っておくと枝が画面の外へ伸びて何も見えなくなる（実測：録画で右端が切れた）。
//
// drawio の中を直に叩いて拡大率を変える手は、**あてにならなかった**
//（EditorUi が窓から見えず、Ctrl+Shift+H の作り物の打鍵も効かず、
//  下の帯のボタンは押すと位置が変わって次が押せなくなった）。
//
// そこで**決まっている動きだけを使う**。`load` は必ず全体が入る大きさに合わせてくれるので、
//   ・絵の大きさが前より大きくなった（＝枝が伸びた）ときだけ `load`
//   ・字が変わっただけのときは `merge`（見ている所はそのまま）
//   ・一度でも手で動かしたら、そのあとは `merge` だけ（その人の見たい所を動かさない）
let fitted = { w: 0, h: 0 };
let autoFit = true;

function watchTouch() {
  try {
    const d = mapFrame.contentDocument;
    if (!d) return;
    const off = () => { autoFit = false; $('fitBtn').classList.add('on'); };
    for (const ev of ['mousedown', 'wheel', 'touchstart']) d.addEventListener(ev, off, { passive: true });
  } catch { /* 触れないときは、追いかけたまま */ }
}

/**
 * 見る所の幅が変わったら、引き直す。
 *
 * **これが無いと、マップが小さいままになる。**書き起こしを畳んだり、窓を狭めたり、
 * スマホの幅で開いたりすると、そのときの幅に合わせて縮尺が決まる。幅が戻っても、
 * 引き直しは「絵が大きくなったとき」にしか走らないので、縮んだままになる
 * （実測：375px で開いたあと元に戻したら、地図が 1% の縮尺のまま白紙に見えた）。
 */
let refitTimer = null;
function refit() {
  if (!autoFit || !loadedOnce || !pendingXml || !mapReady) return;
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    try {
      mapFrame.contentWindow.postMessage(JSON.stringify({ action: 'load', xml: pendingXml, autosave: 0 }), '*');
    } catch { /* まだ出来ていないときは、次の書き換えで入る */ }
  }, 250);
}

function sendMap(xml, extent) {
  pendingXml = xml;
  pendingExtent = extent || pendingExtent;
  if (!mapReady) return;
  const post = (o) => mapFrame.contentWindow.postMessage(JSON.stringify(o), '*');
  const e = pendingExtent || { w: 0, h: 0 };
  const grew = e.w > fitted.w + 4 || e.h > fitted.h + 4;

  if (!loadedOnce || (autoFit && grew)) {
    post({ action: 'load', xml, autosave: 0 });
    fitted = { w: e.w, h: e.h };
    if (!loadedOnce) { loadedOnce = true; setTimeout(watchTouch, 800); }
  } else {
    post({ action: 'merge', xml });
  }
}

$('openDrawio').addEventListener('click', () => {
  // いまの形を、ふつうの drawio で開く。手で並べ替えたり、PNG・SVG・PDF に書き出せる。
  //
  // **押した瞬間に窓を開く。**マインドマップを取りに行ってから open を呼ぶと、
  // 押した指との縁が切れて、ブラウザが窓を止める（実測で null が返った）。
  // 中身は open-map.html が取りに行く。
  window.open('/open-map.html', '_blank');
});

// ---- つなぎっぱなしの通り道 --------------------------------------------------

let es = null;
function connect() {
  es = new EventSource('/api/events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'tree') {
      if (m.xml) sendMap(m.xml, m.extent);
      if (m.status) drawStatus(m.status);
      if (m.transcript) drawLog(m.transcript);
      else refreshLog();
    }
    if (m.type === 'status') drawStatus(m.status);
    if (m.type === 'note') addNote(m.note);
    if (m.type === 'level') $('level').style.width = `${m.level}%`;
  };
  es.onerror = () => { es.close(); setTimeout(connect, 2000); };
}

let logTimer = null;
function refreshLog() {
  if (logTimer) return;
  logTimer = setTimeout(() => {
    logTimer = null;
    fetch('/api/state').then((r) => r.json()).then((s) => drawLog(s.transcript));
  }, 400);
}

// ---- 書き起こし -------------------------------------------------------------

const seen = new Map();
// **直している最中の行は描き直さない。**
// 書き起こしは聞き取りのたびに描き直される。守らないと、打っている途中の文が消える
let editingId = null;

function drawLog(list) {
  const ol = $('log');
  let added = false;
  for (const u of list) {
    if (u.id === editingId) continue;
    const html = row(u);
    const have = seen.get(u.id);
    if (have && have.html === html) continue;
    if (have) { have.el.innerHTML = html; have.html = html; continue; }
    const li = document.createElement('li');
    li.innerHTML = html;
    ol.appendChild(li);
    seen.set(u.id, { el: li, html });
    added = true;
  }
  const has = seen.size > 0;
  $('logEmpty').hidden = has;
  ol.hidden = !has;
  if (added) ol.scrollTop = ol.scrollHeight;
}

const TAGS = {
  decision: ['dec', 'check', '決まったこと'],
  action: ['act', 'task', 'やること'],
  issue: ['iss', 'issue', '残った課題'],
};

function row(u) {
  const d = new Date(u.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');

  const who = u.who
    ? `<span class="tag ${u.who === '自分' ? 'me' : 'them'}">${icon(u.who === '自分' ? 'me' : 'them')}${esc(u.who)}</span>`
    : '';
  const top = (u.marks || {}).top;
  const t = TAGS[top];
  const mark = t ? `<span class="tag ${t[0]}">${icon(t[1])}${t[2]}</span>` : '';
  const tags = (who || mark) ? `<div class="tags">${who}${mark}</div>` : '';

  const fixes = (u.fixes || []).map((f) =>
    `<div class="fix">${icon('fix')}<s>${esc(f.from)}</s> → <b>${esc(f.to)}</b>`
    + `<span class="by">${esc(f.by)}</span></div>`).join('');

  // 手で直したことは、下の「直したところ」の行が「手入力」と示す。札を別に出すと重なる
  return `<div class="t">${icon('time')}${hh}:${mm}:${ss}`
    + `<button type="button" class="edit" data-id="${u.id}">${icon('pen')}<span>直す</span></button></div>`
    + `<div class="text">${esc(u.text)}</div>`
    + fixes + tags;
}

// ---- 手で直す ---------------------------------------------------------------
//
// 聞き取りと辞書と Jev を通しても残る誤りがある。同じ音のまま別の語になっている
// もの（「3小間」が「3個まで」）は、出口では直しようがない。人が直せるようにする。
// 直した結果は、要約と印と、これから来る発言まで通す。

$('log').addEventListener('click', (e) => {
  const b = e.target.closest('.edit');
  if (b) return openEditor(b.dataset.id);
});

function openEditor(id) {
  if (editingId && editingId !== id) closeEditor();
  const have = seen.get(id);
  if (!have) return;
  editingId = id;
  const text = have.el.querySelector('.text')?.textContent || '';
  const box = document.createElement('div');
  box.className = 'editor';
  box.innerHTML = `
    <label class="sr" for="fixText">直した文</label>
    <textarea id="fixText" rows="3" spellcheck="false"></textarea>
    <div class="opts">
      <label class="check"><input type="checkbox" id="fixLearn" checked>
        ${icon('dict')}<span>直した語を覚える</span></label>
      <label class="check"><input type="checkbox" id="fixSweep" checked>
        ${icon('fix')}<span>同じ誤りも直す</span></label>
    </div>
    <div class="row">
      <button type="button" class="btn btn-filled" id="fixSave">${icon('check')}<span>直す</span></button>
      <button type="button" class="btn btn-outline" id="fixCancel">${icon('close')}<span>やめる</span></button>
      <span class="hint">Enter で直す・Shift+Enter で改行・Esc でやめる</span>
    </div>`;
  have.el.querySelector('.text').replaceWith(box);
  const ta = box.querySelector('#fixText');
  ta.value = text;
  ta.focus();
  ta.setSelectionRange(text.length, text.length);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeEditor(); }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditor(); }
  });
  box.querySelector('#fixSave').addEventListener('click', saveEditor);
  box.querySelector('#fixCancel').addEventListener('click', closeEditor);
}

async function saveEditor() {
  const id = editingId;
  const box = seen.get(id)?.el.querySelector('.editor');
  if (!box) return closeEditor();
  const text = box.querySelector('#fixText').value.trim();
  const learn = box.querySelector('#fixLearn').checked;
  const sweep = box.querySelector('#fixSweep').checked;
  box.querySelector('#fixSave').disabled = true;
  const r = await post('/api/fix', { id, text, learn, sweep }).catch((e) => ({ error: e.message }));
  if (r.error) {
    box.querySelector('#fixSave').disabled = false;
    let bad = box.querySelector('.bad');
    if (!bad) { bad = document.createElement('p'); bad.className = 'bad'; box.appendChild(bad); }
    bad.textContent = r.error;
    return;
  }
  closeEditor();
}

/** 編集をやめて、その行をふつうの表示に戻す */
function closeEditor() {
  const id = editingId;
  editingId = null;
  if (!id) return;
  // **行そのものは消さない。**消して入れ直すと、その行だけ末尾へ動いて
  // 書き起こしの順番が崩れる。控えだけ捨てれば、次の描き直しで中身が入れ替わる
  const have = seen.get(id);
  if (have) have.html = '';
  fetch('/api/state').then((r) => r.json()).then((s) => drawLog(s.transcript)).catch(() => {});
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 状態の札（チップラベル） -------------------------------------------------
//
// 決めごと：**色だけで意味を伝えない。**必ず字で状態を書く。アイコンも字と並べる。

/**
 * 状態の札。**狭い所でも1行に収まるように、字は短く。**
 * 短くすると何のことか分からなくなるので、full に長いほうを入れて、
 * 指を乗せたときと読み上げのときはそちらが出るようにする。
 */
function chip(kind, name, label, full) {
  return `<span class="chip${kind ? ` ${kind}` : ''}" title="${esc(full || '')}"`
    + `${full ? ` aria-label="${esc(full)}"` : ''}>${icon(name)}${label}</span>`;
}

function drawStatus(s) {
  lastStatus = s;
  listening = s.listening;
  const label = listening ? '聞き取りを止める' : '聞き取りを始める';
  $('listenLabel').textContent = label;
  // 狭い所では字が隠れて絵だけになる。**そのときのために代替テキストも直す**
  $('listen').title = label;
  $('listen').setAttribute('aria-label', label);
  $('listenIcon').setAttribute('href', listening ? '#i-stop' : '#i-mic');
  $('listen').classList.toggle('on', listening);

  const c = [];
  c.push(s.dict.ready
    ? chip('ok', 'dict', `辞書 <b>${s.dict.terms.toLocaleString()}</b>`, `校正辞書 ${s.dict.terms.toLocaleString()} 語`)
    : chip('ng', 'dict', '辞書なし', '校正辞書が読めません'));

  c.push(s.jev.key
    ? chip('ok', 'jev', `Jev <b>${s.jev.calls}</b>`, `Jev で枝分け ${s.jev.calls} 回`)
    : chip('ng', 'jev', 'Jev の鍵なし', 'Jev の鍵がありません。枝は発言数で切ります。「ほかの操作 → Jev の鍵を入れる」から入れられます'));

  const eng = s.ai.engineLabel || 'Claude';
  if (!s.ai.use) c.push(chip('', 'pen', '発言の言葉から', '見出しと要約は、発言の言葉から作ります'));
  else if (s.ai.ok === false) c.push(chip('ng', 'pen', `${eng} なし`, `${eng} が使えません。見出しと要約は発言の言葉から作ります`));
  else c.push(chip('ok', 'pen', `${eng} <b>${s.ai.done}</b>`, `見出しと要約を ${eng} が ${s.ai.done} 件`));
  if (s.ai.draw) c.push(chip('ok', 'draw', '議題に絵', 'Codex が議題ごとに絵を描いています'));

  if (s.syscap?.denied) c.push(chip('ng', 'meet', '会議の音なし', '会議の音は拾えていません。画面収録の許可が要ります'));
  else if (s.system) c.push(chip('ok', 'meet', '会議の音', 'Google Meet や Zoom の相手の声も拾っています'));
  $('perm').hidden = !s.syscap?.denied;

  if (s.engine.busy) c.push(chip('work', 'wave', `聞き取り <b>${s.engine.busy}</b>`, `聞き取り中 ${s.engine.busy} 件`));
  else if (s.engine.running) c.push(chip('ok', 'wave', '聞き取り待機', '聞き取りの用意ができています'));
  else c.push(chip('', 'wave', '聞き取り未読込', '聞き取りのモデルは、まだ読み込んでいません'));

  lastWords = s.dict.words || [];
  if (lastWords.length) c.push(chip('ok', 'word', `語 <b>${lastWords.length}</b>`, `この会議の語 ${lastWords.length} 件：${lastWords.join('、')}`));
  c.push(chip('', 'chat', `発言 <b>${s.utterances}</b>`, `これまでの発言 ${s.utterances} 件`));
  // 同じ Wi-Fi に開けているときは、**黙っていない**。中身が他の人からも見える
  if (s.lan) c.push(chip('work', 'device', '同じ Wi-Fi に公開中',
    '同じ Wi-Fi の中から、この画面を開けます。会議の中身も見えます'));
  $('chips').innerHTML = c.join('');

  if (document.activeElement !== $('title') && $('title').value !== s.title) $('title').value = s.title;
  if ($('useAi').checked !== !!s.ai.use) $('useAi').checked = !!s.ai.use;
  if ($('engine').value !== s.ai.engine) $('engine').value = s.ai.engine || 'claude';
  $('drawRow').hidden = !s.ai.canDraw;            // 絵は Codex のときだけ出す
  if ($('useDraw').checked !== !!s.ai.draw) $('useDraw').checked = !!s.ai.draw;
}

function addNote(n) {
  const ul = $('notes');
  const li = document.createElement('li');
  li.className = n.level;
  const d = new Date(n.at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  li.innerHTML = `${icon(n.level === 'error' ? 'issue' : 'info')}<span>${hh}:${mm}　${esc(n.text)}</span>`;
  ul.appendChild(li);
  while (ul.children.length > 30) ul.removeChild(ul.firstChild);
  ul.scrollTop = ul.scrollHeight;
}

// ---- とても狭いときは、帯から「ほかの操作」へ移す ----------------------------
//
// **同じ部品を2つ置かない。**同じものを2か所に書くと、片方だけ直して食い違う。
// 置き場所そのものを移す（中身も選んだ値も、そのまま付いてくる）。

const NARROW = 440;
let narrow = null;
function relayout() {
  const now = window.innerWidth < NARROW;
  if (now === narrow) return;
  narrow = now;
  const slot = $('narrowSlot');
  const controls = document.querySelector('.controls');
  const menuBtn = document.querySelector('.menu');
  for (const el of [$('deviceField'), $('meetCheck')]) {
    el.classList.toggle('in-menu', now);
    if (now) slot.appendChild(el);
    else controls.insertBefore(el, controls.firstChild);
  }
  if (!now) controls.insertBefore($('meetCheck'), $('listen'));
  void menuBtn;
}
window.addEventListener('resize', () => { relayout(); refit(); });
// **窓の大きさだけでは足りない。**ペインの幅は、窓が同じままでも変わる
//（書き起こしを畳む・アプリの区切りを動かす・立ち上がりで幅が決まる）。
// 幅が決まる前に合わせると、縮尺が 1% のまま白紙に見えた（実測）。地図の幅そのものを見張る
try {
  let lastW = 0;
  new ResizeObserver((rs) => {
    const w = Math.round(rs[0].contentRect.width);
    if (!w || Math.abs(w - lastW) < 8) return;
    lastW = w;
    refit();
  }).observe(mapFrame);
} catch { /* 見張れない所では、窓の大きさの変わり目だけで合わせる */ }
relayout();

// ---- 操作 -------------------------------------------------------------------

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

$('listen').addEventListener('click', async () => {
  $('listen').disabled = true;
  try {
    if (listening) { await post('/api/stop'); $('level').style.width = '0'; }
    else await post('/api/start', { device: Number($('device').value || 1), system: $('useSystem').checked });
  } finally { $('listen').disabled = false; }
});

$('reset').addEventListener('click', async () => {
  if (!confirm('いまの会議を閉じて、新しく始めます。保存していない議事録は消えます。')) return;
  await post('/api/reset');
  seen.clear();
  $('log').innerHTML = '';
  $('logEmpty').hidden = false;
  loadedOnce = false;
});

$('title').addEventListener('change', () => {
  const t = $('title').value.trim();
  if (t) post('/api/title', { title: t });
});
$('title').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('title').blur(); });

// 書き起こしを畳んで、マインドマップを画面いっぱいに使う
function setFold(on) {
  document.body.classList.toggle('folded', on);
  $('foldIcon').setAttribute('href', on ? '#i-unfold' : '#i-fold');
  const t = on ? '書き起こしを開く' : '書き起こしを畳んで、マインドマップを大きくする';
  $('foldBtn').title = t;
  $('foldBtn').setAttribute('aria-label', t);
  $('foldBtn').setAttribute('aria-expanded', String(!on));
  try { localStorage.setItem('logloom.fold', on ? '1' : '0'); } catch { /* 覚えられない所でも動く */ }
  refit();                            // 畳むとマップの幅が変わる。縮尺を合わせ直す
}
$('foldBtn').addEventListener('click', () => setFold(!document.body.classList.contains('folded')));
try { setFold(localStorage.getItem('logloom.fold') === '1'); } catch { /* 既定は開いたまま */ }

$('showFixes').addEventListener('change', (e) => {
  document.body.classList.toggle('hide-fixes', !e.target.checked);
});

$('useAi').addEventListener('change', (e) => post('/api/ai', { use: e.target.checked }));
$('engine').addEventListener('change', (e) => post('/api/ai', { engine: e.target.value }));
$('useDraw').addEventListener('change', (e) => post('/api/ai', { draw: e.target.checked }));

// 許可はこちらからは出せない。**本人が出すもの**なので、その場所を開くだけ
$('permBtn').addEventListener('click', () => post('/api/privacy'));

$('moreBtn').addEventListener('click', () => {
  const m = $('more');
  m.hidden = !m.hidden;
  $('moreBtn').setAttribute('aria-expanded', String(!m.hidden));
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu')) {
    $('more').hidden = true;
    $('moreBtn').setAttribute('aria-expanded', 'false');
  }
});

$('finishBtn').addEventListener('click', () => post('/api/finish'));

// 手で動かしたあと、また全体を追いかけさせたいとき
$('fitBtn').addEventListener('click', () => {
  autoFit = true;
  fitted = { w: 0, h: 0 };            // 次の書き換えで、必ず引き直す
  $('fitBtn').classList.remove('on');
  if (pendingXml) sendMap(pendingXml, pendingExtent);
});

$('keyBtn').addEventListener('click', () => {
  const j = lastStatus?.jev || {};
  $('keyNow').textContent = j.key
    ? `いま入っている鍵：${j.masked}（${j.source}）`
    : '鍵はまだ入っていません。枝は発言の数で切っています。';
  // **この機械で鍵が決めてあるときは、入れ替えさせない。**
  // 押し間違いで別の鍵に変わらないように、入れる所ごと閉じる
  $('keyLocked').hidden = !j.locked;
  $('keyForm').hidden = !!j.locked;
  $('keyDlg').showModal();
});
$('keyDlg').addEventListener('close', async () => {
  if ($('keyDlg').returnValue !== 'ok') return;
  const k = $('keyText').value.trim();
  $('keyText').value = '';
  if (!k) return;
  const r = await post('/api/key', { key: k });
  if (r.error) alert(r.error);
});

$('wordsBtn').addEventListener('click', () => {
  $('wordsNow').textContent = lastWords.length ? `いま入っている語：${lastWords.join('、')}` : '';
  $('wordsDlg').showModal();
});
$('wordsDlg').addEventListener('close', () => {
  if ($('wordsDlg').returnValue !== 'ok') return;
  const t = $('wordsText').value.trim();
  if (t) post('/api/words', { words: t });
  $('wordsText').value = '';
});

$('pasteBtn').addEventListener('click', () => $('pasteDlg').showModal());
$('pasteDlg').addEventListener('close', () => {
  if ($('pasteDlg').returnValue !== 'ok') return;
  const text = $('pasteText').value.trim();
  if (text) post('/api/text', { text });
  $('pasteText').value = '';
});

$('fileBtn').addEventListener('click', () => $('fileDlg').showModal());
$('fileDlg').addEventListener('close', () => {
  if ($('fileDlg').returnValue !== 'ok') return;
  const p = $('filePath').value.trim();
  if (p) post('/api/file', { path: p });
});

fetch('/api/devices').then((r) => r.json()).then((d) => {
  const sel = $('device');
  const list = d.devices || [];
  sel.innerHTML = list.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('')
    || '<option value="1">見つかりません</option>';
  const mic = list.find((x) => /マイク|Microphone|Built-in/i.test(x.name));
  if (mic) sel.value = String(mic.id);
});

connect();
