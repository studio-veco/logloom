// 木を drawio（mxGraph）の XML にする。
//
// drawio に置き場所を任せると、描き直すたびに枝が飛ぶ。会議の途中で地図が動くと、
// さっきまで見ていた枝を目で追えなくなるので、**座標はこちらで決める。**
// 決め方は素直な木の並べ方で、終点から順に縦に積み、親は子の真ん中に置く。
// 枝は増えるだけなので、前に置いた枝の場所は動かない。
//
// 箱の高さは中の字数から出す。drawio は字を折り返すが、高さは自動で伸びない。
// 出す文字を数えて、ここで高さを決める。

const COL = [
  { x: 0, w: 210 },      // 会議
  { x: 310, w: 210 },    // 議題
  { x: 620, w: 220 },    // 論点
  { x: 940, w: 320 },    // 終点（要約・決まったこと・やること・課題）
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
    // 議題の絵（Codex が描いたもの）。名前の上に置く
    const pic = a.mark
      ? `<img src="data:image/svg+xml;base64,${Buffer.from(a.mark.replace(/currentColor/g, '#FFFFFF'), 'utf8').toString('base64')}" width="26" height="26"><br>`
      : '';
    const an = node(a.id, pic + esc(a.name), a.named ? STYLE.agenda : STYLE.agenda + 'dashed=1;', 1, 14, a.mark ? 74 : 48);
    root.children.push(an);

    for (const p of a.points) {
      const label = `${esc(p.name)}<br><font color="${p.cursor ? '#D9E6FF' : '#666666'}" style="font-size:10px">発言 ${p.count}</font>`;
      const pn = node(p.id, label, p.cursor ? STYLE.pointNow : (p.named ? STYLE.point : STYLE.point + 'dashed=1;'), 2, 13, 48);
      an.children.push(pn);

      // 終点。**要約が来るまでは、来ていないと分かる形で置く**
      if (p.summary) {
        const fresh = p.fresh ? '<br><font color="#666666" style="font-size:10px">この後の発言はまだ入っていません</font>' : '';
        const by = p.summaryBy === 'words' ? '<br><font color="#767676" style="font-size:10px">発言の言葉から</font>' : '';
        pn.children.push(node(`${p.id}_s`, MARK.summary() + esc(p.summary) + fresh + by, STYLE.summary, 3, 12, 56));
      } else {
        pn.children.push(node(`${p.id}_s`, `${MARK.waiting()}要約を書いています`, STYLE.waiting, 3, 12, 44));
      }
      if (p.decisions.length) {
        pn.children.push(node(`${p.id}_d`,
          `${MARK.decision()}<b>決まったこと</b><br>${p.decisions.map((t) => `・${esc(t)}`).join('<br>')}`,
          STYLE.decision, 3, 12, 48));
      }
      if (p.actions.length) {
        pn.children.push(node(`${p.id}_a`,
          `${MARK.action()}<b>やること</b><br>${p.actions.map((t) => `・${esc(t)}`).join('<br>')}`,
          STYLE.action, 3, 12, 48));
      }
      if (p.issues.length) {
        pn.children.push(node(`${p.id}_i`,
          `${MARK.issue()}<b>残った課題</b><br>${p.issues.map((t) => `・${esc(t)}`).join('<br>')}`,
          STYLE.issue, 3, 12, 48));
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
    cells.push(`<mxCell id="${n.id}" value="${attr(n.label)}" style="${n.style}" vertex="1" parent="1">`
      + `<mxGeometry x="${COL[n.col].x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`);
    if (parent) {
      cells.push(`<mxCell id="e_${parent.id}_${n.id}" style="${EDGE}" edge="1" parent="1" `
        + `source="${parent.id}" target="${n.id}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
    }
    for (const c of n.children) walk(c, n);
  };
  walk(root, null);
  return '<mxfile host="LOGLOOM" type="device">'
    + `<diagram id="logloom" name="${attr(name)}">`
    + '<mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" '
    + 'arrows="1" fold="1" page="0" pageScale="1" pageWidth="1169" pageHeight="826" math="0" shadow="0" '
    + 'background="#FFFFFF">'
    + `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root>`
    + '</mxGraphModel></diagram></mxfile>';
}
