// 자체 검사: node app/pdf-wave-e.test.js
// v6 Wave E(양식 채우기 · Word·한글 내보내기)를 순수 함수 → 엔진 → 진짜 PDFium 라우트(127.0.0.1:4955) 순으로 검사한다.
// 시험 PDF는 여기서 만든다(pdf-test-fixtures buildFormPdf · 말뭉치 · 동봉 안내문). 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더로 돌린다.
// 사용자 앱의 4747 포트는 쓰지 않는다. 파이썬(pypdf·PyMuPDF·python-docx)이 있으면 독립 검사도 한다(없으면 건너뛴다)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'wavee-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 4955;
process.env.RETEXTPDF_PORT = String(PORT);

const { buildFormPdf, buildPdf } = require('./pdf-test-fixtures');
const { open } = require('./pdf-engine');
const MD = require('./pdf-markdown');
const FORMS = require('./pdf-forms');
const OFFICE = require('./pdf-office');
const WIN = process.platform === 'win32';

const pagesOf = (d) => Array.from({ length: d.pageCount }, (_, i) => ({ ...d.pageSize(i), objs: d.objects(i) }));
const byName = (fields, n, k = 0) => fields.filter((f) => f.name === n)[k];
const entryText = (zipBuf, name) => { const e = OFFICE.unzip(zipBuf).find((x) => x.name === name); assert.ok(e, `${name}가 있다`); return e.data.toString('utf8'); };
const inkCount = (raw, r, scale) => { // 쪽 좌표 사각형 안의 진한 픽셀 수(그린 글자가 있는지)
  let n = 0;
  for (let y = Math.floor((raw.h / scale - r[3]) * scale); y < Math.ceil((raw.h / scale - r[1]) * scale); y++) {
    for (let x = Math.floor(r[0] * scale) + 3; x < Math.ceil(r[2] * scale) - 3; x++) {
      const p = y * raw.stride + x * 4;
      if (raw.data[p] + raw.data[p + 1] + raw.data[p + 2] < 300) n++;
    }
  }
  return n;
};
const py = (name, lines, args) => {
  const script = path.join(DIR, name);
  fs.writeFileSync(script, lines.join('\n'));
  return spawnSync('python', ['-I', script, ...args], { encoding: 'utf8' });
};

(async () => {
  // ── 1. 엔진: 양식 칸 읽기 · 값 쓰기 · 한글 외형 · 저장·재열기 · 초기화 · 고정 · XFA ─────────────
  {
    const d = await open(buildFormPdf());
    assert.strictEqual(d.formType(), 'acroform');
    const { fields } = d.formFields();
    assert.deepStrictEqual(fields.map((f) => `${f.name}:${f.type}`), ['name:text', 'addr:text', 'memo:text', 'agree:checkbox', 'color:radio', 'color:radio', 'city:combo', 'langs:list', 'sig:signature', 'note2:text']);
    const f = (n, k) => byName(fields, n, k);
    assert.ok(f('name').required && !f('addr').required, '필수 칸(Ff 2)');
    assert.ok(f('memo').multiline && f('sig').readOnly, '여러 줄 칸 · 서명 칸은 읽기 전용');
    assert.deepStrictEqual([f('name').fontSize, f('memo').color, f('name').alt], [12, '#0000ff', 'Full name'], '/DA 글자 크기·색, /TU');
    assert.deepStrictEqual([f('color', 0).exportValue, f('color', 1).exportValue, f('agree').exportValue], ['Red', 'Blue', 'Yes'], '내보내기 값');
    assert.deepStrictEqual(f('city').options.map((o) => [o.label, o.selected]), [['Seoul', true], ['Busan', false], ['Daegu', false]]);
    assert.deepStrictEqual([f('note2').i, f('note2').rotation], [1, 1], '돌린 쪽(/Rotate 90)의 칸');
    assert.throws(() => d.setFormValue(0, f('sig').index, 'x'), (e) => e.status === 400 && /서명 칸/.test(e.message));
    assert.throws(() => d.setFormValue(0, f('city').index, 'Tokyo'), (e) => e.status === 400, '목록에 없는 항목');
    const uni = [];
    const put = (n, v, k) => { const r = d.setFormValue(f(n, k).i, f(n, k).index, v); assert.strictEqual(r.ok, true); uni.push(...r.unicode); return r; };
    put('name', '홍길동'); put('addr', 'Seoul 1'); put('agree', true); put('color', 'Blue', 1); put('city', 'Busan'); put('langs', 'Japanese'); put('note2', '돌린 쪽 메모');
    assert.deepStrictEqual(uni.map((u) => u.value), ['홍길동', '돌린 쪽 메모'], '표준 글꼴로 못 그리는 값만 외형을 다시 쓴다');
    // PDFium 외형: 한글이 빈칸 → 맑은 고딕 외형으로 다시 쓰면 글자가 그려진다(Windows — 맑은 고딕)
    const before = d._renderRaw(0, 2);
    let bytes = d.save();
    d.close();
    if (WIN && FORMS.krFontPath()) {
      bytes = FORMS.fixUnicodeAppearances(bytes, uni);
      const e = await open(bytes);
      const after = e._renderRaw(0, 2);
      const r = f('name').rect;
      assert.ok(inkCount(after, r, 2) > inkCount(before, r, 2) + 40, `한글 외형이 그려진다(${inkCount(before, r, 2)} → ${inkCount(after, r, 2)})`);
      e.close();
    }
    const e = await open(bytes);
    const v = Object.fromEntries(e.formFields().fields.map((x) => [x.name, x.type === 'radio' || x.type === 'checkbox' ? x.value : x.value]));
    assert.deepStrictEqual([v.name, v.addr, v.agree, v.color, v.city, v.langs, v.note2], ['홍길동', 'Seoul 1', 'Yes', 'Blue', 'Busan', 'ja', '돌린 쪽 메모'], '저장·재열기 뒤 값');
    assert.deepStrictEqual(e.formFields().fields.filter((x) => x.name === 'color').map((x) => x.checked), [false, true], '라디오는 하나만');
    // 가져오기(이름 → 값) · 없는 이름 · 내보내기 값으로 준 목록 항목
    let r = e.setFormValues({ langs: 'en', color: 'Red', nope: 'x', name: '' });
    assert.deepStrictEqual([r.set, r.unknown], [3, ['nope']]);
    assert.deepStrictEqual(e.formFields().fields.filter((x) => ['langs', 'color', 'name'].includes(x.name)).map((x) => x.value), ['', 'Red', 'Red', 'en']);
    // 초기화
    r = e.resetForm();
    assert.ok(r.ok && r.reset >= 5, `초기화 ${r.reset}칸`);
    assert.ok(e.formFields().fields.every((x) => ['', 'Off'].includes(x.value) || x.name === 'city'), '초기화 뒤 빈 값');
    e.close();
    // 고정: 상태별 외형을 하나로 → 칸을 쪽 내용으로 → /AcroForm 떼기
    const g = await open(FORMS.resolveAppearanceStates(bytes).bytes);
    const fl = g.flattenForm();
    assert.ok(fl.flattened >= 9 && fl.removed === 1, `고정 ${JSON.stringify(fl)} — 빈 서명 칸만 뺀다`);
    const flat = FORMS.stripAcroForm(g.save()); g.close();
    const h = await open(flat);
    assert.deepStrictEqual([h.formType(), h.formFields().fields.length, h.annots(0).length], ['none', 0, 0], '고정 뒤에는 양식이 없다');
    const raw = h._renderRaw(0, 2);
    assert.ok(inkCount(raw, byName(fields, 'agree').rect, 2) > 10, '고정한 확인란 표시가 남는다');
    h.close();
    // XFA 전용
    const x = await open(buildFormPdf({ xfa: true }));
    assert.deepStrictEqual(x.formFields(), { type: 'xfa-full', fields: [] }); x.close();
    // 양식 없는 문서: 그리기·목록이 예전 그대로
    const plain = await open(buildPdf());
    assert.deepStrictEqual(plain.formFields(), { type: 'none', fields: [] }); plain.close();
    console.log('  엔진 양식 검사 통과');
  }

  // ── 2. 양식 데이터(순수): JSON · FDF · XFDF 쓰기 → 읽기 ─────────────────────
  {
    const fields = [{ name: 'a', type: 'text', value: '한글 값 (괄호) \\ 끝' }, { name: 'b', type: 'checkbox', value: 'Yes' }, { name: 'c', type: 'radio', value: 'Off' }, { name: 'c', type: 'radio', value: 'Off' },
      { name: 'd', type: 'list', value: 'ja' }, { name: 's', type: 'signature', value: '' }, { name: 'e', type: 'text', value: 'x<&>"y' }];
    const want = { a: '한글 값 (괄호) \\ 끝', b: 'Yes', c: 'Off', d: 'ja', e: 'x<&>"y' };
    assert.deepStrictEqual(FORMS.collectValues(fields), want, '서명 칸은 빼고 이름마다 하나');
    assert.deepStrictEqual(FORMS.parseData(Buffer.from(FORMS.toJson(fields, 'x.pdf'))), { format: 'json', values: want });
    assert.deepStrictEqual(FORMS.parseData(FORMS.toFdf(fields, 'x.pdf')), { format: 'fdf', values: want });
    assert.deepStrictEqual(FORMS.parseData(Buffer.from(FORMS.toXfdf(fields, 'x.pdf'))), { format: 'xfdf', values: want });
    assert.match(FORMS.toFdf(fields).toString('latin1'), /\/T \(b\) \/V \/Yes/, 'FDF: 단추 값은 이름');
    assert.deepStrictEqual(FORMS.parseData(Buffer.from('{"x": "1"}')).values, { x: '1' }, '평면 JSON도 받는다');
    assert.deepStrictEqual(FORMS.parseXfdf('<xfdf><fields><field name="p"><field name="q"><value>1</value></field></field></fields></xfdf>'), { 'p.q': '1' }, 'XFDF 중첩 이름');
    assert.deepStrictEqual(FORMS.parseFdf(Buffer.from('%FDF-1.2\n1 0 obj << /FDF << /Fields [ << /T (p) /Kids [ << /T (q) /V (2) >> ] >> ] >> >> endobj')), { 'p.q': '2' }, 'FDF /Kids');
    assert.throws(() => FORMS.parseData(Buffer.from('hello')), (e) => e.status === 400);
  }

  // ── 3. Word·한글(순수 + 엔진): 구조 모델 → .docx · .hwpx ─────────────────────
  const outs = {};
  {
    const corpus = path.join(__dirname, 'test-data', 'grouping');
    const modelOf = async (buf, opts = {}) => { const d = await open(buf); const r = MD.convert(pagesOf(d), { stripHeaderFooter: true, blocks: true, ...opts }); d.close(); return r; };
    // 구조 모델: 표·목록·제목·글 조각(굵게·색)
    const table = await modelOf(fs.readFileSync(path.join(corpus, '09-table.pdf')));
    const tb = table.pages[0].blocks.filter((b) => b.type === 'table');
    assert.strictEqual(tb.length, 2);
    assert.deepStrictEqual(tb[0].rows.map((r) => r.map((c) => c.runs.map((x) => x.text).join(''))), [['품목', '수량', '단가', '금액'], ['사무용 의자', '12', '85,000', '1,020,000']]);
    assert.ok(tb[0].rows[0][0].runs[0].b && !tb[0].rows[1][0].runs[0].b, '머리 칸은 굵게');
    const mixed = await modelOf(fs.readFileSync(path.join(corpus, '05-mixed-styles.pdf')));
    const runs = mixed.pages[0].blocks[1].runs;
    assert.deepStrictEqual(runs.filter((x) => x.b).map((x) => x.text), ['굵은 글씨', 'bold']);
    assert.deepStrictEqual(runs.filter((x) => x.color === '#cc0000').map((x) => x.text), ['빨간 글씨'], '색 조각');
    assert.deepStrictEqual(runs.filter((x) => x.i).map((x) => x.text.trim()), ['기울임', 'italic']);
    const guide = await modelOf(fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf')));
    const gb = guide.pages[0].blocks;
    assert.deepStrictEqual(gb.filter((b) => b.type === 'heading').map((b) => [b.level, b.runs.map((x) => x.text).join('')]), [[1, '10월 독서 모임 안내'], [2, '이번 달 책'], [2, '진행 순서'], [2, '준비물'], [2, '참고']]);
    assert.deepStrictEqual(gb.filter((b) => b.type === 'list').length, 6);
    assert.ok(gb.filter((b) => b.type === 'list').every((b) => !b.ordered && !/^[•·\-]/.test(b.runs[0].text)), '글머리 표시는 뗀다');
    const lists = await modelOf(fs.readFileSync(path.join(corpus, '07-lists.pdf')));
    assert.deepStrictEqual(lists.pages[0].blocks.filter((b) => b.ordered).map((b) => [b.n, b.runs[0].text]), [[1, '번호가 있는 항목'], [2, 'Another numbered item']], '번호 목록(번호 표시는 뗀다)');
    // 그림 하나가 든 쪽(그림 넣기)
    const im = await open(buildPdf({ pages: [{ w: 400, h: 400, content: 'BT /F1 18 Tf 40 340 Td (Picture page) Tj ET' }] }));
    const rgba = Buffer.alloc(40 * 30 * 4);
    for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) rgba.set([x * 6, y * 8, 120, 255], (y * 40 + x) * 4);
    im.insertImage(0, { kind: 'rgba', data: rgba, width: 40, height: 30 }, { x: 60, y: 200, w: 120, h: 90 });
    const imgModel = MD.convert(pagesOf(im), { blocks: true, images: 'files', imageName: (p, k) => `p${p + 1}-${k}.png` });
    const images = new Map(imgModel.images.map((x) => [x.name, { data: im.renderArea(x.page, x.rect, 2), w: x.rect.x1 - x.rect.x0, h: x.rect.y1 - x.rect.y0 }]));
    im.close();
    assert.strictEqual(images.size, 1, '그림 자리 하나');
    const date = new Date('2026-10-15T09:00:00Z');
    for (const [key, model, imgs] of [['table', table, null], ['guide', guide, null], ['mixed', mixed, null], ['lists', lists, null], ['image', imgModel, images]]) {
      outs[key] = { docx: OFFICE.toDocx(model.pages, { title: key, images: imgs || new Map(), date }), hwpx: OFFICE.toHwpx(model.pages, { title: key, images: imgs || new Map(), date }) };
    }
    // DOCX: 꾸러미 · 제목 스타일 · 글머리(numPr) · 표 · 한글 · 굵게 · 동아시아 글꼴 · 쪽 크기 · 그림
    const z = OFFICE.unzip(outs.guide.docx).map((e) => e.name);
    for (const n of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) assert.ok(z.includes(n), `docx ${n}`);
    const doc = entryText(outs.guide.docx, 'word/document.xml');
    assert.match(doc, /<w:pStyle w:val="Heading1"\/><\/w:pPr><w:r><w:rPr><w:rFonts w:ascii="맑은 고딕" w:hAnsi="맑은 고딕" w:eastAsia="맑은 고딕" w:cs="맑은 고딕"\/><w:b\/><w:bCs\/><w:sz w:val="44"\/><w:szCs w:val="44"\/><\/w:rPr><w:t xml:space="preserve">10월 독서 모임 안내<\/w:t>/);
    assert.strictEqual((doc.match(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/g) || []).length, 6, '글머리 목록 6줄');
    assert.match(doc, /<w:pgSz w:w="11918" w:h="16858"\/>/, '쪽 크기 = 첫 쪽(pt × 20)');
    assert.match(entryText(outs.guide.docx, 'word/styles.xml'), /w:styleId="Heading1"[\s\S]*w:styleId="Heading2"[\s\S]*w:styleId="Heading3"[\s\S]*w:styleId="ListParagraph"[\s\S]*w:styleId="TableGrid"/);
    assert.match(entryText(outs.guide.docx, 'word/numbering.xml'), /<w:numFmt w:val="bullet"\/><w:lvlText w:val="•"\/>/);
    const tdoc = entryText(outs.table.docx, 'word/document.xml');
    assert.strictEqual((tdoc.match(/<w:tbl>/g) || []).length, 2, '표 두 개');
    assert.match(tdoc, /<w:tc><w:tcPr><w:tcW w:w="\d+" w:type="dxa"\/><\/w:tcPr><w:p><w:r><w:rPr><w:rFonts [^>]+\/><w:b\/><w:bCs\/>[^]*?<w:t xml:space="preserve">품목<\/w:t>/);
    assert.match(tdoc, /w:orient="landscape"/, '가로 쪽');
    assert.match(entryText(outs.mixed.docx, 'word/document.xml'), /<w:color w:val="CC0000"\/>[^]*?빨간 글씨/);
    assert.match(entryText(outs.lists.docx, 'word/numbering.xml'), /<w:num w:numId="2"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"\/>/, '번호 목록 정의');
    const idoc = OFFICE.unzip(outs.image.docx);
    assert.ok(idoc.some((e) => e.name === 'word/media/image1.png' && e.data.subarray(1, 4).toString() === 'PNG'), 'docx 그림');
    assert.match(entryText(outs.image.docx, 'word/_rels/document.xml.rels'), /Id="rIdImg1"[^>]+Target="media\/image1\.png"/);
    // HWPX: mimetype 맨 앞·무압축 · 필수 부분 · 헤더 개수 · 글자 모양 참조 · 한글·굵게·표·제목 스타일 · 그림
    const hz = OFFICE.unzip(outs.guide.hwpx);
    assert.deepStrictEqual([hz[0].name, hz[0].method, hz[0].extra, hz[0].data.toString()], ['mimetype', 0, 0, 'application/hwp+zip'], 'mimetype 맨 앞·무압축');
    for (const n of ['version.xml', 'META-INF/container.xml', 'META-INF/manifest.xml', 'Contents/content.hpf', 'Contents/header.xml', 'Contents/section0.xml', 'settings.xml', 'Preview/PrvText.txt']) assert.ok(hz.some((e) => e.name === n), `hwpx ${n}`);
    const head = entryText(outs.guide.hwpx, 'Contents/header.xml'), sec = entryText(outs.guide.hwpx, 'Contents/section0.xml');
    for (const [list, item] of [['charProperties', 'charPr'], ['paraProperties', 'paraPr'], ['styles', 'style'], ['borderFills', 'borderFill']]) {
      const cnt = Number(new RegExp(`<hh:${list} itemCnt="(\\d+)"`).exec(head)[1]);
      assert.strictEqual(cnt, (head.match(new RegExp(`<hh:${item} `, 'g')) || []).length, `${list} itemCnt`);
    }
    const charIds = new Set([...head.matchAll(/<hh:charPr id="(\d+)"/g)].map((m) => m[1]));
    assert.ok([...sec.matchAll(/charPrIDRef="(\d+)"/g)].every((m) => charIds.has(m[1])), '본문의 글자 모양 참조가 모두 header에 있다');
    assert.match(sec, /<hp:p id="0" paraPrIDRef="1" styleIDRef="1"[^>]*><hp:run charPrIDRef="0"><hp:secPr [^]*?<\/hp:secPr><hp:ctrl><hp:colPr [^>]+\/><\/hp:ctrl><\/hp:run><hp:run charPrIDRef="(\d+)"><hp:t>10월 독서 모임 안내<\/hp:t>/, '첫 문단 = 구역 정의 + 제목 1');
    assert.match(head, /<hh:style id="1" type="PARA" name="제목 1" engName="Heading 1"/);
    assert.strictEqual((sec.match(/<hp:t>• <\/hp:t>/g) || []).length, 6, '글머리 6줄');
    const boldIds = new Set([...head.matchAll(/<hh:charPr id="(\d+)"[^>]*>(?:(?!<\/hh:charPr>).)*<hh:bold\/>/g)].map((m) => m[1]));
    const th = entryText(outs.table.hwpx, 'Contents/section0.xml');
    const tHead = entryText(outs.table.hwpx, 'Contents/header.xml');
    const tBold = new Set([...tHead.matchAll(/<hh:charPr id="(\d+)"[^>]*>(?:(?!<\/hh:charPr>).)*<hh:bold\/>/g)].map((m) => m[1]));
    assert.ok(boldIds.size >= 1 && tBold.size >= 1, '굵은 글자 모양');
    assert.match(th, /<hp:tbl [^>]*rowCnt="2" colCnt="4"[^>]*>[^]*?<hp:tc [^>]*><hp:subList [^>]*><hp:p [^>]*><hp:run charPrIDRef="(\d+)"><hp:t>품목<\/hp:t>/, '표: 2행 4열, 칸 글');
    const firstCellChar = /<hp:run charPrIDRef="(\d+)"><hp:t>품목<\/hp:t>/.exec(th)[1];
    assert.ok(tBold.has(firstCellChar), '머리 칸은 굵게');
    assert.match(th, /<hp:pagePr landscape="NARROWLY" width="42000" height="59592"/, '가로 쪽(한글은 용지를 세로로 적고 방향을 따로)');
    assert.match(entryText(outs.guide.hwpx, 'Preview/PrvText.txt'), /^10월 독서 모임 안내\r\n일시:/);
    const ih = OFFICE.unzip(outs.image.hwpx);
    assert.ok(ih.some((e) => e.name === 'BinData/image1.png'), 'hwpx 그림');
    assert.match(entryText(outs.image.hwpx, 'Contents/content.hpf'), /<opf:item id="image1" href="BinData\/image1\.png" media-type="image\/png" isEmbeded="1"\/>/);
    assert.match(entryText(outs.image.hwpx, 'Contents/section0.xml'), /<hc:img binaryItemIDRef="image1"/);
    // 만든 XML이 모두 잘 짜였는지(여닫기 짝) — 간단한 짝 맞추기
    for (const [k, o] of Object.entries(outs)) for (const buf of [o.docx, o.hwpx]) for (const e of OFFICE.unzip(buf)) {
      if (!/\.(xml|rels|hpf|rdf)$/.test(e.name)) continue;
      const stack = [];
      for (const m of e.data.toString('utf8').matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^>]*?(\/?)>/g)) {
        if (m[0].startsWith('<?')) continue;
        if (m[1]) assert.strictEqual(stack.pop(), m[2], `${k} ${e.name}: </${m[2]}> 짝`); else if (!m[3]) stack.push(m[2]);
      }
      assert.strictEqual(stack.length, 0, `${k} ${e.name}: 닫히지 않은 요소 없음`);
    }
    for (const [k, o] of Object.entries(outs)) { fs.writeFileSync(path.join(DIR, `${k}.docx`), o.docx); fs.writeFileSync(path.join(DIR, `${k}.hwpx`), o.hwpx); }
    console.log('  Word·한글 구조 검사 통과');
  }

  // ── 4. 라우트(진짜 PDFium): 양식 · 실행 취소 · 저장·재열기 · 데이터 · 고정 · Word·한글 · 일괄 처리 ─────────
  const { _test } = require('./server.js');
  const { server, pdfDocs } = _test;
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const raw = (method, route, data) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let body = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end(data);
  });
  const post = (route, data) => raw('POST', route, JSON.stringify(data));
  const get = (route, q) => raw('GET', route + '?' + new URLSearchParams(q));
  const file = (n, bytes) => { const f = path.join(DIR, n); fs.writeFileSync(f, bytes); return f; };
  const pyFiles = {};
  try {
    {
      const name = file('신청서.pdf', buildFormPdf());
      let r = await get('/api/pdf/form', { name });
      assert.strictEqual(r.body.type, 'acroform');
      const fields = r.body.fields, f = (n, k) => byName(fields, n, k);
      assert.ok(!('objNum' in fields[0]) && !('flags' in fields[0]), '내부 번호는 화면에 보내지 않는다');
      const set = (n, value, k) => post('/api/pdf/form/set', { name, i: f(n, k).i, index: f(n, k).index, value });
      r = await set('addr', '서울시 강남구 테헤란로 1');
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.strictEqual(r.body.undoLeft, 1, '칸 하나 = 실행 취소 한 번');
      assert.ok(!('unicode' in r.body) && !r.body.warning);
      r = await set('agree', true); assert.strictEqual(r.body.undoLeft, 2);
      r = await set('color', 'Blue', 1); r = await set('city', 'Daegu'); r = await set('note2', '회전 쪽 한글');
      r = await set('sig', 'x'); assert.strictEqual(r.status, 400, '서명 칸');
      r = await post('/api/pdf/undo', { name });
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(byName((await get('/api/pdf/form', { name })).body.fields, 'note2').value, '', '실행 취소 → 값이 돌아간다');
      r = await post('/api/pdf/redo', { name });
      assert.strictEqual(byName((await get('/api/pdf/form', { name })).body.fields, 'note2').value, '회전 쪽 한글', '다시 실행');
      r = await post('/api/pdf/save', { name }); assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      // 저장·재열기(새 엔진) → 값 그대로
      const re = await open(fs.readFileSync(name));
      const rv = Object.fromEntries(re.formFields().fields.map((x) => [x.name, x.value]));
      assert.deepStrictEqual([rv.addr, rv.agree, rv.color, rv.city, rv.note2], ['서울시 강남구 테헤란로 1', 'Yes', 'Blue', 'Daegu', '회전 쪽 한글']);
      re.close();
      pyFiles.filled = name;
      // 데이터 내보내기 · 가져오기(FDF) — 한 번에 실행 취소 한 번
      const json = path.join(DIR, '신청서-양식.json'), fdf = path.join(DIR, '값.fdf');
      r = await post('/api/pdf/form/export', { name, to: json });
      assert.strictEqual(r.body.ok, true);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(json, 'utf8')).fields.addr, '서울시 강남구 테헤란로 1');
      r = await post('/api/pdf/form/export', { name, to: path.join(DIR, 'x.txt') }); assert.strictEqual(r.status, 400);
      fs.writeFileSync(fdf, FORMS.toFdf([{ name: 'name', type: 'text', value: '김철수' }, { name: 'agree', type: 'checkbox', value: 'Off' }, { name: 'ghost', type: 'text', value: '?' }]));
      const undoBefore = (await get('/api/pdf/info', { name })).body.undoLeft;
      r = await post('/api/pdf/form/import', { name, path: fdf });
      assert.deepStrictEqual([r.body.ok, r.body.set, r.body.unknown, r.body.format, r.body.undoLeft], [true, 2, ['ghost'], 'fdf', undoBefore + 1]);
      const after = (await get('/api/pdf/form', { name })).body.fields;
      assert.deepStrictEqual([byName(after, 'name').value, byName(after, 'agree').checked], ['김철수', false]);
      // 초기화 → 실행 취소
      r = await post('/api/pdf/form/reset', { name }); assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.reloadAll, true);
      assert.strictEqual(byName((await get('/api/pdf/form', { name })).body.fields, 'addr').value, '');
      await post('/api/pdf/undo', { name });
      assert.strictEqual(byName((await get('/api/pdf/form', { name })).body.fields, 'addr').value, '서울시 강남구 테헤란로 1');
      // 고정 → 양식 없음 → 실행 취소로 되돌린다
      r = await post('/api/pdf/form/flatten', { name });
      assert.ok(r.body.ok && r.body.flattened >= 9, JSON.stringify(r.body));
      assert.strictEqual((await get('/api/pdf/form', { name })).body.type, 'none');
      const flatTo = path.join(DIR, '신청서-고정.pdf');
      await post('/api/pdf/saveas', { name, to: flatTo }); pyFiles.flat = flatTo;
      // XFA 전용
      const xname = file('xfa.pdf', buildFormPdf({ xfa: true }));
      assert.deepStrictEqual((await get('/api/pdf/form', { name: xname })).body, { type: 'xfa-full', fields: [] });
    }
    // Word·한글 내보내기 라우트 · 일괄 처리
    {
      const guide = file('안내.pdf', fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf')));
      let r = await post('/api/pdf/export-office', { name: guide, to: path.join(DIR, '안내.docx'), jobId: 'of1' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.format, r.body.stats.headings, r.body.stats.lists], ['docx', 5, 6]);
      r = await post('/api/pdf/export-office', { name: guide, to: path.join(DIR, '안내.hwpx') });
      assert.strictEqual(r.body.format, 'hwpx');
      assert.match(entryText(fs.readFileSync(path.join(DIR, '안내.hwpx')), 'Contents/section0.xml'), /<hp:t>10월 독서 모임 안내<\/hp:t>/);
      r = await post('/api/pdf/export-office', { name: guide, to: path.join(DIR, '안내.doc') }); assert.strictEqual(r.status, 400);
      const tbl = file('09-table.pdf', fs.readFileSync(path.join(__dirname, 'test-data', 'grouping', '09-table.pdf')));
      r = await post('/api/pdf/batch', { paths: [guide, tbl], action: 'docx', options: { images: 'embed' }, nameSuffix: '-w' });
      assert.deepStrictEqual([r.body.ok, r.body.done], [true, 2], JSON.stringify(r.body));
      r = await post('/api/pdf/batch', { paths: [guide, tbl], action: 'hwpx', options: {}, nameSuffix: '-h' });
      assert.deepStrictEqual([r.body.ok, r.body.done], [true, 2]);
      assert.ok(fs.existsSync(path.join(DIR, '09-table-w.docx')) && fs.existsSync(path.join(DIR, '09-table-h.hwpx')));
      pyFiles.docx = [path.join(DIR, '안내.docx'), path.join(DIR, '09-table-w.docx')];
    }
    console.log('  라우트 검사 통과');

    // ── 5. 파이썬 독립 검사(있으면): pypdf 칸 값 · PyMuPDF 칸 값·글자 · python-docx 제목·목록·표·굵게 ─────────
    {
      const p = py('check_wave_e.py', [
        'import sys, json',
        'out = {}',
        'from pypdf import PdfReader',
        'r = PdfReader(sys.argv[1]); out["pypdf"] = {k: str(v.get("/V")) for k, v in (r.get_fields() or {}).items() if v.get("/V") is not None}',
        'import fitz',
        'd = fitz.open(sys.argv[1]); out["fitz"] = {w.field_name: w.field_value for pg in d for w in pg.widgets()}',
        'out["fitzText"] = "".join(pg.get_text() for pg in d)',
        'f = fitz.open(sys.argv[2]); out["flatWidgets"] = sum(len(list(pg.widgets())) for pg in f); out["flatText"] = f[0].get_text()',
        'import docx',
        'out["docx"] = []',
        'for name in sys.argv[3:]:',
        '    doc = docx.Document(name)',
        '    out["docx"].append({"paras": [[p.style.name, p.text, [r.bold for r in p.runs], p._p.pPr is not None and p._p.pPr.numPr is not None] for p in doc.paragraphs], "tables": [[[c.text for c in row.cells] for row in t.rows] for t in doc.tables]})',
        'print(json.dumps(out))',
      ], [pyFiles.filled, pyFiles.flat, ...pyFiles.docx]);
      if (p.status === 0) {
        const o = JSON.parse(p.stdout);
        assert.strictEqual(o.pypdf.addr, '서울시 강남구 테헤란로 1'); assert.strictEqual(o.pypdf.agree, '/Yes'); assert.strictEqual(o.pypdf.color, '/Blue'); assert.strictEqual(o.pypdf.note2, '회전 쪽 한글');
        assert.strictEqual(o.fitz.addr, '서울시 강남구 테헤란로 1'); assert.strictEqual(o.fitz.city, 'Daegu');
        if (WIN) assert.ok(o.fitzText.includes('서울시 강남구 테헤란로 1') && o.fitzText.includes('회전 쪽 한글'), 'PyMuPDF가 칸 외형의 한글을 읽는다');
        assert.strictEqual(o.flatWidgets, 0, '고정한 파일에는 칸이 없다');
        assert.ok(o.flatText.includes('서울시 강남구 테헤란로 1') || !WIN, '고정한 글자가 쪽 내용에 남는다');
        const [g, t] = o.docx;
        assert.deepStrictEqual(g.paras[0].slice(0, 2), ['Heading 1', '10월 독서 모임 안내']);
        assert.ok(g.paras[0][2].every((b) => b === true), '제목 글자는 굵게');
        assert.deepStrictEqual(g.paras.filter((x) => x[3]).length, 6, '글머리 목록 6줄(numPr)');
        assert.deepStrictEqual(g.paras.filter((x) => x[0] === 'Heading 2').map((x) => x[1]), ['이번 달 책', '진행 순서', '준비물', '참고']);
        assert.deepStrictEqual(t.tables[0], [['품목', '수량', '단가', '금액'], ['사무용 의자', '12', '85,000', '1,020,000']]);
        console.log('  pypdf·PyMuPDF·python-docx 독립 검사 통과');
      } else console.log('  파이썬 검사 건너뜀:', (p.stderr || p.error?.message || '').split('\n').slice(-2).join(' '));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(pdfDocs)) { try { pdfDocs[k].doc.close(); } catch {} delete pdfDocs[k]; }
    if (!process.exitCode) fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log('OK — v6 Wave E(양식 칸·한글 외형·저장·재열기·데이터 JSON/FDF/XFDF·초기화·고정·XFA · Word·한글 내보내기·일괄 처리) 검사 통과');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; process.exit(1); });
