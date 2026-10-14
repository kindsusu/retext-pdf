// PDF 암호 걸기 — 표준 보안 처리기 AES-256 (V 5 / R 6, ISO 32000-2 7.6.4 · Adobe 확장 레벨 8)
// PDFium에는 암호화 API가 없다 → 엔진이 저장한 "암호 없는" PDF 바이트를 직접 읽어 암호화한 새 PDF로 다시 쓴다.
//   encryptPdf(bytes, { userPassword, ownerPassword?, allow?: { print, copy, modify } }) → Buffer
// 읽기: 고전 xref 표 · xref 스트림 · 객체 스트림(/Type /ObjStm) · 증분 저장(/Prev 사슬, 혼합형 /XRefStm). xref가 깨졌으면 "n g obj"를 훑어 다시 만든다.
// 쓰기: 살아 있는 객체를 모두 최상위 간접 객체로 풀어(객체 스트림·xref 스트림은 버린다) 번호를 1부터 다시 매기고 고전 xref 표로 쓴다.
//   문자열(리터럴·16진)은 모두 AES-256-CBC로 암호화해 16진 문자열로, 스트림은 이미 걸린 /Filter 그대로 압축된 바이트를 암호화하고 /Length를 고친다.
//   예외: /Encrypt 사전 자신, 트레일러 /ID, 서명 사전(/Type /Sig·/DocTimeStamp)의 /Contents. 콘텐츠 스트림 안의 문자열은 스트림째 암호화된다.
// 외부 의존성 없음(node:crypto · node:zlib). 이미 암호가 걸린 입력은 거절한다(엔진은 언제나 암호를 벗겨 저장한다 — FPDF_REMOVE_SECURITY).
const crypto = require('crypto');
const zlib = require('zlib');

const fail = (message, code = 'BAD_PDF') => Object.assign(new Error(message), { code });

// ── 바이트 분류 ──────────────────────────────────────────────────────────────
const IS_WS = new Uint8Array(256), IS_DELIM = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) IS_WS[c] = 1;
for (const c of '()<>[]{}/%') IS_DELIM[c.charCodeAt(0)] = 1;
const isRegular = (c) => c !== undefined && !IS_WS[c] && !IS_DELIM[c];
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;
const INT_RE = /^\d+$/;

// 값 표현: null · true/false · { t:'num', raw } · { t:'name', v(바이트를 latin1로) } · { t:'str', v: Buffer }
//   · 배열(JS Array) · { t:'dict', v: Map(이름 → 값) } · { t:'ref', n, g } · { t:'kw', v }(모르는 낱말) · { t:'stream', dict, data }
const num = (n) => ({ t: 'num', raw: String(n) });
const name = (v) => ({ t: 'name', v });
const dict = (entries) => ({ t: 'dict', v: new Map(entries) });
const isDict = (o) => o && o.t === 'dict';
const nameOf = (o) => (o && o.t === 'name' ? o.v : null);

// ── 낱말 읽기(렉서) ─────────────────────────────────────────────────────────
class Lexer {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.end = end; }
  // 공백과 주석(% … 줄 끝)을 건너뛴다
  skip() {
    const b = this.b;
    for (;;) {
      while (this.p < this.end && IS_WS[b[this.p]]) this.p++;
      if (this.p < this.end && b[this.p] === 0x25) { while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; }
      return;
    }
  }
  // 구분자가 아닌 글자가 이어진 낱말 하나(숫자·키워드)
  regular() {
    const s = this.p;
    while (this.p < this.end && isRegular(this.b[this.p])) this.p++;
    return this.b.latin1Slice(s, this.p);
  }
  peekIs(word) {
    this.skip();
    if (this.b.latin1Slice(this.p, this.p + word.length) !== word) return false;
    return !isRegular(this.b[this.p + word.length]) || this.p + word.length >= this.end;
  }
  int() {
    this.skip();
    const t = this.regular();
    if (!INT_RE.test(t)) throw fail(`정수가 아닌 값: ${t.slice(0, 20)}`);
    return Number(t);
  }

  value() {
    this.skip();
    const b = this.b;
    if (this.p >= this.end) throw fail('PDF가 중간에 끝났습니다');
    const c = b[this.p];
    if (c === 0x2f) return this.nameTok();                                  // /
    if (c === 0x28) return this.literal();                                  // (
    if (c === 0x3c) return b[this.p + 1] === 0x3c ? this.dictTok() : this.hex(); // << 또는 <
    if (c === 0x5b) {                                                       // [
      this.p++;
      const arr = [];
      for (;;) {
        this.skip();
        if (this.p >= this.end) throw fail('배열이 닫히지 않았습니다');
        if (b[this.p] === 0x5d) { this.p++; return arr; }
        arr.push(this.value());
      }
    }
    if (IS_DELIM[c]) { this.p++; return { t: 'kw', v: String.fromCharCode(c) }; } // 짝 없는 ) ] > { } — 버리지 않고 낱말로 남긴다
    const tok = this.regular();
    if (NUM_RE.test(tok)) {
      // 정수 두 개 + R = 간접 참조
      if (INT_RE.test(tok)) {
        const save = this.p;
        this.skip();
        const g = this.regular();
        if (INT_RE.test(g)) {
          this.skip();
          if (b[this.p] === 0x52 && (this.p + 1 >= this.end || !isRegular(b[this.p + 1]))) { this.p++; return { t: 'ref', n: Number(tok), g: Number(g) }; }
        }
        this.p = save;
      }
      return { t: 'num', raw: tok };
    }
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { t: 'kw', v: tok };
  }
  nameTok() {
    this.p++;
    const s = this.p;
    while (this.p < this.end && isRegular(this.b[this.p])) this.p++;
    const raw = this.b.latin1Slice(s, this.p);
    // #xx 이스케이프를 바이트로 푼다
    return name(raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : raw);
  }
  literal() {
    const b = this.b, out = [];
    let depth = 1;
    this.p++;
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 0x5c) { // 백슬래시
        const d = b[this.p++];
        if (d === 0x6e) out.push(10); else if (d === 0x72) out.push(13); else if (d === 0x74) out.push(9);
        else if (d === 0x62) out.push(8); else if (d === 0x66) out.push(12);
        else if (d === 0x0d) { if (b[this.p] === 0x0a) this.p++; }  // 줄 이음
        else if (d === 0x0a) { /* 줄 이음 */ }
        else if (d >= 0x30 && d <= 0x37) {                             // \ddd (1–3자리 8진)
          let v = d - 0x30;
          for (let k = 0; k < 2 && b[this.p] >= 0x30 && b[this.p] <= 0x37; k++) v = v * 8 + (b[this.p++] - 0x30);
          out.push(v & 255);
        } else if (d !== undefined) out.push(d);                        // \( \) \\ 와 모르는 이스케이프(백슬래시만 버린다)
      } else if (c === 0x28) { depth++; out.push(c); }
      else if (c === 0x29) { if (--depth === 0) return { t: 'str', v: Buffer.from(out) }; out.push(c); }
      else if (c === 0x0d) { out.push(10); if (b[this.p] === 0x0a) this.p++; } // 줄 끝은 LF 하나로
      else out.push(c);
    }
    throw fail('문자열이 닫히지 않았습니다');
  }
  hex() {
    const b = this.b;
    this.p++;
    let s = '';
    while (this.p < this.end && b[this.p] !== 0x3e) {
      const c = b[this.p++];
      if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) s += String.fromCharCode(c);
    }
    this.p++;
    if (s.length % 2) s += '0';
    return { t: 'str', v: Buffer.from(s, 'hex') };
  }
  dictTok() {
    const b = this.b, m = new Map();
    this.p += 2;
    for (;;) {
      this.skip();
      if (this.p >= this.end) throw fail('사전이 닫히지 않았습니다');
      if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) { this.p += 2; return { t: 'dict', v: m }; }
      const k = this.value();
      if (!k || k.t !== 'name') continue; // 이름이 아닌 키는 버린다(손상 허용)
      this.skip();
      if (b[this.p] === 0x3e && b[this.p + 1] === 0x3e) { m.set(k.v, null); continue; } // 값이 빠진 키
      m.set(k.v, this.value());
    }
  }
}

// ── 스트림 해독(객체 스트림·xref 스트림 읽기용) ─────────────────────────────
function inflate(data) {
  try { return zlib.inflateSync(data); } catch {}
  try { return zlib.inflateSync(data, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch {} // 끝이 잘린 압축
  try { return zlib.inflateRawSync(data); } catch {}
  throw fail('압축된 스트림을 풀 수 없습니다');
}
// PNG 예측기(Predictor ≥ 10). TIFF(2)는 xref·객체 스트림에서 쓰이지 않아 지원하지 않는다
function unpredict(data, parms) {
  const pred = Number(parms?.v.get('Predictor')?.raw || 1);
  if (pred < 2) return data;
  if (pred < 10) throw fail('지원하지 않는 예측기(TIFF)');
  const colors = Number(parms.v.get('Colors')?.raw || 1), bpc = Number(parms.v.get('BitsPerComponent')?.raw || 8), cols = Number(parms.v.get('Columns')?.raw || 1);
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8)), row = Math.ceil(colors * bpc * cols / 8);
  const rows = Math.floor(data.length / (row + 1)), out = Buffer.alloc(rows * row);
  let prev = Buffer.alloc(row);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * (row + 1)], src = data.subarray(r * (row + 1) + 1, (r + 1) * (row + 1)), cur = out.subarray(r * row, (r + 1) * row);
    for (let i = 0; i < row; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (ft === 1) v += a; else if (ft === 2) v += up; else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  return out;
}
function decodeStream(s, resolve) {
  const r = (o) => (o && o.t === 'ref' ? resolve(o) : o);
  const f = r(s.dict.v.get('Filter')), p = r(s.dict.v.get('DecodeParms'));
  const filters = f == null ? [] : Array.isArray(f) ? f.map(r) : [f];
  const parms = Array.isArray(p) ? p.map(r) : [p];
  let data = s.data;
  filters.forEach((fl, k) => {
    const n = nameOf(fl);
    if (n !== 'FlateDecode' && n !== 'Fl') throw fail(`지원하지 않는 필터: ${n}`);
    data = unpredict(inflate(data), isDict(parms[k]) ? parms[k] : null);
  });
  return data;
}

// ── PDF 읽기 ────────────────────────────────────────────────────────────────
// 결과: { version, trailer(dict), nums(살아 있는 객체 번호, 오름차순), get(n) → 값 }
function parsePdf(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const head = buf.latin1Slice(0, Math.min(buf.length, 1024));
  const hm = /%PDF-(\d+\.\d+)/.exec(head);
  if (!hm) throw fail('PDF 파일이 아닙니다');
  const base = hm.index; // 머리 앞에 쓰레기가 붙은 파일은 오프셋이 이만큼 밀려 있을 수 있다
  const cache = new Map(), stmCache = new Map();
  let entries = new Map(); // 번호 → { type:1, off } | { type:2, stm, idx } | { type:0 }
  let scanIndex = null;

  // "n g obj"를 훑은 색인(뒤에 나온 것이 이긴다) — xref 오프셋이 틀렸거나 xref가 없을 때만 만든다
  const scan = () => {
    if (scanIndex) return scanIndex;
    scanIndex = new Map();
    const s = buf.latin1Slice(0, buf.length), re = /(?<![0-9])(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g;
    let m;
    while ((m = re.exec(s))) scanIndex.set(Number(m[1]), m.index);
    return scanIndex;
  };

  // 스트림 길이: /Length가 간접 참조여도 푼다. 틀리면 endstream을 찾아 자른다
  const readStream = (lx, d) => {
    const b = buf;
    let p = lx.p + 6; // 'stream'
    if (b[p] === 0x0d && b[p + 1] === 0x0a) p += 2; else if (b[p] === 0x0a || b[p] === 0x0d) p += 1;
    let len = -1;
    try {
      let L = d.v.get('Length');
      if (L && L.t === 'ref') L = get(L.n);
      if (L && L.t === 'num' && INT_RE.test(L.raw)) len = Number(L.raw);
    } catch { len = -1; }
    let end = -1;
    if (len >= 0 && p + len <= b.length) {
      let q = p + len;
      while (q < b.length && IS_WS[b[q]]) q++;
      if (b.latin1Slice(q, q + 9) === 'endstream') end = p + len;
    }
    if (end < 0) { // 길이가 틀렸다 → endstream 앞의 줄 끝 하나를 뺀 곳까지
      const k = b.indexOf('endstream', p, 'latin1');
      if (k < 0) throw fail('endstream이 없습니다');
      end = k;
      if (b[end - 1] === 0x0a) end--;
      if (b[end - 1] === 0x0d) end--;
      if (end < p) end = p;
    }
    return { t: 'stream', dict: d, data: b.subarray(p, end) };
  };

  // 오프셋의 간접 객체 하나. want를 주면 번호가 맞는지 확인한다
  const parseAt = (off, want) => {
    const lx = new Lexer(buf, off);
    const n = lx.int(), g = lx.int();
    if (want !== undefined && n !== want) throw fail(`객체 번호가 맞지 않습니다(${want} ≠ ${n})`);
    if (!lx.peekIs('obj')) throw fail('obj가 없습니다');
    lx.p += 3;
    if (lx.peekIs('endobj')) return { n, g, value: null };
    const value = lx.value();
    if (isDict(value) && lx.peekIs('stream')) return { n, g, value: readStream(lx, value) };
    return { n, g, value };
  };

  const loadObjStm = (sn) => {
    if (stmCache.has(sn)) return stmCache.get(sn);
    const s = get(sn);
    if (!s || s.t !== 'stream') throw fail(`객체 스트림 ${sn}이 없습니다`);
    const data = decodeStream(s, (r) => get(r.n));
    const n = Number(s.dict.v.get('N')?.raw || 0), first = Number(s.dict.v.get('First')?.raw || 0);
    const lx = new Lexer(data), list = [];
    for (let k = 0; k < n; k++) list.push([lx.int(), lx.int()]);
    const objs = new Map();
    list.forEach(([on, ooff], k) => {
      try { objs.set(k, { n: on, value: new Lexer(data, first + ooff).value() }); } catch { objs.set(k, { n: on, value: null }); }
    });
    stmCache.set(sn, objs);
    return objs;
  };

  const resolving = new Set();
  function get(n) {
    if (cache.has(n)) return cache.get(n);
    const e = entries.get(n);
    if (!e || e.type === 0) return null;
    if (resolving.has(n)) throw fail(`객체 ${n}이 자기 자신을 참조합니다`);
    resolving.add(n);
    try {
      let value;
      if (e.type === 1) {
        try { value = parseAt(e.off, n).value; }
        catch (err) {
          let ok = false;
          if (base) { try { value = parseAt(e.off + base, n).value; ok = true; } catch {} }
          if (!ok) { const off = scan().get(n); if (off === undefined) throw err; value = parseAt(off, n).value; }
        }
      } else {
        const o = loadObjStm(e.stm).get(e.idx);
        value = o && o.n === n ? o.value : [...loadObjStm(e.stm).values()].find((x) => x.n === n)?.value ?? null;
      }
      cache.set(n, value);
      return value;
    } finally { resolving.delete(n); }
  }

  // xref 한 구간: 고전 표 또는 xref 스트림. { list: [[번호, 항목]], trailer }
  const readSection = (off) => {
    const lx = new Lexer(buf, off);
    if (lx.peekIs('xref')) {
      lx.p += 4;
      const list = [];
      for (;;) {
        if (lx.peekIs('trailer')) { lx.p += 7; break; }
        const start = lx.int(), count = lx.int();
        for (let k = 0; k < count; k++) {
          const o = lx.int(), g = lx.int();
          lx.skip();
          const t = lx.regular();
          list.push([start + k, t === 'n' ? { type: 1, off: o, gen: g } : { type: 0 }]);
        }
      }
      const trailer = lx.value();
      if (!isDict(trailer)) throw fail('trailer가 사전이 아닙니다');
      return { list, trailer };
    }
    const { value: s } = parseAt(off);
    if (!s || s.t !== 'stream' || nameOf(s.dict.v.get('Type')) !== 'XRef') throw fail('xref를 찾을 수 없습니다');
    const data = decodeStream(s, (r) => get(r.n));
    const W = (s.dict.v.get('W') || []).map((x) => Number(x.raw));
    const size = Number(s.dict.v.get('Size')?.raw || 0);
    const idx = (s.dict.v.get('Index') || [num(0), num(size)]).map((x) => Number(x.raw));
    const width = W[0] + W[1] + W[2], list = [];
    const field = (p, w, def) => { if (!w) return def; let v = 0; for (let k = 0; k < w; k++) v = v * 256 + data[p + k]; return v; };
    let p = 0;
    for (let i = 0; i + 1 < idx.length; i += 2) {
      for (let k = 0; k < idx[i + 1] && p + width <= data.length; k++, p += width) {
        const t = field(p, W[0], 1), f2 = field(p + W[0], W[1], 0), f3 = field(p + W[0] + W[1], W[2], 0);
        list.push([idx[i] + k, t === 1 ? { type: 1, off: f2, gen: f3 } : t === 2 ? { type: 2, stm: f2, idx: f3 } : { type: 0 }]);
      }
    }
    return { list, trailer: s.dict };
  };
  const trySection = (off) => {
    try { return readSection(off); } catch (e) { if (base) { try { return readSection(off + base); } catch {} } throw e; }
  };

  let trailer = null;
  try {
    const sx = buf.lastIndexOf('startxref', buf.length, 'latin1');
    if (sx < 0) throw fail('startxref가 없습니다');
    let off = new Lexer(buf, sx + 9).int();
    const seen = new Set();
    const add = (list) => { for (const [n, e] of list) if (!entries.has(n)) entries.set(n, e); };
    while (off != null && !seen.has(off)) {
      seen.add(off);
      const sec = trySection(off);
      trailer ||= sec.trailer;
      const xs = sec.trailer.v.get('XRefStm'); // 혼합형: 같은 구간의 xref 스트림을 먼저(표는 압축 객체를 free로 적어 둔다)
      if (xs && xs.t === 'num') { try { add(trySection(Number(xs.raw)).list); } catch {} }
      add(sec.list);
      const prev = sec.trailer.v.get('Prev');
      off = prev && prev.t === 'num' ? Number(prev.raw) : null;
    }
    if (!trailer || !trailer.v.get('Root')) throw fail('Root가 없습니다');
  } catch {
    // xref가 깨졌다 → 본문을 훑어 다시 만든다
    entries = new Map(); cache.clear(); stmCache.clear();
    for (const [n, off] of scan()) entries.set(n, { type: 1, off });
    trailer = null;
    const t = buf.lastIndexOf('trailer', buf.length, 'latin1');
    if (t >= 0) { try { const v = new Lexer(buf, t + 7).value(); if (isDict(v)) trailer = v; } catch {} }
    for (const n of [...entries.keys()]) { // 객체 스트림 속 객체와 xref 스트림 트레일러
      let v; try { v = get(n); } catch { continue; }
      if (!v || v.t !== 'stream') continue;
      const type = nameOf(v.dict.v.get('Type'));
      if (type === 'XRef' && !trailer) trailer = v.dict;
      if (type === 'ObjStm') { try { for (const [k, o] of loadObjStm(n)) if (!entries.has(o.n)) entries.set(o.n, { type: 2, stm: n, idx: k }); } catch {} }
    }
    if (!trailer || !trailer.v.get('Root')) {
      const root = [...entries.keys()].find((n) => { try { const v = get(n); return isDict(v) && nameOf(v.v.get('Type')) === 'Catalog'; } catch { return false; } });
      if (root === undefined) throw fail('PDF 구조를 읽을 수 없습니다(xref·Catalog 없음)');
      trailer = trailer || dict([]);
      trailer.v.set('Root', { t: 'ref', n: root, g: 0 });
    }
  }
  const nums = [...entries.keys()].filter((n) => n > 0 && entries.get(n).type !== 0).sort((a, b) => a - b);
  return { version: hm[1], trailer, nums, get };
}

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

// ── 쓰기 ────────────────────────────────────────────────────────────────────
const NAME_OK = (c) => c > 0x20 && c < 0x7f && c !== 0x23 && !IS_DELIM[c];
function writeName(v) {
  let s = '/';
  for (let k = 0; k < v.length; k++) {
    const c = v.charCodeAt(k) & 255;
    s += NAME_OK(c) ? String.fromCharCode(c) : '#' + c.toString(16).padStart(2, '0');
  }
  return s;
}
// 값 → PDF 문법 문자열(latin1). refMap: 옛 번호 → 새 번호(없으면 null). enc: 문자열 암호화 함수(null이면 그대로)
function serialize(o, refMap, enc) {
  if (o === null || o === undefined) return 'null';
  if (o === true) return 'true';
  if (o === false) return 'false';
  if (Array.isArray(o)) return '[' + o.map((x) => serialize(x, refMap, enc)).join(' ') + ']';
  switch (o.t) {
    case 'num': return o.raw;
    case 'name': return writeName(o.v);
    case 'str': return '<' + (enc ? enc(o.v) : o.v).toString('hex') + '>';
    case 'ref': { const n = refMap.get(o.n); return n ? `${n} 0 R` : 'null'; }
    case 'kw': return o.v;
    case 'dict': {
      // 서명 사전의 /Contents는 암호화하지 않는다(7.6.2)
      const sig = ['Sig', 'DocTimeStamp'].includes(nameOf(o.v.get('Type')));
      let s = '<<';
      for (const [k, v] of o.v) s += writeName(k) + ' ' + serialize(v, refMap, sig && k === 'Contents' ? null : enc) + ' ';
      return s + '>>';
    }
    default: throw fail(`알 수 없는 값: ${o.t}`);
  }
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
