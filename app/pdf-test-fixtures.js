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

module.exports = { buildPdf, makePng, buildObjStmPdf, appendUpdate, buildTrickyPdf };
