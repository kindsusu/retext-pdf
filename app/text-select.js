// v6 Wave F 글자 선택·복사의 순수 계산 — DOM·서버를 만지지 않는다. 화면(window.textSelect)과 Node 시험이 같이 쓴다.
// 쪽의 줄(groupLines mergeStyledRuns — 화면 상자와 같은 줄, 읽기 순서: 단 왼→오른쪽, 단 안에서 위→아래)을 글자 칸의 한 줄 흐름으로 편다.
//   · 글자 칸: 엔진 objects()의 글자 자리(glyphs: 기준선 시작점 x·y와 글자 방향 진행 폭 — 텍스트 페이지 글자 순서) + 글자 크기로 만든 네모(쪽 좌표).
//     글자 방향(텍스트 행렬의 회전)을 따르므로 돌린 글자·돌린 쪽에서도 맞다(쪽 회전은 화면이 pdfPtToScreen으로 바꾼다)
//   · 조각 사이 글(seps — 낱말 사이 띄어쓰기 ' ', 가린 자리 ■)은 앞뒤 글자 사이 자리를 나눠 가진 칸(idx 없음)
//   · 고른 범위 = 칸 경계 [a, b). 글로 옮길 때 줄 사이는 줄바꿈, 줄 끝 하이픈(영문 낱말-)·소프트 하이픈은 다음 줄 소문자와 이어 붙인다
//   · 고른 범위의 줄마다 네모(돌린 글자면 기울어진 네모) — 화면 칠하기·형광펜 quads, 객체 글 범위 — 가리기(/api/pdf/mask parts)
(function () {
  const SHY = '\u00AD';
  const ASC = 0.88, DESC = 0.24; // 글자 칸 높이: 기준선 위 0.88em · 아래 0.24em(한글 글꼴의 올림·내림과 비슷)
  const isWordCh = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);

  // 객체 하나의 글자 칸들: [{ ch, pos, p:[[x,y]×4](왼아래·오른아래·오른위·왼위), dir:[cos,sin] }]
  function objCells(o) {
    const text = String(o.text || ''), n = text.length, size = o.scaledSize || o.size || Math.max(1, (o.bounds?.y1 ?? 0) - (o.bounds?.y0 ?? 0)) || 10;
    const m = o.matrix, len = m ? Math.hypot(m[0], m[1]) : 0;
    const cos = len ? m[0] / len : 1, sin = len ? m[1] / len : 0;
    const base = o.partFrom || 0, out = [];
    const g = Array.isArray(o.glyphs) && o.glyphs.length === n ? o.glyphs : null;
    for (let k = 0; k < n; k++) {
      let x, y, w;
      if (g) [x, y, w] = g[k];
      else { // 글자 자리를 모르면 객체 상자를 고르게 나눈다(합성 객체·옛 응답)
        const b = o.bounds || { x0: 0, y0: 0, x1: 0, y1: 0 }, cw = (b.x1 - b.x0) / Math.max(1, n);
        x = b.x0 + cw * k; y = b.y0 + DESC / (ASC + DESC) * (b.y1 - b.y0); w = cw;
      }
      const d = DESC * size, a = ASC * size, nx = -sin, ny = cos;
      const p0 = [x - nx * d, y - ny * d], p1 = [p0[0] + cos * w, p0[1] + sin * w];
      const p2 = [p1[0] + nx * (a + d), p1[1] + ny * (a + d)], p3 = [p0[0] + nx * (a + d), p0[1] + ny * (a + d)];
      out.push({ ch: text[k], pos: base + k, p: [p0, p1, p2, p3], dir: [cos, sin] });
    }
    return out;
  }
  const bbox = (p) => ({ x0: Math.min(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) });

  // 줄들 → 글자 흐름 { lines, chars:[{ ch, li, idx|null, pos, p, dir, b }], lineStart, lineEnd }
  function build(lines) {
    const chars = [], lineStart = [], lineEnd = [];
    (lines || []).forEach((L, li) => {
      lineStart.push(chars.length);
      let prev = null;
      (L.objs || []).forEach((o, j) => {
        const cells = objCells(o);
        const sep = j ? String((L.seps || [])[j - 1] || '') : '';
        if (sep && prev) { // 사이 글: 앞 글자 끝 ~ 다음 글자 시작을 나눠 갖는다
          const next = cells[0] || prev, [cos, sin] = prev.dir;
          const from = prev.p[1], to = next === prev ? prev.p[1] : next.p[0];
          const gap = (to[0] - from[0]) * cos + (to[1] - from[1]) * sin, step = Math.max(0, gap) / sep.length;
          const h = [prev.p[2][0] - prev.p[1][0], prev.p[2][1] - prev.p[1][1]];
          for (let k = 0; k < sep.length; k++) {
            const q0 = [from[0] + cos * step * k, from[1] + sin * step * k], q1 = [q0[0] + cos * step, q0[1] + sin * step];
            const p = [q0, q1, [q1[0] + h[0], q1[1] + h[1]], [q0[0] + h[0], q0[1] + h[1]]];
            chars.push({ ch: sep[k], li, idx: null, pos: -1, p, dir: prev.dir, b: bbox(p) });
          }
        }
        for (const c of cells) { const x = { ...c, li, idx: o.idx, b: bbox(c.p) }; chars.push(x); prev = x; }
        if (!cells.length && sep && prev) prev = chars[chars.length - 1];
      });
      lineEnd.push(chars.length);
    });
    return { lines: lines || [], chars, lineStart, lineEnd };
  }

  // 쪽 좌표의 점 → 가장 가까운 칸 경계(0 ~ chars.length). 줄 높이 안쪽을 먼저 본다(같은 줄의 먼 글자가 다른 줄의 가까운 글자보다 앞선다)
  function caretAt(model, x, y) {
    const cs = model.chars;
    if (!cs.length) return -1;
    let best = 0, bestD = Infinity, bestAfter = false;
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k], [cos, sin] = c.dir, p0 = c.p[0];
      const w = (c.p[1][0] - p0[0]) * cos + (c.p[1][1] - p0[1]) * sin;
      const h = (c.p[3][0] - p0[0]) * -sin + (c.p[3][1] - p0[1]) * cos;
      const u = (x - p0[0]) * cos + (y - p0[1]) * sin, v = (x - p0[0]) * -sin + (y - p0[1]) * cos;
      const du = u < 0 ? -u : u > w ? u - w : 0, dv = v < 0 ? -v : v > h ? v - h : 0;
      const d = dv * 4 + du;
      if (d < bestD - 1e-9) { bestD = d; best = k; bestAfter = u > w / 2; }
    }
    return best + (bestAfter ? 1 : 0);
  }
  // 칸 번호 → 그 칸이 든 낱말 [a, b)(같은 줄 안). 글자·숫자가 아니면 그 칸 하나
  function wordAt(model, k) {
    const cs = model.chars;
    if (k < 0 || k >= cs.length) return null;
    const li = cs[k].li;
    if (!isWordCh(cs[k].ch)) return [k, k + 1];
    let a = k, b = k + 1;
    while (a > model.lineStart[li] && isWordCh(cs[a - 1].ch)) a--;
    while (b < model.lineEnd[li] && isWordCh(cs[b].ch)) b++;
    return [a, b];
  }
  function lineAt(model, k) {
    const c = model.chars[Math.max(0, Math.min(model.chars.length - 1, k))];
    return c ? [model.lineStart[c.li], model.lineEnd[c.li]] : null;
  }
  // 점에 놓인 칸 번호(경계가 아니라 칸)
  function charAt(model, x, y) {
    const k = caretAt(model, x, y);
    if (k < 0) return -1;
    const cs = model.chars;
    const inside = (c) => x >= c.b.x0 && x <= c.b.x1 && y >= c.b.y0 && y <= c.b.y1;
    if (k > 0 && inside(cs[k - 1])) return k - 1;
    return Math.min(k, cs.length - 1);
  }

  // 고른 범위 [a, b) → 글. 줄 사이는 '\n', 줄 끝 하이픈은 이어 붙인다(영문 소문자로 이어질 때), 소프트 하이픈은 늘 이어 붙인다
  function textOf(model, a, b) {
    const cs = model.chars, lo = Math.max(0, Math.min(a, b)), hi = Math.min(cs.length, Math.max(a, b));
    if (hi <= lo) return '';
    let out = '', lastLi = -1, lastAtEnd = false;
    for (let li = cs[lo].li; li <= cs[hi - 1].li; li++) {
      const s = Math.max(lo, model.lineStart[li]), e = Math.min(hi, model.lineEnd[li]);
      if (e <= s) continue;
      let seg = '';
      for (let k = s; k < e; k++) seg += cs[k].ch;
      const endsLine = e === model.lineEnd[li];
      if (lastLi < 0) out = seg;
      else if (lastAtEnd && /\u00AD$/.test(out)) out = out.slice(0, -1) + seg.replace(/^\s+/, '');
      else if (lastAtEnd && /[A-Za-z][-‐]$/.test(out) && /^[a-z]/.test(seg)) out = out.slice(0, -1) + seg;
      else out = out.replace(/[ \t]+$/, '') + '\n' + seg;
      lastLi = li; lastAtEnd = endsLine;
    }
    return out.replace(/\u00AD/g, '');
  }

  // 고른 범위의 줄마다 네모(글자 방향 기준) → [{ li, p:[[x,y]×4](왼아래·오른아래·오른위·왼위), b }]
  function runs(model, a, b) {
    const cs = model.chars, lo = Math.max(0, Math.min(a, b)), hi = Math.min(cs.length, Math.max(a, b)), out = [];
    if (hi <= lo) return out;
    for (let li = cs[lo].li; li <= cs[hi - 1].li; li++) {
      const s = Math.max(lo, model.lineStart[li]), e = Math.min(hi, model.lineEnd[li]);
      if (e <= s) continue;
      const first = cs[s], [cos, sin] = first.dir, o = first.p[0];
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let k = s; k < e; k++) for (const [x, y] of cs[k].p) {
        const u = (x - o[0]) * cos + (y - o[1]) * sin, v = (x - o[0]) * -sin + (y - o[1]) * cos;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
      }
      const at = (u, v) => [o[0] + u * cos - v * sin, o[1] + u * sin + v * cos];
      const p = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
      out.push({ li, p, b: bbox(p) });
    }
    return out;
  }
  // 형광펜·밑줄 주석 quads: [왼위 x,y, 오른위 x,y, 왼아래 x,y, 오른아래 x,y]
  const quadsOf = (model, a, b) => runs(model, a, b).map(({ p }) => [p[3], p[2], p[0], p[1]].flat().map((v) => Math.round(v * 100) / 100));
  // 가리기 조각: 객체마다 이어진 글 범위 [{ idx, from, to }](사이 글·가린 자리는 PDF 글자가 아니라 뺀다)
  function partsOf(model, a, b) {
    const cs = model.chars, lo = Math.max(0, Math.min(a, b)), hi = Math.min(cs.length, Math.max(a, b)), out = [];
    for (let k = lo; k < hi; k++) {
      const c = cs[k];
      if (c.idx == null || c.pos < 0) continue;
      const last = out[out.length - 1];
      if (last && last.idx === c.idx && last.to === c.pos) last.to = c.pos + 1;
      else out.push({ idx: c.idx, from: c.pos, to: c.pos + 1 });
    }
    return out;
  }

  const textSelectApi = { build, objCells, caretAt, charAt, wordAt, lineAt, textOf, runs, quadsOf, partsOf, ASC, DESC };
  if (typeof window !== 'undefined') window.textSelect = textSelectApi;
  if (typeof module !== 'undefined') module.exports = textSelectApi;
})();
