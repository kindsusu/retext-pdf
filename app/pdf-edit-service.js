// Apply a line edit to the live PDF document (the caller restores it on failure).
// Page object indices refer to the original page; editing from high to low keeps
// every remaining index stable, and the primary (whole-line text) goes last.
function assertIndex(objects, idx) {
  if (!Number.isInteger(idx) || idx < 0 || objects[idx]?.type !== 'text') throw new Error('편집할 텍스트 상자를 다시 선택하세요.');
}
// 객체 하나가 X에서 빠지면(제거·투명 글자 드러내기) X보다 뒤의 인덱스는 하나씩 당겨진다
const shiftAbove = (n, x) => (n > x ? n - 1 : n);
function shiftResult(result, x) {
  if (result.idx != null) result.idx = shiftAbove(result.idx, x);
  if (result.lineIdxs) result.lineIdxs = result.lineIdxs.map((n) => shiftAbove(n, x));
}

function applyEdits(doc, i, edits, { primary, fit, remove = [], align } = {}) {
  if (!Array.isArray(edits) || !edits.length) throw new Error('편집할 텍스트가 없습니다.');
  const objects = doc.objects(i);
  const seen = new Set();
  for (const { idx, text } of edits) {
    assertIndex(objects, idx);
    if (seen.has(idx) || typeof text !== 'string') throw new Error('중복되거나 잘못된 편집입니다.');
    seen.add(idx);
  }
  for (const idx of remove) {
    assertIndex(objects, idx);
    if (seen.has(idx)) throw new Error('중복되거나 잘못된 편집입니다.');
    seen.add(idx);
  }
  if (primary != null && !edits.some((e) => e.idx === primary)) throw new Error('기준 텍스트 상자를 찾을 수 없습니다.');
  const results = new Array(edits.length);
  const operations = [
    ...edits.map((edit, order) => ({ ...edit, order, kind: 'edit', isPrimary: edit.idx === primary })),
    ...remove.map((idx) => ({ idx, kind: 'remove' })),
  ].sort((a, b) => b.idx - a.idx);
  // 기준 조각은 맨 마지막에: 투명 글자 줄이면 나중에 드러난 조각의 배경 덮개가 새 글자 위에 얹혀 글자가 가려진다
  const p = operations.findIndex((o) => o.isPrimary);
  if (p >= 0) operations.push(...operations.splice(p, 1));
  let primaryResult;
  for (let k = 0; k < operations.length; k++) {
    const operation = operations[k];
    const { idx } = operation;
    const result = operation.kind === 'remove' ? doc.removeObject(i, idx)
      : fit && operation.isPrimary ? doc.fitText(i, idx, operation.text, fit.maxWidth, fit.mode)
        : doc.setText(i, idx, operation.text);
    if (!result?.ok) throw new Error(result?.reason || '텍스트를 수정하지 못했습니다.');
    if (operation.kind === 'edit') {
      const expectedLines = operation.text.split(/\r?\n/).length;
      const actualLines = result.lineIdxs?.length || 1;
      if (fit && operation.isPrimary && fit.mode === 'wrap') {
        if (result.wrapped && actualLines !== result.wrapped) throw new Error('줄바꿈 일부를 그리지 못했습니다.');
      } else if (actualLines !== expectedLines) throw new Error('텍스트 일부를 그리지 못했습니다.');
    }
    // A revealed object is removed at its old index and appended. Removing a
    // grouped sibling has the same effect on indices above that sibling —
    // both for results already produced and for operations still pending.
    if (operation.kind === 'remove' || result.revealed) {
      for (const previous of results) if (previous) shiftResult(previous, idx);
      for (const pending of operations.slice(k + 1)) pending.idx = shiftAbove(pending.idx, idx);
    }
    if (operation.kind === 'edit') {
      if (result.idx == null && !result.lineIdxs) result.idx = idx;
      results[operation.order] = result;
      if (operation.isPrimary) primaryResult = result;
    }
  }
  // 정렬(가운데·오른쪽): 새 줄 전체의 오른쪽 끝/가운데를 옛 상자에 맞춘다 — 같은 편집 안에서 하므로 실행 취소도 한 번
  if (primaryResult && align && ['center', 'right'].includes(align.mode)) {
    const old = align.oldBounds || {}, idxs = primaryResult.lineIdxs || [primaryResult.idx], now = doc.objects(i);
    const boxes = idxs.map((n) => now[n]?.bounds).filter(Boolean);
    if (boxes.length && [old.x0, old.x1].every(Number.isFinite)) {
      const x0 = Math.min(...boxes.map((b) => b.x0)), x1 = Math.max(...boxes.map((b) => b.x1));
      const dx = align.mode === 'center' ? ((old.x0 + old.x1) - (x0 + x1)) / 2 : old.x1 - x1;
      if (dx && !doc.move(i, idxs, dx, 0).ok) throw new Error('정렬하지 못했습니다.');
    }
  }
  return { results, primaryResult, fallbackFont: results.some((r) => r.fallbackFont) };
}

// 저장·재열기한 문서에서 편집 결과를 확인한다. 공백으로 비운 곁가지 조각(기준 조각이 아닌 ' ' 편집)이
// 일부 폰트에서 저장 뒤 'ÿ'로 읽히거나 옛 글자가 남으면, 검사를 느슨하게 하지 않고 그 객체를 지운다
// (비우려던 조각이므로 지워도 결과는 같다). 지운 뒤의 인덱스는 results에 반영한다. 그 밖의 불일치는 예외.
function verifyEdits(doc, i, edits, results, { primary } = {}) {
  const objects = doc.objects(i), drop = [];
  for (let n = 0; n < edits.length; n++) {
    const indices = results[n].lineIdxs || [results[n].idx];
    const blankSibling = edits[n].idx !== primary && !edits[n].text.trim() && indices.length === 1;
    if (indices.some((idx) => !Number.isInteger(idx) || objects[idx]?.type !== 'text')) throw new Error('저장된 텍스트 위치를 확인하지 못했습니다.');
    const actual = indices.map((idx) => objects[idx].text).join('').replace(/\s/g, '');
    const expected = edits[n].text.replace(/\s/g, '');
    if (actual === expected) continue;
    if (blankSibling) drop.push(n);
    else throw new Error('이 글꼴은 입력한 글자를 그대로 저장하지 못합니다(원본 PDF의 글자 대응 문제). 다른 표기로 바꾸거나 [폰트 맞추기]로 글꼴을 지정하세요.');
  }
  // 높은 인덱스부터 지워야 아직 지우지 않은 조각의 인덱스가 그대로다
  drop.sort((a, b) => results[b].idx - results[a].idx);
  for (const n of drop) {
    const x = results[n].idx;
    if (!doc.removeObject(i, x).ok) throw new Error('저장된 텍스트가 입력과 다릅니다.');
    results.forEach((r, m) => { if (m !== n) shiftResult(r, x); });
    results[n] = { ...results[n], idx: null, removed: true };
  }
  return drop.length;
}

// 한 번의 가리기 요청에서 같은 줄(기준선 차 0.2em 이내·글자 크기 차 10% 이내)에 속한 덮개를 사각형 하나로 합친다:
// 가로는 가린 첫 글자 왼쪽 ~ 마지막 글자 오른쪽(사이 틈 포함), 세로는 줄 높이(엔진 lineBand). 줄 정보가 없는 덮개(회전·기울임 글자)는 그대로
function mergeLineCovers(covers) {
  const lines = [], loose = [];
  for (const { rect, line } of covers) {
    if (!line) { loose.push(rect); continue; }
    const near = (g) => Math.abs(g.y - line.y) <= 0.2 * Math.max(g.em, line.em) && Math.abs(g.em - line.em) <= 0.1 * Math.max(g.em, line.em);
    const g = lines.find(near);
    if (!g) { lines.push({ y: line.y, em: line.em, rect: { ...rect } }); continue; }
    const r = g.rect;
    g.rect = { x0: Math.min(r.x0, rect.x0), y0: Math.min(r.y0, rect.y0), x1: Math.max(r.x1, rect.x1), y1: Math.max(r.y1, rect.y1) };
  }
  return [...lines.map((g) => g.rect), ...loose];
}

// ── v6 Wave B: 회전·기울어진 줄의 가림 덮개 ─────────────────────────────────────
// 예전에는 회전 글자(세로 제목·기울어진 도장 문구)를 객체 상자(쪽 축에 맞춘 사각형)로 덮어, 글자마다 객체인 PDF(Chromium·한글)는
// 글자 수만큼 덮개가 생겼다(12번 말뭉치: 세로 제목 한 줄 → 덮개 17개, 기울어진 줄 → 20개). 이제 줄마다 글자 방향으로 돌린 사각형 하나.
// 줄 높이는 가로 줄(엔진 lineBand)과 같은 규칙: 기준선 −0.25em ~ +0.85em, 글자 잉크가 그보다 넓으면(쪽 축 상자를 글자 방향으로 잰 값, 0.15em까지) 넓힌다.
// 글자 방향 좌표: u = x·cos + y·sin(진행), v = −x·sin + y·cos(기준선 높이). o: objects() 항목(글자를 지우기 전). 못 재면 null
const TILT_PAD = 0.5;
function tiltCover(o) {
  const m = o?.matrix, t = o?.text || '', g = o?.glyphs;
  if (!m || !g || g.length !== t.length || !t.trim()) return null;
  const len = Math.hypot(m[0], m[1]);
  if (!(len > 0)) return null;
  const cos = m[0] / len, sin = m[1] / len, U = (x, y) => x * cos + y * sin, V = (x, y) => -x * sin + y * cos;
  // 글자 공간의 위(0,1) = 쪽에서 (c,d): 기준선에 수직인 성분 vc, 진행 방향 성분 uc(기울임 — 글자 윗부분이 옆으로 밀린다)
  const uc = m[2] * cos + m[3] * sin, vc = -m[2] * sin + m[3] * cos, size = o.size || 0, em = size * Math.abs(vc);
  if (!(em > 0)) return null;
  const ink = g.filter((q, k) => !/\s/.test(t[k]));
  const v = V(ink[0][0], ink[0][1]);
  let u0 = Math.min(...ink.map((q) => U(q[0], q[1]))), u1 = Math.max(...ink.map((q) => U(q[0], q[1]) + q[2]));
  const lo = -0.25 * size, hi = 0.85 * size;
  u0 += Math.min(0, lo * uc, hi * uc); u1 += Math.max(0, lo * uc, hi * uc);
  let v0 = Math.min(v + lo * vc, v + hi * vc), v1 = Math.max(v + lo * vc, v + hi * vc);
  if (o.bounds) { // 잉크가 줄 높이·진행 폭 밖으로 나온 만큼(90° 단위 회전이면 정확, 그 밖에는 0.15em까지만)
    const b = o.bounds, cs = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]];
    const bu = cs.map(([x, y]) => U(x, y)), bv = cs.map(([x, y]) => V(x, y)), lim = 0.15 * em;
    u0 = Math.min(u0, Math.max(Math.min(...bu), u0 - lim)); u1 = Math.max(u1, Math.min(Math.max(...bu), u1 + lim));
    v0 = Math.min(v0, Math.max(Math.min(...bv), v0 - lim)); v1 = Math.max(v1, Math.min(Math.max(...bv), v1 + lim));
  }
  return { theta: Math.atan2(sin, cos) * 180 / Math.PI, cos, sin, v, em, u0, u1, v0, v1, flat: Math.abs(sin) < 1e-3 && cos > 0 };
}
// 같은 방향(1° 안)·같은 기준선(0.2em 안)·같은 크기(10% 안)의 덮개를 하나로. 반환 [{ pts(쪽 좌표 꼭짓점 4개), bounds(쪽 축 상자) }]
function mergeTiltCovers(tilts) {
  const groups = [];
  for (const c of tilts) {
    const g = groups.find((q) => Math.abs(q.theta - c.theta) <= 1 && Math.abs(q.v - c.v) <= 0.2 * Math.max(q.em, c.em) && Math.abs(q.em - c.em) <= 0.1 * Math.max(q.em, c.em));
    if (!g) { groups.push({ ...c }); continue; }
    g.u0 = Math.min(g.u0, c.u0); g.u1 = Math.max(g.u1, c.u1); g.v0 = Math.min(g.v0, c.v0); g.v1 = Math.max(g.v1, c.v1);
  }
  return groups.map((q) => {
    const P = (u, v) => [u * q.cos - v * q.sin, u * q.sin + v * q.cos];
    const pts = [P(q.u0 - TILT_PAD, q.v0 - TILT_PAD), P(q.u1 + TILT_PAD, q.v0 - TILT_PAD), P(q.u1 + TILT_PAD, q.v1 + TILT_PAD), P(q.u0 - TILT_PAD, q.v1 + TILT_PAD)];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { pts, bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
  });
}

// 가리기(/api/pdf/mask와 tools/demo-assets.js가 같이 쓴다). parts: [{ idx, from, to }] — 글자를 텍스트에서 실제로 지우고(redact),
// 덮개는 다 지운 뒤 줄마다 하나씩 그린다(4.0.1 이전에는 글자·조각마다 따로 그려 높이가 들쭉날쭉했다).
// 하나라도 가렸으면 ok:true(건너뛴 조각은 skipped). 아무것도 못 가렸으면 ok:false — 호출한 쪽(mutate)이 문서를 되돌린다
function maskParts(doc, i, parts, { color, fallbackRects = [] } = {}) {
  const covers = [], tilts = [], skipped = [], rects = [], polys = [];
  const colFor = (b) => (color === 'auto' ? doc.sampleColor(i, b) : (color || [0, 0, 0, 255])); // 'auto' = 그 자리 배경색
  // redact가 idx+1에 새 텍스트 객체를 끼워넣어 뒤 인덱스를 밀어내므로, 앞 인덱스가 안 밀리도록 뒤에서부터 처리
  const sorted = [...parts].sort((a, b) => b.idx - a.idx);
  // 지우기 전 객체 글. 공백 조각(" ")은 옆 글자를 지워 공백(' ')으로 바꾸면 PDFium 텍스트 페이지가 이어진 공백으로 보고 빼서
  // 객체 글이 ''가 된다(redact → 'empty'). 원래 공백뿐이던 범위는 지울 글자가 없으니 건너뛴 조각으로 세지 않는다.
  // (뒤에서부터 처리하므로 아직 처리하지 않은 앞 조각의 인덱스는 그대로다)
  const before = doc.objects(i);
  for (const { idx, from, to } of sorted) {
    const r = doc.redact(i, idx, from, to, undefined, { draw: false });
    if (r.ok) { covers.push({ rect: r.rects[0], line: r.line }); continue; }
    if (r.reason === 'empty' && !String(before[idx]?.text || '').slice(from, to).trim()) continue;
    // 글자 단위로 못 자르는 객체(조각 텍스트 charmap, 회전·기울임 rotated): 객체 전체를 공백으로 지우고 상자를 따로 덮는다
    if (r.reason === 'charmap' || r.reason === 'rotated') {
      const all = doc.objects(i), obj = all[idx];
      const band = obj && obj.bounds ? doc.lineBand(i, obj, all) : null; // 글자를 지우기 전에 줄 높이를 잰다
      // v6 Wave B: 회전·기울임 글자는 글자 방향 덮개(지우기 전 글자 자리로 잰다). 가로 기울임(이탤릭)은 가로 줄 덮개와 합쳐지게 줄 정보를 단다
      const tilt = r.reason === 'rotated' && typeof doc.addPolygon === 'function' ? tiltCover(obj) : null;
      const cleared = doc.setText(i, idx, ' ');
      if (!cleared?.ok) { skipped.push({ idx, reason: cleared?.reason || 'clear' }); continue; } // 글자가 남는데 덮기만 하면 안 된다
      // 같은 자리에 겹쳐 그린 사본(굵게·그림자용)도 비운다 — 안 비우면 저장 뒤 사본에서 가린 글자가 다시 읽힌다.
      // _setOneRaw는 객체 자리를 유지한다(setText는 투명 사본을 드러내며 맨 뒤로 옮겨 남은 parts의 인덱스를 민다)
      for (const j of r.twins || []) {
        const t = doc._setOneRaw(i, j, ' ');
        if (!t?.ok) skipped.push({ idx: j, reason: t?.reason || 'twin' });
      }
      if (tilt?.flat) covers.push({ rect: { x0: tilt.u0 - TILT_PAD, x1: tilt.u1 + TILT_PAD, y0: tilt.v0 - TILT_PAD, y1: tilt.v1 + TILT_PAD }, line: { y: tilt.v, em: tilt.em } });
      else if (tilt) tilts.push(tilt);
      else if (obj && obj.bounds) {
        const b = obj.bounds;
        covers.push(band ? { rect: { x0: b.x0, x1: b.x1, y0: Math.min(b.y0, band.y0), y1: Math.max(b.y1, band.y1) }, line: { y: band.y, em: band.em } } : { rect: b });
      }
    } else skipped.push({ idx, reason: r.reason });
  }
  // 덮개 색은 글자를 다 지운 뒤 합친 상자에서 잰다('auto')
  for (const b of mergeLineCovers(covers)) { doc.addRect(i, b, colFor(b)); rects.push(b); }
  // 회전 줄: 줄마다 돌린 사각형 하나. rects에는 쪽 축 상자(겹치는 주석 지우기·화면 표시용), polys에 꼭짓점
  for (const q of mergeTiltCovers(tilts)) { doc.addPolygon(i, q.pts, colFor(q.bounds)); rects.push(q.bounds); polys.push(q.pts); }
  for (const b of fallbackRects || []) { doc.addRect(i, b, colFor(b)); rects.push(b); }
  return { ok: rects.length > 0, rects, skipped, ...(polys.length ? { polys } : {}) };
}

// 가리기 조각 정리: 같은 객체의 조각은 겹치거나 맞닿으면 하나로 합치고(객체 전체 조각이 있으면 그것 하나),
// 인덱스 내림차순 · 같은 객체 안에서는 뒤 조각부터로 놓는다. redact는 뒤 글자를 새 객체(idx+1)로 떼어 내고 앞부분을 제자리에 남기므로
// 뒤 조각을 먼저 지워야 앞 조각의 위치(from·to)가 그대로다. maskParts의 정렬(인덱스만, 안정 정렬)이 이 순서를 지킨다
function normalizeParts(parts) {
  const byIdx = new Map();
  for (const p of parts) {
    if (!byIdx.has(p.idx)) byIdx.set(p.idx, []);
    byIdx.get(p.idx).push(p);
  }
  const out = [];
  for (const [idx, list] of byIdx) {
    const whole = list.find((p) => p.whole);
    if (whole) { out.push({ idx, from: 0, to: Math.max(...list.map((p) => p.to)), whole: true }); continue; }
    const sorted = [...list].sort((a, b) => a.from - b.from), merged = [];
    for (const p of sorted) {
      const last = merged[merged.length - 1];
      if (last && p.from <= last.to) last.to = Math.max(last.to, p.to); else merged.push({ idx, from: p.from, to: p.to });
    }
    out.push(...merged);
  }
  return out.sort((a, b) => b.idx - a.idx || b.from - a.from);
}

// 텍스트 페이지 글자 번호 범위들([[start, end], …], end 미포함)을 진짜로 가린다(개인정보 일괄 가리기 · 영역 가리기 공용):
// 글자 → 객체 조각(doc.partsForRanges) → maskParts(글자 제거 + 줄마다 덮개) → 덮개와 겹치는 주석 지우기.
// extraRects: 함께 덮을 사각형(영역 가리기의 영역 전체). 돌려주는 값: { ok, rects, skipped, unmapped(쪽 객체에 없는 글자 수), annots(지운 주석 수) }
function redactRanges(doc, i, ranges, { color, extraRects = [] } = {}) {
  const { parts, unmapped } = ranges.length ? doc.partsForRanges(i, ranges) : { parts: [], unmapped: 0 };
  const r = parts.length || extraRects.length ? maskParts(doc, i, normalizeParts(parts), { color, fallbackRects: extraRects }) : { ok: false, rects: [], skipped: [] };
  const annots = r.rects.length ? doc.removeAnnotsIn(i, r.rects) : 0;
  return { ...r, unmapped, annots };
}

// 영역 진짜 가리기(한 쪽). rect: { x0, y0, x1, y1 } 회전 전 페이지 좌표. 순서가 중요하다:
//   1) 영역 안에 다 든 선·도형을 뺀다 2) 겹치는 그림은 영역 부분 픽셀을 칠해 다시 넣는다(다 들면 뺀다)
//   3) 글자 상자 가운데가 영역 안인 글자를 지우고 줄 덮개 + 영역 덮개를 그린다(새 덮개가 1)에서 빠지지 않게 마지막에)
//   4) 영역과 겹치는 주석을 지운다
// 양식 XObject 안의 글자·그림은 지울 수 없어 덮개로만 가려진다(unmapped로 센다). 글자 대응이 어긋난 객체는 객체 전체를 비운다(영역 밖 글자까지)
function redactArea(doc, i, rect, { color } = {}) {
  const box = { x0: Math.min(rect.x0, rect.x1), y0: Math.min(rect.y0, rect.y1), x1: Math.max(rect.x0, rect.x1), y1: Math.max(rect.y0, rect.y1) };
  const fill = color === 'auto' ? doc.sampleColor(i, box) : (Array.isArray(color) ? color : [0, 0, 0, 255]);
  const paths = doc.removePathsIn(i, box);
  const images = doc.redactImagesIn(i, box, fill);
  const r = redactRanges(doc, i, doc.charRangesIn(i, box), { color: fill, extraRects: [box] });
  return { ...r, paths, images };
}

// ── 2단계: 조각(run)별 모양을 지키는 줄 편집 · 문단 다시 흘리기(/api/pdf/edit-runs) ─────────────────────
// 줄 상자 하나에 굵게·기울임·색·코드 글꼴 조각이 섞여 있으면(groupLines mergeStyledRuns) 예전 방식(첫 조각에 줄 전체를 넣고 나머지 삭제)은
// 모든 글자가 첫 조각 모양이 된다. 여기서는 글자 차이(run-edit.planRuns)로 바뀐 조각만 고쳐 쓰고, 안 바뀐 조각은 옮기기만 한다.
//   req: { lines: [{ objs: [{ idx, from?, to?, text }], seps }], oldText, newText, mode: 'none'|'shrink'|'wrap', maxWidth, align, paragraph }
//     objs·seps는 화면 상자(groupLines)의 것 그대로 — from/to는 15d처럼 객체 안 한 부분일 때의 글자 범위, text ''는 겹쳐 그린 빈 사본·가린 자리의 공백(따라 움직이는 객체)
//     paragraph: 여러 줄을 문단으로 — 줄 사이 '\n'은 다시 흘릴 때 낱말 사이 띄어쓰기(앞 줄이 '-'로 끝나면 붙임). 폭 = 문단에서 가장 긴 줄
//   위치: 줄마다 옛 시작 x·기준선을 지키고, 조각 사이 옛 틈(pt)을 그대로 두며 앞 글이 길어지거나 짧아진 만큼 뒤 조각을 민다.
//   넘치면(mode): wrap = 폭에서 나눠 아래 줄로(문단은 옛 줄 자리, 모자라면 같은 줄 간격으로 아래에 더) · shrink = 줄 전체 축소 · none = 그대로
//   객체 순서: 새 객체(나눈 뒷부분)를 먼저 맨 뒤에 만들고 → 글 고치기(제자리) → 옮기기 → 지우기(높은 인덱스부터) — 앞 인덱스가 밀리지 않는다
const { planRuns, breakAtoms } = require('./run-edit');
const RUN_WIDTH_TOL = 1;      // 문단 폭 여유(pt) — 안 고친 줄이 측정 오차로 넘치지 않게
const CALIB_RANGE = [0.5, 2]; // 원래 글꼴 폭 보정(실측 ÷ 글리프 폭)의 허용 범위 — 자간·장평(Tz) 몫

//   v6 덧붙임(모두 생략 가능):
//     force: 글이 같아도 다시 배치한다(글자 모양을 바꾼 뒤 폭이 달라진 조각을 다시 놓기 — styleRuns·정렬·줄 간격·상자 폭)
//     gaps: { [객체 idx]: pt } 그 조각 앞 틈을 이 값으로(자간) · pitch: 문단 줄 간격(pt, 모든 줄) · align(문단): 'left'|'center'|'right'|'justify'
//     box: { x0, x1, dy } 상자 왼쪽·오른쪽 끝(쪽 좌표)과 세로 이동 — 화면 손잡이로 폭을 바꾸거나 옮긴 상자(한 줄이면 x1−x0이 줄바꿈 폭)
//     pushDown: 고친 상자가 아래로 길어지면 같은 단(상자의 가로 범위)에서 아래 내용(글·그림·선)을 그만큼 내린다 — 줄 간격 2배 이상 빈 곳이나 쪽 끝에서 멈춘다
//     overflow: 밀면 쪽 아래로 넘칠 때 'ask'(409 + overflow 표시로 되묻기, 문서는 되돌린다) | 'keep'(밀지 않고 겹쳐 둔다)
//     fontScale: 상자 글자를 이 배율로 줄여 다시 흘린다(넘칠 때 [글자 줄여 맞추기] — 서버 라우트가 배율을 낮춰 가며 다시 시도한다)
function editRuns(doc, i, req = {}) {
  const { lines: reqLines, oldText, newText, mode = 'none', align, paragraph = false, gaps: gapOv = null, pushDown = false, overflow = 'ask' } = req;
  const box = req.box && Number.isFinite(+req.box.x0) && Number.isFinite(+req.box.x1) && +req.box.x1 > +req.box.x0 ? { x0: +req.box.x0, x1: +req.box.x1, dy: +req.box.dy || 0 } : null;
  const fontScale = req.fontScale == null ? 1 : Number(req.fontScale);
  if (!(fontScale >= 0.3 && fontScale <= 1)) throw new Error('글자 배율이 잘못됐습니다.');
  const pitchOv = Number(req.pitch) > 0 ? Number(req.pitch) : 0;
  const force = !!req.force || !!box || pitchOv > 0 || fontScale !== 1 || (paragraph && ['center', 'right', 'justify'].includes(align?.mode || align));
  let maxWidth = Number(req.maxWidth) > 0 ? Number(req.maxWidth) : Infinity; // 아래(줄 기하를 안 뒤)에서 옛 줄 폭 이상으로 넓힌다
  if (!Array.isArray(reqLines) || !reqLines.length || reqLines.some((L) => !Array.isArray(L?.objs) || !L.objs.length)) throw new Error('편집할 줄이 없습니다.');
  if (typeof newText !== 'string' || newText.length > 20000) throw new Error('고칠 글이 너무 깁니다.');
  // 1) 객체 안 부분(15d)은 먼저 실제 객체로 가른다(뒷부분은 맨 뒤에 새 객체 — 앞 인덱스는 그대로)
  let objects = doc.objects(i);
  const cutsBy = new Map();
  for (const L of reqLines) for (const c of L.objs) {
    const o = objects[c?.idx];
    if (!Number.isInteger(c?.idx) || !o || o.type !== 'text') throw new Error('편집할 텍스트 상자를 다시 선택하세요.');
    if (o.hidden || o.group) throw new Error('투명 글자·묶은 상자는 조각별로 고칠 수 없습니다.');
    if (!o.matrix || Math.abs(o.matrix[1]) > 1e-3 || !(o.matrix[0] > 0) || !(o.matrix[3] > 0)) throw new Error('회전한 글자는 조각별로 고칠 수 없습니다.');
    const len = o.text.length, from = c.from ?? 0, to = c.to ?? len;
    if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from <= to && to <= len)) throw new Error('편집할 텍스트 상자를 다시 선택하세요.');
    if (from > 0 || to < len) { if (!cutsBy.has(c.idx)) cutsBy.set(c.idx, new Set()); cutsBy.get(c.idx).add(from).add(to); }
  }
  const segs = new Map(); // idx → { bounds: [0, …, len], idxs: 조각 객체 인덱스 }
  for (const [idx, set] of cutsBy) {
    const len = objects[idx].text.length, cuts = [...set].filter((k) => k > 0 && k < len).sort((a, b) => a - b);
    const r = doc.splitText(i, idx, cuts);
    if (!r.ok) throw new Error(r.reason || '글자 조각을 나누지 못했습니다.');
    segs.set(idx, { bounds: [0, ...cuts, len], idxs: r.idxs });
  }
  if (segs.size) objects = doc.objects(i);
  const segmentsOf = (c) => {
    const s = segs.get(c.idx);
    if (!s) return [c.idx];
    const from = c.from ?? 0, to = c.to ?? s.bounds[s.bounds.length - 1];
    return s.idxs.filter((_, k) => s.bounds[k] >= from && s.bounds[k + 1] <= to);
  };
  // 넘침 줄이기(fontScale): 줄마다 그 줄의 시작점·기준선을 중심으로 글자·틈을 함께 줄인다(아래에서 줄 간격도 같은 배율)
  if (fontScale !== 1) {
    for (const L of reqLines) {
      const idxs = [...new Set(L.objs.flatMap((c) => segmentsOf(c)))], os = idxs.map((x) => objects[x]).filter((o) => o?.origin);
      if (!os.length) continue;
      const ink = os.find((o) => (o.text || '').trim()) || os[0];
      doc.scaleAbout(i, idxs, fontScale, Math.min(...os.map((o) => o.origin.x)), ink.origin.y);
    }
    objects = doc.objects(i);
  }
  // 2) 줄·조각 모양(기하)
  const used = new Set();
  const lines = reqLines.map((L, li) => {
    const items = [], seps = [];
    let sep = '', lead = [];
    L.objs.forEach((c, j) => {
      if (j) sep += String(L.seps?.[j - 1] ?? '');
      const idxs = segmentsOf(c), text = idxs.map((x) => objects[x].text).join('');
      if (c.text === '') { // 따라 움직이는 객체(빈 사본·가린 자리 공백) — 앞 조각에 붙인다(앞이 없으면 첫 조각에)
        idxs.forEach((x) => { used.add(x); (items.length ? items[items.length - 1].followers : lead).push(x); });
        return;
      }
      if (typeof c.text === 'string' && c.text !== text) throw new Error('문서가 바뀌었습니다. 줄을 다시 선택하세요.');
      idxs.forEach((x, q) => {
        if (used.has(x)) throw new Error('같은 글자 조각이 두 번 들어 있습니다.');
        used.add(x);
        if (items.length) seps.push(q ? '' : sep);
        items.push(itemGeometry(objects[x], li));
      });
      sep = '';
    });
    if (!items.length) throw new Error('편집할 글자가 없습니다.');
    items[0].followers.push(...lead);
    const main = items.reduce((m, it) => (it.size > m.size + 0.01 ? it : m), items[0]);
    return { items, seps, x: Math.min(...items.map((it) => it.start)), y: main.y, size: main.size, end: Math.max(...items.map((it) => it.inkEnd)) };
  });
  // 쓸 수 있는 폭은 적어도 옛 줄 폭(+여유) — 화면이 이웃·본문 끝으로 잰 폭이 옛 줄보다 좁게 나와도(이웃이 없으면 그 줄이 곧 본문 끝) 같은 길이로 고친 줄이 줄바꿈되지 않게
  if (!paragraph && box) maxWidth = box.x1 - box.x0 + RUN_WIDTH_TOL; // 화면에서 정한 상자 폭(손잡이)이 곧 줄바꿈 폭
  else if (!paragraph && Number.isFinite(maxWidth)) maxWidth = Math.max(maxWidth, Math.max(...lines.map((L) => L.end - L.x)) + RUN_WIDTH_TOL);
  const raw = lines.map((L) => L.items.map((it, j) => (j ? L.seps[j - 1] : '') + it.text).join('')).join('\n');
  if (typeof oldText === 'string' && oldText !== raw) throw new Error('문서가 바뀌었습니다. 줄을 다시 선택하세요.');
  // 조각 사이 틈(옛 위치)과 가린 자리(■)를 덮은 가림 상자
  for (const L of lines) {
    L.gaps = L.items.slice(1).map((it, j) => (gapOv && gapOv[it.idx] != null && Number.isFinite(+gapOv[it.idx]) ? +gapOv[it.idx] * fontScale : it.start - L.items[j].end));
    L.masks = L.items.slice(1).map((it, j) => (/■/.test(L.seps[j]) ? objects.filter((m) => m.mask && m.bounds && m.bounds.x0 >= L.items[j].end - 1 && m.bounds.x1 <= it.start + 1
      && m.bounds.y0 < L.y + L.size && m.bounds.y1 > L.y - 0.3 * L.size).map((m) => m.idx) : []));
  }
  // 3) 글자 차이 → 조각 배정
  const plan = planRuns(lines.map((L) => ({ items: L.items.map((it) => ({ text: it.text, style: it.style })), seps: L.seps })), newText);
  const allIdxs = () => lines.flatMap((L) => L.items.map((it) => it.idx));
  if (!plan.changed && !force) return { ok: true, unchanged: true, lineIdxs: allIdxs(), written: [], fallbackFont: false };
  const first = force ? 0 : plan.firstChanged, lastChanged = force ? lines.length - 1 : plan.lastChanged;
  // 4) 글자 폭: 안 고친 조각은 실측(글자 위치), 고친 조각은 글꼴 폭 추정 × 보정
  const calibOf = (it) => {
    if (it.calib == null) {
      const m = doc.measureText(i, it.idx, it.text), sum = m.ok ? m.adv.reduce((a, b) => a + b, 0) : 0;
      it.calib = m.ok && !m.fallback && sum > 0 && it.end > it.start ? Math.min(CALIB_RANGE[1], Math.max(CALIB_RANGE[0], (it.end - it.start) / sum)) : 1;
    }
    return it.calib;
  };
  const advOf = (it, text) => {
    const m = doc.measureText(i, it.idx, text);
    if (!m.ok) throw new Error(m.reason || '글자 폭을 재지 못했습니다.');
    const k = m.fallback ? 1 : calibOf(it);
    return m.adv.map((w) => w * k);
  };
  const itemOf = (el) => lines[el.line].items[el.j];
  // 5) 흐름 → 줄 나누기 단위(atoms). 첫 고친 줄 앞의 줄은 손대지 않는다
  const atoms = [];
  const stream = plan.stream.slice(plan.stream.findIndex((el) => el.line >= first));
  stream.forEach((el, n) => {
    if (el.t === 'hard') atoms.push({ t: 'h', el });
    else if (el.t === 'sep') {
      const L = lines[el.line];
      atoms.push({ t: 'g', el, w: el.deleted ? 0 : L.gaps[el.j], brk: !el.deleted && /\s/.test(el.value) });
    } else if (el.t === 'soft') {
      // 옛 줄 경계: 한 줄로 이어지면 낱말 사이 띄어쓰기(다음 조각 글꼴의 공백 폭). 앞 글이 '-'·공백으로 끝나거나 사용자가 줄바꿈을 지웠으면 붙인다.
      // 한글·한자·가나끼리 이어지고 앞 줄이 문단 오른쪽 끝까지 찼으면(1em 안) 낱말 중간에서 글자 단위로 끊긴 줄로 보고 붙인다
      // (실측: 회의록_초안.pdf "…재\n무팀장이" — 브라우저·한글은 한글을 글자 단위로 줄바꿈한다. 낱말 경계 줄바꿈은 보통 줄 끝이 덜 찬다)
      const prev = [...stream.slice(0, n)].reverse().find((x) => x.t === 'piece'), next = stream.slice(n + 1).find((x) => x.t === 'piece');
      const cjk = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;
      const P = lines[el.line], full = P.end >= Math.max(...lines.map((L) => L.end)) - P.size;
      const glue = el.deleted || !prev || !next || /[-­\s]$/.test(prev.text) || /^\s/.test(next.text)
        || (full && cjk.test(prev.text.slice(-1)) && cjk.test(next.text[0]));
      atoms.push({ t: 'g', el, w: glue ? 0 : advOf(itemOf(next), ' ')[0], brk: !el.deleted });
    } else {
      const it = itemOf(el), adv = el.orig ? it.adv : advOf(it, el.text);
      for (let k = 0; k < el.text.length; k++) atoms.push({ t: 'c', el, k, w: adv[k] || 0, ws: /\s/.test(el.text[k]) });
    }
  });
  // 줄 자리(slot): 첫 고친 줄부터 옛 줄 자리, 모자라면 같은 간격으로 아래에 더(문단은 둘째 줄의 x — 첫 줄 들여쓰기 제외)
  // 한 줄이면 줄 간격을 모르므로 같은 단 바로 아래의 같은 크기 줄과의 기준선 차(1~2.2배 크기 안)를 쓰고, 없으면 글자 크기의 1.2배
  const singlePitch = () => {
    const L = lines[0], near = objects.filter((o) => o.type === 'text' && o.origin && (o.text || '').trim() && !used.has(o.idx)
      && Math.abs((o.scaledSize || o.size) - L.size) <= 0.1 * L.size && o.bounds.x1 > L.x && o.bounds.x0 < L.end
      && L.y - o.origin.y >= 1.0 * L.size && L.y - o.origin.y <= 2.2 * L.size).map((o) => L.y - o.origin.y);
    return near.length ? Math.min(...near) : 1.2 * L.size;
  };
  const pitch = pitchOv || (lines.length > 1 ? median(lines.slice(1).map((L, k) => lines[k].y - L.y)) : singlePitch() / fontScale) * fontScale;
  const extraX = lines.length > 1 ? lines[1].x : lines[0].x;
  // 상자를 옮기거나 폭을 바꿨으면(box) 줄 자리를 그만큼 옮긴다. 줄 간격을 바꿨거나 글자를 줄였으면 첫 줄 기준선에서 같은 간격으로 다시 놓는다
  // 화면 상자 왼쪽 끝은 잉크 상자(bounds.x0)라 글자 시작점(L.x)과 왼쪽 여백(lsb)만큼 다르다 — 0.15em 안의 차이는 옮긴 것으로 보지 않는다
  const oldLeft = Math.min(...lines.map((L) => L.x)), sx0 = box ? box.x0 - oldLeft : 0, sy0 = box ? box.dy : 0;
  const sx = Math.abs(sx0) < 0.15 * lines[0].size ? 0 : sx0, sy = Math.abs(sy0) < 0.15 * lines[0].size ? 0 : sy0;
  const even = pitchOv > 0 || fontScale !== 1;
  const slot = (n) => {
    const k = first + n;
    if (k < lines.length) return { x: lines[k].x + sx, y: (even ? lines[0].y - k * pitch : lines[k].y) + sy, orig: true };
    return { x: extraX + sx, y: (even ? lines[0].y - k * pitch : lines[lines.length - 1].y - (k - lines.length + 1) * pitch) + sy, orig: false };
  };
  const paraRight = box ? box.x1 : Math.max(...lines.map((L) => L.end));
  const widthOf = (n) => (paragraph ? paraRight - slot(n).x + RUN_WIDTH_TOL : mode === 'wrap' ? maxWidth : Infinity);
  const stopAt = (start, n) => {
    const prev = atoms[start - 1];
    return !even && !box && paragraph && prev?.el.t === 'soft' && prev.el.line + 1 > lastChanged && first + n === prev.el.line + 1;
  };
  const broken = breakAtoms(atoms, widthOf, stopAt);
  // 6) 줄마다 조각 부분(line piece) — 줄바꿈으로 나뉜 줄의 머리 공백은 버린다
  const out = broken.lines.map(([a, b], n) => {
    const seq = []; // { t:'g', atom } | { t:'p', el, text }
    const wrapped = n > 0 && atoms[a - 1]?.t !== 'h';
    let lead = wrapped;
    const lastChar = (() => { for (let k = b - 1; k >= a; k--) if (atoms[k].t === 'c') return k; return -1; })();
    for (let k = a; k < b; k++) {
      const at = atoms[k];
      if (at.t === 'g') {
        // 옛 줄 경계가 줄 가운데로 들어오면 틈 대신 진짜 공백 글자를 앞 조각 끝에 붙인다 — 글자 추출·다음 줄 묶기에서 낱말 사이로 읽힌다
        const prevP = seq[seq.length - 1];
        if (at.el.t === 'soft' && at.w > 0 && prevP?.t === 'p' && k < lastChar) { prevP.text += ' '; continue; }
        seq.push({ t: 'g', atom: at }); continue;
      }
      if (at.t !== 'c') continue;
      if (lead && at.ws) continue;
      lead = false;
      const last = seq[seq.length - 1];
      if (last && last.t === 'p' && last.el === at.el) last.text += at.el.text[at.k];
      else seq.push({ t: 'p', el: at.el, text: at.el.text[at.k] });
    }
    return seq;
  });
  // 7) 객체 고치기: 조각마다 첫 부분은 그 객체(글이 같으면 그대로), 나머지 부분은 새 객체(먼저 — 원래 모양을 본뜨게)
  // 뒤쪽 안정화로 멈췄으면 그 옛 줄부터는 손대지 않는다
  const stopLine = broken.rest < atoms.length ? atoms[broken.rest - 1].el.line + 1 : lines.length;
  const partsOf = new Map(); // item → [{ seq 항목 }]
  out.forEach((seq) => seq.forEach((s) => {
    if (s.t !== 'p') return;
    const it = itemOf(s.el);
    if (!s.text.trim() && s.text !== it.text) { s.t = 'g'; s.atom = { w: (s.el.orig ? it.adv : advOf(it, s.text)).reduce((p, q) => p + q, 0) }; return; } // 고친 공백뿐인 부분은 객체 없이 틈으로
    if (!partsOf.has(it)) partsOf.set(it, []);
    partsOf.get(it).push(s);
  }));
  const remove = new Set(), written = [], substitutes = []; // substitutes: 원래 글꼴에 없는 글자를 그린 대체 글꼴 { orig, used, kind }
  let fallbackFont = false, kept = 0; // kept: 커닝을 지킨 글자 수(rewriteKerned)
  for (const L of lines.slice(first, stopLine)) {
    for (const it of L.items) {
      const ps = partsOf.get(it) || [];
      if (!ps.length) { remove.add(it.idx); it.followers.forEach((x) => remove.add(x)); continue; }
      for (const s of ps.slice(1)) {
        const r = doc.cloneText(i, it.idx, s.text);
        if (!r.ok) throw new Error(r.reason || '나눈 글을 만들지 못했습니다.');
        s.obj = r.idx; fallbackFont ||= !!r.fallbackFont; written.push({ idx: r.idx, text: s.text }); if (r.substitute) substitutes.push(r.substitute);
      }
      ps[0].obj = it.idx;
      // v6 Wave B: TJ 간격(커닝)이 있는 객체의 가운데만 고쳤으면 안 고친 앞뒤 글자는 원래 자리에 둔다(doc.rewriteKerned — 조각 여럿이 함께 움직인다)
      const kr = ps[0].text !== it.text && ps.length === 1 && typeof doc.rewriteKerned === 'function' ? doc.rewriteKerned(i, it.idx, ps[0].text) : null;
      if (kr?.ok) {
        ps[0].obj = kr.idxs[0]; ps[0].follow = kr.idxs.slice(1); ps[0].multi = kr.idxs.map((x, q) => ({ idx: x, text: kr.texts[q] }));
        kr.idxs.forEach((x, q) => written.push({ idx: x, text: kr.texts[q] }));
        fallbackFont ||= !!kr.fallbackFont; if (kr.substitute) substitutes.push(kr.substitute);
        kept += kr.kept;
        it.followers.forEach((x) => remove.add(x));
      } else if (ps[0].text !== it.text) {
        const r = doc.setText(i, it.idx, ps[0].text);
        if (!r?.ok) throw new Error(r?.reason || '텍스트를 수정하지 못했습니다.');
        if (r.idx != null && r.idx !== it.idx) throw new Error('이 글자는 조각별로 고칠 수 없습니다.');
        fallbackFont ||= !!r.fallbackFont; written.push({ idx: it.idx, text: ps[0].text }); if (r.substitute) substitutes.push(r.substitute);
        it.followers.forEach((x) => remove.add(x)); // 겹쳐 그린 사본은 옛 글을 그린다 — 글을 바꾸면 지운다
      } else ps[0].follow = it.followers;
    }
  }
  // 가린 자리 틈을 지웠으면 그 가림 상자도 지운다(가린 글자는 이미 없다)
  for (const el of stream) if (el.t === 'sep' && el.deleted) lines[el.line].masks[el.j].forEach((x) => remove.add(x));
  // 8) 위치: 고쳐 쓴 뒤 실제 글자 위치로 잰 폭으로 줄마다 왼쪽부터 놓는다
  const now = doc.objects(i);
  // 쓴 글(want)의 끝 공백을 텍스트 페이지가 빼고 보고하면(실측: 새로 쓴 "…reflow " 객체의 끝 공백이 objects()에 없다)
  // 그 공백의 진행 폭을 글꼴 폭으로 더한다 — 안 더하면 다음 조각이 공백 없이 바로 붙는다
  const ext = (idx, want) => {
    const g = now[idx]?.glyphs || [];
    if (!g.length) { const b = now[idx].bounds; return { start: b.x0, end: b.x1, ink: b.x1 }; }
    const t = now[idx].text || '';
    let ink = g[0][0];
    g.forEach((q, k) => { if (!/\s/.test(t[k] || '')) ink = Math.max(ink, q[0] + q[2]); });
    let end = g[g.length - 1][0] + g[g.length - 1][2];
    const lost = (want.match(/\s*$/)[0].length) - (t.match(/\s*$/)[0].length);
    if (lost > 0) { const m = doc.measureText(i, idx, ' '.repeat(lost)); if (m.ok) end += m.adv.reduce((a, b) => a + b, 0); }
    return { start: g[0][0], end, ink };
  };
  const moves = []; // [idxs, dx, dy]
  const placed = []; // 줄마다 { x, y, x1(잉크 끝), idxs, pieces: [{ idxs, k(앞에 있는 낱말 틈 수) }], breaks, hardEnd }
  out.forEach((seq, n) => {
    const { x, y } = slot(n), row = { x, y, x1: x, idxs: [], pieces: [], breaks: 0 };
    const [, b] = broken.lines[n];
    row.hardEnd = n === out.length - 1 || atoms[b]?.t === 'h';
    let cursor = x, gap = 0, started = false, brk = false, lastText = '';
    for (const s of seq) {
      if (s.t === 'g') {
        if (started) { gap += s.atom.w; if (s.atom.brk || s.atom.el?.t === 'soft' || /\s/.test(s.atom.el?.value || '')) brk = true; }
        const m = s.atom.el?.t === 'sep' && !s.atom.el.deleted ? lines[s.atom.el.line].masks[s.atom.el.j] : [];
        if (m.length) { // 가린 자리: 틈 시작이 옮겨 간 만큼 가림 상자도
          const L = lines[s.atom.el.line], oldStart = L.items[s.atom.el.j].end;
          moves.push([m, (started ? cursor : x) - oldStart, y - L.y]);
        }
        continue;
      }
      // 커닝을 지키며 나눈 조각(multi)은 첫 조각 시작 ~ 마지막 조각 끝을 한 덩어리로 잰다
      const it = itemOf(s.el), target = started ? cursor + gap : x;
      const e = !s.multi ? ext(s.obj, s.text) : (() => { const es = s.multi.map((q) => ext(q.idx, q.text)); return { start: es[0].start, end: es[es.length - 1].end, ink: Math.max(...es.map((q) => q.ink)) }; })();
      const dx = target - e.start, dy = y - lines[it.line].y;
      moves.push([[s.obj, ...(s.follow || [])], dx, dy]);
      if (started && (brk || /\s$/.test(lastText))) row.breaks++;
      row.pieces.push({ idxs: [s.obj, ...(s.follow || [])], k: row.breaks });
      cursor = target + (e.end - e.start); row.x1 = Math.max(row.x1, target + (e.ink - e.start));
      row.idxs.push(s.obj); started = true; gap = 0; brk = false; lastText = s.text;
    }
    placed.push(row);
  });
  for (const [idxs, dx, dy] of moves) if (Math.abs(dx) > 1e-3 || Math.abs(dy) > 1e-3) doc.move(i, idxs, dx, dy);
  // 9) 넘치면 축소(한 줄 편집) — 줄마다 그 줄의 시작점을 중심으로
  let scaled = null;
  const widest = Math.max(...placed.map((r) => r.x1 - r.x));
  if (!paragraph && mode === 'shrink' && Number.isFinite(maxWidth) && widest > maxWidth) {
    scaled = maxWidth / widest;
    for (const r of placed) { doc.scaleAbout(i, [...r.idxs, ...followersOf(r.idxs)], scaled, r.x, r.y); r.x1 = r.x + (r.x1 - r.x) * scaled; }
  }
  function followersOf(idxs) { return out.flat().filter((s) => s.t === 'p' && idxs.includes(s.obj)).flatMap((s) => s.follow || []); }
  // 10) 정렬 유지(가운데·오른쪽, 한 줄 편집): 새 줄 전체를 옛 줄의 가운데/오른쪽 끝에 맞춘다
  if (!paragraph && align && ['center', 'right'].includes(align.mode || align)) {
    const m = align.mode || align, L = lines[0];
    const x0 = Math.min(...placed.map((r) => r.x)), x1 = Math.max(...placed.map((r) => r.x1));
    const dx = m === 'center' ? ((L.x + L.end) - (x0 + x1)) / 2 : L.end - x1;
    const idxs = placed.flatMap((r) => r.idxs);
    if (Math.abs(dx) > 1e-3 && idxs.length) doc.move(i, [...idxs, ...followersOf(idxs)], dx, 0);
    placed.forEach((r) => { r.x += dx; r.x1 += dx; });
  }
  // 10b) 문단 정렬(v6): 줄마다 상자 폭 안에서 가운데·오른쪽, 양쪽 맞춤은 문단 끝·강제 줄바꿈 줄을 빼고 낱말 틈(조각 사이)에 남는 폭을 나눠 준다.
  //      한 객체 안의 공백은 늘릴 수 없다(PDFium에 낱말 간격 Tw가 없다) — 조각이 낱말마다 나뉜 PDF(Chromium·한글)에서만 고르게 맞는다
  const pAlign = paragraph ? (align?.mode || align) : null;
  if (pAlign && ['center', 'right', 'justify'].includes(pAlign)) {
    placed.forEach((r) => {
      const avail = paraRight - r.x, extra = avail - (r.x1 - r.x);
      if (!r.idxs.length || extra <= 0.01) return;
      if (pAlign === 'justify') {
        if (r.hardEnd || !r.breaks) return;
        for (const pc of r.pieces) if (pc.k) doc.move(i, [...pc.idxs], extra * pc.k / r.breaks, 0);
        r.x1 += extra;
        return;
      }
      const dx = pAlign === 'center' ? extra / 2 : extra;
      doc.move(i, [...r.idxs, ...followersOf(r.idxs)], dx, 0);
      r.x += dx; r.x1 += dx;
    });
  }
  const mine = new Set([...used, ...lines.flatMap((L) => L.masks.flat())]);
  // 10c) 아래 내용 밀기(v6 pushDown): 고친 상자의 새 아래끝이 옛 아래끝보다 내려간 만큼, 같은 단의 아래 내용을 내린다
  let pushed = null;
  if (pushDown && Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5) {
    const now2 = doc.objects(i);
    const y0s = (idxs, list) => idxs.map((x) => list[x]?.bounds?.y0).filter(Number.isFinite);
    const oldBottom = Math.min(...y0s([...used], objects)), newBottom = Math.min(...y0s(placed.flatMap((r) => r.idxs), now2));
    const growth = oldBottom - newBottom;
    if (growth > 0.5 && Number.isFinite(growth)) {
      if (doc.pageSize(i).rotation) pushed = { skipped: 'rotated', growth };
      else {
        const size = lines[lines.length - 1].size, pageH = doc.pageSize(i).h, pageW = doc.pageSize(i).w;
        const colX0 = Math.min(oldLeft, ...placed.map((r) => r.x)), colX1 = Math.max(paraRight, ...lines.map((L) => L.end), ...placed.map((r) => r.x1));
        // 단 안: 가운데가 단 범위(+0.3em 여유) 안이거나, 폭의 절반 이상이 단과 겹친다(줄 끝 글자가 단 끝을 살짝 넘는 경우 포함)
        const tol = 0.3 * size;
        const inCol = (b) => {
          const w = b.x1 - b.x0, ov = Math.min(b.x1, colX1) - Math.max(b.x0, colX0), cx = (b.x0 + b.x1) / 2;
          return (cx >= colX0 - tol && cx <= colX1 + tol) || (w >= 1 && ov > 0 && ov >= 0.5 * w);
        };
        const cand = objects.filter((o) => !mine.has(o.idx) && o.bounds && !o.pageNum && !o.headerFooter && !o.watermark
          && (o.bounds.y1 - o.bounds.y0) < 0.5 * pageH && (o.bounds.x1 - o.bounds.x0) < 0.95 * pageW
          && o.bounds.y1 <= oldBottom + 0.25 * size && inCol(o.bounds)).sort((a, b) => b.bounds.y1 - a.bounds.y1);
        const block = [];
        let cur = oldBottom;
        // 줄 간격 2배 이상 빈 곳에서 멈춘다 — 단, 늘어난 만큼을 그 빈 곳이 다 받아 주지 못하면(겹친다) 그 아래도 민다
        for (const o of cand) {
          const gap = cur - o.bounds.y1;
          if (gap >= 2 * pitch && growth <= gap - 0.5 * pitch) break;
          block.push(o); cur = Math.min(cur, o.bounds.y0);
        }
        if (block.length) {
          const lowest = Math.min(...objects.filter((o) => o.bounds && o.type !== 'other').map((o) => o.bounds.y0)), limit = Math.max(0, Math.min(18, lowest));
          const room = cur - limit;
          if (cur - growth < limit - 0.01) {
            if (overflow === 'keep') pushed = { skipped: 'overflow', growth, room };
            else throw Object.assign(new Error('아래 내용을 밀면 쪽 아래로 넘칩니다. 글자를 줄여 맞추거나 겹쳐 둘지 고르세요.'), { status: 409, extra: { overflow: true, growth: +growth.toFixed(2), room: +room.toFixed(2) } });
          }
          if (!pushed) { doc.move(i, block.map((o) => o.idx), 0, -growth); pushed = { moved: block.length, dy: -growth }; }
        } else pushed = { moved: 0, dy: 0 };
      }
    }
  }
  // 11) 새로 늘어난 줄이 다른 글자와 겹치는지(경고만 — 아래 내용을 밀었으면 겹치지 않는다)
  let overlap = false;
  placed.forEach((r, n) => {
    if (pushed?.moved != null || slot(n).orig || !r.idxs.length) return;
    const size = lines[lines.length - 1].size, y0 = r.y - 0.25 * size, y1 = r.y + 0.85 * size;
    if (objects.some((o) => o.type === 'text' && !mine.has(o.idx) && (o.text || '').trim() && o.bounds && o.bounds.x0 < r.x1 && o.bounds.x1 > r.x && o.bounds.y0 < y1 && o.bounds.y1 > y0)) overlap = true;
  });
  // 12) 지우기(높은 인덱스부터) — 남은 객체의 최종 인덱스를 돌려준다
  const gone = [...remove].sort((a, b) => b - a);
  for (const x of gone) if (!doc.removeObject(i, x).ok) throw new Error('글자 조각을 지우지 못했습니다.');
  const finalIdx = (x) => x - gone.filter((g) => g < x).length;
  const origLines = Math.max(0, lines.length - first);
  return {
    ok: true,
    lineIdxs: placed.flatMap((r) => r.idxs).map(finalIdx),
    written: written.filter((w) => !remove.has(w.idx)).map((w) => ({ idx: finalIdx(w.idx), text: w.text })),
    fallbackFont, scaled, overlap,
    ...(substitutes.length ? { substitutes: [...new Map(substitutes.map((x) => [x.orig + '|' + x.used, x])).values()] } : {}),
    ...(kept ? { kerningKept: kept } : {}),
    addedLines: Math.max(0, placed.length - (paragraph ? origLines : 1)),
    lines: placed.length,
    removed: [...gone].reverse(), // 지운 객체(이 호출 전 번호, 오름차순) — 같은 쪽을 여러 번 고칠 때 앞서 받은 번호를 고친다(찾아 바꾸기)
    ...(pushed ? { pushed } : {}),
    ...(fontScale !== 1 ? { fontScale } : {}),
  };
}
function median(a) { const s = a.slice().sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; }
// 조각 하나의 기하: 글자마다 진행 폭(adv), 시작 x(첫 글자), 끝 x(마지막 글자 진행 끝), 잉크 끝(마지막 공백 아닌 글자), 기준선 y
function itemGeometry(o, line) {
  const t = o.text || '', g = o.glyphs?.length === t.length && t.length ? o.glyphs : null;
  const start = g ? g[0][0] : o.origin.x, end = g ? g[g.length - 1][0] + g[g.length - 1][2] : o.bounds.x1;
  let inkEnd = start;
  if (g) g.forEach((q, k) => { if (!/\s/.test(t[k])) inkEnd = Math.max(inkEnd, q[0] + q[2]); });
  else inkEnd = o.bounds.x1;
  const adv = g ? g.map((q, k) => (k < g.length - 1 ? g[k + 1][0] - q[0] : q[2])) : Array.from(t, () => (end - start) / Math.max(1, t.length));
  const size = o.scaledSize || o.size || 10;
  // 모양 열쇠: 글꼴 이름(서브셋 접두어 포함)·크기·색·기울임 — 같은 열쇠의 글자끼리만 차이 덩어리를 낱말 끝까지 넓힌다(run-edit.snapWords)
  const style = `${o.font}|${size.toFixed(2)}|${(o.color || []).slice(0, 3).join(',')}|${o.matrix ? o.matrix[2].toFixed(2) : 0}`;
  return { idx: o.idx, text: t, line, start, end, inkEnd, adv, y: o.origin.y, size, style, followers: [], calib: null };
}
// 저장·재열기한 문서에서 editRuns가 고쳐 쓴 객체의 글을 확인한다(공백 무시). 다르면 예외 — 트랜잭션이 되돌린다
function verifyRuns(doc, i, result) {
  const objects = doc.objects(i);
  for (const w of result.written || []) {
    const o = objects[w.idx];
    if (!o || o.type !== 'text') throw new Error('저장된 텍스트 위치를 확인하지 못했습니다.');
    if (o.text.replace(/\s/g, '') !== w.text.replace(/\s/g, '')) throw new Error('이 글꼴은 입력한 글자를 그대로 저장하지 못합니다(원본 PDF의 글자 대응 문제). 다른 표기로 바꾸거나 [폰트 맞추기]로 글꼴을 지정하세요.');
  }
  return 0;
}

// ── v6: 밑줄·취소선 선 맞추기 ─────────────────────────────────────────────────
// 쪽에 밑줄·취소선 표시(RetextPdfStyle u·s)나 옛 선(RetextPdfDeco)이 있으면 선을 다시 그린다(doc.syncDeco). 옛 선을 지운 만큼
// result의 객체 번호(lineIdxs·written)를 당겨 고친다. 아무 표시도 없으면 손대지 않는다(예전 문서·시험 결과가 그대로)
function syncDecoAfter(doc, i, result = {}) {
  if (typeof doc.syncDeco !== 'function') return result;
  if (!doc.objects(i).some((o) => o.deco || (o.style && (o.style.u || o.style.s)))) return result;
  const { removed = [] } = doc.syncDeco(i);
  if (!removed.length) return result;
  const fix = (x) => x - removed.filter((r) => r < x).length;
  if (result.lineIdxs) result.lineIdxs = result.lineIdxs.map(fix);
  if (result.written) result.written = result.written.map((w) => ({ ...w, idx: fix(w.idx) }));
  return result;
}

// ── v6: 고른 글자 모양 바꾸기(/api/pdf/style-runs) ─────────────────────────────────
// req: { lines(edit-runs와 같은 줄 모양), oldText(줄 글 — 문단이면 줄 사이 '\n'), from, to(줄 글 위치, 소프트 하이픈 포함 — 비우면 모양 없이 다시 배치만),
//        style: { bold, italic, underline, strike, script, fontId, size, color }, letterSpacing(pt, 고른 글자 사이),
//        paragraph, align, pitch, box, pushDown, overflow, fontScale } — 뒤쪽은 editRuns에 그대로 넘긴다
// 1) 고른 범위의 경계에서 객체를 가른다(splitText — 원래 글꼴로 다시 그릴 수 없는 글자면 그 객체 전체를 고른 것으로 넓힌다: expanded)
// 2) 고른 조각마다 doc.restyleText 3) editRuns(force)로 줄을 다시 놓는다(굵게·크기로 폭이 바뀐 만큼 뒤 조각을 밀고, 문단이면 다시 흘린다)
// 서버 라우트 하나 = 스냅샷 하나라 실행 취소 한 번에 모양·위치가 함께 돌아온다
const STYLE_KEYS = ['bold', 'italic', 'underline', 'strike', 'script', 'fontId', 'size', 'color'];
function styleRuns(doc, i, req = {}) {
  const { lines: reqLines, oldText } = req;
  const style = Object.fromEntries(Object.entries(req.style || {}).filter(([k, v]) => STYLE_KEYS.includes(k) && v !== undefined));
  const letterSpacing = req.letterSpacing == null || req.letterSpacing === '' ? null : Number(req.letterSpacing);
  if (letterSpacing != null && !(letterSpacing >= -5 && letterSpacing <= 50)) throw new Error('자간은 −5~50pt 범위로 입력하세요.');
  if (!Array.isArray(reqLines) || !reqLines.length || reqLines.some((L) => !Array.isArray(L?.objs) || !L.objs.length)) throw new Error('모양을 바꿀 줄이 없습니다.');
  let objects = doc.objects(i);
  // 줄 글과 조각 자리(줄 글 위치)
  let raw = '';
  const spans = []; // { c, s, e, base }
  reqLines.forEach((L, li) => {
    if (li) raw += '\n';
    L.objs.forEach((c, j) => {
      if (j) raw += String(L.seps?.[j - 1] ?? '');
      const o = objects[c?.idx];
      if (!Number.isInteger(c?.idx) || !o || o.type !== 'text') throw new Error('편집할 텍스트 상자를 다시 선택하세요.');
      const t = typeof c.text === 'string' ? c.text : o.text;
      spans.push({ c, s: raw.length, e: raw.length + t.length, base: c.from ?? 0 });
      raw += t;
    });
  });
  if (typeof oldText === 'string' && oldText !== raw) throw new Error('문서가 바뀌었습니다. 줄을 다시 선택하세요.');
  const from = Math.max(0, Math.min(raw.length, Number(req.from) || 0)), to = Math.max(from, Math.min(raw.length, Number(req.to) || 0));
  const restyle = from < to && Object.keys(style).length > 0, spacing = from < to && letterSpacing != null;
  // 1) 가를 자리: 객체 안 부분(15d)의 경계 + 고른 범위의 경계(+ 자간이면 고른 글자마다)
  const cuts = new Map(), selLocal = new Map(); // idx → Set(위치) · idx → [[a, b]] 고른 객체 글 범위
  const addCut = (idx, k) => { if (!cuts.has(idx)) cuts.set(idx, new Set()); cuts.get(idx).add(k); };
  for (const { c, s, e, base } of spans) {
    const o = objects[c.idx];
    if (c.from != null || c.to != null) { addCut(c.idx, c.from ?? 0); addCut(c.idx, c.to ?? o.text.length); }
    if (c.text === '' || !(from < e && to > s)) continue;
    const a = base + Math.max(from, s) - s, b = base + Math.min(to, e) - s;
    if (!selLocal.has(c.idx)) selLocal.set(c.idx, []);
    selLocal.get(c.idx).push([a, b]);
    if (restyle || spacing) { addCut(c.idx, a); addCut(c.idx, b); }
    if (spacing) for (let k = a + 1; k < b; k++) if (!/[\uDC00-\uDFFF]/.test(o.text[k])) addCut(c.idx, k);
  }
  const segs = new Map(); // idx → { bounds, idxs }
  const expanded = [];
  for (const [idx, set] of cuts) {
    const len = objects[idx].text.length, ks = [...set].filter((k) => k > 0 && k < len).sort((a, b) => a - b);
    if (!ks.length) continue;
    const r = doc.splitText(i, idx, ks);
    if (r.ok) { segs.set(idx, { bounds: [0, ...ks, len], idxs: r.idxs }); continue; }
    // 글자 대응이 어긋난 객체: 객체 안 부분(15d) 경계가 있으면 가를 수밖에 없다 — 그 밖에는 객체 전체를 고른 것으로 넓힌다
    if (spans.some((sp) => sp.c.idx === idx && (sp.c.from != null || sp.c.to != null))) throw new Error(r.reason || '글자 조각을 나누지 못했습니다.');
    expanded.push(idx);
    if (selLocal.has(idx)) selLocal.set(idx, [[0, len]]);
  }
  if (segs.size) objects = doc.objects(i);
  // 2) 새 줄 모양(가른 조각 사이는 '') · 고른 조각
  const selected = [], gaps = {};
  const lines = reqLines.map((L) => {
    const objs = [], seps = [];
    let prevSel = false;
    L.objs.forEach((c, j) => {
      const sg = segs.get(c.idx), base = c.from ?? 0, end = c.to ?? (sg ? sg.bounds[sg.bounds.length - 1] : objects[c.idx].text.length);
      const parts = sg ? sg.idxs.map((x, k) => ({ idx: x, a: sg.bounds[k], b: sg.bounds[k + 1] })).filter((q) => q.a >= base && q.b <= end) : [{ idx: c.idx, a: base, b: end }];
      parts.forEach((q, k) => {
        const sep = objs.length ? (k ? '' : String(L.seps?.[j - 1] ?? '')) : null;
        if (sep != null) seps.push(sep);
        if (c.text === '') { objs.push({ idx: q.idx, text: '' }); return; }
        objs.push({ idx: q.idx, text: objects[q.idx].text });
        const inSel = (selLocal.get(c.idx) || []).some(([a, b]) => q.a >= a && q.b <= b && q.b > q.a);
        // 자간: 고른 글자끼리 붙어 있는 자리(사이 글 '')만 — 낱말 사이 띄어쓰기 틈은 그대로 둔다
        if (inSel && spacing && prevSel && sep === '') gaps[q.idx] = letterSpacing;
        prevSel = inSel;
        if (inSel) selected.push({ idx: q.idx, src: c.idx });
      });
    });
    return { objs, seps };
  });
  // 조각 사이 틈은 모양을 바꾸기 전 것으로 지킨다 — 첨자·크기는 객체마다 제 원점을 중심으로 줄고 늘어 끝이 움직이므로, 바꾼 뒤에 재면
  // 틈이 벌어지거나(첨자 "b l u e") 겹친다(굵은 면이 넓다). 자간으로 정한 틈은 그 값
  for (const L of lines) {
    const its = L.objs.filter((o) => o.text !== '').map((o) => itemGeometry(objects[o.idx], 0));
    its.forEach((it, k) => { if (k && gaps[it.idx] == null) gaps[it.idx] = it.start - its[k - 1].end; });
  }
  // 3) 모양 바꾸기(객체 자리는 그대로)
  const skipped = [], faces = new Set(), fake = { bold: false, italic: false };
  if (restyle) {
    for (const { idx } of selected) {
      const r = doc.restyleText(i, idx, style);
      if (!r.ok) throw new Error(r.reason || '글자 모양을 바꾸지 못했습니다.');
      if (r.face) faces.add(r.face);
      fake.bold ||= r.fakeBold; fake.italic ||= r.fakeItalic;
      skipped.push(...(r.skipped || []));
    }
    objects = doc.objects(i);
  }
  // 4) 다시 놓기(글은 그대로) — 굵게·크기·글꼴로 폭이 바뀐 만큼 뒤 조각을 밀고, 문단이면 다시 흘린다
  const lineText = (L) => L.objs.map((o, j) => (j ? L.seps[j - 1] : '') + objects[o.idx].text).join('');
  lines.forEach((L) => L.objs.forEach((o) => { if (o.text !== '') o.text = objects[o.idx].text; }));
  const newRaw = lines.map(lineText).join('\n');
  const result = editRuns(doc, i, {
    lines, oldText: newRaw, newText: newRaw.replace(/­/g, ''), force: true, gaps,
    paragraph: !!req.paragraph, mode: req.paragraph ? undefined : (req.mode || 'none'), maxWidth: req.maxWidth,
    align: req.align, pitch: req.pitch, box: req.box, pushDown: !!req.pushDown, overflow: req.overflow, fontScale: req.fontScale,
  });
  return { ...result, styled: selected.length, expanded: expanded.length, skipped: [...new Set(skipped)], faces: [...faces], fake };
}

// ── v6: 찾아 바꾸기(/api/pdf/replace) ─────────────────────────────────────────
const fr = require('./find-replace');
const { groupLines } = require('./text-grouping');
const mergedLines = (objs) => groupLines(objs, { mergeStyledRuns: true });
const runLineOf = (line) => ({ objs: line.objs.map((o) => ({ idx: o.idx, text: o.text, ...(o.partFrom != null ? { from: o.partFrom, to: o.partFrom + o.text.length } : {}) })), seps: line.seps });
const MATCH_LIMIT = 2000;
// 일치의 쪽 위 사각형(글자 위치로) — 화면이 현재 일치를 칠한다
function matchRect(line, at, len) {
  const raw = line.text, d2r = [];
  for (let r = 0; r < raw.length; r++) if (raw[r] !== '­') d2r.push(r);
  d2r.push(raw.length);
  const a = d2r[at], b = d2r[at + len] ?? raw.length;
  let off = 0, box = null;
  line.objs.forEach((o, j) => {
    const s = off, e = off + o.text.length; off = e + (line.seps[j] || '').length;
    const lo = Math.max(a, s), hi = Math.min(b, e);
    if (lo >= hi) return;
    const g = o.glyphs?.length === o.text.length ? o.glyphs : null;
    const x0 = g ? g[lo - s][0] : o.bounds.x0, x1 = g ? g[hi - s - 1][0] + g[hi - s - 1][2] : o.bounds.x1;
    const r = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: o.bounds.y0, y1: o.bounds.y1 };
    box = box ? { x0: Math.min(box.x0, r.x0), y0: Math.min(box.y0, r.y0), x1: Math.max(box.x1, r.x1), y1: Math.max(box.y1, r.y1) } : r;
  });
  return box;
}
// 문서 전체(또는 pages)의 일치 목록: [{ i, line(쪽 안 줄 번호 — 읽기 순서), at, len, lineText, context, rect, masked, editable, reason }]
function findInDoc(doc, query, opts = {}, pages = null) {
  const out = [];
  for (const i of pages || Array.from({ length: doc.pageCount }, (_, k) => k)) {
    const lines = mergedLines(doc.objects(i));
    lines.forEach((line, k) => {
      const ms = fr.lineMatches(line, query, opts);
      if (!ms.length) return;
      const block = fr.editBlock(line), disp = line.text.replace(/­/g, '');
      for (const m of ms) {
        if (out.length >= MATCH_LIMIT) return;
        out.push({ i, line: k, at: m.at, len: m.len, lineText: line.text, context: fr.context(disp, m.at, m.len), rect: matchRect(line, m.at, m.len), masked: m.masked, editable: !m.masked && !block, reason: m.masked ? '가린 자리' : block });
      }
    });
  }
  return out;
}
// 바꾸기: target이 있으면 그 일치 하나({ i, line, at, lineText }), 없으면 문서 전체. 바꿀 줄마다 editRuns(조각별 모양 보존, 넘치면 그대로 둔다).
// 같은 쪽을 여러 번 고치므로 고칠 때마다 줄을 다시 묶고(번호가 바뀐다), 앞서 쓴 객체 번호(written)는 지운 객체만큼 당긴다.
// 반환 { count, pages:[쪽], written: { [i]: [{ idx, text }] }, skipped: [{ i, context, reason }] }
function replaceInDoc(doc, query, replacement, opts = {}, target = null) {
  if (!String(query || '')) throw Object.assign(new Error('찾을 말을 넣으세요.'), { status: 400 });
  if (typeof replacement !== 'string' || replacement.length > 2000 || /[\r\n]/.test(replacement)) throw Object.assign(new Error('바꿀 말은 한 줄(2,000자 이하)로 넣으세요.'), { status: 400 });
  const written = {}, skipped = [], pages = new Set();
  let count = 0;
  const editLine = (i, line, ms) => {
    const disp = line.text.replace(/­/g, ''), newText = fr.applyReplace(disp, ms, replacement);
    const r = editRuns(doc, i, { lines: [runLineOf(line)], oldText: line.text, newText, mode: 'none' });
    const gone = r.removed || [];
    const kept = (written[i] || []).filter((w) => !gone.includes(w.idx)).map((w) => ({ ...w, idx: w.idx - gone.filter((g) => g < w.idx).length }));
    written[i] = [...kept, ...(r.written || [])];
    count += ms.length; pages.add(i);
    return r;
  };
  const pageList = target ? [target.i] : Array.from({ length: doc.pageCount }, (_, k) => k);
  for (const i of pageList) {
    if (!Number.isInteger(i) || i < 0 || i >= doc.pageCount) throw Object.assign(new Error('쪽 번호가 잘못됐습니다.'), { status: 400 });
    let lines = mergedLines(doc.objects(i));
    if (target) {
      const k = Number.isInteger(target.line) && lines[target.line]?.text === target.lineText ? target.line : lines.findIndex((L) => L.text === target.lineText);
      const m = k >= 0 ? fr.lineMatches(lines[k], query, opts).find((x) => x.at === target.at) : null;
      if (!m) throw Object.assign(new Error('문서가 바뀌었습니다. 다시 찾으세요.'), { status: 409 });
      const block = m.masked ? '가린 자리' : fr.editBlock(lines[k]);
      if (block) throw Object.assign(new Error(`이 자리는 바꿀 수 없습니다(${block}).`), { status: 400 });
      editLine(i, lines[k], [m]);
      break;
    }
    for (let k = 0; k < lines.length; k++) {
      const line = lines[k], ms = fr.lineMatches(line, query, opts);
      if (!ms.length) continue;
      const disp = line.text.replace(/­/g, ''), block = fr.editBlock(line);
      for (const m of ms) if (m.masked || block) skipped.push({ i, context: fr.context(disp, m.at, m.len), reason: m.masked ? '가린 자리' : block });
      const ok = block ? [] : ms.filter((m) => !m.masked);
      if (!ok.length) continue;
      const r = editLine(i, line, ok);
      lines = mergedLines(doc.objects(i));
      const nk = lines.findIndex((L) => L.objs.some((o) => (r.lineIdxs || []).includes(o.idx)));
      if (nk >= 0) k = Math.max(k, nk); // 고친 줄 다음부터(묶음이 바뀌어도 앞으로만 간다)
    }
  }
  // 밑줄·취소선 선을 고친 쪽마다 다시 그린다(written 번호도 함께 고친다)
  for (const i of pages) written[i] = syncDecoAfter(doc, i, { written: written[i] || [] }).written;
  return { count, pages: [...pages], written, skipped };
}

module.exports = { applyEdits, verifyEdits, maskParts, mergeLineCovers, tiltCover, mergeTiltCovers, normalizeParts, redactRanges, redactArea, editRuns, verifyRuns, styleRuns, syncDecoAfter, findInDoc, replaceInDoc };
