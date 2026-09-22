// 辞書に**載っていない誤り**を、読みの近さで拾う。
//
// 共通辞書は「正しい語の一覧」で、誤りは案件ごとに貯める。
// 会議は毎回ちがう案件なので、貯まった誤りが効かない。だから
// **その場で読みを比べて候補を出し、当たり外れは Jev に決めてもらう。**
//
// 共通辞書の道具 も同じことをするが、あちらは「同じ収録の中で、もっと多く出ている語」を
// 先に探す（1本の動画を通して見るので、それが一番強い手がかりになる）。
// 会議は始まったばかりで比べる相手が居ないので、こちらは**辞書の語と直接比べる**。
//
// 罠がひとつある。その道具の読み（janome）は英字をそのまま返すので、
// 「生成AI」は「せいせいAI」になる。これを「せいせいあい」と比べると
// 距離が離れ、**「生成愛」を取り逃がす**（実データでそうなった）。
// 大文字の略語は1字ずつ日本語の字名に開いてから比べる。

const LETTER = {
  A: 'えー', B: 'びー', C: 'しー', D: 'でぃー', E: 'いー', F: 'えふ', G: 'じー',
  H: 'えいち', I: 'あい', J: 'じぇー', K: 'けー', L: 'える', M: 'えむ', N: 'えぬ',
  O: 'おー', P: 'ぴー', Q: 'きゅー', R: 'あーる', S: 'えす', T: 'てぃー', U: 'ゆー',
  V: 'ぶい', W: 'だぶりゅー', X: 'えっくす', Y: 'わい', Z: 'ぜっと',
  0: 'ぜろ', 1: 'いち', 2: 'に', 3: 'さん', 4: 'よん', 5: 'ご',
  6: 'ろく', 7: 'なな', 8: 'はち', 9: 'きゅう',
};

const VOWEL = { あ: 'あ', か: 'あ', さ: 'あ', た: 'あ', な: 'あ', は: 'あ', ま: 'あ', や: 'あ', ら: 'あ', わ: 'あ', が: 'あ', ざ: 'あ', だ: 'あ', ば: 'あ', ぱ: 'あ',
  い: 'い', き: 'い', し: 'い', ち: 'い', に: 'い', ひ: 'い', み: 'い', り: 'い', ぎ: 'い', じ: 'い', ぢ: 'い', び: 'い', ぴ: 'い',
  う: 'う', く: 'う', す: 'う', つ: 'う', ぬ: 'う', ふ: 'う', む: 'う', ゆ: 'う', る: 'う', ぐ: 'う', ず: 'う', づ: 'う', ぶ: 'う', ぷ: 'う',
  え: 'い', け: 'い', せ: 'い', て: 'い', ね: 'い', へ: 'い', め: 'い', れ: 'い', げ: 'い', ぜ: 'い', で: 'い', べ: 'い', ぺ: 'い',
  お: 'う', こ: 'う', そ: 'う', と: 'う', の: 'う', ほ: 'う', も: 'う', よ: 'う', ろ: 'う', ご: 'う', ぞ: 'う', ど: 'う', ぼ: 'う', ぽ: 'う' };

const KATA2HIRA = (s) => String(s).replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** 比べるための形にそろえる。長音を母音に開き、促音を落とし、大文字の略語は字名にする */
export function key(s) {
  let t = KATA2HIRA(String(s || ''));
  // 大文字だけの英数（AI・DX・API・5G）は、1字ずつ日本語の字名に
  t = t.replace(/[A-Z0-9]{1,5}/g, (m) => [...m].map((c) => LETTER[c] || c).join(''));
  t = t.toLowerCase();
  let out = '';
  for (const ch of t) {
    if (ch === 'ー' && out) out += VOWEL[out[out.length - 1]] || out[out.length - 1];
    else out += ch;
  }
  return out.replace(/[っ・\s]/g, '');
}

/** 読みの近さ。0〜1（1が同じ） */
export function close(a, b) {
  const x = key(a), y = key(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (Math.abs(x.length - y.length) > 3) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}

// 本文から取り出す語。漢字・片仮名・英数の続きだけを見る（ひらがなだけの語は助詞ごと拾ってしまう）
const TOKEN = /[一-龥ァ-ヶーA-Za-z0-9][一-龥ァ-ヶーA-Za-z0-9]{1,9}/g;

let index = null;

/**
 * 辞書に読みを付けた索引を作る。**1回だけ。**
 * @param terms   共通辞書（{correct, also}）
 * @param readOf  読みを引く関数（words => Promise<readings>）
 */
export async function buildIndex(terms, readOf) {
  if (index) return index;
  const words = [];
  const seen = new Set();
  for (const t of terms || []) {
    for (const w of [t.correct, ...(t.also || [])]) {
      const s = String(w || '').trim();
      if (!s || s.length < 3 || seen.has(s)) continue;
      if (/^[ぁ-ん]+$/.test(s)) continue;             // ひらがなだけの言い換えは、比べる意味がない
      seen.add(s);
      words.push({ correct: t.correct, surface: s });
    }
  }
  let readings = words.map((w) => w.surface);
  try {
    const got = await readOf(words.map((w) => w.surface));
    readings = words.map((w, i) => got[i] || w.surface);
  } catch { /* 読みが引けなくても、字のままで比べる */ }
  index = words.map((w, i) => ({ ...w, k: key(readings[i]) }));
  return index;
}

export function ready() { return !!index; }
export function size() { return index?.length || 0; }

/**
 * その会議だけの語を索引に足す。**人名・社名・商品名は辞書に無い。**
 * 会議のたびに変わるので、始める前に画面から入れてもらう。
 * 聞き取りの語彙（whisper の初期プロンプト）にも同じものを渡す。
 */
export async function addTerms(words, readOf) {
  if (!index) return 0;
  const add = [...new Set((words || []).map((w) => String(w || '').trim()).filter((w) => w.length >= 2))]
    .filter((w) => !index.some((t) => t.surface === w));
  if (!add.length) return 0;
  let readings = add;
  try { const got = await readOf(add); readings = add.map((w, i) => got[i] || w); } catch { /* 字のまま */ }
  add.forEach((w, i) => index.push({ correct: w, surface: w, k: key(readings[i]), mine: true }));
  return add.length;
}

/**
 * この文から、辞書の語の聞き間違いらしきものを拾う。**直さない。候補を返すだけ。**
 *
 * @param text    発言
 * @param known   そのまま正しいと分かっている語（辞書の見出し）
 * @param readOf  読みを引く関数
 * @param min     これ以上近ければ候補にする。**低めにして、決めるのは Jev に任せる**
 */
export async function candidates(text, { known = new Set(), readOf = null, min = 0.68, minKnown = 0.78, max = 3 } = {}) {
  if (!index) return [];
  const raw = String(text || '');
  const toks = [...new Set((raw.match(TOKEN) || []))]
    .filter((w) => w.length >= 2 && w.length <= 10)
    .filter((w) => !/^[0-9]+$/.test(w));
  if (!toks.length) return [];

  let reads = toks;
  if (readOf) {
    try { const got = await readOf(toks); reads = toks.map((w, i) => got[i] || w); } catch { /* 字のまま */ }
  }

  const out = [];
  toks.forEach((w, i) => {
    const kw = key(reads[i]);
    if (kw.length < 3) return;
    // **辞書に載っている語も、候補から外さない。**
    // 外していたとき「設計案」が「設定案」と書かれても黙っていた。どちらもふつうの語なので、
    // 読みを比べるしかなく、決められるのは前後を読む Jev だけ。
    // ただし正しく書けているほうが多いので、載っている語には高いほうの下限を使う。
    const isKnown = known.has(w);
    const bar = isKnown ? minKnown : min;
    let best = null;
    for (const t of index) {
      if (t.surface === w || t.correct === w) continue;         // 自分自身とは比べない
      if (Math.abs(t.k.length - kw.length) > 2) continue;
      if (t.surface.includes(w) || w.includes(t.surface)) continue;  // 語が伸びただけ。聞き違いではない
      const s = closeKeys(kw, t.k);
      if (s >= bar && (!best || s > best.score)) best = { correct: t.correct, score: Math.round(s * 100) / 100 };
    }
    if (best) out.push({ found: w, correct: best.correct, score: best.score, known: isKnown, text: raw });
  });
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}

/** key() を通した文字列どうしの近さ（索引はもう key 済みなので、二度掛けない） */
function closeKeys(x, y) {
  if (x === y) return 1;
  if (Math.abs(x.length - y.length) > 3) return 0;
  const dp = Array.from({ length: x.length + 1 }, (_, i) => [i, ...Array(y.length).fill(0)]);
  for (let j = 0; j <= y.length; j++) dp[0][j] = j;
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
  }
  return 1 - dp[x.length][y.length] / Math.max(x.length, y.length);
}
