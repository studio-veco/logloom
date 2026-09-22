// 会議を木にする。
//
//   会議 ─ 議題 ─ 論点 ─ 要約（終点）
//                      ├ 決まったこと
//                      └ やること
//
// **終点には発言をそのまま置かない。**逐語は別の欄（書き起こし）で読める。
// 木の終点は「その論点で何が話されたか」をまとめた文章にする。そうしないと、
// 枝の先が発言の数だけ増えて、地図として読めなくなる。
//
// 置き場所を決めるのは Jev。見出しと要約を書くのは手元の Claude。
// **どちらが欠けても議事録は止めない。**Jev が無ければ一定の発言数で枝を切り、
// Claude が無ければ lib/youyaku.mjs が発言の言葉だけで見出しと要約を作る。
// **書き起こしそのものは、どちらも通らない。**

import * as jev from './jev.mjs';
import * as ai from './ai.mjs';
import * as kotoba from './kotoba.mjs';

let seq = 0;
const nid = (p) => `${p}${(++seq).toString(36)}`;

/** 2つの文の、違うところだけを取り出す（前後の同じ部分を落とす） */
function diff(a, b) {
  const A = [...String(a)], B = [...String(b)];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  return { from: A.slice(s, A.length - e).join(''), to: B.slice(s, B.length - e).join('') };
}

/**
 * 同じことを言っているか。**句読点と空白を落としてから比べる。**
 * 聞き取りは同じ音でも読点の打ち方が変わるので、そこで違う文に見えてしまう。
 */
function samish(a, b) {
  const norm = (x) => String(x).replace(/[、。，．,.\s！？!?「」『』]/g, '');
  const A = norm(a), B = norm(b);
  if (!A || !B) return 0;
  const [long, short] = A.length >= B.length ? [A, B] : [B, A];
  if (short.length < 6) return long === short ? 1 : 0;
  if (long.includes(short)) return 1;                       // 片方がもう片方を丸ごと含む
  // 6文字の窓で、いくつ重なるか
  let hit = 0, n = 0;
  for (let i = 0; i + 6 <= short.length; i += 2) { n += 1; if (long.includes(short.slice(i, i + 6))) hit += 1; }
  return n ? hit / n : 0;
}

/** これ以上そっくりなら、同じ声が2つの入口から入ったと見なす */
const SAME = 0.72;
/** 何秒の間を見るか。スピーカーから耳に届くまでの遅れを見込む */
const SAME_MS = 20000;

/** Jev が無いときに枝を切る発言数 */
const BLIND_POINT = 6;
/** 要約を作り直すまでに貯める発言数 */
const SUMMARY_EVERY = 3;
/** 見出しを付けるのに読む発言数 */
const NAME_LINES = 4;
/** これだけ黙ったら、いまの論点をまとめる */
const IDLE_MS = 45000;

export class Kaigi {
  constructor({ title = '', onChange = () => {} } = {}) {
    this.title = title || '会議';
    this.titleFixed = !!title;
    this.agendas = [];
    this.log = [];
    this.cursor = { agendaId: null, pointId: null };
    this.onChange = onChange;
    this.queue = Promise.resolve();
    this.startedAt = Date.now();
    this.naming = new Set();
    this.summarizing = new Set();
    this.drawing = new Set();
    this.blind = 0;
    // **最後の論点にも要約を付ける。**
    // 要約は「発言が3つ貯まったら」と「次の話題に移ったら」で作っていたので、
    // 会議の終わりの論点だけ、どちらも起きずに「要約を書いています」のまま残った
    this.idle = null;
  }

  /** しばらく黙ったら、いまの論点をまとめる */
  armIdle(ms = IDLE_MS) {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      const p = this.point(this.cursor.pointId);
      if (!p) return;
      this.nameLater(p, true);
      if (p.utterances.length > p.summaryAt) this.summarizeLater(p, true);
    }, ms);
    this.idle.unref?.();
  }

  /** 会議を閉じる。**まだ要約の付いていない論点を、全部まとめる** */
  finish() {
    clearTimeout(this.idle);
    let n = 0;
    for (const a of this.agendas) {
      for (const p of a.points) {
        if (!p.utterances.length) continue;
        this.nameLater(p, true);
        if (p.utterances.length > p.summaryAt) { this.summarizeLater(p, true); n += 1; }
      }
    }
    return n;
  }

  // ---- 取り込み口 ----------------------------------------------------------

  /** 発言を1つ受ける。**順番を崩さないため、1件ずつ順に処理する。** */
  add(raw, { at = Date.now(), ms = 0, who = '' } = {}) {
    this.queue = this.queue.then(() => this.ingest(raw, { at, ms, who })).catch((e) => {
      this.emit({ kind: 'error', text: String(e.message || e) });
    });
    return this.queue;
  }

  async ingest(raw, { at, ms, who = '' }) {
    const text0 = String(raw || '').trim();
    if (!text0) return null;

    // 1. 話し言葉を整える → 2. 辞書の正誤表 → 3. 書き方を辞書に寄せる
    const cleaned = kotoba.clean(text0);
    if (!cleaned || kotoba.isNoise(cleaned)) {
      this.log.push({ id: nid('u'), at, ms, who, raw: text0, text: cleaned, noise: true, fixes: [] });
      this.emit({ kind: 'noise' });
      return null;
    }
    let text = kotoba.fixCasing(kotoba.fixByDict(cleaned));
    const fixes = [];
    // **直したところだけを見せる。**文まるごとを並べると、どこが変わったのか読めない
    if (text !== cleaned) fixes.push({ by: '辞書', ...diff(cleaned, text) });

    // 4. 辞書に**無い**誤りは、読みの近い語を探して Jev に決めてもらう
    const guessed = await this.guessTypos(text);
    for (const g of guessed) {
      if (!text.includes(g.found)) continue;
      text = text.split(g.found).join(g.correct);
      fixes.push({ by: `Jev ${g.p}`, from: g.found, to: g.correct });
    }

    // **同じ声を2度入れない。**
    // スピーカーで会議をしていると、相手の声はこの Mac の音としても、
    // マイクに回り込んだ音としても入ってくる。イヤホンなら起きないが、
    // 起きたときに同じ発言が2つ並ぶと、木も要約も二重になる。
    const twin = this.twinOf(text, who, at);
    if (twin) {
      // 残すのは**会議の音のほう**。マイクに回り込んだ音より綴りが崩れていない
      if (who === '相手' && twin.who !== '相手') {
        twin.text = text;
        twin.who = '相手';
        twin.fixes = fixes;
        this.emit({ kind: 'merged', id: twin.id });
      } else {
        this.emit({ kind: 'duplicate', id: twin.id });
      }
      return twin;
    }

    const u = { id: nid('u'), at, ms, who, raw: text0, text, fixes, noise: false, pointId: null, marks: null };
    this.log.push(u);
    this.emit({ kind: 'utterance', id: u.id });

    // 5. どの枝に置くか
    const where = await this.route(text);
    const point = this.place(where, u);
    u.pointId = point.id;
    point.utterances.push(u);
    point.touchedAt = at;
    this.emit({ kind: 'placed', id: u.id, pointId: point.id });

    // 6. 決まったこと・やること・課題の印（待たない）
    this.markLater(u);
    // 7. 見出しと要約（待たない）
    this.nameLater(point);
    this.summarizeLater(point);
    this.armIdle();
    return u;
  }

  /** 直前の数十秒に、別の入口から入った同じ発言があるか */
  twinOf(text, who, at) {
    if (!who) return null;
    for (let i = this.log.length - 1; i >= 0; i--) {
      const l = this.log[i];
      if (at - l.at > SAME_MS) break;
      if (l.noise || !l.who || l.who === who) continue;
      if (samish(l.text, text) >= SAME) return l;
    }
    return null;
  }

  // ---- 誤字 ----------------------------------------------------------------

  /**
   * 辞書に載っていない誤りを拾う。**直さない。候補を出して Jev に決めてもらう。**
   *
   * 2つの探し方を並べる。
   *   1. 同じ会議の中で、読みが近くてもっと多く出ている語（共通辞書の道具（terms.suspects））
   *   2. 辞書の語と読みを直に比べる（lib/yomimatch）
   *
   * 1 だけでは、会議が始まったばかりで比べる相手が居ないときに何も出ない。
   * 2 だけでは、その会議でしか使わない言葉（人名・社名）を拾えない。
   */
  async guessTypos(text) {
    const recent = this.log.slice(-12).map((l) => l.text).filter(Boolean);
    const cands = new Map();
    try {
      const s = await kotoba.suspects([...recent, text]);
      for (const x of s) {
        if (!x.like || x.like.score < 0.75 || !text.includes(x.word)) continue;
        cands.set(x.word, { found: x.word, correct: x.like.word, text, by: '会議の中' });
      }
    } catch { /* 次の探し方へ */ }
    try {
      for (const c of await kotoba.dictCandidates(text)) {
        if (!cands.has(c.found)) cands.set(c.found, { ...c, text, by: '辞書の読み' });
      }
    } catch { /* 読みが引けない機械でも進む */ }

    const list = [...cands.values()];
    if (!list.length || !jev.available()) return [];
    try {
      const judged = await jev.judgeTypos(list, { about: this.title });
      return judged.filter((j) => j.p != null && j.p >= jev.FIX);
    } catch { return []; }
  }

  // ---- 枝分け --------------------------------------------------------------

  async route(text) {
    const current = this.point(this.cursor.pointId);
    const others = this.recentPoints().filter((p) => p.id !== current?.id);
    // **議題は「いまの議題」だけでなく、前に出たものも見る。**
    // いまの議題しか見ていなかったとき、「展示会の話に戻るんですけど」が
    // 5つめの議題になり、同じ会議に「展示会」が2本できた
    const agendas = [...this.agendas].reverse().filter((a) => a.points.some((p) => p.utterances.length));

    if (!jev.available()) {
      // Jev が無いときは、一定の発言数でしか切れない。**そう書いて出す。**
      this.blind += 1;
      if (!current) return { kind: 'newAgenda', off: true };
      if (this.blind % BLIND_POINT === 0) return { kind: 'newPoint', off: true };
      return { kind: 'stay', pointId: current.id, off: true };
    }
    try {
      return await jev.route(text, {
        current: current && {
          id: current.id, name: current.name || this.recentText(current, 1),
          agendaId: current.agendaId, recent: this.recentText(current),
        },
        others: others.map((p) => ({ id: p.id, name: p.name || this.recentText(p, 1), recent: this.recentText(p) })),
        agendas: agendas.map((a) => ({ id: a.id, name: a.name || this.agendaGist(a) })),
        about: this.title,
      });
    } catch (e) {
      this.emit({ kind: 'error', text: `Jev：${e.message}` });
      return current ? { kind: 'stay', pointId: current.id } : { kind: 'newAgenda' };
    }
  }

  /** 見出しがまだ付いていない議題を、Jev に伝えるための言い方 */
  agendaGist(a) {
    return a.points.flatMap((p) => p.utterances).slice(0, 3).map((u) => u.text).join(' ').slice(0, 160);
  }

  place(where, u) {
    if (where.kind === 'stay' || where.kind === 'return') {
      const p = this.point(where.pointId);
      if (p) {
        const prev = this.cursor.pointId;
        this.cursor = { agendaId: p.agendaId, pointId: p.id };
        if (where.kind === 'return' && prev !== p.id) {
          const back = this.point(prev);
          if (back) this.summarizeLater(back, true);
        }
        return p;
      }
    }
    const prev = this.point(this.cursor.pointId);
    if (where.kind === 'newPoint') {
      const a = this.agendas.find((x) => x.id === where.agendaId)
        || this.agendas.find((x) => x.id === this.cursor.agendaId)
        || this.newAgenda();
      if (prev) this.summarizeLater(prev, true);
      this.cursor.agendaId = a.id;
      return this.newPoint(a);
    }
    if (prev) this.summarizeLater(prev, true);
    return this.newPoint(this.newAgenda());
  }

  newAgenda() {
    const a = { id: nid('a'), name: '', named: false, by: null, mark: null, points: [], at: Date.now() };
    this.agendas.push(a);
    this.cursor.agendaId = a.id;
    this.emit({ kind: 'agenda', id: a.id });
    return a;
  }

  newPoint(agenda) {
    const p = { id: nid('p'), agendaId: agenda.id, name: '', named: false, by: null, utterances: [],
      summary: '', summaryBy: null, summaryAt: 0, decisions: [], actions: [], issues: [], at: Date.now(), touchedAt: Date.now() };
    agenda.points.push(p);
    this.cursor = { agendaId: agenda.id, pointId: p.id };
    this.emit({ kind: 'point', id: p.id });
    return p;
  }

  point(id) {
    if (!id) return null;
    for (const a of this.agendas) for (const p of a.points) if (p.id === id) return p;
    return null;
  }

  /** 前に出た論点のうち、話が戻りやすい直近のもの */
  recentPoints(n = 5) {
    const all = [];
    for (const a of this.agendas) for (const p of a.points) if (p.utterances.length) all.push(p);
    return all.sort((x, y) => y.touchedAt - x.touchedAt).slice(0, n);
  }

  recentText(p, n = 4) {
    return p.utterances.slice(-n).map((u) => u.text).join(' ');
  }

  // ---- 見出しと要約（待たない） ---------------------------------------------

  /**
   * 見出しは発言が2つ貯まってから付ける（1つでは何の話か決まらない）。
   * **ただし会議の終わりだけは、1つでも付ける。**そうしないと、最後の論点が
   * 「（見出しを付けています）」のまま地図に残る
   */
  nameLater(point, force = false) {
    const need = force ? 1 : 2;
    const agenda = this.agendas.find((a) => a.id === point.agendaId);
    if (agenda && !agenda.named && agenda.points.reduce((n, p) => n + p.utterances.length, 0) >= need
      && !this.naming.has(agenda.id)) {
      this.naming.add(agenda.id);
      const lines = agenda.points.flatMap((p) => p.utterances).slice(0, NAME_LINES).map((u) => u.text);
      ai.nameBranch(lines, { kind: '議題' }).then((r) => {
        agenda.name = r.name; agenda.named = true; agenda.by = r.by;
        this.naming.delete(agenda.id);
        this.emit({ kind: 'named', id: agenda.id });
        // 議題の名が決まってから絵を頼む。名前が無いと、何の絵か決まらない
        this.drawLater(agenda, lines);
      });
    }
    if (!point.named && point.utterances.length >= need && !this.naming.has(point.id)) {
      this.naming.add(point.id);
      const lines = point.utterances.slice(0, NAME_LINES).map((u) => u.text);
      ai.nameBranch(lines, { kind: '論点', parent: agenda?.name || '' }).then((r) => {
        point.name = r.name; point.named = true; point.by = r.by;
        this.naming.delete(point.id);
        this.emit({ kind: 'named', id: point.id });
      });
    }
    if (!this.titleFixed && this.log.filter((l) => !l.noise).length >= (force ? 1 : 4) && !this.naming.has('title')) {
      this.naming.add('title');
      ai.nameMeeting(this.log.filter((l) => !l.noise).slice(0, 6).map((l) => l.text)).then((r) => {
        this.title = r.name; this.titleFixed = true;
        this.emit({ kind: 'named', id: 'title' });
      });
    }
  }

  /** 議題の絵（Codex のときだけ）。待たない。返ってきたら地図に出す */
  drawLater(agenda, lines) {
    if (!ai.drawing() || agenda.mark || this.drawing.has(agenda.id)) return;
    this.drawing.add(agenda.id);
    ai.drawMark(agenda.name, lines).then((svg) => {
      this.drawing.delete(agenda.id);
      if (!svg) return;
      agenda.mark = svg;
      this.emit({ kind: 'mark', id: agenda.id });
    }).catch(() => { this.drawing.delete(agenda.id); });
  }

  summarizeLater(point, force = false) {
    const since = point.utterances.length - point.summaryAt;
    if (!point.utterances.length) return;
    if (!force && since < SUMMARY_EVERY) return;
    if (this.summarizing.has(point.id)) return;
    this.summarizing.add(point.id);
    const n = point.utterances.length;
    const lines = point.utterances.map((u) => u.text);
    ai.summarize(point.name || 'この話題', lines).then((r) => {
      point.summary = r.text;
      point.summaryBy = r.by;
      point.summaryAt = n;
      this.summarizing.delete(point.id);
      this.emit({ kind: 'summary', id: point.id });
      // まとめている間に増えていたら、もう一度
      if (point.utterances.length - point.summaryAt >= SUMMARY_EVERY) this.summarizeLater(point);
    });
  }

  markLater(u) {
    if (!jev.available()) return;
    jev.mark(u.text, { about: this.title }).then((m) => {
      u.marks = m;
      const p = this.point(u.pointId);
      if (!p || !m.top) return;
      // **一番強い1つだけ。**3つとも付けると、同じ文が3つの箱に並んで地図が読めない
      ({ decision: p.decisions, action: p.actions, issue: p.issues })[m.top].push(u.id);
      this.emit({ kind: 'marked', id: u.id, pointId: p.id });
    }).catch(() => {});
  }

  // ---- 外へ ----------------------------------------------------------------

  emit(ev) { try { this.onChange(ev); } catch { /* 受け手が居なくても続ける */ } }

  textOf(id) { return this.log.find((l) => l.id === id)?.text || ''; }

  /** 画面と drawio が読む形 */
  tree() {
    return {
      title: this.title,
      startedAt: this.startedAt,
      agendas: this.agendas.map((a) => ({
        id: a.id,
        name: a.name || '（見出しを付けています）',
        named: a.named,
        by: a.by || null,
        mark: a.mark || null,
        points: a.points.map((p) => ({
          id: p.id,
          name: p.name || '（見出しを付けています）',
          named: p.named,
          by: p.by || null,
          count: p.utterances.length,
          summary: p.summary,
          summaryBy: p.summaryBy || null,
          fresh: p.utterances.length > p.summaryAt,
          decisions: p.decisions.map((i) => this.textOf(i)).filter(Boolean),
          actions: p.actions.map((i) => this.textOf(i)).filter(Boolean),
          issues: p.issues.map((i) => this.textOf(i)).filter(Boolean),
          cursor: p.id === this.cursor.pointId,
        })),
      })),
    };
  }

  transcript() {
    return this.log.filter((l) => !l.noise).map((l) => ({
      id: l.id, at: l.at, who: l.who || '', text: l.text, raw: l.raw, fixes: l.fixes, pointId: l.pointId,
      marks: l.marks,
    }));
  }

  /** 議事録（テキスト）。会議が終わったら、これをそのまま配れる */
  markdown() {
    const out = [`# ${this.title}`, ''];
    const d = new Date(this.startedAt);
    out.push(`${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 開始`, '');
    const allDec = [], allAct = [], allIss = [];
    for (const a of this.agendas) {
      out.push(`## ${a.name || '（見出しなし）'}`, '');
      for (const p of a.points) {
        out.push(`### ${p.name || '（見出しなし）'}`, '');
        if (p.summary) out.push(p.summary, '');
        if (p.decisions.length) {
          out.push('決まったこと', '');
          for (const i of p.decisions) { out.push(`- ${this.textOf(i)}`); allDec.push(this.textOf(i)); }
          out.push('');
        }
        if (p.actions.length) {
          out.push('やること', '');
          for (const i of p.actions) { out.push(`- ${this.textOf(i)}`); allAct.push(this.textOf(i)); }
          out.push('');
        }
        if (p.issues.length) {
          out.push('残った課題', '');
          for (const i of p.issues) { out.push(`- ${this.textOf(i)}`); allIss.push(this.textOf(i)); }
          out.push('');
        }
      }
    }
    out.push('## 書き起こし', '');
    for (const l of this.transcript()) {
      const t = new Date(l.at);
      const hhmmss = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      out.push(`${hhmmss}　${l.who ? `[${l.who}] ` : ''}${l.text}`);
    }
    return out.join('\n');
  }
}
