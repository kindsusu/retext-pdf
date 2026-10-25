// 자체 검사: node app/open-formats.test.js
// v6.1 열 수 있는 파일 넓히기 — 텍스트(.txt) 인코딩 왕복(UTF-8·BOM·UTF-16 LE/BE·CP949·CRLF) · .markdown · 그림을 PDF로 열기(PNG 투명·JPEG DCT 그대로·
// BMP·EXIF 방향·큰 그림 줄이기·GIF/WebP는 화면이 풀어 보냄·여러 장 합치기/따로) · 새 PDF의 저장 흐름 · 그림 쪽 진짜 가리기 · 스캔한 쪽 알림 · 20MB 상한.
// 순수 함수 → 진짜 PDFium 라우트(127.0.0.1:5061) 순서. 시험 파일은 모두 여기서 만든다(사용자 문서를 쓰지 않는다).
// 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더로 돌린다(사용자 설정 ~/.retext-pdf.json에 쓰지 않는다)
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'open-formats-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 5061;
process.env.RETEXTPDF_PORT = String(PORT);

const jpeg = require('jpeg-js');
const codec = require('./text-codec');
const UM = require('./ui-model');
const iu = require('./image-util');
const imagePdf = require('./image-pdf');
const { open } = require('./pdf-engine');
const { makePng, buildRawPdf } = require('./pdf-test-fixtures');
const WIN = process.platform === 'win32';

// ── 시험 그림 만들기 ─────────────────────────────────────────────────────────
// BMP: fn(x, y) → [r,g,b,a]. bpp 24(BGR)·32(BI_BITFIELDS + 알파 마스크)·8(팔레트, 색은 pal) · topDown이면 높이 음수
function makeBmp(w, h, fn, { bpp = 24, topDown = false, pal = null } = {}) {
  const stride = Math.floor((bpp * w + 31) / 32) * 4, hsize = bpp === 32 ? 108 : 40, palBytes = bpp === 8 ? 256 * 4 : 0;
  const off = 14 + hsize + palBytes, b = Buffer.alloc(off + stride * h);
  b.write('BM', 0, 'latin1'); b.writeUInt32LE(b.length, 2); b.writeUInt32LE(off, 10);
  b.writeUInt32LE(hsize, 14); b.writeInt32LE(w, 18); b.writeInt32LE(topDown ? -h : h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(bpp, 28);
  b.writeUInt32LE(bpp === 32 ? 3 : 0, 30); b.writeUInt32LE(stride * h, 34);
  if (bpp === 32) { b.writeUInt32LE(0x00ff0000, 54); b.writeUInt32LE(0x0000ff00, 58); b.writeUInt32LE(0x000000ff, 62); b.writeUInt32LE(0xff000000, 66); }
  if (bpp === 8) { b.writeUInt32LE(256, 46); pal.forEach((c, k) => { b[54 + k * 4] = c[2]; b[55 + k * 4] = c[1]; b[56 + k * 4] = c[0]; }); }
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      if (bpp === 8) b[row + x] = c;
      else if (bpp === 24) { b[row + x * 3] = c[2]; b[row + x * 3 + 1] = c[1]; b[row + x * 3 + 2] = c[0]; }
      else b.writeUInt32LE(((c[3] << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0, row + x * 4);
    }
  }
  return b;
}
const makeJpeg = (w, h, fn, q = 92) => {
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set([...fn(x, y), 255].slice(0, 4), (y * w + x) * 4);
  return Buffer.from(jpeg.encode({ data: d, width: w, height: h }, q).data);
};
// JPEG에 EXIF 방향(APP1, 빅 엔디언 TIFF, IFD0 항목 하나)을 끼운다
function withOrientation(jpg, o) {
  const tiff = Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]), len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, jpg.subarray(2)]);
}
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0, 0x3b])]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([20, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(12)]);
const has = (buf, s) => buf.includes(Buffer.from(s, 'latin1'));

(async () => {
  // ── 1. 파일 종류(ui-model): 화면·main.js·server.js가 같이 쓴다 ─────────────
  assert.deepStrictEqual(['a.pdf', 'b.md', 'c.MARKDOWN', 'd.txt', 'e.PNG', 'f.jpeg', 'g.webp', 'h.gif', 'i.bmp', 'j.doc', 'C:\\d.x\\noext', ''].map(UM.fileKind),
    ['pdf', 'md', 'md', 'txt', 'image', 'image', 'image', 'image', 'image', null, null, null]);
  assert.deepStrictEqual(['a.pdf', 'b.markdown', 'c.txt', 'd.jpg'].map(UM.kindLabel), ['PDF', 'MD', 'TXT', 'IMG']);
  assert.deepStrictEqual(UM.OPEN_EXT, ['pdf', 'md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

  // ── 2. 텍스트 인코딩 왕복 ────────────────────────────────────────────────
  const KO = '한글 텍스트 시험\r\n둘째 줄 ― ABC 123 · ①\r\n'; // ―(U+2015)·①은 CP949에 있다. —(U+2014 줄표)는 없다(아래 422 시험)
  const cp949Bytes = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]); // '한글'
  assert.deepStrictEqual(codec.decodeText(cp949Bytes), { text: '한글', encoding: 'cp949', lossy: false }, 'CP949 한글을 알아본다');
  assert.deepStrictEqual(codec.encodeText('한글', 'cp949'), cp949Bytes, 'CP949로 되돌려 쓴다');
  const variants = {
    'utf-8': Buffer.from(KO, 'utf8'),
    'utf-8-bom': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(KO, 'utf8')]),
    'utf-16le': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(KO, 'utf16le')]),
    'utf-16be': Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(KO, 'utf16le').swap16()]),
    cp949: new Uint8Array(0), // 아래에서 표로 만든다
  };
  variants.cp949 = codec.encodeText(KO, 'cp949');
  assert.ok(!variants.cp949.equals(variants['utf-8']) && variants.cp949.length < variants['utf-8'].length, 'CP949는 한글 한 자가 2바이트');
  for (const [enc, bytes] of Object.entries(variants)) {
    const d = codec.decodeText(bytes);
    assert.deepStrictEqual([d.encoding, d.text, d.lossy], [enc, KO, false], `${enc} 알아보기`);
    assert.ok(codec.encodeText(d.text, d.encoding).equals(bytes), `${enc} 바이트 그대로 왕복(CRLF 포함)`);
  }
  // CP949 두 바이트 조합 전부(표 app/cp949.bin): 풀린 글자는 같은 두 바이트로 되돌아간다(확장 완성형 포함)
  let pairs = 0, ksx = 0;
  const icuDec = new TextDecoder('euc-kr'); // Node의 것은 ICU EUC-KR(완성형 + 사용자 정의 영역을 PUA로) — 둘 다 아는 글자는 같아야 한다
  for (let lead = 0x81; lead <= 0xfe; lead++) for (let trail = 0x41; trail <= 0xfe; trail++) {
    const b = Buffer.from([lead, trail]), s = codec.decodeCp949(b);
    if (s === null) continue;
    const icu = icuDec.decode(b);
    if (icu.length === 1 && icu !== '�') { assert.strictEqual(s, icu, `완성형 ${b.toString('hex')}는 ICU와 같다`); ksx++; }
    assert.ok(codec.encodeText(s, 'cp949').equals(b), `CP949 ${b.toString('hex')} 왕복`);
    pairs++;
  }
  assert.ok(pairs === 17048 && ksx > 8000, `CP949 글자 ${pairs}개 왕복(완성형 ${ksx}개는 ICU와 일치)`);
  assert.deepStrictEqual([codec.decodeCp949(Buffer.from([0x8c, 0x63])), codec.decodeCp949(Buffer.from([0x81, 0x41]))], ['똠', '갂'], '확장 완성형(UHC)도 푼다');
  assert.deepStrictEqual(codec.decodeText(Buffer.from([0xb6, 0xc8, 0x8c, 0x63, 0x0d, 0x0a])), { text: '똑똠\r\n', encoding: 'cp949', lossy: false }, '확장 완성형이 섞인 CP949 파일');
  assert.throws(() => codec.encodeText('가😀나—', 'cp949'), (e) => e.status === 422 && e.extra.unencodable.join('') === '😀—', '이모지는 CP949로 못 쓴다 → 422 unencodable');
  assert.deepStrictEqual(codec.decodeText(Buffer.from([0x80, 0xff, 0xfe, 0x41, 0xc0])).lossy, true, '어느 인코딩으로도 안 풀리면 lossy');
  assert.strictEqual(codec.decodeText(Buffer.from('plain ascii\n')).encoding, 'utf-8', 'ASCII는 UTF-8');

  // ── 3. 그림 도우미(image-util) ───────────────────────────────────────────
  assert.deepStrictEqual([GIF, WEBP, makeBmp(2, 2, () => [0, 0, 0]), makePng(1, 1, () => [0, 0, 0, 255]), makeJpeg(8, 8, () => [9, 9, 9])].map(iu.sniffImage), ['gif', 'webp', 'bmp', 'png', 'jpeg']);
  assert.strictEqual(iu.sniff(makeBmp(2, 2, () => [0, 0, 0])), null, '도장·그림 넣기의 sniff는 그대로(PNG·JPEG만)');
  const quad = (x, y) => (x < 2 ? (y < 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : y < 2 ? [0, 0, 255, 255] : [255, 255, 0, 128]);
  for (const opt of [{ bpp: 24 }, { bpp: 24, topDown: true }, { bpp: 32 }]) {
    const d = iu.decodeBmp(makeBmp(4, 4, quad, opt));
    const px = (x, y) => [...d.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    assert.deepStrictEqual([px(0, 0), px(0, 3), px(3, 0)], [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]], `BMP ${JSON.stringify(opt)} 위·아래 줄 순서`);
    assert.strictEqual(px(3, 3)[3], opt.bpp === 32 ? 128 : 255, 'BMP 32비트 알파 마스크');
  }
  const pal = Array.from({ length: 256 }, (_, k) => [k, 255 - k, 7]);
  assert.deepStrictEqual([...iu.decodeBmp(makeBmp(3, 1, (x) => x * 100, { bpp: 8, pal })).data.subarray(4, 8)], [100, 155, 7, 255], 'BMP 8비트 팔레트');
  const rle = makeBmp(2, 2, () => [0, 0, 0]); rle.writeUInt32LE(1, 30);
  assert.throws(() => iu.decodeBmp(rle), /압축된 BMP/, 'RLE BMP는 직접 풀지 않는다(화면 디코더로)');
  assert.strictEqual(iu.jpegOrientation(withOrientation(makeJpeg(8, 8, () => [1, 2, 3]), 6)), 6);
  assert.strictEqual(iu.jpegOrientation(makeJpeg(8, 8, () => [1, 2, 3])), 1);
  { // 방향 6(시계 방향 90°): 왼쪽 위 픽셀이 오른쪽 위로
    const img = { width: 3, height: 2, data: Buffer.from([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255]) };
    const r = iu.orientRgba(img, 6);
    assert.deepStrictEqual([r.width, r.height, [...r.data].filter((_, k) => k % 4 === 0)], [2, 3, [4, 1, 5, 2, 6, 3]]);
    const r8 = iu.orientRgba(img, 8);
    assert.deepStrictEqual([...r8.data].filter((_, k) => k % 4 === 0), [3, 6, 2, 5, 1, 4]);
  }

  // ── 4. 그림 → PDF(엔진) ────────────────────────────────────────────────
  {
    const pngA = makePng(40, 30, (x) => (x < 20 ? [200, 30, 30, 255] : [0, 0, 255, 0])); // 오른쪽 절반 투명
    const jpg = makeJpeg(64, 48, (x) => [x * 4, 100, 50]);
    const a = imagePdf.prepareImage(pngA), b = imagePdf.prepareImage(jpg);
    assert.deepStrictEqual([a.type, a.image.kind, a.image.lossless, b.type, b.image.kind], ['png', 'rgba', true, 'jpeg', 'jpeg'], 'PNG는 무손실, JPEG는 DCT 그대로');
    const bytes = await imagePdf.imagesToPdf([a, b]);
    assert.ok(bytes.includes(jpg), 'JPEG 바이트가 다시 압축되지 않고 그대로 들어간다');
    assert.ok(has(bytes, '/SMask'), '투명 PNG는 /SMask');
    const d = await open(bytes);
    assert.deepStrictEqual([d.pageCount, d.pageSize(0), d.pageSize(1)], [2, { w: 30, h: 22.5, rotation: 0 }, { w: 48, h: 36, rotation: 0 }], '쪽 크기 = 그림 픽셀 × 0.75pt(96dpi)');
    const raw = d._renderRaw(0, 4), px = (x, y) => { const p = y * raw.stride + x * 4; return [raw.data[p], raw.data[p + 1], raw.data[p + 2]]; };
    assert.ok(px(10, 40)[0] > 150 && px(10, 40)[2] < 80, `왼쪽 절반은 그림 색: ${px(10, 40)}`);
    assert.ok(px(100, 40).every((v) => v > 240), `투명한 오른쪽 절반은 흰 바탕이 보인다: ${px(100, 40)}`);
    assert.deepStrictEqual(UM.scanPageInfo(d.objects(1), d.pageSize(1)).scanned, true, '그림 한 장짜리 쪽 = 스캔한 쪽(글자 인식 알림이 뜬다)');
    // 쪽을 가로 띠 그림 28장으로 쪼갠 PDF(띠 한 장은 쪽의 3.6%)와 글자를 윤곽선 도형으로 그린 PDF도 글자 인식을 권한다 — 저장·다시 열기 뒤 엔진 objects로
    d.insertBlankPage(2, 595, 842);
    const strip = { kind: 'jpeg', data: makeJpeg(400, 20, (x) => [x % 255, 120, 80]) };
    for (let k = 0; k < 28; k++) d.insertImage(2, strip, { x: 0, y: 842 - (k + 1) * (842 / 28), w: 595, h: 842 / 28 });
    const e = await open(d.save()); d.close();
    const sStrip = UM.scanPageInfo(e.objects(2), e.pageSize(2));
    assert.deepStrictEqual([sStrip.scanned, sStrip.kind, sStrip.imageCover >= 0.99, e.objects(2).filter((o) => o.type === 'image').length], [true, 'image', true, 28], `띠 그림 28장 쪽 ${JSON.stringify(sStrip)}`);
    e.close();
    // 윤곽선 글자: 글자 크기 채운 도형 150개(따로 칠한 경로 = 경로 객체 하나씩) + 표 선 40개(0.5pt — 세지 않는다). 엔진 addPolygon은 가림 상자 표시가 붙어 원시 PDF로 만든다
    const glyphs = Array.from({ length: 150 }, (_, k) => `${40 + (k % 50) * 10} ${780 - Math.floor(k / 50) * 16} 6 9 re f`).join('\n');
    const ruleLines = Array.from({ length: 40 }, (_, k) => `40 ${100 + k * 12} 515 0.5 re f`).join('\n');
    const content = Buffer.from(`${glyphs}\n${ruleLines}\n`, 'latin1');
    const outlinePdf = buildRawPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << >> >>', { dict: `<< /Length ${content.length} >>`, data: content }]);
    const f = await open(outlinePdf);
    const sOutline = UM.scanPageInfo(f.objects(0), f.pageSize(0));
    assert.deepStrictEqual([sOutline.scanned, sOutline.kind, sOutline.chars, sOutline.glyphPaths, f.objects(0).filter((o) => o.type === 'path').length], [true, 'outline', 0, 150, 190], `윤곽선 글자 쪽 ${JSON.stringify(sOutline)}`);
    f.close();
    // EXIF 방향 6: 픽셀을 돌려 넣는다 → 쪽이 세로(48×64px → 36×48pt)
    const rot = imagePdf.prepareImage(withOrientation(jpg, 6));
    assert.deepStrictEqual([rot.image.kind, rot.width, rot.height], ['rgba', 48, 64], 'EXIF 방향대로 돌린다');
    // 큰 그림: 긴 변 7000px로 줄이고 알린다
    const big = imagePdf.prepareImage(makePng(7200, 4, () => [10, 20, 30, 255]));
    assert.deepStrictEqual([big.width, big.height, big.scaled], [7000, 4, { from: [7200, 4] }], '긴 변이 7000px를 넘으면 줄인다');
    for (const raw2 of [GIF, WEBP]) assert.throws(() => imagePdf.prepareImage(raw2), (e) => e.needDecode === true, 'GIF·WebP는 화면 디코더로');
    assert.throws(() => imagePdf.prepareImage(Buffer.from('not an image')), /그림 파일이 아닙니다/);
  }

  // ── 5. 라우트(진짜 PDFium) ───────────────────────────────────────────────
  const { _test } = require('./server.js');
  const { server, pdfDocs } = _test;
  assert.ok(server.keepAliveTimeout >= 60000, '쉬는 연결 유지 시간을 늘려 동기 작업 뒤 ECONNRESET이 나지 않게 한다');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const raw = (method, route, data, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: route, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks), text = buf.toString(); let body = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body, buf, type: res.headers['content-type'] }); });
    });
    req.on('error', reject);
    req.end(data);
  });
  const post = (route, data) => raw('POST', route, JSON.stringify(data));
  const get = (route, q) => raw('GET', route + '?' + new URLSearchParams(q));
  const file = (n, bytes) => { const f = path.join(DIR, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); return f; };
  const entryOf = (f) => pdfDocs[WIN ? path.resolve(f).toLowerCase() : path.resolve(f)];
  try {
    // 5a. 텍스트 라우트: CP949 + CRLF를 열고 고쳐 저장하면 CP949·CRLF 그대로
    {
      const name = file('docs/메모.txt', codec.encodeText('첫 줄 한글\r\n둘째 줄\r\n', 'cp949'));
      let r = await get('/api/text', { name });
      assert.deepStrictEqual([r.status, r.body.encoding, r.body.text, r.body.lossy], [200, 'cp949', '첫 줄 한글\r\n둘째 줄\r\n', false]);
      r = await raw('PUT', `/api/text?${new URLSearchParams({ name, encoding: 'cp949' })}`, '첫 줄 한글 고침\r\n둘째 줄\r\n셋째 줄 추가\r\n');
      assert.deepStrictEqual([r.status, r.body.ok], [200, true]);
      const saved = fs.readFileSync(name);
      assert.ok(saved.includes(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb])) && saved.includes(Buffer.from('\r\n')) && !saved.includes(Buffer.from('한글', 'utf8')), '저장 바이트는 CP949(한글 = C7D1 B1DB)·CRLF');
      assert.strictEqual(new TextDecoder('euc-kr').decode(fs.readFileSync(name)), '첫 줄 한글 고침\r\n둘째 줄\r\n셋째 줄 추가\r\n');
      r = await raw('PUT', `/api/text?${new URLSearchParams({ name, encoding: 'cp949' })}`, '이모지 😀');
      assert.deepStrictEqual([r.status, r.body.unencodable], [422, ['😀']], 'CP949로 못 쓰는 글자 → 422(파일은 그대로)');
      assert.strictEqual(new TextDecoder('euc-kr').decode(fs.readFileSync(name)), '첫 줄 한글 고침\r\n둘째 줄\r\n셋째 줄 추가\r\n', '422면 파일을 건드리지 않는다');
      r = await raw('PUT', `/api/text?${new URLSearchParams({ name, encoding: 'utf-8' })}`, '이모지 😀');
      assert.ok(r.status === 200 && fs.readFileSync(name).equals(Buffer.from('이모지 😀', 'utf8')), 'UTF-8로 저장을 고르면 UTF-8');
      for (const [enc, bytes] of Object.entries(variants)) {
        const f = file(`enc-${enc}.txt`, bytes);
        r = await get('/api/text', { name: f });
        assert.deepStrictEqual([r.body.encoding, r.body.text], [enc, KO], `라우트 ${enc}`);
        await raw('PUT', `/api/text?${new URLSearchParams({ name: f, encoding: enc })}`, r.body.text);
        assert.ok(fs.readFileSync(f).equals(bytes), `라우트 ${enc} 저장 = 원래 바이트`);
      }
      assert.strictEqual((await raw('PUT', `/api/text?${new URLSearchParams({ name, encoding: 'latin9' })}`, 'x')).status, 400, '모르는 인코딩은 400');
      // 20MB 넘는 글 파일: 열지 않고 알린다(.txt·.md·.markdown)
      const huge = Buffer.alloc(codec.TEXT_MAX_BYTES + 10, 0x61);
      for (const n of ['big.txt', 'big.md', 'big.markdown']) {
        const f = file(n, huge);
        r = n.endsWith('.txt') ? await get('/api/text', { name: f }) : await get('/api/file', { name: f });
        assert.deepStrictEqual([r.status, r.body.tooLarge, /20MB까지/.test(r.body.error)], [413, true, true], `${n} 20MB 상한`);
        fs.unlinkSync(f);
      }
    }
    // 5b. .markdown은 .md와 같다: 원문 그대로 읽고 쓰고, 작업 폴더 목록에 든다(그림은 목록에 넣지 않는다)
    {
      const ws = path.join(DIR, 'ws'); fs.mkdirSync(ws);
      for (const n of ['a.markdown', 'b.md', 'c.txt', 'd.pdf', 'e.png', 'f.docx']) fs.writeFileSync(path.join(ws, n), n === 'e.png' ? makePng(1, 1, () => [0, 0, 0, 255]) : '# x\r\n');
      const r = await get('/api/files', { dir: ws });
      assert.deepStrictEqual(r.body.map((p) => path.basename(p)), ['a.markdown', 'b.md', 'c.txt', 'd.pdf'], '폴더 열기: PDF·.md·.markdown·.txt만');
      const md = path.join(ws, 'a.markdown');
      let g = await get('/api/file', { name: md });
      assert.deepStrictEqual([g.status, g.body, /text\/plain/.test(g.type)], [200, '# x\r\n', true]);
      await raw('PUT', `/api/file?${new URLSearchParams({ name: md })}`, '# 고침\r\n');
      assert.strictEqual(fs.readFileSync(md, 'utf8'), '# 고침\r\n', '.markdown 저장은 확장자·줄바꿈 그대로');
      g = await get('/api/file', { name: path.join(ws, 'e.png') });
      assert.strictEqual(g.type, 'image/png', '그림 파일은 그림 형식으로(화면 디코더가 받는다)');
    }
    // 5c. 그림 → 새 PDF(따로 열기): 미저장·임시 폴더·그림 폴더를 저장 기본 위치로
    const imgDir = path.join(DIR, '사진');
    const png = file('사진/투명.png', makePng(40, 30, (x) => (x < 20 ? [200, 30, 30, 255] : [0, 0, 255, 0])));
    const jpg = file('사진/사진.jpg', makeJpeg(80, 60, (x, y) => [x * 3, y * 4, 120]));
    const bmp = file('사진/그림.bmp', makeBmp(20, 10, (x) => (x < 10 ? [0, 128, 255] : [255, 255, 255])));
    const webp = file('사진/움짤.webp', WEBP), gif = file('사진/첫장.gif', GIF);
    {
      const r = await post('/api/pdf/from-images', { images: [{ path: png }, { path: jpg }, { path: bmp }], merge: false });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.files.map((f) => [path.basename(f.path), f.pages]), [['투명.pdf', 1], ['사진.pdf', 1], ['그림.pdf', 1]], '따로 열기: 그림마다 <그림 이름>.pdf');
      for (const f of r.body.files) assert.ok(path.dirname(f.path).startsWith(path.join(os.tmpdir(), 'retext-pdf-new-')), '임시 폴더에 둔다');
      const [fp, fj, fb] = r.body.files.map((f) => f.path);
      const inf = (await get('/api/pdf/info', { name: fj })).body;
      assert.deepStrictEqual([inf.dirty, inf.temp, inf.fresh, inf.pages[0].w, inf.pages[0].h], [true, true, { dir: imgDir }, 60, 45], '미저장·임시·저장 기본 폴더 = 그림 폴더 · 쪽 60×45pt');
      // BMP 색이 그대로(파랑 왼쪽 · 흰 오른쪽)
      const db = entryOf(fb).doc, rb = db._renderRaw(0, 4), at = (x, y) => { const p = y * rb.stride + x * 4; return [rb.data[p], rb.data[p + 1], rb.data[p + 2]]; };
      assert.ok(at(10, 15)[2] > 200 && at(10, 15)[0] < 40 && at(45, 15).every((v) => v > 240), `BMP 픽셀: ${at(10, 15)} / ${at(45, 15)}`);
      // 그 자리 저장은 409 fresh → 다른 이름으로 저장하면 임시 폴더를 지우고 보통 문서가 된다
      let s = await post('/api/pdf/save', { name: fj });
      assert.deepStrictEqual([s.status, s.body.needSaveAs, s.body.fresh], [409, true, true], '새 PDF는 그 자리 저장 대신 다른 이름으로');
      const to = path.join(imgDir, '사진.pdf'), tmpDir = path.dirname(fj);
      s = await post('/api/pdf/saveas', { name: fj, to });
      assert.deepStrictEqual([s.status, fs.existsSync(to), fs.existsSync(tmpDir)], [200, true, false], '저장하면 임시 폴더는 지운다');
      const after = (await get('/api/pdf/info', { name: to })).body;
      assert.deepStrictEqual([after.dirty, after.fresh, after.temp], [false, undefined, false]);
      assert.ok(fs.readFileSync(to).includes(fs.readFileSync(jpg)), '저장한 PDF에 원본 JPEG 바이트가 그대로');
      assert.strictEqual((await post('/api/pdf/save', { name: to })).status, 200, '저장한 뒤에는 보통 저장');
      // 저장하지 않고 닫으면 임시 폴더째 지운다
      const tmpP = path.dirname(fp);
      await post('/api/pdf/close', { name: fp });
      assert.ok(!fs.existsSync(tmpP), '닫으면 임시 폴더를 지운다');
      await post('/api/pdf/close', { name: fb });
    }
    // 5d. GIF·WebP: 서버는 422 needDecode → 화면이 풀어 보낸 PNG/JPEG(data)로 다시 · 여러 장 합치기(쪽마다 그림 크기)
    {
      let r = await post('/api/pdf/from-images', { images: [{ path: png }, { path: webp }, { path: gif }], merge: true });
      assert.deepStrictEqual([r.status, r.body.needDecode], [422, [1, 2]], '못 푸는 그림 번호를 알려 준다');
      const fromPage = (w, h, c) => makePng(w, h, () => c).toString('base64'); // 화면 디코더(캔버스 → PNG)를 흉내
      r = await post('/api/pdf/from-images', { images: [{ path: png }, { path: webp, data: makeJpeg(32, 16, () => [0, 200, 0]).toString('base64') }, { path: gif, data: fromPage(8, 12, [255, 0, 255, 255]) }], merge: true });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(r.body.files.map((f) => [path.basename(f.path), f.pages]), [['투명 외 2장.pdf', 3]], '한 PDF로 합치기');
      const name = r.body.files[0].path, d = entryOf(name).doc;
      assert.deepStrictEqual([0, 1, 2].map((i) => [d.pageSize(i).w, d.pageSize(i).h]), [[30, 22.5], [24, 12], [6, 9]], '쪽마다 그 그림 크기');
      assert.ok([0, 1, 2].every((i) => UM.scanPageInfo(d.objects(i), d.pageSize(i)).scanned), '모든 쪽이 스캔한 쪽(글자 인식 알림)');
      // 그림 쪽 진짜 가리기: 2쪽(초록 JPEG 24×12pt)의 왼쪽 절반을 가리면 그림 픽셀이 칠해진다(덮개를 빼고 봐도)
      const red = await post('/api/pdf/redact-area', { name, rect: [0, 0, 12, 12], pages: '2' });
      assert.strictEqual(red.status, 200, JSON.stringify(red.body));
      assert.strictEqual(red.body.pages[0].images.painted, 1, '그림 픽셀을 칠했다');
      const doc2 = entryOf(name).doc, covers = doc2.objects(1).filter((o) => o.mask).map((o) => o.idx).sort((a, b) => b - a);
      const probe = await open(doc2.save());
      for (const k of covers) probe.removeObject(1, k);
      const rr = probe._renderRaw(1, 4), at = (x, y) => { const p = y * rr.stride + x * 4; return [rr.data[p], rr.data[p + 1], rr.data[p + 2]]; };
      assert.ok(at(20, 24).every((v) => v < 60), `가린 곳의 그림 픽셀은 검정으로 칠해졌다: ${at(20, 24)}`);
      assert.ok(at(80, 24)[1] > 150 && at(80, 24)[0] < 80, `가리지 않은 곳은 초록 그대로: ${at(80, 24)}`);
      probe.close();
      const empty = await post('/api/pdf/from-images', { images: [], merge: true });
      assert.strictEqual(empty.status, 400);
      const bad = await post('/api/pdf/from-images', { images: [{ path: file('사진/가짜.png', Buffer.from('nope')) }] });
      assert.deepStrictEqual([bad.status, /가짜\.png/.test(bad.body.error)], [400, true], '그림이 아닌 파일은 이름과 함께 400');
      await post('/api/pdf/close', { name });
      assert.ok(!fs.existsSync(path.dirname(name)), '합친 새 PDF도 닫으면 임시 폴더가 남지 않는다');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log('OK — v6.1 열 수 있는 파일(텍스트 인코딩 왕복·CRLF·20MB 상한·.markdown·그림 → PDF: PNG 투명·JPEG 그대로·BMP·EXIF 방향·줄이기·GIF/WebP 화면 디코드·합치기·새 PDF 저장 흐름·그림 가리기·스캔한 쪽) 검사 통과');
})().catch((e) => { console.error('FAIL', e); process.exitCode = 1; process.exit(1); });
