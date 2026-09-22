// 音を聞いて、発言の切れ目ごとに文字にする係。
//
// **whisper-cli を1回ずつ起こすと、毎回モデルを読み直す。**
// large-v3-turbo は 1.6GB あり、読み込みだけで3秒以上かかる。会議に追いつかない。
// whisper.cpp には同じ推論をそのまま持った whisper-server があるので、
// モデルを載せたまま常駐させ、切れ目ごとに音を投げる（実測：11秒の音で 1.5秒）。
// 手元に音のファイルがあるとき（会議のあとで流し込む）は whisper-cli を使う。
//
// 切れ目は**黙ったところ**で入れる。一定の秒数で切ると語の途中で切れ、
// 「生成A／Iを使って」のように割れる。20ミリ秒ごとの音の大きさを見て、
// 静かな時間が続いたところを発言の終わりにする。雑音の大きさは部屋ごとに違うので、
// 静かなときの大きさを覚えておいて、そこからの上がりで判断する。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MODEL_DIR = process.env.LOGLOOM_MODEL_DIR
  || path.join(os.homedir(), '.cache', 'whisper-models');
export const MODEL = process.env.LOGLOOM_WHISPER_MODEL
  || path.join(MODEL_DIR, 'ggml-large-v3-turbo.bin');

const RATE = 16000;
const FRAME = 320;            // 20ミリ秒（16000 × 0.02）
const PREROLL = 20;           // 400ミリ秒ぶん、話し始めの前を残す
const START_FRAMES = 4;       // 80ミリ秒続けて大きければ、話し始め
const END_FRAMES = 32;        // 640ミリ秒静かなら、話し終わり
const MIN_MS = 700;           // これより短いものは、咳や物音として捨てる
const MAX_MS = 18000;         // 長い発言は途中で切る（黙らない人がいる）

// 静かなときの大きさを測る窓。**話している間も測り続ける。**
// 「話していない間だけ」にしていたとき、続けて喋られると窓が回らず、
// 部屋が変わっても敷居が付いていかなかった。
//
// **窓は長く、取る所は下から1割に近く。**5秒・下から2割にしていたとき、
// 喋りっぱなしの音では窓の中が声で埋まり、静かなときの大きさを 0.0068 と
// 読み違えた（本当は 0.0042）。敷居が 0.023 まで上がり、12秒の話が1つしか
// 切れなかった。30秒の窓なら、ふつうの会議なら必ずどこかに間がある。
const FLOOR_WIN = 1500;       // 30秒ぶん（1500枠 × 20ミリ秒）
const FLOOR_PCT = 0.08;       // 下から8分の1の大きさを「静かなとき」と見る

// 話し始めと話し終わりで敷居を変える（ヒステリシス）。同じ敷居だと、
// 声の切れ目のたびに切れて、語の途中で分かれる
const ON_MUL = 2.2, ON_ADD = 0.0022;
const OFF_MUL = 1.4, OFF_ADD = 0.0012;

// **静かなときの大きさに、下限を置く。**
// 置かずにいたとき、窓が溜まる前の静けさを 0.0004 と読み、敷居が
// 部屋の雑音より下がった。whisper はその雑音に当てて、すらすらした嘘を返してくる
//（実測：「アジア大会競泳男子400m個人メドレーで…」という、会議と無関係の一文）
const FLOOR_MIN = 0.0015;

/** 使える音の入口を並べる */
export function devices() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (e, so, se) => {
      const text = `${se || ''}${so || ''}`;
      const out = [];
      let inAudio = false;
      for (const line of text.split('\n')) {
        if (/AVFoundation audio devices/.test(line)) { inAudio = true; continue; }
        if (/AVFoundation video devices/.test(line)) { inAudio = false; continue; }
        if (!inAudio) continue;
        const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
        if (m) out.push({ id: Number(m[1]), name: m[2].trim() });
      }
      resolve(out);
    });
  });
}

// ---- whisper-server を常駐させる -------------------------------------------

let server = null;
let serverPort = 0;

export function engine() {
  // **「自分が起こしたか」ではなく「使える口があるか」を返す。**
  // すでに立っているものを使い回したとき server は null のままなので、
  // 画面に「まだ読み込んでいません」と出たまま動いていた
  return { running: serverPort > 0, spawned: !!server, port: serverPort, model: MODEL, exists: fs.existsSync(MODEL) };
}

export async function startEngine({ port = 8571, lang = 'ja', threads = 8 } = {}) {
  if (server) return serverPort;
  if (!fs.existsSync(MODEL)) throw new Error(`聞き取りのモデルがありません：${MODEL}`);
  // すでに誰かが立てているなら、それを使う
  if (await alive(port)) { serverPort = port; return port; }
  server = spawn('whisper-server', ['-m', MODEL, '-l', lang, '--host', '127.0.0.1',
    '--port', String(port), '-t', String(threads), '-nt'], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});
  server.on('close', () => { server = null; serverPort = 0; });
  for (let i = 0; i < 90; i++) {
    if (await alive(port)) { serverPort = port; return port; }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('whisper-server が立ち上がりませんでした');
}

export function stopEngine() {
  if (server) { try { server.kill(); } catch { /* もう居ない */ } server = null; serverPort = 0; }
}

async function alive(port) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 800);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ctl.signal });
    clearTimeout(t);
    return res.status < 500;
  } catch { return false; }
}

/**
 * 音のかたまりを文字にする。**語彙は毎回渡す。**（入口で直すほうが確実）
 *
 * 返すのは文字だけではない。**その文字をどれだけ信じてよいか**も一緒に返す。
 *   ja      … 日本語らしさ。実測で、本物の日本語は 0.999、無音の空耳は 0.050
 *   logprob … 言葉の確からしさ。本物は -0.03、空耳は -0.377
 * この2つで、whisper が無音に当てて返してくる決まり文句をはっきり分けられる。
 */
export async function transcribe(wavPath, { lang = 'ja', prompt = '', port = serverPort } = {}) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), path.basename(wavPath));
  form.append('language', lang);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (prompt) form.append('prompt', prompt);
  const res = await fetch(`http://127.0.0.1:${port}/inference`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`聞き取りが答えませんでした：HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  const text = String(body.text || '').trim();
  const seg = (body.segments || [])[0] || {};
  const ja = Number(body.language_probabilities?.[lang]);
  return {
    text,
    ja: Number.isFinite(ja) ? ja : null,
    logprob: Number.isFinite(seg.avg_logprob) ? seg.avg_logprob : null,
  };
}

// ---- この Mac が鳴らしている音（Meet・Zoom の相手の声） -----------------------
//
// **会議に記録用の参加者を入れない。**相手の画面には何も出ない。
// macOS の ScreenCaptureKit で、この Mac が出している音をそのまま拾う
// （native/syscap.swift）。別の音の入口（BlackHole など）を入れなくてよい。
//
// 初回に macOS が「画面収録」の許可を尋ねる。許可を出す相手は、
// このサーバを起こした親（ターミナルか Claude のアプリ）。

const CACHE = path.join(os.homedir(), '.cache', 'logloom');
const SYSCAP_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'syscap.swift');
// **単体のアプリの形にする。**「画面収録」の許可は起こした親に紐づくので、
// node の子のままだと logloom を起こしたアプリ（Claude のアプリなど）の許可になる。
// そこで断られていると、node を起こし直しても断られたままだった（実測）。
// LaunchServices から起こせば親の鎖から外れ、この係自身に許可が紐づく。
const SYSCAP_APP = path.join(CACHE, 'LOGLOOM 会議の音.app');
const SYSCAP_BIN = path.join(SYSCAP_APP, 'Contents', 'MacOS', 'syscap');
const SYSCAP_PLIST = path.join(SYSCAP_APP, 'Contents', 'Info.plist');
const FIFO = path.join(CACHE, 'syscap.pipe');

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>LOGLOOM 会議の音</string>
  <key>CFBundleDisplayName</key><string>LOGLOOM 会議の音</string>
  <key>CFBundleExecutable</key><string>syscap</string>
  <key>CFBundleIdentifier</key><string>dev.logloom.syscap</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>会議の相手の声を議事録にするため、この Mac が鳴らしている音を拾います。</string>
</dict></plist>
`;

export function syscapState() {
  const src = fs.existsSync(SYSCAP_SRC);
  let built = false;
  try { built = fs.statSync(SYSCAP_BIN).mtimeMs >= fs.statSync(SYSCAP_SRC).mtimeMs; } catch { built = false; }
  return { platform: process.platform, src, built, app: SYSCAP_APP };
}

/** 要るときに1度だけ組む。**組み上がったものは取っておく**（毎回20秒かけない） */
export function buildSyscap() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') return reject(new Error('会議の音を拾えるのは macOS だけです'));
    if (!fs.existsSync(SYSCAP_SRC)) return reject(new Error('native/syscap.swift がありません'));
    if (syscapState().built) return resolve(SYSCAP_APP);
    fs.mkdirSync(path.dirname(SYSCAP_BIN), { recursive: true });
    fs.writeFileSync(SYSCAP_PLIST, PLIST, 'utf8');
    execFile('swiftc', ['-O', '-parse-as-library', '-o', SYSCAP_BIN, SYSCAP_SRC],
      { timeout: 180000 }, (e, so, se) => {
        if (e) return reject(new Error(`会議の音を拾う係を組めませんでした：${String(se || e.message).slice(0, 300)}`));
        // **署名しておく。**署名が無いと、組み直すたびに macOS から別物に見え、
        // 出してもらった許可が毎回消える
        execFile('codesign', ['--force', '--sign', '-', SYSCAP_APP], { timeout: 60000 }, () => {
          execFile('touch', [SYSCAP_BIN], () => resolve(SYSCAP_APP));
        });
      });
  });
}

/** 許可が下りていないときに macOS が返す言い方 */
const DENIED = /TCC|not authorized|declined|denied|拒否/i;

/** 名前付きパイプを作り直す。前の残りがあると、古い音が先に流れてくる */
function makeFifo() {
  try { fs.unlinkSync(FIFO); } catch { /* 無ければそのまま */ }
  const r = spawnSync('mkfifo', [FIFO]);
  if (r.status !== 0) throw new Error('名前付きパイプを作れませんでした');
  return FIFO;
}

// ---- 黙ったところで切る ------------------------------------------------------

function wav(pcm) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / (buf.length / 2 || 1));
}

/**
 * 音の入口を開いて、発言ごとに onSegment を呼ぶ。
 * @param onSegment {wavPath, ms, at} を受け取る
 */
export class Listener {
  constructor({ device = 1, source = 'mic', onSegment = () => {}, onLevel = () => {}, onError = () => {} } = {}) {
    this.device = device;
    this.source = source;          // 'mic'＝この人の声／'system'＝この Mac が鳴らしている音
    this.onSegment = onSegment;
    this.onLevel = onLevel;
    this.onError = onError;
    this.proc = null;
    this.rest = Buffer.alloc(0);
    this.pre = [];            // 話し始めの前を残す輪
    this.seg = [];
    this.speaking = false;
    this.hot = 0;
    this.cold = 0;
    this.win = [];            // 直近の大きさ。ここから静かなときの大きさを出す
    // **始めは高めに置く。**低く置くと、窓が溜まる前の物音で1つめの切れ目ができる
    // （実測：静かな部屋の3秒から「はい」を拾った）
    this.floor = 0.008;       // 静かなときの大きさ。部屋に合わせて動かす
    this.peak = 0;            // いまの発言でいちばん大きかった所
    this.sum = 0;             // いまの発言の大きさの合計（平均を出すため）
    this.cnt = 0;
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logloom-'));
    this.n = 0;
  }

  start() {
    if (this.source === 'system') return this.startSystem();
    {
      const args = ['-hide_banner', '-loglevel', 'error', '-f', 'avfoundation',
        '-i', `:${this.device}`, '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'];
      this.proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    this.proc.stdout.on('data', (d) => this.feed(d));
    this.proc.stderr.on('data', (d) => {
      const t = String(d).trim();
      if (!t) return;
      // 立ち上がりの知らせは、困りごとではない
      if (/拾っています/.test(t)) return;
      this.onError(t.slice(0, 300));
    });
    this.proc.on('error', (e) => this.onError(e.message));
    this.proc.on('close', () => { this.proc = null; });
  }

  /**
   * 会議の音を拾い始める。**2つの起こし方を順に試す。**
   *
   * 「画面収録」の許可は、起こした親に紐づく。どちらが通るかは、
   * logloom を何から起こしたかで変わるので、片方に決め打ちできない。
   *
   *   1. **そのまま子として起こす** … 親（ターミナル等）の許可で動く。
   *      ターミナルから logloom を起こしているなら、これで通る。
   *   2. **アプリとして起こす** … 親の鎖から外れ、この係自身の許可で動く。
   *      親に許可が無いときの道。ただし利用者が一度、画面収録の一覧で
   *      「LOGLOOM 会議の音」に印を付ける必要がある（背景で動くので窓が出ない）。
   */
  startSystem() {
    this.tryDirect(() => this.tryApp());
  }

  tryDirect(onDenied) {
    let got = false;
    const p = spawn(SYSCAP_BIN, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    p.stdout.on('data', (d) => { got = true; this.feed(d); });
    p.stderr.on('data', (d) => {
      const t = String(d).trim();
      if (!t || /拾っています/.test(t)) return;
      if (DENIED.test(t)) { this.proc = null; try { p.kill(); } catch { /* もう居ない */ } return onDenied(); }
      this.onError(t.slice(0, 300));
    });
    p.on('error', () => { this.proc = null; onDenied(); });
    p.on('close', () => { if (this.proc === p) { this.proc = null; if (!got) onDenied(); } });
  }

  tryApp() {
    let fifo;
    try { fifo = makeFifo(); } catch (e) { return this.onError(e.message); }
    // 先に読み口を開ける（書き手は、読み手が開くまで塞がる）
    this.pipe = spawn('cat', [fifo], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.pipe.stdout.on('data', (d) => this.feed(d));
    this.pipe.on('error', () => {});
    const err = path.join(CACHE, 'syscap.log');
    try { fs.writeFileSync(err, ''); } catch { /* 書けなくても進む */ }
    this.proc = spawn('open', ['-a', SYSCAP_APP, '--stderr', err, '--args', fifo],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc.on('close', () => {
      this.proc = null;
      // アプリ側の言い分は、ここでしか受け取れない（open は自分の言い分しか返さない）
      setTimeout(() => {
        let t = '';
        try { t = fs.readFileSync(err, 'utf8').trim(); } catch { /* 読めない */ }
        if (t && DENIED.test(t)) this.onError(`denied-app: ${t}`);
        else if (t && !/拾っています/.test(t)) this.onError(t.slice(0, 300));
      }, 2500);
    });
  }

  stop() {
    if (this.proc) { try { this.proc.kill('SIGINT'); } catch { /* もう居ない */ } this.proc = null; }
    if (this.pipe) { try { this.pipe.kill(); } catch { /* もう居ない */ } this.pipe = null; }
    // アプリとして起こしたものは、親を殺しても残る。名前で止める
    if (this.source === 'system') { try { spawnSync('pkill', ['-f', 'LOGLOOM 会議の音']); } catch { /* 居ない */ } }
    this.flush();
  }

  feed(chunk) {
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const step = FRAME * 2;
    let i = 0;
    for (; i + step <= buf.length; i += step) this.frame(buf.subarray(i, i + step));
    this.rest = buf.subarray(i);
  }

  frame(f) {
    const level = rms(f);

    // 静かなときの大きさ。**直近5秒の下から2割**で測る。
    // 話している間も測り続けるので、部屋が変わっても敷居が付いていく
    this.win.push(level);
    if (this.win.length > FLOOR_WIN) this.win.shift();
    this.tick = (this.tick || 0) + 1;
    if (this.win.length >= 25 && this.tick % 10 === 0) {
      const sorted = [...this.win].sort((a, b) => a - b);
      const q = sorted[Math.floor(sorted.length * FLOOR_PCT)] || this.floor;
      // **下がるのはすぐ、上がるのはゆっくり。**
      // 静かな部屋に移ったらすぐ付いていき、話し声で押し上げられはしない
      const next = q < this.floor ? q : Math.min(q, this.floor * 1.03 + 0.00005);
      this.floor = Math.max(FLOOR_MIN, next);
    }

    const on = this.floor * ON_MUL + ON_ADD;
    const off = this.floor * OFF_MUL + OFF_ADD;
    this.onLevel(level, on);

    if (!this.speaking) {
      this.pre.push(f);
      if (this.pre.length > PREROLL) this.pre.shift();
      // 静かなときの大きさが定まるまで（1秒）は、切り出さない
      this.hot = (this.win.length >= 50 && level > on) ? this.hot + 1 : 0;
      if (this.hot >= START_FRAMES) {
        this.speaking = true;
        this.seg = [...this.pre];
        this.pre = [];
        this.cold = 0;
        this.peak = level;
        this.sum = level;
        this.cnt = 1;
      }
      return;
    }

    this.seg.push(f);
    if (level > this.peak) this.peak = level;
    this.sum += level;
    this.cnt += 1;
    this.cold = level > off ? 0 : this.cold + 1;
    const ms = (this.seg.length * FRAME * 1000) / RATE;
    if (this.cold >= END_FRAMES || ms >= MAX_MS) this.flush();
  }

  flush() {
    if (!this.speaking) return;
    const frames = this.seg;
    this.speaking = false;
    this.seg = [];
    this.cold = 0;
    this.hot = 0;
    const ms = (frames.length * FRAME * 1000) / RATE;
    const peak = this.peak;
    const mean = this.cnt ? this.sum / this.cnt : 0;
    this.peak = 0; this.sum = 0; this.cnt = 0;
    if (ms < MIN_MS) return;                       // 咳・物音。文字にしない
    const pcm = Buffer.concat(frames);
    const p = path.join(this.dir, `s${String(this.n++).padStart(5, '0')}.wav`);
    try { fs.writeFileSync(p, wav(pcm)); } catch (e) { return this.onError(e.message); }
    // **いちばん大きかった所と、静かなときの大きさを一緒に渡す。**
    // 差が小さいものは、whisper に投げても空耳を返してくる
    this.onSegment({ wavPath: p, ms: Math.round(ms), at: Date.now(), peak, mean, floor: this.floor, source: this.source });
  }
}

// ---- 空耳をはじく -----------------------------------------------------------

/**
 * whisper が**無音に近い音**に当てると返してくる決まり文句。
 * 学習に使われた動画の締めの言葉で、会議の音とは関係がない。
 * 実測（スピーカーの音をマイクで拾った45秒）で、この2つだけが出た。
 */
const GHOST = [
  /^(ご(視聴|清聴)ありがとうございました[。！!]?)+$/,
  /^ありがとうございました[。！!]?$/,
  /^(おやすみなさい|お疲れ様でした|チャンネル登録|次回もお楽しみに)/,
  /^[ 。、.,!?！？…ー\-]*$/,
  /^(Thank you( for watching)?\.?|Thanks for watching\.?|you|Bye\.?)$/i,
];

/** 日本語らしさの下限。**実測で本物 0.999／空耳 0.050 と、はっきり離れている** */
export const JA_MIN = 0.5;
/** 言葉の確からしさの下限。本物 -0.03／空耳 -0.377 */
export const LOGPROB_MIN = -0.6;

/**
 * この聞き取りは信じてよいか。
 * @param got   transcribe の戻り（文字と、日本語らしさと、確からしさ）
 * @param peak  その発言でいちばん大きかった所
 * @param floor そのときの静かなときの大きさ
 */
export function trustworthy(got, { peak = 1, mean = null, floor = 0 } = {}) {
  const o = typeof got === 'string' ? { text: got, ja: null, logprob: null } : (got || {});
  const t = String(o.text || '').trim();
  if (!t) return { ok: false, why: '何も聞き取れませんでした' };
  for (const re of GHOST) if (re.test(t)) return { ok: false, why: '無音に当てたときの決まり文句でした' };
  // **決まり文句の一覧だけでは足りない。**
  // 実測で「競泳には池江理学選手が登場します」のような、一覧に無い長い空耳が出た。
  // 日本語らしさと確からしさで見ると、本物とはっきり離れている
  if (o.ja != null && o.ja < JA_MIN) {
    return { ok: false, why: `日本語として聞こえていません（${o.ja.toFixed(3)}）` };
  }
  if (o.logprob != null && o.logprob < LOGPROB_MIN) {
    return { ok: false, why: `聞き取りの確からしさが低すぎます（${o.logprob.toFixed(2)}）` };
  }
  // 静かなときとの差が小さい音は、声として扱わない。
  // **いちばん大きかった所だけでは足りない。**物音1つで越えてしまうので、
  // 発言のあいだ通しての平均も見る
  if (peak < floor * 3 + 0.006) return { ok: false, why: `音が小さすぎます（最大 ${peak.toFixed(4)}）` };
  if (mean != null && mean < floor * 1.6 + 0.002) {
    return { ok: false, why: `声というより物音でした（平均 ${mean.toFixed(4)}）` };
  }
  return { ok: true };
}

// ---- 手元の音のファイルを流し込む -------------------------------------------

/**
 * 録ってあるものを、**生のときと同じように黙ったところで切る。**
 *
 * 長い音をまるごと1回で聞き取らせてはいけない。実測（45秒の会議）で、
 *   ・「設計案」が「設定案」になった（7秒ずつに切ると正しく出た）
 *   ・「来月中に」が「3月中に」になった
 *   ・1文まるごと落ちた
 * 初期プロンプトの効き目は先頭の30秒までで薄れ、そこから先は語彙が効かない。
 * 切ってから投げれば、どの切れ端にも語彙が効く。
 */
export function segmentsOf(wavPath) {
  const buf = pcmOf(fs.readFileSync(wavPath));
  const out = [];
  const L = new Listener({ onSegment: (s) => out.push(s), onError: () => {} });
  for (let i = 0; i < buf.length; i += 65536) L.feed(buf.subarray(i, i + 65536));
  L.flush();
  return out;
}

/**
 * WAV から音そのものを取り出す。**44バイト決め打ちにしない。**
 * ffmpeg は LIST チャンクを足すことがあり、そのぶんずれると
 * 左右のバイトが入れ替わって、音が雑音になる。data の位置を読んで切る。
 */
function pcmOf(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') return buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return buf.subarray(44);
}

/**
 * 会議のあとで、録っておいたものを丸ごと聞き取る。**こちらは whisper-cli を使う。**
 * 聞き取りの常駐が立たない機械のための道。切らずに投げるので、上に書いた崩れが出る。
 */
export function transcribeFile(file, { lang = 'ja', prompt = '', onLine = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-m', MODEL, '-f', file, '-l', lang, '-np', '-oj', '-of',
      path.join(os.tmpdir(), `logloom-${Date.now()}`), '-t', '8'];
    if (prompt) args.push('--prompt', prompt);
    const out = args[args.indexOf('-of') + 1];
    const proc = spawn('whisper-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    proc.stdout.on('data', (d) => onLine(String(d)));
    proc.stderr.on('data', (d) => { err += String(d).slice(0, 400); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `whisper-cli が ${code} で終わりました`));
      try {
        const j = JSON.parse(fs.readFileSync(`${out}.json`, 'utf8'));
        const segs = (j.transcription || []).map((s) => ({
          text: String(s.text || '').trim(),
          from: s.offsets?.from ?? 0,
        })).filter((s) => s.text);
        fs.unlinkSync(`${out}.json`);
        resolve(segs);
      } catch (e) { reject(e); }
    });
  });
}

/** 音のファイルを 16kHz モノラルの WAV に直す（mp4・m4a・mp3 でも受ける） */
export function toWav(src) {
  return new Promise((resolve, reject) => {
    const dst = path.join(os.tmpdir(), `logloom-in-${Date.now()}.wav`);
    execFile('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', src,
      '-ac', '1', '-ar', String(RATE), '-c:a', 'pcm_s16le', dst], (e) => {
      if (e) return reject(new Error(`音を読めませんでした：${e.message}`));
      resolve(dst);
    });
  });
}
