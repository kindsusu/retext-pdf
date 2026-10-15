// PDF 암호 걸기 — 표준 보안 처리기 AES-256 (V 5 / R 6, ISO 32000-2 7.6.4 · Adobe 확장 레벨 8)
// PDFium에는 암호화 API가 없다 → 엔진이 저장한 "암호 없는" PDF 바이트를 직접 읽어 암호화한 새 PDF로 다시 쓴다.
//   encryptPdf(bytes, { userPassword, ownerPassword?, allow?: { print, copy, modify } }) → Buffer
// 읽기: 고전 xref 표 · xref 스트림 · 객체 스트림(/Type /ObjStm) · 증분 저장(/Prev 사슬, 혼합형 /XRefStm). xref가 깨졌으면 "n g obj"를 훑어 다시 만든다.
// 쓰기: 살아 있는 객체를 모두 최상위 간접 객체로 풀어(객체 스트림·xref 스트림은 버린다) 번호를 1부터 다시 매기고 고전 xref 표로 쓴다.
//   문자열(리터럴·16진)은 모두 AES-256-CBC로 암호화해 16진 문자열로, 스트림은 이미 걸린 /Filter 그대로 압축된 바이트를 암호화하고 /Length를 고친다.
//   예외: /Encrypt 사전 자신, 트레일러 /ID, 서명 사전(/Type /Sig·/DocTimeStamp)의 /Contents. 콘텐츠 스트림 안의 문자열은 스트림째 암호화된다.
// 외부 의존성 없음(node:crypto). PDF 읽기·값 쓰기는 pdf-rewrite.js. 이미 암호가 걸린 입력은 거절한다(엔진은 언제나 암호를 벗겨 저장한다 — FPDF_REMOVE_SECURITY).
const crypto = require('crypto');
const { fail, num, name, dict, isDict, nameOf, parsePdf, serialize } = require('./pdf-rewrite'); // 읽기·쓰기 문법은 pdf-rewrite.js와 같이 쓴다

// ── 암호 ────────────────────────────────────────────────────────────────────
// SASLprep(RFC 4013) 근사: B.1(없앨 글자) 제거 · C.1.2(ASCII 아닌 공백) → 공백 · NFKC. 금지 글자·양방향 검사는 하지 않는다.
// R6 암호는 SASLprep한 UTF-8을 127바이트로 자른다(ISO 32000-2 7.6.4.3.3). 한글·영숫자는 NFKC에서 바뀌지 않는다.
// PDFium·qpdf는 암호를 정규화하지 않고 UTF-8 그대로 쓰므로, 정규화로 바뀌는 암호(전각 문자·합자 등)는 서버가 원문과 정규화본을 둘 다 시도한다.
function normalizePassword(pw) {
  return String(pw ?? '')
    .replace(/[­͏᠆᠋-᠍​-‍⁠︀-️﻿]/g, '')
    .replace(/[   -   　]/g, ' ')
    .normalize('NFKC');
}
const passwordBytes = (pw) => (Buffer.isBuffer(pw) ? pw : Buffer.from(normalizePassword(pw), 'utf8')).subarray(0, 127);
// 라우트용 검사: 문제가 있으면 사용자에게 보여 줄 문장, 없으면 null
function passwordProblem(pw, label = '암호') {
  if (typeof pw !== 'string' || !pw) return `${label}를 입력하세요.`;
  const n = normalizePassword(pw);
  if (!n) return `${label}에 쓸 수 있는 글자가 없습니다.`;
  if (Buffer.byteLength(pw, 'utf8') > 127 || Buffer.byteLength(n, 'utf8') > 127) return `${label}는 127바이트(한글 약 42자, 영문 127자) 이하로 입력하세요.`;
  return null;
}

// 권한 비트 P(int32). 예약 비트 7·8·13–32는 1, 1·2는 0. 접근성 추출(10)은 PDF 2.0 권고대로 늘 켠다.
// print → 인쇄(3)+고품질 인쇄(12), modify → 수정(4)+주석·양식(6)+양식 채우기(9)+조립(11), copy → 복사·추출(5)
function permissionBits({ print = true, copy = true, modify = true } = {}) {
  let p = 0xfffff0c0 | 512;
  if (print) p |= 4 | 2048;
  if (modify) p |= 8 | 32 | 256 | 1024;
  if (copy) p |= 16;
  return p | 0;
}

const sha = (alg, ...parts) => crypto.createHash(alg).update(Buffer.concat(parts)).digest();
const aesNoPad = (alg, key, iv, data) => { const c = crypto.createCipheriv(alg, key, iv); c.setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]); };
// 알고리즘 2.B(R6 해시): SHA-256으로 시작해 AES-128-CBC 결과의 앞 16바이트 합 mod 3으로 SHA-256/384/512를 고르며
// 최소 64회, 마지막 바이트 ≤ (회차 − 32)가 될 때까지 돈다(qpdf·Acrobat과 같은 회차 세기)
function hash2B(pw, salt, udata = Buffer.alloc(0)) {
  let K = sha('sha256', pw, salt, udata);
  for (let round = 0; ;) {
    const unit = Buffer.concat([pw, K, udata]), K1 = Buffer.alloc(unit.length * 64);
    for (let k = 0; k < 64; k++) unit.copy(K1, k * unit.length);
    const E = aesNoPad('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32), K1);
    let sum = 0;
    for (let k = 0; k < 16; k++) sum += E[k];
    K = sha(['sha256', 'sha384', 'sha512'][sum % 3], E);
    round++;
    if (round >= 64 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}

// 알고리즘 8(U·UE) · 9(O·OE) · 10(Perms). fileKey 32바이트
function securityValues(fileKey, userPw, ownerPw, P, encryptMetadata = true) {
  const zero = Buffer.alloc(16);
  const u = passwordBytes(userPw), o = passwordBytes(ownerPw);
  const uvs = crypto.randomBytes(8), uks = crypto.randomBytes(8);
  const U = Buffer.concat([hash2B(u, uvs), uvs, uks]);
  const UE = aesNoPad('aes-256-cbc', hash2B(u, uks), zero, fileKey);
  const ovs = crypto.randomBytes(8), oks = crypto.randomBytes(8);
  const O = Buffer.concat([hash2B(o, ovs, U), ovs, oks]);
  const OE = aesNoPad('aes-256-cbc', hash2B(o, oks, U), zero, fileKey);
  const perms = Buffer.alloc(16);
  perms.writeInt32LE(P, 0);
  perms.fill(0xff, 4, 8);
  perms.write(encryptMetadata ? 'T' : 'F', 8, 'latin1');
  perms.write('adb', 9, 'latin1');
  crypto.randomBytes(4).copy(perms, 12);
  const Perms = aesNoPad('aes-256-ecb', fileKey, null, perms);
  return { U, UE, O, OE, Perms };
}
// AESV3: 문자열·스트림 모두 파일 키 그대로, 앞에 임의 IV 16바이트 + AES-256-CBC(PKCS#7)
function aesv3(key, data) {
  const iv = crypto.randomBytes(16), c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, c.update(data), c.final()]);
}


// 암호 없는 PDF → AES-256(R6) 암호 PDF
function encryptPdf(input, { userPassword, ownerPassword, allow } = {}) {
  const problem = passwordProblem(userPassword, '여는 암호');
  if (problem) throw fail(problem, 'BAD_PASSWORD');
  if (ownerPassword) { const p2 = passwordProblem(ownerPassword, '권한 암호'); if (p2) throw fail(p2, 'BAD_PASSWORD'); }
  const pdf = parsePdf(input);
  if (pdf.trailer.v.get('Encrypt')) throw fail('이미 암호가 걸린 PDF입니다. 암호를 푼 문서만 다시 암호화할 수 있습니다.', 'ALREADY_ENCRYPTED');

  // 살아 있는 객체(객체 스트림·xref 스트림은 풀어 버린다) → 새 번호 1..N
  const objs = [];
  for (const n of pdf.nums) {
    const v = pdf.get(n);
    if (v && v.t === 'stream' && ['XRef', 'ObjStm'].includes(nameOf(v.dict.v.get('Type')))) continue;
    objs.push({ old: n, value: v });
  }
  const refMap = new Map(objs.map((o, k) => [o.old, k + 1]));
  const rootRef = pdf.trailer.v.get('Root');
  if (!rootRef || rootRef.t !== 'ref' || !refMap.has(rootRef.n)) throw fail('문서 카탈로그(Root)를 찾을 수 없습니다');
  let info = pdf.trailer.v.get('Info');
  if (isDict(info)) { objs.push({ old: -1, value: info }); info = objs.length; } // 트레일러에 바로 든 Info는 간접 객체로 뺀다
  else info = info && info.t === 'ref' ? refMap.get(info.n) : null;

  // AES-256은 PDF 2.0(또는 1.7 + Adobe 확장 레벨 8)
  const v2 = Number(pdf.version) >= 2;
  const root = pdf.get(rootRef.n);
  if (!v2 && isDict(root)) {
    const ext = root.v.get('Extensions');
    const adbe = dict([['BaseVersion', name('1.7')], ['ExtensionLevel', num(8)]]);
    if (!ext) root.v.set('Extensions', dict([['ADBE', adbe]]));
    else if (isDict(ext) && !ext.v.get('ADBE')) ext.v.set('ADBE', adbe);
  }

  const fileKey = crypto.randomBytes(32);
  const owner = ownerPassword || crypto.randomBytes(32); // 권한 암호가 없으면 임의 바이트(여는 암호에서 끌어내지 않는다)
  const P = permissionBits(allow);
  const sec = securityValues(fileKey, userPassword, owner, P, true);
  const enc = (b) => aesv3(fileKey, b);

  const parts = [Buffer.from(`%PDF-${v2 ? pdf.version : '1.7'}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  let size = parts[0].length;
  const offs = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objs.forEach((o, k) => {
    offs.push(size);
    const v = o.value;
    if (v && v.t === 'stream') {
      const data = enc(v.data);
      v.dict.v.set('Length', num(data.length));
      push(Buffer.from(`${k + 1} 0 obj\n${serialize(v.dict, refMap, enc)}\nstream\n`, 'latin1'));
      push(data);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else push(Buffer.from(`${k + 1} 0 obj\n${serialize(v, refMap, enc)}\nendobj\n`, 'latin1'));
  });
  const encNum = objs.length + 1;
  const hex = (b) => `<${b.toString('hex')}>`;
  offs.push(size);
  push(Buffer.from(`${encNum} 0 obj\n<< /Filter /Standard /V 5 /R 6 /Length 256 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> /StmF /StdCF /StrF /StdCF`
    + ` /O ${hex(sec.O)} /U ${hex(sec.U)} /OE ${hex(sec.OE)} /UE ${hex(sec.UE)} /P ${P} /Perms ${hex(sec.Perms)} /EncryptMetadata true >>\nendobj\n`, 'latin1'));

  // /ID는 암호화하지 않는다. 없으면 새로 만든다
  const oldId = pdf.trailer.v.get('ID');
  const ids = Array.isArray(oldId) && oldId.length === 2 && oldId.every((x) => x && x.t === 'str' && x.v.length) ? oldId.map((x) => x.v) : null;
  const id0 = ids ? ids[0] : crypto.randomBytes(16), id1 = ids ? ids[1] : id0;
  const xref = size;
  push(Buffer.from(`xref\n0 ${encNum + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${encNum + 1} /Root ${refMap.get(rootRef.n)} 0 R${info ? ` /Info ${info} 0 R` : ''} /Encrypt ${encNum} 0 R /ID [${hex(id0)} ${hex(id1)}] >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

module.exports = { encryptPdf, parsePdf, permissionBits, normalizePassword, passwordProblem, hash2B };
