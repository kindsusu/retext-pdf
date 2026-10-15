// 자체 검사: node app/pdf-features.test.js
// P9 기능(개인정보 일괄 가리기·영역 가리기·숨은 데이터 지우기·워터마크·머리말·꼬리말·주석·목차·문서 정보·이미지 PDF·쪽 범위)을
// 순수 함수 → 진짜 PDFium 라우트(127.0.0.1:4851) 순으로 검사한다. 시험 PDF는 모두 여기서 만든다(사용자 문서를 쓰지 않는다).
// 홈 폴더·도장 보관함은 저장소 tmp\ 아래 임시 폴더로 돌린다(사용자 설정 ~/.retext-pdf.json·앱 데이터에 쓰지 않는다)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'features-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 4851;
process.env.RETEXTPDF_PORT = String(PORT);

const { parsePageRange, formatPageRange } = require('./page-range');
const { parseOutlineText, formatOutlineText } = require('./outline-text');
const pii = require('./pii');
const pdfRewrite = require('./pdf-rewrite');
const { buildPdf, buildHiddenDataPdf, buildTrickyPdf, makePng } = require('./pdf-test-fixtures');
const { open } = require('./pdf-engine');
const { normalizeParts } = require('./pdf-edit-service');
const WIN = process.platform === 'win32'; // 한글 글자 넣기(맑은 고딕 대체 글꼴)는 Windows에서만

// 검사 숫자 계산(시험 데이터 만들기용 — pii.js와 따로 쓴다)
const rrnWithCheck = (d12) => { const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5]; const s = w.reduce((n, k, i) => n + k * +d12[i], 0); return d12 + ((11 - (s % 11)) % 10); };
const brnWithCheck = (d9) => { const w = [1, 3, 7, 1, 3, 7, 1, 3, 5]; let s = w.reduce((n, k, i) => n + k * +d9[i], 0); s += Math.floor((+d9[8] * 5) / 10); return d9 + ((10 - (s % 10)) % 10); };
const RRN_OK = (() => { const d = rrnWithCheck('900101123456'); return `${d.slice(0, 6)}-${d.slice(6)}`; })();
const RRN_BAD = RRN_OK.slice(0, -1) + ((+RRN_OK.slice(-1) + 1) % 10);
const BRN_OK = (() => { const d = brnWithCheck('123456789'); return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`; })();

// 렌더 픽셀: 흰색이 아닌 픽셀의 외곽 상자(영역 안에서) — 주석·워터마크가 실제로 그려졌는지 본다
const inkBox = (raw, region = { x0: 0, y0: 0, x1: raw.w - 1, y1: raw.h - 1 }, thr = 735) => {
  let box = null, n = 0;
  for (let y = Math.max(0, region.y0); y <= Math.min(raw.h - 1, region.y1); y++) for (let x = Math.max(0, region.x0); x <= Math.min(raw.w - 1, region.x1); x++) {
    const p = y * raw.stride + x * 4;
    if (raw.data[p] + raw.data[p + 1] + raw.data[p + 2] >= thr) continue;
    n++;
    box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
  }
  return box && { ...box, n };
};
const diffBox = (a, b) => { // 두 렌더에서 달라진 픽셀의 외곽 상자
  let box = null;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const p = y * a.stride + x * 4;
    if (Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]) < 30) continue;
    box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
  }
  return box;
};
const squeeze = (s) => s.replace(/\s+/g, '');
// 바이트에 글이 있는가 — 리터럴 문자열·스트림 그대로 또는 16진 문자열(<…>, pdf-rewrite가 문자열을 이렇게 쓴다)
const has = (buf, s) => buf.includes(s) || buf.includes(Buffer.from(s, 'latin1').toString('hex')) || buf.includes(Buffer.from(s, 'latin1').toString('hex').toUpperCase());

(async () => {
  // ── 1. 쪽 범위 해석기 ─────────────────────────────────────────────────────
  {
    assert.deepStrictEqual(parsePageRange('all', 5), [0, 1, 2, 3, 4]);
    assert.deepStrictEqual(parsePageRange('', 3), [0, 1, 2]);
    assert.deepStrictEqual(parsePageRange(undefined, 2), [0, 1]);
    assert.deepStrictEqual(parsePageRange('odd', 5), [0, 2, 4]);
    assert.deepStrictEqual(parsePageRange('짝수', 5), [1, 3]);
    assert.deepStrictEqual(parsePageRange('1,3,5-7', 9), [0, 2, 4, 5, 6]);
    assert.deepStrictEqual(parsePageRange('-3', 9), [0, 1, 2]);
    assert.deepStrictEqual(parsePageRange('5-', 7), [4, 5, 6]);
    assert.deepStrictEqual(parsePageRange('7, 2 - 3, 2', 9), [1, 2, 6], '공백·중복·순서');
    assert.deepStrictEqual(parsePageRange('3~4쪽', 9), [2, 3], '물결·쪽');
    assert.deepStrictEqual(parsePageRange([2, 0, 2], 3), [0, 2], '배열은 검사만');
    for (const [bad, re] of [['0', /범위/], ['10', /범위/], ['7-5', /거꾸로/], ['a', /읽을 수 없/], ['1-2-3', /읽을 수 없/], ['3-12', /범위/]]) {
      assert.throws(() => parsePageRange(bad, 9), (e) => e.code === 'BAD_RANGE' && re.test(e.message), bad);
    }
    assert.throws(() => parsePageRange('1', 0), /쪽이 없습니다/);
    assert.strictEqual(formatPageRange([0, 1, 2, 4, 6, 7]), '1-3,5,7-8');
  }

  // ── 2. 목차 글 형식 ───────────────────────────────────────────────────────
  {
    const t = '1장 시작\t1\n  1.1 하위\t2\n\t1.2 탭 하위\t3\n    1.2.1 더 깊이  4\n2장 목적지 없음\n\n3장\t5';
    const r = parseOutlineText(t, 5);
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(r.items.map((x) => [x.title, x.page]), [['1장 시작', 0], ['2장 목적지 없음', null], ['3장', 4]]);
    assert.deepStrictEqual(r.items[0].children.map((x) => [x.title, x.page]), [['1.1 하위', 1], ['1.2 탭 하위', 2]]);
    assert.deepStrictEqual(r.items[0].children[1].children.map((x) => [x.title, x.page]), [['1.2.1 더 깊이', 3]], '공백 두 칸 뒤 숫자도 쪽 번호');
    assert.strictEqual(formatOutlineText(r.items), '1장 시작\t1\n  1.1 하위\t2\n  1.2 탭 하위\t3\n    1.2.1 더 깊이\t4\n2장 목적지 없음\n3장\t5');
    const bad = parseOutlineText('가\t1\n      너무 깊음\t2\n나\t9\n다\tx\n   홀수 들여쓰기\t1\n\t\t', 5);
    assert.deepStrictEqual(bad.errors.map((e) => e.line), [2, 3, 4, 5]);
    assert.match(bad.errors[1].message, /범위/);
  }

  // ── 3. 개인정보 패턴 ─────────────────────────────────────────────────────
  {
    const text = `메일 hong.gildong@example.com 전화 010-1234-5678, 010 2345 6789, 02-123-4567, 031)123-4567 주민 ${RRN_OK} 틀린 ${RRN_BAD} 사업자 ${BRN_OK} 카드 4111-1111-1111-1111 / 1234 5678 9012 3456 일련 12345678901234`;
    const hits = pii.findPii(text);
    const by = (k) => hits.filter((h) => h.kind === k).map((h) => h.text);
    assert.deepStrictEqual(by('email'), ['hong.gildong@example.com']);
    assert.deepStrictEqual(by('phone'), ['010-1234-5678', '010 2345 6789', '02-123-4567', '031)123-4567']);
    assert.deepStrictEqual(hits.filter((h) => h.kind === 'rrn').map((h) => [h.text, h.valid]), [[RRN_OK, true], [RRN_BAD, false]], '주민번호: 검사 숫자 틀려도 남기고 valid:false');
    assert.deepStrictEqual(hits.filter((h) => h.kind === 'brn').map((h) => [h.text, h.valid]), [[BRN_OK, true]]);
    assert.deepStrictEqual(hits.filter((h) => h.kind === 'card').map((h) => [h.text, h.valid]), [['4111-1111-1111-1111', true], ['1234 5678 9012 3456', false]]);
    for (const h of hits) assert.strictEqual(text.slice(h.start, h.end), h.text);
    assert.deepStrictEqual(pii.findPii(text, { kinds: ['email'] }).length, 1);
    assert.deepStrictEqual(pii.findPii(text, { kinds: [], regex: '일련\\s\\d+' }).map((h) => [h.kind, h.text]), [['custom', '일련 12345678901234']]);
    assert.deepStrictEqual(pii.findPii('ABC abc', { kinds: [], regex: '/abc/i' }).map((h) => h.text), ['ABC', 'abc'], '/패턴/i 플래그');
    assert.strictEqual(pii.findPii('0'.repeat(5000), { kinds: [], regex: '0', limit: 2000 }).length, 2000, '상한');
    for (const [re, why] of [['(', /문법/], ['a*', /빈 문자열/], ['x'.repeat(501), /500자/]]) assert.throws(() => pii.compileCustom(re), (e) => e.status === 400 && why.test(e.message), re);
    const t0 = Date.now();
    assert.throws(() => pii.findPii('a'.repeat(40) + '!', { kinds: [], regex: '(a+)+$' }), (e) => e.status === 400 && /너무 오래/.test(e.message), '역추적 폭주 정규식은 시간 제한');
    assert.ok(Date.now() - t0 < 5000, '시간 제한 안에 끝난다');
    assert.strictEqual(pii.rrnValid('901301-1234567'), false, '13월은 무효');
  }

  // ── 4. 가리기 조각 정리 ──────────────────────────────────────────────────
  assert.deepStrictEqual(normalizeParts([{ idx: 2, from: 0, to: 3 }, { idx: 5, from: 4, to: 6 }, { idx: 2, from: 2, to: 5 }, { idx: 5, from: 0, to: 2 }, { idx: 7, from: 1, to: 2 }, { idx: 7, from: 0, to: 9, whole: true }]),
    [{ idx: 7, from: 0, to: 9, whole: true }, { idx: 5, from: 4, to: 6 }, { idx: 5, from: 0, to: 2 }, { idx: 2, from: 0, to: 5 }]);

  // ── 5. 숨은 데이터 지우기(바이트 다시 쓰기) ────────────────────────────────
  const SECRETS = ['InfoSECRET', 'XMPSECRET', 'PAGEXMP', 'JSSECRET', 'JSOPEN', 'AASECRET', 'LINKJS', 'ATTACHSECRET'];
  {
    const src = buildHiddenDataPdf();
    for (const s of [...SECRETS, 'NOTESECRET', 'CHAPTERSECRET']) assert.ok(src.includes(s), `시험 PDF에 ${s}`);
    const { bytes, removed } = pdfRewrite.sanitizePdf(src, { info: true, xmp: true, attachments: true, javascript: true });
    assert.deepStrictEqual(removed, { info: 3, xmp: 2, attachments: 2, annotations: 0, bookmarks: 0, javascript: 4 });
    for (const s of SECRETS) assert.ok(!has(bytes, s), `${s}가 지워졌다`);
    for (const s of ['NOTESECRET', 'CHAPTERSECRET', 'KEEPURI', 'Hidden data sample']) assert.ok(has(bytes, s), `${s}는 남는다`);
    const d = await open(bytes);
    assert.deepStrictEqual([d.pageCount, d.pageText(0), d.annots(0).map((a) => a.subtype)], [1, 'Hidden data sample', ['text', 'link', 'link']]);
    assert.deepStrictEqual(d.outline().map((x) => x.title), ['CHAPTERSECRET']);
    d.close();
    const all = pdfRewrite.sanitizePdf(src, { annotations: true, bookmarks: true });
    assert.deepStrictEqual([all.removed.annotations, all.removed.bookmarks], [2, 1], '메모·첨부 주석(링크 2개는 남김) · 목차 1');
    assert.ok(!has(all.bytes, 'NOTESECRET') && !has(all.bytes, 'CHAPTERSECRET') && !has(all.bytes, 'UseOutlines'));
    // 문서 정보 보충: /Info 없는 문서에 한글 제목(UTF-16BE+BOM)
    const withInfo = pdfRewrite.setInfoPdf(buildPdf({ pages: [{}] }), { Title: '한글 제목', Author: 'ascii' });
    const t = await open(withInfo);
    assert.deepStrictEqual([t.metaText('Title'), t.metaText('Author')], ['한글 제목', 'ascii']);
    t.close();
    assert.ok(withInfo.includes(Buffer.from('feffd55c', 'hex')) || withInfo.includes('<feffd55c'), 'UTF-16BE BOM + 한(U+D55C)');
  }

  // ── 6. 라우트(진짜 PDFium) ───────────────────────────────────────────────
  const { _test } = require('./server.js');
  const { server, pdfDocs } = _test;
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const raw = (method, route, data) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let body = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body, type: res.headers['content-type'] }); });
    });
    req.on('error', reject);
    req.end(data);
  });
  const post = (route, data) => raw('POST', route, JSON.stringify(data));
  const get = (route, q) => raw('GET', route + '?' + new URLSearchParams(q));
  const entryOf = (file) => pdfDocs[WIN ? path.resolve(file).toLowerCase() : path.resolve(file)];
  const info = async (name) => (await get('/api/pdf/info', { name })).body;
  const file = (n, bytes) => { const f = path.join(DIR, n); fs.writeFileSync(f, bytes); return f; };
  const savedBytes = async (name, to) => { const out = path.join(DIR, to); const r = await post('/api/pdf/saveas', { name, to: out }); assert.strictEqual(r.body.ok, true); return out; };
  const report = { files: {} }; // Python 독립 검사(tmp\feat\verify_features.py)에 넘길 파일 목록
  try {
    // 화면용 공용 스크립트
    for (const js of ['/page-range.js', '/outline-text.js']) {
      const r = await raw('GET', js);
      assert.deepStrictEqual([r.status, /javascript/.test(r.type)], [200, true], js);
    }

    // ── 6a. 숨은 데이터 지우기 라우트: 기본(정보·XMP·첨부·자바스크립트) → 주석·목차까지 → 실행 취소 두 번
    {
      const name = file('hidden.pdf', buildHiddenDataPdf());
      let r = await post('/api/pdf/sanitize', { name });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.removed, { info: 3, xmp: 2, attachments: 2, annotations: 0, bookmarks: 0, javascript: 4 });
      assert.deepStrictEqual([r.body.ok, r.body.reloadAll, r.body.undoLeft], [true, true, 1]);
      const out1 = await savedBytes(name, 'hidden-clean.pdf');
      const b1 = fs.readFileSync(out1);
      for (const s of SECRETS) assert.ok(!has(b1, s), `저장본에 ${s} 없음`);
      assert.ok(has(b1, 'NOTESECRET') && has(b1, 'CHAPTERSECRET'), '기본값은 주석·목차를 남긴다');
      r = await post('/api/pdf/sanitize', { name: out1, info: false, xmp: false, attachments: false, javascript: false, annotations: true, bookmarks: true });
      assert.deepStrictEqual([r.body.removed.annotations, r.body.removed.bookmarks], [1, 1]);
      r = await post('/api/pdf/sanitize', { name: out1, annotations: true, bookmarks: true });
      assert.strictEqual(r.body.ok, false, '지울 것이 없으면 ok:false(스냅샷 없음)');
      assert.strictEqual((await info(out1)).undoLeft, 2, '다른 이름 저장은 실행 취소 기록을 이어 간다(1차 지우기 + 2차)');
      const out2 = await savedBytes(out1, 'hidden-clean2.pdf');
      assert.ok(!has(fs.readFileSync(out2), 'NOTESECRET') && !has(fs.readFileSync(out2), 'CHAPTERSECRET'));
      await post('/api/pdf/undo', { name: out2 });
      assert.deepStrictEqual(entryOf(out2).doc.outline().map((x) => x.title), ['CHAPTERSECRET'], '실행 취소 한 번이면 목차·주석이 돌아온다');
      assert.strictEqual((await post('/api/pdf/sanitize', { name, info: false, xmp: false, attachments: false, javascript: false })).status, 400, '고른 항목이 없으면 400');
      report.files.sanitized = out2; report.files.hiddenSource = path.join(DIR, 'hidden.pdf');
    }

    // ── 6b. 문서 정보: /Info 없는 문서(PDFium 저장으로는 안 남는다 → 바이트 보충) · 있는 문서 · 실행 취소 · 잘못된 키
    {
      const plain = file('meta-plain.pdf', buildPdf({ pages: [{}] }));
      let r = await get('/api/pdf/meta', { name: plain });
      assert.deepStrictEqual([r.status, r.body.Title, r.body.Author], [200, '', '']);
      r = await post('/api/pdf/meta', { name: plain, fields: { Title: '분기 보고서 — 초안', Author: '홍길동', Subject: 'Q3', Keywords: '보고서, 초안' } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.meta.Title, r.body.meta.Author, r.body.meta.Keywords, r.body.undoLeft], ['분기 보고서 — 초안', '홍길동', '보고서, 초안', 1]);
      assert.match(r.body.meta.ModDate, /^\d{4}-\d{2}-\d{2}T/);
      const out = await savedBytes(plain, 'meta-plain-saved.pdf');
      const chk = await open(fs.readFileSync(out));
      assert.deepStrictEqual([chk.metaText('Title'), chk.metaText('Author')], ['분기 보고서 — 초안', '홍길동'], '저장·재열기 뒤에도 남는다');
      chk.close();
      report.files.meta = out;
      r = await post('/api/pdf/meta', { name: out, fields: { Author: '' } });
      assert.strictEqual(r.body.meta.Author, '', '빈 글자는 지우기');
      await post('/api/pdf/undo', { name: out });
      assert.strictEqual((await get('/api/pdf/meta', { name: out })).body.Author, '홍길동', '실행 취소');
      const tricky = file('meta-tricky.pdf', buildTrickyPdf());
      r = await post('/api/pdf/meta', { name: tricky, fields: { Title: '새 제목' } });
      assert.deepStrictEqual([r.body.meta.Title, r.body.meta.Author], ['새 제목', 'Hi'], '다른 키는 그대로');
      assert.strictEqual((await post('/api/pdf/meta', { name: tricky, fields: { Producer: 'x' } })).status, 400);
      assert.strictEqual((await post('/api/pdf/meta', { name: tricky, fields: {} })).status, 400);
    }

    // ── 6c. 목차: items 쓰기 · 읽기 · 글(탭) 쓰기 · 글 오류(줄 번호) · 실행 취소
    {
      const name = file('outline.pdf', buildPdf({ pages: [{}, {}, { extra: '/Rotate 90' }, {}] }));
      assert.deepStrictEqual((await get('/api/pdf/outline', { name })).body, { items: [] });
      const items = [{ title: '1장 개요', page: 0, children: [{ title: '1.1 배경', page: 1, children: [] }] }, { title: '2장 회전 쪽', page: 2, children: [] }, { title: '부록(목적지 없음)', page: null, children: [] }];
      let r = await post('/api/pdf/outline', { name, items });
      assert.deepStrictEqual([r.status, r.body.count, r.body.undoLeft], [200, 4, 1], JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.items, items);
      r = await post('/api/pdf/outline', { name, text: '가나다\t1\n  하위\t4\n라마\t3' });
      assert.deepStrictEqual(r.body.items.map((x) => [x.title, x.page, x.children.map((c) => [c.title, c.page])]), [['가나다', 0, [['하위', 3]]], ['라마', 2, []]]);
      r = await post('/api/pdf/outline', { name, text: '가\t1\n      나\t2\n다\t99' });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.body.errors.map((e) => e.line), [2, 3]);
      assert.strictEqual((await post('/api/pdf/outline', { name, items: [{ title: '', page: 0 }] })).status, 400);
      assert.strictEqual((await post('/api/pdf/outline', { name, items: [{ title: 'x', page: 7 }] })).status, 400);
      await post('/api/pdf/undo', { name });
      assert.deepStrictEqual((await get('/api/pdf/outline', { name })).body.items, items, '실행 취소 한 번 = 목차 바꾸기 한 번');
      report.files.outline = await savedBytes(name, 'outline-saved.pdf');
      report.outline = items;
    }

    // ── 6d. 이미지 PDF: 글자 없음 · 보이는 쪽 크기 · 원본 그대로 · 취소 · 오류
    {
      const name = file('raster.pdf', buildPdf({ pages: [{ w: 595, h: 842 }, { w: 595, h: 842, extra: '/Rotate 90' }, { w: 300, h: 200 }] }));
      const to = path.join(DIR, 'raster-image.pdf');
      let r = await post('/api/pdf/rasterize', { name, to, dpi: 72, quality: 0.8 });
      assert.deepStrictEqual([r.status, r.body.ok, r.body.pageCount], [200, true, 3], JSON.stringify(r.body));
      const d = await open(fs.readFileSync(to));
      assert.deepStrictEqual(Array.from({ length: 3 }, (_, i) => { const s = d.pageSize(i); return [Math.round(s.w), Math.round(s.h), s.rotation]; }), [[595, 842, 0], [842, 595, 0], [300, 200, 0]]);
      for (let i = 0; i < 3; i++) {
        assert.strictEqual(d.pageText(i), '', '글자 없음');
        assert.deepStrictEqual(d.objects(i).map((o) => o.type), ['image']);
      }
      assert.ok(inkBox(d._renderRaw(0, 0.5)), '그림이 그려진다(Page 1 글자 그림)');
      d.close();
      assert.strictEqual(entryOf(name).doc.pageText(0), 'Page 1', '열린 문서는 그대로');
      assert.strictEqual((await info(name)).undoLeft, 0, '실행 취소 기록 없음');
      report.files.raster = to;
      r = await post('/api/pdf/rasterize', { name, to: path.join(DIR, 'raster-2-3.pdf'), pages: '2-3' });
      assert.strictEqual(r.body.pageCount, 2);
      await post('/api/jobs/cancel', { id: 'raster-cancel' });
      const cancelled = path.join(DIR, 'raster-cancelled.pdf');
      r = await post('/api/pdf/rasterize', { name, to: cancelled, jobId: 'raster-cancel' });
      assert.deepStrictEqual([r.body.cancelled, fs.existsSync(cancelled)], [true, false], '취소하면 쓰지 않는다');
      for (const [bad, why] of [[{ to: name }, '같은 파일'], [{ to: path.join(DIR, 'x.png') }, '.pdf 아님'], [{ to, dpi: 1000 }, 'dpi'], [{ to, quality: 2 }, '품질'], [{ to, pages: '9' }, '범위'], [{}, 'to 없음']]) {
        assert.strictEqual((await post('/api/pdf/rasterize', { name, ...bad })).status, 400, why);
      }
    }

    if (WIN) {
      // ── 6e. 개인정보 찾기·가리기: 한글 문서(맑은 고딕 글자 객체) — 종류마다 찾고, 고른 것만 진짜로 지우고, 실행 취소
      const src = await open(buildPdf({ pages: [{ w: 595, h: 842, content: ' ' }, { w: 595, h: 842, content: ' ' }, { w: 595, h: 842, content: ' ', extra: '/Rotate 90' }] }));
      src.addTextBox(0, { x: 40, y: 800, size: 11, text: [
        '담당자 이메일: hong.gildong@example.com',
        '휴대전화 010-1234-5678 / 집 02-123-4567',
        '사무실 031)123-4567, 비상 010 2345 6789',
        `주민등록번호 ${RRN_OK} 확인`,
        `잘못 적은 번호 ${RRN_BAD}`,
        `사업자등록번호 ${BRN_OK}`,
        '카드 4111-1111-1111-1111 / 1234 5678 9012 3456',
      ].join('\n') });
      src.addTextBox(1, { x: 40, y: 800, size: 11, text: '두 번째 쪽 연락처 010-9876-5432' });
      src.addTextBox(2, { x: 40, y: 500, size: 11, text: '회전 쪽 메일 kim@example.org' });
      const name = file('pii.pdf', src.save());
      src.close();
      let r = await post('/api/pdf/pii/find', { name, kinds: ['email', 'phone', 'rrn', 'brn', 'card'] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const ms = r.body.matches;
      const kinds = (i) => ms.filter((m) => m.i === i).map((m) => `${m.kind}:${m.text}${m.valid === false ? '!' : ''}`);
      assert.deepStrictEqual(kinds(0).sort(), ['brn:' + BRN_OK, 'card:1234 5678 9012 3456!', 'card:4111-1111-1111-1111', 'email:hong.gildong@example.com',
        'phone:010 2345 6789', 'phone:010-1234-5678', 'phone:02-123-4567', 'phone:031)123-4567', 'rrn:' + RRN_BAD + '!', 'rrn:' + RRN_OK].sort());
      assert.deepStrictEqual([kinds(1), kinds(2)], [['phone:010-9876-5432'], ['email:kim@example.org']]);
      assert.strictEqual(r.body.truncated, false);
      for (const m of ms) {
        assert.ok(m.rects.length >= 1 && m.rects.every((q) => q.length === 4 && q[2] > q[0] && q[3] > q[1]), `사각형 ${m.text}`);
        assert.strictEqual(m.id, `${m.i}:${m.start}:${m.end}`);
        assert.strictEqual(squeeze(entryOf(name).doc.pageChars(m.i).text.slice(...(() => { const { map } = entryOf(name).doc.pageChars(m.i); return [map.indexOf(m.start), map.lastIndexOf(m.end - 1) + 1]; })())), squeeze(m.text), '글자 번호가 그 글을 가리킨다');
      }
      r = await post('/api/pdf/pii/find', { name, kinds: [], regex: '담당자', pages: '1' });
      assert.deepStrictEqual(r.body.matches.map((m) => [m.kind, m.text, m.i]), [['custom', '담당자', 0]]);
      assert.strictEqual((await post('/api/pdf/pii/find', { name, regex: '(' })).status, 400);
      assert.strictEqual((await post('/api/pdf/pii/find', { name, kinds: ['ssn'] })).status, 400);
      assert.strictEqual((await post('/api/pdf/pii/find', { name, kinds: [] })).status, 400);
      assert.strictEqual((await post('/api/pdf/pii/find', { name, pages: '4' })).status, 400);

      // 가리기 전에 전화 줄 위에 형광펜 주석(메모) — 가린 덮개와 겹치므로 함께 지워져야 한다
      const phone = ms.find((m) => m.text === '010-1234-5678');
      r = await post('/api/pdf/annot/create', { name, i: 0, subtype: 'highlight', chars: { start: phone.start, end: phone.end }, contents: '전화번호 확인 메모' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      const pick = ms.filter((m) => !(m.kind === 'rrn' && m.valid === false)); // 검사 숫자가 틀린 번호는 사용자가 빼고 가린다
      const textBefore = squeeze(entryOf(name).doc.pageText(0));
      r = await post('/api/pdf/pii/redact', { name, matches: pick.map(({ i, start, end }) => ({ i, start, end })), color: 'black' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.ok, r.body.redacted, r.body.failed, r.body.annots, r.body.undoLeft, r.body.reloadAll], [true, pick.length, [], 1, 2, true]);
      const doc = entryOf(name).doc;
      for (let i = 0; i < 3; i++) {
        const now = squeeze(doc.pageText(i));
        for (const m of pick.filter((x) => x.i === i)) assert.ok(!now.includes(squeeze(m.text)), `지워짐: ${m.text}`);
      }
      const after0 = squeeze(doc.pageText(0));
      assert.ok(after0.includes(RRN_BAD) && after0.includes('담당자이메일') && after0.includes('사업자등록번호'), '고르지 않은 글자·주변 글자는 남는다');
      assert.ok(textBefore.includes('hong.gildong@example.com'));
      assert.strictEqual(doc.annots(0).length, 0, '덮개와 겹친 형광펜도 지워졌다');
      assert.ok(doc.objects(0).filter((o) => o.mask).length >= 5, '줄마다 덮개');
      // 저장 바이트에도 없다(재열기 글자 + 바이트)
      const out = await savedBytes(name, 'pii-redacted.pdf');
      const re = await open(fs.readFileSync(out));
      for (const m of pick.filter((x) => x.i === 0)) assert.ok(!squeeze(re.pageText(0)).includes(squeeze(m.text)), `저장본에서도 지워짐: ${m.text}`);
      re.close();
      assert.ok(!has(fs.readFileSync(out), 'example.com') && !fs.readFileSync(out).includes(Buffer.from('전화번호 확인 메모', 'utf16le').swap16()), '바이트에도 메일·주석 메모 없음');
      report.files.piiRedacted = out;
      report.pii = { picked: pick.map((m) => ({ i: m.i, text: m.text })), kept: [RRN_BAD] };
      // 실행 취소 한 번이면 가리기 전(형광펜 있음)
      await post('/api/pdf/undo', { name: out });
      assert.ok(squeeze(entryOf(out).doc.pageText(0)).includes('010-1234-5678') && entryOf(out).doc.annots(0).length === 1, '실행 취소');
      await post('/api/pdf/redo', { name: out });
      assert.ok(!squeeze(entryOf(out).doc.pageText(0)).includes('010-1234-5678'), '다시 실행');
      // 오류·이미 지운 위치
      assert.strictEqual((await post('/api/pdf/pii/redact', { name: out, matches: [] })).status, 400);
      assert.strictEqual((await post('/api/pdf/pii/redact', { name: out, matches: [{ i: 9, start: 0, end: 1 }] })).status, 400);
      assert.strictEqual((await post('/api/pdf/pii/redact', { name: out, matches: [{ i: 0, start: 0, end: 3 }], color: 'red' })).status, 400);
      r = await post('/api/pdf/pii/redact', { name: out, matches: [{ i: 0, start: 100000, end: 100005 }] });
      assert.deepStrictEqual([r.body.ok, r.body.redacted], [false, 0], '글자가 없는 위치는 ok:false');
      // 'auto' 색(배경색 덮개)
      const m2 = (await post('/api/pdf/pii/find', { name: out, kinds: ['rrn'] })).body.matches;
      assert.deepStrictEqual(m2.map((m) => m.text), [RRN_BAD]);
      r = await post('/api/pdf/pii/redact', { name: out, matches: m2, color: 'auto' });
      assert.strictEqual(r.body.redacted, 1);
      assert.ok(entryOf(out).doc.objects(0).some((o) => o.mask && o.color[0] > 200), '배경(흰)색 덮개');
    }

    // ── 6f. 영역 가리기(3쪽): 글자 제거 · 영역 안 도형 제거 · 걸친 그림은 그 부분만 칠하기 · 주석 제거 · 실행 취소 한 번
    {
      const content = 'BT /F1 20 Tf 50 300 Td (KEEP) Tj ET BT /F1 20 Tf 200 300 Td (AREASECRET) Tj ET 0 1 0 rg 300 340 20 20 re f';
      const name = file('area.pdf', buildPdf({ pages: [{ content }, { content }, { content }] }));
      const png = path.join(DIR, 'red.png');
      fs.writeFileSync(png, makePng(20, 20, () => [255, 0, 0, 255]));
      let r = await post('/api/pdf/image', { name, i: 1, path: png, box: { x: 150, y: 200, w: 100, h: 60 } }); // x 150~250: 영역(190~)에 걸친다
      assert.strictEqual(r.body.ok, true);
      r = await post('/api/pdf/annot/create', { name, i: 2, subtype: 'square', rect: [210, 290, 260, 330], contents: 'AREANOTE' });
      assert.strictEqual(r.body.ok, true);
      const undo0 = (await info(name)).undoLeft;
      r = await post('/api/pdf/redact-area', { name, rect: [190, 190, 390, 370], pages: '1-3' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.pages.length, r.body.reloadAll, (await info(name)).undoLeft], [3, true, undo0 + 1]);
      assert.deepStrictEqual(r.body.pages.map((p) => [p.paths, p.annots, p.images.painted]), [[1, 0, 0], [1, 0, 1], [1, 1, 0]]);
      const doc = entryOf(name).doc;
      for (let i = 0; i < 3; i++) {
        assert.deepStrictEqual([doc.pageText(i).includes('KEEP'), doc.pageText(i).includes('AREASECRET'), doc.pageText(i).includes('SECRET')], [true, false, false], `${i + 1}쪽 글자`);
        assert.ok(doc.objects(i).some((o) => o.mask && o.bounds.x0 <= 190.5 && o.bounds.x1 >= 389.5), '영역 전체 덮개');
      }
      assert.strictEqual(doc.annots(2).length, 0);
      const img = doc.objects(1).find((o) => o.type === 'image');
      assert.ok(img, '걸친 그림은 남는다');
      // 그림 왼쪽(150~190)은 빨강 그대로, 영역 안(190~250)은 칠해졌다 — 덮개를 잠깐 빼고 그림 픽셀만 본다
      const covers = doc.objects(1).filter((o) => o.mask).map((o) => o.idx).sort((a, b) => b - a);
      const probe = await open(doc.save());
      for (const k of covers) probe.removeObject(1, k);
      const px = (x, y) => { const rr = probe._renderRaw(1, 1), p = (400 - y) * rr.stride + x * 4; return [...rr.data.subarray(p, p + 3)]; };
      assert.ok(px(160, 230)[0] > 200 && px(160, 230)[1] < 80, `영역 밖 그림은 빨강: ${px(160, 230)}`);
      assert.ok(px(230, 230).every((v) => v < 60), `영역 안 그림 픽셀은 검정으로 칠해졌다: ${px(230, 230)}`);
      probe.close();
      const out = await savedBytes(name, 'area-redacted.pdf');
      assert.ok(!has(fs.readFileSync(out), 'AREASECRET') && !has(fs.readFileSync(out), 'AREANOTE'), '저장 바이트에 없다');
      report.files.areaRedacted = out;
      await post('/api/pdf/undo', { name: out });
      assert.ok([0, 1, 2].every((i) => entryOf(out).doc.pageText(i).includes('AREASECRET')) && entryOf(out).doc.annots(2).length === 1, '실행 취소 한 번으로 세 쪽 모두');
      { // 기존 글자 가리기(/api/pdf/mask)도 덮개와 겹치는 주석을 지운다
        const k = entryOf(out).doc.objects(0).findIndex((o) => (o.text || '').trim() === 'KEEP');
        assert.strictEqual((await post('/api/pdf/annot/create', { name: out, i: 0, subtype: 'highlight', chars: { start: 0, end: 4 }, contents: 'KEEPNOTE' })).body.ok, true);
        const m = await post('/api/pdf/mask', { name: out, i: 0, parts: [{ idx: k, from: 0, to: 4 }] });
        assert.deepStrictEqual([m.body.ok, m.body.annots, entryOf(out).doc.annots(0).length, entryOf(out).doc.pageText(0).includes('KEEP')], [true, 1, 0, false]);
        assert.ok(!has(entryOf(out).doc.save(), 'KEEPNOTE'), '지운 주석 메모가 저장 바이트에 없다');
      }
      for (const bad of [{ rect: [0, 0, 0.5, 10] }, { rect: [1, 2, 3] }, { rect: [190, 190, 390, 370], pages: '0' }, { rect: [190, 190, 390, 370], color: 'pink' }]) {
        assert.strictEqual((await post('/api/pdf/redact-area', { name: out, ...bad })).status, 400, JSON.stringify(bad));
      }
    }

    // ── 6g. 주석: 종류마다 만들기(외형 있음 · 렌더에 보임 · 회전 쪽 위치) · 목록 · 고치기 · 지우기 · 고정 · 실행 취소 · 오류
    {
      const name = file('annots.pdf', buildPdf({ pages: [{ w: 400, h: 400 }, { w: 400, h: 300, extra: '/Rotate 90' }] }));
      const doc = () => entryOf(name).doc;
      await info(name);
      const specs = [
        { subtype: 'highlight', chars: { start: 0, end: 6 }, color: '#ffd400', contents: '형광펜 메모' }, // 'Page 1'
        { subtype: 'underline', quads: [[40, 70, 120, 70, 40, 60, 120, 60]], color: '#0000ff' },
        { subtype: 'strikeout', quads: [[40, 100, 120, 100, 40, 90, 120, 90]] },
        { subtype: 'squiggly', quads: [[40, 130, 120, 130, 40, 120, 120, 120]] },
        { subtype: 'text', x: 300, y: 380, contents: '스티커 메모입니다', color: '#ff9900' },
        { subtype: 'square', rect: [200, 200, 300, 260], color: '#e53935', width: 3, fill: '#ffeeee', opacity: 0.8 },
        { subtype: 'circle', rect: [200, 280, 300, 340], color: '#2e7d32', width: 2 },
        { subtype: 'line', from: [50, 300], to: [180, 360], arrow: true, color: '#000000', width: 2 },
        { subtype: 'ink', strokes: [[[60, 180], [90, 220], [120, 170], [150, 230]], [[60, 160], [150, 160]]], color: '#6a1b9a', width: 3 },
      ];
      const created = [];
      for (const spec of specs) {
        const before = doc()._renderRaw(0, 1);
        const r = await post('/api/pdf/annot/create', { name, i: 0, ...spec });
        assert.strictEqual(r.status, 200, `${spec.subtype}: ${JSON.stringify(r.body)}`);
        assert.deepStrictEqual([r.body.ok, r.body.annot.subtype, r.body.annot.hasAppearance], [true, spec.subtype, true], spec.subtype);
        const d = diffBox(before, doc()._renderRaw(0, 1));
        assert.ok(d, `${spec.subtype}이 화면 렌더에 보인다`);
        const [l, b, rr, t] = r.body.annot.rect; // 회전 0: 화면 x = x, 화면 y = 400 − y
        assert.ok(d.x0 >= l - 3 && d.x1 <= rr + 3 && d.y0 >= 400 - t - 3 && d.y1 <= 400 - b + 3, `${spec.subtype} 렌더 위치 ${JSON.stringify(d)} ⊂ ${r.body.annot.rect}`);
        created.push(r.body.annot);
      }
      assert.strictEqual((await info(name)).undoLeft, specs.length, '주석 하나 = 실행 취소 하나');
      let list = (await get('/api/pdf/annots', { name, i: 0 })).body;
      assert.deepStrictEqual(list.map((a) => a.subtype), specs.map((s) => s.subtype));
      const me = os.userInfo().username;
      assert.ok(list.every((a) => a.author === me && a.modified && a.hasAppearance && a.rotation === 0), '작성자 기본값 = OS 사용자 이름, /M 있음');
      assert.deepStrictEqual([list[0].contents, list[0].color, list[0].quads.length], ['형광펜 메모', '#ffd400', 1]);
      assert.ok(Math.abs(list[0].quads[0][0] - 40) < 4, `글자 범위 → 글자 상자 사각형 ${JSON.stringify(list[0].quads)}`);
      assert.deepStrictEqual([list[5].fill, list[5].opacity, list[5].width], ['#ffeeee', 0.8, 3]);
      assert.deepStrictEqual(list[7].line, { from: [50, 300], to: [180, 360], arrow: true });
      assert.deepStrictEqual(list[8].inkPaths.map((p) => p.length), [4, 2]);
      assert.strictEqual(list[4].contents, '스티커 메모입니다');
      // 회전 쪽: 사각형 주석이 보이는 방향으로 맞는 자리에 그려진다(90° 시계: 화면 x = PDF y, 화면 y = PDF x)
      {
        const before = doc()._renderRaw(1, 1);
        const r = await post('/api/pdf/annot/create', { name, i: 1, subtype: 'square', rect: [50, 100, 150, 140], color: '#0000ff', width: 4, author: '검토자' });
        assert.deepStrictEqual([r.body.ok, r.body.annot.rotation, r.body.annot.author], [true, 1, '검토자']);
        const d = diffBox(before, doc()._renderRaw(1, 1));
        assert.ok(d && Math.abs(d.x0 - 100) <= 4 && Math.abs(d.x1 - 140) <= 4 && Math.abs(d.y0 - 50) <= 4 && Math.abs(d.y1 - 150) <= 4, `회전 쪽 렌더 위치 ${JSON.stringify(d)}`);
      }
      const all = (await get('/api/pdf/annots/all', { name })).body;
      assert.deepStrictEqual([all.length, all.filter((a) => a.i === 1).length, all[0].i], [specs.length + 1, 1, 0]);
      // 고치기
      let r = await post('/api/pdf/annot/update', { name, i: 0, index: 5, contents: '고친 메모', color: '#123456', opacity: 0.5, rect: [210, 210, 290, 250] });
      assert.deepStrictEqual([r.body.ok, r.body.annot.contents, r.body.annot.color, r.body.annot.opacity, r.body.annot.rect.map(Math.round)], [true, '고친 메모', '#123456', 0.502, [210, 210, 290, 250]]);
      assert.strictEqual((await post('/api/pdf/annot/update', { name, i: 0, index: 0, rect: [0, 0, 10, 10] })).status, 400, '형광펜은 rect로 못 옮긴다');
      assert.strictEqual((await post('/api/pdf/annot/update', { name, i: 0, index: 0, color: 'red' })).status, 400);
      await post('/api/pdf/undo', { name });
      assert.strictEqual((await get('/api/pdf/annots', { name, i: 0 })).body[5].contents, '', '실행 취소');
      // 지우기
      r = await post('/api/pdf/annot/delete', { name, i: 0, index: 2 });
      assert.deepStrictEqual([r.body.ok, r.body.removed], [true, 1]);
      list = (await get('/api/pdf/annots', { name, i: 0 })).body;
      assert.ok(!list.some((a) => a.subtype === 'strikeout'));
      assert.strictEqual((await post('/api/pdf/annot/delete', { name, i: 0, index: 99 })).status, 404);
      // 저장본(다른 렌더러 검사용) — 고정 전
      report.files.annots = await savedBytes(name, 'annots-saved.pdf');
      report.annots = (await get('/api/pdf/annots/all', { name: report.files.annots })).body.map((a) => ({ i: a.i, subtype: a.subtype, rect: a.rect }));
      // 고정(평면화): 주석은 사라지고 그림은 쪽 내용으로 남는다
      const before = entryOf(report.files.annots).doc._renderRaw(0, 1); // 다른 이름 저장으로 항목이 새 경로로 옮겨 갔다
      const n0 = (await get('/api/pdf/annots', { name: report.files.annots, i: 0 })).body.length;
      r = await post('/api/pdf/annot/flatten', { name: report.files.annots, pages: '1' });
      assert.deepStrictEqual([r.body.ok, r.body.flattened, r.body.failed], [true, n0, 0], JSON.stringify(r.body));
      assert.strictEqual(entryOf(report.files.annots).doc.annots(0).length, 0);
      const after = entryOf(report.files.annots).doc._renderRaw(0, 1);
      const ink = (raw2) => inkBox(raw2, { x0: 200, y0: 400 - 260, x1: 300, y1: 400 - 200 });
      assert.ok(ink(before) && ink(after) && Math.abs(ink(after).n - ink(before).n) < ink(before).n * 0.2, '고정한 사각형이 같은 자리에 그대로 보인다');
      report.files.flattened = await savedBytes(report.files.annots, 'annots-flattened.pdf');
      r = await post('/api/pdf/annot/flatten', { name: report.files.flattened, indices: [{ i: 1, index: 0 }] });
      assert.deepStrictEqual([r.body.flattened, entryOf(report.files.flattened).doc.annots(1).length], [1, 0]);
      await post('/api/pdf/undo', { name: report.files.flattened });
      assert.strictEqual(entryOf(report.files.flattened).doc.annots(1).length, 1, '고정도 실행 취소 한 번');
      // 오류
      for (const [bad, code] of [[{ subtype: 'stamp' }, 400], [{ subtype: 'square', rect: [1, 2] }, 400], [{ subtype: 'line', from: [0, 0], to: [0, 0.2] }, 400],
        [{ subtype: 'ink', strokes: [] }, 400], [{ subtype: 'highlight', quads: [[1, 2, 3]] }, 400], [{ subtype: 'square', rect: [0, 0, 50, 50], opacity: 3 }, 400], [{ subtype: 'text', x: 1, y: 2, color: 'blue' }, 400]]) {
        assert.strictEqual((await post('/api/pdf/annot/create', { name, i: 0, ...bad })).status, code, JSON.stringify(bad));
      }
      assert.strictEqual((await post('/api/pdf/annot/create', { name, i: 5, subtype: 'text', x: 1, y: 1 })).status, 400, '쪽 번호');
      assert.strictEqual((await get('/api/pdf/annots', { name, i: 'x' })).status, 400);
    }

    if (WIN) {
      // ── 6h. 워터마크: 한글 글자(반투명·45°) · 회전 쪽·CropBox 쪽의 보이는 가운데 · 다시 넣으면 교체 · 본문 뒤 · 그림(도장) · 지우기 · 실행 취소
      const name = file('wm.pdf', buildPdf({ pages: [{ w: 400, h: 600 }, { w: 400, h: 600, extra: '/Rotate 90' }, { w: 400, h: 600, extra: '/CropBox [100 100 400 500]' }] }));
      await info(name);
      const doc = () => entryOf(name).doc;
      let r = await post('/api/pdf/watermark', { name, kind: 'text', text: '대외비 사본', size: 40, color: '#ff0000', opacity: 0.3 });
      assert.deepStrictEqual([r.status, r.body.ok, r.body.placed, r.body.removed, r.body.reloadAll], [200, true, 3, 0, true], JSON.stringify(r.body));
      const wm = (i) => doc().objects(i).filter((o) => o.watermark);
      assert.deepStrictEqual([0, 1, 2].map((i) => wm(i).map((o) => o.text)), [['대외비 사본'], ['대외비 사본'], ['대외비 사본']]);
      assert.deepStrictEqual(wm(0)[0].color, [255, 0, 0, 77], '불투명도 0.3 → 알파 77');
      // 보이는 쪽 가운데에 잉크(반투명 빨강), 네 귀퉁이에는 없다
      for (const i of [0, 1, 2]) {
        const rr = doc()._renderRaw(i, 1), cx = rr.w / 2, cy = rr.h / 2;
        const c = inkBox(rr, { x0: cx - 60, y0: cy - 60, x1: cx + 60, y1: cy + 60 }, 760);
        assert.ok(c && c.n > 50, `${i + 1}쪽 보이는 가운데에 워터마크`);
        assert.ok(Math.abs((c.x0 + c.x1) / 2 - cx) < 25 && Math.abs((c.y0 + c.y1) / 2 - cy) < 25, `${i + 1}쪽 가운데 맞춤 ${JSON.stringify(c)} (${rr.w}×${rr.h})`);
        const p = Math.round(cy) * rr.stride + Math.round(c.x0 + (c.x1 - c.x0) / 2) * 4;
        void p;
      }
      // 반투명: 가장 진한 픽셀도 원색 빨강(255,0,0)이 아니라 흰색과 섞인 색
      { const rr = doc()._renderRaw(0, 1); let minG = 255; for (let k = 0; k < rr.data.length; k += 4) if (rr.data[k] > 200) minG = Math.min(minG, rr.data[k + 1]); assert.ok(minG > 120, `반투명(초록 성분 최소 ${minG})`); }
      // 저장·재열기 뒤에도 반투명(ExtGState)
      { const re = await open(doc().save()); let minG = 255; const rr = re._renderRaw(0, 1); for (let k = 0; k < rr.data.length; k += 4) if (rr.data[k] > 200) minG = Math.min(minG, rr.data[k + 1]); re.close(); assert.ok(minG > 120 && minG < 250, `저장 뒤에도 반투명 ${minG}`); }
      // 위쪽 자리: 회전 쪽에서도 보이는 위쪽
      r = await post('/api/pdf/watermark', { name, kind: 'text', text: 'TOP', position: 'top', rotation: 0, size: 30, color: '#000000', opacity: 1, pages: '2' });
      assert.deepStrictEqual([r.body.placed, r.body.removed], [1, 3], '다시 넣으면 모든 쪽의 옛 워터마크를 지운다');
      { // 본문 'Page 2'는 보이는 왼쪽 위(화면 x = PDF y ≈ 40)에 있다 → 가운데 띠만 본다
        const rr = doc()._renderRaw(1, 1), cx = rr.w / 2;
        const top = inkBox(rr, { x0: cx - 100, y0: 0, x1: cx + 100, y1: rr.h / 4 }), rest = inkBox(rr, { x0: cx - 100, y0: rr.h / 4, x1: cx + 100, y1: rr.h - 1 });
        assert.ok(top && !rest && Math.abs((top.x0 + top.x1) / 2 - cx) < 10, `회전 쪽 보이는 위쪽 가운데 ${JSON.stringify(top)} / ${JSON.stringify(rest)}`);
      }
      r = await post('/api/pdf/watermark', { name, text: '뒤', layer: 'back', pages: 'odd' });
      assert.deepStrictEqual([r.body.placed, doc().objects(0)[0].watermark, doc().objects(2)[0].watermark, wm(1).length], [2, true, true, 0], '본문 뒤 = 맨 앞 객체, 홀수 쪽만');
      // 그림 워터마크: 보관함 도장(불투명 PNG → JPEG), 반투명, 쪽마다 같은 그림 스트림 하나로
      const stamp = await post('/api/stamps', { name: '시험 로고', data: makePng(40, 20, (x) => (x < 20 ? [0, 0, 255, 255] : [0, 160, 0, 255])).toString('base64') });
      r = await post('/api/pdf/watermark', { name, kind: 'image', imageStampId: stamp.body.id, opacity: 0.5, scale: 0.5 });
      assert.deepStrictEqual([r.body.ok, r.body.placed], [true, 3], JSON.stringify(r.body));
      assert.ok([0, 1, 2].every((i) => wm(i).length === 1 && wm(i)[0].type === 'image'));
      { const rr = doc()._renderRaw(0, 1), p = Math.round(rr.h / 2) * rr.stride + Math.round(rr.w / 2 - 20) * 4; const c = [...rr.data.subarray(p, p + 3)]; assert.ok(c[2] > 200 && c[0] > 90 && c[0] < 170, `반투명 파랑 ${c}`); }
      const saved = doc().save(), parsed = pdfRewrite.parsePdf(saved);
      const images = parsed.nums.filter((n) => { const v = parsed.get(n); return v && v.t === 'stream' && pdfRewrite.nameOf(v.dict.v.get('Subtype')) === 'Image'; });
      assert.strictEqual(images.length, 1, `같은 그림 스트림은 하나(${images.length})`);
      assert.strictEqual((await info(name)).undoLeft, 4, '그림 워터마크(합치기 포함)도 실행 취소 한 번');
      report.files.watermark = await savedBytes(name, 'wm-saved.pdf');
      r = await post('/api/pdf/watermark/remove', { name: report.files.watermark });
      assert.deepStrictEqual([r.body.ok, r.body.removed], [true, 3]);
      assert.strictEqual((await post('/api/pdf/watermark/remove', { name: report.files.watermark })).body.ok, false);
      await post('/api/pdf/undo', { name: report.files.watermark });
      assert.strictEqual([0, 1, 2].reduce((n, i) => n + entryOf(report.files.watermark).doc.objects(i).filter((o) => o.watermark).length, 0), 3, '실행 취소');
      for (const bad of [{ text: '' }, { text: 'x', opacity: 2 }, { text: 'x', position: 'left' }, { text: 'x', layer: 'middle' }, { kind: 'image' }, { kind: 'image', imagePath: path.join(DIR, 'x.gif') }, { text: 'x', pages: '5' }, { text: 'x', size: 1000 }]) {
        assert.strictEqual((await post('/api/pdf/watermark', { name, ...bad })).status, 400, JSON.stringify(bad));
      }
      assert.strictEqual((await post('/api/pdf/watermark', { name, kind: 'image', imagePath: path.join(DIR, 'none.png') })).status, 404);

      // ── 6i. 머리말·꼬리말: 여섯 자리 · 표시({page} {pages} {date} {file} {title}) · 회전 쪽 · 다시 넣으면 교체 · 쪽 번호와 함께 · 실행 취소
      const hf = file('보고서 초안.pdf', buildPdf({ pages: [{ w: 400, h: 600 }, { w: 400, h: 600, extra: '/Rotate 90' }, { w: 400, h: 600 }] }));
      await info(hf);
      const hdoc = () => entryOf(hf).doc;
      const texts = (i) => hdoc().objects(i).filter((o) => o.headerFooter).map((o) => o.text.trim()).sort(); // 작은 한글 글자 객체는 GetText 끝에 공백이 붙어 나올 때가 있다
      r = await post('/api/pdf/header-footer', { name: hf, slots: { tl: '{title}', tc: '{file}', tr: '{date}', bl: '대외비', bc: '{page} / {pages}', br: '' }, size: 9, color: '#333333' });
      assert.deepStrictEqual([r.status, r.body.ok, r.body.placed, r.body.pages], [200, true, 15, 3], JSON.stringify(r.body));
      const today = new Date(), dd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      assert.deepStrictEqual(texts(1), ['2 / 3', dd, '대외비', '보고서 초안', '보고서 초안'].sort(), '제목이 없으면 {title} = 파일 이름');
      // 회전 쪽: 머리말은 보이는 위쪽, 꼬리말은 보이는 아래쪽 — 렌더 잉크로 확인
      for (const i of [0, 1]) {
        const rr = hdoc()._renderRaw(i, 1), top = inkBox(rr, { x0: 0, y0: 0, x1: rr.w - 1, y1: 40 }), bottom = inkBox(rr, { x0: 0, y0: rr.h - 41, x1: rr.w - 1, y1: rr.h - 1 }), mid = inkBox(rr, { x0: 0, y0: 60, x1: rr.w - 1, y1: rr.h - 61 });
        assert.ok(top && bottom, `${i + 1}쪽 보이는 위·아래 띠에 글자`);
        assert.ok(!mid || mid.y1 < rr.h - 61, `${i + 1}쪽 가운데는 비어 있다(본문 'Page n'만)`);
        const ll = inkBox(rr, { x0: 0, y0: rr.h - 41, x1: 60, y1: rr.h - 1 }), rr2 = inkBox(rr, { x0: rr.w - 61, y0: 0, x1: rr.w - 1, y1: 40 });
        assert.ok(ll && rr2, `${i + 1}쪽 왼쪽 아래('대외비')·오른쪽 위(날짜)`);
      }
      await post('/api/pdf/meta', { name: hf, fields: { Title: '3분기 보고' } });
      r = await post('/api/pdf/header-footer', { name: hf, slots: { tc: '{title} — {page}쪽' }, skipFirst: true, startAt: 1, pages: '1-3' });
      assert.deepStrictEqual([r.body.placed, r.body.removed], [2, 15], '다시 넣으면 교체 · 표지 건너뜀');
      assert.deepStrictEqual([texts(0), texts(1), texts(2)], [[], ['3분기 보고 — 1쪽'], ['3분기 보고 — 2쪽']]);
      r = await post('/api/pdf/page-numbers', { name: hf, format: 'n/N' });
      assert.deepStrictEqual([r.body.numbered, texts(2)], [3, ['3분기 보고 — 2쪽']], '쪽 번호와 머리말은 따로 산다');
      assert.deepStrictEqual(hdoc().objects(1).filter((o) => o.pageNum).map((o) => o.text), ['2 / 3']);
      r = await post('/api/pdf/header-footer/remove', { name: hf });
      assert.deepStrictEqual([r.body.ok, r.body.removed, hdoc().objects(1).filter((o) => o.pageNum).length], [true, 2, 1], '머리말만 지운다');
      await post('/api/pdf/undo', { name: hf });
      assert.deepStrictEqual(texts(1), ['3분기 보고 — 1쪽'], '실행 취소');
      report.files.headerFooter = await savedBytes(hf, 'hf-saved.pdf');
      for (const bad of [{ slots: {} }, { slots: { zz: 'x' } }, { slots: { tc: 'a\nb' } }, { slots: { tc: 'x' }, size: 1 }, { slots: { tc: 'x' }, pages: 'abc' }]) {
        assert.strictEqual((await post('/api/pdf/header-footer', { name: hf, ...bad })).status, 400, JSON.stringify(bad));
      }
    }

    if (process.env.KEEP_FEATURE_FILES) { fs.mkdirSync(path.join(TMP_ROOT, 'feat'), { recursive: true }); fs.writeFileSync(path.join(TMP_ROOT, 'feat', 'features-report.json'), JSON.stringify(report, null, 2)); } // Python 독립 검사용(tmp/feat/verify_features.py)
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(pdfDocs)) { try { pdfDocs[k].doc.close(); } catch {} delete pdfDocs[k]; }
    if (!process.env.KEEP_FEATURE_FILES && !process.exitCode) fs.rmSync(DIR, { recursive: true, force: true }); // Python 검사용으로 남기려면 KEEP_FEATURE_FILES=1
  }
  console.log(`OK — P9 기능(쪽 범위·목차 글·개인정보 패턴·숨은 데이터·문서 정보·목차·이미지 PDF${WIN ? '·개인정보 가리기·워터마크·머리말' : ''}·영역 가리기·주석) 검사 통과`);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
