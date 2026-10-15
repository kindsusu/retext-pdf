// 자체 검사: node app/pdf-ocr.test.js
// v6 Wave E2 글자 인식(OCR)을 설정·네트워크 차단 → 합성 스캔(글을 그려 그림 PDF로 만든 쪽) 인식 → 보이지 않는 글자 층(자리·찾기·개인정보·Markdown·가리기)
// → 편집 가능한 글자 → 진짜 PDFium 라우트(127.0.0.1:4971 — 진행·취소·영역 인식·일괄 처리) → 기울기 → 패키징 설정 순으로 검사한다.
// 시험 PDF는 여기서 만든다(빈 A4에 글상자로 한글·영문을 쓰고 기존 그림 PDF 경로로 그림만 남긴다). 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더로 돌린다.
// 사용자 앱의 4747 포트는 쓰지 않는다. 큰 말뭉치·방향(180°) 검사는 따로: npm run test:ocr (tools/ocr-corpus.js)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'ocr-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 4971;
process.env.RETEXTPDF_PORT = String(PORT);

const OCR = require('./pdf-ocr');
const { open } = require('./pdf-engine');
const { buildPdf } = require('./pdf-test-fixtures');
const UM = require('./ui-model');
const pii = require('./pii');
const MD = require('./pdf-markdown');
const { redactArea } = require('./pdf-edit-service');
const T0 = Date.now();
const lap = (label) => console.log(`  ${label} (${((Date.now() - T0) / 1000).toFixed(1)}초)`);

// 비슷함: 1 − 편집 거리 / 긴 쪽 길이(공백은 빼고 비교 — 띄어쓰기는 OCR이 흔히 틀린다)
function similarity(a, b) {
  a = [...String(a).replace(/\s+/g, '')]; b = [...String(b).replace(/\s+/g, '')];
  if (!a.length && !b.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
const iou = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy, area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
  return inter / (area(a) + area(b) - inter);
};
// electron-builder files 패턴(여기서 쓰는 것만: * · ** · {a,b}) → 정규식
const globRe = (g) => new RegExp('^' + g.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{([^}]+)\}/g, (_, x) => `(${x.split(',').join('|')})`)
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const union = (rects) => ({ x0: Math.min(...rects.map((r) => r.x0)), y0: Math.min(...rects.map((r) => r.y0)), x1: Math.max(...rects.map((r) => r.x1)), y1: Math.max(...rects.map((r) => r.y1)) });

// 합성 스캔: 빈 A4에 글을 쓰고(맑은 고딕) 200dpi로 그린 픽셀을 deg만큼 돌려(흰 바탕) 그림 하나만 든 쪽으로. truth = 원래 글자 자리(돌리기 전)
const LINES = [['독서 모임 안내문 OCR Test', 22], ['개인정보 보호법에 따라 처리합니다.', 16], ['The quick brown fox jumps over the lazy dog.', 16], ['연락처: 010-1234-5678', 16], ['회의 자료는 다음 주 월요일까지 보내 주세요.', 16]];
const WORDS = ['독서', '개인정보', 'quick', '010-1234-5678', '월요일까지'];
async function syntheticScan({ deg = 0, dpi = 200 } = {}) {
  const src = await open(buildPdf({ pages: [{ w: 595, h: 842, content: '' }] }));
  LINES.forEach(([t, size], k) => src.addTextBox(0, { text: t, x: 60, y: 770 - k * 48, size }));
  const truth = {};
  for (const w of WORDS) truth[w] = union(src.find(0, w)[0].rects);
  const raw = src._renderRaw(0, dpi / 72);
  src.close();
  const W = raw.w, H = raw.h, data = Buffer.alloc(W * H * 4, 255), th = deg * Math.PI / 180, cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = x - cx, dy = y - cy;
    const sx = Math.round(cx + dx * Math.cos(th) - dy * Math.sin(th)), sy = Math.round(cy + dx * Math.sin(th) + dy * Math.cos(th));
    if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
    raw.data.copy(data, (y * W + x) * 4, sy * raw.stride + sx * 4, sy * raw.stride + sx * 4 + 4);
  }
  const d = await open(buildPdf({ pages: [{ w: 595, h: 842, content: '' }] }));
  d.insertImage(0, { kind: 'rgba', data, width: W, height: H, quality: 90 }, { x: 0, y: 0, w: 595, h: 842 });
  const bytes = d.save(); d.close();
  return { bytes, truth };
}
// 쪽 하나 인식해 엔진 모양 줄로(서버 ocrPage와 같은 길)
async function ocrDocPage(doc, i, opts = {}) {
  const s = 300 / 72, bmp = doc._renderRaw(i, s);
  const r = await OCR.recognize(bmp, { langs: ['kor', 'eng'], ...opts });
  return { r, lines: OCR.toPageLines(r.lines, (pts) => doc.pixelToPage(i, s, pts)) };
}
const inkIn = (raw, scale, r) => { // 쪽 좌표 사각형 안의 진한 픽셀 수
  let n = 0;
  for (let y = Math.floor((raw.h / scale - r.y1) * scale); y < Math.ceil((raw.h / scale - r.y0) * scale); y++) {
    for (let x = Math.floor(r.x0 * scale); x < Math.ceil(r.x1 * scale); x++) {
      const p = y * raw.stride + x * 4;
      if (raw.data[p] + raw.data[p + 1] + raw.data[p + 2] < 300) n++;
    }
  }
  return n;
};

(async () => {
  // ── 1. 설정: 모든 경로가 앱 안 파일 · 데이터 해시 · 네트워크 차단 ──────────────────────────
  {
    const o = OCR.workerOptions();
    for (const k of ['workerPath', 'langPath']) {
      assert.ok(path.isAbsolute(o[k]) && fs.existsSync(o[k]), `${k}는 앱 안의 실제 파일·폴더: ${o[k]}`);
      assert.ok(!/^[a-z][a-z0-9+.-]*:\/\//i.test(o[k]), `${k}가 주소가 아니다`);
    }
    assert.strictEqual(o.workerPath, path.join(__dirname, 'ocr-worker.js'));
    assert.strictEqual(o.langPath, path.join(__dirname, 'vendor', 'ocr'));
    assert.strictEqual(o.cacheMethod, 'none', '인식 데이터를 캐시 폴더에 쓰거나 읽지 않는다');
    assert.strictEqual(o.gzip, false);
    assert.ok(!('corePath' in o), 'WASM 엔진은 node_modules의 tesseract.js-core를 require한다(주소 없음)');
    const st = OCR.status();
    assert.strictEqual(st.available, true, JSON.stringify(st));
    assert.deepStrictEqual(st.langs.map((l) => [l.code, l.ok]), [['kor', true], ['eng', true]]);
    assert.deepStrictEqual(OCR.normLangs(['eng', 'kor']), ['kor', 'eng'], '한국어를 앞에');
    assert.throws(() => OCR.normLangs(['jpn']), /지원하지 않는 인식 언어/);
    assert.throws(() => OCR.normLangs([]), /언어를 하나 이상/);
    assert.strictEqual(OCR._test.unpacked('C:\\x\\resources\\app.asar\\app\\vendor\\ocr'), 'C:\\x\\resources\\app.asar.unpacked\\app\\vendor\\ocr', '설치본은 asar 밖 경로');
    // 작업 스레드는 네트워크 길이 막혀 있다: 일부러 주소를 줘도 받지 못하고 우리 차단 메시지로 실패한다(DNS 오류가 아니라)
    const { createWorker, OEM } = OCR._test.tesseract();
    let thread = null;
    const err = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('시간 초과'), 20000);
      createWorker(['kor'], OEM.LSTM_ONLY, { ...o, langPath: 'https://example.invalid/tessdata', errorHandler: (m) => { clearTimeout(t); resolve(String(m)); } }).catch(() => {});
      thread = OCR._test.lastThread(); // 언어를 못 받은 createWorker는 끝나지 않는다 → 스레드를 직접 끝낸다(남기면 시험 프로세스가 안 끝난다)
    });
    await thread?.terminate();
    assert.match(err, /네트워크를 쓰지 않습니다 \(fetch 차단/, `작업 스레드의 네트워크 차단: ${err}`);
    for (const w of ['http.request', 'net.connect', 'dns.lookup', 'tls.connect']) assert.ok(fs.readFileSync(o.workerPath, 'utf8').includes(w.split('.')[0]), `ocr-worker.js가 ${w}를 막는다`);
    // 순수 함수: 낱말 잇기(음절마다 따로 온 한글 낱말을 줄 글의 띄어쓰기대로)
    const bb = (x0, x1) => ({ x0, y0: 0, x1, y1: 10 });
    const jw = OCR._test.joinWords([{ text: '개', conf: 90, bbox: bb(0, 10) }, { text: '인', conf: 80, bbox: bb(10, 20) }, { text: '정보', conf: 95, bbox: bb(20, 40) }, { text: '보호법', conf: 90, bbox: bb(50, 80) }], '개인정보 보호법\n');
    assert.deepStrictEqual(jw.map((w) => [w.text, w.bbox.x0, w.bbox.x1]), [['개인정보', 0, 40], ['보호법', 50, 80]]);
    // 돌리기·되돌리기는 서로 역
    const g = { g: Buffer.from([1, 2, 3, 4, 5, 6]), w: 3, h: 2 };
    for (const k of [1, 2, 3]) { const r = OCR._test.rotGray(g, k); const [x, y] = OCR._test.unrot(k, ...(k === 1 ? [1.5, 0.5] : k === 2 ? [2.5, 1.5] : [0.5, 2.5]), 3, 2); assert.ok(Number.isFinite(x) && Number.isFinite(y) && r.g.length === 6); }
    lap('설정·데이터 해시·네트워크 차단 검사 통과');
  }

  // ── 2. 합성 스캔 → 스캔한 쪽 알아보기 → 인식(한국어+영어) → 보이지 않는 글자 층 ─────────────────
  const scan = await syntheticScan();
  const scanFile = path.join(DIR, '스캔.pdf'); fs.writeFileSync(scanFile, scan.bytes);
  let searchBytes;
  {
    const d = await open(scan.bytes);
    assert.strictEqual(d.pageText(0).trim(), '', '그림 PDF에는 글자가 없다');
    const info = UM.scanPageInfo(d.objects(0), d.pageSize(0));
    assert.deepStrictEqual([info.scanned, info.chars], [true, 0], `스캔한 쪽으로 알아본다 ${JSON.stringify(info)}`);
    assert.ok(info.imageCover > 0.95);
    const rss0 = process.memoryUsage().rss;
    const { r, lines } = await ocrDocPage(d, 0);
    const rss1 = process.memoryUsage().rss;
    console.log(`  인식 ${r.ms}ms · 신뢰도 ${r.confidence}% · 메모리 +${((rss1 - rss0) / 1048576).toFixed(0)}MB (프로세스 ${(rss1 / 1048576).toFixed(0)}MB)`);
    const got = r.lines.map((l) => l.text);
    LINES.forEach(([t], k) => {
      const best = Math.max(...got.map((g2) => similarity(g2, t)));
      assert.ok(best >= 0.85, `${k + 1}번째 줄 "${t}" 인식 비슷함 ${best.toFixed(2)} ≥ 0.85 — 읽은 글: ${JSON.stringify(got)}`);
    });
    assert.ok(r.confidence >= 75, `평균 신뢰도 ${r.confidence}`);
    assert.strictEqual(r.angle, 0); assert.strictEqual(r.orientation, 0);
    const a = d.addOcrLayers([{ i: 0, lines }], { mode: 'search' });
    assert.ok(a.ok && a.words >= 20 && a.dropped === 0, JSON.stringify(a));
    searchBytes = d.save(); d.close();
    const e = await open(searchBytes);
    const objs = e.objects(0);
    const ocrObjs = objs.filter((o) => o.ocr === 'search');
    assert.strictEqual(ocrObjs.length, a.words, '낱말마다 글자 객체 하나');
    assert.ok(ocrObjs.every((o) => o.hidden && o.renderMode === 3), '보이지 않는 글자(렌더 모드 3)');
    assert.strictEqual(objs.filter((o) => o.type === 'image').length, 1, '그림은 그대로');
    assert.ok(!UM.scanPageInfo(objs, e.pageSize(0)).scanned, '인식한 쪽은 더 이상 스캔한 쪽이 아니다');
    // 찾기: 낱말이 찾히고, 찾은 자리가 원래 글자 자리와 겹친다(IoU — 그림 속 글자 위에 정확히 겹쳐 있다)
    for (const w of WORDS) {
      const hits = e.find(0, w);
      assert.ok(hits.length >= 1, `찾기 "${w}"`);
      const box = union(hits[0].rects), v = iou(box, scan.truth[w]);
      assert.ok(v >= 0.5, `"${w}" 찾은 자리와 원래 글자 자리 IoU ${v.toFixed(2)} ≥ 0.5 (${JSON.stringify(box)} vs ${JSON.stringify(scan.truth[w])})`);
    }
    assert.ok(e.find(0, '모임 안내문').length >= 1, '띄어쓰기가 든 말도 찾는다(낱말 뒤 띄어쓰기를 넣었다)');
    // 낱말 상자(tesseract)와 넣은 글자 객체 상자: 같은 낱말끼리 IoU
    const wordObjs = ocrObjs.filter((o) => /^(개인정보|quick|월요일까지)$/.test(o.text.trim()));
    assert.ok(wordObjs.length >= 2);
    for (const o of wordObjs) {
      const t = scan.truth[o.text.trim()], v = iou(o.bounds, t);
      assert.ok(v >= 0.5, `글자 객체 "${o.text}" 상자와 원래 자리 IoU ${v.toFixed(2)}`);
    }
    // 개인정보 찾기 · Markdown 내보내기 · 글자 추출(복사)이 OCR 글자를 읽는다
    const { text } = e.pageChars(0);
    assert.ok(pii.findPii(text, { kinds: ['phone'] }).some((h) => /010-?1234-?5678/.test(h.text || text.slice(h.start, h.end))), '개인정보 찾기(전화번호)');
    const md = MD.convert([{ ...e.pageSize(0), objs }], { format: 'md' }).text;
    assert.ok(md.includes('독서') && md.includes('quick'), `Markdown에 OCR 글자: ${md.slice(0, 120)}`);
    assert.ok(similarity(e.pageText(0), LINES.map((l) => l[0]).join('')) >= 0.85, '글자 추출(복사·다른 뷰어) 전체 비슷함');
    // 진짜 가리기: OCR 글자를 덮은 영역을 가리면 그 낱말이 파일에서 사라진다(그림 픽셀도 칠한다)
    const t = scan.truth['개인정보'], box = { x0: t.x0 - 2, y0: t.y0 - 2, x1: t.x1 + 2, y1: t.y1 + 2 };
    const before = e._renderRaw(0, 1);
    const rr = redactArea(e, 0, box, { color: [0, 0, 0, 255] });
    assert.ok(rr.images.painted >= 1, '그림 픽셀도 칠한다');
    const red = await open(e.save());
    assert.strictEqual(red.find(0, '개인정보').length, 0, '가린 OCR 낱말은 찾히지 않는다');
    assert.ok(!red.pageChars(0).text.includes('개인정보'), '글자 추출에도 없다');
    assert.ok(red.find(0, 'quick').length >= 1, '가리지 않은 낱말은 남는다');
    assert.ok(inkIn(red._renderRaw(0, 1), 1, box) > inkIn(before, 1, box), '가린 자리는 검게 덮였다');
    red.close(); e.close();
    lap('합성 스캔 인식·보이지 않는 글자 층(찾기·IoU·개인정보·Markdown·가리기) 검사 통과');
  }

  // ── 3. 편집 가능한 글자: 그림의 글자 자리를 배경색으로 지우고 보이는 글자 줄로 ─────────────────
  {
    const d = await open(scan.bytes);
    const { lines } = await ocrDocPage(d, 0);
    const before = d._renderRaw(0, 1);
    const a = d.addOcrLayers([{ i: 0, lines }], { mode: 'edit' });
    assert.ok(a.ok && a.painted === 1 && a.covers === 0, JSON.stringify(a));
    const objs = d.objects(0), vis = objs.filter((o) => o.ocr === 'edit');
    assert.strictEqual(vis.length, a.lines, '줄마다 보이는 글자 객체 하나(기존 줄 편집기로 고친다)');
    assert.ok(vis.every((o) => !o.hidden && o.renderMode === 0));
    const line2 = vis.find((o) => similarity(o.text, LINES[1][0]) >= 0.85);
    assert.ok(line2, `둘째 줄 글자 객체: ${vis.map((o) => o.text).join(' | ')}`);
    assert.ok(Math.abs(line2.scaledSize - 16) <= 3, `글자 크기가 원래(16pt)와 비슷하다: ${line2.scaledSize}`);
    assert.ok(Math.abs(line2.color[0] - 0) <= 90, `글자 색은 진하다: ${line2.color}`);
    const after = d._renderRaw(0, 1), t = scan.truth['개인정보'];
    assert.ok(inkIn(after, 1, t) > 20 && inkIn(before, 1, t) > 20, '그 자리에 다시 쓴 글자가 보인다');
    const bytes = d.save(); d.close();
    const e = await open(bytes);
    assert.ok(e.find(0, '개인정보').length >= 1 && e.find(0, 'quick').length >= 1);
    // 다시 인식(편집 → 검색용): 전에 넣은 OCR 글자는 교체된다(겹쳐 두 번 찾히지 않는다)
    const again = e.addOcrLayers([{ i: 0, lines }], { mode: 'search' });
    assert.strictEqual(again.removed, a.lines, '옛 OCR 글자를 뺐다');
    assert.strictEqual(e.find(0, 'quick').length, 1);
    e.close();
    lap('편집 가능한 글자(배경 칠하기·크기·색·다시 인식 교체) 검사 통과');
  }

  // ── 4. 라우트(진짜 PDFium): 상태 · 문서 OCR(진행·취소·실행 취소) · 찾기 · 영역 인식·넣기 · 일괄 처리 ─────────
  const { _test } = require('./server.js');
  const { server, pdfDocs, jobs } = _test;
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
  const get = (route, q) => raw('GET', route + (q ? '?' + new URLSearchParams(q) : ''));
  try {
    let r = await get('/api/ocr/status');
    assert.strictEqual(r.body.available, true);
    assert.ok(!JSON.stringify(r.body).includes(DIR), '상태에 경로를 싣지 않는다');
    const name = scanFile;
    // 3쪽 문서(같은 스캔 세 쪽)를 만들어 진행·취소를 본다
    const three = await open(scan.bytes); three.insertPdf(1, scan.bytes); three.insertPdf(2, scan.bytes);
    const multi = path.join(DIR, '세쪽.pdf'); fs.writeFileSync(multi, three.save()); three.close();
    const jobId = 'ocr-cancel-1';
    const pending = post('/api/pdf/ocr', { name: multi, langs: ['kor', 'eng'], jobId });
    let seen = null;
    for (let k = 0; k < 200 && !seen; k++) { await new Promise((res) => setTimeout(res, 50)); const j = jobs.get(jobId); if (j && j.done >= 1) seen = { ...j }; }
    assert.ok(seen && seen.total === 4 && /2쪽 글자 인식 중 \(2\/3\)/.test(seen.message), `쪽마다 진행: ${JSON.stringify(seen)}`);
    const progressView = await get('/api/jobs', { id: jobId });
    assert.strictEqual(progressView.body.phase, 'ocr');
    await post('/api/jobs/cancel', { id: jobId });
    r = await pending;
    assert.deepStrictEqual([r.body.cancelled, r.body.ok, r.body.undoLeft], [true, false, 0], `취소하면 문서는 그대로: ${JSON.stringify(r.body)}`);
    assert.strictEqual((await post('/api/pdf/find', { name: multi, query: '독서' })).body.total, 0);
    // 잘못된 입력
    assert.strictEqual((await post('/api/pdf/ocr', { name, langs: ['xx'] })).status, 400);
    assert.strictEqual((await post('/api/pdf/ocr', { name, pages: '9' })).status, 400);
    // 문서 OCR(검색 가능) → 실행 취소 한 번 · 찾기 라우트 · 개인정보 찾기 라우트
    r = await post('/api/pdf/ocr', { name, langs: ['kor', 'eng'], mode: 'search', jobId: 'ocr-2' });
    assert.ok(r.body.ok && r.body.words >= 20 && r.body.undoLeft === 1 && r.body.reloadAll, JSON.stringify(r.body).slice(0, 300));
    assert.deepStrictEqual(r.body.pages.map((p) => p.i), [0]);
    r = await post('/api/pdf/find', { name, query: '독서' });
    assert.ok(r.body.total >= 1 && iou(union(r.body.hits[0].rects), scan.truth['독서']) >= 0.5, `찾기 라우트: ${JSON.stringify(r.body).slice(0, 200)}`);
    r = await post('/api/pdf/pii/find', { name, kinds: ['phone'] });
    assert.ok((r.body.matches || []).length >= 1, `개인정보 찾기 라우트: ${JSON.stringify(r.body).slice(0, 200)}`);
    // 다시 하면 글자가 있는 쪽은 건너뛴다
    r = await post('/api/pdf/ocr', { name, langs: ['kor', 'eng'] });
    assert.deepStrictEqual([r.body.ok, r.body.skipped.length, r.body.pages.length], [false, 1, 0], '이미 글자가 있는 쪽은 건너뛴다');
    r = await post('/api/pdf/undo', { name });
    assert.ok(r.body.ok);
    assert.strictEqual((await post('/api/pdf/find', { name, query: '독서' })).body.total, 0, '실행 취소 한 번이면 OCR 글자가 모두 빠진다');
    // 영역 인식: 둘째 줄만 → 읽기만(문서 그대로) → 그 자리에 검색용으로 넣기
    const t = scan.truth['개인정보'];
    const rect = [t.x0 - 6, t.y0 - 6, 400, t.y1 + 6];
    r = await post('/api/pdf/ocr-region', { name, i: 0, rect, langs: ['kor', 'eng'] });
    assert.ok(r.body.ok && similarity(r.body.text, '개인정보 보호법에 따라 처리합니다.') >= 0.8, `영역 인식: ${JSON.stringify(r.body.text)}`);
    assert.ok(!r.body.text.includes('독서') && !r.body.text.includes('quick'), '영역 밖 글은 읽지 않는다');
    assert.strictEqual((await get('/api/pdf/info', { name })).body.undoLeft ?? 0, 0, '영역 인식은 문서를 바꾸지 않는다');
    const region = r.body;
    r = await post('/api/pdf/ocr-apply', { name, i: 0, lines: region.lines, mode: 'search', rect });
    assert.ok(r.body.ok && r.body.words >= 3 && r.body.undoLeft === 1, JSON.stringify(r.body));
    r = await post('/api/pdf/find', { name, query: '개인정보' });
    assert.ok(r.body.total === 1 && iou(union(r.body.hits[0].rects), t) >= 0.5, `영역 넣기 뒤 찾기: ${JSON.stringify(r.body).slice(0, 200)}`);
    assert.strictEqual((await post('/api/pdf/find', { name, query: 'quick' })).body.total, 0, '영역 밖은 그대로');
    r = await post('/api/pdf/ocr-apply', { name, i: 0, lines: region.lines, mode: 'search', rect });
    assert.strictEqual((await post('/api/pdf/find', { name, query: '개인정보' })).body.total, 1, '같은 영역에 다시 넣으면 교체(두 번 찾히지 않음)');
    assert.strictEqual((await post('/api/pdf/ocr-apply', { name, i: 0, lines: [] })).status, 400);
    assert.strictEqual((await post('/api/pdf/ocr-apply', { name, i: 0, lines: [{ o: ['x', 1], words: [] }] })).body.ok, false, '이상한 줄은 넣지 않는다');
    // 일괄 처리: OCR(검색 가능) — 원본은 그대로, 결과 파일은 찾을 수 있다
    const outDir = path.join(DIR, 'out'); fs.mkdirSync(outDir);
    r = await post('/api/pdf/batch', { paths: [scanFile, multi], action: 'ocr', options: { langs: ['kor', 'eng'] }, outDir, nameSuffix: '-OCR', jobId: 'ocr-batch' });
    assert.ok(r.body.ok && r.body.results.length === 2, JSON.stringify(r.body).slice(0, 300));
    assert.deepStrictEqual(r.body.results.map((x) => x.pages), [1, 3]);
    for (const x of r.body.results) {
      const out = await open(fs.readFileSync(x.out));
      for (let i = 0; i < out.pageCount; i++) assert.ok(out.find(i, '독서').length >= 1, `${path.basename(x.out)} ${i + 1}쪽 찾기`);
      out.close();
    }
    assert.strictEqual((await open(fs.readFileSync(multi))).pageText(0).trim(), '', '원본은 그대로');
    assert.strictEqual((await post('/api/pdf/batch', { paths: [scanFile], action: 'ocr', options: { langs: [] }, outDir })).status, 400);
    lap('라우트(진행·취소·실행 취소·찾기·개인정보·영역 인식·일괄 처리) 검사 통과');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(pdfDocs)) { try { pdfDocs[k].doc.close(); } catch {} delete pdfDocs[k]; }
  }

  // ── 5. 기울어진 스캔(2°): tesseract가 기울기를 재서 세우고, 보이지 않는 글자도 같은 기울기로 겹친다 ─────────
  {
    const sk = await syntheticScan({ deg: 2 });
    const d = await open(sk.bytes);
    const { r, lines } = await ocrDocPage(d, 0);
    assert.ok(Math.abs(Math.abs(r.angle) - 2) <= 0.6, `기울기 ${r.angle}°`);
    const got = r.lines.map((l) => l.text);
    assert.ok(Math.max(...got.map((g2) => similarity(g2, LINES[1][0]))) >= 0.8, `기울어진 줄 인식: ${JSON.stringify(got)}`);
    d.addOcrLayers([{ i: 0, lines }], { mode: 'search' });
    const o = d.objects(0).find((x) => x.ocr && x.text.trim() === 'quick');
    assert.ok(o && Math.abs(Math.atan2(o.matrix[1], o.matrix[0]) * 180 / Math.PI) > 1, `글자 객체도 기울었다: ${o && o.matrix}`);
    // 그림을 2° 돌렸으니 원래 자리(가운데 기준으로 돌린 자리)와 겹친다
    const th = 2 * Math.PI / 180, c = { x: 595 / 2, y: 842 / 2 }, t = sk.truth.quick;
    const rot = (x, y) => { const dx = x - c.x, dy = y - c.y; return [c.x + dx * Math.cos(th) - dy * Math.sin(th), c.y + dx * Math.sin(th) + dy * Math.cos(th)]; };
    const pts = [rot(t.x0, t.y0), rot(t.x1, t.y0), rot(t.x0, t.y1), rot(t.x1, t.y1)];
    const exp = { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
    const hit = union(d.find(0, 'quick')[0].rects);
    assert.ok(iou(hit, exp) >= 0.4, `기울어진 낱말 자리 IoU ${iou(hit, exp).toFixed(2)}`);
    d.close();
    lap(`기울어진 스캔(${r.angle}°) 검사 통과`);
  }

  // ── 6. 패키징 설정: 작업 스레드·인식 데이터·엔진이 asar 밖에, 쓰는 WASM 빌드는 빠지지 않는다 ─────────
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const un = pkg.build.asarUnpack || [];
    for (const p of ['app/ocr-worker.js', 'app/vendor/ocr/**', 'node_modules/tesseract.js/**', 'node_modules/tesseract.js-core/**', 'node_modules/regenerator-runtime/**', 'node_modules/is-url/**', 'node_modules/bmp-js/**', 'node_modules/wasm-feature-detect/**']) assert.ok(un.includes(p), `asarUnpack ${p}`);
    assert.strictEqual(pkg.dependencies['tesseract.js'], '7.0.0', '정확한 판 고정');
    assert.strictEqual(pkg.dependencies['tesseract.js-core'], '7.0.0');
    const files = pkg.build.files;
    assert.ok(files.includes('app/**') && !files.some((f) => /vendor/.test(f) && f.startsWith('!')), 'app/vendor/ocr는 빠지지 않는다');
    // Node 작업 스크립트가 실제로 부르는 엔진 빌드: tesseract.js 7.0.0의 getCore는 OEM 대신 lstmOnly(true)를 받아 언제나 '-lstm'이 없는 빌드를 고른다
    // (실측 2026-10-15: -lstm만 남긴 설치본이 "Cannot find module tesseract-core-relaxedsimd"로 실패) → getCore.js에서 이름을 읽어 그 빌드가 빠지지 않는지 본다
    const getCore = fs.readFileSync(require.resolve('tesseract.js/src/worker-script/node/getCore.js'), 'utf8');
    const loaded = [...getCore.matchAll(/require\('tesseract\.js-core\/([\w-]+)'\)/g)].map((m) => m[1]);
    const used = loaded.filter((v) => !v.endsWith('-lstm'));
    assert.deepStrictEqual(used.sort(), ['tesseract-core', 'tesseract-core-relaxedsimd', 'tesseract-core-simd']);
    for (const v of used) {
      for (const ext of ['.js', '.wasm']) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'node_modules', 'tesseract.js-core', v + ext)));
        assert.ok(!files.some((f) => f.startsWith('!') && globRe(f.slice(1)).test(`node_modules/tesseract.js-core/${v}${ext}`)), `${v}${ext}는 패키지에 남는다`);
        assert.ok(files.some((f) => f.startsWith('!') && globRe(f.slice(1)).test(`node_modules/tesseract.js-core/${v}-lstm${ext}`)), `쓰지 않는 ${v}-lstm${ext}는 뺀다`);
      }
    }
    assert.ok(files.includes('THIRD-PARTY-NOTICES.md'));
    const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md'), 'utf8');
    for (const [lang, l] of Object.entries(OCR.LANGS)) assert.ok(notices.includes(l.sha256) && notices.includes(`${lang}.traineddata`), `고지문에 ${lang} SHA-256`);
    assert.ok(fs.existsSync(path.join(__dirname, 'vendor', 'ocr', 'LICENSE')), '인식 데이터 라이선스 사본');
    lap('패키징 설정 검사 통과');
  }

  await OCR.shutdown();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`OK — v6 Wave E2 글자 인식(설정·네트워크 차단·합성 스캔 인식·보이지 않는 글자 층·편집 가능한 글자·라우트·기울기·패키징) 검사 통과 (${((Date.now() - T0) / 1000).toFixed(1)}초)`);
})().catch(async (e) => { console.error('FAIL', e); try { await OCR.shutdown(); } catch {} process.exitCode = 1; process.exit(1); });
