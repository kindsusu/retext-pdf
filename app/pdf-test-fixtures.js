// 시험용 PDF 만들기 (pdf-engine.test.js · server.test.js 공용). 사용자 문서 대신 테스트가 직접 바이트를 만든다
//   buildPdf({ pages:[{ w, h, content, extra }], encrypt? }) → Buffer
//   encrypt: { user, owner, P } — 표준 보안 처리기 R4 / AESV2(AES-128) 로 콘텐츠 스트림을 암호화한다.
//   PDFium은 암호화를 못 하므로 PDF 1.7 규격(7.6.3 알고리즘 1·2·3·5)을 node:crypto로 직접 구현했다.
//   RC4는 OpenSSL 3에서 기본 제공자가 아니라(createCipheriv('rc4') 실패) 순수 JS로 둔다 — O·U 계산에만 쓴다
const crypto = require('crypto');

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts) => crypto.createHash('md5').update(Buffer.concat(parts)).digest();
const pad = (pw) => Buffer.concat([Buffer.from(pw || '', 'latin1'), PAD]).subarray(0, 32);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
// R3 이상: 키의 각 바이트를 1..19와 XOR한 키로 19번 더 돌린다
const rc4x20 = (key, data) => { let d = rc4(key, data); for (let i = 1; i <= 19; i++) d = rc4(Buffer.from(key.map((b) => b ^ i)), d); return d; };

// 알고리즘 3(O) · 2(파일 키) · 5(U). 키 길이 16바이트(128비트), R4
function standardSecurity({ user = '', owner = '', P = -4 }, id0) {
  let h = md5(pad(owner || user));
  for (let k = 0; k < 50; k++) h = md5(h);
  const O = rc4x20(h, pad(user));
  const p = Buffer.alloc(4); p.writeInt32LE(P);
  let key = md5(pad(user), O, p, id0);
  for (let k = 0; k < 50; k++) key = md5(key);
  const U = Buffer.concat([rc4x20(key, md5(PAD, id0)), Buffer.alloc(16)]);
  return { key, O, U, P };
}
// 알고리즘 1 + AESV2: 객체 키 = MD5(파일 키 + 객체 번호 3바이트 + 세대 2바이트 + "sAlT"), 앞에 IV 16바이트를 붙인 AES-128-CBC(PKCS#7)
function aesObject(key, num, data) {
  const ok = md5(key, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]), Buffer.from('sAlT'));
  const iv = crypto.randomBytes(16), c = crypto.createCipheriv('aes-128-cbc', ok, iv);
  return Buffer.concat([iv, c.update(data), c.final()]);
}

// 여러 쪽짜리 PDF. 글꼴 F1 = Helvetica. page.extra: 쪽 사전에 더할 항목(/Rotate, /CropBox 등)
function buildPdf({ pages = [{}], encrypt = null } = {}) {
  const id0 = crypto.randomBytes(16);
  const sec = encrypt ? standardSecurity(encrypt, id0) : null;
  const objs = []; // { body: Buffer|string, stream?: Buffer }
  const add = (o) => { objs.push(o); return objs.length; };
  const catalog = add(null), tree = add(null), font = add({ body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  const kids = pages.map((pg, k) => {
    const content = Buffer.from(pg.content ?? `BT /F1 24 Tf 40 40 Td (Page ${k + 1}) Tj ET`, 'latin1');
    const cnum = add({ stream: content });
    return add({ body: `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${pg.w || 400} ${pg.h || 400}] ${pg.extra || ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${cnum} 0 R >>` });
  });
  objs[catalog - 1] = { body: `<< /Type /Catalog /Pages ${tree} 0 R >>` };
  objs[tree - 1] = { body: `<< /Type /Pages /Kids [${kids.map((n) => `${n} 0 R`).join(' ')}] /Count ${kids.length} >>` };
  const enc = sec ? add({ body: `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${sec.O.toString('hex')}> /U <${sec.U.toString('hex')}> /P ${sec.P} >>` }) : 0;
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0].length; const offs = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objs.forEach((o, k) => {
    offs.push(size);
    if (o.stream) {
      const data = sec ? aesObject(sec.key, k + 1, o.stream) : o.stream;
      push(Buffer.from(`${k + 1} 0 obj\n<< /Length ${data.length} >>\nstream\n`, 'latin1')); push(data); push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else push(Buffer.from(`${k + 1} 0 obj\n${o.body}\nendobj\n`, 'latin1'));
  });
  const xref = size, idHex = id0.toString('hex');
  push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /ID [<${idHex}> <${idHex}>]${enc ? ` /Encrypt ${enc} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 투명 PNG 만들기(도장 시험용): rgba(x, y) → [r,g,b,a]. 필터 0, 비인터레이스, 8비트 RGBA
function makePng(w, h, rgba) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); len.writeUInt32BE(data.length); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// 객체 스트림(/Type /ObjStm) + xref 스트림(Flate + PNG 예측기 12) 로 쓴 PDF. 스트림이 아닌 객체(카탈로그·쪽·글꼴·Info)는 모두 객체 스트림 안에 든다
//   pages: [{ text, w, h }], title: Info /Title(리터럴 문자열 그대로)
function buildObjStmPdf({ pages = [{}], title = 'ObjStm sample' } = {}) {
  const zlib = require('zlib');
  const inner = [], streams = []; // inner: [번호, 본문] / streams: [번호, 데이터]
  let next = 1;
  const catalog = next++, tree = next++, font = next++, info = next++;
  const kids = pages.map((pg, k) => {
    const c = next++, p = next++;
    streams.push([c, Buffer.from(`BT /F1 20 Tf 30 30 Td (${pg.text ?? `ObjStm page ${k + 1}`}) Tj ET`, 'latin1')]);
    inner.push([p, `<</Type/Page/Parent ${tree} 0 R/MediaBox[0 0 ${pg.w || 300} ${pg.h || 200}]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${c} 0 R>>`]);
    return p;
  });
  inner.unshift([catalog, `<</Type/Catalog/Pages ${tree} 0 R>>`], [tree, `<</Type/Pages/Kids[${kids.map((n) => `${n} 0 R`).join(' ')}]/Count ${kids.length}>>`],
    [font, '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'], [info, `<</Title (${title})/Producer (fixture)>>`]);
  const stm = next++, xrefNum = next++;
  let body = '', header = '';
  for (const [n, b] of inner) { header += `${n} ${body.length} `; body += b + '\n'; }
  const objData = zlib.deflateSync(Buffer.from(header + body, 'latin1'));
  const parts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0].length;
  const push = (b) => { parts.push(b); size += b.length; };
  const entries = new Map(); // 번호 → [종류, 필드2, 필드3]
  for (const [n, data] of streams) {
    entries.set(n, [1, size, 0]);
    push(Buffer.from(`${n} 0 obj\n<</Length ${data.length}>>stream\n`, 'latin1')); push(data); push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  }
  entries.set(stm, [1, size, 0]);
  push(Buffer.from(`${stm} 0 obj\n<</Type/ObjStm/N ${inner.length}/First ${header.length}/Filter/FlateDecode/Length ${objData.length}>>stream\n`, 'latin1')); push(objData); push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
  inner.forEach(([n], k) => entries.set(n, [2, stm, k]));
  entries.set(xrefNum, [1, size, 0]);
  // xref 스트림 행: 1 + 4 + 2 바이트, PNG Up(2) 예측
  const rows = [];
  let prev = Buffer.alloc(7);
  for (let n = 0; n < next; n++) {
    const [t, f2, f3] = entries.get(n) || [0, 0, n === 0 ? 65535 : 0];
    const row = Buffer.alloc(7); row[0] = t; row.writeUInt32BE(f2, 1); row.writeUInt16BE(f3, 5);
    rows.push(Buffer.concat([Buffer.from([2]), Buffer.from(row.map((v, i) => (v - prev[i]) & 255))]));
    prev = row;
  }
  const xdata = zlib.deflateSync(Buffer.concat(rows)), xoff = size;
  push(Buffer.from(`${xrefNum} 0 obj\n<</Type/XRef/Size ${next}/W[1 4 2]/Root ${catalog} 0 R/Info ${info} 0 R/Filter/FlateDecode/DecodeParms<</Predictor 12/Columns 7>>/Length ${xdata.length}>>stream\n`, 'latin1'));
  push(xdata); push(Buffer.from(`\nendstream\nendobj\nstartxref\n${xoff}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 증분 저장 한 번을 덧붙인다(고전 xref 표 + /Prev). objs: [{ n, body } | { n, stream }], root·size: 트레일러 값
function appendUpdate(base, { objs, root, size }) {
  const prev = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(base.latin1Slice(Math.max(0, base.length - 64)))[1]);
  const parts = [base, Buffer.from('\n')];
  let at = base.length + 1;
  const push = (b) => { parts.push(b); at += b.length; };
  const offs = [];
  for (const o of objs) {
    offs.push([o.n, at]);
    if (o.stream) { const d = Buffer.from(o.stream, 'latin1'); push(Buffer.from(`${o.n} 0 obj\n<< /Length ${d.length} >>\nstream\n`, 'latin1')); push(d); push(Buffer.from('\nendstream\nendobj\n', 'latin1')); }
    else push(Buffer.from(`${o.n} 0 obj\n${o.body}\nendobj\n`, 'latin1'));
  }
  const xref = at;
  push(Buffer.from('xref\n' + offs.map(([n, off]) => `${n} 1\n${String(off).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${size} /Root ${root} 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 파서가 까다로워하는 문법을 모은 한 쪽 PDF: 주석 · 이름의 #xx · 리터럴 문자열 이스케이프(괄호 짝·\ddd·줄 이음·\r\n) · 16진 문자열 ·
// 간접 /Length · 틀린 /Length · 줄 끝 CRLF · 이진 데이터(CR·LF가 섞인 비압축 이미지)
function buildTrickyPdf() {
  const c1 = 'BT /F1 18 Tf 20 150 Td (Tricky \\(text\\)) Tj ET q 60 0 0 60 200 100 cm /Im#31 Do Q';
  const c2 = 'BT /F1 12 Tf 20 50 Td (Second) Tj ET';
  const img = Buffer.from([255, 0, 0, 13, 10, 13, 0, 0, 255, 10, 13, 10]); // 2×2 RGB, 줄 끝 바이트가 섞인 이진 데이터
  const objs = [
    '<< /Type /Catalog % 주석\r\n /Pages 2 0 R /PageLabels << /Nums [0 << /P (A\\)\\(b\\\\) >>] >> >>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F#31 5 0 R >> /XObject << /Im1 9 0 R >> >> /Contents [4 0 R 8 0 R] >>',
    { dict: '<< /Length 6 0 R >>', data: Buffer.from(c1, 'latin1') },
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>',
    String(Buffer.byteLength(c1, 'latin1')),
    '<< /Title (Caf\\351 \\(nested (ok)\\) \\\\ back\\\nslash\\101) /Author <FEFF0048 0069> /Subject (line1\\r\\nline2) >>',
    { dict: '<< /Length 3 >>', data: Buffer.from(c2, 'latin1') }, // 틀린 길이 → endstream을 찾아야 한다
    { dict: `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.length} >>`, data: img },
  ];
  const parts = [Buffer.from('%PDF-1.4\r\n%\xe2\xe3\xcf\xd3\r\n% 머리 주석\r\n', 'latin1')];
  let size = parts[0].length; const offs = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objs.forEach((o, k) => {
    offs.push(size);
    if (typeof o === 'string') push(Buffer.from(`${k + 1} 0 obj % 주석\r\n${o}\r\nendobj\r\n`, 'latin1'));
    else { push(Buffer.from(`${k + 1} 0 obj\r\n${o.dict}\r\nstream\r\n`, 'latin1')); push(o.data); push(Buffer.from('\r\nendstream\r\nendobj\r\n', 'latin1')); }
  });
  const xref = size;
  push(Buffer.from(`xref\r\n0 ${objs.length + 1}\r\n0000000000 65535 f\r\n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n\r\n').join('')
    + `trailer\r\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\r\nstartxref\r\n${xref}\r\n%%EOF\r\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 객체 본문 목록으로 PDF 한 벌(고전 xref). objs[k]는 k+1번 객체: 문자열(사전 등) 또는 { dict, data }(스트림 — /Length는 dict 안에 직접 쓴다).
// trailer: 트레일러에 더할 항목(예: '/Info 19 0 R'). 카탈로그는 1번
function buildRawPdf(objs, trailer = '') {
  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let size = parts[0].length; const offs = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objs.forEach((o, k) => {
    offs.push(size);
    if (typeof o === 'string') push(Buffer.from(`${k + 1} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else { push(Buffer.from(`${k + 1} 0 obj\n${o.dict}\nstream\n`, 'latin1')); push(o.data); push(Buffer.from('\nendstream\nendobj\n', 'latin1')); }
  });
  const xref = size;
  push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 숨은 데이터가 골고루 든 한 쪽 PDF(숨은 데이터 지우기 시험용). 지워져야 할 표지 글자:
//   InfoSECRET(/Info) · XMPSECRET(카탈로그 /Metadata) · PAGEXMP(쪽 /Metadata) · JSSECRET(이름 트리 /JavaScript) · JSOPEN(/OpenAction)
//   AASECRET(카탈로그 /AA) · LINKJS(링크 주석의 /A 자바스크립트) · ATTACHSECRET(첨부 파일 내용) · NOTESECRET(메모 주석) · CHAPTERSECRET(목차 제목)
// 남아야 할 것: 쪽 글자 'Hidden data sample', 링크 주석 자체(/Link), URI 링크 동작(KEEPURI)
function buildHiddenDataPdf() {
  const xmp = Buffer.from('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:title>XMPSECRET</dc:title></x:xmpmeta><?xpacket end="w"?>', 'latin1');
  const pageXmp = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/">PAGEXMP</x:xmpmeta>', 'latin1');
  const content = Buffer.from('BT /F1 24 Tf 40 300 Td (Hidden data sample) Tj ET', 'latin1');
  const attach = Buffer.from('ATTACHSECRET file body', 'latin1');
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R /Metadata 6 0 R /Names << /JavaScript 7 0 R /EmbeddedFiles 9 0 R >> /OpenAction 11 0 R /Outlines 12 0 R /PageMode /UseOutlines /AA << /WC 20 0 R >> >>', // 1
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', // 2
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Metadata 21 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [14 0 R 15 0 R 16 0 R 22 0 R] >>', // 3
    { dict: `<< /Length ${content.length} >>`, data: content }, // 4
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', // 5
    { dict: `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>`, data: xmp }, // 6
    '<< /Names [(init) 8 0 R] >>', // 7
    "<< /S /JavaScript /JS (app.alert\\('JSSECRET'\\);) >>", // 8
    '<< /Names [(secret.txt) 10 0 R] >>', // 9
    '<< /Type /Filespec /F (secret.txt) /UF (secret.txt) /EF << /F 17 0 R >> >>', // 10
    '<< /S /JavaScript /JS (JSOPEN) >>', // 11
    '<< /Type /Outlines /First 13 0 R /Last 13 0 R /Count 1 >>', // 12
    '<< /Title (CHAPTERSECRET) /Parent 12 0 R /Dest [3 0 R /XYZ 0 400 0] >>', // 13
    '<< /Type /Annot /Subtype /Text /Rect [10 10 30 30] /Contents (NOTESECRET) /F 4 >>', // 14
    '<< /Type /Annot /Subtype /Link /Rect [50 50 100 70] /Border [0 0 0] /A 18 0 R >>', // 15
    '<< /Type /Annot /Subtype /FileAttachment /Rect [120 10 140 30] /FS 10 0 R /Contents (attachment) >>', // 16
    { dict: `<< /Type /EmbeddedFile /Length ${attach.length} >>`, data: attach }, // 17
    '<< /S /JavaScript /JS (LINKJS) >>', // 18
    '<< /Title (InfoSECRET) /Author (Someone) /Producer (fixture) >>', // 19
    '<< /S /JavaScript /JS (AASECRET) >>', // 20
    { dict: `<< /Type /Metadata /Subtype /XML /Length ${pageXmp.length} >>`, data: pageXmp }, // 21
    '<< /Type /Annot /Subtype /Link /Rect [150 50 200 70] /Border [0 0 0] /A << /S /URI /URI (https://example.com/KEEPURI) >> >>', // 22
  ], '/Info 19 0 R');
}

// 줄 묶기 말뭉치(tmp/grouping 15~20번)의 원시 내용 스트림 PDF — Word·엑셀·한글이 만드는 객체 구조를 손으로 쓴 것.
// 기대 상자는 app/grouping-corpus.test.js. 반환: { '15-tj-kerning': Buffer, … } (A5 가로 595×420, 회색 7pt 설명 줄 포함)
function buildGroupingRawPdfs() {
  // Helvetica AFM 폭(1/1000 em)
  const W = { ' ': 278, '.': 278, ',': 278, ':': 278, '-': 333, '%': 889, '(': 333, ')': 333 };
  '0123456789'.split('').forEach((c) => (W[c] = 556));
  Object.assign(W, { a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
    A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611 });
  const wid = (s, size) => [...s].reduce((t, c) => t + (W[c] || 556), 0) / 1000 * size;
  const esc = (s) => s.replace(/([()\\])/g, '\\$1');
  const label = (txt, y) => `BT /F4 7 Tf 0.53 0.53 0.53 rg 20 ${y} Td (${esc(txt)}) Tj ET 0 0 0 rg\n`;
  const tj = (font, size, x, y, s, extra = '') => `BT /${font} ${size} Tf ${extra} 1 0 0 1 ${x.toFixed(2)} ${y} Tm (${esc(s)}) Tj ET\n`;
  const pdf = (content) => {
    const data = Buffer.from(content, 'latin1');
    return buildRawPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 420] /Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R /F4 8 0 R >> >> /Contents 4 0 R >>',
      { dict: `<< /Length ${data.length} >>`, data },
      '<< /Type /Font /Subtype /Type1 /BaseFont /ABCDEF+Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /GHIJKL+Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    ]);
  };
  // 한 줄의 조각들: [[글, 뒤 틈(em)]] — 조각마다 BT/ET(Tj), 틈 = 진행 폭 뒤에 더 띄우는 간격
  const frags = (font, size, x, y, parts, extra = '') => {
    let s = '', cx = x;
    for (const [t, gapEm = 0] of parts) { s += tj(font, size, cx, y, t, extra); cx += wid(t, size) + gapEm * size; }
    return s;
  };
  const out = {};
  out['15-tj-kerning'] = pdf(label('15a TJ [(Hel) 20 (lo) -250 (World)] - kerning number acts as space', 395)
    + 'BT /F1 14 Tf 40 375 Td [(Hel) 20 (lo) -250 (World)] TJ ET\n'
    + label('15b Word-like TJ, -278 = space width, no space glyph', 345)
    + 'BT /F1 14 Tf 40 325 Td [(T) 80 (o) -15 (tal) -278 (amount) -278 (due) -278 (today)] TJ ET\n'
    + label('15c positive kerning tightens one word', 295)
    + 'BT /F1 14 Tf 40 275 Td [(A) 120 (V) 120 (A) 120 (T) 60 (AR)] TJ ET\n'
    + label('15d one TJ with -4000 jump = two fields inside one object', 245)
    + 'BT /F1 14 Tf 40 225 Td [(Left field) -4000 (Right field)] TJ ET\n'
    + label('15e each word its own TJ, Word-style split at kerning', 195)
    + frags('F1', 14, 40, 175, [['Each', 0.278], ['word', 0.278], ['separate', 0]]));
  out['16-space-vs-gap'] = pdf(label('16a explicit space glyph in one object', 395) + tj('F1', 14, 40, 375, 'Hello World')
    + label('16b two objects, gap = 0.28em, no space glyph', 345) + frags('F1', 14, 40, 325, [['Hello', 0.28], ['World']])
    + label('16c trailing-space object + space-only object + word', 295) + frags('F1', 14, 40, 275, [['Hello ', 0], [' ', 0], ['World']])
    + label('16d gap 0.55em without space glyph (wide word gap)', 245) + frags('F1', 14, 40, 225, [['Two', 0.55], ['words']])
    + label('16e gap 0.65em without space glyph (should still be one line)', 195) + frags('F1', 14, 40, 175, [['Loose', 0.65], ['spacing']])
    + label('16f per-glyph objects (Chromium/HWP style) with word gap 0.28em', 145)
    + frags('F1', 14, 40, 125, [...'Eac'].map((c) => [c]).concat([['h', 0.278]], [...'glyp'].map((c) => [c]), [['h']])));
  out['17-tz-tc'] = pdf(label('17a 50 Tz single object', 395) + 'BT /F1 14 Tf 50 Tz 40 375 Td (Condensed text line) Tj ET\n'
    + label('17b 50 Tz two objects, gap = one condensed space', 345)
    + `BT /F1 14 Tf 50 Tz 40 325 Td (Condensed) Tj ET BT /F1 14 Tf 50 Tz ${(40 + wid('Condensed ', 14) * 0.5).toFixed(2)} 325 Td (pair) Tj ET\n`
    + label('17c 200 Tz two objects, gap = one expanded space (1.1em in device space)', 295)
    + `BT /F1 14 Tf 200 Tz 40 275 Td (Wide) Tj ET BT /F1 14 Tf 200 Tz ${(40 + wid('Wide ', 14) * 2).toFixed(2)} 275 Td (text) Tj ET\n`
    + label('17d 3 Tc char spacing, single object', 245) + 'BT /F1 14 Tf 3 Tc 40 225 Td (Spaced letters here) Tj ET\n'
    + label('17e per-letter objects, +4pt tracking, word gap = space+4pt', 195)
    + (() => { let s = '', x = 40; for (const c of 'SALE NOW') { if (c !== ' ') s += tj('F1', 14, x, 175, c); x += wid(c, 14) + 4; } return s; })());
  out['18-fake-bold-shadow'] = pdf(label('18a same text drawn twice, +0.4pt x (shadow bold)', 395) + tj('F1', 14, 40, 375, 'Bold Title Text') + tj('F1', 14, 40.4, 375, 'Bold Title Text')
    + label('18b drawn 3x with x/y offsets 0.3pt', 345) + tj('F1', 14, 40, 325, 'Grand Total 1,234') + tj('F1', 14, 40.3, 325, 'Grand Total 1,234') + tj('F1', 14, 40.6, 325.3, 'Grand Total 1,234')
    + label('18c render mode 2 (Word fake bold) mid-line, same font', 295)
    + frags('F1', 14, 40, 275, [['Normal and ']]) + `BT /F1 14 Tf 2 Tr 0.3 w ${(40 + wid('Normal and ', 14)).toFixed(2)} 275 Td (bold) Tj ET\n`
    + tj('F1', 14, 40 + wid('Normal and bold', 14), 275, ' text')
    + label('18d synthetic italic via Tm skew, then upright, same font', 245)
    + 'BT /F1 14 Tf 1 0 0.21 1 40 225 Tm (Italic words) Tj ET\n' + tj('F1', 14, 40 + wid('Italic words ', 14), 225, 'and upright'));
  {
    let c = label('19a words emitted right-to-left (Third, Second, First)', 395);
    const xs = [40, 40 + wid('First ', 14), 40 + wid('First Second ', 14)];
    c += tj('F1', 14, xs[2], 375, 'Third') + tj('F1', 14, xs[1], 375, 'Second ') + tj('F1', 14, xs[0], 375, 'First ');
    c += label('19b glyphs of one word emitted in reverse order', 345);
    let x = 40; const pos = [...'REVERSED'].map((ch) => { const p = x; x += wid(ch, 14); return [ch, p]; });
    for (const [ch, p] of pos.reverse()) c += tj('F1', 14, p, 325, ch);
    c += label('19c lower line emitted before upper line', 295);
    c += tj('F1', 14, 40, 255, 'Line two comes second.') + tj('F1', 14, 40, 275, 'Line one comes first.');
    c += label('19d two columns emitted column-major (reading order L1 L2 R1 R2)', 225);
    c += tj('F1', 12, 40, 205, 'Left col line 1') + tj('F1', 12, 40, 190, 'Left col line 2') + tj('F1', 12, 300, 205, 'Right col line 1') + tj('F1', 12, 300, 190, 'Right col line 2');
    out['19-out-of-order'] = pdf(c);
  }
  out['20-font-boundaries'] = pdf(label('20a ABCDEF+Helvetica then GHIJKL+Helvetica (same base font)', 395)
    + tj('F1', 14, 40, 375, 'Quarterly ') + tj('F2', 14, 40 + wid('Quarterly ', 14), 375, 'sales report')
    + label('20b regular / Helvetica-Bold / regular in one sentence', 345)
    + tj('F1', 14, 40, 325, 'Revenue ') + tj('F3', 14, 40 + wid('Revenue ', 14), 325, 'increased') + tj('F1', 14, 40 + wid('Revenue ', 14) + wid('increased', 14) * 1.06, 325, ' by 12%')
    + label('20c sizes 12 vs 11.5 (rounding) in one line', 295)
    + tj('F1', 12, 40, 275, 'Size twelve ') + tj('F1', 11.5, 40 + wid('Size twelve ', 12), 275, 'and eleven point five')
    + label('20d near-black color 0 0 0 vs 0.02 0.02 0.02 (Excel automatic)', 245)
    + tj('F1', 14, 40, 225, 'Color black ') + `0.02 0.02 0.02 rg ${tj('F1', 14, 40 + wid('Color black ', 14), 225, 'and near black')} 0 0 0 rg\n`
    + label('20e two fields: Courier label + Helvetica value, 1 space gap', 195)
    + tj('F4', 12, 40, 175, 'ID:') + tj('F1', 12, 40 + 3 * 7.2 + 3.3, 175, 'A-1029'));
  // 2단계 문단(9번): 11pt, 줄 간격 14pt인 문단 둘(사이 30pt). 둘째 문단 첫 줄은 보통/굵게/보통 조각 — 문단 다시 흘리기에서 조각 모양 보존을 본다
  {
    let c = label('21 two paragraphs, pitch 14pt, gap 30pt; bold run inside paragraph 2', 395);
    c += tj('F1', 11, 40, 375, 'The first paragraph has three lines of text') + tj('F1', 11, 40, 361, 'that wrap at a fixed width inside the box') + tj('F1', 11, 40, 347, 'and it ends here.');
    const a = 'Second paragraph starts after a gap and ', b = 'mixes';
    c += tj('F1', 11, 40, 317, a) + tj('F3', 11, 40 + wid(a, 11), 317, b) + tj('F1', 11, 40 + wid(a, 11) + wid(b, 11) * 1.1, 317, ' styles in one line.');
    c += tj('F1', 11, 40, 303, 'Its last line is short.');
    out['21-paragraphs'] = pdf(c);
  }
  return out;
}

// v6 Wave B: 서명된 것처럼 보이는 PDF — /AcroForm /SigFlags 3, 서명 칸(/FT /Sig)의 값 /V가 /Type /Sig 사전(/ByteRange·/Contents).
// 진짜 서명(PKCS#7)은 아니다 — 감지(FPDF_GetSignatureCount·바이트 검사)와 "다른 이름으로 저장" 유도만 시험한다
function buildSignedPdf() {
  const content = Buffer.from('BT /F1 18 Tf 40 300 Td (Signed contract body) Tj ET', 'latin1');
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /SigFlags 3 >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 420] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R /Annots [5 0 R] >>',
    { dict: `<< /Length ${content.length} >>`, data: content },
    '<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [0 0 0 0] /F 132 /P 3 0 R /V 6 0 R >>',
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 100 200 50] /Contents <${'0'.repeat(64)}> /M (D:20261015120000+09'00') /Name (Retext Test) >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]);
}

// v6 Wave B: 고정폭 서브셋 글꼴 PDF — 설치돼 있지 않은 이름(ABCDEF+RetextMonoTest, -Bold)으로 ttfPath(Courier New 등)의 몇 글자만 넣는다.
// Chromium·워드 내보내기와 같은 CID 글꼴(Type0 Identity-H + ToUnicode, FontDescriptor Flags 33 = FixedPitch) — 없는 글자는 .notdef로 잡힌다.
// 없는 글자를 넣으면 같은 집안 설치 폰트가 없으므로 고정폭 대체(Consolas → D2Coding → Courier New)로 가야 한다. 글자: 'code_x = 1' / 'bold_y = 2'
function buildMonoSubsetPdf(ttfPath) {
  const { _subsetTTF } = require('./pdf-engine');
  const fontkit = require('fontkit');
  const ttf = _subsetTTF(ttfPath, new Set('code_x =1bold_y2'));
  const face = fontkit.create(ttf);
  const gid = (ch) => face.glyphForCodePoint(ch.codePointAt(0)).id;
  const hex = (s) => '<' + [...s].map((ch) => gid(ch).toString(16).padStart(4, '0')).join('') + '>';
  const chars = [...new Set('code_x =1bold_y2')];
  const cmap = Buffer.from(['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange', `${chars.length} beginbfchar`,
    ...chars.map((ch) => `<${gid(ch).toString(16).padStart(4, '0')}> <${ch.codePointAt(0).toString(16).padStart(4, '0')}>`),
    'endbfchar', 'endcmap', 'CMapName currentdict /CMapResource defineresource pop', 'end', 'end'].join('\n'), 'latin1');
  const content = Buffer.from(`BT /F1 14 Tf 40 300 Td ${hex('code_x = 1')} Tj ET\nBT /F2 14 Tf 40 270 Td ${hex('bold_y = 2')} Tj ET`, 'latin1');
  const type0 = (name, cid) => `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode 12 0 R >>`;
  const cidFont = (name, desc) => `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${desc} 0 R /DW 600 /CIDToGIDMap /Identity >>`;
  const descriptor = (name, weight) => `<< /Type /FontDescriptor /FontName /${name} /Flags 33 /FontBBox [-50 -250 650 850] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 600 /StemV ${weight > 500 ? 140 : 80} /FontWeight ${weight} /FontFile2 11 0 R >>`;
  return buildRawPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 420] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    { dict: `<< /Length ${content.length} >>`, data: content },
    type0('ABCDEF+RetextMonoTest', 7),
    type0('ABCDEF+RetextMonoTest-Bold', 8),
    cidFont('ABCDEF+RetextMonoTest', 9),
    cidFont('ABCDEF+RetextMonoTest-Bold', 10),
    descriptor('ABCDEF+RetextMonoTest', 400),
    descriptor('ABCDEF+RetextMonoTest-Bold', 700),
    { dict: `<< /Length ${ttf.length} /Length1 ${ttf.length} >>`, data: ttf },
    { dict: `<< /Length ${cmap.length} >>`, data: cmap },
  ]);
}

// v6 Wave E: AcroForm 양식 PDF. 두 쪽 — 1쪽(세로 420×520), 2쪽(/Rotate 90, 돌린 쪽의 칸 위치 시험).
//   name   : 글 칸(/DA /Helv 12 Tf, 필수 Ff 2)          · addr  : 글 칸(/DA /Helv 10 Tf, 한글 값을 넣어 볼 칸)
//   memo   : 여러 줄 글 칸(Ff 4096)                       · agree : 확인란(/AP /N /Yes·/Off, /AS /Off)
//   color  : 라디오 묶음(Red·Blue 두 위젯, Ff 49152)       · city  : 콤보 상자(Ff 131072, /Opt Seoul·Busan·Daegu, /V Seoul)
//   langs  : 목록 상자(/Opt ko·en·ja)                      · sig   : 빈 서명 칸(/FT /Sig, 읽기 전용으로 보여야 한다)
//   note2  : 2쪽(돌린 쪽)의 글 칸
// opts.xfa: true면 /AcroForm에 /XFA만 있고 칸이 없는 "XFA 전용" 양식
function buildFormPdf(opts = {}) {
  const objs = [], ids = new Map();
  const ref = (k) => { if (!ids.has(k)) { ids.set(k, objs.length + 1); objs.push(null); } return `${ids.get(k)} 0 R`; };
  const def = (k, body) => { ref(k); objs[ids.get(k) - 1] = body; };
  const stream = (k, dict, text) => { const data = Buffer.from(text, 'latin1'); def(k, { dict: dict.replace(/>>$/, ` /Length ${data.length} >>`), data }); };
  const form = (w, h, extra = '') => `<< /Type /XObject /Subtype /Form /BBox [0 0 ${w} ${h}] ${extra}>>`;
  ref('cat'); ref('pages');
  def('helv', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const res = `/Resources << /Font << /F1 ${ref('helv')} >> >>`;
  if (opts.xfa) {
    stream('xfa', '<< >>', '<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form1"/></template></xdp:xdp>');
    def('cat', `<< /Type /Catalog /Pages ${ref('pages')} /AcroForm << /Fields [] /XFA ${ref('xfa')} >> /NeedsRendering true >>`);
    stream('c1', '<< >>', 'BT /F1 14 Tf 40 300 Td (Please wait... XFA form) Tj ET');
    def('p1', `<< /Type /Page /Parent ${ref('pages')} /MediaBox [0 0 420 420] ${res} /Contents ${ref('c1')} >>`);
    def('pages', `<< /Type /Pages /Kids [${ref('p1')}] /Count 1 >>`);
    return buildRawPdf(objs);
  }
  def('zadb', '<< /Type /Font /Subtype /Type1 /BaseFont /ZapfDingbats >>');
  const label = (x, y, s) => `BT /F1 10 Tf ${x} ${y} Td (${s}) Tj ET\n`;
  stream('c1', '<< >>', 'BT /F1 16 Tf 40 480 Td (Application Form) Tj ET\n' + label(40, 444, 'Name') + label(40, 404, 'Address') + label(40, 364, 'Memo')
    + label(40, 290, 'Agree') + label(40, 254, 'Color') + label(130, 254, 'Red') + label(200, 254, 'Blue') + label(40, 214, 'City') + label(40, 174, 'Language') + label(40, 100, 'Signature'));
  stream('c2', '<< >>', label(40, 360, 'Rotated page note'));
  const widget = (k, page, rect, extra = '') => def(k, `<< /Type /Annot /Subtype /Widget /F 4 /P ${ref(page)} /Rect [${rect.join(' ')}] ${extra} >>`);
  const mk = '/MK << /BC [0 0 0] /BG [1 1 1] >>';
  const empty = (k, w, h) => stream(k, form(w, h), '/Tx BMC EMC');
  // 글 칸
  empty('nameAP', 200, 20);
  widget('name', 'p1', [110, 438, 310, 458], `${mk} /FT /Tx /T (name) /TU (Full name) /Ff 2 /DA (/Helv 12 Tf 0 g) /AP << /N ${ref('nameAP')} >>`);
  empty('addrAP', 260, 20);
  widget('addr', 'p1', [110, 398, 370, 418], `${mk} /FT /Tx /T (addr) /DA (/Helv 10 Tf 0 g) /AP << /N ${ref('addrAP')} >>`);
  empty('memoAP', 260, 50);
  widget('memo', 'p1', [110, 320, 370, 370], `${mk} /FT /Tx /T (memo) /Ff 4096 /DA (/Helv 9 Tf 0 0 1 rg) /AP << /N ${ref('memoAP')} >>`);
  // 확인란
  stream('agreeOn', form(16, 16, `/Resources << /Font << /ZaDb ${ref('zadb')} >> >> `), '0 G 1 1 14 14 re S q 0 g BT /ZaDb 12 Tf 2.5 3 Td (4) Tj ET Q');
  stream('agreeOff', form(16, 16), '0 G 1 1 14 14 re S');
  widget('agree', 'p1', [110, 286, 126, 302], `/MK << /BC [0 0 0] /CA (4) >> /FT /Btn /T (agree) /V /Off /AS /Off /DA (/ZaDb 0 Tf 0 g) /AP << /N << /Yes ${ref('agreeOn')} /Off ${ref('agreeOff')} >> >>`);
  // 라디오 묶음(부모 color, 위젯 둘)
  const dot = (k, on) => stream(k, form(14, 14), `0 G 1 w 1 1 12 12 re S${on ? ' 0 g 4 4 6 6 re f' : ''}`);
  dot('redOn', true); dot('redOff', false); dot('blueOn', true); dot('blueOff', false);
  def('color', `<< /FT /Btn /T (color) /Ff 49152 /V /Off /Kids [${ref('red')} ${ref('blue')}] >>`);
  def('red', `<< /Type /Annot /Subtype /Widget /F 4 /P ${ref('p1')} /Parent ${ref('color')} /Rect [110 250 124 264] /AS /Off /MK << /BC [0 0 0] /CA (l) >> /AP << /N << /Red ${ref('redOn')} /Off ${ref('redOff')} >> >> >>`);
  def('blue', `<< /Type /Annot /Subtype /Widget /F 4 /P ${ref('p1')} /Parent ${ref('color')} /Rect [180 250 194 264] /AS /Off /MK << /BC [0 0 0] /CA (l) >> /AP << /N << /Blue ${ref('blueOn')} /Off ${ref('blueOff')} >> >> >>`);
  // 콤보·목록
  stream('cityAP', form(120, 20, `/Resources << /Font << /Helv ${ref('helv')} >> >> `), '/Tx BMC q BT /Helv 11 Tf 0 g 2 5 Td (Seoul) Tj ET Q EMC');
  widget('city', 'p1', [110, 208, 230, 228], `${mk} /FT /Ch /T (city) /Ff 131072 /Opt [(Seoul) (Busan) (Daegu)] /V (Seoul) /DA (/Helv 11 Tf 0 g) /AP << /N ${ref('cityAP')} >>`);
  empty('langsAP', 120, 40);
  widget('langs', 'p1', [110, 150, 230, 190], `${mk} /FT /Ch /T (langs) /Opt [[(ko) (Korean)] [(en) (English)] [(ja) (Japanese)]] /DA (/Helv 10 Tf 0 g) /AP << /N ${ref('langsAP')} >>`);
  // 빈 서명 칸
  widget('sig', 'p1', [110, 80, 300, 120], '/FT /Sig /T (sig)');
  // 2쪽(돌린 쪽)
  empty('note2AP', 160, 20);
  widget('note2', 'p2', [120, 340, 280, 360], `${mk} /FT /Tx /T (note2) /DA (/Helv 10 Tf 0 g) /AP << /N ${ref('note2AP')} >>`);
  const fields = ['name', 'addr', 'memo', 'agree', 'color', 'city', 'langs', 'sig', 'note2'];
  def('cat', `<< /Type /Catalog /Pages ${ref('pages')} /AcroForm << /Fields [${fields.map(ref).join(' ')}] /DA (/Helv 0 Tf 0 g) /DR << /Font << /Helv ${ref('helv')} /ZaDb ${ref('zadb')} >> >> >> >>`);
  def('p1', `<< /Type /Page /Parent ${ref('pages')} /MediaBox [0 0 420 520] ${res} /Contents ${ref('c1')} /Annots [${['name', 'addr', 'memo', 'agree', 'red', 'blue', 'city', 'langs', 'sig'].map(ref).join(' ')}] >>`);
  def('p2', `<< /Type /Page /Parent ${ref('pages')} /MediaBox [0 0 420 420] /Rotate 90 ${res} /Contents ${ref('c2')} /Annots [${ref('note2')}] >>`);
  def('pages', `<< /Type /Pages /Kids [${ref('p1')} ${ref('p2')}] /Count 2 >>`);
  return buildRawPdf(objs);
}

module.exports = { buildPdf, makePng, buildObjStmPdf, appendUpdate, buildTrickyPdf, buildRawPdf, buildHiddenDataPdf, buildGroupingRawPdfs, buildSignedPdf, buildMonoSubsetPdf, buildFormPdf };
