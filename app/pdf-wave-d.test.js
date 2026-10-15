// 자체 검사: node app/pdf-wave-d.test.js
// v6 Wave D(Markdown·텍스트 내보내기 · 쪽 자르기·크기 · 두 문서 비교 · 일괄 처리 · 링크 · 첨부 파일 · 영역 스냅샷 · 베이츠 번호)를
// 순수 함수 → 엔진 → 진짜 PDFium 라우트(127.0.0.1:4931) 순으로 검사한다. 시험 PDF는 여기서 만든다(사용자 문서를 쓰지 않는다).
// 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더로 돌린다. 사용자 앱의 4747 포트는 쓰지 않는다
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'waved-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 4931;
process.env.RETEXTPDF_PORT = String(PORT);

const { buildPdf, makePng } = require('./pdf-test-fixtures');
const { open, normalizeLinkUri } = require('./pdf-engine');
const MD = require('./pdf-markdown');
const CMP = require('./pdf-compare');
const { encodePng, decodePng } = require('./image-util');
const WIN = process.platform === 'win32'; // 한글 글자 넣기(맑은 고딕 대체 글꼴)는 Windows에서만

const pagesOf = (d) => Array.from({ length: d.pageCount }, (_, i) => ({ ...d.pageSize(i), objs: d.objects(i) }));
const inkBox = (raw, thr = 735) => { // 흰색이 아닌 픽셀의 외곽 상자
  let box = null;
  for (let y = 0; y < raw.h; y++) for (let x = 0; x < raw.w; x++) {
    const p = y * raw.stride + x * 4;
    if (raw.data[p] + raw.data[p + 1] + raw.data[p + 2] >= thr) continue;
    box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
  }
  return box;
};
// 한글 줄 여러 개로 된 PDF(글상자 — 맑은 고딕 서브셋). lines: [[쪽, 글]…]
async function koreanPdf(pageLines, pageCount = 1) {
  const d = await open(buildPdf({ pages: Array.from({ length: pageCount }, () => ({ w: 400, h: 500, content: ' ' })) }));
  const byPage = new Map();
  for (const [p, t] of pageLines) { if (!byPage.has(p)) byPage.set(p, []); byPage.get(p).push(t); }
  for (const [p, list] of byPage) list.forEach((t, k) => d.addTextBox(p, { x: 40, y: 460 - k * 30, text: t, size: 14 }));
  const b = d.save(); d.close(); return b;
}

(async () => {
  // ── 1. Markdown 변환(순수): 말뭉치 골든 · 독서모임 안내문 되돌리기 · 텍스트 형식 · 줄 잇기 ─────────────
  {
    const dir = path.join(__dirname, 'test-data', 'grouping'), gold = path.join(__dirname, 'test-data', 'markdown-golden');
    const names = fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'));
    assert.ok(names.length >= 14, '말뭉치 14건');
    for (const f of names) {
      const d = await open(fs.readFileSync(path.join(dir, f)));
      const got = MD.convert(pagesOf(d), { stripHeaderFooter: true }).text;
      d.close();
      assert.strictEqual(got, fs.readFileSync(path.join(gold, f.replace(/\.pdf$/, '.md')), 'utf8'), `골든 ${f}`);
    }
    // 골든 안의 핵심 모양: 목록·번호·굵게·기울임·표·하이픈 잇기
    const g = (n) => fs.readFileSync(path.join(gold, n), 'utf8');
    assert.match(g('07-lists.md'), /^- 첫 번째 항목입니다\n- Second item here\n1\. 번호가 있는 항목\n2\. Another numbered item\n- 직접 입력한 글머리 기호 항목\n- 하이픈 글머리 항목$/m);
    assert.match(g('05-mixed-styles.md'), /\*\*굵은 글씨\*\*와 _기울임_/);
    assert.match(g('09-table.md'), /\| \*\*품목\*\* \| \*\*수량\*\* \| \*\*단가\*\* \| \*\*금액\*\* \|\n\| --- \| --- \| --- \| --- \|\n\| 사무용 의자 \| 12 \| 85,000 \| 1,020,000 \|/, '테두리 있는 표');
    assert.match(g('09-table.md'), /\| 모니터 받침대 \| 3 \| 25,000 \| 개당 가격 \|/, '테두리 없는 표');
    assert.doesNotMatch(g('08-two-columns.md'), /\|/, '두 단 글은 표가 아니다');
    assert.match(g('11-hyphenation.md'), /The internationalization of documents/);
    assert.match(g('11-hyphenation.md'), /문장입니다\. 다음 줄로/, '한글 음절 나눔은 붙여 잇는다');
    assert.match(g('13-mixed-sizes.md'), /^# /m, '큰 글자는 제목');

    // 독서모임 안내문: 원본 .md와 제목·글머리 줄이 같다
    const src = path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf');
    const want = fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.md'), 'utf8').replace(/\r\n/g, '\n');
    const d = await open(fs.readFileSync(src));
    const out = MD.convert(pagesOf(d), { stripHeaderFooter: true });
    const pick = (t) => t.split('\n').filter((l) => /^(#{1,6} |- )/.test(l));
    assert.deepStrictEqual(pick(out.text), pick(want), '제목·글머리가 원본 Markdown과 같다');
    const words = (t) => t.replace(/[#*_\-]/g, ' ').split(/\s+/).filter(Boolean);
    const W = new Set(words(want)), hit = words(out.text).filter((w) => W.has(w)).length;
    assert.ok(hit / words(want).length > 0.95, `낱말 일치 ${hit}/${words(want).length}`);
    assert.deepStrictEqual([out.stats.headings, out.stats.lists], [5, 6]);
    const txt = MD.convert(pagesOf(d), { format: 'txt' }).text;
    d.close();
    assert.ok(!/[#*]/.test(txt) && /^• 일시: 2026년/m.test(txt) && /^10월 독서 모임 안내$/m.test(txt), '텍스트 내보내기: 표시 없이, 도형 글머리는 •');
    assert.strictEqual(MD.joinLines([{ raw: 'inter-', text: 'inter-' }, { raw: 'national', text: 'national' }]), 'international');
    assert.strictEqual(MD.joinLines([{ raw: '사과 ', text: '사과' }, { raw: '배', text: '배' }]), '사과 배', '줄 끝 공백은 한 칸');
    assert.strictEqual(MD.joinLines([{ raw: 'end.', text: 'end.' }, { raw: 'Next', text: 'Next' }]), 'end. Next');
    assert.ok(MD.PAGE_NUM.test('- 3 -') && MD.PAGE_NUM.test('3 / 10') && MD.PAGE_NUM.test('12쪽') && !MD.PAGE_NUM.test('2026년'), '쪽 번호 모양');
  }

  // ── 2. 비교(순수): Myers 차분은 최장 공통 부분열 ─────────────────────────────
  {
    for (let t = 0; t < 200; t++) {
      const rnd = (n) => Array.from({ length: n }, () => 'abcd'[(t * 7 + n * 13 + Math.floor(Math.random() * 4)) % 4]);
      const a = rnd(Math.floor(Math.random() * 15)), b = rnd(Math.floor(Math.random() * 15));
      const ops = CMP.myers(a, b);
      let eq = 0;
      for (const o of ops) if (o.op === 'eq') { assert.strictEqual(a[o.a], b[o.b]); eq++; }
      const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      assert.strictEqual(eq, dp[0][0], 'LCS 길이');
      assert.strictEqual(ops.filter((o) => o.op !== 'ins').length, a.length); assert.strictEqual(ops.filter((o) => o.op !== 'del').length, b.length);
    }
  }

  // ── 3. 엔진: 자르기·여백 자동·쪽 크기·영역 그림·링크·첨부·베이츠 ─────────────────
  {
    assert.strictEqual(normalizeLinkUri('example.com/한'), 'https://example.com/%ED%95%9C');
    assert.strictEqual(normalizeLinkUri('mailto:a@b.kr'), 'mailto:a@b.kr');
    for (const bad of ['javascript:alert(1)', 'file:///c:/x', '', 'x'.repeat(2001)]) assert.throws(() => normalizeLinkUri(bad), (e) => e.status === 400, bad);
    const d = await open(buildPdf({ pages: [{ w: 400, h: 300, content: '0 0 1 rg 100 100 50 40 re f' }, { w: 400, h: 300, extra: '/Rotate 90', content: '0 0 1 rg 100 100 50 40 re f' }] }));
    assert.deepStrictEqual(d.pageBoxes(0), { media: [0, 0, 400, 300], crop: null, view: [0, 0, 400, 300], rotation: 0 });
    const c = d.contentBox(0).map(Math.round);
    assert.deepStrictEqual(c, [100, 100, 150, 140], '내용 외곽(파란 사각형)');
    let r = d.cropPages([0], { margins: { top: 10, right: 30, bottom: 40, left: 20 } });
    assert.deepStrictEqual(r.pages[0].crop, [20, 40, 370, 290]);
    assert.deepStrictEqual(d.pageSize(0), { w: 350, h: 250, rotation: 0, ox: 20, oy: 40 }, '보이는 크기·원점');
    r = d.cropPages([1], { margins: { top: 10, right: 30, bottom: 40, left: 20 } });
    const s1 = d.pageSize(1);
    assert.deepStrictEqual([s1.w, s1.h], [250, 350], '회전 쪽: 보이는 방향 여백(가로 400-20-30 → 세로)');
    r = d.cropPages([0], { auto: true, pad: 5 });
    assert.deepStrictEqual(r.pages[0].crop.map(Math.round), [95, 95, 155, 145], '여백 자동 자르기 = 내용 + 5pt');
    const raw = d._renderRaw(0, 1);
    assert.deepStrictEqual([raw.w, raw.h], [60, 50], '잘린 쪽만 그린다');
    assert.ok(inkBox(raw) && inkBox(raw).x0 <= 6 && inkBox(raw).x1 >= 53, '잘린 쪽 안의 사각형');
    assert.strictEqual(d.cropPages([0], { reset: true }).pages[0].crop.join(), '0,0,400,300', '자르기 풀기');
    assert.ok(d.cropPages([0], { rect: [0, 0, 5, 5] }).skipped.length === 1, '18pt보다 작으면 건너뛴다');
    assert.throws(() => d.cropPages([0], {}), /자를 방법/);
    // 쪽 크기: A4 맞춤(400×300 → 595×842, 배율 595/400) — 사각형도 같은 배율로 가운데
    r = d.resizePages([0], { width: 595.28, height: 841.89, mode: 'fit' });
    assert.ok(Math.abs(r.pages[0].scale - 595.28 / 400) < 1e-3);
    assert.deepStrictEqual([Math.round(d.pageSize(0).w), Math.round(d.pageSize(0).h)], [595, 842]);
    const sc = 595.28 / 400, oy = (841.89 - 300 * sc) / 2;
    const cb = d.contentBox(0);
    assert.ok(Math.abs(cb[0] - 100 * sc) < 2 && Math.abs(cb[1] - (oy + 100 * sc)) < 2 && Math.abs(cb[2] - 150 * sc) < 2, `맞춘 내용 자리 ${cb.map(Math.round)}`);
    r = d.resizePages([1], { width: 500, height: 500, mode: 'center' });
    assert.deepStrictEqual([d.pageSize(1).w, d.pageSize(1).h, d.pageSize(1).rotation], [500, 500, 1], '가운데 놓기·회전 유지');
    assert.throws(() => d.resizePages([0], { width: 10, height: 10 }), /36~14400/);
    { const L = await open(buildPdf({ pages: [{ w: 500, h: 300 }, { w: 300, h: 500 }] }));
      L.resizePages([0, 1], { width: 595.28, height: 841.89, keepOrientation: true });
      assert.deepStrictEqual([0, 1].map((k) => [Math.round(L.pageSize(k).w), Math.round(L.pageSize(k).h)]), [[842, 595], [595, 842]], '쪽마다 원래 방향(가로 쪽은 가로 A4)');
      L.close(); }
    // 영역 그림
    const png = decodePng(d.renderArea(0, { x0: 100, y0: 100, x1: 200, y1: 150 }, 2));
    assert.deepStrictEqual([png.width, png.height], [200, 100]);
    // 링크
    const u = d.addLink(0, [50, 50, 150, 80], { uri: 'https://example.com/가' });
    const g = d.addLink(0, [50, 100, 150, 130], { page: 1 });
    assert.deepStrictEqual(d.links(0).map((l) => [l.kind, l.uri || l.page]), [['uri', 'https://example.com/%EA%B0%80'], ['page', 1]]);
    assert.throws(() => d.addLink(0, [0, 0, 1, 1], { page: 0 }), /너무 작/);
    assert.throws(() => d.addLink(0, [0, 0, 50, 50], { page: 9 }), /범위/);
    const up = d.updateLink(0, u.index, { page: 0 });
    assert.deepStrictEqual([up.link.kind, up.link.page, up.link.rect], ['page', 0, [50, 50, 150, 80]], '링크 대상 바꾸기');
    assert.strictEqual(d.deleteLink(0, g.index).ok, true);
    assert.strictEqual(d.links(0).length, 1);
    // 첨부
    const at = d.addAttachment('C:\\x\\메모.txt', Buffer.from('첨부 내용 ✓'), '설명');
    assert.deepStrictEqual([at.name, d.attachments()[0].name, d.attachments()[0].desc], ['메모.txt', '메모.txt', '설명']);
    assert.strictEqual(d.attachmentData(0).toString(), '첨부 내용 ✓');
    assert.throws(() => d.addAttachment('메모.TXT', Buffer.from('x')), /같은 이름/);
    // 베이츠
    const bt = d.addBates({ prefix: 'ABC-', digits: 5, start: 98, position: 'bottom-right' });
    assert.deepStrictEqual([bt.first, bt.last, bt.next, bt.placed], ['ABC-00098', 'ABC-00099', 100, 2]);
    assert.deepStrictEqual(d.objects(1).filter((o) => o.bates).map((o) => o.text), ['ABC-00099']);
    assert.strictEqual(d.addBates({ prefix: 'X', digits: 2, start: 1 }).removed, 2, '다시 넣으면 바꿔 끼운다');
    const saved = d.save(); d.close();
    const e = await open(saved);
    assert.deepStrictEqual([e.links(0).length, e.attachments().length, e.objects(0).filter((o) => o.bates).map((o) => o.text)], [1, 1, ['X01']], '저장·재열기');
    assert.strictEqual(e.removeBates().removed, 2);
    assert.deepStrictEqual(e.addBates({ pages: [1], start: 7, digits: 3 }).first, '007', '고른 쪽만');
    e.close();
  }

  // ── 4. 라우트(진짜 PDFium) ───────────────────────────────────────────────
  const { _test } = require('./server.js');
  const { server, pdfDocs } = _test;
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const raw = (method, route, data) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks), text = buf.toString(); let body = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body, buf, type: res.headers['content-type'], headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(data);
  });
  const post = (route, data) => raw('POST', route, JSON.stringify(data));
  const get = (route, q) => raw('GET', route + '?' + new URLSearchParams(q));
  const file = (n, bytes) => { const f = path.join(DIR, n); fs.writeFileSync(f, bytes); return f; };
  const savedAs = async (name, to) => { const out = path.join(DIR, to); const r = await post('/api/pdf/saveas', { name, to: out }); assert.strictEqual(r.body.ok, true); return out; };
  const py = { links: null, attach: null };
  try {
    // 4a. Markdown 내보내기 라우트: 안내문(→ .md 탭으로 열 파일) · 그림 PNG 저장 · 텍스트 · 범위
    {
      const name = file('안내.pdf', fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf')));
      const to = path.join(DIR, '안내.md');
      let r = await post('/api/pdf/export-markdown', { name, to, jobId: 'md1' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      const md = fs.readFileSync(to, 'utf8');
      assert.match(md, /^# 10월 독서 모임 안내\n\n- 일시:/);
      r = await post('/api/pdf/export-markdown', { name, to: path.join(DIR, '안내.txt') });
      assert.strictEqual(r.body.format, 'txt');
      assert.ok(!fs.readFileSync(path.join(DIR, '안내.txt'), 'utf8').includes('#'));
      assert.strictEqual((await post('/api/pdf/export-markdown', { name, to: path.join(DIR, 'x.doc') })).status, 400);
      assert.strictEqual((await post('/api/pdf/export-markdown', { name, to, pages: '9' })).status, 400, '없는 쪽');
      // 그림이 있는 문서: 그림을 PNG로 .md 옆에
      const d = await open(buildPdf({ pages: [{ w: 300, h: 300, content: 'BT /F1 18 Tf 40 250 Td (Title line) Tj ET BT /F1 10 Tf 40 40 Td (Under the picture) Tj ET' }] }));
      const px = Buffer.alloc(40 * 30 * 4); for (let k = 0; k < px.length; k += 4) { px[k] = 200; px[k + 3] = 255; }
      d.insertImage(0, { kind: 'rgba', data: px, width: 40, height: 30 }, { x: 60, y: 100, w: 120, h: 90 });
      const imgPdf = file('그림.pdf', d.save()); d.close();
      r = await post('/api/pdf/export-markdown', { name: imgPdf, to: path.join(DIR, '그림.md'), images: 'files' });
      assert.strictEqual(r.body.images.length, 1);
      assert.ok(fs.existsSync(r.body.images[0]) && /그림-p1-1\.png$/.test(r.body.images[0]));
      const gmd = fs.readFileSync(path.join(DIR, '그림.md'), 'utf8');
      assert.match(gmd, /Title line\n\n!\[\]\(%EA%B7%B8%EB%A6%BC-p1-1\.png\)\n\nUnder the picture/, '그림은 위·아래 글 사이');
      const pic = decodePng(fs.readFileSync(r.body.images[0]));
      assert.deepStrictEqual([pic.width, pic.height], [240, 180], '그림 영역 2배');
    }

    // 4b. 자르기·쪽 크기 라우트 + 실행 취소 한 번 · 렌더 크기
    {
      const name = file('crop.pdf', buildPdf({ pages: [{ w: 400, h: 300, content: '1 0 0 rg 200 150 40 30 re f' }, { w: 400, h: 300 }] }));
      let r = await post('/api/pdf/crop', { name, pages: 'all', margins: { top: 50, bottom: 50, left: 100, right: 100 } });
      assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.reloadAll, true);
      let inf = (await get('/api/pdf/info', { name })).body;
      assert.deepStrictEqual(inf.pages.map((p) => [p.w, p.h, p.ox, p.oy]), [[200, 200, 100, 50], [200, 200, 100, 50]]);
      const img = decodePng((await get('/api/pdf/page', { name, i: 0, scale: 1 })).buf);
      assert.deepStrictEqual([img.width, img.height], [200, 200], '자른 쪽 그림 크기');
      r = await get('/api/pdf/boxes', { name, i: 0, detect: 1 });
      assert.deepStrictEqual([r.body.crop, r.body.content.map(Math.round)], [[100, 50, 300, 250], [200, 150, 240, 180]]);
      r = await post('/api/pdf/crop', { name, pages: '1', auto: true, pad: 0 });
      assert.deepStrictEqual(r.body.pages[0].crop.map(Math.round), [200, 150, 240, 180]);
      r = await post('/api/pdf/crop', { name, pages: '2', auto: true });
      assert.deepStrictEqual([r.body.ok, r.body.skipped.length], [true, 0], 'Page 2 글자');
      await post('/api/pdf/undo', { name });
      inf = (await get('/api/pdf/info', { name })).body;
      assert.strictEqual(inf.pages[0].w, 40, '실행 취소 한 번 = 직전 자르기만');
      r = await post('/api/pdf/page-size', { name, pages: 'all', width: 612, height: 792, mode: 'fit' });
      inf = (await get('/api/pdf/info', { name })).body;
      assert.deepStrictEqual(inf.pages.map((p) => [Math.round(p.w), Math.round(p.h), p.ox || 0]), [[612, 792, 0], [612, 792, 0]], 'Letter');
      const big = decodePng((await get('/api/pdf/page', { name, i: 0, scale: 0.5 })).buf);
      assert.deepStrictEqual([big.width, big.height], [306, 396]);
      await post('/api/pdf/undo', { name });
      assert.strictEqual(Math.round((await get('/api/pdf/info', { name })).body.pages[0].w), 40, '쪽 크기 실행 취소');
      assert.strictEqual((await post('/api/pdf/page-size', { name, width: 1, height: 1 })).status, 400);
    }

    // 4c. 링크 라우트: URI + 쪽 이동을 만들고 저장본을 엔진·pypdf로 다시 읽는다
    {
      const name = file('links.pdf', buildPdf({ pages: [{}, {}] }));
      let r = await post('/api/pdf/link/create', { name, i: 0, rect: [40, 300, 200, 330], uri: 'https://example.com/a b' });
      assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
      r = await post('/api/pdf/link/create', { name, i: 0, rect: [40, 200, 200, 230], page: 1 });
      assert.strictEqual(r.body.link.page, 1);
      assert.strictEqual((await post('/api/pdf/link/create', { name, i: 0, rect: [40, 200, 200, 230], uri: 'javascript:alert(1)' })).status, 400, 'javascript: 링크 거절');
      let all = (await get('/api/pdf/links', { name })).body;
      assert.deepStrictEqual(all.map((l) => [l.i, l.kind, l.uri || l.page]), [[0, 'uri', 'https://example.com/a%20b'], [0, 'page', 1]]);
      r = await post('/api/pdf/link/update', { name, i: 0, index: all[0].index, uri: 'https://example.org/' });
      all = (await get('/api/pdf/links', { name, i: 0 })).body;
      assert.ok(all.some((l) => l.uri === 'https://example.org/'), '주소 고치기');
      const out = await savedAs(name, 'links-saved.pdf');
      const e = await open(fs.readFileSync(out));
      assert.deepStrictEqual(e.links(0).map((l) => l.kind).sort(), ['page', 'uri']);
      e.close();
      py.links = out;
      r = await post('/api/pdf/link/delete', { name: out, i: 0, index: 0 }); // 다른 이름으로 저장하면 열린 문서가 그 파일로 옮겨 간다
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual((await get('/api/pdf/links', { name: out, i: 0 })).body.length, 1);
      assert.strictEqual((await post('/api/pdf/link/delete', { name: out, i: 0, index: 5 })).status, 404);
    }

    // 4d. 첨부 파일 라우트: 넣기 → 목록 → 꺼내기(바이트 같음) → 지우기(저장본에 내용이 남지 않음)
    {
      const name = file('attach.pdf', buildPdf({ pages: [{}] }));
      const payload = Buffer.from('ATTACHMENT-PAYLOAD-한글-' + 'x'.repeat(100));
      const src = file('자료.txt', payload);
      let r = await post('/api/pdf/attachment/add', { name, path: src });
      assert.deepStrictEqual([r.body.ok, r.body.attachments.map((a) => [a.name, a.size])], [true, [['자료.txt', payload.length]]]);
      assert.strictEqual((await post('/api/pdf/attachment/add', { name, path: src })).status, 400, '같은 이름');
      assert.strictEqual((await post('/api/pdf/attachment/add', { name, path: path.join(DIR, 'none.bin') })).status, 404);
      const to = path.join(DIR, 'out', '꺼낸.txt'); fs.mkdirSync(path.dirname(to));
      r = await post('/api/pdf/attachment/extract', { name, index: 0, to });
      assert.ok(fs.readFileSync(to).equals(payload), '꺼낸 바이트 = 넣은 바이트');
      py.attach = await savedAs(name, 'attach-saved.pdf');
      const reopened = await open(fs.readFileSync(py.attach));
      assert.ok(reopened.attachmentData(0).equals(payload)); reopened.close();
      r = await post('/api/pdf/attachment/delete', { name: py.attach, index: 0 });
      assert.deepStrictEqual([r.body.ok, r.body.attachments.length, r.body.compacted], [true, 0, true]);
      const gone = await savedAs(py.attach, 'attach-deleted.pdf');
      assert.ok(!fs.readFileSync(gone).includes('ATTACHMENT-PAYLOAD'), '지운 첨부 내용이 파일에 남지 않는다');
    }

    // 4e. 영역 스냅샷
    {
      const name = file('snap.pdf', buildPdf({ pages: [{ w: 300, h: 300, content: '0 0 1 rg 50 50 100 50 re f' }] }));
      let r = await get('/api/pdf/snapshot', { name, i: 0, x0: 50, y0: 50, x1: 150, y1: 100, scale: 2 });
      const p = decodePng(r.buf);
      assert.deepStrictEqual([r.type, p.width, p.height], ['image/png', 200, 100]);
      assert.deepStrictEqual([...p.data.subarray(0, 3)], [0, 0, 255], '영역 안은 파랑');
      r = await post('/api/pdf/snapshot/save', { name, i: 0, rect: [50, 50, 150, 100], to: path.join(DIR, 'snap.png') });
      assert.ok(r.body.ok && fs.existsSync(path.join(DIR, 'snap.png')));
      assert.strictEqual((await post('/api/pdf/snapshot/save', { name, i: 0, rect: [0, 0, 9, 9], to: path.join(DIR, 'snap.jpg') })).status, 400);
    }

    // 4f. 베이츠 라우트 + 지우기
    {
      const name = file('bates.pdf', buildPdf({ pages: [{}, {}, {}] }));
      let r = await post('/api/pdf/bates', { name, prefix: 'CASE-', digits: 4, start: 12 });
      assert.deepStrictEqual([r.body.first, r.body.last, r.body.next], ['CASE-0012', 'CASE-0014', 15]);
      assert.deepStrictEqual((await get('/api/pdf/objects', { name, i: 2 })).body.filter((o) => o.bates).map((o) => o.text), ['CASE-0014']);
      assert.strictEqual((await post('/api/pdf/bates', { name, digits: 40 })).status, 400);
      r = await post('/api/pdf/bates/remove', { name });
      assert.strictEqual(r.body.removed, 3);
      assert.strictEqual((await post('/api/pdf/bates/remove', { name })).body.ok, false);
    }

    // 4g. 두 문서 비교: 넣기·지우기·바꾸기(한글) · 단위 · 픽셀 비교
    if (WIN) {
      const A = file('비교-원본.pdf', await koreanPdf([[0, '첫째 줄은 그대로 남는다'], [0, '둘째 줄은 지워질 문장'], [0, '셋째 줄 사과를 먹었다'], [1, '다음 쪽 그대로']], 2));
      const B = file('비교-수정.pdf', await koreanPdf([[0, '첫째 줄은 그대로 남는다'], [0, '셋째 줄 배를 먹었다'], [0, '넷째 줄 새로 넣음'], [1, '다음 쪽 그대로']], 2));
      let r = await post('/api/pdf/compare', { name: A, other: B, unit: 'word', jobId: 'cmp1' });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const sum = r.body.diffs.map((d) => [d.kind, d.a.text || '', d.b.text || '']);
      assert.deepStrictEqual(sum, [['delete', '둘째 줄은 지워질 문장', ''], ['change', '사과를', '배를'], ['insert', '', '넷째 줄 새로 넣음']]);
      assert.deepStrictEqual(r.body.stats, { insert: 1, delete: 1, change: 1 });
      const ch = r.body.diffs[1];
      assert.ok(ch.a.rects.length === 1 && ch.b.rects.length === 1 && ch.a.rects[0].page === 0, '바뀐 낱말의 자리');
      const [l, b, rr, t] = ch.a.rects[0].rect;
      assert.ok(rr - l > 20 && rr - l < 60 && t - b > 8 && t - b < 25, `낱말 상자 크기 ${ch.a.rects[0].rect}`);
      assert.ok(r.body.diffs[2].a.rects.length === 0 && r.body.diffs[2].a.page === 0, '넣은 것: 왼쪽에는 자리만');
      assert.deepStrictEqual([r.body.pagesA.length, r.body.pagesB.length], [2, 2]);
      r = await post('/api/pdf/compare', { name: A, other: B, unit: 'line' });
      assert.deepStrictEqual(r.body.diffs.map((d) => d.kind), ['change'], '줄 단위: 두 줄 → 두 줄은 바뀜 하나');
      r = await post('/api/pdf/compare', { name: A, other: B, unit: 'paragraph' });
      assert.ok(r.body.diffs.length >= 1);
      assert.strictEqual((await post('/api/pdf/compare', { name: A, other: A })).status, 400, '같은 문서');
      assert.strictEqual((await post('/api/pdf/compare', { name: A, other: B, unit: 'char' })).status, 400);
      r = await get('/api/pdf/compare/pixels', { name: A, other: B, i: 0, scale: 0.5 });
      const heat = decodePng(r.buf);
      assert.deepStrictEqual([heat.width, heat.height], [200, 250]);
      assert.ok(Number(r.headers['x-changed']) > 0.002, `달라진 비율 ${r.headers['x-changed']}`);
      r = await get('/api/pdf/compare/pixels', { name: A, other: B, i: 1, scale: 0.5 });
      assert.strictEqual(Number(r.headers['x-changed']), 0, '같은 쪽은 0');
      // 같은 글 → 차이 없음
      const C = file('비교-같음.pdf', fs.readFileSync(A));
      assert.strictEqual((await post('/api/pdf/compare', { name: A, other: C })).body.diffs.length, 0);
    }

    // 4h. 일괄 처리: 세 파일(하나는 암호) 워터마크 → 둘 성공·하나 실패(계속) · 베이츠 이어 매기기 · 취소 · Markdown
    {
      const inDir = path.join(DIR, 'batch-in'), outDir = path.join(DIR, 'batch-out');
      fs.mkdirSync(inDir); fs.mkdirSync(outDir);
      const f1 = path.join(inDir, 'one.pdf'), f2 = path.join(inDir, 'two.pdf'), f3 = path.join(inDir, 'locked.pdf');
      fs.writeFileSync(f1, buildPdf({ pages: [{}, {}] })); fs.writeFileSync(f2, buildPdf({ pages: [{}, {}, {}] }));
      fs.writeFileSync(f3, buildPdf({ pages: [{}], encrypt: { user: 'pw', owner: 'own', P: -4 } }));
      let r = await post('/api/pdf/batch', { paths: [f1, f3, f2], action: 'watermark', options: { text: 'DRAFT', size: 40 }, outDir, nameSuffix: '-wm', jobId: 'b1' });
      assert.deepStrictEqual([r.body.ok, r.body.done, r.body.failed], [false, 2, 1], JSON.stringify(r.body));
      assert.match(r.body.results[1].error, /암호/);
      assert.ok(fs.existsSync(path.join(outDir, 'one-wm.pdf')) && fs.existsSync(path.join(outDir, 'two-wm.pdf')) && !fs.existsSync(path.join(outDir, 'locked-wm.pdf')));
      const w = await open(fs.readFileSync(path.join(outDir, 'two-wm.pdf')));
      assert.deepStrictEqual(Array.from({ length: 3 }, (_, i) => w.objects(i).filter((o) => o.watermark).map((o) => o.text)[0]), ['DRAFT', 'DRAFT', 'DRAFT']);
      w.close();
      assert.ok(fs.readFileSync(f1).equals(fs.readFileSync(f1)) && !(await open(fs.readFileSync(f1))).objects(0).some((o) => o.watermark), '원본은 그대로');
      // 베이츠: two(3쪽) 다음 one(2쪽) — 7부터 이어서
      r = await post('/api/pdf/batch', { paths: [f2, f1], action: 'bates', options: { prefix: 'B', digits: 3, start: 7 }, outDir, nameSuffix: '-bates' });
      assert.deepStrictEqual([r.body.ok, r.body.next, r.body.results.map((x) => [x.first, x.last])], [true, 12, [['B007', 'B009'], ['B010', 'B011']]]);
      const b1 = await open(fs.readFileSync(path.join(outDir, 'one-bates.pdf')));
      assert.deepStrictEqual([0, 1].map((i) => b1.objects(i).find((o) => o.bates).text), ['B010', 'B011'], '두 번째 파일은 이어지는 번호');
      b1.close();
      // 원본 자리에 쓰지 않는다
      r = await post('/api/pdf/batch', { paths: [f1], action: 'sanitize', nameSuffix: '' });
      assert.match(r.body.results[0].error, /원본과 같은 파일/);
      // 그 밖의 동작이 한 파일씩 성공한다
      for (const [action, options, ext] of [['headerFooter', { slots: { tc: '{file} {page}/{pages}' } }, '.pdf'], ['pageNumbers', {}, '.pdf'], ['sanitize', {}, '.pdf'], ['protect', { userPassword: 'secret1' }, '.pdf'],
        ['rasterize', { dpi: 50 }, '.pdf'], ['downsample', {}, '.pdf'], ['markdown', {}, '.md'], ['pii', { kinds: ['email'] }, '.pdf']]) {
        r = await post('/api/pdf/batch', { paths: [f1], action, options, outDir, nameSuffix: '-' + action });
        assert.strictEqual(r.body.ok, true, `${action}: ${JSON.stringify(r.body)}`);
        assert.ok(fs.existsSync(path.join(outDir, 'one-' + action + ext)), action);
      }
      await assert.rejects(open(fs.readFileSync(path.join(outDir, 'one-protect.pdf'))), (e) => e.code === 'PASSWORD_REQUIRED', '암호 걸기 결과');
      assert.strictEqual((await post('/api/pdf/batch', { paths: [f1], action: 'nope' })).status, 400);
      assert.strictEqual((await post('/api/pdf/batch', { paths: [f1], action: 'protect', options: {} })).status, 400, '암호 없음');
      // 취소: 시작 전에 취소한 작업은 아무것도 쓰지 않는다
      await post('/api/jobs/cancel', { id: 'b-cancel' });
      r = await post('/api/pdf/batch', { paths: [f1, f2], action: 'watermark', options: { text: 'C' }, outDir, nameSuffix: '-cancel', jobId: 'b-cancel' });
      assert.deepStrictEqual([r.body.cancelled, r.body.results.length], [true, 0]);
      assert.ok(!fs.existsSync(path.join(outDir, 'one-cancel.pdf')));
    }

    // 4i. 선택 검사: pypdf로 링크(/URI·/GoTo)와 첨부를 따로 읽는다(파이썬이 없으면 건너뛴다)
    {
      const script = path.join(DIR, 'check_wave_d.py');
      fs.writeFileSync(script, [
        'import sys, json',
        'from pypdf import PdfReader',
        'r = PdfReader(sys.argv[1]); out = {"uri": [], "goto": []}',
        'for a in r.pages[0].get("/Annots", []):',
        '    a = a.get_object(); act = a.get("/A")',
        '    if act is None: continue',
        '    act = act.get_object()',
        '    if act.get("/S") == "/URI": out["uri"].append(str(act.get("/URI")))',
        '    if act.get("/S") == "/GoTo": out["goto"].append(next(k for k, p in enumerate(r.pages) if p.indirect_reference.idnum == act["/D"][0].idnum))',
        'r2 = PdfReader(sys.argv[2]); out["attach"] = {k: len(v[0]) for k, v in r2.attachments.items()}',
        'print(json.dumps(out))  # -I는 PYTHONIOENCODING을 무시한다 → ASCII 이스케이프로',
      ].join('\n'));
      const p = spawnSync('python', ['-I', script, py.links, py.attach], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      if (p.status === 0) {
        const o = JSON.parse(p.stdout);
        assert.deepStrictEqual(o.uri, ['https://example.org/']);
        assert.deepStrictEqual(o.goto, [1], 'GoTo → 2쪽');
        assert.deepStrictEqual(o.attach, { '자료.txt': Buffer.byteLength('ATTACHMENT-PAYLOAD-한글-' + 'x'.repeat(100)) });
        console.log('  pypdf 독립 검사 통과(링크 URI·GoTo, 첨부)');
      } else console.log('  pypdf 검사 건너뜀:', (p.stderr || p.error?.message || '').split('\n').slice(-2).join(' '));
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(pdfDocs)) { try { pdfDocs[k].doc.close(); } catch {} delete pdfDocs[k]; }
    if (!process.exitCode) fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`OK — v6 Wave D(Markdown 골든·안내문 되돌리기·자르기·쪽 크기·링크·첨부·스냅샷·베이츠${WIN ? '·비교' : ''}·일괄 처리) 검사 통과`);
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; process.exit(1); });
