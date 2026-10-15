// Integration regression: node app/pdf-edit-service.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('./pdf-engine');
const { verifyEdits, editRuns } = require('./pdf-edit-service');
const { diffChars, planRuns, breakAtoms } = require('./run-edit');
const { groupLines, groupParagraphs } = require('./text-grouping');
const { buildGroupingRawPdfs } = require('./pdf-test-fixtures');

// ── 2단계(조각별 모양 보존 편집 · 15d 부분 · 문단 다시 흘리기) ─────────────────────────────
const GDIR = path.join(__dirname, 'test-data', 'grouping');
const merged = (objs) => groupLines(objs, { mergeStyledRuns: true });
// index.html runLine과 같은 요청 모양
const runLine = (line) => ({ objs: line.objs.map((o) => ({ idx: o.idx, text: o.text, ...(o.partFrom != null ? { from: o.partFrom, to: o.partFrom + o.text.length } : {}) })), seps: line.seps });
const isBoldObj = (o) => /bold/i.test(o.font) || o.weight >= 600;
// 글자 bounds 안의 잉크 밀도(어두운 픽셀 비율) — 굵은 글자는 같은 크기 보통 글자보다 진하다
function inkDensity(raw, scale, pageH, b) {
  let ink = 0, n = 0;
  for (let y = Math.floor((pageH - b.y1) * scale); y < Math.ceil((pageH - b.y0) * scale); y++) {
    for (let x = Math.floor(b.x0 * scale); x < Math.ceil(b.x1 * scale); x++) {
      const p = y * raw.stride + x * 4; n++;
      if (raw.data[p] + raw.data[p + 1] + raw.data[p + 2] < 3 * 128) ink++;
    }
  }
  return n ? ink / n : 0;
}
const unionB = (objs) => objs.reduce((u, o) => ({ x0: Math.min(u.x0, o.bounds.x0), y0: Math.min(u.y0, o.bounds.y0), x1: Math.max(u.x1, o.bounds.x1), y1: Math.max(u.y1, o.bounds.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

async function stage2(dir, post, get) {
  // ① 순수 계산: 글자 차이·조각 배정·줄 나누기
  assert.deepStrictEqual(diffChars('abcdef', 'abXdef'), [{ a: 2, b: 3, ins: 'X' }]);
  assert.deepStrictEqual(diffChars('same', 'same'), []);
  {
    const L = (items, seps) => ({ items: items.map(([text, style]) => ({ text, style })), seps });
    // 조각 경계("bold|,")에 넣은 글은 왼쪽 조각, 줄 첫머리는 오른쪽(첫) 조각, 덮어쓴 글은 지운 글자의 조각
    const line = [L([['Mix of ', 'R'], ['bold', 'B'], [', italic', 'R']], ['', ''])];
    assert.deepStrictEqual(planRuns(line, 'Mix of boldX, italic').texts[0], ['Mix of ', 'boldX', ', italic'], '경계 삽입 → 왼쪽 조각');
    assert.deepStrictEqual(planRuns(line, 'YMix of bold, italic').texts[0], ['YMix of ', 'bold', ', italic'], '줄 첫머리 → 첫 조각');
    assert.deepStrictEqual(planRuns(line, 'Mix of heavy, italic').texts[0], ['Mix of ', 'heavy', ', italic'], '덮어쓴 글 → 그 조각');
    assert.deepStrictEqual(planRuns(line, 'Mix of , italic').texts[0], ['Mix of ', '', ', italic'], '조각 전체 지움 → 빈 글');
    // 같은 모양 안에서는 낱말 끝까지 넓혀 LCS가 남긴 한 글자를 같이 고친다("test"→"run lint"의 마지막 t)
    const code = [L([['Run ', 'R'], ['npm test', 'C'], [' now', 'R']], ['', ''])];
    assert.deepStrictEqual(planRuns(code, 'Run npm run lint now').texts[0], ['Run ', 'npm run lint', ' now']);
    // 한 낱말 안 모양 경계("글씨"(굵게)+"와")는 넘지 않는다
    const ko = [L([['굵은 글씨', 'B'], ['와 기울임', 'R']], [''])];
    assert.deepStrictEqual(planRuns(ko, '굵은 글씨랑 기울임').texts[0], ['굵은 글씨', '랑 기울임']);
    // 문단: 줄 사이 '\n'을 지우면 soft deleted, 새 '\n'은 hard
    const p = planRuns([L([['one two', 'R']], []), L([['three', 'R']], [])], 'one two three\nfour');
    assert.ok(p.stream.some((e) => e.t === 'soft' && e.deleted) && p.stream.some((e) => e.t === 'hard'));
  }
  {
    const atoms = [...'aa bb cc'].map((ch) => ({ t: 'c', w: 10, ws: ch === ' ' }));
    assert.deepStrictEqual(breakAtoms(atoms, () => 40).lines, [[0, 3], [3, 6], [6, 8]], '공백 뒤에서 끊고 공백은 앞 줄 끝에');
    assert.deepStrictEqual(breakAtoms(atoms, () => Infinity).lines, [[0, 8]]);
    assert.deepStrictEqual(breakAtoms([...'abcdef'].map(() => ({ t: 'c', w: 10 })), () => 25).lines, [[0, 2], [2, 4], [4, 6]], '끊을 데가 없으면 글자 단위');
  }

  // ② 05(Chromium, 글자마다 객체): 굵은 조각 안 낱말 고치기 → 굵게 유지, 다른 조각 글꼴·색·기울임 그대로, 뒤 조각은 민다. 실행 취소 한 번에 원상
  const c05 = fs.readFileSync(path.join(GDIR, '05-mixed-styles.pdf'));
  {
    const name = path.join(dir, 's2-05.pdf'); fs.writeFileSync(name, c05);
    const before = await get('/api/pdf/objects', name);
    const line = merged(before).find((b) => b.text.startsWith('이 문장에는'));
    assert.strictEqual(line.runs.length, 5, '굵게·기울임·빨강이 섞인 한 상자');
    const newText = line.text.replace('굵은 글씨', '두꺼운 글씨');
    const r = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text, newText, mode: 'none' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.undoLeft, 1, '편집 한 번 = 실행 취소 한 번');
    const after = await get('/api/pdf/objects', name);
    const nl = merged(after).find((b) => b.text.startsWith('이 문장에는'));
    assert.strictEqual(nl.text, newText);
    const at = (w) => { const k = nl.text.indexOf(w); let off = 0; return nl.objs.filter((o, j) => { const s = off; off += o.text.length + (nl.seps[j] || '').length; return s < k + w.length && s + o.text.length > k && o.text.trim(); }); };
    assert.ok(at('두꺼운').every(isBoldObj), `고친 낱말은 굵게: ${at('두꺼운').map((o) => o.font + '/' + o.weight)}`);
    assert.ok(at('글씨와').slice(0, 2).every(isBoldObj), '안 고친 굵은 글자는 원래 객체 그대로');
    assert.ok(at('이 문장에는').every((o) => o.font === 'BAAAAA+MalgunGothic'), '앞 조각 글꼴 그대로');
    assert.ok(at('기울임').every((o) => Math.abs(o.matrix[2]) > 0.1), '기울임 조각은 기울임 그대로(행렬)');
    assert.ok(at('빨간 글씨').every((o) => o.color[0] > 150 && o.color[1] < 60), '빨간 조각은 빨강 그대로');
    const oldRed = merged(before).find((b) => b.text.startsWith('이 문장에는')).objs.find((o) => o.text === '빨');
    assert.ok(at('빨')[0].bounds.x0 > oldRed.bounds.x0 + 5, '앞 글이 길어진 만큼 뒤 조각을 오른쪽으로 민다');
    assert.ok(Math.abs(at('빨')[0].origin.y - oldRed.origin.y) < 0.01, '기준선 그대로');
    await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '실행 취소 한 번에 객체가 원상(글·위치·글꼴·색)');
  }
  {
    // 조각 전체 지우기(빨간 조각) → 빨간 객체 없음, 뒤 글자는 왼쪽으로 당겨진다. 경계 삽입은 왼쪽 조각 모양
    const name = path.join(dir, 's2-05b.pdf'); fs.writeFileSync(name, c05);
    const before = await get('/api/pdf/objects', name);
    const line = merged(before).find((b) => b.text.startsWith('이 문장에는'));
    const newText = line.text.replace('빨간 글씨', '');
    const r = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text, newText, mode: 'none' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await get('/api/pdf/objects', name), nl = merged(after).find((b) => b.text.startsWith('이 문장에는'));
    assert.strictEqual(nl.text.replace(/\s+/g, ' '), newText.replace(/\s+/g, ' '));
    assert.ok(!nl.objs.some((o) => o.color[0] > 150 && o.color[1] < 60), '빨간 조각은 지워졌다');
    const ga = (b) => b.objs.find((o) => o.text === '가');
    assert.ok(ga(nl).bounds.x0 < ga(line).bounds.x0 - 20, '뒤 글자는 지운 폭만큼 왼쪽으로');
    const en = merged(after).find((b) => b.text.startsWith('Mix of'));
    const r2 = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(en)], oldText: en.text, newText: en.text.replace('bold,', 'boldest,'), mode: 'none' });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    const en2 = merged(await get('/api/pdf/objects', name)).find((b) => b.text.startsWith('Mix of'));
    const objsOf = (b, w) => { const k = b.text.indexOf(w); let off = 0; return b.objs.filter((o, j) => { const s = off; off += o.text.length + (b.seps[j] || '').length; return s < k + w.length && s + o.text.length > k && o.text.trim(); }); };
    assert.ok(objsOf(en2, 'boldest').every(isBoldObj), '조각 끝에 붙여 쓴 글자는 그 조각(굵게)');
    assert.ok(objsOf(en2, 'italic').every((o) => !isBoldObj(o)), '다음 조각은 보통 그대로');
    assert.strictEqual(r2.undoLeft, 2);
  }
  {
    // 화면 픽셀: 고친 굵은 낱말은 보통 낱말보다 진하다(대체 글꼴도 굵은 맑은 고딕)
    const doc = await open(c05);
    const line = merged(doc.objects(0)).find((b) => b.text.startsWith('이 문장에는'));
    const r = doc.batch(() => editRuns(doc, 0, { lines: [runLine(line)], oldText: line.text, newText: line.text.replace('굵은', '두꺼운'), mode: 'none' }));
    assert.ok(r.ok && r.written.length === 1, JSON.stringify(r));
    const objs = doc.objects(0), bold = objs[r.written[0].idx], plain = merged(objs).find((b) => b.text.startsWith('이 문장에는')).objs.filter((o) => '문장에는'.includes(o.text) && o.text.trim());
    const raw = doc._renderRaw(0, 3), H = doc.pageSize(0).h;
    const dBold = inkDensity(raw, 3, H, bold.bounds), dPlain = inkDensity(raw, 3, H, unionB(plain));
    assert.ok(dBold > dPlain * 1.15, `굵은 낱말이 더 진하다: ${dBold.toFixed(3)} vs ${dPlain.toFixed(3)}`);
    doc.close();
  }

  // ③ 15d: 객체 하나 안의 두 칸 — 뒤 칸만 고치면 그 자리에서 객체를 갈라 뒤 칸만 다시 쓴다(앞 칸 글·위치 그대로)
  const raw = buildGroupingRawPdfs();
  {
    const name = path.join(dir, 's2-15.pdf'); fs.writeFileSync(name, raw['15-tj-kerning']);
    const before = await get('/api/pdf/objects', name);
    const right = merged(before).find((b) => b.text === 'Right field'), left = merged(before).find((b) => b.text.trim() === 'Left field');
    const R = right.objs[0], rx = R.glyphs[0][0];
    const r = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(right)], oldText: right.text, newText: 'Wrong field', mode: 'none' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const after = await get('/api/pdf/objects', name);
    const lo = after[left.objs[0].idx];
    assert.strictEqual(lo.text.trim(), 'Left field', '앞 칸 글 그대로');
    assert.ok(Math.abs(lo.origin.x - left.objs[0].origin.x) < 0.01, '앞 칸 위치 그대로');
    const wo = after.find((o) => o.text === 'Wrong field');
    assert.ok(wo && Math.abs(wo.glyphs[0][0] - rx) < 0.5 && wo.font === R.font, `뒤 칸은 그 자리·같은 글꼴: ${wo && wo.glyphs[0][0]} vs ${rx}`);
    assert.deepStrictEqual(merged(after).filter((b) => /field/.test(b.text) && b.objs[0].size > 10).map((b) => b.text.trim()), ['Left field', 'Wrong field'], '여전히 두 칸');
    await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '실행 취소로 한 객체로 돌아온다');
  }

  // ④ 문단 다시 흘리기(21 합성): 첫 줄을 길게 고치면 다음 줄로 넘기고 기준선·폭을 지킨다. 넘친 줄은 같은 간격으로 아래에 붙는다
  {
    const name = path.join(dir, 's2-21.pdf'); fs.writeFileSync(name, raw['21-paragraphs']);
    const before = await get('/api/pdf/objects', name);
    const para = groupParagraphs(merged(before)).find((p) => p.text.startsWith('The first'));
    assert.strictEqual(para.boxes.length, 3);
    const maxW = Math.max(...para.boxes.map((b) => b.bounds.x1 - b.bounds.x0));
    const newText = para.text.replace('three lines of text', 'three lines of rather long text that must reflow');
    const r = await post('/api/pdf/edit-runs', { name, i: 0, paragraph: true, lines: para.boxes.map(runLine), oldText: para.text, newText });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.strictEqual(r.undoLeft, 1);
    const after = merged(await get('/api/pdf/objects', name)).filter((b) => b.bounds.y1 > 330 && b.bounds.y0 < 390 && b.objs[0].size > 10);
    const ys = after.map((b) => b.objs[0].origin.y);
    assert.deepStrictEqual(ys, [375, 361, 347, 333].slice(0, ys.length), `기준선은 옛 줄 자리, 넘치면 같은 14pt 간격: ${ys}`);
    assert.ok(ys.length === 4 && r.addedLines === 1, `한 줄 늘었다: ${ys.length}/${r.addedLines}`);
    assert.ok(after.every((b) => b.bounds.x1 - 40 <= maxW + 1.5), `문단 폭을 넘지 않는다: ${after.map((b) => (b.bounds.x1 - 40).toFixed(1))} / ${maxW.toFixed(1)}`);
    assert.strictEqual(after.map((b) => b.text).join(' ').replace(/\s+/g, ' '), newText.replace(/\n/g, ' ').replace(/\s+/g, ' '), '글은 띄어쓰기로 이어진다');
    assert.ok(after.every((b) => Math.abs(b.bounds.x0 - 40) < 1.5), '줄마다 왼쪽 끝 그대로');
    // 둘째 문단: 굵은 조각은 다시 흘려도 굵게(Helvetica-Bold)
    const all = await get('/api/pdf/objects', name);
    const p2 = groupParagraphs(merged(all)).find((p) => p.text.startsWith('Second'));
    const r2 = await post('/api/pdf/edit-runs', { name, i: 0, paragraph: true, lines: p2.boxes.map(runLine), oldText: p2.text, newText: p2.text.replace('Second paragraph', 'The second paragraph') });
    assert.strictEqual(r2.status, 200, JSON.stringify(r2));
    const all2 = await get('/api/pdf/objects', name);
    const mix = all2.find((o) => o.text === 'mixes');
    assert.ok(mix && mix.font === 'Helvetica-Bold', `굵은 조각 그대로: ${mix && mix.font}`);
    assert.ok(all2.some((o) => /The second paragraph/.test(o.text) && o.font !== 'Helvetica-Bold'), '고친 글은 보통 조각');
    await post('/api/pdf/undo', { name }); await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '두 번 되돌리면 원상');
  }
  {
    // 01(Chromium, 한·영 섞인 3줄 문단): 첫 줄을 늘리면 뒤 낱말이 다음 줄로, 줄 수가 늘고 기준선 간격 18.75pt 유지. 실행 취소 원상
    const name = path.join(dir, 's2-01.pdf'); fs.writeFileSync(name, fs.readFileSync(path.join(GDIR, '01-plain-paragraph.pdf')));
    const before = await get('/api/pdf/objects', name);
    const para = groupParagraphs(merged(before)).find((p) => p.boxes.length === 3);
    const newText = para.text.replace('예산을', '예산과 인력 계획, 그리고 하반기 채용 일정을 함께');
    const r = await post('/api/pdf/edit-runs', { name, i: 0, paragraph: true, lines: para.boxes.map(runLine), oldText: para.text, newText });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    const lines = merged(await get('/api/pdf/objects', name)).filter((b) => b.objs.some((o) => o.size > 14));
    const ys = lines.map((b) => b.objs.find((o) => o.text.trim()).origin.y);
    ys.slice(1).forEach((y, k) => assert.ok(Math.abs(ys[k] - y - 18.75) < 0.05, `줄 간격 그대로: ${ys}`));
    assert.strictEqual(lines.length, 4);
    const maxW = Math.max(...para.boxes.map((b) => b.bounds.x1 - b.bounds.x0));
    assert.ok(lines.every((b) => b.bounds.x1 - b.bounds.x0 <= maxW + 1.5), '문단 폭 안');
    await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '실행 취소 원상');
  }
  {
    // 한 줄 편집의 넘침 처리: 줄바꿈(wrap)은 아래 줄을 더하고, 축소(shrink)는 줄 전체를 줄인다 — 둘 다 조각 모양 유지
    const doc = await open(c05);
    const line = merged(doc.objects(0)).find((b) => b.text.startsWith('이 문장에는'));
    const long = line.text.replace('빨간 글씨', '빨간 글씨와 파란 글씨와 초록 글씨');
    const w = doc.batch(() => editRuns(doc, 0, { lines: [runLine(line)], oldText: line.text, newText: long, mode: 'wrap', maxWidth: 300 }));
    assert.ok(w.ok && w.lines === 2 && w.addedLines === 1 && w.overlap, `줄바꿈: ${JSON.stringify(w)}`);
    doc.close();
    const d2 = await open(c05);
    const l2 = merged(d2.objects(0)).find((b) => b.text.startsWith('이 문장에는'));
    const s = d2.batch(() => editRuns(d2, 0, { lines: [runLine(l2)], oldText: l2.text, newText: long, mode: 'shrink', maxWidth: 300 }));
    const sl = merged(d2.objects(0)).find((b) => b.text.startsWith('이 문장에는'));
    const oldW = l2.bounds.x1 - l2.bounds.x0; // 쓸 수 있는 폭은 적어도 옛 줄 폭(같은 길이로 고친 줄은 줄이지 않는다)
    assert.ok(s.ok && s.scaled > 0.6 && s.scaled < 0.85 && sl.bounds.x1 - sl.bounds.x0 <= oldW + 2, `축소: ${s.scaled} / ${sl.bounds.x1 - sl.bounds.x0} / ${oldW}`);
    const same = d2.batch(() => editRuns(d2, 0, { lines: [runLine(merged(d2.objects(0)).find((b) => b.text.startsWith('Mix of')))], oldText: 'Mix of bold, italic and blue words.', newText: 'Mix of bald, italic and blue words.', mode: 'wrap', maxWidth: 50 }));
    assert.ok(same.ok && same.lines === 1 && !same.scaled, '옛 줄 폭 안이면 줄바꿈하지 않는다(화면이 잰 폭이 좁아도)');
    assert.ok(sl.objs.filter((o) => o.text.trim()).some(isBoldObj), '축소해도 굵은 조각 그대로');
    d2.close();
  }
  {
    // 문서가 바뀐 뒤의 옛 선택은 거절하고(400대·500), 실패한 편집은 문서·실행 취소 스택을 건드리지 않는다
    const name = path.join(dir, 's2-stale.pdf'); fs.writeFileSync(name, c05);
    const before = await get('/api/pdf/objects', name), info = await get('/api/pdf/info', name);
    const line = merged(before).find((b) => b.text.startsWith('Mix of'));
    const bad = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text + 'x', newText: 'whatever' });
    assert.notStrictEqual(bad.status, 200);
    const emoji = await post('/api/pdf/edit-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text, newText: line.text.replace('bold', '\u{1f680}') });
    assert.notStrictEqual(emoji.status, 200, '그릴 수 없는 글자');
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before);
    assert.deepStrictEqual(await get('/api/pdf/info', name), info);
  }
  console.log('stage2 runs/paragraph: OK — 조각별 모양 보존·조각 지우기·경계 삽입·15d 부분·문단 다시 흘리기·넘침(줄바꿈·축소)·실행 취소 원상');
}

// ── v6 Wave A: 고른 글자 모양 · 찾아 바꾸기 · 아래 내용 밀기 ─────────────────────────────
async function v6(dir, post, get, hiddenBytes) {
  const { styleRuns, syncDecoAfter } = require('./pdf-edit-service');
  const c05 = fs.readFileSync(path.join(GDIR, '05-mixed-styles.pdf'));
  const objsOf = (b, w, n = 0) => { let k = -1; for (let q = 0; q <= n; q++) k = b.text.indexOf(w, k + 1); let off = 0; return b.objs.filter((o, j) => { const s = off; off += o.text.length + (b.seps[j] || '').length; return s < k + w.length && s + o.text.length > k && o.text.trim(); }); };
  const boldish = (o) => isBoldObj(o) || o.renderMode === 2 || /bold/i.test(o.fontLabel || '');
  const sig = (os) => os.map((o) => `${o.font}|${o.fontLabel || ''}|${o.color.slice(0, 3)}|${o.renderMode}|${o.matrix.slice(0, 4).map((v) => v.toFixed(3))}`).join(' ');
  const lineOf = (objs, start) => merged(objs).find((b) => b.text.startsWith(start));
  const info = async (name) => (await fetch(`http://127.0.0.1:${process.env.RETEXTPDF_PORT}/api/pdf/info?${new URLSearchParams({ name })}`)).json().catch(() => ({}));
  // ① 엔진·서비스: 여러 조각 줄 가운데 낱말에 굵게·빨강 / 기울임·밑줄 / 위첨자 / 취소선·크기 → 저장·다시 열어도 그대로
  {
    const doc = await open(c05);
    const run = (start, word, style, extra = {}) => {
      const line = lineOf(doc.objects(0), start), from = line.text.indexOf(word);
      assert.ok(from >= 0, `${word} in ${line.text}`);
      const r = doc.batch(() => syncDecoAfter(doc, 0, styleRuns(doc, 0, { lines: [runLine(line)], oldText: line.text, from, to: from + word.length, style, ...extra })));
      assert.ok(r.ok && r.styled > 0, JSON.stringify(r));
      return r;
    };
    const L0 = lineOf(doc.objects(0), 'Mix of');
    const keep = { Mix: sig(objsOf(L0, 'Mix')), italic: sig(objsOf(L0, 'italic')), blue: sig(objsOf(L0, 'blue')), ko: sig(lineOf(doc.objects(0), '이 문장').objs) };
    const rb = run('Mix of', 'and', { bold: true, color: '#cc0000' });
    let L = lineOf(doc.objects(0), 'Mix of');
    assert.strictEqual(L.text, L0.text, '글은 그대로');
    assert.ok(objsOf(L, 'and').every((o) => boldish(o) && o.color[0] === 204 && o.color[1] === 0), `고른 낱말만 굵게·빨강: ${sig(objsOf(L, 'and'))}`);
    assert.ok(rb.faces.length || rb.fake.bold, '진짜 굵은 면(설치 폰트) 또는 흉내 굵게');
    assert.strictEqual(sig(objsOf(L, 'Mix')), keep.Mix, '앞 조각 그대로'); assert.strictEqual(sig(objsOf(L, 'italic')), keep.italic, '기울임 조각 그대로');
    assert.strictEqual(sig(objsOf(L, 'blue')), keep.blue, '파란 조각 모양 그대로');
    assert.strictEqual(sig(lineOf(doc.objects(0), '이 문장').objs), keep.ko, '다른 줄 그대로');
    const blueX0 = objsOf(L0, 'blue')[0].origin.x;
    assert.ok(objsOf(L, 'blue')[0].origin.x >= blueX0 - 0.01, '굵어진 만큼 뒤 조각은 그 자리이거나 오른쪽');
    run('이 문장', '섞여', { italic: true, underline: true });
    const K = lineOf(doc.objects(0), '이 문장'), seok = objsOf(K, '섞여');
    assert.ok(seok.every((o) => Math.abs(o.matrix[2] / o.matrix[0] - 0.2) < 0.01 && o.style?.fi && o.style?.u), `흉내 기울임 c=0.2a·밑줄 표시: ${JSON.stringify(seok.map((o) => [o.matrix, o.style]))}`);
    const deco = doc.objects(0).filter((o) => o.deco);
    assert.ok(deco.some((d) => d.bounds.x0 <= seok[0].glyphs[0][0] + 0.5 && d.bounds.x1 >= seok[1].glyphs[0][0] && d.bounds.y1 < seok[0].origin.y), `밑줄 선이 그 낱말 아래: ${JSON.stringify(deco.map((d) => d.bounds))}`);
    const blue0 = objsOf(lineOf(doc.objects(0), 'Mix of'), 'blue');
    run('Mix of', 'blue', { script: 'super' });
    L = lineOf(doc.objects(0), 'Mix of');
    assert.ok(L.text.includes('blue words'), `위첨자도 같은 줄: ${L.text}`);
    objsOf(L, 'blue').forEach((o, k) => {
      assert.ok(Math.abs(o.scaledSize / blue0[k].scaledSize - 0.65) < 0.01, '위첨자 0.65배');
      assert.ok(Math.abs((o.origin.y - blue0[k].origin.y) / blue0[k].scaledSize - 0.33) < 0.01, '기준선 +0.33em');
    });
    run('Mix of', 'words', { strike: true, size: 13 });
    L = lineOf(doc.objects(0), 'Mix of');
    assert.ok(objsOf(L, 'words').every((o) => Math.abs(o.scaledSize - 13) < 0.05 && o.style?.s), '취소선 표시·13pt');
    assert.strictEqual(doc.objects(0).filter((o) => o.deco).length, 2, '밑줄 선 1 + 취소선 선 1');
    const re = await open(doc.save()); doc.close();
    const R = lineOf(re.objects(0), 'Mix of'), RK = lineOf(re.objects(0), '이 문장');
    assert.strictEqual(R.text, L.text, '저장·다시 열어도 글 그대로');
    assert.ok(objsOf(R, 'and').every((o) => boldish(o) && o.color[0] === 204), '저장 뒤에도 굵게·빨강');
    assert.ok(objsOf(RK, '섞여').every((o) => o.style?.u && o.style?.fi), '저장 뒤에도 밑줄·기울임 표시');
    assert.ok(objsOf(R, 'blue').every((o) => o.style?.sc === 'sup'), '저장 뒤에도 위첨자 표시');
    assert.strictEqual(re.objects(0).filter((o) => o.deco).length, 2, '저장 뒤에도 선 2개');
    // 다시 열린 문서에서 밑줄 낱말 글을 고쳐도 선이 따라온다(조각별 편집 → syncDeco)
    const r2 = re.batch(() => syncDecoAfter(re, 0, editRuns(re, 0, { lines: [runLine(RK)], oldText: RK.text, newText: RK.text.replace('기울임', '기울임 글씨'), mode: 'none' })));
    assert.ok(r2.ok);
    const RK2 = lineOf(re.objects(0), '이 문장'), u2 = objsOf(RK2, '섞여'), d2 = re.objects(0).filter((o) => o.deco && o.bounds.y1 < u2[0].origin.y && o.bounds.y1 > u2[0].origin.y - 5);
    assert.ok(d2.length === 1 && Math.abs(d2[0].bounds.x0 - u2[0].glyphs[0][0]) < 0.6, `밑줄이 옮겨진 낱말을 따라간다: ${JSON.stringify(d2.map((d) => d.bounds))} vs ${u2[0].glyphs[0][0]}`);
    re.close();
    // 첨자 끄기 · 굵게 끄기는 원래대로
    const d3 = await open(c05);
    const M = lineOf(d3.objects(0), 'Mix of'), beforeSig = sig(M.objs.filter((o) => o.text.trim()));
    const f = M.text.indexOf('blue');
    d3.batch(() => styleRuns(d3, 0, { lines: [runLine(M)], oldText: M.text, from: f, to: f + 4, style: { script: 'sub' } }));
    const M2 = lineOf(d3.objects(0), 'Mix of');
    d3.batch(() => styleRuns(d3, 0, { lines: [runLine(M2)], oldText: M2.text, from: f, to: f + 4, style: { script: null } }));
    const M3 = lineOf(d3.objects(0), 'Mix of');
    assert.ok(objsOf(M3, 'blue').every((o, k) => Math.abs(o.scaledSize - objsOf(M, 'blue')[k].scaledSize) < 0.01 && Math.abs(o.origin.y - objsOf(M, 'blue')[k].origin.y) < 0.01), '첨자를 끄면 크기·기준선이 돌아온다');
    assert.ok(beforeSig.length > 0);
    d3.close();
  }
  // ② 서버: 모양 바꾸기 한 번 = 실행 취소 한 번, 네 번 되돌리면 객체가 원상
  {
    const name = path.join(dir, 'v6-style.pdf'); fs.writeFileSync(name, c05);
    const before = await get('/api/pdf/objects', name);
    const steps = [['Mix of', 'and', { bold: true, color: '#cc0000' }], ['이 문장', '섞여', { italic: true, underline: true }], ['Mix of', 'blue', { script: 'super' }], ['Mix of', 'words', { strike: true, size: 13 }]];
    for (const [k, [start, word, style]] of steps.entries()) {
      const line = lineOf(await get('/api/pdf/objects', name), start), from = line.text.indexOf(word);
      const r = await post('/api/pdf/style-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text, from, to: from + word.length, style });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      assert.strictEqual(r.undoLeft, k + 1, '모양 바꾸기 한 번 = 실행 취소 한 번');
    }
    // 진짜 가리기는 모양을 바꾼 글자(설치 폰트 굵은 면·흉내 기울임·첨자)에서도 글자를 지운다
    const partsFor = (b, w) => { const k = b.text.indexOf(w); let off = 0; const parts = []; b.objs.forEach((o, j) => { const s0 = off; off += o.text.length + (b.seps[j] || '').length; const a = Math.max(k, s0), e = Math.min(k + w.length, s0 + o.text.length); if (a < e) parts.push({ idx: o.idx, from: a - s0 + (o.partFrom || 0), to: e - s0 + (o.partFrom || 0) }); }); return parts; };
    const cur = await get('/api/pdf/objects', name);
    const mk = await post('/api/pdf/mask', { name, i: 0, parts: [...partsFor(lineOf(cur, 'Mix of'), 'and'), ...partsFor(lineOf(cur, 'Mix of'), 'blue')] });
    assert.ok(mk.ok && !/and|blue/.test(mk.textLeft), `굵게·첨자 글자도 지워진다: ${mk.textLeft}`);
    const mk2 = await post('/api/pdf/mask', { name, i: 0, parts: partsFor(lineOf(await get('/api/pdf/objects', name), '이 문장'), '섞여') });
    assert.ok(mk2.ok && !mk2.textLeft.includes('섞여'), '기울임·밑줄 글자도 지워진다');
    await post('/api/pdf/undo', { name }); await post('/api/pdf/undo', { name });
    for (let k = 0; k < steps.length; k++) await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '네 번 되돌리면 글·위치·글꼴·색·선 모두 원상');
    // 낡은 줄로 보내면 거절하고 문서는 그대로
    const line = lineOf(before, 'Mix of');
    const bad = await post('/api/pdf/style-runs', { name, i: 0, lines: [runLine(line)], oldText: line.text + 'x', from: 0, to: 3, style: { bold: true } });
    assert.notStrictEqual(bad.status, 200);
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before);
  }
  // ③ 찾아 바꾸기: 여러 모양 줄의 한국어 낱말 · 모두 바꾸기 한 번 = 실행 취소 한 번 · 대소문자·단어 단위 · 가린 자리·투명 글자는 건너뛴다
  {
    const name = path.join(dir, 'v6-replace.pdf'); fs.writeFileSync(name, c05);
    const before = await get('/api/pdf/objects', name);
    const dry = await post('/api/pdf/replace', { name, query: '글씨', dryRun: true });
    assert.strictEqual(dry.total, 2); assert.strictEqual(dry.editable, 2);
    assert.ok(dry.matches.every((m) => m.rect && m.rect.x1 > m.rect.x0), '일치마다 쪽 위 사각형');
    assert.strictEqual((await post('/api/pdf/replace', { name, query: '글씨', wholeWord: true, dryRun: true })).total, 0, '단어 단위: "글씨와"·"글씨가"는 빠진다');
    assert.strictEqual((await post('/api/pdf/replace', { name, query: 'mix', dryRun: true })).total, 1, '대소문자 무시');
    assert.strictEqual((await post('/api/pdf/replace', { name, query: 'mix', matchCase: true, dryRun: true })).total, 0, '대소문자 구분');
    const r = await post('/api/pdf/replace', { name, query: '글씨', replacement: '글자' });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.ok && r.count === 2 && r.undoLeft === 1, `모두 바꾸기 = 실행 취소 한 번: ${JSON.stringify(r)}`);
    const K = lineOf(await get('/api/pdf/objects', name), '이 문장');
    assert.strictEqual(K.text, '이 문장에는 굵은 글자와 기울임, 빨간 글자가 섞여 있습니다.');
    assert.ok(objsOf(K, '굵은 글자').every(boldish), '굵은 조각은 굵게');
    assert.ok(objsOf(K, '빨간 글자').every((o) => o.color[0] > 150 && o.color[1] < 60), '빨간 조각은 빨강');
    await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '한 번 되돌리면 원상');
    // 다음 바꾸기(하나): 두 번째 일치만
    const m2 = dry.matches[1];
    const one = await post('/api/pdf/replace', { name, query: '글씨', replacement: '글자', target: { i: m2.i, line: m2.line, at: m2.at, lineText: m2.lineText } });
    assert.ok(one.ok && one.count === 1, JSON.stringify(one));
    assert.strictEqual(lineOf(await get('/api/pdf/objects', name), '이 문장').text, '이 문장에는 굵은 글씨와 기울임, 빨간 글자가 섞여 있습니다.');
    // 가린 자리: "기울임"을 가리면 줄에 ■가 생긴다 — ■는 찾아도 바꾸지 않고 문서·실행 취소 기록도 그대로
    const K2 = lineOf(await get('/api/pdf/objects', name), '이 문장'), at = K2.text.indexOf('기울임');
    const mk = await post('/api/pdf/mask', { name, i: 0, parts: (() => { let off = 0; const parts = []; K2.objs.forEach((o, j) => { const s = off; off += o.text.length + (K2.seps[j] || '').length; const a = Math.max(at, s), b = Math.min(at + 3, s + o.text.length); if (a < b) parts.push({ idx: o.idx, from: a - s + (o.partFrom || 0), to: b - s + (o.partFrom || 0) }); }); return parts; })() });
    assert.ok(mk.ok, JSON.stringify(mk));
    const masked = await post('/api/pdf/replace', { name, query: '■', dryRun: true });
    assert.ok(masked.total > 0 && masked.matches.every((m) => m.masked && !m.editable && m.reason === '가린 자리'), JSON.stringify(masked.matches));
    const infoBefore = await info(name), objsBefore = await get('/api/pdf/objects', name);
    const none = await post('/api/pdf/replace', { name, query: '■', replacement: 'X' });
    assert.ok(none.ok === false && none.count === 0 && none.skipped.every((s) => s.reason === '가린 자리'), JSON.stringify(none));
    assert.deepStrictEqual(await get('/api/pdf/objects', name), objsBefore); assert.strictEqual((await info(name)).undoLeft, infoBefore.undoLeft, '바꿀 것이 없으면 실행 취소 기록도 없다');
    // 투명 글자(그림 위 글자)는 바꿀 수 없다고 알린다
    const hname = path.join(dir, 'v6-hidden.pdf'); fs.writeFileSync(hname, hiddenBytes);
    const hid = await post('/api/pdf/replace', { name: hname, query: 'BBB', dryRun: true });
    assert.ok(hid.total === 1 && !hid.matches[0].editable && hid.matches[0].reason === '그림 위 투명 글자', JSON.stringify(hid.matches));
  }
  // ④ 아래 내용 밀기: 문단이 한 줄 늘면 같은 단의 아래 내용이 줄 간격만큼 내려간다(위·다른 단은 그대로). 쪽 아래로 넘치면 409로 묻는다
  {
    const name = path.join(dir, 'v6-push.pdf'); fs.writeFileSync(name, fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf')));
    const before = await get('/api/pdf/objects', name), B = merged(before), y0 = (L, t) => L.find((b) => b.text.startsWith(t)).bounds.y0;
    const para = groupParagraphs(B).find((p) => p.text.startsWith('『어린'));
    const pitch = para.boxes[0].objs[0].origin.y - para.boxes[1].objs[0].origin.y;
    const newText = para.text.replace('나눕니다.', '나눕니다. 책을 읽고 느낀 점을 자유롭게 이야기하고, 다음 모임에서 함께 읽을 책 후보도 두세 권씩 가져와 주세요. 한 줄이 더 늘어나도록 덧붙인 문장입니다.');
    const r = await post('/api/pdf/edit-runs', { name, i: 0, paragraph: true, lines: para.boxes.map(runLine), oldText: para.text, newText, pushDown: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r));
    assert.ok(r.addedLines === 1 && r.pushed?.moved > 0 && r.undoLeft === 1, JSON.stringify({ added: r.addedLines, pushed: r.pushed }));
    const A = merged(await get('/api/pdf/objects', name));
    for (const t of ['진행 순서', '2:00', '준비물', '참고', '모임 사진']) assert.ok(Math.abs(y0(A, t) - y0(B, t) + pitch) < 0.6, `${t}: ${y0(A, t) - y0(B, t)} ≈ −${pitch}`);
    for (const t of ['10월 독서', '이번 달 책', '일시:']) assert.ok(Math.abs(y0(A, t) - y0(B, t)) < 0.01, `${t}: 위 내용은 그대로`);
    await post('/api/pdf/undo', { name });
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '실행 취소 한 번에 밀린 내용까지 원상');
    // 넘침: 아래 내용을 쪽 밖으로 밀어야 하면 409(overflow) — 문서·실행 취소 기록 그대로. keep = 밀지 않음, shrink = 글자를 줄여 맞춘다
    const P2 = groupParagraphs(B).find((p) => p.text.startsWith('읽은 책과'));
    const huge = P2.text + ' ' + '모임 전에 미리 책을 읽어 오시면 이야기가 훨씬 풍성해집니다. '.repeat(30);
    const req = { name, i: 0, paragraph: true, lines: P2.boxes.map(runLine), oldText: P2.text, newText: huge, pushDown: true };
    const of = await post('/api/pdf/edit-runs', req);
    assert.ok(of.status === 409 && of.overflow === true && of.growth > of.room, JSON.stringify(of));
    assert.deepStrictEqual(await get('/api/pdf/objects', name), before, '넘치면 문서는 그대로');
    assert.strictEqual((await info(name)).undoLeft, 0, '실행 취소 기록도 그대로');
    const keep = await post('/api/pdf/edit-runs', { ...req, overflow: 'keep' });
    assert.ok(keep.status === 200 && keep.pushed?.skipped === 'overflow', JSON.stringify(keep.pushed));
    const cham = B.find((b) => b.text.startsWith('참고')).objs.find((o) => o.text.trim()).origin.y;
    assert.ok((await get('/api/pdf/objects', name)).some((o) => o.text?.startsWith('참') && Math.abs(o.origin.y - cham) < 0.01), 'keep: 아래 내용은 그대로(겹침)');
    await post('/api/pdf/undo', { name });
    const shrink = await post('/api/pdf/edit-runs', { ...req, overflow: 'shrink' });
    assert.ok(shrink.status === 200 && shrink.fontScale < 1 && shrink.pushed?.moved > 0 && shrink.undoLeft === 1, JSON.stringify({ s: shrink.status, f: shrink.fontScale, p: shrink.pushed, e: shrink.error }));
    const S = await get('/api/pdf/objects', name);
    assert.ok(S.filter((o) => o.type === 'text' && o.bounds).every((o) => o.bounds.y0 > 0), 'shrink: 모든 글자가 쪽 안');
    // 두 단(08): 왼쪽 단 줄을 늘리면 왼쪽 단만 내려가고 오른쪽 단은 그대로
    const n8 = path.join(dir, 'v6-cols.pdf'); fs.writeFileSync(n8, fs.readFileSync(path.join(GDIR, '08-two-columns.pdf')));
    const b8 = merged(await get('/api/pdf/objects', n8)), left = b8.find((b) => b.text.startsWith('왼쪽 단의 첫째'));
    const r8 = await post('/api/pdf/edit-runs', { name: n8, i: 0, lines: [runLine(left)], oldText: left.text, newText: left.text + ' 그리고 길게 늘려서 왼쪽 단 안에서 다음 줄로 넘어가게 만든 문장', mode: 'wrap', box: { x0: left.bounds.x0, x1: left.bounds.x1 }, pushDown: true });
    assert.strictEqual(r8.status, 200, JSON.stringify(r8));
    const objs8 = await get('/api/pdf/objects', n8), gone = r8.removed || [];
    // 옛 객체 번호 → 새 번호(지운 객체만큼 당겨진다). 줄마다 첫 글자 객체가 얼마나 내려갔나
    const dyOf = (t) => { const o = b8.find((b) => b.text.startsWith(t)).objs.find((x) => x.text.trim()); const n = objs8[o.idx - gone.filter((g) => g < o.idx).length]; assert.strictEqual(n.text, o.text); return n.origin.y - o.origin.y; };
    const d = dyOf('왼쪽 단의 둘째');
    assert.ok(d < -10 && Math.abs(r8.pushed.dy - d) < 0.01, `왼쪽 단 아래가 내려간다: ${d}`);
    for (const t of ['08b', 'Left column first', 'Left column second']) assert.ok(Math.abs(dyOf(t) - d) < 0.01, `${t}도 같은 만큼`);
    for (const t of ['오른쪽 단의 첫째', '오른쪽 단의 둘째', 'Right column first', 'Right column second']) assert.ok(Math.abs(dyOf(t)) < 0.01, `${t}: 다른 단은 그대로`);
  }
  console.log('v6 Wave A: OK — 고른 글자 굵게·색·기울임·밑줄·위첨자·취소선·크기(저장·다시 열기·실행 취소 원상) · 찾아 바꾸기(모양 유지·한 번 되돌리기·가린 자리·투명 글자) · 아래 내용 밀기(단·넘침 409·keep·shrink)');
}

process.env.RETEXTPDF_PORT = '4861';
const app = require('./server');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retext-pdf-edits-'));
  try {
    const port = await app.ready;
    const post = async (route, data) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, ...(await response.json()) };
    };
    const get = async (route, name) => (await fetch(`http://127.0.0.1:${port}${route}?${new URLSearchParams({ name, i: 0 })}`)).json();
    const source = fs.readFileSync(path.join(__dirname, '..', 'workspace', 'sample.pdf'));
    const fixture = await open(source);
    for (let idx = 1; idx <= 3; idx++) {
      assert(fixture.setText(0, idx, ['','AAA','BBB','CCC'][idx]).ok);
      const object = fixture.objects(0)[idx];
      fixture.move(0, [idx], 60 + (idx - 1) * 40 - object.origin.x, 690 - object.origin.y);
      fixture._setFillColor(0, idx, [0, 0, 0, 0]);
    }
    const bytes = fixture.save(); fixture.close();
    for (const route of ['edits', 'fit']) {
      const name = path.join(dir, `${route}.pdf`);
      fs.writeFileSync(name, bytes);
      const payload = route === 'edits'
        ? { name, i: 0, edits: [{ idx: 2, text: ' ' }, { idx: 3, text: ' ' }, { idx: 1, text: 'REPLACED' }] }
        : { name, i: 0, idx: 1, text: 'REPLACED', maxWidth: 200, mode: 'wrap', blank: [2, 3] };
      const result = await post(`/api/pdf/${route}`, payload);
      assert.strictEqual(result.status, 200, JSON.stringify(result));
      assert.strictEqual(result.undoLeft, 1);
      const objects = await get('/api/pdf/objects', name);
      assert(objects.some((o) => o.text === 'Key points:'), 'unrelated object survives');
      assert(!objects.some((o) => o.text === 'CCC'), 'last fragment was cleared');
      assert.strictEqual(objects[result.lineIdxs[0]].text, 'REPLACED', 'returned index addresses replacement');
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert(undone.some((o) => o.text?.trim() === 'CCC'), 'one undo restores all fragments');
    }
    {
      const name = path.join(dir, 'group.pdf'); fs.writeFileSync(name, bytes);
      const r = await post('/api/pdf/fit', { name, i: 0, idx: 1, text: 'WHOLE', maxWidth: 200, mode: 'wrap', remove: [2, 3] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name);
      assert(!after.some((o) => ['BBB', 'CCC'].includes(o.text?.trim())));
      assert.strictEqual(after[r.lineIdxs[0]].text, 'WHOLE');
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert(undone.some((o) => o.text?.trim() === 'BBB') && undone.some((o) => o.text?.trim() === 'CCC'));
    }
    {
      const name = path.join(dir, 'failure.pdf'); fs.writeFileSync(name, source);
      const beforeObjects = await get('/api/pdf/objects', name), beforeInfo = await get('/api/pdf/info', name);
      const failed = await post('/api/pdf/fit', { name, i: 0, idx: 1, text: '\u{1f680}', maxWidth: 300, mode: 'wrap', blank: [2] });
      assert.notStrictEqual(failed.status, 200);
      assert.deepStrictEqual(await get('/api/pdf/objects', name), beforeObjects, 'failed edit leaves live document untouched');
      assert.deepStrictEqual(await get('/api/pdf/info', name), beforeInfo, 'failed edit leaves dirty and history untouched');
      assert(fs.readFileSync(name).equals(source), 'failed edit leaves file bytes untouched');
      const failedSingle = await post('/api/pdf/edit', { name, i: 0, idx: 1, text: '\u{1f680}' });
      assert.notStrictEqual(failedSingle.status, 200);
      assert.deepStrictEqual(await get('/api/pdf/info', name), beforeInfo, 'single edit also preserves history on failure');
    }
    {
      // edits + remove 함께: 투명 곁가지는 ' ' 편집, 보이는 곁가지는 remove — 한 번의 실행 취소
      const name = path.join(dir, 'mixed.pdf'); fs.writeFileSync(name, bytes);
      const r = await post('/api/pdf/edits', { name, i: 0, edits: [{ idx: 2, text: ' ' }, { idx: 1, text: 'MIXED' }], remove: [3] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name);
      assert.strictEqual(after[r.lineIdxs[0]].text, 'MIXED');
      assert(!after.some((o) => ['BBB', 'CCC'].includes(o.text?.trim())));
      assert.strictEqual(r.undoLeft, 1);
    }
    {
      // 기준 조각이 가장 높은 인덱스인 투명 글자 줄(180° 회전 쪽처럼 화면 순서와 인덱스가 거꾸로):
      // 곁가지를 나중에 드러내면 그 배경 덮개가 새 글자 위에 얹혀 글자가 안 보였다 → 기준 조각을 마지막에 처리
      const fx = await open(source);
      for (let idx = 1; idx <= 3; idx++) {
        assert(fx.setText(0, idx, ['', 'AAA', 'BBB', 'CCC'][idx]).ok);
        const object = fx.objects(0)[idx];
        fx.move(0, [idx], 60 + (3 - idx) * 40 - object.origin.x, 690 - object.origin.y);
        fx._setFillColor(0, idx, [0, 0, 0, 0]);
      }
      const name = path.join(dir, 'reversed.pdf'); fs.writeFileSync(name, fx.save()); fx.close();
      const r = await post('/api/pdf/edits', { name, i: 0, edits: [{ idx: 1, text: ' ' }, { idx: 2, text: ' ' }, { idx: 3, text: 'REPLACED TEXT' }] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name), p = r.lineIdxs[0], b = after[p].bounds;
      assert.strictEqual(after[p].text, 'REPLACED TEXT');
      const over = after.filter((o) => o.idx > p && o.type === 'path' && o.bounds.x0 < b.x1 && o.bounds.x1 > b.x0 && o.bounds.y0 < b.y1 && o.bounds.y1 > b.y0);
      assert.deepStrictEqual(over, [], 'no cover rect is painted above the edited text');
    }
    for (const [route, mode] of [['edits', 'right'], ['fit', 'center']]) {
      // 정렬도 같은 트랜잭션: 실행 취소 한 번, 반환한 lineIdxs가 옮겨진 최종 위치
      const name = path.join(dir, `align-${mode}.pdf`); fs.writeFileSync(name, source);
      const old = (await get('/api/pdf/objects', name))[1].bounds;
      const align = { mode, oldBounds: old };
      const r = await post(`/api/pdf/${route}`, route === 'edits'
        ? { name, i: 0, edits: [{ idx: 1, text: 'Short line' }], align }
        : { name, i: 0, idx: 1, text: 'Short line', maxWidth: 400, mode: 'wrap', align });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      assert.strictEqual(r.undoLeft, 1, 'edit + align is one undo step');
      const nb = (await get('/api/pdf/objects', name))[r.lineIdxs[0]].bounds;
      assert(nb.x0 > old.x0 + 40, `moved: ${JSON.stringify([old, nb])}`);
      if (mode === 'right') assert(Math.abs(nb.x1 - old.x1) < 0.5, JSON.stringify([old, nb]));
      else assert(Math.abs((nb.x0 + nb.x1) - (old.x0 + old.x1)) < 1, JSON.stringify([old, nb]));
    }
    {
      // 공백으로 비운 곁가지가 저장 뒤 'ÿ'로 읽히면 검사를 느슨하게 하지 않고 그 객체를 지운다(기준 조각 인덱스도 당긴다)
      const objs = [{ type: 'text', text: 'X' }, { type: 'text', text: 'ÿ' }, { type: 'text', text: 'NEW' }];
      const removed = [];
      const fake = { objects: () => objs, removeObject: (i, idx) => { removed.push(idx); objs.splice(idx, 1); return { ok: true }; } };
      const results = [{ idx: 1 }, { idx: 2 }];
      assert.strictEqual(verifyEdits(fake, 0, [{ idx: 1, text: ' ' }, { idx: 2, text: 'NEW' }], results, { primary: 2 }), 1);
      assert.deepStrictEqual(removed, [1]);
      assert.strictEqual(results[1].idx, 1, 'primary index shifts down');
      assert.strictEqual(results[0].removed, true);
      assert.throws(() => verifyEdits({ objects: () => [{ type: 'text', text: 'old' }] }, 0, [{ idx: 0, text: 'new' }], [{ idx: 0 }], { primary: 0 }), /그대로 저장하지 못합니다/, 'primary mismatch still fails');
    }
    {
      // 4.0.1 가리기 덮개: 같은 줄 여러 조각(한글 PDF는 글자마다 객체)을 한 번에 가리면 덮개(mask 객체)는 줄마다 1개,
      // 높이는 줄 높이로 균일(하이픈 자리도 숫자 자리와 같은 높이), 가린 글자는 텍스트에 0건, 실행 취소 한 번에 원상
      const notice = fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf'));
      const { groupLines } = require('./text-grouping');
      const partsFor = (line, sub) => {
        const from = line.text.indexOf(sub), to = from + sub.length; let off = 0; const parts = [];
        line.objs.forEach((o, j) => {
          const s = off, e = off + o.text.length; off = e + (line.seps[j] || '').length;
          const a = Math.max(from, s), b = Math.min(to, e);
          if (a < b) parts.push({ idx: o.idx, from: a - s, to: b - s });
        });
        return parts;
      };
      const masks = (objs) => objs.filter((o) => o.mask);
      const name = path.join(dir, 'notice.pdf'); fs.writeFileSync(name, notice);
      const before = await get('/api/pdf/objects', name);
      const ask = groupLines(before).find((l) => l.text.startsWith('문의:'));
      const phone = partsFor(ask, '010-1234-5678');
      assert(phone.length >= 13, `연락처는 여러 조각(${phone.length})`);
      const r = await post('/api/pdf/mask', { name, i: 0, parts: phone });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      assert.deepStrictEqual([r.ok, r.rects.length, r.skipped.length, r.undoLeft], [true, 1, 0, 1], JSON.stringify(r));
      const after = await get('/api/pdf/objects', name), added = masks(after);
      assert.strictEqual(added.length, 1, '같은 줄 13조각 → 덮개 1개');
      const cover = added[0].bounds, em = ask.objs[0].size * ask.objs[0].matrix[3], base = ask.objs[0].origin.y;
      assert(cover.y0 <= base - 0.25 * em + 0.01 && cover.y1 >= base + 0.85 * em - 0.01, `줄 높이(기준선 −0.25em ~ +0.85em 이상): ${JSON.stringify(cover)}`);
      const dash = ask.objs.find((o) => o.text === '-').bounds, digit = ask.objs.find((o) => o.text === '0').bounds;
      assert(cover.y0 < dash.y0 - 2 && cover.y1 > dash.y1 + 4 && cover.y0 < digit.y0 && cover.y1 > digit.y1, '하이픈 자리도 숫자 자리와 같은 높이로 덮인다');
      const last = ask.objs.find((o) => o.text === '8').bounds;
      assert(cover.x0 <= digit.x0 && cover.x1 >= last.x1, '가로는 첫 글자 왼쪽 ~ 마지막 글자 오른쪽(사이 틈 포함)');
      for (const k of ['010', '1234', '5678']) assert(!r.textLeft.includes(k), `가린 글자 텍스트 0건: ${k}`);
      assert(r.textLeft.includes('문의: 모임지기'), '앞부분은 남는다');
      // 같은 줄을 따로 한 번 더 가려도(남은 한글) 높이가 같다 — 줄 높이는 같은 줄 글자 전체 기준
      const ask2 = groupLines(after).find((l) => l.text.startsWith('문의:'));
      const r2 = await post('/api/pdf/mask', { name, i: 0, parts: partsFor(ask2, '모임지기'), color: 'auto' });
      assert.deepStrictEqual([r2.ok, r2.rects.length], [true, 1], JSON.stringify(r2));
      assert(Math.abs((r2.rects[0].y1 - r2.rects[0].y0) - (cover.y1 - cover.y0)) < 0.01, '같은 줄의 두 번째 덮개도 같은 높이');
      const autoMask = masks(await get('/api/pdf/objects', name)).at(-1);
      assert(autoMask.color.slice(0, 3).every((v) => v >= 250), `'auto'는 배경색(흰색): ${autoMask.color}`);
      // 실행 취소 한 번 = 가리기 한 번
      await post('/api/pdf/undo', { name });
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert.strictEqual(masks(undone).length, 0, '두 번 되돌리면 덮개 0개');
      assert((await get('/api/pdf/text', name)).text.includes('010-1234-5678'), '되돌리면 연락처 글자가 돌아온다');
      // 여러 줄(장소·문의 줄 전체)을 한 요청으로 가리면 줄마다 1개
      const lines = groupLines(undone).filter((l) => l.text.startsWith('장소:') || l.text.startsWith('문의:'));
      const both = lines.flatMap((l) => l.objs.filter((o) => o.text.length).map((o) => ({ idx: o.idx, from: 0, to: o.text.length })));
      const r3 = await post('/api/pdf/mask', { name, i: 0, parts: both });
      assert.deepStrictEqual([r3.ok, r3.rects.length, r3.undoLeft], [true, 2, 1], JSON.stringify(r3));
      const [h1, h2] = r3.rects.map((b) => b.y1 - b.y0);
      assert(r3.rects[0].y0 > r3.rects[1].y1 || r3.rects[1].y0 > r3.rects[0].y1, '두 줄의 덮개는 겹치지 않는다');
      assert(Math.abs(h1 - h2) < 0.5, `같은 글자 크기의 두 줄은 높이가 거의 같다: ${h1} / ${h2}`);
      const left = (await get('/api/pdf/text', name)).text;
      assert(!left.includes('동네') && !left.includes('010'), '두 줄의 글자 모두 제거');
      console.log(`mask covers: OK — 연락처 ${phone.length}조각 → 덮개 1개(높이 ${(cover.y1 - cover.y0).toFixed(2)}pt), 두 줄 → 2개`);
    }
    await stage2(dir, post, get);
    await v6(dir, post, get, bytes);
    console.log('pdf edit transaction: OK');
  } finally {
    const absolute = path.resolve(dir), root = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('test cleanup outside temporary directory');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
