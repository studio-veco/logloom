// 見出しと要約を書く係。**手元の `claude` を呼ぶ。**
//
// 配る道具に、こちらの API キーを埋めない。サーバ側の AI 呼び出しは
// 既定を利用者の `claude -p` にする（利用者自身の契約で動く）。
//
// Jev との分担
//   Jev      … 「はい／いいえの確からしさ」で答えが出るもの（どの枝に置くか、決定事項か）
//   claude   … 文章を書くもの（枝の見出し、終点の要約）
//
// 会議に追いつくため、**呼び出しは待たせない。**頼みは待ち行列に積み、
// 返ってきたところで木に書き込んで、画面へ押し出す。書けなくても議事録は進む。

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as youyaku from './youyaku.mjs';

// **どちらも、使う人自身の契約で動く。**こちらの鍵は要らないし、埋め込まない。
//   claude … 手元の `claude -p`
//   codex  … 手元の `codex exec`（ChatGPT のログインで動く）
const ENGINES = {
  claude: { bin: process.env.LOGLOOM_CLAUDE_BIN || 'claude', label: 'Claude' },
  codex: { bin: process.env.LOGLOOM_CODEX_BIN || 'codex', label: 'Codex' },
};
let engineId = process.env.LOGLOOM_ENGINE || 'claude';
const BIN = ENGINES.claude.bin;
const MODEL = process.env.LOGLOOM_MODEL || 'sonnet';
// MCP を一切繋がない設定。外の道具を勝手に触らせない
const NULL_MCP = path.join(os.tmpdir(), 'logloom-null-mcp.json');
try { fs.writeFileSync(NULL_MCP, '{"mcpServers":{}}'); } catch { /* 書けなくても下で落ちる */ }

/**
 * 親から漏れてくる環境変数。**消さないと `claude -p` が別のところを叩く。**
 * このサーバを Claude Code の中から起こすと ANTHROPIC_BASE_URL が親の中継を指していて、
 * 子の claude はそこへ繋ぎにいって落ちた（実測：見出しも要約も1件も書けなかった）。
 * ANTHROPIC_API_KEY が残っていると、契約の枠ではなく従量課金の経路で動く。
 * 消す顔ぶれは 校正の道具の lib/agent.mjs の STRIP_ENV と同じにしてある。
 */
const STRIP_ENV = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_EXECPATH',
  'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH',
  'CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_EAGER_FLUSH', 'AI_AGENT', 'BAGGAGE',
  'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

function childEnv() {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return env;
}

let ok = null;          // null=未確認 true=使える false=使えない
let lastError = '';
let done = 0;
let use = true;         // 画面からの切り替え。false なら Claude を呼ばない
let fails = 0;

export function stats() {
  return { ok, lastError, done, model: engineId === 'codex' ? 'codex' : MODEL, use,
    usable: use && ok !== false, fails, engine: engineId, engineLabel: ENGINES[engineId]?.label || engineId,
    engines: Object.keys(ENGINES), draw: drawOn, canDraw: engineId === 'codex' };
}

/** どちらの係に書かせるか。**切り替えたら、使えるかを確かめ直す** */
export function setEngine(id) {
  if (!ENGINES[id]) return engineId;
  engineId = id;
  ok = null; lastError = ''; fails = 0;
  if (id !== 'codex') drawOn = false;      // 絵は Codex のときだけ
  return engineId;
}

// **絵は Codex のときだけ。**議題ごとに、その話に合う印を1つ描かせる。
// 画像の API は使わない（鍵が要る）。**Codex に SVG を書かせる**ので、
// ChatGPT のログインだけで絵が出る。地図の中に直に置けるので、線も崩れない。
let drawOn = false;
export function setDraw(v) { drawOn = !!v && engineId === 'codex'; return drawOn; }
export function drawing() { return drawOn; }

/** 画面から「Claude を使う／使わない」を切り替える */
export function setUse(v) {
  use = !!v;
  if (use) { ok = null; lastError = ''; fails = 0; }   // 入れ直したら、もう一度試す
  return use;
}

/**
 * 手元に `claude` が入っているかを、**先に一度だけ確かめる。**
 * 確かめずに頼みを積むと、入っていない機械では見出しのたびにプロセスを起こしては
 * 失敗し、そのぶん木の更新が遅れる。
 */
export function probe() {
  return new Promise((resolve) => {
    const eng = ENGINES[engineId];
    execFile(eng.bin, ['--version'], { timeout: 20000, env: childEnv() }, (e, so) => {
      if (e) { ok = false; lastError = `手元の ${eng.label} が見つかりません：${e.message}`.slice(0, 200); return resolve(false); }
      ok = true; lastError = '';
      resolve(String(so || '').trim().slice(0, 60) || true);
    });
  });
}

/** 使える見込みがあるか。**無ければ呼ばずに、発言の言葉だけで作る** */
function usable() {
  if (!use) return false;
  if (ok === false) return false;
  if (fails >= 3) return false;          // 3回続けて駄目なら、もう呼ばない
  return true;
}

const QUEUE = [];
let running = 0;
const MAX = 2;

/** 頼みを積む。順番が来たら走る */
export function enqueue(prompt, { timeoutMs = 60000, tag = '' } = {}) {
  return new Promise((resolve) => {
    QUEUE.push({ prompt, timeoutMs, tag, resolve });
    pump();
  });
}

function pump() {
  while (running < MAX && QUEUE.length) {
    const job = QUEUE.shift();
    running += 1;
    run(job.prompt, job.timeoutMs).then((text) => {
      running -= 1;
      if (text != null) done += 1;
      job.resolve(text);
      pump();
    });
  }
}

function run(prompt, timeoutMs) {
  return engineId === 'codex' ? runCodex(prompt, timeoutMs) : runClaude(prompt, timeoutMs);
}

function runClaude(prompt, timeoutMs) {
  return new Promise((resolve) => {
    let proc;
    const args = [
      '-p',
      '--output-format', 'text',
      '--model', MODEL,
      '--tools', '',                       // 組み込みの道具は渡さない
      '--strict-mcp-config',
      '--mcp-config', NULL_MCP,
      '--setting-sources', '',             // 利用者の CLAUDE.md や設定を読ませない
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
    ];
    try {
      proc = spawn(ENGINES.claude.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() });
    } catch (e) {
      ok = false; fails += 1; lastError = e.message; return resolve(null);
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* もう居ない */ } }, timeoutMs);
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += String(d).slice(0, 500); });
    proc.on('error', (e) => { clearTimeout(timer); ok = false; fails += 1; lastError = e.message; resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && text) { ok = true; fails = 0; return resolve(text); }
      ok = false; fails += 1;
      lastError = (err || `手元の Claude が ${code} で終わりました`).trim().slice(0, 300);
      resolve(null);
    });
    try { proc.stdin.end(prompt); } catch { /* 上の error で拾う */ }
  });
}

/**
 * Codex を呼ぶ。**Claude とは2つ作法が違う。**
 *   1. 頼みは引数で渡す。`codex exec` は標準入力を閉じるので、流し込むと取りこぼす
 *   2. 標準出力には、繋ぎの知らせや使ったトークン数まで混ざる。
 *      `-o` で最後の答えだけをファイルに書かせて、そこから読む
 */
function runCodex(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `logloom-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    let proc;
    const args = ['exec', '--skip-git-repo-check', '-c', 'model_reasoning_effort=low',
      '-o', out, prompt];
    try {
      proc = spawn(ENGINES.codex.bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnv() });
    } catch (e) {
      ok = false; fails += 1; lastError = e.message; return resolve(null);
    }
    let err = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* もう居ない */ } }, timeoutMs);
    proc.stderr.on('data', (d) => { err += String(d).slice(0, 500); });
    proc.on('error', (e) => { clearTimeout(timer); ok = false; fails += 1; lastError = e.message; resolve(null); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      let text = '';
      try { text = fs.readFileSync(out, 'utf8').trim(); } catch { /* 書けていない */ }
      try { fs.unlinkSync(out); } catch { /* もう無い */ }
      if (code === 0 && text) { ok = true; fails = 0; return resolve(text); }
      ok = false; fails += 1;
      lastError = (err || `手元の Codex が ${code} で終わりました`).trim().slice(0, 300);
      resolve(null);
    });
  });
}

// ---- 頼みの形 ---------------------------------------------------------------

// **見出しと要約で言うことを分ける。**
// ひとつにまとめていたとき、見出しの頼みに「体言止め」と「句点で終わる普通の文に」が
// 同時に入り、claude が矛盾を指摘してきて、その指摘文がそのまま見出しになった
//（実データで「体言止めと「句点で終わる文に」が矛盾」という論点ができた）。
const RULES = '日本語で書いてください。絵文字と飾り記号は使いません。'
  + '聞こえたことだけを書き、推測や言い足しをしません。';
const RULES_HEAD = `${RULES}句点は付けません。`;
const RULES_BODY = `${RULES}句点で終わる普通の文にしてください。`;

/** 新しい枝の見出し。**短く、名詞で。** */
export async function nameBranch(lines, { kind = '論点', parent = '' } = {}) {
  const limit = kind === '議題' ? 16 : 18;
  if (!usable()) return { name: youyaku.heading(lines, limit), by: 'words' };
  const text = await enqueue(
    `次は会議の書き起こしの一部です。この部分に付ける「${kind}」の見出しを1つ考えてください。\n`
    + `${parent ? `この見出しは「${parent}」の中に置かれます。\n` : ''}`
    + `条件：${limit}文字以内。体言止め。読点で要素を並べず、一番の中心だけを書く。`
    + `見出しだけを出力し、前置きも引用符も付けない。${RULES_HEAD}\n\n`
    + lines.map((l) => `・${l}`).join('\n'),
    { tag: 'name', timeoutMs: 45000 },
  );
  const first = (text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const name = trim(first.replace(/^[「『"'\-・\s]+|[」』"'\s。]+$/g, ''), limit);
  return name ? { name, by: 'claude' } : { name: youyaku.heading(lines, limit), by: 'words' };
}

/**
 * 長すぎる見出しを切る。**語の途中で切らない。**
 * 「ノベルティは去年の在庫で対応、新規作成な」のように尻切れになると、
 * 地図の上で何の枝か読めなくなる（実データで出た）。読点があればそこで切る。
 */
function trim(s, limit) {
  const t = String(s || '').trim();
  if ([...t].length <= limit) return t;
  const cut = [...t].slice(0, limit).join('');
  const at = Math.max(cut.lastIndexOf('、'), cut.lastIndexOf('・'), cut.lastIndexOf('と'));
  return (at >= Math.floor(limit * 0.5) ? cut.slice(0, at) : cut).replace(/[のにをはがでと、]+$/, '');
}

/** 終点に出す要約。**関連する発言をまとめた短い文章。** */
export async function summarize(name, lines) {
  if (!usable()) return { text: youyaku.summary(lines), by: 'words' };
  const text = await enqueue(
    `次は会議の「${name}」についての発言です。ここで何が話されたかを、読む人が後から追えるようにまとめてください。\n`
    + `条件：80文字から160文字。2文か3文。決まったこと・数字・期日・担当が出ていれば必ず残す。`
    + `まだ決まっていないことは「決まっていない」と書く。見出しや箇条書きにしない。${RULES_BODY}\n\n`
    + lines.map((l) => `・${l}`).join('\n'),
    { tag: 'summary', timeoutMs: 60000 },
  );
  const body = (text || '').split('\n').map((s) => s.trim()).filter(Boolean).join('')
    .replace(/^[「『"']+|[」』"']+$/g, '').slice(0, 300);
  return body ? { text: body, by: 'claude' } : { text: youyaku.summary(lines), by: 'words' };
}

/** 会議そのものの名前。冒頭の発言から付ける */
export async function nameMeeting(lines) {
  if (!usable()) return { name: youyaku.meetingName(lines), by: 'words' };
  const text = await enqueue(
    '次は会議の冒頭です。この会議の名前を1つ考えてください。\n'
    + `条件：20文字以内。体言止め。名前だけを出力する。${RULES_HEAD}\n\n`
    + lines.map((l) => `・${l}`).join('\n'),
    { tag: 'meeting', timeoutMs: 45000 },
  );
  const first = (text || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  const name = first.replace(/^[「『"'\-・\s]+|[」』"'\s。]+$/g, '').slice(0, 20);
  return name ? { name, by: 'claude' } : { name: youyaku.meetingName(lines), by: 'words' };
}

/**
 * 議題の絵。**Codex に SVG を1つ書かせる。**
 *
 * 画像の API（gpt-image ほか）は鍵が要るので使わない。使う人の ChatGPT の
 * ログインだけで絵が出るように、**モデル自身に図形を書かせる**。
 * SVG なので地図の中に直に置けて、どれだけ拡げても線が崩れない。
 *
 * 返すのは 64×64 の SVG 1つ。色は地図の議題の色に合わせて白の線画にする。
 */
export async function drawMark(name, lines) {
  if (!drawOn || !usable()) return null;
  const text = await enqueue(
    `「${name}」という会議の議題を表す、64×64 の SVG のピクトグラムを1つ書いてください。\n`
    + '条件：\n'
    + '- <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" ...> から </svg> までだけを出力する。説明文もコードブロックの印も付けない\n'
    + '- 線画のみ。fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"\n'
    + '- 塗り、影、グラデーション、文字、絵文字は使わない\n'
    + '- 形は4〜8本の線か図形まで。小さく置いても何か分かる、単純な形にする\n'
    + '- 余白を 6 取り、6〜58 の範囲に収める\n\n'
    + `この議題で話されたこと：\n${lines.slice(0, 4).map((l) => `・${l}`).join('\n')}`,
    { tag: 'draw', timeoutMs: 90000 },
  );
  return cleanSvg(text);
}

/**
 * 返ってきた SVG を、そのまま置いてよい形にする。
 * **中身を確かめずに地図へ入れない。**モデルは説明やコードブロックの印を付けてくることがあり、
 * script や画像の取り込みを書かれると、そのまま画面で動いてしまう。
 */
function cleanSvg(text) {
  const t = String(text || '');
  const m = t.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  let svg = m[0];
  if (/<script|<foreignObject|<image|href\s*=|javascript:|on[a-z]+\s*=/i.test(svg)) return null;
  if (svg.length > 4000) return null;
  if (!/viewBox/i.test(svg)) svg = svg.replace(/<svg/i, '<svg viewBox="0 0 64 64"');
  return svg;
}

// 見出しと要約が Claude で書けないときは lib/youyaku.mjs が引き受ける。
// **書き起こしそのものは Claude を通らない。**音を文字にするのは whisper、
// 枝分けは Jev、誤字は 校正辞書で、Claude が無くても最後まで動く。
