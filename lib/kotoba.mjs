// 校正辞書と検査をそのまま借りる橋。
//
// **同じ仕事を作り直すときは、機能より先に前の案件の検査を移す。**
// ここで 写経すると、その道具が直した穴（語の内側に食い込む置換、
// 言い換えを片方に寄せる、フィラーだけの行）をもう一度掘ることになる。
// なので写さずに読み込む。元の道具が直れば、こちらも直る。
//
// 借りるもの
//   glossary.mjs  共通辞書 6,700語（分野13本）・vocabPrompt（聞き取りに教える語彙）
//   report.mjs    applyGlossary（正誤表を本文に当てる。語の内側には食い込まない）
//   speech.mjs    cleanSpeech（言いよどみ・相づちを落とす。言葉は足さない）
//   terms.mjs     suspects（辞書に無い怪しい語を、読みの近さで並べる）
//   yomi.mjs      読み（janome）。常駐するので、終わるときに止める
//
// 直すのは**入口が先**。whisper の初期プロンプトに語彙を渡すほうが、
// 出口で置換するより確実に効く（実測：「生成愛」「施策」が、語彙を渡しただけで
// 「生成AI」「試作」で出た）。出口の置換は、そこを抜けたぶんの受け皿。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ym from './yomimatch.mjs';

// その道具の置き場所。**決め打ちにしない。**
// 人に配るときに、こちらの機械の道が残っていると、その人の機械では読めない。
//   1. この道具の .env の LOGLOOM_GLOSSARY（.gitignore 済み。配る形には残らない）
//   2. 環境変数 LOGLOOM_GLOSSARY
//   3. この道具の隣（../glossary-tool）
//   4. その1つ上の隣（../../glossary-tool）
// 見つからなければ、辞書なしで動く（画面にそう出る）。
/** この道具の .env から1行読む（鍵と同じ置き場所。.gitignore 済み） */
function fromEnvFile(key) {
  try {
    const f = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
    const m = fs.readFileSync(f, 'utf8').match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*["']?([^"'\\r\\n]+)["']?`, 'm'));
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

function findGlossaryTool() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cands = [fromEnvFile('LOGLOOM_GLOSSARY'), process.env.LOGLOOM_GLOSSARY,
    path.resolve(here, '..', '..', 'glossary-tool'),
    path.resolve(here, '..', '..', '..', 'glossary-tool')].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(path.join(c, 'lib', 'glossary.mjs'))) return c; } catch { /* 次へ */ }
  }
  return cands[0] || '';
}

const TOOL = findGlossaryTool();
const at = (f) => path.join(TOOL, 'lib', f);
export function glossaryPath() { return TOOL; }

let mods = null;
let glossary = null;

/** 校正の道具の lib を読み込む。その道具が無い機械でも、議事録そのものは動く */
export async function load() {
  if (mods) return mods;
  try {
    const [g, r, s, t, y] = await Promise.all([
      import(at('glossary.mjs')), import(at('report.mjs')),
      import(at('speech.mjs')), import(at('terms.mjs')), import(at('yomi.mjs')),
    ]);
    mods = { g, r, s, t, y, ok: true };
    glossary = await g.withShared({});
  } catch (e) {
    mods = { ok: false, why: TOOL ? `${TOOL} から読めません：${e.message}` : 'その道具が見つかりません' };
    glossary = { terms: [] };
  }
  return mods;
}

export function ready() { return !!mods?.ok; }
export function termCount() { return glossary?.terms?.length || 0; }
export function why() { return mods?.why || ''; }

/**
 * 聞き取りに渡す語彙。**224トークンで切られる**ので、その道具が頻度順に並べたものを使う。
 * 会議でよく出て、崩れると意味が変わる語をこちらから足す。
 */
// **同じ音の別の語に転ぶものを、先に教える。**
// 実測：「設計案は山田さんが」が「設定案は山田さんが」になった。設計も設定も
// ふつうの語なので、出口では直しようがない（読みを比べても、どちらも正しい語）。
// 入口で「設計」を教えておけば、whisper はそちらを選ぶ。
const MEETING_VOCAB = ['議事録', '議題', '論点', '設計', '仕様', '要件', '試作',
  '決裁', '稟議', '見積', '納期', '進捗', '課題', '合意', '差し戻し', '前提', '懸念',
  '小間', '承認', '保留'];

export function vocab(extra = []) {
  if (!mods?.ok) return [...extra, ...MEETING_VOCAB].join('、') + '。';
  // **その会議の語を先に置く。**224トークンで切られるので、順番が効き目を決める
  return mods.g.vocabPrompt(glossary, [...extra, ...MEETING_VOCAB]);
}

/** 言いよどみだけの行か（マインドマップに入れない） */
export function isNoise(text) {
  if (!mods?.ok) return !String(text || '').trim();
  return mods.s.isFillerOnly(text);
}

/** 話し言葉を整える。**言葉は足さない。** */
export function clean(text) {
  if (!mods?.ok) return String(text || '').trim();
  return mods.s.cleanSpeech(text);
}

/** 正誤表を当てる。辞書に載っている誤りだけ。機械の勘より辞書が強い */
export function fixByDict(text) {
  if (!mods?.ok) return String(text || '');
  return mods.r.applyGlossary(String(text || ''), glossary);
}

/** 大文字小文字・全角半角を辞書の書き方に寄せる（chatGPT → ChatGPT） */
export function fixCasing(text) {
  if (!mods?.ok) return String(text || '');
  return mods.g.fixCasing(String(text || ''), glossary);
}

/** 辞書に載っている誤りの指摘（level: wrong / style / maybe） */
export function checks(text) {
  if (!mods?.ok) return [];
  try { return mods.g.checkText(String(text || ''), glossary); } catch { return []; }
}

/**
 * 辞書に**載っていない**怪しい語を並べる。直さない。候補を出すだけ。
 * 決めるのは Jev（lib/jev.mjs）。
 */
export async function suspects(lines) {
  if (!mods?.ok) return [];
  try { return await mods.t.suspects(lines, { minLen: 3 }); } catch { return []; }
}

/** 読み。辞書の語をあらかじめ引いておくと、途中で止まらない */
export async function warmReadings(limit = 4000) {
  if (!mods?.ok) return 0;
  const words = (glossary.terms || []).map((t) => t.correct).filter((w) => w && w.length >= 3).slice(0, limit);
  try { await mods.y.readingsOf(words); return words.length; } catch { return 0; }
}

// ---- 辞書の語と、読みを直に比べる ------------------------------------------
//
// その道具の suspects は「同じ収録の中で、もっと多く出ている語」を探す。
// 会議は始まったばかりで比べる相手が居ないので、辞書と直に比べる道をもう1本持つ。

let known = null;
export async function buildMatcher() {
  if (!mods?.ok) return 0;
  known = new Set();
  for (const t of glossary.terms || []) {
    if (t.correct) known.add(t.correct);
    for (const a of t.also || []) known.add(a);
  }
  await ym.buildIndex(glossary.terms, (ws) => mods.y.readingsOf(ws));
  return ym.size();
}

export function matcherSize() { return ym.size(); }

/** その会議だけの語（人名・社名・商品名）。聞き取りの語彙と、読みの照合の両方に効かせる */
export async function addMeetingWords(words) {
  if (!mods?.ok) return 0;
  for (const w of words || []) if (w) (known || (known = new Set())).add(String(w).trim());
  try { return await ym.addTerms(words, (ws) => mods.y.readingsOf(ws)); } catch { return 0; }
}

/** 辞書の語の聞き間違いらしきものを拾う。直さない。候補を返すだけ */
export async function dictCandidates(text) {
  if (!mods?.ok || !ym.ready()) return [];
  return ym.candidates(text, { known: known || new Set(), readOf: (ws) => mods.y.readingsOf(ws) });
}

export function shutdown() {
  try { mods?.y?.shutdown?.(); } catch { /* もう居ない */ }
}
