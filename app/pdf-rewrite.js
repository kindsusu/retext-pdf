// PDF 바이트 직접 읽기·다시 쓰기 — 암호 걸기(pdf-encrypt.js)와 숨은 데이터 지우기·문서 정보 쓰기(sanitizePdf·setInfoPdf)가 함께 쓴다.
// 읽기: 고전 xref 표 · xref 스트림 · 객체 스트림(/Type /ObjStm) · 증분 저장(/Prev 사슬, 혼합형 /XRefStm). xref가 깨졌으면 "n g obj"를 훑어 다시 만든다.
// 쓰기(writePdf): 트레일러 /Root(·/Info)에서 닿는 객체만 최상위 간접 객체로 풀어(객체 스트림·xref 스트림은 버린다) 번호를 1부터 다시 매기고
//   고전 xref 표로 쓴다. 닿지 않는 객체(PDFium이 남긴 옛 콘텐츠 스트림, 지운 첨부 파일·XMP 스트림)는 쓰지 않는다.
// 외부 의존성 없음(node:zlib · node:crypto).
const zlib = require('zlib');
const crypto = require('crypto');

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

// ── 객체 그래프 ─────────────────────────────────────────────────────────────
// 간접 참조를 따라가며 값 하나와 그 아래를 모두 훑는다. visit(사전, 원래 값)은 사전(스트림의 사전 포함)마다 한 번 불린다.
// 참조 번호마다 한 번만 들어가므로 순환 참조(/Parent ↔ /Kids)에서 멈춘다. 반환값: 닿은 간접 객체 번호 집합
function walk(pdf, starts, visit) {
  const seen = new Set(), stack = [...starts];
  while (stack.length) {
    let v = stack.pop();
    if (v && v.t === 'ref') {
      if (seen.has(v.n)) continue;
      seen.add(v.n);
      try { v = pdf.get(v.n); } catch { continue; } // 깨진 객체는 건너뛴다(쓸 때 null)
    }
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v)) { for (let k = v.length - 1; k >= 0; k--) stack.push(v[k]); continue; }
    const d = v.t === 'stream' ? v.dict : v.t === 'dict' ? v : null;
    if (!d) continue;
    if (visit) visit(d, v);
    for (const x of d.v.values()) stack.push(x);
  }
  return seen;
}

// 트레일러 /Root(·/Info)에서 닿는 객체만 새 번호로 고전 xref PDF로 쓴다(암호 없음). 트레일러 /Info가 직접 사전이면 간접 객체로 뺀다.
// /ID는 그대로 옮긴다(없으면 만들지 않는다)
// opts.dedupe: 사전·바이트가 똑같은 그림 스트림(/Subtype /Image)은 하나만 쓰고 나머지 참조를 그것으로 돌린다 —
//   그림 워터마크는 PDFium이 쪽마다 그림 사본을 만들어 100쪽이면 100벌이 된다. /SMask가 서로 다른 번호여도 같아지도록 여러 번 돈다
function writePdf(pdf, opts = {}) {
  const tr = pdf.trailer.v;
  const rootRef = tr.get('Root');
  if (!rootRef || rootRef.t !== 'ref') throw fail('문서 카탈로그(Root)를 찾을 수 없습니다');
  let info = tr.get('Info');
  const reach = walk(pdf, [rootRef, ...(info && info.t === 'ref' ? [info] : isDict(info) ? [info] : [])]);
  let objs = [...reach].sort((a, b) => a - b).map((n) => {
    let value = null;
    try { value = pdf.get(n); } catch {}
    return { old: n, value };
  }).filter((o) => !(o.value && o.value.t === 'stream' && ['XRef', 'ObjStm'].includes(nameOf(o.value.dict.v.get('Type')))));
  const alias = new Map(); // 지운 사본 번호 → 남긴 번호
  if (opts.dedupe) {
    const named = { get: (n) => alias.get(n) ?? n }; // 비교용 직렬화: 옛 번호 그대로(사본은 남긴 번호로)
    for (let pass = 0, grew = true; grew && pass < 4; pass++) {
      grew = false;
      const keys = new Map();
      for (const o of objs) {
        const v = o.value;
        if (alias.has(o.old) || !v || v.t !== 'stream' || nameOf(v.dict.v.get('Subtype')) !== 'Image') continue;
        const d = new Map(v.dict.v); d.delete('Length');
        const key = crypto.createHash('sha256').update(serialize({ t: 'dict', v: d }, named, null)).update(v.data).digest('hex');
        if (keys.has(key)) { alias.set(o.old, keys.get(key)); grew = true; } else keys.set(key, o.old);
      }
    }
    objs = objs.filter((o) => !alias.has(o.old));
  }
  const refMap = new Map(objs.map((o, k) => [o.old, k + 1]));
  for (const [dup, keep] of alias) refMap.set(dup, refMap.get(keep));
  if (isDict(info)) { objs.push({ old: -1, value: info }); info = objs.length; }
  else info = info && info.t === 'ref' ? refMap.get(info.n) : null;

  const parts = [Buffer.from(`%PDF-${pdf.version || '1.7'}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  let size = parts[0].length;
  const offs = [];
  const push = (b) => { parts.push(b); size += b.length; };
  objs.forEach((o, k) => {
    offs.push(size);
    const v = o.value;
    if (v && v.t === 'stream') {
      v.dict.v.set('Length', num(v.data.length));
      push(Buffer.from(`${k + 1} 0 obj\n${serialize(v.dict, refMap, null)}\nstream\n`, 'latin1'));
      push(v.data);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else push(Buffer.from(`${k + 1} 0 obj\n${serialize(v, refMap, null)}\nendobj\n`, 'latin1'));
  });
  const id = tr.get('ID');
  const idText = Array.isArray(id) && id.length === 2 && id.every((x) => x && x.t === 'str') ? ` /ID [<${id[0].v.toString('hex')}> <${id[1].v.toString('hex')}>]` : '';
  const xref = size;
  push(Buffer.from(`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Size ${objs.length + 1} /Root ${refMap.get(rootRef.n)} 0 R${info ? ` /Info ${info} 0 R` : ''}${idText} >>\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

// 문서 정보 글자 → PDF 문자열 바이트: 출력 가능한 ASCII는 그대로, 그 밖(한글 등)은 UTF-16BE + BOM(FE FF)
function textString(s) {
  const t = String(s ?? '');
  if (/^[\x20-\x7e]*$/.test(t)) return Buffer.from(t, 'latin1');
  const b = Buffer.from('﻿' + t, 'utf16le');
  for (let k = 0; k + 1 < b.length; k += 2) { const x = b[k]; b[k] = b[k + 1]; b[k + 1] = x; } // LE → BE
  return b;
}

// ── 문서 정보(/Info) 쓰기 ─────────────────────────────────────────────────
// PDFium(EPDF_SetMetaText)은 /Info가 없는 문서에 값을 넣어도 저장본 트레일러에 /Info를 달지 않는다(실측 2026-10-14) → 이 함수로 보충한다.
// fields: { Title: '…', Author: '' } — 빈 문자열이면 그 키를 지운다. 닿지 않는 객체는 함께 떨어진다(writePdf)
function setInfoPdf(input, fields) {
  const pdf = parsePdf(input);
  const tr = pdf.trailer.v;
  let info = tr.get('Info');
  if (info && info.t === 'ref') info = pdf.get(info.n);
  if (!isDict(info)) { info = dict([]); tr.set('Info', info); }
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === '') info.v.delete(k);
    else info.v.set(k, { t: 'str', v: textString(v) });
  }
  return writePdf(pdf);
}

// ── 숨은 데이터 지우기 ──────────────────────────────────────────────────────
// opts: { info, xmp, attachments, annotations, bookmarks, javascript } (true인 것만 지운다)
// 지우는 것:
//   info        트레일러 /Info(제목·작성자·만든 프로그램·날짜 등 전부)
//   xmp         모든 사전의 /Metadata(문서 카탈로그의 XMP뿐 아니라 쪽·이미지·글꼴에 달린 XMP 스트림까지)
//   attachments 이름 트리 /EmbeddedFiles, 카탈로그 /AF(연결 파일), 쪽의 /FileAttachment 주석
//   annotations 쪽의 주석 중 링크(/Link)와 양식 칸(/Widget)을 뺀 전부(메모·형광펜·도형·잉크·팝업…)
//   bookmarks   카탈로그 /Outlines(목차) — /PageMode /UseOutlines도 뗀다
//   javascript  이름 트리 /JavaScript, 모든 /AA(자동 동작), 값이 자바스크립트 동작인 /OpenAction·/A·/Next
// 지우지 않는 것: XFA 양식 안의 스크립트(/AcroForm /XFA), 쪽 내용 안의 글자·그림, /PieceInfo(앱 전용 데이터), 이름 붙은 목적지(/Dests),
//   양식 칸 값, 글꼴 이름, 문서 /ID. 지운 객체를 가리키던 곳만 끊고, 닿지 않게 된 객체는 쓰지 않는다(writePdf) — 파일 바이트에 남지 않는다
// 돌려주는 removed는 지운 개수(info는 키 개수, 나머지는 항목 수)
function sanitizePdf(input, opts = {}) {
  const pdf = parsePdf(input);
  const R = (o) => { try { return o && o.t === 'ref' ? pdf.get(o.n) : o; } catch { return null; } };
  const removed = { info: 0, xmp: 0, attachments: 0, annotations: 0, bookmarks: 0, javascript: 0 };
  const tr = pdf.trailer.v, root = R(tr.get('Root'));
  if (!isDict(root)) throw fail('문서 카탈로그(Root)를 찾을 수 없습니다');
  // 참조로 한 번 들른 객체는 다시 세지 않는다(순환 방지)
  const visitOnce = (seen, ref) => {
    if (!ref || ref.t !== 'ref') return true;
    if (seen.has(ref.n)) return false;
    seen.add(ref.n);
    return true;
  };

  if (opts.info) {
    const info = R(tr.get('Info'));
    if (isDict(info)) removed.info = info.v.size;
    tr.delete('Info');
  }
  if (opts.bookmarks) {
    const outlines = R(root.v.get('Outlines'));
    if (isDict(outlines)) { // 항목 수: First → Next 사슬, 하위는 First로
      const seen = new Set(), stack = [outlines.v.get('First')];
      while (stack.length && seen.size < 100000) {
        const ref = stack.pop(), it = R(ref);
        if (!isDict(it) || !visitOnce(seen, ref)) continue;
        removed.bookmarks++;
        stack.push(it.v.get('Next'), it.v.get('First'));
      }
    }
    root.v.delete('Outlines');
    if (nameOf(root.v.get('PageMode')) === 'UseOutlines') root.v.delete('PageMode');
  }
  // 이름 트리 잎 개수(/Names [키 값 …] · /Kids)
  const leaves = (tree) => {
    let n = 0;
    const seen = new Set(), stack = [tree];
    while (stack.length && seen.size < 100000) {
      const ref = stack.pop(), t = R(ref);
      if (!isDict(t) || !visitOnce(seen, ref)) continue;
      const list = R(t.v.get('Names'));
      if (Array.isArray(list)) n += Math.floor(list.length / 2);
      const kids = R(t.v.get('Kids'));
      if (Array.isArray(kids)) stack.push(...kids);
    }
    return n;
  };
  const names = R(root.v.get('Names'));
  if (isDict(names)) {
    if (opts.javascript && names.v.has('JavaScript')) { removed.javascript += leaves(names.v.get('JavaScript')); names.v.delete('JavaScript'); }
    if (opts.attachments && names.v.has('EmbeddedFiles')) { removed.attachments += leaves(names.v.get('EmbeddedFiles')); names.v.delete('EmbeddedFiles'); }
  }
  if (opts.attachments && root.v.has('AF')) { const af = R(root.v.get('AF')); removed.attachments += Array.isArray(af) ? af.length : 1; root.v.delete('AF'); }

  // 쪽 주석: 쪽 트리를 따라 /Annots 배열을 거른다
  if (opts.annotations || opts.attachments) {
    const seen = new Set(), stack = [root.v.get('Pages')];
    while (stack.length) {
      const ref = stack.pop(), node = R(ref);
      if (!isDict(node) || !visitOnce(seen, ref)) continue;
      const kids = R(node.v.get('Kids'));
      if (Array.isArray(kids)) { stack.push(...kids); continue; }
      const annots = R(node.v.get('Annots'));
      if (!Array.isArray(annots)) continue;
      const keep = annots.filter((a) => {
        const ad = R(a), sub = isDict(ad) ? nameOf(ad.v.get('Subtype')) : null;
        if (opts.annotations && !['Link', 'Widget'].includes(sub)) { removed.annotations++; return false; }
        if (opts.attachments && sub === 'FileAttachment') { removed.attachments++; return false; }
        return true;
      });
      if (keep.length === annots.length) continue;
      if (keep.length) node.v.set('Annots', keep); else node.v.delete('Annots');
    }
  }

  // 자바스크립트 동작인가: /S /JavaScript 또는 /JS 키를 가진 동작 사전(Rendition 동작의 /JS 포함)
  const isJs = (o) => { const d = R(o); return isDict(d) && (nameOf(d.v.get('S')) === 'JavaScript' || d.v.has('JS')); };
  if (opts.xmp || opts.javascript) {
    walk(pdf, [tr.get('Root'), ...(tr.has('Info') ? [tr.get('Info')] : [])], (d) => {
      if (opts.xmp && d.v.has('Metadata')) { removed.xmp++; d.v.delete('Metadata'); }
      if (!opts.javascript) return;
      if (d.v.has('AA')) { removed.javascript++; d.v.delete('AA'); }
      for (const k of ['OpenAction', 'A', 'Next']) {
        if (!d.v.has(k)) continue;
        const v = R(d.v.get(k));
        if (Array.isArray(v)) { // /Next는 동작 배열일 수 있다
          const left = v.filter((x) => !isJs(x));
          if (left.length !== v.length) { removed.javascript += v.length - left.length; if (left.length) d.v.set(k, left); else d.v.delete(k); }
        } else if (isJs(v)) { removed.javascript++; d.v.delete(k); }
      }
    });
  }
  return { bytes: writePdf(pdf), removed };
}

module.exports = { fail, num, name, dict, isDict, nameOf, Lexer, inflate, decodeStream, parsePdf, writeName, serialize, walk, writePdf, textString, setInfoPdf, sanitizePdf };
