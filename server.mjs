// LOGLOOM。依存パッケージなし（Node 20+）。
//
//   マイク ─ ffmpeg ─ 無音で切る ─ whisper-server ─ 校正辞書 ─ Jev ─ 木 ─ drawio
//
// 鍵はこのサーバだけが持つ。画面には伏せ字しか渡さない。

import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import * as kotoba from './lib/kotoba.mjs';
import * as jev from './lib/jev.mjs';
import * as ai from './lib/ai.mjs';
import * as listen from './lib/listen.mjs';
import * as mx from './lib/mx.mjs';
import { Kaigi } from './lib/kaigi.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8570);
// **既定は、この機械の中だけ。**
// `--lan` を付けたときだけ、同じ Wi-Fi の中から開けるようにする。
// スマホを画面として使うための口だが、会議の中身がそのまま見えるので、
// 黙って開けてはいけない（頼まれたときだけ開ける）。
const LAN = process.argv.includes('--lan') || process.env.LOGLOOM_LAN === '1';
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const WHISPER_PORT = Number(process.env.LOGLOOM_WHISPER_PORT || 8571);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.ico': 'image/x-icon' };

// ---- 状態 -------------------------------------------------------------------

let kaigi = new Kaigi({ onChange: () => bump() });
let listener = null;          // この人の声（マイク）
let sysListener = null;       // 会議の相手の声（この Mac が鳴らしている音）
let syscapDenied = false;     // 画面収録の許可が下りていない
let engineOn = false;
let busy = 0;                       // 聞き取り待ちの数
// **この会議だけの語。**人名・社名・商品名は辞書に無いので、始める前に画面から入れてもらう。
// 実測：「設計案」を語彙に入れただけで、「設定案」と書かれていたところが直った
let words = [];
const notes = [];                   // 画面に出す知らせ
function note(level, text) {
  notes.push({ at: Date.now(), level, text: String(text).slice(0, 400) });
  if (notes.length > 60) notes.shift();
  push({ type: 'note', note: notes[notes.length - 1] });
}

// ---- つなぎっぱなしの通り道（SSE） -------------------------------------------

const clients = new Set();
function push(msg) {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch { clients.delete(res); } }
}

let timer = null;
/** 木が変わったら画面へ。**まとめて送る。**発言ごとに全部送ると画面が追いつかない */
function bump() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const tree = kaigi.tree();
    push({ type: 'tree', tree, xml: mx.xml(tree, { name: kaigi.title }), extent: mx.extent(tree), status: status() });
  }, 350);
}

function status() {
  return {
    listening: !!(listener || sysListener),
    system: !!sysListener,
    syscap: { ...listen.syscapState(), denied: syscapDenied },
    engine: { ...listen.engine(), busy },
    jev: jev.stats(),
    ai: ai.stats(),
    dict: { ready: kotoba.ready(), terms: kotoba.termCount(), why: kotoba.why(), words },
    lan: LAN,
    title: kaigi.title,
    utterances: kaigi.transcript().length,
    notes: notes.slice(-12),
  };
}

// ---- 音 → 文字 → 木 ----------------------------------------------------------

/** 誰の声か。**マイク＝自分、この Mac の音＝相手。**会議の道具に人を足さずに分けられる */
const WHO = { mic: '自分', system: '相手' };

async function onSegment({ wavPath, ms, at, peak, mean, floor, source }) {
  busy += 1;
  push({ type: 'status', status: status() });
  try {
    const got = await listen.transcribe(wavPath, { lang: 'ja', prompt: kotoba.vocab(words), port: WHISPER_PORT });
    // **空耳は木に入れない。**whisper は無音に近い音に当てると
    // 「ご視聴ありがとうございました」と返す（実測で出た）
    const judged = listen.trustworthy(got, { peak, mean, floor });
    if (!judged.ok) {
      if (got.text) note('info', `聞き流しました：${judged.why}（${got.text.slice(0, 20)}）`);
      return;
    }
    await kaigi.add(got.text, { at, ms, who: WHO[source] || '' });
  } catch (e) {
    note('error', `聞き取り：${e.message}`);
  } finally {
    busy -= 1;
    try { fs.unlinkSync(wavPath); } catch { /* もう無い */ }
    push({ type: 'status', status: status() });
  }
}

async function startListening(device, { system = false, mic = true } = {}) {
  if (!engineOn) {
    note('info', '聞き取りのモデルを読み込んでいます。1分ほどかかります');
    await listen.startEngine({ port: WHISPER_PORT, lang: 'ja' });
    engineOn = true;
    note('info', '聞き取りの用意ができました');
  }

  // 音の大きさは、画面の帯に出す。**そのまま流すと毎秒50回になる**ので間引く
  let levelAt = 0;
  const onLevel = (level, gate) => {
    const now = Date.now();
    if (now - levelAt < 120) return;
    levelAt = now;
    push({ type: 'level', level: Math.round(Math.min(1, level / Math.max(gate * 3, 0.02)) * 100) });
  };

  if (mic && !listener) {
    listener = new listen.Listener({
      device, source: 'mic', onSegment, onLevel,
      onError: (t) => note('error', `マイク：${t}`),
    });
    listener.start();
    note('info', `マイクを開きました（入口 ${device}）`);
  }

  // **会議の相手の声。**Google Meet も Zoom も、記録用の参加者を入れずに拾える
  if (system && !sysListener) {
    if (!listen.syscapState().built) {
      note('info', '会議の音を拾う係を組み立てています。初回だけ20秒ほどかかります');
      await listen.buildSyscap();
    }
    sysListener = new listen.Listener({
      source: 'system', onSegment,
      onError: (t) => {
        if (/^denied-app:/.test(t)) {
          // 2つの起こし方を両方とも断られた。**何に印を付けるかまで書く**
          syscapDenied = true;
          note('error', '会議の音を拾えません。システム設定の「画面収録」で '
            + '「LOGLOOM 会議の音」に印を付けてください。'
            + 'または、ターミナルから `node logloom/server.mjs 8580` で起こすと、'
            + 'ターミナルの許可で動きます');
        } else if (/TCC|not authorized|許可|declined|denied|拒否/i.test(t)) {
          note('info', '親の許可では拾えなかったので、アプリとして起こし直しています');
        } else {
          note('error', `会議の音：${t}`);
        }
        push({ type: 'status', status: status() });
      },
    });
    sysListener.start();
    note('info', '会議の音を拾い始めました（相手の画面には何も出ません）');
  }
  push({ type: 'status', status: status() });
}

function stopListening() {
  if (listener) { listener.stop(); listener = null; }
  if (sysListener) { sysListener.stop(); sysListener = null; }
  // **止めたところで、まだ要約の付いていない論点をまとめる。**
  // 会議の終わりの論点は、次の話題に移らないので要約の頼みが出なかった
  const n = kaigi.finish();
  note('info', n ? `聞き取りを止めました。要約の付いていない論点 ${n} 件をまとめています` : '聞き取りを止めました');
  push({ type: 'status', status: status() });
}

// ---- HTTP -------------------------------------------------------------------

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj));

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

function serveFile(res, file) {
  fs.readFile(file, (e, data) => {
    if (e) return send(res, 404, 'not found', 'text/plain; charset=utf-8');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const cache = file.includes(`${path.sep}drawio${path.sep}`) ? 'public, max-age=86400' : 'no-store';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = decodeURIComponent(url.pathname);

  // drawio（jgraph/drawio の公式ビルドをそのまま手元で出す。外へは出ない）
  if (p.startsWith('/drawio/')) {
    const rel = p.slice('/drawio/'.length);
    const file = path.join(ROOT, 'vendor', 'drawio', rel);
    if (!file.startsWith(path.join(ROOT, 'vendor', 'drawio'))) return send(res, 403, 'no');
    return serveFile(res, file);
  }

  if (p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    const tree = kaigi.tree();
    res.write(`data: ${JSON.stringify({ type: 'tree', tree, xml: mx.xml(tree, { name: kaigi.title }), extent: mx.extent(tree), status: status(), transcript: kaigi.transcript() })}\n\n`);
    const keep = setInterval(() => { try { res.write(': .\n\n'); } catch { /* 切れた */ } }, 20000);
    req.on('close', () => { clearInterval(keep); clients.delete(res); });
    return;
  }

  if (p === '/api/state') {
    const tree = kaigi.tree();
    return json(res, 200, { tree, xml: mx.xml(tree, { name: kaigi.title }), extent: mx.extent(tree), status: status(), transcript: kaigi.transcript() });
  }

  if (p === '/api/devices') return json(res, 200, { devices: await listen.devices() });

  if (p === '/api/map.xml') {
    return send(res, 200, mx.xml(kaigi.tree(), { name: kaigi.title }), MIME['.xml'],
      url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(kaigi.title)}.drawio"` } : {});
  }

  // 書き出す前に、まだ要約の付いていない論点をまとめておく
  if (req.method === 'POST' && p === '/api/finish') {
    const n = kaigi.finish();
    note('info', n ? `要約の付いていない論点 ${n} 件をまとめています` : 'すべての論点に要約が付いています');
    return json(res, 200, { ok: true, pending: n });
  }

  if (p === '/api/minutes.md') {
    return send(res, 200, kaigi.markdown(), MIME['.txt'],
      url.searchParams.get('dl') ? { 'Content-Disposition': `attachment; filename="${encodeURIComponent(kaigi.title)}.md"` } : {});
  }

  if (req.method === 'POST' && p === '/api/start') {
    const b = await body(req);
    try {
      await startListening(Number(b.device ?? 1), { system: !!b.system, mic: b.mic !== false });
      return json(res, 200, { ok: true, status: status() });
    }
    catch (e) { note('error', e.message); return json(res, 500, { error: e.message }); }
  }

  if (req.method === 'POST' && p === '/api/stop') { stopListening(); return json(res, 200, { ok: true }); }

  // 手で入れる／別の道具から流し込む。**マイクが無くても試せる**
  if (req.method === 'POST' && p === '/api/text') {
    const b = await body(req);
    const lines = String(b.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const line of lines) await kaigi.add(line, { at: Date.now() });
    return json(res, 200, { ok: true, added: lines.length });
  }

  // 録ってあるものを流し込む
  if (req.method === 'POST' && p === '/api/file') {
    const b = await body(req);
    const src = String(b.path || '');
    if (!fs.existsSync(src)) return json(res, 400, { error: 'そのファイルがありません' });
    json(res, 200, { ok: true, started: true });
    (async () => {
      let wav = null;
      try {
        note('info', `${path.basename(src)} を聞き取っています`);
        wav = /\.wav$/i.test(src) ? src : await listen.toWav(src);
        // **生のときと同じように、黙ったところで切ってから投げる。**
        // 丸ごと1回で投げると、初期プロンプトが先頭30秒までしか効かない。
        // 45秒の会議で「設計案→設定案」「来月中→3月中」になり、1文まるごと落ちた（実測）
        const cuts = listen.segmentsOf(wav);
        note('info', `${cuts.length} の発言に切れました。聞き取っていきます`);
        if (cuts.length) {
          if (!engineOn) {
            note('info', '聞き取りのモデルを読み込んでいます');
            await listen.startEngine({ port: WHISPER_PORT, lang: 'ja' });
            engineOn = true;
          }
          let at = kaigi.startedAt;
          for (const c of cuts) {
            busy += 1; push({ type: 'status', status: status() });
            try {
              const got = await listen.transcribe(c.wavPath,
                { lang: 'ja', prompt: kotoba.vocab(words), port: WHISPER_PORT });
              const ok = listen.trustworthy(got, { peak: 1, floor: 0 });
              if (ok.ok) await kaigi.add(got.text, { at, ms: c.ms });
              else if (got.text) note('info', `聞き流しました：${ok.why}（${got.text.slice(0, 20)}）`);
            } finally {
              busy -= 1;
              at += c.ms;
              try { fs.unlinkSync(c.wavPath); } catch { /* もう無い */ }
              push({ type: 'status', status: status() });
            }
          }
        } else {
          // 切れ目が見つからない音（ずっと喋りっぱなし・とても静か）は、丸ごと whisper-cli へ
          note('info', '切れ目が見つかりませんでした。丸ごと聞き取ります');
          const segs = await listen.transcribeFile(wav, { lang: 'ja', prompt: kotoba.vocab(words) });
          for (const s of segs) await kaigi.add(s.text, { at: kaigi.startedAt + (s.from || 0) });
        }
        note('info', '流し込みが終わりました');
      } catch (e) { note('error', e.message); }
      finally { if (wav && wav !== src) { try { fs.unlinkSync(wav); } catch { /* もう無い */ } } }
    })();
    return;
  }

  // Jev の鍵を貼って保存する。**鍵そのものは画面に返さない**（末尾4文字だけ）
  if (req.method === 'POST' && p === '/api/key') {
    if (jev.keyLocked()) return json(res, 403, { error: 'この機械では鍵が決めてあるので、画面からは変えられません' });
    const b = await body(req);
    const v = await jev.verify(String(b.key || ''));
    if (!v.ok) return json(res, 400, { error: `その鍵では通りませんでした：${v.why}` });
    try {
      const masked = jev.saveKey(b.key);
      note('info', `Jev の鍵を保存しました（${masked}）`);
      push({ type: 'status', status: status() });
      return json(res, 200, { ok: true, masked, source: jev.keySource() });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // 見出しと要約に手元の Claude を使うかどうか
  // 画面収録の許可を出す所を開く。**こちらからは許可できない。**本人が出すもの
  if (req.method === 'POST' && p === '/api/privacy') {
    execFile('open', ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'], () => {});
    note('info', 'システム設定を開きました。「画面収録」でこのアプリに許可を出し、聞き取りを始め直してください');
    return json(res, 200, { ok: true });
  }

  // 見出しと要約を、どの係に書かせるか（手元の Claude か Codex か、使わないか）
  if (req.method === 'POST' && p === '/api/ai') {
    const b = await body(req);
    if (b.engine) ai.setEngine(String(b.engine));
    if (b.draw != null) ai.setDraw(!!b.draw);
    const on = b.use == null ? ai.stats().use : ai.setUse(b.use !== false);
    if (on) {
      const label = ai.stats().engineLabel;
      const v = await ai.probe();
      note('info', v ? `手元の ${label} が使えます（${v}）` : `手元の ${label} は使えません：${ai.stats().lastError}`);
    } else note('info', '見出しと要約を、発言の言葉だけで作ります');
    push({ type: 'status', status: status() });
    return json(res, 200, { ok: true, ai: ai.stats() });
  }

  if (req.method === 'POST' && p === '/api/words') {
    const b = await body(req);
    const list = String(b.words || '').split(/[\n,、,]+/).map((x) => x.trim()).filter(Boolean);
    words = [...new Set([...words, ...list])].slice(0, 60);
    const n = await kotoba.addMeetingWords(list);
    note('info', `この会議の語を ${list.length} 語 受け取りました（照合に足したのは ${n} 語）`);
    push({ type: 'status', status: status() });
    return json(res, 200, { ok: true, words });
  }

  if (req.method === 'POST' && p === '/api/title') {
    const b = await body(req);
    const t = String(b.title || '').trim();
    if (t) { kaigi.title = t; kaigi.titleFixed = true; bump(); }
    return json(res, 200, { ok: true, title: kaigi.title });
  }

  if (req.method === 'POST' && p === '/api/reset') {
    stopListening();
    words = [];
    syscapDenied = false;
    kaigi = new Kaigi({ onChange: () => bump() });
    note('info', '新しい会議を始めました');
    bump();
    return json(res, 200, { ok: true });
  }

  // 画面
  const file = p === '/' ? 'index.html' : p.replace(/^\//, '');
  const local = path.join(ROOT, 'public', file);
  if (!local.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'no');
  return serveFile(res, local);
});

// ---- 起動 -------------------------------------------------------------------

server.listen(PORT, HOST, async () => {
  console.log(`LOGLOOM  http://localhost:${PORT}`);
  if (LAN) {
    // スマホから開くための宛先を、そのまま書き出す
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const n of list || []) {
        if (n.family === 'IPv4' && !n.internal) console.log(`  同じ Wi-Fi から  http://${n.address}:${PORT}  (${name})`);
      }
    }
    console.log('  **会議の中身が同じ Wi-Fi の誰からも見えます。**要らなくなったら --lan を外してください');
  }
  await kotoba.load();
  if (kotoba.ready()) {
    console.log(`校正辞書：${kotoba.termCount()} 語`);
    kotoba.warmReadings()
      .then((n) => n && console.log(`読みを ${n} 語ぶん引きました`))
      .then(() => kotoba.buildMatcher())
      .then((n) => n && console.log(`読みで照合する索引：${n} 語`));
  } else {
    console.log(`校正辞書が読めません：${kotoba.why()}`);
  }
  console.log(jev.available() ? 'Jev：鍵あり' : 'Jev：鍵がありません（枝分けは発言数で切ります）');
  // **先に一度だけ確かめる。**入っていない機械で見出しのたびにプロセスを起こすと、
  // そのぶん木の更新が遅れる
  const v = await ai.probe();
  const label = ai.stats().engineLabel;
  console.log(v ? `手元の ${label}：${v}` : `手元の ${label} は使えません（見出しと要約は発言の言葉から作ります）`);
  push({ type: 'status', status: status() });
  push({ type: 'status', status: status() });
});

function bye() {
  stopListening();
  listen.stopEngine();
  kotoba.shutdown();
  process.exit(0);
}
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
