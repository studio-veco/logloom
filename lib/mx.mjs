// 木を drawio（mxGraph）の XML にする。
//
// drawio に置き場所を任せると、描き直すたびに枝が飛ぶ。会議の途中で地図が動くと、
// さっきまで見ていた枝を目で追えなくなるので、**座標はこちらで決める。**
// 決め方は素直な木の並べ方で、終点から順に縦に積み、親は子の真ん中に置く。
// 枝は増えるだけなので、前に置いた枝の場所は動かない。
//
// 箱の高さは中の字数から出す。drawio は字を折り返すが、高さは自動で伸びない。
// 出す文字を数えて、ここで高さを決める。

// 起点から4層。**第3層までで枝を分け、第4層で振り分ける。**
// 決まったこと・やること・課題を論点の真下に横並びにしていたとき、
// 論点ごとに4つの箱が散らばって地図が読めなかった。要点の下にぶら下げて束ねる。
const COL = [
  { x: 0, w: 200 },      // 起点　　会議
  { x: 290, w: 200 },    // 第1層　議題
  { x: 580, w: 210 },    // 第2層　論点
  { x: 880, w: 280 },    // 第3層　要点（要約を開いたもの）
  { x: 1250, w: 300 },   // 第4層　振り分け（決まったこと・やること・課題）
];
const VGAP = 16;
const LINE = 19;
const PAD = 22;

const STYLE = {
  root: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#1A1A1A;strokeColor=none;fontColor=#FFFFFF;fontSize=16;fontStyle=1;align=center;verticalAlign=middle;arcSize=12;',
  agenda: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#0017C1;strokeColor=none;fontColor=#FFFFFF;fontSize=14;fontStyle=1;align=center;verticalAlign=middle;arcSize=14;',
  point: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E8F1FE;strokeColor=#0017C1;fontColor=#1A1A1A;fontSize=13;align=center;verticalAlign=middle;arcSize=14;',
  pointNow: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#0017C1;strokeColor=#0017C1;fontColor=#FFFFFF;fontSize=13;fontStyle=1;align=center;verticalAlign=middle;arcSize=14;strokeWidth=3;',
  summary: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#CCCCCC;fontColor=#1A1A1A;fontSize=12;align=left;verticalAlign=top;spacing=10;arcSize=8;',
  decision: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E6F5EC;strokeColor=#197A4B;fontColor=#0C472A;fontSize=12;align=left;verticalAlign=top;spacing=10;arcSize=8;',
  action: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E8F1FE;strokeColor=#0017C1;fontColor=#00118F;fontSize=12;align=left;verticalAlign=top;spacing=10;arcSize=8;',
  issue: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FDEEEE;strokeColor=#CE0000;fontColor=#A90000;fontSize=12;align=left;verticalAlign=top;spacing=10;arcSize=8;',
  waiting: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#F2F2F2;strokeColor=#CCCCCC;fontColor=#666666;fontSize=12;align=left;verticalAlign=top;spacing=10;arcSize=8;dashed=1;',
};
// 終点の見出しに添える印。**drawio の箱の中身は HTML なので、小さな絵を埋められる。**
// 色は箱の枠と同じにして、字と並べて置く（アイコンだけで意味を伝えない）。
function mark(d, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" `
    + `fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}" width="13" height="13" align="absmiddle"> `;
}
const MARK = {
  summary: () => mark('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/>', '#767676'),
  decision: () => mark('<path d="m4.5 12.5 5 5 10-11"/>', '#197A4B'),
  action: () => mark('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 9.5h16M8 3v4m8-4v4m-8 8 2 2 4-4"/>', '#0017C1'),
  issue: () => mark('<path d="M12 3.5 21.5 20h-19z"/><path d="M12 10v4m0 3h.01"/>', '#CE0000'),
  waiting: () => mark('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', '#767676'),
};

const EDGE = 'edgeStyle=entityRelationEdgeStyle;rounded=1;curved=1;html=1;'
  + 'startArrow=none;startFill=0;endArrow=none;endFill=0;'
  + 'exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;'
  + 'strokeColor=#B3B3B3;strokeWidth=1.5;';

// 箱の中身は HTML として書く（改行・太字・小さい字）。ここは HTML としての逃がし
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * XML の属性に入れるための逃がし。**HTML の逃がしとは別に、もう一度かける。**
 *
 * mxGraph は見出しを `value="..."` という属性に入れる。そこに `<br>` を生のまま
 * 書くと XML として壊れ、drawio は「図面ファイルではありません」と言って何も描かない
 *（実際にそうなった：Unescaped '<' not allowed in attributes values）。
 * 二重に逃がしても、XML を解いた時点で HTML に戻るので、見た目は変わらない。
 */
const attr = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

/** 和文まじりの字幅。英数は半分として数える */
function width(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\x20-\x7E]/.test(ch) ? 0.5 : 1;
  return n;
}

/** その箱に要る高さ。<br> は必ず行を変える */
function height(label, w, { fontPx = 12, min = 44 } = {}) {
  const perLine = Math.max(4, Math.floor((w - 24) / fontPx));
  let lines = 0;
  for (const part of String(label).split(/<br\s*\/?>/i)) {
    lines += Math.max(1, Math.ceil(width(part.replace(/<[^>]+>/g, '')) / perLine));
  }
  return Math.max(min, Math.round(lines * LINE + PAD));
}

function node(id, label, style, col, fontPx, min) {
  const w = COL[col].w;
  return { id, label, style, col, w, h: height(label, w, { fontPx, min }), y: 0, children: [] };
}

/** 木を組み立てる。終点（要約・決まったこと・やること・課題）はここで作る */
export function build(tree) {
  const root = node('root', esc(tree.title || '会議'), STYLE.root, 0, 16, 56);

  for (const a of tree.agendas) {
    // 議題の絵（Codex の image_gen が作ったもの）。名前の上に置く。
    // すでに data URI の形で届くので、そのまま入れる
    const pic = a.mark ? `<img src="${esc(a.mark)}" width="30" height="30"><br>` : '';
    const an = node(a.id, pic + esc(a.name), a.named ? STYLE.agenda : STYLE.agenda + 'dashed=1;', 1, 14, a.mark ? 74 : 48);
    root.children.push(an);

    for (const p of a.points) {
      const label = `${esc(p.name)}<br><font color="${p.cursor ? '#D9E6FF' : '#666666'}" style="font-size:10px">発言 ${p.count}</font>`;
      const pn = node(p.id, label, p.cursor ? STYLE.pointNow : (p.named ? STYLE.point : STYLE.point + 'dashed=1;'), 2, 13, 48);
      an.children.push(pn);

      // 第3層。**要約を2〜4つに開いたもの。**来るまでは、来ていないと分かる形で置く
      if (p.keypoints && p.keypoints.length) {
        for (const k of p.keypoints) {
          const kn = node(k.id, MARK.summary() + esc(k.text), STYLE.summary, 3, 12, 48);
          kn.jump = (k.from || []).join(',');
          pn.children.push(kn);

          // 第4層。振り分け（決まったこと・やること・課題）
          for (const [bucket, style, m, head] of [
            ['decisions', STYLE.decision, MARK.decision, '決まったこと'],
            ['actions', STYLE.action, MARK.action, 'やること'],
            ['issues', STYLE.issue, MARK.issue, '残った課題'],
          ]) {
            const list = k[bucket] || [];
            if (!list.length) continue;
            const bn = node(`${k.id}_${bucket[0]}`,
              `${m()}<b>${head}</b><br>${list.map((t) => `・${esc(t.text)}`).join('<br>')}`,
              style, 4, 12, 48);
            bn.jump = list.map((t) => t.id).join(',');
            kn.children.push(bn);
          }
        }
        if (p.fresh) {
          pn.children.push(node(`${p.id}_f`,
            `${MARK.waiting()}この後の発言はまだ入っていません`, STYLE.waiting, 3, 12, 44));
        }
      } else {
        pn.children.push(node(`${p.id}_s`, `${MARK.waiting()}要点をまとめています`, STYLE.waiting, 3, 12, 44));
      }
    }
    if (!an.children.length) an.children.push(node(`${a.id}_e`, '（論点はこれから）', STYLE.waiting, 2, 12, 44));
  }
  if (!root.children.length) {
    root.children.push(node('empty', '発言を待っています', STYLE.waiting, 1, 12, 44));
  }
  layout(root, 0);
  return root;
}

/** 終点から縦に積み、親は子の真ん中に置く */
function layout(n, top) {
  if (!n.children.length) {
    n.y = top;
    return top + n.h + VGAP;
  }
  let y = top;
  for (const c of n.children) y = layout(c, y);
  const first = n.children[0];
  const last = n.children[n.children.length - 1];
  n.y = Math.round((first.y + last.y + last.h) / 2 - n.h / 2);
  // 親のほうが背が高いとき、子の帯からはみ出す。親が収まるだけ下へ送る
  return Math.max(y, n.y + n.h + VGAP);
}

/**
 * 絵ぜんたいの大きさ。**画面側が「枝が伸びたか」を知るために要る。**
 * 伸びたときだけ引き直せば、見ている所をむやみに動かさずに済む。
 */
export function extent(tree) {
  const root = build(tree);
  let w = 0, h = 0;
  const walk = (n) => {
    w = Math.max(w, COL[n.col].x + n.w);
    h = Math.max(h, n.y + n.h);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return { w, h };
}

/** drawio が読む XML */
export function xml(tree, { name = '議事録' } = {}) {
  const root = build(tree);
  const cells = [];
  const walk = (n, parent) => {
    const geo = `<mxGeometry x="${COL[n.col].x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/>`;
    if (n.jump) {
      // **飛び先を図形に持たせる。**mxCell には自前の属性を足せないので、
      // drawio の決まりどおり object で包む。押されたら、その発言まで書き起こしを送る
      cells.push(`<object id="${n.id}" label="${attr(n.label)}" jump="${attr(n.jump)}">`
        + `<mxCell style="${n.style}" vertex="1" parent="1">${geo}</mxCell></object>`);
    } else {
      cells.push(`<mxCell id="${n.id}" value="${attr(n.label)}" style="${n.style}" vertex="1" parent="1">`
        + `${geo}</mxCell>`);
    }
    if (parent) {
      cells.push(`<mxCell id="e_${parent.id}_${n.id}" style="${EDGE}" edge="1" parent="1" `
        + `source="${parent.id}" target="${n.id}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    }
    for (const c of n.children) walk(c, n);
  };
  walk(root, null);
  return '<mxfile host="LOGLOOM" type="device">'
    + `<diagram id="logloom" name="${attr(name)}">`
    + '<mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="0" connect="1" '
    + 'arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0" '
    + 'background="#FFFFFF">'
    + `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root>`
    + '</mxGraphModel></diagram></mxfile>';
}

/**
 * 配る用の地図。**drawio を持ち出さずに、同じ形の絵を1枚の SVG で描く。**
 *
 * 配る先に drawio は無い。置き場所の計算（build）はそのまま使い、
 * 描くところだけを差し替える。箱の中身は HTML なので、foreignObject に入れる。
 * 押したときの飛び先は data-jump に残す（配った先でも書き起こしへ飛べる）。
 */
export function svg(tree) {
  const root = build(tree);
  let W = 0, H = 0;
  const all = [];
  const walk = (n, parent) => {
    all.push({ n, parent });
    W = Math.max(W, COL[n.col].x + n.w);
    H = Math.max(H, n.y + n.h);
    for (const c of n.children) walk(c, n);
  };
  walk(root, null);

  const PADDING = 24;
  const parts = [];
  // 枝。親の右の真ん中から、子の左の真ん中へ
  for (const { n, parent } of all) {
    if (!parent) continue;
    const x1 = COL[parent.col].x + parent.w, y1 = parent.y + parent.h / 2;
    const x2 = COL[n.col].x, y2 = n.y + n.h / 2;
    const mid = (x1 + x2) / 2;
    parts.push(`<path d="M${x1} ${y1}C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" fill="none" stroke="#B3B3B3" stroke-width="1.5"/>`);
  }
  // 箱
  for (const { n } of all) {
    const st = styleOf(n.style);
    const x = COL[n.col].x;
    parts.push(`<g class="bx${n.jump ? ' tap' : ''}"${n.jump ? ` data-jump="${attr(n.jump)}" tabindex="0" role="button"` : ''}>`
      + `<rect x="${x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${st.sw}"${st.dash ? ' stroke-dasharray="5 4"' : ''}/>`
      + `<foreignObject x="${x + 10}" y="${n.y + 7}" width="${n.w - 20}" height="${n.h - 12}">`
      + `<div xmlns="http://www.w3.org/1999/xhtml" style="font:${st.fw} ${st.fs}px/1.5 'Noto Sans JP',system-ui,sans-serif;color:${st.color};text-align:${st.align};height:100%;display:flex;flex-direction:column;justify-content:${st.align === 'center' ? 'center' : 'flex-start'}">`
      + `<div>${n.label}</div></div></foreignObject></g>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-PADDING} ${-PADDING} ${W + PADDING * 2} ${H + PADDING * 2}" `
    + `width="${W + PADDING * 2}" height="${H + PADDING * 2}" font-family="'Noto Sans JP',system-ui,sans-serif">${parts.join('')}</svg>`;
}

/** drawio の書き方の文字列から、SVG に要る色と字だけを読み取る */
function styleOf(style) {
  const get = (k, d) => (new RegExp(`${k}=([^;]+)`).exec(style) || [, d])[1];
  const fill = get('fillColor', '#FFFFFF');
  return {
    fill: fill === 'none' ? 'transparent' : fill,
    stroke: get('strokeColor', 'none') === 'none' ? 'transparent' : get('strokeColor', '#CCCCCC'),
    sw: /strokeWidth=3/.test(style) ? 3 : 1,
    dash: /dashed=1/.test(style),
    color: get('fontColor', '#1A1A1A'),
    fs: Number(get('fontSize', '12')),
    fw: /fontStyle=1/.test(style) ? 700 : 400,
    align: get('align', 'left'),
  };
}
