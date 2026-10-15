// 자체 검사: node app/grouping-corpus.test.js
// 줄 묶기 말뭉치(21건) — 사람이 기대하는 편집 상자와 groupLines 결과를 맞춘다.
//   01~14: Chromium(Electron printToPDF)이 만든 PDF — app/test-data/grouping/ (생성: tmp/grouping/gen-chromium.js, 저장소에 넣어 둔 합성 파일)
//   15~21: 손으로 쓴 내용 스트림 — pdf-test-fixtures.buildGroupingRawPdfs()가 그 자리에서 만든다
// 기대값은 tmp/grouping/make-manifest.js와 같다. 회색 7~8pt 설명 줄("NNx …")은 시험 대상이 아니다.
// 함께 보는 것: 읽기 순서(08·19d), 상자 겹침 없음, 글자 상자·가리기 위치 대응(객체 텍스트에서 PDFium 공백을 뺀 뒤에도 어긋나지 않는지)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { open } = require('./pdf-engine');
const { groupLines, groupParagraphs } = require('./text-grouping');
const { buildGroupingRawPdfs } = require('./pdf-test-fixtures');
const { maskParts, normalizeParts } = require('./pdf-edit-service');

const DIR = path.join(__dirname, 'test-data', 'grouping');
// L(기대 상자들, 다른 허용 분할들, 알려진 한계, 표시) — 화면과 같은 groupLines(objs, { mergeStyledRuns: true })로 잰다
const L = (boxes, alt, known, tag) => ({ boxes, alt: alt || [], known: known || null, tag: tag || null });
// 표시: 'styled' = 글꼴(굵게·기울임·코드 글꼴)·색이 바뀌는 줄 — 상자 하나에 runs가 여럿(2단계: run별 모양을 지키며 고쳐 쓴다)
//       'part'   = 객체 하나 안의 TJ −4000 점프(15d) — 객체를 부분(partFrom)으로 나눠 두 상자
// 알려진 한계(지금은 기대와 다르게 나오는 줄) — 이유와 함께. 고쳐지면 이 표에서 빼야 검사가 실패로 알려 준다.
//   2026-10-15 2단계: 없음(1단계의 styled 05·06·13c·20b, object 15d는 고쳐졌다)
const S = (boxes) => L(boxes, [], null, 'styled');
const CASES = [
  { id: '01', file: '01-plain-paragraph.pdf', lines: [L(['오늘 회의에서는 다음 분기 예산을 검토했습니다.']), L(['The team agreed to finalize the draft by Friday.']), L(['자세한 내용은 첨부 문서를 참고하세요. 문의는 총무팀으로.'])] },
  { id: '02', file: '02-justified.pdf', lines: [L(['계약 기간은 2026년 1월 1일부터 시작한다.']), L(['The quick report was sent to all members.']), L(['갑과 을은 성실히 의무를 이행한다.']), L(['본 계약은 양 당사자의 서명으로 효력이 발생하며 모든 조항은'])] },
  { id: '03', file: '03-letter-word-spacing.pdf', lines: [L(['자간이 넓은 제목 줄입니다']), L(['아주 넓은 자간 SPACED']), L(['단어 간격이 넓은 문장 입니다']), L(['Words are spaced widely here'])] },
  { id: '04', file: '04-sup-sub.pdf', lines: [L(['각주가 달린 문장입니다1 그리고 계속됩니다.']), L(['물의 화학식은 H2O 입니다.']), L(['Einstein wrote E = mc2 in 1905.']), L(['See note12 and tablea below.'])] },
  { id: '05', file: '05-mixed-styles.pdf', lines: [S(['이 문장에는 굵은 글씨와 기울임, 빨간 글씨가 섞여 있습니다.']), S(['Mix of bold, italic and blue words.'])] },
  { id: '06', file: '06-inline-code.pdf', lines: [S(['설정 파일의 max_width 값을 1200으로 바꾸세요.']), S(['Run npm test before you commit.'])] },
  { id: '07', file: '07-lists.pdf', lines: [L(['첫 번째 항목입니다'], [['• 첫 번째 항목입니다']]), L(['Second item here'], [['• Second item here']]), L(['1. 번호가 있는 항목'], [['1.', '번호가 있는 항목']]), L(['2. Another numbered item'], [['2.', 'Another numbered item']]), L(['• 직접 입력한 글머리 기호 항목']), L(['- 하이픈 글머리 항목'])] },
  { id: '08', file: '08-two-columns.pdf', lines: [L(['왼쪽 단의 첫째 줄 입니다', '오른쪽 단의 첫째 줄이다']), L(['왼쪽 단의 둘째 줄 입니다', '오른쪽 단의 둘째 줄이다']), L(['Left column first line', 'Right column first line']), L(['Left column second line', 'Right column second line'])],
    order: ['왼쪽 단의 첫째 줄 입니다', '왼쪽 단의 둘째 줄 입니다', '오른쪽 단의 첫째 줄이다', '오른쪽 단의 둘째 줄이다', 'Left column first line', 'Left column second line', 'Right column first line', 'Right column second line'] },
  { id: '09', file: '09-table.pdf', lines: [L(['품목', '수량', '단가', '금액']), L(['사무용 의자', '12', '85,000', '1,020,000']), L(['모니터 받침대', '3', '25,000', '개당 가격']), L(['Desk lamp', '40', '9,900', 'Unit price'])] },
  { id: '10', file: '10-leader-dots.pdf', lines: [L(['제1장 개요...3'], [['제1장 개요...', '3'], ['제1장 개요', '...', '3']]), L(['Chapter 2 Methods...17'], [['Chapter 2 Methods...', '17'], ['Chapter 2 Methods', '...', '17']]), L(['제3장 결론 42'], [['제3장 결론', '42']])] },
  { id: '11', file: '11-hyphenation.pdf', lines: [L(['The internation-']), L(['alization of documents is hard.']), L(['이 문장은 줄 끝에서 단어가 잘리는 경우를 시험하기 위한 문장입']), L(['니다. 다음 줄로 이어집니다.']), L(['Supercalifragilistic-']), L(['expialidocious words'])] },
  { id: '12', file: '12-rotated.pdf', lines: [L(['세로로 회전된 제목 Rotated 90']), L(['기울어진 도장 문구 Approved 2026']), L(['정상 가로 줄 (기준)'])] },
  { id: '13', file: '13-mixed-sizes.pdf', lines: [L(['큰 제목 작은 부제 설명'], [['큰 제목', '작은 부제 설명']]), L(['Annual Report 2026']), S(['가격 12,000원 (부가세 포함)'])] },
  { id: '14', file: '14-field-gap.pdf', lines: [L(['이름: 홍길동', '날짜: 2026-10-15']), L(['이름: 김영희', '날짜: 2026-10-16']), L(['성명 박철수', '소속 영업팀']), L(['Name: John Doe', 'Date: 2026-10-17'])] },
  { id: '15', raw: '15-tj-kerning', lines: [L(['Hello World']), L(['Total amount due today']), L(['AVATAR']), L(['Left field', 'Right field'], [], null, 'part'), L(['Each word separate'])] },
  { id: '16', raw: '16-space-vs-gap', lines: [L(['Hello World']), L(['Hello World']), L(['Hello World']), L(['Two words']), L(['Loose spacing']), L(['Each glyph'])] },
  { id: '17', raw: '17-tz-tc', lines: [L(['Condensed text line']), L(['Condensed pair']), L(['Wide text']), L(['Spaced letters here']), L(['SALE NOW'])] },
  { id: '18', raw: '18-fake-bold-shadow', lines: [L(['Bold Title Text']), L(['Grand Total 1,234']), L(['Normal and bold text']), L(['Italic words and upright'])] },
  { id: '19', raw: '19-out-of-order', lines: [L(['First Second Third']), L(['REVERSED']), L(['Line one comes first.']), L(['Line two comes second.']), L(['Left col line 1', 'Right col line 1']), L(['Left col line 2', 'Right col line 2'])],
    order: ['Left col line 1', 'Left col line 2', 'Right col line 1', 'Right col line 2'] },
  { id: '20', raw: '20-font-boundaries', lines: [L(['Quarterly sales report']), S(['Revenue increased by 12%']), L(['Size twelve and eleven point five']), L(['Color black and near black']), L(['ID: A-1029'], [['ID:', 'A-1029']])] },
  // 2단계 문단(9번) 합성 — 문단 둘, 둘째 문단 첫 줄에 굵은 조각
  { id: '21', raw: '21-paragraphs', lines: [L(['The first paragraph has three lines of text']), L(['that wrap at a fixed width inside the box']), L(['and it ends here.']),
    S(['Second paragraph starts after a gap and mixes styles in one line.']), L(['Its last line is short.'])],
    paras: [3, 2] },
];
// 문단 묶기(groupParagraphs) 기대: 01은 세 줄이 한 문단(줄 간격 1.7em, 위 설명 줄과는 크기로 갈림)
CASES.find((c) => c.id === '01').paras = [3];
// 회색 설명 줄: 색이 회색(120~150, R=G)인 조각만으로 된 상자
const isLabel = (b) => b.objs.every((o) => o.color && o.color[0] >= 120 && o.color[0] <= 150 && o.color[0] === o.color[1]);
// 비교용 정규화: 소프트 하이픈은 보이지 않는 글자(편집 창에도 빼고 보인다), 지시선 점은 개수 무관
const norm = (s) => String(s).replace(/­/g, '').replace(/ /g, ' ').trim().replace(/\.{3,}/g, '...').replace(/…/g, '...');

function evaluate(c, boxes) {
  const pool = boxes.map((b) => ({ t: norm(b.text), b, used: false }));
  const take = (arr) => {
    const picks = [];
    for (const want of arr) {
      const k = pool.findIndex((p, j) => !p.used && !picks.includes(j) && p.t === norm(want));
      if (k < 0) return null;
      picks.push(k);
    }
    return picks;
  };
  const result = c.lines.map((ln) => {
    for (const opt of [ln.boxes, ...ln.alt]) {
      const picks = take(opt);
      if (picks) { picks.forEach((k) => (pool[k].used = true)); return { ok: true }; }
    }
    return { ok: false };
  });
  return { result, extra: pool.filter((p) => !p.used) };
}

(async () => {
  const raw = buildGroupingRawPdfs();
  const table = [];
  let failures = 0;
  for (const c of CASES) {
    const buf = c.raw ? raw[c.raw] : fs.readFileSync(path.join(DIR, c.file));
    const doc = await open(buf);
    const objs = doc.objects(0);
    const boxes = groupLines(objs, { mergeStyledRuns: true }).filter((b) => !isLabel(b));
    const { result, extra } = evaluate(c, boxes);
    const known = c.lines.map((l) => l.known || null);
    // 알려진 한계 줄은 실패여야 하고(고쳐지면 표를 고치라고 알린다), 그 줄의 상자는 "남는 상자"로 치지 않는다
    result.forEach((r, k) => {
      if (known[k] && r.ok) { console.error(`  ${c.id} 줄 ${k + 1}: 알려진 한계(${known[k]})였는데 통과 — CASES 표에서 known을 빼세요`); failures++; }
      if (!known[k] && !r.ok) { console.error(`  ${c.id} 줄 ${k + 1} 실패: 기대 ${JSON.stringify(c.lines[k].boxes)}`); failures++; }
    });
    const knownTexts = c.lines.filter((l) => l.known).flatMap((l) => l.boxes.join(' ').split(/\s+/)).join('');
    const stray = extra.filter((p) => !knownTexts || !p.t.replace(/\s+/g, '').split('').every((ch) => knownTexts.includes(ch)));
    if (stray.length) { console.error(`  ${c.id} 남는 상자: ${JSON.stringify(stray.map((p) => p.b.text))} / 전체 ${JSON.stringify(boxes.map((b) => b.text))}`); failures++; }
    // 'styled' 줄: 상자 하나에 runs 여러 개(조각 범위가 objs 전체를 덮는다). 합치지 않은 기본 모드에서는 run마다 상자이고 line 번호가 같다
    const plain = groupLines(objs).filter((b) => !isLabel(b));
    for (const l of c.lines.filter((x) => x.tag === 'styled')) {
      const hit = boxes.find((b) => norm(b.text) === norm(l.boxes[0]));
      assert.ok(hit && hit.runs && hit.runs.length > 1, `${c.id} ${JSON.stringify(l.boxes[0])} 한 상자(runs 여러 개)`);
      assert.strictEqual(hit.runs[0].from, 0, `${c.id} runs는 0부터`);
      hit.runs.forEach((r, k) => assert.ok(r.to > r.from && (!k || r.from === hit.runs[k - 1].to), `${c.id} runs가 이어진다`));
      assert.strictEqual(hit.runs[hit.runs.length - 1].to, hit.objs.length, `${c.id} runs가 objs 전체를 덮는다`);
      const line = plain.find((x) => x.objs[0] === hit.objs[0]).line;
      assert.ok(plain.filter((b) => b.line === line).length === hit.runs.length, `${c.id} 같은 line 번호의 상자 수 = run 수`);
    }
    // 'part' 줄(15d): 두 상자가 같은 객체의 부분 — partFrom으로 객체 글 안의 위치를 안다
    for (const l of c.lines.filter((x) => x.tag === 'part')) {
      const hits = l.boxes.map((t) => boxes.find((b) => norm(b.text) === norm(t)));
      assert.ok(hits.every((h) => h && h.objs.length === 1), `${c.id} 부분 상자`);
      const [a, b] = hits.map((h) => h.objs[0]);
      assert.ok(a.idx === b.idx && a.partFrom === 0 && b.partFrom > 0 && objs[a.idx].text.slice(b.partFrom).trim() === norm(l.boxes[1]), `${c.id} 같은 객체의 두 부분: ${JSON.stringify([a.partFrom, b.partFrom])}`);
    }
    // 문단: 설명 줄을 뺀 상자들의 여러 줄 문단 크기
    if (c.paras) {
      const paras = groupParagraphs(boxes).filter((p) => p.boxes.length > 1).map((p) => p.boxes.length);
      assert.deepStrictEqual(paras, c.paras, `${c.id} 문단 묶기`);
    }
    // 읽기 순서
    if (c.order) {
      const seq = boxes.map((b) => norm(b.text)).filter((t) => c.order.includes(t));
      assert.deepStrictEqual(seq, c.order, `${c.id} 읽기 순서(단: 왼→오른쪽, 단 안 위→아래)`);
    }
    // 상자끼리 겹치지 않는다(첨자가 따로 상자가 되어 본문 줄 상자와 겹치던 문제). 회전 글자(12)는 외접 사각형이라 제외
    if (c.id !== '12') {
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].bounds, b = boxes[j].bounds;
        const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        assert.ok(!(w > 0.5 && h > 0.5), `${c.id} 상자 겹침: ${JSON.stringify(boxes[i].text)} × ${JSON.stringify(boxes[j].text)}`);
      }
    }
    // 글자 상자 대응: 모든 텍스트 객체에서 charBoxes 길이 = 텍스트 길이(가리기가 글자 단위로 자를 수 있다)
    for (const o of objs.filter((x) => x.type === 'text')) {
      assert.strictEqual(doc.charBoxes(0, o.idx).length, o.text.length, `${c.id} #${o.idx} ${JSON.stringify(o.text)} charBoxes 길이`);
      assert.strictEqual((o.glyphs || []).length, o.text.length, `${c.id} #${o.idx} glyphs 길이`);
    }
    // PDFium이 끼운 공백이 객체 텍스트에 새지 않는다(자간·지시선 점·글자별 객체)
    assert.ok(!objs.some((o) => o.type === 'text' && /\S \S/.test(o.text) && o.text.length <= 3 && !isLabel({ objs: [o] })) || ['15', '16', '17', '18', '19', '20'].includes(c.id),
      `${c.id} 글자 하나짜리 조각에 끼운 공백이 없다`);
    const ok = result.filter((r, k) => r.ok && !known[k]).length;
    table.push(`${c.id} ${ok}/${result.length}${known.some(Boolean) ? ` (알려진 한계 ${known.filter(Boolean).join(',')})` : ''}`);
    doc.close();
  }
  console.log(table.join('\n'));
  assert.strictEqual(failures, 0, `말뭉치 실패 ${failures}건`);

  // 가리기 위치 대응: 줄 상자 글의 일부를 골라(index.html mapRangeToParts와 같은 계산) 가리면 그 글만 사라진다
  const pick = async (buf, want, sub) => {
    const doc = await open(buf);
    const line = groupLines(doc.objects(0), { mergeStyledRuns: true }).find((b) => norm(b.text) === want);
    assert.ok(line, `가리기 시험 줄 ${want}`);
    const from = line.text.indexOf(sub), to = from + sub.length;
    let off = 0; const parts = [];
    for (const [j, o] of line.objs.entries()) { // index.html mapRangeToParts와 같은 계산(객체 안 부분이면 partFrom만큼 민다)
      const s = off, e = off + o.text.length; off = e + (line.seps[j] || '').length;
      const a = Math.max(from, s), b = Math.min(to, e);
      if (a < b) parts.push({ idx: o.idx, from: a - s + (o.partFrom || 0), to: b - s + (o.partFrom || 0) });
    }
    const r = maskParts(doc, 0, normalizeParts(parts), {});
    assert.ok(r.ok && !r.skipped.length, `${sub} 가림 결과 ${JSON.stringify(r)}`);
    const after = doc.pageText(0).replace(/\s+/g, '');
    assert.ok(!after.includes(sub.replace(/\s+/g, '')), `${sub} 지워짐`);
    const rest = want.replace(sub, '').replace(/\s+/g, '').replace(/\.{3,}/g, '');
    for (const w of rest.split(/[.]+/).filter((x) => x.length >= 2)) assert.ok(after.includes(w), `${sub} 가린 뒤 나머지 "${w}" 남음`);
    doc.close();
  };
  const chrome = (f) => fs.readFileSync(path.join(DIR, f));
  await pick(chrome('02-justified.pdf'), '계약 기간은 2026년 1월 1일부터 시작한다.', '2026년');
  await pick(chrome('03-letter-word-spacing.pdf'), '아주 넓은 자간 SPACED', 'SPACED');
  await pick(chrome('04-sup-sub.pdf'), '물의 화학식은 H2O 입니다.', 'H2O');
  await pick(chrome('14-field-gap.pdf'), '이름: 김영희', '김영희');
  await pick(raw['15-tj-kerning'], 'Total amount due today', 'amount');
  await pick(raw['17-tz-tc'], 'SALE NOW', 'NOW');
  // 조각(run)을 가로지르는 가리기: 굵은 글씨 끝 ~ 보통 글씨 머리(한 상자 안 두 run), 객체 안 부분(15d)의 뒤 칸
  await pick(chrome('05-mixed-styles.pdf'), '이 문장에는 굵은 글씨와 기울임, 빨간 글씨가 섞여 있습니다.', '글씨와 기울임');
  await pick(chrome('06-inline-code.pdf'), 'Run npm test before you commit.', 'npm test before');
  await pick(raw['15-tj-kerning'], 'Right field', 'Right');

  // 쪽 글자 번호 → 객체 조각(개인정보 일괄 가리기 경로): PDFium이 끼운 공백이 빠진 객체 텍스트에도 위치가 맞는다
  {
    const doc = await open(chrome('14-field-gap.pdf'));
    const { text, map } = doc.pageChars(0);
    const at = text.indexOf('2026-10-16');
    assert.ok(at >= 0, '쪽 글자에 날짜');
    const { parts, unmapped } = doc.partsForRanges(0, [[map[at], map[at + 9] + 1]]);
    assert.strictEqual(unmapped, 0);
    assert.ok(maskParts(doc, 0, normalizeParts(parts), {}).ok);
    assert.ok(!doc.pageText(0).includes('2026-10-16') && doc.pageText(0).includes('2026-10-15'), '그 날짜만 지워짐');
    doc.close();
  }
  // 줄 끝 하이픈 표시(U+0002)는 '-'로 — 객체 텍스트·쪽 글자 모두(길이 같음)
  {
    const doc = await open(chrome('11-hyphenation.pdf'));
    assert.ok(doc.objects(0).some((o) => o.text === '-') && !doc.objects(0).some((o) => /\u0002/.test(o.text || '')), 'U+0002 → -');
    assert.ok(!/\u0002/.test(doc.pageChars(0).text), '쪽 글자에도 U+0002 없음');
    doc.close();
  }
  console.log('OK — 줄 묶기 말뭉치 21건(styled·부분·문단 포함)·읽기 순서·겹침·글자 대응·가리기 위치(조각 경계·부분) 검사 통과');
})().catch((e) => { console.error(e); process.exit(1); });
