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

// 가리기(/api/pdf/mask와 tools/demo-assets.js가 같이 쓴다). parts: [{ idx, from, to }] — 글자를 텍스트에서 실제로 지우고(redact),
// 덮개는 다 지운 뒤 줄마다 하나씩 그린다(4.0.1 이전에는 글자·조각마다 따로 그려 높이가 들쭉날쭉했다).
// 하나라도 가렸으면 ok:true(건너뛴 조각은 skipped). 아무것도 못 가렸으면 ok:false — 호출한 쪽(mutate)이 문서를 되돌린다
function maskParts(doc, i, parts, { color, fallbackRects = [] } = {}) {
  const covers = [], skipped = [], rects = [];
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
      const cleared = doc.setText(i, idx, ' ');
      if (!cleared?.ok) { skipped.push({ idx, reason: cleared?.reason || 'clear' }); continue; } // 글자가 남는데 덮기만 하면 안 된다
      // 같은 자리에 겹쳐 그린 사본(굵게·그림자용)도 비운다 — 안 비우면 저장 뒤 사본에서 가린 글자가 다시 읽힌다.
      // _setOneRaw는 객체 자리를 유지한다(setText는 투명 사본을 드러내며 맨 뒤로 옮겨 남은 parts의 인덱스를 민다)
      for (const j of r.twins || []) {
        const t = doc._setOneRaw(i, j, ' ');
        if (!t?.ok) skipped.push({ idx: j, reason: t?.reason || 'twin' });
      }
      if (obj && obj.bounds) {
        const b = obj.bounds;
        covers.push(band ? { rect: { x0: b.x0, x1: b.x1, y0: Math.min(b.y0, band.y0), y1: Math.max(b.y1, band.y1) }, line: { y: band.y, em: band.em } } : { rect: b });
      }
    } else skipped.push({ idx, reason: r.reason });
  }
  // 덮개 색은 글자를 다 지운 뒤 합친 상자에서 잰다('auto')
  for (const b of mergeLineCovers(covers)) { doc.addRect(i, b, colFor(b)); rects.push(b); }
  for (const b of fallbackRects || []) { doc.addRect(i, b, colFor(b)); rects.push(b); }
  return { ok: rects.length > 0, rects, skipped };
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

function editRuns(doc, i, req = {}) {
  const { lines: reqLines, oldText, newText, mode = 'none', align, paragraph = false } = req;
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
  if (!paragraph && Number.isFinite(maxWidth)) maxWidth = Math.max(maxWidth, Math.max(...lines.map((L) => L.end - L.x)) + RUN_WIDTH_TOL);
  const raw = lines.map((L) => L.items.map((it, j) => (j ? L.seps[j - 1] : '') + it.text).join('')).join('\n');
  if (typeof oldText === 'string' && oldText !== raw) throw new Error('문서가 바뀌었습니다. 줄을 다시 선택하세요.');
  // 조각 사이 틈(옛 위치)과 가린 자리(■)를 덮은 가림 상자
  for (const L of lines) {
    L.gaps = L.items.slice(1).map((it, j) => it.start - L.items[j].end);
    L.masks = L.items.slice(1).map((it, j) => (/■/.test(L.seps[j]) ? objects.filter((m) => m.mask && m.bounds && m.bounds.x0 >= L.items[j].end - 1 && m.bounds.x1 <= it.start + 1
      && m.bounds.y0 < L.y + L.size && m.bounds.y1 > L.y - 0.3 * L.size).map((m) => m.idx) : []));
  }
  // 3) 글자 차이 → 조각 배정
  const plan = planRuns(lines.map((L) => ({ items: L.items.map((it) => ({ text: it.text, style: it.style })), seps: L.seps })), newText);
  const allIdxs = () => lines.flatMap((L) => L.items.map((it) => it.idx));
  if (!plan.changed) return { ok: true, unchanged: true, lineIdxs: allIdxs(), written: [], fallbackFont: false };
  const first = plan.firstChanged;
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
  const pitch = lines.length > 1 ? median(lines.slice(1).map((L, k) => lines[k].y - L.y)) : 1.2 * lines[0].size;
  const extraX = lines.length > 1 ? lines[1].x : lines[0].x;
  const slot = (n) => {
    const k = first + n;
    if (k < lines.length) return { x: lines[k].x, y: lines[k].y, orig: true };
    return { x: extraX, y: lines[lines.length - 1].y - (k - lines.length + 1) * pitch, orig: false };
  };
  const paraRight = Math.max(...lines.map((L) => L.end));
  const widthOf = (n) => (paragraph ? paraRight - slot(n).x + RUN_WIDTH_TOL : mode === 'wrap' ? maxWidth : Infinity);
  const stopAt = (start, n) => {
    const prev = atoms[start - 1];
    return paragraph && prev?.el.t === 'soft' && prev.el.line + 1 > plan.lastChanged && first + n === prev.el.line + 1;
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
  const remove = new Set(), written = [];
  let fallbackFont = false;
  for (const L of lines.slice(first, stopLine)) {
    for (const it of L.items) {
      const ps = partsOf.get(it) || [];
      if (!ps.length) { remove.add(it.idx); it.followers.forEach((x) => remove.add(x)); continue; }
      for (const s of ps.slice(1)) {
        const r = doc.cloneText(i, it.idx, s.text);
        if (!r.ok) throw new Error(r.reason || '나눈 글을 만들지 못했습니다.');
        s.obj = r.idx; fallbackFont ||= !!r.fallbackFont; written.push({ idx: r.idx, text: s.text });
      }
      ps[0].obj = it.idx;
      if (ps[0].text !== it.text) {
        const r = doc.setText(i, it.idx, ps[0].text);
        if (!r?.ok) throw new Error(r?.reason || '텍스트를 수정하지 못했습니다.');
        if (r.idx != null && r.idx !== it.idx) throw new Error('이 글자는 조각별로 고칠 수 없습니다.');
        fallbackFont ||= !!r.fallbackFont; written.push({ idx: it.idx, text: ps[0].text });
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
  const placed = []; // 줄마다 { x, y, x1(잉크 끝), idxs }
  out.forEach((seq, n) => {
    const { x, y } = slot(n), row = { x, y, x1: x, idxs: [] };
    let cursor = x, gap = 0, started = false;
    for (const s of seq) {
      if (s.t === 'g') {
        if (started) gap += s.atom.w;
        const m = s.atom.el?.t === 'sep' && !s.atom.el.deleted ? lines[s.atom.el.line].masks[s.atom.el.j] : [];
        if (m.length) { // 가린 자리: 틈 시작이 옮겨 간 만큼 가림 상자도
          const L = lines[s.atom.el.line], oldStart = L.items[s.atom.el.j].end;
          moves.push([m, (started ? cursor : x) - oldStart, y - L.y]);
        }
        continue;
      }
      const it = itemOf(s.el), e = ext(s.obj, s.text), target = started ? cursor + gap : x;
      const dx = target - e.start, dy = y - lines[it.line].y;
      moves.push([[s.obj, ...(s.follow || [])], dx, dy]);
      cursor = target + (e.end - e.start); row.x1 = Math.max(row.x1, target + (e.ink - e.start));
      row.idxs.push(s.obj); started = true; gap = 0;
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
  // 11) 새로 늘어난 줄이 다른 글자와 겹치는지(경고만)
  const mine = new Set([...used, ...lines.flatMap((L) => L.masks.flat())]);
  let overlap = false;
  placed.forEach((r, n) => {
    if (slot(n).orig || !r.idxs.length) return;
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
    addedLines: Math.max(0, placed.length - (paragraph ? origLines : 1)),
    lines: placed.length,
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

module.exports = { applyEdits, verifyEdits, maskParts, mergeLineCovers, normalizeParts, redactRanges, redactArea, editRuns, verifyRuns };
