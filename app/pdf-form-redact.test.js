// 자체 검사: node app/pdf-form-redact.test.js
// v6: 양식 XObject 안 진짜 가리기 — 영역 가리기 · 개인정보 가리기 · 줄 가리기(덮개 밑 양식)가 양식 안 글자·그림 픽셀·도형까지 지우는지,
// 같은 양식을 쓰는 다른 배치·다른 쪽은 그대로인지, 저장 바이트(모든 스트림을 풀어서)에 지운 글이 남지 않는지, 실행 취소가 정확한지 검사한다.
// 시험 PDF는 여기서 만든다(pdf-test-fixtures buildFormXObjectPdf — 사용자 문서를 쓰지 않는다). 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더.
// 라우트 검사 포트 127.0.0.1:4987(사용자 앱의 4747은 쓰지 않는다). 파이썬(pypdf·PyMuPDF)이 있으면 독립 글자 추출 검사도 한다(없으면 건너뛴다)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'formredact-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
process.env.RETEXTPDF_NO_LISTEN = '1';
const PORT = 4987;
process.env.RETEXTPDF_PORT = String(PORT);

const { buildFormXObjectPdf, buildRawPdf } = require('./pdf-test-fixtures');
const { open } = require('./pdf-engine');
const { redactArea, redactRanges, maskParts, normalizeParts } = require('./pdf-edit-service');
const pii = require('./pii');
const rw = require('./pdf-rewrite');

const KR_FONT = 'C:\\Windows\\Fonts\\malgun.ttf';
const S = 2; // 렌더 배율
const count = (hay, needle) => { let n = 0; for (let k = hay.indexOf(needle); needle && k >= 0; k = hay.indexOf(needle, k + needle.length)) n++; return n; };
const squeeze = (s) => s.replace(/\s+/g, '');
const pageText = (d, i) => squeeze(d.pageChars(i).text);
// 쪽 글자에서 n번째(0부터) needle의 글자 사각형들을 감싼 상자(+pad)
function boxOf(d, i, needle, n = 0, pad = 2) {
  const { text, map } = d.pageChars(i);
  let at = -1;
  for (let k = 0; k <= n; k++) at = text.indexOf(needle, at + 1);
  assert.ok(at >= 0, `${i}쪽에 ${needle}(${n})`);
  const rr = d.charRangeRects(i, map[at], map[at + needle.length - 1] + 1);
  return { x0: Math.min(...rr.map((r) => r[0])) - pad, y0: Math.min(...rr.map((r) => r[1])) - pad, x1: Math.max(...rr.map((r) => r[2])) + pad, y1: Math.max(...rr.map((r) => r[3])) + pad };
}
// 렌더 픽셀 비교: box들(쪽 좌표, 2px 여유) 밖에서 채널 차가 tol 넘는 픽셀 수 · box 안(1px 안쪽) 픽셀 중 cover 색인 비율
const H_PAGE = 792;
const inBox = (x, y, b, m) => x >= (b.x0 * S) - m && x <= (b.x1 * S) + m && y >= (H_PAGE - b.y1) * S - m && y <= (H_PAGE - b.y0) * S + m;
function changedOutside(a, b, boxes, tol = 24) {
  let n = 0;
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    if (boxes.some((q) => inBox(x, y, q, 2))) continue;
    const p = y * a.stride + x * 4;
    if (Math.abs(a.data[p] - b.data[p]) > tol || Math.abs(a.data[p + 1] - b.data[p + 1]) > tol || Math.abs(a.data[p + 2] - b.data[p + 2]) > tol) n++;
  }
  return n;
}
function coverRatio(raw, box, color = [0, 0, 0]) {
  let n = 0, ok = 0;
  for (let y = Math.ceil((H_PAGE - box.y1) * S) + 1; y < Math.floor((H_PAGE - box.y0) * S) - 1; y++) for (let x = Math.ceil(box.x0 * S) + 1; x < Math.floor(box.x1 * S) - 1; x++) {
    const p = y * raw.stride + x * 4; n++;
    if (Math.abs(raw.data[p] - color[0]) + Math.abs(raw.data[p + 1] - color[1]) + Math.abs(raw.data[p + 2] - color[2]) < 30) ok++;
  }
  return n ? ok / n : 0;
}
const pixel = (raw, x, y) => { const p = Math.round((H_PAGE - y) * S) * raw.stride + Math.round(x * S) * 4; return [raw.data[p], raw.data[p + 1], raw.data[p + 2]]; };
// 저장 바이트의 스트림(풀 수 있는 것은 풀어서). pageIndex를 주면 그 쪽(내용·자원 — 안의 양식까지)에서 닿는 것만
function streamsOf(bytes, pageIndex = null) {
  const pdf = rw.parsePdf(bytes), out = [];
  const R = (v) => (v && v.t === 'ref' ? pdf.get(v.n) : v);
  const take = (v) => { try { out.push(rw.decodeStream(v, (r) => pdf.get(r.n))); } catch { out.push(v.data); } };
  if (pageIndex == null) { for (const n of pdf.nums) { const v = pdf.get(n); if (v && v.t === 'stream') take(v); } return out; }
  const pages = [];
  const visit = (node) => { node = R(node); if (!rw.isDict(node)) return; if (rw.nameOf(node.v.get('Type')) === 'Page') pages.push(node); else for (const k of R(node.v.get('Kids')) || []) visit(k); };
  visit(R(pdf.trailer.v.get('Root')).v.get('Pages'));
  const pg = pages[pageIndex];
  rw.walk(pdf, [pg.v.get('Contents'), pg.v.get('Resources')].filter(Boolean), (d, v) => { if (v.t === 'stream') take(v); });
  return out;
}
// 글자가 스트림에 남았나: 글자 그대로 · 16진(대·소문자) · (F1로 쓴 글이면) F1 글자 코드(바이트·16진 대·소문자). 전자우편은 F2(Helvetica)라 글자 그대로만
function leaks(streams, s, fx) {
  const forms = [Buffer.from(s, 'latin1'), Buffer.from(Buffer.from(s, 'latin1').toString('hex')), Buffer.from(Buffer.from(s, 'latin1').toString('hex').toUpperCase())];
  const h = s === fx.email ? null : fx.hex(s);
  if (h) forms.push(Buffer.from(h, 'hex'), Buffer.from(h), Buffer.from(h.toUpperCase()));
  return streams.some((d) => forms.some((f) => d.includes(f)));
}
const py = (name, lines, args) => {
  const script = path.join(DIR, name);
  fs.writeFileSync(script, lines.join('\n'));
  return spawnSync('python', ['-I', script, ...args], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
};

(async () => {
  const fx = buildFormXObjectPdf(KR_FONT);
  const T = fx.text;
  console.log(`  시험 PDF: 양식 X(글자·그림·투명 그림·도형·안 양식 2단) — 1쪽 두 배치, 2쪽 돌린 배치 (${fx.korean ? '한글' : '영문'} 글꼴)`);
  const pyFiles = {};

  // ── 1. 영역 가리기: 배치 A의 전화번호 → A에서만 지워지고 B·2쪽은 그대로 ─────────────────
  {
    const d = await open(fx.bytes);
    assert.strictEqual(count(pageText(d, 0), fx.phone), 2);
    assert.strictEqual(count(pageText(d, 1), fx.phone), 1);
    const r0 = [d._renderRaw(0, S), d._renderRaw(1, S)];
    const box = boxOf(d, 0, fx.phone, 0, 2);
    const r = redactArea(d, 0, box, { color: [0, 0, 0, 255] });
    assert.strictEqual(r.unmapped, 0, '양식 안 글자도 지웠다(덮기만 한 글자 없음)');
    assert.strictEqual(r.forms, 1, '배치 A 하나만 복사해 고쳤다');
    assert.deepStrictEqual(r.unsupported, []);
    assert.strictEqual(count(pageText(d, 0), fx.phone), 1, '1쪽: 배치 B의 번호는 남는다');
    assert.strictEqual(count(pageText(d, 1), fx.phone), 1, '2쪽(같은 양식)은 그대로');
    assert.strictEqual(count(pageText(d, 0), squeeze(T.phone.split(' ')[0])), 2, '영역 밖 글자(연락처)는 남는다');
    const r1 = [d._renderRaw(0, S), d._renderRaw(1, S)];
    assert.ok(coverRatio(r1[0], box) > 0.99, `영역 안은 덮개 색: ${coverRatio(r1[0], box)}`);
    assert.strictEqual(changedOutside(r0[0], r1[0], [box]), 0, '1쪽 영역 밖 픽셀은 그대로(배치 B 포함)');
    assert.strictEqual(changedOutside(r0[1], r1[1], []), 0, '2쪽은 한 픽셀도 안 바뀐다');

    // ── 2. 그림 픽셀: 불투명 그림 오른쪽 반 + 투명 그림 왼쪽 반(배치 A, 양식 좌표 x 30~75, y 4~36 → 쪽 +50, +560).
    //    영역 경계를 그림 픽셀 경계(5pt)에 맞춘다 — 걸친 픽셀은 통째로 칠하므로(가린 쪽이 안전) 경계가 어긋나면 픽셀 하나만큼 밖까지 칠해진다
    const box2 = { x0: 80, y0: 564, x1: 125, y1: 596 };
    const before2 = d._renderRaw(0, S);
    const corner = [50 + 88, 560 + 33]; // 투명 그림의 투명한 귀퉁이(영역 밖) — 밑의 빨강이 비쳐야 한다
    assert.ok(pixel(before2, ...corner)[0] > 200 && pixel(before2, ...corner)[1] < 60, `투명 귀퉁이는 빨강: ${pixel(before2, ...corner)}`);
    const r2 = redactArea(d, 0, box2, { color: [0, 0, 0, 255] });
    assert.strictEqual(r2.forms, 1); assert.strictEqual(r2.unmapped, 0);
    const after2 = d._renderRaw(0, S);
    assert.ok(coverRatio(after2, box2) > 0.99, `그림 영역 안은 덮개 색: ${coverRatio(after2, box2)}`);
    assert.strictEqual(changedOutside(before2, after2, [box2]), 0, '그림의 영역 밖 픽셀·투명은 그대로(무손실·SMask 유지)');
    assert.ok(pixel(after2, ...corner)[0] > 200 && pixel(after2, ...corner)[1] < 60, `칠한 뒤에도 투명 귀퉁이는 빨강: ${pixel(after2, ...corner)}`);

    // ── 3. 깊이 3: 배치 B 안 양식 D의 글자 ──
    const box3 = boxOf(d, 0, 'DEEP99', 1, 1.5);
    const before3 = d._renderRaw(0, S);
    const r3 = redactArea(d, 0, box3, { color: [0, 0, 0, 255] });
    assert.strictEqual(r3.unmapped, 0, '깊이 3 양식 안 글자도 지웠다');
    assert.strictEqual(count(pageText(d, 0), 'DEEP99'), 1, '배치 B의 DEEP99만 지워졌다');
    assert.strictEqual(count(pageText(d, 0), 'SECRET77'), 2, '같은 양식의 다른 글자는 그대로');
    assert.strictEqual(changedOutside(before3, d._renderRaw(0, S), [box3]), 0, '깊은 양식 가리기: 영역 밖은 그대로');

    // ── 4. 돌리고 키운 배치(2쪽 C): 전화번호 영역 ──
    const box4 = boxOf(d, 1, fx.phone, 0, 2);
    assert.ok(box4.y1 - box4.y0 > box4.x1 - box4.x0, '2쪽 번호는 세로로 놓였다(90° 배치)');
    const before4 = d._renderRaw(1, S), p0before = d._renderRaw(0, S);
    const r4 = redactArea(d, 1, box4, { color: [0, 0, 0, 255] });
    assert.strictEqual(r4.unmapped, 0); assert.strictEqual(r4.forms, 1);
    assert.strictEqual(count(pageText(d, 1), fx.phone), 0, '2쪽 번호가 지워졌다');
    const after4 = d._renderRaw(1, S);
    assert.ok(coverRatio(after4, box4) > 0.99, `돌린 배치 영역 안은 덮개 색: ${coverRatio(after4, box4)}`);
    assert.strictEqual(changedOutside(before4, after4, [box4]), 0, '돌린 배치: 영역 밖은 그대로');
    assert.strictEqual(changedOutside(p0before, d._renderRaw(0, S), []), 0, '1쪽은 안 바뀐다');

    // ── 5. 저장 바이트: 2쪽에서 닿는 스트림에는 번호가 없고, 1쪽(배치 B)에는 있다. 고아가 된 원본은 다시 쓰기에서 빠진다 ──
    const saved = rw.writePdf(rw.parsePdf(d.save()), { dedupe: 'streams' });
    assert.ok(!leaks(streamsOf(saved, 1), fx.phone, fx), '2쪽에서 닿는 스트림에 지운 번호가 없다');
    assert.ok(leaks(streamsOf(saved, 0), fx.phone, fx), '1쪽 배치 B의 번호는 남아 있다(가리지 않은 배치)');
    const e = await open(saved);
    assert.strictEqual(count(pageText(e, 0), fx.phone), 1); assert.strictEqual(count(pageText(e, 1), fx.phone), 0);
    assert.strictEqual(count(pageText(e, 0), 'DEEP99'), 1);
    assert.strictEqual(changedOutside(d._renderRaw(0, S), e._renderRaw(0, S), [], 24), 0, '저장·다시 열어도 그림이 같다');
    fs.writeFileSync((pyFiles.area = path.join(DIR, 'area.pdf')), saved);
    e.close(); d.close();
    console.log('  영역 가리기(배치 하나만 복사·깊이 3·그림 픽셀·투명 유지·돌린 배치·저장 바이트) 통과');
  }

  // ── 6. 개인정보 가리기(모든 쪽): 양식 안 전화번호·전자우편이 모든 배치에서 사라지고 파일 어디에도 남지 않는다 ──────────
  {
    const d = await open(fx.bytes);
    let found = 0;
    for (let i = 0; i < d.pageCount; i++) {
      const { text, map } = d.pageChars(i);
      const hits = pii.findPii(text, { kinds: ['phone', 'email'] });
      found += hits.length;
      const r = redactRanges(d, i, hits.map((h) => [map[h.start], map[h.end - 1] + 1]), { color: [0, 0, 0, 255] });
      assert.strictEqual(r.unmapped, 0, `${i + 1}쪽: 덮기만 한 글자 없음`);
      assert.strictEqual(r.forms, i === 0 ? 2 : 1, `${i + 1}쪽 배치 수만큼 복사`);
    }
    assert.strictEqual(found, 6, '전화번호 3 + 전자우편 3(1쪽 배치 둘, 2쪽 배치 하나)');
    for (let i = 0; i < d.pageCount; i++) {
      const t = pageText(d, i);
      assert.strictEqual(pii.findPii(d.pageChars(i).text, { kinds: ['phone', 'email'] }).length, 0, `${i + 1}쪽에 개인정보가 남지 않는다`);
      assert.ok(t.includes('SECRET77') && t.includes('DEEP99') && t.includes(squeeze(T.phone.split(' ')[0])), '개인정보가 아닌 글은 남는다');
    }
    const saved = rw.writePdf(rw.parsePdf(d.save()), { dedupe: 'streams' });
    const all = streamsOf(saved);
    assert.ok(!leaks(all, fx.email, fx) && !leaks(all, fx.phone, fx), '저장 바이트(모든 스트림을 풀어서)에 전화번호·전자우편이 없다');
    assert.ok(saved.length < fx.bytes.length * 3, `복사한 글꼴 파일은 하나로 합친다(${fx.bytes.length} → ${saved.length})`);
    const e = await open(saved);
    for (let i = 0; i < e.pageCount; i++) assert.strictEqual(pii.findPii(e.pageChars(i).text, { kinds: ['phone', 'email'] }).length, 0, `다시 열어도 ${i + 1}쪽에 없다`);
    e.close(); d.close();
    fs.writeFileSync((pyFiles.pii = path.join(DIR, 'pii.pdf')), saved);
    console.log('  개인정보 가리기(양식 안 · 모든 배치 · 저장 바이트) 통과');
  }

  // ── 7. 쪽에 바로 놓인 투명 그림을 일부 가려도 투명이 남는다(예전: 불투명 JPEG) ───────────────────
  {
    const zlib = require('zlib');
    const ia = Buffer.alloc(6 * 6 * 3), sm = Buffer.alloc(36);
    for (let k = 0; k < 36; k++) { ia.set([0, 160, 0], k * 3); const x = k % 6, y = (k / 6) | 0; sm[k] = (x - 2.5) ** 2 + (y - 2.5) ** 2 <= 6.5 ? 255 : 0; }
    const c = '1 0 0 rg 100 100 120 120 re f q 120 0 0 120 100 100 cm /Ia Do Q';
    const bytes = buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Ia 5 0 R >> >> /Contents 4 0 R >>',
      { dict: `<< /Length ${c.length} >>`, data: Buffer.from(c, 'latin1') },
      { dict: `<< /Type /XObject /Subtype /Image /Width 6 /Height 6 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 6 0 R /Filter /FlateDecode /Length ${zlib.deflateSync(ia).length} >>`, data: zlib.deflateSync(ia) },
      { dict: `<< /Type /XObject /Subtype /Image /Width 6 /Height 6 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${zlib.deflateSync(sm).length} >>`, data: zlib.deflateSync(sm) },
    ]);
    const d = await open(bytes);
    const before = d._renderRaw(0, S), box = { x0: 100, y0: 100, x1: 160, y1: 220 };
    const r = redactArea(d, 0, box, { color: [0, 0, 0, 255] });
    assert.strictEqual(r.images.painted, 1);
    const after = d._renderRaw(0, S);
    assert.strictEqual(changedOutside(before, after, [box]), 0, '투명 그림의 영역 밖(투명 귀퉁이 포함)은 그대로');
    assert.ok(pixel(after, 215, 215)[0] > 200 && pixel(after, 215, 215)[1] < 60, `투명 귀퉁이로 밑 빨강이 보인다: ${pixel(after, 215, 215)}`);
    const e = await open(d.save());
    assert.strictEqual(changedOutside(after, e._renderRaw(0, S), []), 0, '저장 뒤에도 투명(SMask)이 남는다');
    e.close(); d.close();
    console.log('  쪽 수준 투명 그림 일부 가리기 — 투명 유지 통과');
  }

  // ── 8. 줄 가리기(maskParts): 쪽 글자 줄 밑에 깔린 양식 글자도 지운다 ───────────────────────
  {
    const fc = 'BT /F1 12 Tf 0 2 Td (UNDER-SECRET-42) Tj ET';
    const c = 'q 1 0 0 1 100 500 cm /U Do Q BT /F1 12 Tf 100 502 Td (Visible line text) Tj ET';
    const bytes = buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> /XObject << /U 5 0 R >> >> /Contents 4 0 R >>',
      { dict: `<< /Length ${c.length} >>`, data: Buffer.from(c, 'latin1') },
      { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources << /Font << /F1 6 0 R >> >> /Length ${fc.length} >>`, data: Buffer.from(fc, 'latin1') },
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ]);
    const d = await open(bytes);
    const objs = d.objects(0), line = objs.findIndex((o) => o.type === 'text' && /Visible/.test(o.text));
    const r = maskParts(d, 0, normalizeParts([{ idx: line, from: 0, to: objs[line].text.length }]), { color: [0, 0, 0, 255] });
    assert.ok(r.ok && r.forms === 1, JSON.stringify({ ok: r.ok, forms: r.forms }));
    const t = pageText(d, 0);
    assert.ok(!t.includes('Visible') && !t.includes('UNDER-SECRET-42'), `덮개 밑 양식 글자도 사라진다: ${t}`);
    d.close();
    console.log('  줄 가리기 — 덮개 밑 양식 글자 통과');
  }

  // ── 8b. 양식 안 인라인 그림(BI)은 칠하고, 걸친 셰이딩(sh)은 잘라 내지 못해 unsupported로 알린다 · 'auto' 색 ─────────
  {
    const xc = [
      '0.9 0.9 0.6 rg 0 0 200 100 re f',
      'q 40 0 0 40 10 10 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID \xff\x00\x00\x00\xff\x00\x00\x00\xff\xff\xff\x00 EI Q',
      'q 60 10 60 40 re W n /Sh0 sh Q',
      'BT /F1 10 Tf 10 70 Td (INLINE-SECRET-1) Tj ET',
    ].join('\n');
    const res = '/Font << /F1 6 0 R >> /Shading << /Sh0 << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [60 0 120 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >> >>';
    const c = 'q 1 0 0 1 100 400 cm /X Do Q';
    const bytes = buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /X 5 0 R >> >> /Contents 4 0 R >>',
      { dict: `<< /Length ${c.length} >>`, data: Buffer.from(c, 'latin1') },
      { dict: `<< /Type /XObject /Subtype /Form /BBox [0 0 200 100] /Resources << ${res} >> /Length ${Buffer.byteLength(xc, 'latin1')} >>`, data: Buffer.from(xc, 'latin1') },
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]);
    const d = await open(bytes);
    const box = { x0: 130, y0: 405, x1: 175, y1: 485 }; // 양식 x 30~75: 인라인 그림 오른쪽 반 · 셰이딩 왼쪽 일부 · 비밀 글자 가운데
    const r = redactArea(d, 0, box, { color: 'auto' });
    assert.ok(r.forms === 1 && r.images.painted === 1 && r.unmapped === 0, JSON.stringify(r));
    assert.deepStrictEqual(r.unsupported, [{ reason: 'shading', count: 1 }], '걸친 셰이딩은 덮개 밑에 남는다고 알린다');
    assert.ok(!pageText(d, 0).includes('SECRET'), `영역 안 글자는 지운다: ${pageText(d, 0)}`);
    const saved = rw.writePdf(rw.parsePdf(d.save()), { dedupe: 'streams' });
    assert.ok(!streamsOf(saved).some((s) => s.includes(Buffer.from('SECRET'))), '저장 바이트에도 없다');
    d.close();
    console.log('  양식 안 인라인 그림·걸친 셰이딩 알림·자동 색 통과');
  }

  // ── 9. 라우트(진짜 PDFium): 영역 가리기 응답 · 실행 취소가 정확히 되돌린다 · 개인정보 가리기 라우트 ─────────────
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
  try {
    const name = path.join(DIR, '양식가리기.pdf');
    fs.writeFileSync(name, fx.bytes);
    const ref = await open(fx.bytes);
    const box = boxOf(ref, 0, fx.phone, 0, 2);
    const orig = [ref._renderRaw(0, S), ref._renderRaw(1, S)], origText = [pageText(ref, 0), pageText(ref, 1)];
    ref.close();
    let r = await post('/api/pdf/redact-area', { name, rect: [box.x0, box.y0, box.x1, box.y1], pages: '1' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.pages[0].unmapped, r.body.pages[0].forms, r.body.pages[0].unsupported], [0, 1, []], JSON.stringify(r.body.pages));
    assert.ok(r.body.compacted, '다시 쓰기(고아 원본 버리기)');
    const live = () => pdfDocs[Object.keys(pdfDocs).find((k) => path.resolve(k) === path.resolve(name)) || name]?.doc || Object.values(pdfDocs)[0].doc;
    assert.strictEqual(count(pageText(live(), 0), fx.phone), 1);
    r = await post('/api/pdf/undo', { name });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    assert.deepStrictEqual([pageText(live(), 0), pageText(live(), 1)], origText, '실행 취소: 글자가 정확히 돌아온다');
    assert.strictEqual(changedOutside(orig[0], live()._renderRaw(0, S), [], 0), 0, '실행 취소: 1쪽 픽셀이 정확히 같다');
    assert.strictEqual(changedOutside(orig[1], live()._renderRaw(1, S), [], 0), 0, '실행 취소: 2쪽 픽셀이 정확히 같다');
    // 개인정보 라우트: 찾기 → 모두 가리기
    r = await post('/api/pdf/pii/find', { name, kinds: ['phone', 'email'] });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const matches = r.body.matches;
    assert.strictEqual(matches.length, 6, '1쪽 번호 2·우편 2, 2쪽 번호 1·우편 1: ' + matches.map((m) => m.text).join(','));
    r = await post('/api/pdf/pii/redact', { name, matches });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual([r.body.redacted, r.body.failed.length], [matches.length, 0], JSON.stringify(r.body.failed));
    assert.ok(r.body.pages.every((p) => p.unmapped === 0 && p.forms >= 1), JSON.stringify(r.body.pages));
    const all = streamsOf(live().save());
    assert.ok(!leaks(all, fx.email, fx) && !leaks(all, fx.phone, fx), '라우트 결과 바이트에도 남지 않는다(고아 원본까지)');
    console.log('  라우트(영역 가리기 응답·실행 취소 픽셀 일치·개인정보 가리기) 통과');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const k of Object.keys(pdfDocs)) { try { pdfDocs[k].doc.close(); } catch {} delete pdfDocs[k]; }
  }

  // ── 10. 파이썬 독립 검사(있으면): pypdf·PyMuPDF로 글자를 뽑아 지운 글이 없는지 ─────────────
  {
    const p = py('extract.py', [
      'import sys, json', 'out = {}',
      'from pypdf import PdfReader',
      'out["pypdf"] = {k: [pg.extract_text() for pg in PdfReader(f).pages] for k, f in zip(["area", "pii"], sys.argv[1:3])}',
      'import fitz',
      'out["fitz"] = {k: [pg.get_text() for pg in fitz.open(f)] for k, f in zip(["area", "pii"], sys.argv[1:3])}',
      'print(json.dumps(out))',
    ], [pyFiles.area, pyFiles.pii]);
    if (p.status === 0) {
      const o = JSON.parse(p.stdout);
      for (const lib of ['pypdf', 'fitz']) {
        const area = o[lib].area.map(squeeze), piiT = o[lib].pii.map(squeeze);
        assert.strictEqual(count(area[0], fx.phone), 1, `${lib}: 영역 가리기 1쪽 번호 하나(배치 B) — ${area[0]}`);
        assert.strictEqual(count(area[1], fx.phone), 0, `${lib}: 영역 가리기 2쪽 번호 없음`);
        assert.ok(piiT.every((t) => !t.includes(fx.phone) && !t.includes(fx.email)), `${lib}: 개인정보 가리기 결과에 없음`);
        assert.ok(piiT[0].includes('SECRET77'), `${lib}: 다른 글은 남는다`);
      }
      console.log('  pypdf·PyMuPDF 독립 검사 통과');
    } else console.log('  파이썬 검사 건너뜀:', (p.stderr || p.error?.message || '').split('\n').slice(-2).join(' '));
  }

  if (!process.exitCode) fs.rmSync(DIR, { recursive: true, force: true });
  console.log('pdf-form-redact.test.js 통과');
})().catch((e) => { console.error(e); process.exitCode = 1; });
