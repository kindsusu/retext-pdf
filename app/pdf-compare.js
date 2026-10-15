// v6 Wave D: 두 문서 비교 — 순수 계산(엔진·파일을 만지지 않는다). 서버가 두 문서의 쪽마다 objects()를 넘긴다.
//   · 단위: 'word'(낱말) · 'line'(줄) · 'paragraph'(문단). 읽기 순서는 text-grouping.js(groupLines·groupParagraphs)
//   · 차이: 토큰 글자(공백을 하나로 줄인 것)의 최장 공통 부분열(Myers 차분). 낱말 단위는 먼저 줄로 맞춘 뒤 달라진 줄 묶음 안에서만 낱말을 비교한다
//     (문서 전체를 낱말로 한 번에 비교하면 수만 낱말에서 느려진다)
//   · 결과: [{ kind:'insert'|'delete'|'change', a:{ text, page, rects }, b:{ text, page, rects } }] — 지운 것(빨강)은 a(왼쪽 원본)에만, 넣은 것(초록)은 b에만,
//     바뀐 것(노랑)은 양쪽에. 한쪽에 없는 차이는 그쪽의 가까운 자리(anchor: 앞 토큰)를 rects 없이 page로 준다(목록에서 눌렀을 때 함께 스크롤)
(function () {
  const TG = typeof module !== 'undefined' && typeof require === 'function' ? require('./text-grouping') : window;
  const { groupLines, groupParagraphs } = TG;
  const norm = (s) => String(s || '').replace(/­/g, '').replace(/\s+/g, ' ').trim();

  // 글자마다 사각형(회전 전 쪽 좌표 [l,b,r,t]). 객체 glyphs([x, y, 진행 폭])가 글자 수와 맞으면 글자 단위, 아니면 객체 상자
  function charRects(o) {
    const t = o.text || '', sz = (o.scaledSize != null ? o.scaledSize : o.size) || 10;
    const flat = !o.matrix || Math.abs(o.matrix[1]) < 0.01 * Math.abs(o.matrix[0] || 1);
    if (flat && Array.isArray(o.glyphs) && o.glyphs.length === t.length) return o.glyphs.map(([x, y, w]) => [x, y - 0.22 * sz, x + Math.max(w, 0.2 * sz), y + 0.85 * sz]);
    const b = o.bounds; return [...t].map(() => [b.x0, b.y0, b.x1, b.y1]);
  }
  const union = (rs) => { const v = rs.filter(Boolean); return v.length ? [Math.min(...v.map((r) => r[0])), Math.min(...v.map((r) => r[1])), Math.max(...v.map((r) => r[2])), Math.max(...v.map((r) => r[3]))] : null; };
  const r2 = (r) => r.map((v) => Math.round(v * 100) / 100);

  // 쪽들 → 줄 목록 [{ page, text, chars:[{ ch, rect }] }] (읽기 순서)
  function docLines(pages) {
    const out = [];
    pages.forEach((pg, page) => {
      const objs = (pg.objs || []).filter((o) => !o.watermark);
      for (const box of groupLines(objs, { mergeStyledRuns: true })) {
        const chars = [];
        box.objs.forEach((o, j) => {
          if (j) for (const ch of box.seps[j - 1] || '') chars.push({ ch, rect: null });
          const rs = charRects(o);
          [...(o.text || '')].forEach((ch, k) => chars.push({ ch, rect: rs[k] || null }));
        });
        out.push({ page, box, text: norm(chars.map((c) => c.ch).join('')), chars });
      }
    });
    return out;
  }
  // 줄 → 낱말 토큰 [{ text, page, rects:[rect] }]
  function lineWords(line) {
    const toks = [];
    let cur = null;
    for (const c of line.chars) {
      if (/\s/.test(c.ch) || c.ch === '­') { if (cur) { toks.push(cur); cur = null; } continue; }
      if (!cur) cur = { text: '', page: line.page, rs: [] };
      cur.text += c.ch; cur.rs.push(c.rect);
    }
    if (cur) toks.push(cur);
    return toks.map((t) => ({ text: t.text, page: t.page, rects: [union(t.rs)].filter(Boolean).map(r2) }));
  }
  function tokens(pages, unit) {
    const lines = docLines(pages);
    if (unit === 'line') return lines.map((l) => ({ text: l.text, page: l.page, rects: [r2([l.box.bounds.x0, l.box.bounds.y0, l.box.bounds.x1, l.box.bounds.y1])] })).filter((t) => t.text);
    if (unit === 'paragraph') {
      const out = [];
      pages.forEach((pg, page) => {
        const objs = (pg.objs || []).filter((o) => !o.watermark);
        for (const para of groupParagraphs(groupLines(objs, { mergeStyledRuns: true }))) {
          const text = norm(para.text);
          if (text) out.push({ text, page, rects: para.boxes.map((b) => r2([b.bounds.x0, b.bounds.y0, b.bounds.x1, b.bounds.y1])) });
        }
      });
      return out;
    }
    return lines;
  }

  // Myers 차분: a·b(글 배열) → [{ op:'eq'|'del'|'ins', a, b }](각 한 칸). maxD를 넘으면 null(호출자가 통째로 바뀐 것으로 본다)
  function myers(a, b, maxD = 4000) {
    const n = a.length, m = b.length, max = n + m, off = max + 1;
    let v = new Int32Array(2 * max + 3);
    const trace = [];
    for (let d = 0; d <= Math.min(max, maxD); d++) {
      trace.push(v.slice(off - d - 1, off + d + 2)); // v[-d-1 .. d+1]
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) return backtrack(trace, a, b, d);
      }
    }
    return null;
  }
  function backtrack(trace, a, b, D) {
    const ops = [];
    let x = a.length, y = b.length;
    for (let d = D; d > 0; d--) {
      const vv = trace[d], get = (k) => vv[k + d + 1]; // trace[d]는 v[-d-1 .. d+1] — d번째 단계에 들어가기 전 값
      const k = x - y;
      const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
      const prevX = get(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { ops.push({ op: 'eq', a: --x, b: --y }); }
      if (x === prevX) ops.push({ op: 'ins', b: --y }); else ops.push({ op: 'del', a: --x });
    }
    while (x > 0 && y > 0) ops.push({ op: 'eq', a: --x, b: --y });
    return ops.reverse();
  }
  // 차분 결과를 덩어리(hunk)로: [{ eq:true, a0,a1,b0,b1 } | { eq:false, a0,a1,b0,b1 }]
  function hunks(a, b, maxD) {
    let ops = myers(a, b, maxD);
    if (!ops) { // 너무 다르다: 앞뒤 같은 부분만 맞추고 가운데는 통째로 바뀐 것으로
      let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
      let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
      ops = [];
      for (let k = 0; k < s; k++) ops.push({ op: 'eq', a: k, b: k });
      for (let k = s; k < a.length - e; k++) ops.push({ op: 'del', a: k });
      for (let k = s; k < b.length - e; k++) ops.push({ op: 'ins', b: k });
      for (let k = e; k > 0; k--) ops.push({ op: 'eq', a: a.length - k, b: b.length - k });
    }
    const out = [];
    let x = 0, y = 0;
    for (const o of ops) {
      const eq = o.op === 'eq';
      let h = out[out.length - 1];
      if (!h || h.eq !== eq) { h = { eq, a0: x, a1: x, b0: y, b1: y }; out.push(h); }
      if (o.op !== 'ins') { x++; h.a1 = x; }
      if (o.op !== 'del') { y++; h.b1 = y; }
    }
    return out;
  }
  // 한쪽에 없는 차이의 자리: 바로 앞 토큰(없으면 다음 토큰)의 쪽
  const anchor = (toks, at) => { const t = toks[Math.max(0, Math.min(toks.length - 1, at - 1))]; return t ? { page: t.page, rects: [], anchor: t.rects[0] || null } : { page: 0, rects: [] }; };
  const side = (toks, i0, i1) => {
    if (i1 <= i0) return null;
    const list = toks.slice(i0, i1), page = list[0].page;
    return { text: list.map((t) => t.text).join(' '), page, rects: list.flatMap((t) => t.rects.map((r) => ({ page: t.page, rect: r }))) };
  };
  function diffTokens(A, B, maxD) {
    const out = [];
    for (const h of hunks(A.map((t) => t.text), B.map((t) => t.text), maxD)) {
      if (h.eq) continue;
      const a = side(A, h.a0, h.a1), b = side(B, h.b0, h.b1);
      out.push({ kind: a && b ? 'change' : a ? 'delete' : 'insert', a: a || anchor(A, h.a0), b: b || anchor(B, h.b0) });
    }
    return out;
  }

  // 두 문서 비교. pagesA·pagesB: [{ objs }] · unit: 'word'(기본)|'line'|'paragraph' · limit: 차이 개수 상한(기본 2000)
  // 반환 { diffs, stats:{ insert, delete, change }, truncated, tokens:{ a, b } }
  function compare(pagesA, pagesB, { unit = 'word', limit = 2000 } = {}) {
    if (!['word', 'line', 'paragraph'].includes(unit)) throw Object.assign(new Error(`알 수 없는 비교 단위입니다: ${unit}`), { status: 400 });
    let diffs = [], countA = 0, countB = 0;
    if (unit === 'word') {
      const LA = tokens(pagesA, 'raw'), LB = tokens(pagesB, 'raw');
      for (const h of hunks(LA.map((l) => l.text), LB.map((l) => l.text), 4000)) {
        const wa = LA.slice(h.a0, h.a1).flatMap(lineWords), wb = LB.slice(h.b0, h.b1).flatMap(lineWords);
        countA += wa.length; countB += wb.length;
        if (h.eq) continue;
        // 한쪽이 비면 다른 쪽 자리는 그 덩어리 앞 줄
        if (!wa.length || !wb.length) {
          const prevA = LA[h.a0 - 1] || LA[h.a1], prevB = LB[h.b0 - 1] || LB[h.b1];
          const empty = (l) => (l ? { page: l.page, rects: [], anchor: r2([l.box.bounds.x0, l.box.bounds.y0, l.box.bounds.x1, l.box.bounds.y1]) } : { page: 0, rects: [] });
          if (wa.length) diffs.push({ kind: 'delete', a: side(wa, 0, wa.length), b: empty(prevB) });
          else if (wb.length) diffs.push({ kind: 'insert', a: empty(prevA), b: side(wb, 0, wb.length) });
          continue;
        }
        diffs.push(...diffTokens(wa, wb, 2000));
      }
    } else {
      const A = tokens(pagesA, unit), B = tokens(pagesB, unit);
      countA = A.length; countB = B.length;
      diffs = diffTokens(A, B, 4000);
    }
    const truncated = diffs.length > limit;
    if (truncated) diffs = diffs.slice(0, limit);
    diffs.forEach((d, k) => { d.id = k; });
    const stats = { insert: 0, delete: 0, change: 0 };
    for (const d of diffs) stats[d.kind]++;
    return { diffs, stats, truncated, tokens: { a: countA, b: countB } };
  }

  const api = { compare, myers, hunks, tokens, docLines, lineWords };
  if (typeof module !== 'undefined') module.exports = api;
})();
