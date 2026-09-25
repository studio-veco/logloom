// Claude を使わずに、見出しと要約を作る係。
//
// **書き起こしは Claude が無くても動きます。**音を文字にするのは whisper、
// 枝分けは Jev、誤字は 校正辞書で、どれも Claude を通りません。
// Claude が要るのは「見出し」と「要約」という、文章を書く仕事だけです。
//
// ここはその2つを、**発言の中の言葉だけで**作ります。言葉を足さないので、
// Claude が書いたものより硬くなりますが、間違ったことは書きません。
//
//   見出し … その論点でいちばん多く出ている中身のある語
//   要約   … 中身の濃い発言を2文、出てきた順につなぐ
//
// 濃さの測り方は、数字・期日・担当・決めの言葉が入っているかで数えます。
// 会議の議事録で人が読み返すのは、だいたいそこだからです。

// 中身のある語として拾う形。ひらがなだけの語は助詞ごと付いてくるので見ない
const WORD = /[一-龥ァ-ヶーA-Za-z0-9][一-龥ァ-ヶーA-Za-z0-9]{1,11}/g;

// それだけでは中身にならない語。数えても見出しにならない
const THIN = new Set(['こと', 'もの', 'ため', 'とき', 'ところ', 'それ', 'これ',
  '今回', '今日', '本日', '以上', '以下', '場合', '部分', '内容', '状況', '感じ',
  '話', '件', '方', '点', '形', '我々', '皆さん', '皆様', '自分', '一つ目', '二つ目', '三つ目']);

// 決まったこと・やることの手がかり。要約に残す文を選ぶのに使う
const HEAVY = [/決ま(り|っ)/, /決定/, /合意/, /承認/, /通りました/, /します/, /ます/,
  /まで/, /担当/, /[0-9０-９]+\s*(円|万円|億円|件|人|名|日|月|週|時間|分|％|%|個|台|本)/,
  /来週|来月|今月|今週|年度|期限|納期/];

function count(lines) {
  const c = new Map();
  for (const line of lines) {
    for (const m of String(line).matchAll(WORD)) {
      const w = m[0];
      if (w.length < 2 || THIN.has(w)) continue;
      if (/^[0-9０-９]+$/.test(w)) continue;
      c.set(w, (c.get(w) || 0) + 1);
    }
  }
  return c;
}

/**
 * 見出し。**その論点でいちばん多く出ている、中身のある語を2つまで。**
 * 同じ回数なら長いほうを取ります（「展示会」より「展示会ブース」）。
 */
export function heading(lines, limit = 18) {
  const c = count(lines);
  if (!c.size) return '話題';
  const ranked = [...c.entries()]
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .map(([w]) => w);
  const pick = [];
  for (const w of ranked) {
    // すでに選んだ語に含まれる（または含む）ものは、同じことを二度言うだけ
    if (pick.some((p) => p.includes(w) || w.includes(p))) continue;
    pick.push(w);
    if (pick.length === 2) break;
  }
  const name = pick.join('と');
  return name.length <= limit ? name : pick[0].slice(0, limit);
}

/** 会議そのものの名前。冒頭の発言から、同じやり方で */
export function meetingName(lines, limit = 20) {
  const h = heading(lines, limit - 2);
  return h === '話題' ? '会議' : `${h}の会議`.slice(0, limit);
}

function weight(text) {
  let n = 0;
  for (const re of HEAVY) if (re.test(text)) n += 1;
  return n + Math.min(String(text).length / 60, 1);
}

/**
 * 要約。**発言の言葉をそのまま使います。書き換えません。**
 * 中身の濃い順に2文選び、話した順に並べ直します。
 */
export function summary(lines, max = 160) {
  const list = lines.map((t) => String(t).trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return cut(list[0], max);
  const ranked = list
    .map((t, i) => ({ t, i, w: weight(t) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 2)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.t);
  return cut(ranked.join(''), max);
}

function cut(s, max) {
  const t = String(s).trim();
  if ([...t].length <= max) return t;
  const head = [...t].slice(0, max).join('');
  const at = Math.max(head.lastIndexOf('。'), head.lastIndexOf('、'));
  return at > max * 0.5 ? head.slice(0, at + 1) : `${head}…`;
}

/**
 * 要点を2〜4つに分ける。**AI が居ないときの道。**
 *
 * 地図の第3層に置くものなので、1つの長い文ではなく、短い文をいくつか返す。
 * 重みの高い発言をそのまま採り、どの発言から採ったかを添える
 *（地図から書き起こしへ飛ぶのに要る）。
 */
export function keypoints(lines, { max = 4, chars = 45 } = {}) {
  const list = lines.map((t, i) => ({ t: String(t).trim(), i })).filter((x) => x.t);
  if (!list.length) return [];
  const n = Math.max(1, Math.min(max, Math.ceil(list.length / 3)));
  return list
    .map((x) => ({ ...x, w: weight(x.t) }))
    .sort((a, b) => b.w - a.w)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => ({ text: cut(x.t, chars), from: [x.i] }));
}

/**
 * 発言を、地図に置ける短い言い方にする。**要約した状態で終点に出すため。**
 * 言いよどみの頭を落とし、文の切れ目で切る。中身は足さない。
 */
export function gist(text, max = 42) {
  const t = String(text || '').trim()
    .replace(/^(ええと|えっと|あの|その|まあ|はい|うん|で、|それで|あと|ちょっと)[、,\s]*/g, '')
    .replace(/^(なので|ですので)[、,\s]*/, '');
  return cut(t, max);
}
