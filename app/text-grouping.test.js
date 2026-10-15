// 자체 검사: node app/text-grouping.test.js
// 합성 객체로 groupLines의 순수 함수 단위 검사를 하고(①~⑦, SPEC-line-grouping.md 참고),
// 저장소 표본(workspace/*)으로 실제 PDF 통합 검사를 한다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { groupLines } = require('./text-grouping');
const { open } = require('./pdf-engine');

const WS = path.join(__dirname, '..', 'workspace');

// 합성 텍스트 객체. matrix는 [1, skewB, 0, 1, originX, originY] — 회전·기울임 없는 보통 글자는 skewB=0이라
// origin.y(=matrix[5])가 그대로 기준선이고, scaledSize = size(행렬 배율 1이므로).
let nextIdx = 0;
function T(text, { x0, y0, x1, y1, originX = x0, originY = y0, size = 10, font = 'Helvetica', fontId, hidden = false, color = [0, 0, 0, 255], group = null, skewB = 0 }) {
  const matrix = [1, skewB, 0, 1, originX, originY];
  return {
    idx: nextIdx++, type: 'text', text, bounds: { x0, y0, x1, y1 },
    size, font, fontId, hidden, color, group,
    matrix, origin: { x: originX, y: originY }, scaledSize: size * Math.hypot(matrix[0], matrix[1]),
  };
}
// 세로 괘선(표 경계) 후보 — 비텍스트 객체.
function rule({ x0, y0, x1, y1 }) { return { idx: nextIdx++, type: 'path', text: null, bounds: { x0, y0, x1, y1 } }; }

// ① 같은 기준선·간격 0.3×글자크기 → 한 상자
{
  const a = T('9', { x0: 0, y0: 0, x1: 9, y1: 10 });
  const b = T('월', { x0: 12, y0: 0, x1: 21, y1: 10 }); // 간격 (12-9)/10 = 0.3
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 1, '① 간격 0.3 → 한 상자');
  assert.strictEqual(lines[0].text, '9월');
}

// ② 같은 기준선·간격 2.0×글자크기 → 두 상자
{
  const a = T('A', { x0: 0, y0: 0, x1: 9, y1: 10 });
  const b = T('B', { x0: 29, y0: 0, x1: 38, y1: 10 }); // 간격 (29-9)/10 = 2.0
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 2, '② 간격 2.0 → 두 상자');
}

// ③ 간격 0.3인데 사이에 세로선(폭 1pt) → 두 상자 (표 경계 안전장치)
{
  const a = T('가', { x0: 0, y0: 0, x1: 9, y1: 10 });
  const b = T('나', { x0: 12, y0: 0, x1: 21, y1: 10 }); // 간격 0.3, ③ 없으면 합쳐질 조건
  const line = rule({ x0: 10, y0: -1, x1: 11, y1: 11 }); // 폭 1pt(<3), 높이 12pt(>4), a·b 사이(10~11), y 겹침
  const lines = groupLines([a, b, line]);
  assert.strictEqual(lines.length, 2, '③ 사이에 세로선 → 두 상자');
}

// ④ 간격 0.3인데 글꼴 다름 → 두 상자
{
  const a = T('A', { x0: 0, y0: 0, x1: 9, y1: 10, font: 'Helvetica' });
  const b = T('B', { x0: 12, y0: 0, x1: 21, y1: 10, font: 'Times' });
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 2, '④ 글꼴 다름 → 두 상자');
}

// ⑤ 간격 0.3인데 하나만 hidden → 두 상자
{
  const a = T('A', { x0: 0, y0: 0, x1: 9, y1: 10, hidden: false });
  const b = T('B', { x0: 12, y0: 0, x1: 21, y1: 10, hidden: true });
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 2, '⑤ hidden 다름 → 두 상자');
}

// ⑥ bounds.y0는 다르지만 origin.y가 같음 → 한 상자 (이번 수정의 핵심: 기준선 vs 잉크 아래끝)
{
  // 받침 있는 글자처럼 잉크 상자 아래끝(bounds.y0)이 5pt나 다르지만, 실제로 그려진 기준선(origin.y)은 둘 다 0
  const a = T('한', { x0: 0, y0: 0, x1: 9, y1: 10, originY: 0 });
  const b = T('글', { x0: 12, y0: 5, x1: 21, y1: 15, originY: 0 }); // bounds.y0=5 ≠ a의 0, 그러나 originY는 같다
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 1, '⑥ origin.y가 같으면 bounds.y0가 달라도 한 상자');
  assert.strictEqual(lines[0].text, '한글');
}

// ⑦ 그룹 마크가 있으면 떨어져 있어도 한 상자에 seps가 '\n' (줄바꿈 편집·Shift 묶음)
{
  const a = T('첫째 줄', { x0: 0, y0: 95, x1: 9, y1: 105, originY: 100, group: 'g1' });
  const b = T('둘째 줄', { x0: 0, y0: 75, x1: 9, y1: 85, originY: 80, group: 'g1' }); // 기준선 차이 20 ≫ 0.2×10
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 1, '⑦ 그룹 마크 → 떨어져 있어도 한 상자');
  assert.strictEqual(lines[0].group, 'g1');
  assert.deepStrictEqual(lines[0].seps, ['\n']);
  assert.strictEqual(lines[0].text, '첫째 줄\n둘째 줄');
}

// ⑧ 둘 다 hidden·간격 2.0×크기 → 한 상자 (그림 위 투명 텍스트는 병합 경계를 3.0까지 넓힌다)
{
  const a = T('가', { x0: 0, y0: 0, x1: 9, y1: 10, hidden: true });
  const b = T('나', { x0: 29, y0: 0, x1: 38, y1: 10, hidden: true }); // 간격 (29-9)/10 = 2.0
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 1, '⑧ 둘 다 hidden·간격 2.0 → 한 상자');
  assert.strictEqual(lines[0].text, '가나');
}

// ⑨ ⑧과 같은 좌표인데 hidden이 아니면 → 두 상자 (일반 텍스트는 여전히 0.6 경계)
{
  const a = T('가', { x0: 0, y0: 0, x1: 9, y1: 10, hidden: false });
  const b = T('나', { x0: 29, y0: 0, x1: 38, y1: 10, hidden: false });
  const lines = groupLines([a, b]);
  assert.strictEqual(lines.length, 2, '⑨ 보이는 글자는 간격 2.0 → 두 상자(변화 없음)');
}

// ⑩ 둘 다 hidden·간격 2.0인데 사이에 세로선 → 두 상자 (표 칸 경계 검사는 hidden에서도 유지)
{
  const a = T('가', { x0: 0, y0: 100, x1: 9, y1: 110, originY: 105, hidden: true });
  const b = T('나', { x0: 29, y0: 100, x1: 38, y1: 110, originY: 105, hidden: true });
  const mid = (a.bounds.x1 + b.bounds.x0) / 2;
  const line = rule({ x0: mid - 1, x1: mid + 1, y0: 95, y1: 115 });
  const lines = groupLines([a, b, line]);
  assert.strictEqual(lines.length, 2, '⑩ hidden이어도 세로선 있으면 두 상자');
}

// ⑪ 둘 다 hidden, 글꼴 이름이 서브셋 접두어(BCDEEE+)만 다름 → 한 상자 (실측: 그림 글자 덱의 조각 대부분이 이 경우)
{
  const a = T('가', { x0: 0, y0: 100, x1: 9, y1: 110, originY: 105, hidden: true, font: 'BCDEEE+Calibri-Bold' });
  const b = T('나', { x0: 12, y0: 100, x1: 21, y1: 110, originY: 105, hidden: true, font: 'Calibri-Bold' });
  assert.strictEqual(groupLines([a, b]).length, 1, '⑪ hidden끼리는 접두어 뗀 글꼴 이름으로 비교');
}

// ⑫ 보이는 글자도 서브셋 접두어만 다르면 한 상자
{
  const a = T('가', { x0: 0, y0: 100, x1: 9, y1: 110, originY: 105, font: 'BCDEEE+Pretendard-Bold' });
  const b = T('나', { x0: 12, y0: 100, x1: 21, y1: 110, originY: 105, font: 'FGHIJK+Pretendard-Bold' });
  assert.strictEqual(groupLines([a, b]).length, 1, '⑫ 보이는 글자는 서브셋 접두어 차이를 무시');
}

// ⑬ 접두어 정규화 뒤에도 서로 다른 굵기와 명시적 fontId는 분리
{
  const a = T('가', { x0: 0, y0: 100, x1: 9, y1: 110, originY: 105, font: 'BCDEEE+Pretendard-Bold' });
  const bold = T('나', { x0: 12, y0: 100, x1: 21, y1: 110, originY: 105, font: 'FGHIJK+Pretendard-Regular' });
  assert.strictEqual(groupLines([a, bold]).length, 2, '⑬ Bold와 Regular는 분리');
  const idA = T('다', { x0: 0, y0: 100, x1: 9, y1: 110, originY: 105, font: 'Pretendard-Bold', fontId: 'font-a' });
  const idB = T('라', { x0: 12, y0: 100, x1: 21, y1: 110, originY: 105, font: 'Pretendard-Bold', fontId: 'font-b' });
  assert.strictEqual(groupLines([idA, idB]).length, 2, '⑬ 명시적 fontId가 다르면 분리');
}

// ⑭ 전자계약 입력 칸: 글자마다 사이에 빈 흰색 조각(크기 0) + 밑에 다른 글꼴의 넓은 공백 → 공백·빈 조각은 줄을 끊지 않는다
{
  const ink = [35, 31, 32, 255], font = 'FDKRVC+NotoSansCJKkr-Regular';
  const objs = [
    T('1', { x0: 0, y0: 100, x1: 5, y1: 110, originY: 100, size: 10, font, color: ink }),
    T(' ', { x0: 2, y0: 100, x1: 70, y1: 109, originY: 100.8, size: 9.6, font: 'BERSWC+Dotum' }),
    T('', { x0: 5.5, y0: 100, x1: 5.5, y1: 100, originX: 5.5, originY: 100, size: 0, font, color: [255, 255, 255, 255] }),
    T('2', { x0: 6, y0: 100, x1: 11, y1: 110, originX: 5.5, originY: 100, size: 10, font, color: ink }),
    T('', { x0: 11.5, y0: 100, x1: 11.5, y1: 100, originX: 11.5, originY: 100, size: 0, font, color: [255, 255, 255, 255] }),
    T('3', { x0: 12, y0: 100, x1: 17, y1: 110, originX: 11.5, originY: 100, size: 10, font, color: ink }),
  ];
  const lines = groupLines(objs);
  assert.strictEqual(lines.length, 1, '⑭ 빈 조각이 끼어도 입력 칸은 한 상자');
  assert.strictEqual(lines[0].text, '123', '⑭ 상자 글은 입력 글자만');
}

// ⑮ Chromium PDF: 낱말 조각("9월") 뒤에 공백만 든 조각(" ")이 있다 → 줄 글은 한 칸, 공백 조각도 objs에 남고 가리기 위치는 맞는다.
// (엔진 객체 텍스트는 이제 그 객체가 그린 글자뿐이라 PDFium이 붙이던 "월 "의 뒤 공백이 없다 — pdf-engine objText)
// 진짜 공백이 두 개 이어지면(앞 조각 끝 공백 + 공백 조각) 둘 다 남긴다 — 겹공백을 지우지 않는다(입력 칸 정렬용 공백 등)
{
  const a = T('9월', { x0: 0, y0: 0, x1: 22, y1: 10 });
  const sp = T(' ', { x0: 22, y0: 0, x1: 25, y1: 10, originX: 22 });
  const b = T('첫째', { x0: 25, y0: 0, x1: 45, y1: 10, originX: 25 });
  const lines = groupLines([a, sp, b]);
  assert.strictEqual(lines.length, 1, '⑮ 한 상자');
  assert.strictEqual(lines[0].text, '9월 첫째', '⑮ 공백 조각이 낱말 사이 한 칸');
  assert.deepStrictEqual(lines[0].objs.map((o) => o.idx), [a.idx, sp.idx, b.idx], '⑮ 공백 조각도 objs에 남아 편집·이동 때 함께 처리된다');
  // index.html의 mapRangeToParts와 같은 계산: "첫째"(3~5)를 고르면 b의 0~2만 가린다
  let off = 0; const parts = [];
  for (const o of lines[0].objs) { const s = off, e = off + o.text.length; off = e; const x = Math.max(3, s), y = Math.min(5, e); if (x < y) parts.push({ idx: o.idx, from: x - s, to: y - s }); }
  assert.deepStrictEqual(parts, [{ idx: b.idx, from: 0, to: 2 }], '⑮ 가리기 글자 위치가 어긋나지 않는다');
  const a2 = T('9월 ', { x0: 0, y0: 20, x1: 22, y1: 30, originY: 20 });
  const sp2b = T(' ', { x0: 22, y0: 20, x1: 25, y1: 30, originX: 22, originY: 20 });
  const b2 = T('첫째', { x0: 25, y0: 20, x1: 45, y1: 30, originX: 25, originY: 20 });
  assert.strictEqual(groupLines([a2, sp2b, b2])[0].text, '9월  첫째', '⑮ 진짜 겹공백은 그대로');
  // 앞 글이 공백으로 끝나지 않으면 공백 조각은 그대로 글에 들어간다(낱말 사이 공백이 그 조각뿐인 PDF)
  const c = T('A', { x0: 0, y0: 50, x1: 9, y1: 60, originY: 50 });
  const sp2 = T(' ', { x0: 9, y0: 50, x1: 12, y1: 60, originX: 9, originY: 50 });
  const d = T('B', { x0: 12, y0: 50, x1: 21, y1: 60, originX: 12, originY: 50 });
  assert.strictEqual(groupLines([c, sp2, d])[0].text, 'A B', '⑮ 유일한 공백은 지우지 않는다');
}

// ⑯ 가린 자리: 글자가 지워져 틈이 벌어져도 가림 상자가 틈을 덮으면 한 줄, 틈은 ■로 보이고 가리기 위치 대응이 맞다
{
  const mask = (x0, x1) => ({ ...rule({ x0, y0: -1, x1, y1: 11 }), mask: true });
  const a = T('대표, ', { x0: 0, y0: 0, x1: 20, y1: 10 });
  const b = T(', 재무', { x0: 60, y0: 0, x1: 80, y1: 10, originX: 60 }); // 틈 40pt = 4×글자크기
  const lines = groupLines([a, b, mask(22, 41), mask(41, 59)]);
  assert.strictEqual(lines.length, 1, '⑯ 가림 상자가 틈을 덮으면 한 줄');
  assert.strictEqual(lines[0].text, '대표, ■■■■, 재무', '⑯ 틈은 ■ 자리 표시(40pt / 0.9em ≈ 4글자)');
  assert.deepStrictEqual(lines[0].seps, ['■■■■']);
  // mapRangeToParts와 같은 계산: "재무"(10~12)는 b의 2~4
  let off = 0; const parts = [];
  for (const [j, o] of lines[0].objs.entries()) { const s = off, e = off + o.text.length; off = e + (lines[0].seps[j] || '').length; const x = Math.max(10, s), y = Math.min(12, e); if (x < y) parts.push({ idx: o.idx, from: x - s, to: y - s }); }
  assert.deepStrictEqual(parts, [{ idx: b.idx, from: 2, to: 4 }], '⑯ 자리 표시 뒤 가리기 위치가 맞다');
  // 가림 상자가 틈 일부만 덮으면(사이에 덮이지 않은 15pt) 잇지 않는다
  assert.strictEqual(groupLines([a, b, mask(22, 30), mask(45, 59)]).length, 2, '⑯ 덮이지 않은 틈이 있으면 두 줄');
  // 가림 상자가 없으면 지금처럼 두 줄
  assert.strictEqual(groupLines([a, b]).length, 2, '⑯ 가림 상자 없으면 두 줄');
  // 표 칸 경계(세로 괘선)는 가림 상자가 덮어도 넘지 않는다
  assert.strictEqual(groupLines([a, b, mask(22, 59), rule({ x0: 40, y0: -1, x1: 41, y1: 11 })]).length, 2, '⑯ 세로 괘선이 있으면 두 줄');
}

// 글자 위치(glyphs)까지 있는 합성 객체 — 엔진 objects()와 같은 모양. 글자마다 진행 폭 w(기본 0.5em), 공백은 0.3em
function G(text, x, y, { size = 10, w = 0.5, font = 'Helvetica', color = [0, 0, 0, 255], angle = 0 } = {}) {
  const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
  const glyphs = []; let u = 0;
  for (const ch of text) { const adv = (/\s/.test(ch) ? 0.3 : w) * size; glyphs.push([x + u * c, y + u * s, adv]); u += adv; }
  const ends = [[x, y], [x + u * c, y + u * s], [x - size * s, y + size * c], [x + u * c - size * s, y + u * s + size * c]];
  const xs = ends.map((p) => p[0]), ys = ends.map((p) => p[1]);
  const matrix = [c, s, -s, c, x, y];
  return { idx: nextIdx++, type: 'text', text, size, font, color, hidden: false, group: null, glyphs, matrix, origin: { x, y }, scaledSize: size,
    bounds: { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } };
}
// 진행 폭으로 이어 붙인 조각들(앞 조각 끝 + gapEm×크기에서 다음 조각 시작)
// angle이면 글자 방향으로 이어 붙인다(기준선 시작점 (x0, y))
function run(parts, y, opts = {}, x0 = 0) {
  let u = 0; const size = opts.size || 10, a = (opts.angle || 0) * Math.PI / 180;
  return parts.map(([t, gapEm = 0, o = {}]) => {
    const g = G(t, x0 + u * Math.cos(a), y + u * Math.sin(a), { ...opts, ...o });
    u += g.glyphs.reduce((s2, q) => s2 + q[2], 0) + gapEm * size;
    return g;
  });
}

// ⑰ 입력 칸: 공백만 든 조각이 여러 개 이어져도 틈을 잇는 징검다리가 되지 않는다("이름: 김영희␣×10 날짜") → 두 상자
{
  const objs = run([['이름:'], [' '], ['김영희'], ...Array.from({ length: 10 }, () => [' ']), ['날짜:'], [' '], ['2026']], 0);
  const lines = groupLines(objs);
  assert.deepStrictEqual(lines.map((l) => l.text), ['이름: 김영희', '날짜: 2026'], '⑰ 공백 조각 여러 개 = 칸 경계');
}
// ⑱ 공백 글자가 있는 줄의 공백 없는 0.62em 틈 = 칸 경계, 공백 없는 줄의 0.65em 틈 = 낱말 사이(한 줄 + 공백 한 칸)
{
  assert.deepStrictEqual(groupLines(run([['Name:'], [' '], ['John', 0.62], ['Date:']], 0)).map((l) => l.text), ['Name: John', 'Date:'], '⑱ 공백 있는 줄');
  assert.deepStrictEqual(groupLines(run([['Loose', 0.65], ['spacing']], 0)).map((l) => l.text), ['Loose spacing'], '⑱ 공백 없는 줄은 1.5em까지 잇고 한 칸 넣는다');
  assert.deepStrictEqual(groupLines(run([['A', 0.3], ['B', 0.3], ['C']], 0)).map((l) => l.text), ['ABC'], '⑱ 고른 자간은 공백이 아니다');
}
// ⑲ 위·아래 첨자는 본문 줄에 붙는다(크기·기준선이 달라도) — 상자 하나
{
  const body = run([['H'], ['2', 0, { size: 7 }], ['O']], 100);
  body[1].origin.y = 97; body[1].matrix[5] = 97; body[1].glyphs[0][1] = 97; // 아래첨자: 기준선 −0.3em
  const lines = groupLines(body);
  assert.deepStrictEqual(lines.map((l) => l.text), ['H2O'], '⑲ 아래첨자');
}
// ⑳ 회전 글자: 글자 방향 좌표로 묶는다 — 90° 세로 줄 하나, -20° 줄 하나
{
  const v = run([['세'], ['로'], [' '], ['줄']], 0, { angle: 90 });
  const t = run([['A'], ['p'], ['p'], [' '], ['2'], ['0']], 0, { angle: -20 }, 200);
  assert.deepStrictEqual(groupLines([...v, ...t]).map((l) => l.text).sort(), ['App 20', '세로 줄'], '⑳ 회전 줄마다 한 상자');
}
// ㉑ 색 차이 16 이하(엑셀 "자동" 검정)는 같은 색, 그보다 크면 run 경계(같은 line 번호) — mergeStyledRuns이면 한 상자 + runs
{
  const near = run([['black'], [' '], ['near', 0, { color: [5, 5, 5, 255] }]], 0);
  assert.strictEqual(groupLines(near).length, 1, '㉑ 거의 검정은 같은 색');
  const red = run([['black'], [' '], ['red', 0, { color: [200, 0, 0, 255] }], [' ', 0, { color: [200, 0, 0, 255] }], ['text']], 20);
  const plain = groupLines(red);
  assert.deepStrictEqual(plain.map((l) => l.text), ['black ', 'red ', 'text'], '㉑ 색이 바뀌면 run마다 상자(지금 기본)');
  assert.ok(plain.every((l) => l.line === plain[0].line), '㉑ 같은 시각적 줄 = 같은 line 번호');
  const merged = groupLines(red, { mergeStyledRuns: true });
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].text, 'black red text');
  assert.deepStrictEqual(merged[0].runs.map((r) => [r.from, r.to]), [[0, 2], [2, 4], [4, 5]], '㉑ runs = objs 범위');
}

// ㉒ 2단계: 객체 하나 안의 큰 점프(15d) — 글자 위치(glyphs)로 부분을 나눠 두 상자, 낱말 틈뿐이면 원래 객체 그대로 한 상자
{
  const mk = (text, jumpAt, jump) => {
    let x = 10; const glyphs = [...text].map((ch, k) => { if (k === jumpAt) x += jump; const g = [x, 50, 6]; x += 6; return g; });
    const o = T(text, { x0: 10, y0: 48, x1: x, y1: 58, originX: 10, originY: 50 });
    o.glyphs = glyphs;
    return o;
  };
  const far = mk('Name Value', 5, 40); // 'V' 앞 40pt(4em) 점프 — 사이 공백은 앞 부분 끝에
  const boxes = groupLines([far], { mergeStyledRuns: true });
  assert.deepStrictEqual(boxes.map((b) => b.text), ['Name ', 'Value'], '㉒ 큰 점프 → 부분 두 상자');
  assert.deepStrictEqual(boxes.map((b) => [b.objs[0].idx, b.objs[0].partFrom]), [[far.idx, 0], [far.idx, 5]], '㉒ 같은 객체의 부분(partFrom)');
  assert.ok(boxes[1].bounds.x0 >= 60 && boxes[0].bounds.x1 < 60, '㉒ 부분 상자는 제 글자 자리만 덮는다');
  const near = mk('Name Value', 5, 2); // 낱말 틈 수준 — 나누지 않는다
  const one = groupLines([near], { mergeStyledRuns: true });
  assert.strictEqual(one.length, 1, '㉒ 작은 틈은 한 상자');
  assert.strictEqual(one[0].objs[0], near, '㉒ 다시 이어진 부분은 원래 객체로 되돌린다(partFrom 없음)');
}

// ㉓ 2단계 문단 묶기: 줄 간격이 고른 같은 크기의 줄 → 한 문단. 문단 사이 여백·글머리 기호·같은 행의 다른 상자(표 칸)·크기 차에서 끊는다
{
  const { groupParagraphs } = require('./text-grouping');
  const line = (text, y, x0 = 40, size = 10) => T(text, { x0, y0: y - 2, x1: x0 + text.length * 5, y1: y + 8, originX: x0, originY: y, size });
  const objs = [
    line('Title line in a bigger size', 142, 40, 14),
    line('First paragraph line one goes here', 120), line('first paragraph line two goes here', 106), line('and the last line.', 92),
    line('Second paragraph after a gap', 62), line('ends right here.', 48),
    line('• bullet item one', 20), line('• bullet item two', 6),
    line('Cell A', -30), line('Cell B', -30, 300), line('Cell C', -44), line('Cell D', -44, 300), rule({ x0: 250, y0: -50, x1: 251, y1: -18 }),
  ];
  const paras = groupParagraphs(groupLines(objs, { mergeStyledRuns: true }));
  assert.deepStrictEqual(paras.slice(0, 3).map((p) => p.text), ['Title line in a bigger size',
    'First paragraph line one goes here\nfirst paragraph line two goes here\nand the last line.', 'Second paragraph after a gap\nends right here.'], '㉓ 문단 둘(사이 여백에서 끊김), 큰 제목은 따로');
  assert.deepStrictEqual(paras.slice(3, 5).map((p) => p.text), ['• bullet item one', '• bullet item two'], '㉓ 글머리 기호 줄은 저마다 새 문단');
  assert.ok(paras.slice(5).every((p) => p.boxes.length === 1) && paras.length === 9, `㉓ 표 칸(같은 행에 다른 상자)은 혼자 문단: ${paras.map((p) => p.boxes.length)}`);
}

console.log('OK — 합성 객체 단위 검사 ①~㉓ 통과');

// --- 통합 검사: 저장소 표본 PDF ---
(async () => {
  const samplePath = path.join(WS, 'sample.pdf');
  const sampleDoc = await open(fs.readFileSync(samplePath));
  const sampleLines = groupLines(sampleDoc.objects(0));
  assert.strictEqual(sampleLines.length, 8, 'sample.pdf → 상자 8개(변화 없음)');
  sampleDoc.close();
  console.log(`OK — sample.pdf 상자 ${sampleLines.length}개`);

  const koPath = path.join(WS, '회의록_초안.pdf');
  if (fs.existsSync(koPath)) {
    const koDoc = await open(fs.readFileSync(koPath));
    const koLines = groupLines(koDoc.objects(0));
    console.log('회의록_초안.pdf 1쪽 상자 수:', koLines.length);
    console.log('첫 상자:', JSON.stringify(koLines[0].text));
    assert.strictEqual(koLines.length, 15, '회의록_초안.pdf 1쪽 → 상자 15개');
    assert.ok(koLines[0].text.startsWith('9월'), '첫 상자는 9월로 시작');
    assert.ok(koLines[0].text.endsWith('(초안)'), '첫 상자는 (초안)으로 끝남');
    assert.strictEqual(koLines[0].text, '9월 첫째 주 경영관리회의 회의록 (초안)', '첫 상자 글은 낱말 사이 한 칸(v3.0.0은 두 칸)');
    assert.ok(koLines.every((l) => !/ {2}/.test(l.text)), '어느 줄에도 두 칸 공백이 없다');
    // 줄 일부를 가려도 그 줄은 한 상자로 남는다(v3.0.0은 가린 자리에서 둘로 쪼개졌다)
    const att = koLines.find((l) => l.text.startsWith('참석'));
    const from = att.text.indexOf('인사팀장');
    let off = 0; const parts = [];
    for (const o of att.objs) { const s = off, e = off + o.text.length; off = e; const x = Math.max(from, s), y = Math.min(from + 4, e); if (x < y) parts.push({ idx: o.idx, from: x - s, to: y - s }); }
    for (const p of parts.sort((m, n) => n.idx - m.idx)) assert.ok(koDoc.redact(0, p.idx, p.from, p.to).ok, '인사팀장 가리기');
    const maskedLines = groupLines(koDoc.objects(0));
    assert.strictEqual(maskedLines.length, 15, '가린 뒤에도 상자 15개');
    assert.strictEqual(maskedLines.find((l) => l.text.startsWith('참석')).text, '참석: 대표, ■■■■, 재무팀장, 영업팀장', '가린 줄은 한 상자, 가린 자리는 ■');
    koDoc.close();
  } else {
    console.log('회의록_초안.pdf 없음 — 통합 검사 건너뜀');
  }
  console.log('OK — text-grouping 통합 검사 통과');
})().catch((e) => { console.error(e); process.exit(1); });
