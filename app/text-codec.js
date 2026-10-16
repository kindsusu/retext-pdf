// v6.1 텍스트(.txt) 인코딩: 읽을 때 알아보고, 저장할 때 같은 인코딩으로 되돌린다.
// 알아보는 순서: BOM(UTF-8 · UTF-16 LE · UTF-16 BE) → 엄격한 UTF-8 → CP949(한국어 Windows 메모장의 'ANSI', 확장 완성형 포함).
// CP949는 표(app/cp949.bin — WHATWG 'euc-kr' = windows-949, tools/make-cp949-table.js가 Electron 디코더로 만든다)로 직접 풀고 쓴다.
// Node의 TextDecoder('euc-kr')는 ICU의 EUC-KR이라 확장 완성형(똠·갂 등)을 못 풀어(실측 2026-10-16: Node 8,412자 / Electron 17,048자)
// 실행 환경(앱·node server.js·시험)마다 결과가 달라지지 않게 표를 쓴다
const fs = require('fs');
const path = require('path');

const ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'cp949'];
const LABEL = { 'utf-8': 'UTF-8', 'utf-8-bom': 'UTF-8 (BOM)', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', cp949: 'CP949' };
const TEXT_MAX_BYTES = 20 * 1024 * 1024; // 편집기(textarea)로 여는 글 파일 상한 — 넘으면 열지 않고 알린다

// CP949 표: 포인터((앞 − 0x81) × 190 + (뒤 − 0x41)) → UTF-16 코드 단위(0 = 없는 칸). 처음 쓸 때 읽는다
let table = null, reverse = null;
function cp949Table() {
  if (!table) {
    const b = fs.readFileSync(path.join(__dirname, 'cp949.bin'));
    table = new Uint16Array(b.length / 2);
    for (let k = 0; k < table.length; k++) table[k] = b.readUInt16LE(k * 2);
  }
  return table;
}
function cp949Reverse() {
  if (!reverse) {
    const t = cp949Table();
    reverse = new Map();
    for (let p = 0; p < t.length; p++) {
      if (!t[p] || reverse.has(t[p])) continue;
      reverse.set(t[p], ((Math.floor(p / 190) + 0x81) << 8) | ((p % 190) + 0x41));
    }
  }
  return reverse;
}
// 엄격한 CP949 풀기: 표에 없는 조합·잘린 앞 바이트가 하나라도 있으면 null
function decodeCp949(b) {
  const t = cp949Table();
  let out = '', run = [];
  const flush = () => { if (run.length) { out += String.fromCharCode(...run); run = []; } };
  for (let k = 0; k < b.length; k++) {
    const c = b[k];
    if (c < 0x80) { run.push(c); }
    else {
      if (c === 0x80 || c === 0xff || k + 1 >= b.length) return null;
      const trail = b[++k];
      if (trail < 0x41 || trail > 0xfe) return null;
      const u = t[(c - 0x81) * 190 + (trail - 0x41)];
      if (!u) return null;
      run.push(u);
    }
    if (run.length >= 8192) flush();
  }
  flush();
  return out;
}

// 버퍼 → { text, encoding, lossy } (lossy: 어느 인코딩으로도 깨끗이 풀리지 않아 UTF-8로 풀고 깨진 글자를 �로 바꿨다)
function decodeText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom', lossy: false };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le', lossy: false };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be', lossy: false };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8', lossy: false }; } catch {}
  const k = decodeCp949(b);
  if (k !== null) return { text: k, encoding: 'cp949', lossy: false };
  return { text: new TextDecoder('utf-8').decode(b), encoding: 'utf-8', lossy: true };
}

// 글 → 그 인코딩의 바이트. CP949로 못 쓰는 글자가 있으면 { status:422, extra:{ unencodable:['😀', …](최대 20자, 중복 없음) } }를 단 오류를 던진다
function encodeText(text, encoding) {
  const s = String(text ?? '');
  switch (encoding) {
    case 'utf-8': return Buffer.from(s, 'utf8');
    case 'utf-8-bom': return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]);
    case 'utf-16le': return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    case 'utf-16be': { const b = Buffer.from(s, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
    case 'cp949': {
      const map = cp949Reverse(), out = Buffer.alloc(s.length * 2), bad = new Set();
      let n = 0;
      for (const ch of s) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) { out[n++] = cp; continue; }
        const v = cp <= 0xffff ? map.get(cp) : undefined;
        if (v === undefined) { if (bad.size < 20) bad.add(ch); continue; }
        out[n++] = v >> 8; out[n++] = v & 0xff;
      }
      if (bad.size) throw Object.assign(new Error(`CP949로 저장할 수 없는 글자가 있습니다: ${[...bad].join(' ')}`), { status: 422, extra: { unencodable: [...bad], encoding } });
      return out.subarray(0, n);
    }
    default: throw Object.assign(new Error(`알 수 없는 인코딩입니다: ${encoding}`), { status: 400 });
  }
}

module.exports = { ENCODINGS, LABEL, TEXT_MAX_BYTES, decodeText, encodeText, decodeCp949 };
