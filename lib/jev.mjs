// Jev（TypeSafe の System One）に、短い判定だけを頼む。
//
// 議事録を木にするとき、毎回決めることは3つある。
//   ・いまの発言は、さっきの論点の続きか
//   ・続きでないなら、前に出たどの論点に戻ったのか（会議は行き来する）
//   ・辞書に無い怪しい語は、本当に聞き間違いか
//
// どれも「はい／いいえの確からしさ」で答えが出る形なので、文章を書かせる必要がない。
// Jev は型の決まった判定を1秒弱で返すので、発言ごとに回しても会議に追いつく。
// **見出しと要約は書く仕事なので、ここではなく lib/ai.mjs（手元の claude）に回す。**
//
// **鍵はこの道具が持たない。**配るときに、こちらの鍵を埋め込んではいけない。
// 読む順は次のとおり。上にあるものが勝つ。
//   1. この道具の .env の TYPESAFE_API_KEY（画面から貼って保存したもの）
//   2. 環境変数 TYPESAFE_API_KEY
//   3. LOGLOOM_SECRETS が指すファイル（機械ごとに鍵をまとめてある人向け）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');

export const ENDPOINT = process.env.TYPESAFE_ENDPOINT || 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';

function fromEnvFile(file) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

export function apiKey() {
  const here = fromEnvFile(ENV_FILE);
  if (here) return here;
  const env = (process.env.TYPESAFE_API_KEY || '').trim();
  if (env) return env;
  const secrets = process.env.LOGLOOM_SECRETS ? fromEnvFile(process.env.LOGLOOM_SECRETS) : '';
  if (secrets) return secrets;
  return '';
}

/** どこから読んだか。**鍵そのものは画面に渡さない** */
export function keySource() {
  if (fromEnvFile(ENV_FILE)) return 'logloom/.env';
  if ((process.env.TYPESAFE_API_KEY || '').trim()) return '環境変数';
  if (process.env.LOGLOOM_SECRETS && fromEnvFile(process.env.LOGLOOM_SECRETS)) return 'LOGLOOM_SECRETS';
  return '';
}

/**
 * 画面から鍵を入れ替えてよいか。
 *
 * **入れ替えてよいのは、まだどこにも鍵が無いときだけ。**
 * 使う人の機械で、環境変数などに鍵が置いてあるなら、
 * 「この機械ではこの鍵を使う」と決めてあるということで、
 * 画面から上書きできてしまうと、押し間違いで別の鍵に変わる。
 *
 * 配った先（GitHub から持っていった人）には鍵が無いので、画面から入れられる。
 * つまり、**同じコードのまま、自分のところは固定・配った先は入力できる**。
 *
 * `LOGLOOM_KEY_UNLOCK=1` を立てれば、自分の機械でも入れ替えられる。
 */
export function keyLocked() {
  if (process.env.LOGLOOM_KEY_UNLOCK === '1') return false;
  if (fromEnvFile(ENV_FILE)) return false;        // この道具の .env は、画面で入れたもの
  return !!apiKey();                              // 外に置いてある鍵は、画面から触らせない
}

/** 画面から貼られた鍵を、この道具の .env に入れる。**読み書きは本人だけ（600）** */
export function saveKey(key) {
  if (keyLocked()) throw new Error('この機械では鍵が決めてあるので、画面からは変えられません');
  const k = String(key || '').trim();
  if (!k) throw new Error('鍵が空です');
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split('\n') : [];
  const i = lines.findIndex((l) => /^\s*(export\s+)?TYPESAFE_API_KEY\s*=/.test(l));
  const line = `TYPESAFE_API_KEY=${k}`;
  if (i >= 0) lines[i] = line;
  else { if (lines.length && lines[lines.length - 1] === '') lines.pop(); lines.push(line); }
  fs.writeFileSync(ENV_FILE, `${lines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
  fs.chmodSync(ENV_FILE, 0o600);
  return mask(k);
}

/** 鍵そのものは出さない。末尾4文字だけ */
export const mask = (k) => (k ? `${'•'.repeat(8)}${String(k).slice(-4)}` : '');

/** 本当に通るか、いちばん小さな問いで確かめる */
export async function verify(key) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${String(key).trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        state: {},
        questions: { q: { type: 'noul', instructions: { question: 'これは日本語ですか。', 文: 'これは日本語です。' },
          criteria: { true: '日本語', false: '日本語ではない' } } },
      }),
    });
    if (res.ok) return { ok: true };
    const b = await res.json().catch(() => ({}));
    return { ok: false, why: b?.error?.message || `HTTP ${res.status}` };
  } catch (e) { return { ok: false, why: e.message }; }
}

export function available() { return !!apiKey(); }

let calls = 0;
let inTok = 0;
let outTok = 0;
let lastError = '';
export function stats() {
  return { calls, inTok, outTok, lastError, model: MODEL, key: available(),
    source: keySource(), masked: mask(apiKey()), locked: keyLocked() };
}

/**
 * 判定を頼む。**問いはまとめて出す。**同じ発言についての問いは並びで走るので、
 * 1件ずつ投げるより速く、料金も少ない。
 */
export async function ask(state, questions, { timeoutMs = 20000 } = {}) {
  const key = apiKey();
  if (!key) throw new Error('TYPESAFE_API_KEY がありません');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastError = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw new Error(`Jev が答えませんでした：${lastError}`);
    }
    calls += 1;
    inTok += body?.usage?.input_tokens || 0;
    outTok += body?.usage?.output_tokens || 0;
    return body;
  } finally { clearTimeout(timer); }
}

const p = (r, id) => {
  const v = Number(r?.answers?.[id]?.noul);
  return Number.isFinite(v) ? v : null;
};

// ---- 話題の行き先を決める --------------------------------------------------

/** いまの論点の続きだと見なす下限。これを割ったら、他の論点か新しい論点を探す */
export const STAY = 0.45;
/** 前に出た論点へ戻ったと見なす下限。**戻りは新設より強い証拠が要る** */
export const RETURN = 0.62;
/** その議題の中の話だと見なす下限 */
export const SAME_AGENDA = 0.5;
/** これを割る発言は、枝を作らない（挨拶・相づち・進行の合図） */
export const SUBSTANCE = 0.4;

const N_POINTS = 4;    // 戻り先として見る論点の数
const N_AGENDAS = 4;   // 置き場所として見る議題の数

/**
 * この発言はどこへ置くか。**問いは1回にまとめて出す。**
 *
 * 見るのは4つ。
 *   1. 中身のある発言か（「以上です」「ありがとうございました」で枝を作らない）
 *   2. いまの論点の続きか
 *   3. 前に出た論点に戻ったか（会議は行き来する）
 *   4. どの議題の中の話か（**いまの議題だけでなく、前の議題も見る**）
 *
 * 4 を「いまの議題」だけにしていたとき、「展示会の話に戻るんですけど」が
 * 5つめの議題として生え、同じ会議に「展示会」が2本できた（実データで確認）。
 *
 * @returns {kind:'stay'|'return'|'newPoint'|'newAgenda', pointId?, agendaId?, scores}
 */
export async function route(text, { current = null, others = [], agendas = [], about = '' } = {}) {
  if (!available()) return { kind: current ? 'stay' : 'newAgenda', scores: {}, off: true };
  const pts = others.slice(0, N_POINTS);
  const ags = agendas.slice(0, N_AGENDAS);

  const q = { sub: substantial(text) };
  if (current) q.cur = continues(text, current);
  pts.forEach((o, i) => { q[`o${i}`] = continues(text, o); });
  ags.forEach((a, i) => { q[`g${i}`] = underAgenda(text, a); });

  const r = await ask({ about, いまの論点: current?.name || '' }, q);
  const scores = { sub: p(r, 'sub'), cur: p(r, 'cur'), points: {}, agendas: {} };
  pts.forEach((o, i) => { scores.points[o.id] = p(r, `o${i}`); });
  ags.forEach((a, i) => { scores.agendas[a.id] = p(r, `g${i}`); });

  // 1. いまの論点の続き
  if (current && scores.cur != null && scores.cur >= STAY) {
    return { kind: 'stay', pointId: current.id, scores };
  }
  // 2. 前に出た論点へ戻った
  let best = null;
  for (const o of pts) {
    const s = scores.points[o.id];
    if (s != null && (!best || s > best.s)) best = { id: o.id, s };
  }
  if (best && best.s >= RETURN) return { kind: 'return', pointId: best.id, scores };
  // 3. どの議題に置くか。いまの議題を少しだけ優先する（行き来で枝が散らばらないように）
  let bag = null;
  for (const a of ags) {
    const s0 = scores.agendas[a.id];
    if (s0 == null) continue;
    const s = a.id === current?.agendaId ? s0 + 0.05 : s0;
    if (!bag || s > bag.s) bag = { id: a.id, s };
  }
  if (bag && bag.s >= SAME_AGENDA) return { kind: 'newPoint', agendaId: bag.id, scores };
  // 4. どこにも当てはまらない。**中身が無い発言なら、枝を生やさずにいまの枝へ。**
  //
  // この判定は**最後に置く。**先に置いていたとき、「次に、ウェブサイトのリニューアル
  // についてです」を進行の合図と見なして展示会の論点に混ぜ、ウェブサイトの話が
  // まるごと展示会の下にぶら下がった（実データで確認）。
  // 話題の名を告げる発言は、枝を分けるための一番強い手がかりで、捨ててはいけない。
  if (current && scores.sub != null && scores.sub < SUBSTANCE) {
    return { kind: 'stay', pointId: current.id, thin: true, scores };
  }
  return { kind: 'newAgenda', scores };
}

function substantial(text) {
  return {
    type: 'noul',
    instructions: {
      question: 'この発言には、議事録に残すだけの中身がありますか。',
      発言: text,
    },
    criteria: {
      true: '議題・意見・報告・数字・決定・質問など、あとから読んで意味のあることを言っている。'
        + '「次に、◯◯について話します」のように、これから話す件の名前を告げているものも「はい」',
      false: '挨拶、返事、相づち、「以上です」「ありがとうございました」のような締め。'
        + '何の件かを名指ししない「次に行きます」だけの合図。中身のある話が何も含まれていない',
    },
  };
}

function continues(text, point) {
  return {
    type: 'noul',
    instructions: {
      question: '`発言` は、`論点` で話していたことの続きですか。',
      論点: point.name,
      その論点で出た話: (point.recent || '').slice(0, 400),
      発言: text,
    },
    criteria: {
      true: '同じことについて話している。言い換え・補足・反論・具体例・数字の提示も続きに含む',
      false: '別のことに移った。語が重なるだけで、話している中身が違う場合も「いいえ」',
    },
  };
}

function underAgenda(text, agenda) {
  return {
    type: 'noul',
    instructions: {
      question: '`発言` は、`議題` の中の話ですか。',
      議題: agenda.name,
      発言: text,
    },
    criteria: {
      true: 'その議題を進めるための話。細かい論点が変わっても、議題の枠の中なら「はい」',
      false: '議題そのものが変わった。別の案件・別のテーマに移った',
    },
  };
}

// ---- 決定事項・宿題を見つける ----------------------------------------------

/**
 * 発言の種類。**書かせるのではなく、当てはまるかどうかだけ聞く。**
 * 決まったこと・やること・残った課題は、議事録で一番読まれるので、木の上でも印を付ける。
 *
 * **一番強い1つだけを取る。**3つとも 0.7 を超えることがよくあり
 *（「来月中に直します。担当は鈴木さんです」は決定でもあり、やることでもある）、
 * 全部付けると同じ文が3つの箱に並んで地図が読めなくなった。
 */
export async function mark(text, { about = '' } = {}) {
  if (!available()) return { decision: null, action: null, issue: null, top: null };
  const r = await ask({ about }, {
    d: {
      type: 'noul',
      instructions: { question: 'この発言は、会議で決まったことを述べていますか。', 発言: text },
      criteria: { true: '方針・金額・期日・担当・可否が、その場で決まった、または合意されたと読める',
        false: '提案・意見・質問・報告にとどまり、まだ決まっていない' },
    },
    a: {
      type: 'noul',
      instructions: { question: 'この発言は、誰かがこれからやることを述べていますか。', 発言: text },
      criteria: { true: '担当か期日を伴う、これからの具体的な作業',
        false: '済んだことの報告、一般論、感想、会議の進行そのもの（「次の話に移ります」など）' },
    },
    i: {
      type: 'noul',
      instructions: { question: 'この発言は、まだ片付いていない課題や懸念を述べていますか。', 発言: text },
      criteria: { true: '問題・懸念・不明点・反対意見が示され、その場では解決していない',
        false: '解決した、または解決の手立てが同じ発言の中で示されている。'
          + '課題ではない報告や決定も「いいえ」。'
          + '「◯◯はどうしますか」のように、これから相談することを持ち出しただけの問いかけも「いいえ」' },
    },
  });
  const m = { decision: p(r, 'd'), action: p(r, 'a'), issue: p(r, 'i') };
  const best = [['decision', m.decision], ['action', m.action], ['issue', m.issue]]
    .filter(([, v]) => v != null && v >= MARK_SURE)
    .sort((x, y) => y[1] - x[1])[0];
  m.top = best ? best[0] : null;
  return m;
}

export const MARK_SURE = 0.78;

// ---- 辞書に無い誤字を決める ------------------------------------------------

/** これ以上なら直す。これ以下なら触らない（校正の道具 と同じ値から始める） */
export const FIX = 0.8;
export const DROP = 0.25;

/**
 * 「読みが近い語」を、本当に聞き間違いかどうか判定する。
 * **辞書に載っている誤りは触らない。**辞書のほうが機械の勘より強い。
 */
export async function judgeTypos(cands, { about = '', max = 8 } = {}) {
  const targets = cands.slice(0, max);
  if (!targets.length || !available()) return [];
  const q = {};
  targets.forEach((c, i) => {
    q[`t${i}`] = {
      type: 'noul',
      instructions: {
        question: '`文` の中の `出た語` は、`正しい語` の聞き間違い（聞き取りの誤り）ですか。'
          + '`正しい語` に直すべきなら「はい」、その場の言葉として正しく、直すと意味が変わるなら「いいえ」。',
        出た語: c.found,
        正しい語: c.correct,
        文: c.text,
      },
      criteria: {
        true: '音がほぼ同じで、この文では `正しい語` のことを言っている（例：「プロンプット」→「プロンプト」）',
        false: '別の語として正しく使われている。直すと文の意味が変わる。人名・一般名詞の偶然の一致も含む',
      },
    };
  });
  const r = await ask({ about, count: targets.length }, q);
  return targets.map((c, i) => ({ ...c, p: p(r, `t${i}`) }));
}
