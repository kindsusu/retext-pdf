// PDFium(WASM) 얇은 래퍼 — 열기 / 렌더(PNG·JPEG) / 객체 목록 / 텍스트 교체
//   / 페이지 삭제 · 병합 · 회전 · 순서 변경 · 추출 / 텍스트 검색 / 이미지 삽입 · 다운샘플링 / 저장
// 계약: PLAN.md P2 "엔진 계약", PLAN-P4.md·PLAN-P5.md "WP-A 엔진 계약" 참고.
const fs = require('fs');
const fontkit = require('fontkit');
const jpeg = require('jpeg-js'); // 페이지 JPEG 내보내기 · 이미지 삽입 · 다운샘플링의 인코더 (동기, 순수 JS)
const fontRegistry = require('./pdf-fonts');
const crypto = require('crypto');

const MARK_MASK = 'RetextPdfMask', MARK_GROUP = 'RetextPdfGroup';
const MARK_PAGENUM = 'RetextPdfPageNum'; // 쪽 번호 글자. 다시 매기면 이 마크가 달린 객체를 지우고 새로 넣는다
const MARK_HF = 'RetextPdfHeaderFooter'; // 머리말·꼬리말 글자(다시 넣으면 교체)
const MARK_WM = 'RetextPdfWatermark';    // 워터마크 글자·그림(다시 넣으면 모든 쪽에서 교체)
const MARK_BATES = 'RetextPdfBates';      // v6 Wave D: 베이츠 번호(접두어 + 0을 채운 번호 + 접미어). 다시 넣으면 모든 쪽에서 교체
const MARK_STYLE = 'RetextPdfStyle';     // v6: 고른 글자에 준 모양(밑줄·취소선·가짜 굵게·가짜 기울임·첨자) — 글을 고쳐 써도 따라간다
const MARK_DECO = 'RetextPdfDeco';       // v6: 밑줄·취소선 선(얇은 채움 사각형). syncDeco가 RetextPdfStyle에서 다시 그린다
// v6 Wave B: 원래 글꼴에 없는 글자 때문에 다른 글꼴로 다시 그린 글자 조각. orig(원래 글꼴 이름)·used(쓴 글꼴)·kind('family' 같은 집안 설치 폰트 |
// 'mono' 고정폭 대체 | 'fallback' 맑은 고딕)·b/it/mono(원래 굵기·기울임·고정폭)·sid(이 앱 실행 — 저장 전 경고는 이번 실행에서 바꾼 것만 보인다)
const MARK_SUBST = 'RetextPdfSubst';
const SESSION_ID = crypto.randomBytes(6).toString('hex');
// 고정폭 원래 글꼴(코드·표)의 대체 후보 — 같은 집안이 설치돼 있지 않을 때 맑은 고딕보다 먼저(글자가 다 있는 첫 집안)
const MONO_FAMILIES = ['Consolas', 'D2Coding', 'Courier New'];
const META_KEYS = ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'];
const META_EDITABLE = ['Title', 'Author', 'Subject', 'Keywords'];

const OBJ_TEXT = 1, OBJ_PATH = 2, OBJ_IMAGE = 3; // FPDF_PAGEOBJ_*
const RENDER_FLAGS = 0x01 | 0x10;                // FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER(=RGBA로 뽑기)
const FPDF_FONT_TRUETYPE = 2;
// FPDFText_FindStart 플래그 (실측 2026-09-09, sample.pdf: "SAMPLE" flags 0 → 1건 / flags 1 → 0건, "sam" flags 2 → 0건)
const FIND_MATCHCASE = 1, FIND_MATCHWHOLEWORD = 2;
const FIND_LIMIT = 500; // 한 페이지에서 가져올 최대 결과 수(폭주 방지). 서버가 문서 전체를 합칠 때도 같은 상한을 쓴다
const LINE_HEIGHT = 1.2; // 줄바꿈 편집 시 행간(글자 크기 배수). PDF는 행간 정보를 주지 않는다

// FPDFBitmap_* 포맷 (FPDFBitmap_GetFormat). 픽셀당 바이트 수가 다르다
const BMP_GRAY = 1, BMP_BGR = 2, BMP_BGRx = 3, BMP_BGRA = 4;
const BMP_BYTES = { [BMP_GRAY]: 1, [BMP_BGR]: 3, [BMP_BGRx]: 4, [BMP_BGRA]: 4 };

// 폴백 한글 폰트 후보 (윈도우 기준). 없으면 폴백 불가 → setText가 ok:false.
const FALLBACK_FONTS = [
  'C:\\Windows\\Fonts\\malgun.ttf',
  'C:\\Windows\\Fonts\\malgunbd.ttf',
  'C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
];

// ── 폴백 폰트 서브셋 ───────────────────────────────────────────────────────
// 맑은 고딕 전체(7.5MB)를 FPDFText_LoadFont에 넘기면 PDFium이 서브셋 없이 그대로 임베드한다.
// → 편집에 쓰인 글자만 남긴 TTF를 만들어 넘긴다.
// 라이브러리는 fontkit(순수 JS·동기). subset-font(HarfBuzz wasm)는 cmap까지 챙겨주지만 async라
// 동기 계약인 setText에서 쓸 수 없다.
// fontkit의 TTF 서브셋은 cmap을 만들지 않는다(pdfkit은 글리프 ID로 직접 그려서 필요 없음).
// PDFium은 FPDFText_SetText에서 cmap으로 유니코드→글리프를 찾으므로 cmap이 없으면 전부 두부(□)로 그려진다.
// → format 4 cmap을 직접 만들어 붙인다. (BMP 밖 글자는 format 12가 필요 — 한글에는 안 쓰인다)
const _fkCache = new Map();
function subsetTTF(path, chars, index = 0) {
  const key = `${path}#${index}`; // 글꼴 모음(TTC — 바탕·굴림)은 면 번호까지
  let f = _fkCache.get(key);
  if (!f) { f = fontkit.openSync(path); if (f.fonts) f = f.fonts[index] || f.fonts[0]; _fkCache.set(key, f); }
  const sub = f.createSubset();
  const map = [];
  for (const ch of chars) {
    const cp = ch.codePointAt(0);
    if (cp > 0xffff) continue;              // BMP만
    const g = f.glyphForCodePoint(cp);
    if (!g || !g.id) continue;              // 폰트에 없는 글자 → 넣지 않으면 canRender가 notdef로 잡는다
    map.push([cp, sub.includeGlyph(g.id)]);
  }
  map.sort((a, b) => a[0] - b[0]);
  return addTable(Buffer.from(sub.encode()), 'cmap', cmap4(map));
}

// cmap format 4: 글자 하나당 세그먼트 하나(수십 글자뿐이라 압축할 이유가 없다) + 필수 0xFFFF 종단
function cmap4(pairs) {
  const n = pairs.length + 1, sel = Math.floor(Math.log2(n));
  const b = Buffer.alloc(28 + n * 8);
  b.writeUInt16BE(0, 0); b.writeUInt16BE(1, 2);           // version, numTables
  b.writeUInt16BE(3, 4); b.writeUInt16BE(1, 6);           // platformID 3(Windows), encodingID 1(BMP)
  b.writeUInt32BE(12, 8);                                 // subtable offset
  b.writeUInt16BE(4, 12); b.writeUInt16BE(16 + n * 8, 14); b.writeUInt16BE(0, 16); // format, length, language
  b.writeUInt16BE(n * 2, 18);                             // segCountX2
  b.writeUInt16BE(2 << sel, 20); b.writeUInt16BE(sel, 22); b.writeUInt16BE(n * 2 - (2 << sel), 24);
  const end = 26, start = end + n * 2 + 2, delta = start + n * 2; // idRangeOffset[]은 전부 0
  [...pairs, [0xffff, 0x10000]].forEach(([cp, gid], i) => {
    b.writeUInt16BE(cp, end + i * 2);
    b.writeUInt16BE(cp, start + i * 2);
    b.writeUInt16BE((gid - cp) & 0xffff, delta + i * 2);  // idDelta는 uint16 mod 연산
  });
  return b;
}

const u32 = (b, i) => ((((b[i] || 0) << 24) | ((b[i + 1] || 0) << 16) | ((b[i + 2] || 0) << 8) | (b[i + 3] || 0)) >>> 0);
const checksum = (b) => { let s = 0; for (let i = 0; i < b.length; i += 4) s = (s + u32(b, i)) >>> 0; return s; };

// sfnt에 테이블 하나를 끼워 넣고 디렉터리를 다시 쓴다 (head.checkSumAdjustment는 손대지 않는다 — FreeType이 안 본다)
function addTable(ttf, tag, data) {
  const tables = [{ tag, data }];
  for (let i = 0, p = 12; i < ttf.readUInt16BE(4); i++, p += 16) {
    const off = ttf.readUInt32BE(p + 8), len = ttf.readUInt32BE(p + 12);
    tables.push({ tag: ttf.toString('latin1', p, p + 4), data: ttf.subarray(off, off + len) });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const n = tables.length, sel = Math.floor(Math.log2(n));
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(n, 4);
  dir.writeUInt16BE(16 << sel, 6); dir.writeUInt16BE(sel, 8); dir.writeUInt16BE(n * 16 - (16 << sel), 10);
  const parts = [dir];
  let off = dir.length;
  tables.forEach((t, i) => {
    const p = 12 + i * 16, pad = (4 - (t.data.length % 4)) % 4;
    dir.write(t.tag, p, 'latin1');
    dir.writeUInt32BE(checksum(t.data), p + 4);
    dir.writeUInt32BE(off, p + 8);
    dir.writeUInt32BE(t.data.length, p + 12);
    parts.push(t.data);
    if (pad) parts.push(Buffer.alloc(pad));
    off += t.data.length + pad;
  });
  return Buffer.concat(parts);
}

// 초기화 Promise를 기억한다 — 초기화가 끝나기 전에 두 호출자가 들어와도 WASM 모듈은 하나만 만든다. 실패하면 다음 호출이 다시 시도한다
let _P = null;
function pdfium() {
  return _P ||= (async () => {
    const wasmBinary = fs.readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'));
    const P = await require('@embedpdf/pdfium').init({ wasmBinary });
    P.PDFiumExt_Init();
    require('./pdf-system-fonts').install(P);
    return P;
  })().catch((e) => { _P = null; throw e; });
}

// FPDF_LoadMemDocument 실패 이유. FPDF_GetLastError 4 = FPDF_ERR_PASSWORD
const isPasswordError = (P) => P.FPDF_GetLastError() === 4;
// 암호 오류는 code로 구분한다 — 서버가 "암호 입력"(PASSWORD_REQUIRED)과 "암호 틀림"(PASSWORD_WRONG)을 다르게 응답한다
const passwordError = (given) => Object.assign(
  new Error(given ? '암호가 맞지 않습니다.' : '암호가 걸린 PDF입니다. 암호를 입력하세요.'),
  { code: given ? 'PASSWORD_WRONG' : 'PASSWORD_REQUIRED' });
const FPDF_REMOVE_SECURITY = 3; // FPDF_SaveAsCopy 플래그
// FPDF_GetDocPermissions 중 사용자가 체감하는 권한 비트(인쇄 4·수정 8·복사 16·주석 32·양식 256·추출 512·조립 1024·고품질 인쇄 2048)
const PERM_ALL = 0xf3c;

// 저장 루틴 — api.save()와 모듈 함수 merge()가 함께 쓴다 (FPDF_SaveAsCopy + 파일 라이터 콜백)
// 암호화된 문서는 암호를 벗겨 저장한다(FPDF_REMOVE_SECURITY). PDFiumExt_SaveAsCopy는 암호화를 그대로 남겨
// (실측 2026-10-14: AES-128 문서를 저장한 바이트를 암호 없이 다시 열면 FPDF_ERR_PASSWORD) 실행 취소 스냅샷·편집 검증 재열기가 모두 막힌다.
// 파일 라이터가 FPDF_FILEWRITE 구조라 FPDF_SaveAsCopy에 그대로 넘길 수 있다. 암호 없는 문서는 예전 경로 그대로(출력 바이트 불변)
function saveDoc(P, doc) {
  const M = P.pdfium;
  const w = P.PDFiumExt_OpenFileWriter();
  try {
    const plain = P.FPDF_GetSecurityHandlerRevision(doc) === -1;
    if (!(plain ? P.PDFiumExt_SaveAsCopy(doc, w) : P.FPDF_SaveAsCopy(doc, w, FPDF_REMOVE_SECURITY))) throw new Error('저장 실패');
    const size = P.PDFiumExt_GetFileWriterSize(w);
    const out = M._malloc(size);
    try {
      P.PDFiumExt_GetFileWriterData(w, out, size);
      return Buffer.from(M.HEAPU8.subarray(out, out + size));
    } finally { M._free(out); }
  } finally { P.PDFiumExt_CloseFileWriter(w); }
}

// 여러 PDF를 순서대로 이어 붙인다. buffers는 파일 바이트 배열.
// FPDF_ImportPages(dest, src, pagerange, index) — pagerange가 null(0)이면 문서 전체를 가져온다(실측 2026-09-09).
// 원본 버퍼는 저장이 끝날 때까지 힙에 남겨 둔다(FPDF_LoadMemDocument는 복사하지 않는다).
async function merge(buffers) {
  const list = [].concat(buffers || []);
  if (!list.length) throw new Error('병합할 파일이 없습니다.');
  const P = await pdfium();
  const M = P.pdfium;
  const dest = P.FPDF_CreateNewDocument();
  if (!dest) throw new Error('새 PDF를 만들지 못했습니다.');
  const ptrs = [], docs = [];
  try {
    for (let n = 0; n < list.length; n++) {
      const b = Buffer.isBuffer(list[n]) ? list[n] : Buffer.from(list[n] || []);
      if (!b.length) throw new Error(`${n + 1}번째 파일을 열 수 없습니다: 내용이 비어 있습니다`);
      const ptr = M._malloc(b.length);
      M.HEAPU8.set(b, ptr);
      ptrs.push(ptr);
      const src = P.FPDF_LoadMemDocument(ptr, b.length, 0);
      if (!src) throw new Error(`${n + 1}번째 파일을 열 수 없습니다: ${isPasswordError(P) ? '암호가 걸린 PDF입니다. 암호를 푼 뒤 다시 넣으세요.' : '손상된 파일입니다'}`);
      docs.push(src);
      if (!P.FPDF_ImportPages(dest, src, null, P.FPDF_GetPageCount(dest))) {
        throw new Error(`${n + 1}번째 파일의 페이지를 가져올 수 없습니다`);
      }
    }
    if (!P.FPDF_GetPageCount(dest)) throw new Error('가져올 페이지가 없습니다.');
    return saveDoc(P, dest);
  } finally {
    for (const d of docs) P.FPDF_CloseDocument(d);
    P.FPDF_CloseDocument(dest);
    for (const p of ptrs) M._free(p);
  }
}

// 정수 배율 박스 필터(순수 JS). src는 촘촘한 RGBA, 결과도 촘촘한 RGBA(알파 255 고정 — JPEG로 갈 픽셀이라 알파는 쓰지 않는다)
function boxDown(src, w, h, factor) {
  const nw = Math.max(1, Math.floor(w / factor)), nh = Math.max(1, Math.floor(h / factor));
  const out = Buffer.alloc(nw * nh * 4);
  const n = factor * factor;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < factor; dy++) {
        let p = ((y * factor + dy) * w + x * factor) * 4;
        for (let dx = 0; dx < factor; dx++, p += 4) { r += src[p]; g += src[p + 1]; b += src[p + 2]; }
      }
      const q = (y * nw + x) * 4;
      out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

// RGBA 픽셀 → JPEG 바이트. JPEG는 투명을 지원하지 않으므로 알파는 흰 배경에 합성해 없앤다.
function encodeJpeg(data, width, height, quality) {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  let px = data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 255) continue;
    if (px === data) px = Buffer.from(data);           // 원본을 건드리지 않는다
    const a = px[i] / 255;
    px[i - 3] = px[i - 3] * a + 255 * (1 - a);
    px[i - 2] = px[i - 2] * a + 255 * (1 - a);
    px[i - 1] = px[i - 1] * a + 255 * (1 - a);
    px[i] = 255;
  }
  return Buffer.from(jpeg.encode({ data: px, width, height }, q).data);
}

// v6 Wave D 링크 주소: http(s)·mailto만 받는다(javascript:·file: 등은 400). 한글 등 ASCII 밖 글자는 퍼센트 인코딩(URL 표준)
function normalizeLinkUri(raw) {
  const s = String(raw ?? '').trim();
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (!s || s.length > 2000) throw fail('링크 주소는 1~2000자로 입력하세요.');
  if (/^mailto:/i.test(s)) return encodeURI(decodeSafe(s));
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+\.[^:/]+:\d/.test(s) ? s : 'https://' + s; // 'example.com/a'처럼 스킴이 없으면 https
  let u;
  try { u = new URL(withScheme); } catch { throw fail('링크 주소를 읽을 수 없습니다. https://로 시작하는 주소를 입력하세요.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw fail('링크 주소는 http(s):// 또는 mailto: 만 넣을 수 있습니다.');
  return u.href;
}
function decodeSafe(s) { try { return decodeURI(s); } catch { return s; } }

// password: 여는 암호(사용자 암호). 없으면 빈 암호로 연다 — 소유자 암호만 걸린(권한 제한) 문서는 PDFium이 빈 암호로 연다
async function open(buffer, password) {
  const P = await pdfium();
  const M = P.pdfium; // emscripten 모듈 (_malloc/_free/HEAPU8/getValue/...)

  // 힙은 메모리 성장 시 재할당되므로 매번 새로 참조한다.
  const heap = () => M.HEAPU8;
  const mal = (n) => M._malloc(n);
  const free = (p) => M._free(p);
  const f32 = (p) => M.getValue(p, 'float');
  const i32 = (p) => M.getValue(p, 'i32');
  const f64 = (p) => M.getValue(p, 'double');
  const utf16 = (s) => { const p = mal((s.length + 1) * 2); M.stringToUTF16(s, p, (s.length + 1) * 2); return p; };

  // FPDF_LoadMemDocument는 버퍼를 복사하지 않는다 → close()까지 살려둔다.
  const srcPtr = mal(buffer.length);
  heap().set(buffer, srcPtr);
  const given = typeof password === 'string' && password ? password : 0;
  const doc = P.FPDF_LoadMemDocument(srcPtr, buffer.length, given);
  if (!doc) { const pw = isPasswordError(P); free(srcPtr); throw pw ? passwordError(!!given) : new Error('PDF를 열 수 없습니다 (손상된 파일)'); }
  // 보안 정보: encrypted = 보안 처리기가 있다, openPassword = 여는 암호가 있어야 열린다, restricted = 권한(인쇄·복사 등)이 다 풀려 있지 않다.
  // 소유자 암호로 열었거나(PDFium이 권한을 다 준다) 사용자 암호로 열어도 권한 비트가 다 서 있으면 restricted가 아니다.
  // openPassword: 암호를 받아 열었을 때만 빈 암호로 한 번 더 열어 본다 — 빈 암호로도 열리면 소유자 암호만 걸린 문서다(잘못 넘긴 암호)
  const security = (() => {
    const rev = P.FPDF_GetSecurityHandlerRevision(doc);
    if (rev === -1) return { encrypted: false, openPassword: false, restricted: false };
    let openPassword = false;
    if (given) { const probe = P.FPDF_LoadMemDocument(srcPtr, buffer.length, 0); if (probe) P.FPDF_CloseDocument(probe); else openPassword = true; }
    return { encrypted: true, openPassword, restricted: ((P.FPDF_GetDocPermissions(doc) >>> 0) & PERM_ALL) !== PERM_ALL };
  })();

  const pages = new Map();
  const page = (i) => {
    if (!pages.has(i)) {
      const h = P.FPDF_LoadPage(doc, i);
      if (!h) throw new Error(`page ${i} 로드 실패`);
      pages.set(i, h);
    }
    return pages.get(i);
  };

  // 콘텐츠 스트림 다시 쓰기. PDFium은 한 세션에서 같은 페이지에 FPDFPage_GenerateContent를 두 번째 부를 때부터
  // 페이지 전체를 새 스트림으로 쓰고 옛 스트림을 고아로 남긴다(SaveAsCopy가 고아도 저장한다).
  // 실측: 48조각 한 줄 편집이 48번 불러 1.4MB 벡터 PDF가 27MB, 편집 6–9초. 페이지당 한 번이면 저장·재열기 5회에도 1.31MB 그대로.
  // → batch() 안에서는 페이지만 기록해 두고 가장 바깥 batch가 끝날 때 페이지당 한 번만 부른다.
  //   렌더·텍스트 페이지·객체 목록은 메모리의 페이지 객체로 동작하므로 batch 중에 다시 쓴 스트림이 필요 없다.
  //   저장·페이지 가져오기(추출)는 스트림을 읽으므로 그 전에 flush한다. 페이지 핸들을 닫기 전(삭제·순서 변경)에도 flush한다.
  let batchDepth = 0;
  const pending = new Set(); // 다시 써야 할 페이지 핸들
  const regen = (p) => { if (batchDepth) pending.add(p); else P.FPDFPage_GenerateContent(p); };
  const flush = () => { for (const p of pending) P.FPDFPage_GenerateContent(p); pending.clear(); };

  // 폴백 폰트: 굵기별로 "지금까지 쓴 글자" 서브셋 하나를 유지한다.
  // 이미 올린 서브셋이 새 텍스트를 다 덮으면 그대로 재사용, 아니면 (기존 ∪ 새 글자)로 다시 서브셋해 새로 올린다.
  // ponytail: 합집합이라 이전 서브셋과 글리프가 겹쳐 중복 임베드된다(글자당 ~0.5KB).
  //   새 글자만 담으면 중복은 없지만 편집마다 폰트 객체가 늘어나고 헤더/공통 테이블이 매번 붙는다. 편집 수십 건 규모라 합집합이 싸다.
  const fbPtrs = [];                        // 문서가 닫힐 때까지 살려둬야 하는 폰트 버퍼 (PDFium이 복사하지 않는다)
  const fb = { regular: null, bold: null }; // { font, chars:Set }
  const customFonts = new Map();
  let selectedFont = null;
  function customFont(entry, text) {
    const cur = customFonts.get(entry.id);
    if (cur && [...text].every((c) => cur.chars.has(c))) return cur.font;
    const chars = new Set([...(cur?.chars || []), ...text]);
    const data = subsetTTF(entry.path, chars, entry.index || 0), ptr = mal(data.length);
    heap().set(data, ptr); fbPtrs.push(ptr);
    const font = P.FPDFText_LoadFont(doc, ptr, data.length, FPDF_FONT_TRUETYPE, true);
    if (!font) throw new Error('선택한 폰트를 PDF에 넣지 못했습니다.');
    customFonts.set(entry.id, { font, chars });
    fbBold.set(font, /bold|black|heavy/i.test(entry.label));
    return font;
  }
  function fallbackFont(bold, text) {
    const key = bold ? 'bold' : 'regular';
    const cur = fb[key];
    if (cur && [...text].every((c) => cur.chars.has(c))) return cur.font;
    const cands = bold ? ['C:\\Windows\\Fonts\\malgunbd.ttf', ...FALLBACK_FONTS] : FALLBACK_FONTS;
    const path = cands.find((p) => fs.existsSync(p));
    if (!path) return 0;
    const chars = new Set([...(cur ? cur.chars : []), ...text]);
    const data = subsetTTF(path, chars);
    const ptr = mal(data.length);
    heap().set(data, ptr);
    fbPtrs.push(ptr);
    const font = P.FPDFText_LoadFont(doc, ptr, data.length, FPDF_FONT_TRUETYPE, true);
    if (process.env.RETEXTPDF_DEBUG) console.error('[fallbackFont]', key, path.split(/[\\/]/).pop(), 'chars', chars.size, 'bytes', data.length, 'font', font);
    if (!font) return 0;
    fb[key] = { font, chars, label: fontRegistry.byPath(path)?.label || path.split(/[\\/]/).pop().replace(/\.tt[fc]$/i, '') };
    fbBold.set(font, !!bold);
    return font;
  }

  // 글리프 존재 확인 (실측으로 고른 방법):
  //   - FPDFFont_GetGlyphWidth: 글리프가 없어도 기본 폭을 돌려줌 → 못 씀.
  //   - FPDFFont_GetGlyphPath(font, unicode, size):
  //       표준/비CID 폰트(Helvetica)는 없는 글자에 0(null)을 준다.
  //       CID 서브셋 폰트(AAAAAA+MalgunGothicBold 같은 워드/한글 내보내기)는 0이 아니라
  //       '.notdef' 글리프 패스를 준다. 이때 없는 글자들은 전부 같은 포인터(캐시된 glyph 0)다.
  //     → 사설영역(PUA) 코드포인트로 notdef 포인터를 먼저 뽑아 두고, 그 포인터와 같으면 없는 글자로 본다.
  //       (PUA 두 개가 서로 다른 패스를 주면 notdef 판별을 포기하고 0 검사만 쓴다)
  //   공백류는 원래 빈 패스(0)라 검사에서 제외.
  // FPDFPageObjMark_GetName(mark, buffer, buflen, out_buflen) — buffer는 UTF-16LE. 먼저 0,0으로 불러 필요 바이트 수를 받는다.
  const markName = (mark) => {
    const outLen = mal(4);
    try {
      if (!P.FPDFPageObjMark_GetName(mark, 0, 0, outLen)) return '';
      const need = i32(outLen);
      if (!need) return '';
      const buf = mal(need);
      try { return P.FPDFPageObjMark_GetName(mark, buf, need, outLen) ? M.UTF16ToString(buf) : ''; }
      finally { free(buf); }
    } finally { free(outLen); }
  };

  const canRender = (font, text, size) => {
    const sz = size || 12;
    const a = P.FPDFFont_GetGlyphPath(font, 0xe000, sz);
    const notdef = a && a === P.FPDFFont_GetGlyphPath(font, 0xf8ff, sz) ? a : 0;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      const gp = P.FPDFFont_GetGlyphPath(font, ch.codePointAt(0), sz);
      if (!gp || gp === notdef) return false;
    }
    return true;
  };

  // 원본·대체 글꼴 어디에도 없는 글자가 있어 고칠 수 없을 때의 안내 — 어떤 글자인지 몇 개 보여 준다
  const noGlyphReason = (font, text, size) => {
    if (!font) return '이 글자를 그릴 대체 글꼴(맑은 고딕)을 찾지 못해 고칠 수 없습니다.';
    const miss = [...new Set([...text].filter((ch) => !canRender(font, ch, size)))].slice(0, 8);
    return `이 줄의 일부 글자(수식 기호·이모지 등)는 대체 글꼴에도 없어 고칠 수 없습니다${miss.length ? ': ' + miss.join(' ') : '.'}`;
  };

  // 굵기 판정: 우리가 올린 대체 폰트는 이름이 "Untitled"라 이름으로 알 수 없다 → 올릴 때 기억한 굵기(fbBold)를 쓴다.
  // 그 외에는 이름(Bold/Black/Heavy) 또는 PDFium이 읽은 weight(≥600). 이 판정이 틀리면 폭 맞춤의 두 번째 SetText에서 굵은 글자가 보통 굵기로 떨어진다(사용자 보고).
  const fbBold = new Map(); // 폰트 핸들 → bold
  const isBold = (o) => {
    const font = P.FPDFTextObj_GetFont(o);
    if (fbBold.has(font)) return fbBold.get(font);
    const nb = mal(256); const name = P.FPDFFont_GetBaseFontName(font, nb, 256) ? M.UTF8ToString(nb) : ''; free(nb);
    const w = P.FPDFFont_GetWeight ? P.FPDFFont_GetWeight(font) : 0;
    return /bold|black|heavy/i.test(name) || w >= 600;
  };

  // ── v6 Wave B: 대체 글꼴 고르기 ─────────────────────────────────────────────
  // 원래 글꼴(대개 쓴 글자만 담은 서브셋)에 없는 글자를 넣을 때, 예전에는 늘 맑은 고딕이었다(코드 글꼴 Consolas 조각도 맑은 고딕이 됐다).
  // 이제 ① 같은 이름의 설치 폰트(서브셋 접두어·PostScript 꼬리를 떼고 이름표의 모든 언어 집안 이름과 비교, 굵기·기울임 맞춤)
  //      ② 원래 글꼴이 고정폭이면 설치된 고정폭(Consolas → D2Coding → Courier New, 글자가 다 있는 첫 집안) ③ 맑은 고딕(굵기 유지) 순서로 고른다.
  // 다시 그린 조각에는 RetextPdfSubst(원래 이름·쓴 글꼴·원래 굵기/기울임/고정폭)를 남긴다 — 다음 편집도 같은 규칙(원래 이름 기준)으로 고르고, 저장 전 경고가 읽는다
  // PDF 글꼴 이름 바이트: UTF-8이 아니면 CP949(한글 윈도 문서의 "#B9#D9#C5#C1" = 바탕)로 푼다
  const fontNameOf = (font) => {
    const nb = mal(256);
    try {
      const n = P.FPDFFont_GetBaseFontName(font, nb, 256);
      if (!n) return '';
      const bytes = Buffer.from(heap().subarray(nb, nb + Math.min(255, n))), end = bytes.indexOf(0);
      const raw = end >= 0 ? bytes.subarray(0, end) : bytes;
      try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { try { return new TextDecoder('euc-kr').decode(raw); } catch { return raw.toString('latin1'); } }
    } finally { free(nb); }
  };
  const isItalicFont = (o, name) => {
    if (/italic|oblique/i.test(name)) return true;
    const ia = mal(4);
    try { return !!(P.FPDFFont_GetItalicAngle(P.FPDFTextObj_GetFont(o), ia) && i32(ia) !== 0); } finally { free(ia); }
  };
  // 고정폭: 글꼴 서술자 Flags의 FixedPitch(1) 또는 이름(Courier·Consolas·Mono·Coding·…Che — 바탕체·굴림체)
  const isMonoFont = (o, name) => !!((P.FPDFFont_GetFlags ? P.FPDFFont_GetFlags(P.FPDFTextObj_GetFont(o)) : 0) & 1)
    || /courier|consol|mono|coding|typewriter|fixed|che$/i.test(String(name || '').replace(/^[A-Z]{6}\+/, '').replace(/[-,](bold|italic|regular|oblique)+$/i, ''));
  const SUBST_KEYS = ['orig', 'used', 'kind', 'b', 'it', 'mono', 'sid'];
  const substOf = (o) => {
    const mk = findMark(o, MARK_SUBST);
    if (!mk) return null;
    const r = {};
    for (const k of SUBST_KEYS) { const v = markParam(mk, k); if (v != null) r[k] = v; }
    return r;
  };
  const setSubst = (o, s) => {
    let mk; while ((mk = findMark(o, MARK_SUBST))) P.FPDFPageObj_RemoveMark(o, mk);
    if (!s) return;
    mk = P.FPDFPageObj_AddMark(o, MARK_SUBST);
    if (!mk) return;
    const flag = (x) => (x === true || x === '1' ? '1' : '0');
    const v = { orig: String(s.orig || ''), used: String(s.used || ''), kind: String(s.kind || 'fallback'), b: flag(s.b), it: flag(s.it), mono: flag(s.mono), sid: String(s.sid || SESSION_ID) };
    for (const k of SUBST_KEYS) P.FPDFPageObjMark_SetStringParam(doc, o, mk, k, v[k]);
  };
  // 대체 글꼴을 고르기만 한다(PDF에 올리지 않는다) — o: 원래(또는 이미 대체된) 글자 객체. 반환 { entry(설치 폰트 면, 맑은 고딕이면 null), kind, orig, b, it, mono }
  const pickSubstitute = (o, text, bold) => {
    const prev = substOf(o);
    const orig = prev?.orig || fontNameOf(P.FPDFTextObj_GetFont(o)).replace(/^[A-Z]{6}\+/, '');
    const b = prev ? prev.b === '1' : (bold ?? isBold(o));
    const it = prev ? prev.it === '1' : isItalicFont(o, orig);
    const mono = prev ? prev.mono === '1' : isMonoFont(o, orig);
    const usable = (e) => e && !fontRegistry.missing(e, text).length;
    const styleOk = (e) => e && fontRegistry.isBoldFace(e) === b;
    let entry = null, kind = 'fallback';
    if (orig && orig !== 'Untitled') {
      const fam = fontRegistry.familyFor(orig);
      const exact = fontRegistry.faceByName(orig);
      if (fam) entry = [styleOk(exact) && fontRegistry.isItalicFace(exact) === it ? exact : null, fontRegistry.faceFor(fam, b, it), fontRegistry.faceFor(fam, b, false)].find(usable) || null;
      if (entry) kind = 'family';
    }
    if (!entry && mono) {
      for (const name of MONO_FAMILIES) {
        const fam = fontRegistry.familyFor(name);
        if (!fam) continue;
        entry = [fontRegistry.faceFor(fam, b, it), fontRegistry.faceFor(fam, b, false), fontRegistry.faceFor(fam, false, false)].find(usable) || null;
        if (entry) { kind = 'mono'; break; }
      }
    }
    return { entry, kind, orig, b, it, mono };
  };
  // 대체 글꼴을 PDF에 올린다: { font, used(쓴 글꼴 이름), ...pickSubstitute } — font가 0이면 그릴 글꼴이 없다
  const substituteFont = (o, text, bold) => {
    const pick = pickSubstitute(o, text, bold);
    if (pick.entry) return { ...pick, font: customFont(pick.entry, text), used: pick.entry.label };
    const font = fallbackFont(pick.b, text);
    return { ...pick, font, used: fb[pick.b ? 'bold' : 'regular']?.label || '맑은 고딕' };
  };

  // 원본 글자의 그리기 방식을 새 객체에 옮긴다: 렌더 모드(2 = 채움+외곽선 — Word가 '굵게'를 흉내낼 때 씀)·선 색·선 굵기.
  // 이걸 빼먹으면 대체 폰트로 다시 만든 제목이 보통 굵기로 얇아져 "폰트가 바뀐" 것처럼 보인다
  // (계약서 '개인정보수집, 이용에 대한 동의' 제목: MalgunGothic 400 + 렌더 모드 2 + 선 0.4pt, 잉크 밀도 0.27 → 대체 후 0.19. 2026-09-09 사용자 보고)
  // 투명 모드(3·7)는 옮기지 않는다 — 투명 글자를 드러내는 경로가 따로 0으로 맞춘다
  const copyTextStyle = (src, dst) => {
    const buf = mal(16);
    try {
      const rm = P.FPDFTextObj_GetTextRenderMode(src);
      if (rm >= 0 && rm !== 3 && rm !== 7) P.FPDFTextObj_SetTextRenderMode(dst, rm);
      if (P.FPDFPageObj_GetStrokeColor(src, buf, buf + 4, buf + 8, buf + 12)) P.FPDFPageObj_SetStrokeColor(dst, i32(buf), i32(buf + 4), i32(buf + 8), i32(buf + 12));
      if (P.FPDFPageObj_GetStrokeWidth(src, buf)) P.FPDFPageObj_SetStrokeWidth(dst, f32(buf));
    } finally { free(buf); }
  };

  // 페이지 좌표 → withBitmap(i, scale) 비트맵 픽셀. /Rotate·CropBox 원점까지 렌더와 같은 행렬로 옮긴다(FPDF_PageToDevice).
  // `ph − y`로 계산하면 회전 페이지·원점이 (0,0)이 아닌 CropBox에서 엉뚱한 픽셀을 읽는다
  const toDevice = (i, x, y, scale) => {
    const { w, h } = api.pageSize(i), out = mal(8);
    try {
      P.FPDF_PageToDevice(page(i), 0, 0, Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), 0, x, y, out, out + 4);
      return [i32(out), i32(out + 4)];
    } finally { free(out); }
  };
  // 페이지 좌표 사각형 → 비트맵 픽셀 사각형 (양 끝 포함, 비트맵 안으로 자름. 90° 단위 회전이라 두 모서리로 충분)
  const deviceRect = (i, b, scale) => {
    const { w, h } = api.pageSize(i), pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
    const [ax, ay] = toDevice(i, b.x0, b.y0, scale), [bx, by] = toDevice(i, b.x1, b.y1, scale);
    return { x0: Math.max(0, Math.min(ax, bx)), x1: Math.min(pw - 1, Math.max(ax, bx)), y0: Math.max(0, Math.min(ay, by)), y1: Math.min(ph - 1, Math.max(ay, by)) };
  };

  // 쪽 그리기. v6 Wave E: FPDF_RenderPageBitmap(FPDF_ANNOT)은 양식 칸(위젯)을 그리지 않는다(실측 2026-10-15: 채운 양식도 빈칸으로 나온다) →
  //   양식 칸이 있는 쪽은 양식 환경으로 위에 덧그린다(FPDF_FFLDraw). XFA 전용 양식은 PDFium이 칸을 모르므로 쪽 내용만
  const renderInto = (bmp, i, x, y, w, h) => {
    P.FPDF_RenderPageBitmap(bmp, page(i), x, y, w, h, 0, RENDER_FLAGS);
    const ft = P.FPDF_GetFormType(doc);
    if (ft !== 1 && ft !== 3) return;
    const p = page(i);
    let has = false;
    for (let k = 0, n = P.FPDFPage_GetAnnotCount(p); k < n && !has; k++) { const a = P.FPDFPage_GetAnnot(p, k); if (a) { has = P.FPDFAnnot_GetSubtype(a) === 20; P.FPDFPage_CloseAnnot(a); } }
    if (has) withFormPage(i, (form) => P.FPDF_FFLDraw(form, bmp, p, x, y, w, h, 0, RENDER_FLAGS));
  };
  const withBitmap = (i, scale, fn) => {
    const { w, h } = api.pageSize(i);
    const pw = Math.max(1, Math.round(w * scale)), ph = Math.max(1, Math.round(h * scale));
    const bmp = P.FPDFBitmap_Create(pw, ph, 0); // 항상 BGRA. REVERSE_BYTE_ORDER 플래그로 RGBA가 됨
    if (!bmp) throw new Error('비트맵 생성 실패');
    try {
      P.FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 0xffffffff);
      renderInto(bmp, i, 0, 0, pw, ph);
      return fn(bmp, pw, ph);
    } finally { P.FPDFBitmap_Destroy(bmp); }
  };

  // ── 이미지 객체 다루기 (삽입 · 다운샘플링) ────────────────────────────────
  // 실측 2026-09-09 (2000×1500 노이즈 이미지를 sample.pdf에 넣고 저장한 바이트):
  //   ① FPDFImageObj_LoadJpegFileInline (DCTDecode 그대로) → 1,880,992 B
  //   ② FPDFBitmap_CreateEx(BGRA) + FPDFImageObj_SetBitmap (FlateDecode) → 6,998,728 B, 저장에 281ms
  //   → ①이 3.7배 작고 저장도 빠르다. ①로 통일하고 RGBA 입력은 jpeg-js로 인코딩해 같은 길로 보낸다.
  //   (①은 emscripten addFunction으로 FPDF_FILEACCESS 콜백을 만들 수 있어야 하는데, 이 빌드는 addFunction/removeFunction을 노출한다)
  //   ①의 대가: JPEG는 투명(알파)을 못 담는다 → encodeJpeg가 흰 배경에 합성하고, 다운샘플링은 알파 있는 이미지를 건너뛴다.
  //
  // pageHandles: 이미 페이지에 올라간 객체를 교체할 때 그 페이지 핸들들(리소스 갱신용). 새 객체면 빈 배열.
  // FPDF_FILEACCESS { unsigned long m_FileLen; int (*m_GetBlock)(param,pos,buf,size); void* m_Param; } — wasm32에서 12바이트.
  // Inline은 호출 중에 데이터를 문서로 복사한다(실측: 호출 직후 힙을 0xAB로 덮고 해제해도 저장·재열기 색이 그대로 빨강)
  const putJpeg = (io, data, pageHandles = []) => {
    const src = mal(data.length);
    heap().set(data, src);
    const fa = mal(12);
    const arr = mal(Math.max(4, pageHandles.length * 4));
    const cb = M.addFunction((param, pos, buf, size) => {
      if (pos < 0 || size < 0 || pos + size > data.length) return 0;
      heap().copyWithin(buf, src + pos, src + pos + size);
      return 1;
    }, 'iiiii');
    try {
      M.setValue(fa, data.length, 'i32');
      M.setValue(fa + 4, cb, 'i32');
      M.setValue(fa + 8, 0, 'i32');
      pageHandles.forEach((h, k) => M.setValue(arr + k * 4, h, 'i32'));
      if (!P.FPDFImageObj_LoadJpegFileInline(pageHandles.length ? arr : 0, pageHandles.length, io, fa)) {
        throw new Error('이미지를 PDF에 넣지 못했습니다 (JPEG를 읽을 수 없음).');
      }
    } finally { M.removeFunction(cb); free(arr); free(fa); free(src); }
  };

  // 투명이 있는 RGBA(도장·서명 PNG)는 JPEG로 보내면 흰 배경에 합성돼 밑 글자를 가린다 → BGRA 비트맵으로 넣는다.
  // 실측 2026-10-14: FPDFBitmap_CreateEx(BGRA) + FPDFImageObj_SetBitmap → PDFium이 /SMask(DeviceGray)를 붙여 저장하고,
  // 저장·재열기 후 알파 0 칸은 밑의 빨간 사각형이, 알파 255 칸은 이미지 색이 그려진다. 비트맵 버퍼는 호출 중에 복사된다 —
  // 해제 전에 0xAB로 덮어 두므로 복사하지 않는 빌드로 바뀌면 시험(투명 도장 픽셀)이 바로 깨진다
  const putBitmap = (io, rgba, width, height) => {
    if (!(width > 0 && height > 0) || rgba.length < width * height * 4) throw new Error('RGBA 데이터가 이미지 크기보다 짧습니다.');
    const buf = mal(width * height * 4), H = heap();
    for (let k = 0; k < width * height * 4; k += 4) { H[buf + k] = rgba[k + 2]; H[buf + k + 1] = rgba[k + 1]; H[buf + k + 2] = rgba[k]; H[buf + k + 3] = rgba[k + 3]; } // RGBA → BGRA
    const bmp = P.FPDFBitmap_CreateEx(width, height, BMP_BGRA, buf, width * 4);
    try {
      if (!bmp || !P.FPDFImageObj_SetBitmap(0, 0, io, bmp)) throw new Error('이미지를 PDF에 넣지 못했습니다 (투명 이미지).');
    } finally { if (bmp) P.FPDFBitmap_Destroy(bmp); heap().fill(0xab, buf, buf + width * height * 4); free(buf); }
  };
  const transparent = (image) => {
    if (image?.kind !== 'rgba' || !image.data) return false;
    const d = image.data, n = Math.min(d.length, (image.width * image.height) * 4);
    for (let k = 3; k < n; k += 4) if (d[k] !== 255) return true;
    return false;
  };

  // { kind:'jpeg', data } 또는 { kind:'rgba', data, width, height, quality? } → JPEG 바이트
  const toJpeg = (image) => {
    if (!image || !image.data || !image.data.length) throw new Error('이미지 데이터가 없습니다.');
    const data = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
    if (image.kind === 'jpeg') {
      if (!(data[0] === 0xff && data[1] === 0xd8)) throw new Error('JPEG 파일이 아닙니다.');
      return data;
    }
    if (image.kind !== 'rgba') throw new Error(`지원하지 않는 이미지 형식입니다: ${image.kind}`);
    const { width, height } = image;
    if (!(width > 0 && height > 0)) throw new Error('이미지 크기가 잘못됐습니다.');
    if (data.length < width * height * 4) throw new Error('RGBA 데이터가 이미지 크기보다 짧습니다.');
    return encodeJpeg(data.subarray(0, width * height * 4), width, height, image.quality || 90);
  };

  // 이미지 객체의 원본 픽셀(변환 미적용)을 촘촘한 RGBA로. 포맷(Gray/BGR/BGRx/BGRA)은 FPDFBitmap_GetFormat으로 확인
  const imagePixels = (o) => {
    const bmp = P.FPDFImageObj_GetBitmap(o);
    if (!bmp) return null;
    try {
      const w = P.FPDFBitmap_GetWidth(bmp), h = P.FPDFBitmap_GetHeight(bmp);
      const fmt = P.FPDFBitmap_GetFormat(bmp), bpp = BMP_BYTES[fmt];
      if (!w || !h || !bpp) return null;
      const stride = P.FPDFBitmap_GetStride(bmp), buf = P.FPDFBitmap_GetBuffer(bmp), H = heap();
      const out = Buffer.alloc(w * h * 4);
      for (let y = 0; y < h; y++) {
        let p = buf + y * stride, q = y * w * 4;
        for (let x = 0; x < w; x++, p += bpp, q += 4) {
          if (fmt === BMP_GRAY) { out[q] = out[q + 1] = out[q + 2] = H[p]; }
          else { out[q] = H[p + 2]; out[q + 1] = H[p + 1]; out[q + 2] = H[p]; } // BGR(x/A) → RGB
          out[q + 3] = 255;
        }
      }
      return { data: out, width: w, height: h };
    } finally { P.FPDFBitmap_Destroy(bmp); }
  };

  // 투명(SMask/마스크) 여부. 실측 2026-09-09:
  //   FPDFImageObj_GetBitmap은 마스크를 뺀 원본이라 SMask가 있어도 포맷이 BGR(2)로 나온다 → 포맷만으로는 알 수 없다.
  //   FPDFImageObj_GetRenderedBitmap은 마스크를 적용하고 항상 BGRA(4)를 준다 → 알파 값을 실제로 훑어야 한다.
  //   표시 크기로 렌더하므로 비용이 낮다(계약서 12개 125ms, 슬라이드 583개 336ms). 계약서는 0개, 슬라이드는 583개 중 569개가 투명으로 잡혔다.
  const hasAlpha = (pageHandle, o) => {
    const bmp = P.FPDFImageObj_GetRenderedBitmap(doc, pageHandle, o);
    if (!bmp) return null;
    try {
      const w = P.FPDFBitmap_GetWidth(bmp), h = P.FPDFBitmap_GetHeight(bmp);
      if (P.FPDFBitmap_GetFormat(bmp) !== BMP_BGRA) return false;
      const stride = P.FPDFBitmap_GetStride(bmp), buf = P.FPDFBitmap_GetBuffer(bmp), H = heap();
      for (let y = 0; y < h; y++) {
        const row = buf + y * stride;
        for (let x = 3; x < w * 4; x += 4) if (H[row + x] !== 255) return true;
      }
      return false;
    } finally { P.FPDFBitmap_Destroy(bmp); }
  };

  // ── 그룹 마크: 줄바꿈 편집으로 만든 줄들, 사용자가 Shift 클릭으로 묶은 상자들을 콘텐츠 마크 RetextPdfGroup(id)로 표시. 저장 후에도 유지 ──
  const findMark = (o, name) => { for (let k = 0, mc = P.FPDFPageObj_CountMarks(o); k < mc; k++) { const mk = P.FPDFPageObj_GetMark(o, k); const n = mk && markName(mk); if (n === name) return mk; } return 0; };
  const markParam = (mk, key) => {
    const n = mal(4);
    try {
      if (!P.FPDFPageObjMark_GetParamStringValue(mk, key, 0, 0, n) || !i32(n)) return null;
      const len = i32(n), b = mal(len);
      try { return P.FPDFPageObjMark_GetParamStringValue(mk, key, b, len, n) ? M.UTF16ToString(b) : null; } finally { free(b); }
    } finally { free(n); }
  };
  const groupOf = (o) => { const mk = findMark(o, MARK_GROUP); return mk ? markParam(mk, 'id') : null; };
  const fontOf = (o) => { const mk = findMark(o, 'RetextPdfFont'); return mk ? markParam(mk, 'id') : null; };
  const chosenFont = (o) => selectedFont || (fontOf(o) ? fontRegistry.get(fontOf(o)) : null);
  const tagFont = (o, entry) => {
    let mk; while ((mk = findMark(o, 'RetextPdfFont'))) P.FPDFPageObj_RemoveMark(o, mk);
    mk = P.FPDFPageObj_AddMark(o, 'RetextPdfFont');
    P.FPDFPageObjMark_SetStringParam(doc, o, mk, 'id', entry.id);
    P.FPDFPageObjMark_SetStringParam(doc, o, mk, 'label', entry.label);
  };
  const tagGroup = (o, id) => { // id=null이면 해제
    let mk; while ((mk = findMark(o, MARK_GROUP))) P.FPDFPageObj_RemoveMark(o, mk);
    if (id) { mk = P.FPDFPageObj_AddMark(o, MARK_GROUP); if (mk) P.FPDFPageObjMark_SetStringParam(doc, o, mk, 'id', id); }
  };
  const newGroupId = () => 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // ── v6 글자 모양 마크: 텍스트 객체에 RetextPdfStyle(u 밑줄 · s 취소선 · fb 가짜 굵게 · fi 가짜 기울임 · sc 위/아래첨자 + k 배율 · sy 기준선 이동)
  // 값은 문자열('1', 'sup', '0.65'…). 밑줄·취소선 선(RetextPdfDeco 사각형)은 이 표시에서 syncDeco가 다시 그린다 — 글을 고치거나 옮겨도 선이 따라온다
  const STYLE_KEYS = ['u', 's', 'fb', 'fi', 'sc', 'k', 'sy'];
  const styleOf = (o) => {
    const mk = findMark(o, MARK_STYLE);
    if (!mk) return null;
    const st = {};
    for (const k of STYLE_KEYS) { const v = markParam(mk, k); if (v != null && v !== '') st[k] = v; }
    return Object.keys(st).length ? st : null;
  };
  const setStyleMark = (o, st) => {
    let mk; while ((mk = findMark(o, MARK_STYLE))) P.FPDFPageObj_RemoveMark(o, mk);
    const keys = STYLE_KEYS.filter((k) => st && st[k] != null && st[k] !== '' && st[k] !== false);
    if (!keys.length) return;
    mk = P.FPDFPageObj_AddMark(o, MARK_STYLE);
    if (mk) for (const k of keys) P.FPDFPageObjMark_SetStringParam(doc, o, mk, k, String(st[k]));
  };
  // 글자 모양 표시와 대체 글꼴 표시(RetextPdfSubst)를 함께 옮긴다 — 조각을 나누거나 다시 만들어도 "원래 글꼴"을 잊지 않는다
  const copyStyleMark = (src, dst) => { const st = styleOf(src); if (st) setStyleMark(dst, st); const sb = substOf(src); if (sb) setSubst(dst, sb); };

  // 페이지 인덱스가 바뀌는 작업(삭제·끼우기·복제·순서 변경) 전에: 미룬 콘텐츠를 쓰고 캐시된 페이지 핸들을 모두 닫는다
  const resetPages = () => { flush(); for (const h of pages.values()) P.FPDF_ClosePage(h); pages.clear(); };

  // 화면(보이는 방향) 좌표 → 페이지 사용자 좌표. 쪽 번호·글상자가 /Rotate 된 쪽에서도 똑바로 보이게 한다.
  // 기준 상자는 CropBox(없으면 MediaBox). vx·vy는 보이는 쪽의 왼쪽 아래가 원점, 위가 +y.
  // /Rotate r(시계 방향 90°×r)로 보이므로 글자 행렬은 반대로(반시계) 돌린다: r=1 → [0 1 −1 0]
  //   r=0: (x0+vx, y0+vy)   r=1: (x0+W−vy, y0+vx)   r=2: (x1−vx, y1−vy)   r=3: (x0+vy, y1−vx)   (W·H = 상자 폭·높이)
  // 렌더 비트맵으로 검사한다(pdf-engine.test.js 쪽 번호 — 회전 쪽에서 보이는 아래 가운데에 잉크)
  const visualFrame = (i) => {
    const p = page(i), b = mal(16);
    try {
      let box = null;
      for (const get of [P.FPDFPage_GetCropBox, P.FPDFPage_GetMediaBox]) {
        if (get.call(P, p, b, b + 4, b + 8, b + 12)) { box = { x0: f32(b), y0: f32(b + 4), x1: f32(b + 8), y1: f32(b + 12) }; break; }
      }
      const rot = ((P.FPDFPage_GetRotation(p) % 4) + 4) % 4;
      if (!box) { const { w, h } = api.pageSize(i); box = rot % 2 ? { x0: 0, y0: 0, x1: h, y1: w } : { x0: 0, y0: 0, x1: w, y1: h }; }
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      const W = x1 - x0, H = y1 - y0;
      const map = [
        (vx, vy) => [x0 + vx, y0 + vy], (vx, vy) => [x0 + W - vy, y0 + vx],
        (vx, vy) => [x1 - vx, y1 - vy], (vx, vy) => [x0 + vy, y1 - vx],
      ][rot];
      const rotm = [[1, 0, 0, 1], [0, 1, -1, 0], [-1, 0, 0, -1], [0, -1, 1, 0]][rot]; // a b c d (글자 진행 방향 · 위 방향)
      return { width: rot % 2 ? H : W, height: rot % 2 ? W : H, map, rotm, rot };
    } finally { free(b); }
  };
  // '#rrggbb' → [r,g,b,255]. 잘못된 값이면 검정
  const parseColor = (c) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c ?? ''));
    if (!m) return [0, 0, 0, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  };
  // 새 글자 객체 하나: 폰트·크기로 만들어 텍스트를 넣고 행렬 m(a b c d e f)·색을 건다. 실패하면 던진다(페이지에는 아직 넣지 않는다)
  const makeText = (font, size, text, m, color) => {
    const neo = P.FPDFPageObj_CreateTextObj(doc, font, size);
    const u = utf16(text || ' '); // 빈 문자열 SetText는 WASM 트랩
    const ok = neo && P.FPDFText_SetText(neo, u); free(u);
    if (!ok) { if (neo) P.FPDFPageObj_Destroy(neo); throw new Error('글자 객체를 만들지 못했습니다.'); }
    if (m) setMatrix(neo, m);
    P.FPDFPageObj_SetFillColor(neo, color[0], color[1], color[2], color[3]);
    return neo;
  };
  const setMatrix = (o, m) => {
    const b = mal(24);
    try { m.forEach((v, k) => M.setValue(b + k * 4, v, 'float')); P.FPDFPageObj_SetMatrix(o, b); } finally { free(b); }
  };
  const boundsOf = (o) => {
    const b = mal(16);
    try { P.FPDFPageObj_GetBounds(o, b, b + 4, b + 8, b + 12); return { x0: f32(b), y0: f32(b + 4), x1: f32(b + 8), y1: f32(b + 12) }; } finally { free(b); }
  };
  // 새 글자(쪽 번호·글상자)에 쓸 폰트: 지정한 설치 폰트(fontId) 또는 대체 한글 폰트(맑은 고딕). 그릴 수 없으면 던진다
  const newTextFont = (fontId, text, size) => {
    const entry = fontId ? fontRegistry.get(fontId) : null;
    if (entry) { const absent = fontRegistry.missing(entry, text); if (absent.length) throw new Error(`선택한 폰트에 없는 글자: ${absent.slice(0, 12).join(' ')}`); }
    const font = entry ? customFont(entry, text) : fallbackFont(false, text);
    if (!font || !canRender(font, text, size)) throw new Error(noGlyphReason(font, text, size));
    return { font, entry };
  };

  // 사용자가 고칠 수 있는 입력 오류 — 서버가 400으로 응답한다(e.status). 그 밖의 실패는 500
  const bad = (message) => Object.assign(new Error(message), { status: 400 });

  // ── 놓기 공용(쪽 번호·머리말·꼬리말·워터마크) ─────────────────────────────
  // 보이는 쪽 좌표계의 행렬(a b c d e f) → 페이지 사용자 좌표 행렬. visualFrame의 map은 아핀이라 선형 부분은 L(v) = map(v) − map(0,0)
  // (회전 0이면 그대로, /Rotate 90이면 [a b c d]가 rotm처럼 돌아간다 — 쪽 번호가 쓰던 [...rotm, e, f]와 같은 값)
  const toPageMatrix = (f, [a, b, c, d, e, g]) => {
    const [ox, oy] = f.map(0, 0), L = (x, y) => { const [px, py] = f.map(x, y); return [px - ox, py - oy]; };
    const [A, B] = L(a, b), [C, D] = L(c, d), [E, F] = f.map(e, g);
    return [A, B, C, D, E, F];
  };
  // 글자 한 줄을 보이는 쪽의 정해진 자리에 놓는다(쪽 번호·머리말·꼬리말·글자 워터마크가 같이 쓴다).
  //   at: { h:'left'|'center'|'right', v:'top'|'middle'|'bottom' }, margin(pt), rotation(도, 보이는 방향에서 반시계),
  //   baseline: 아래 자리에서 기준선을 margin에 맞춘다(쪽 번호가 예전부터 쓰던 규칙 — 회전이 없을 때만). 아니면 잉크 상자 아래끝을 맞춘다
  //   mark: 콘텐츠 마크 이름(다시 넣을 때 지우는 표시), back: 맨 아래 z-순서(본문 뒤)에 넣는다
  // 자리 계산은 원점에 놓인 글자의 잉크 상자(boundsOf)를 rotation만큼 돌린 외곽 상자로 한다 — 회전 0이면 쪽 번호 공식과 같다
  const placeText = (i, { font, size, text, color, at, margin = 0, rotation = 0, baseline = true, mark, back = false }) => {
    const p = page(i), f = visualFrame(i);
    const o = makeText(font, size, text, null, color);
    const b = boundsOf(o);
    const t = (Number(rotation) || 0) * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
    const minX = Math.min(...pts.map((q) => q[0])), maxX = Math.max(...pts.map((q) => q[0]));
    const minY = Math.min(...pts.map((q) => q[1])), maxY = Math.max(...pts.map((q) => q[1]));
    const vx = at.h === 'center' ? (f.width - (maxX - minX)) / 2 - minX : at.h === 'right' ? f.width - margin - maxX : margin - minX;
    const vy = at.v === 'middle' ? (f.height - (maxY - minY)) / 2 - minY
      : at.v === 'top' ? f.height - margin - maxY : baseline && !t ? margin : margin - minY;
    setMatrix(o, toPageMatrix(f, [cos, sin, -sin, cos, vx, vy]));
    if (mark) P.FPDFPageObj_AddMark(o, mark);
    if (!(back && P.FPDFPage_InsertObjectAtIndex(p, o, 0))) P.FPDFPage_InsertObject(p, o);
    regen(p);
    return o;
  };
  // 모든 쪽에서 mark가 달린 객체를 뺀다(쪽 번호·머리말·워터마크를 다시 넣거나 지울 때)
  const removeMarked = (mark) => {
    let removed = 0;
    for (let i = 0, n = P.FPDF_GetPageCount(doc); i < n; i++) {
      const p = page(i);
      let hit = false;
      for (let idx = P.FPDFPage_CountObjects(p) - 1; idx >= 0; idx--) {
        const o = P.FPDFPage_GetObject(p, idx);
        if (!o || !findMark(o, mark)) continue;
        if (P.FPDFPage_RemoveObject(p, o)) { P.FPDFPageObj_Destroy(o); removed++; hit = true; }
      }
      if (hit) regen(p);
    }
    return removed;
  };
  // 쪽 목록 검사(0 기준). 서버가 page-range.js로 푼 배열을 그대로 받는다. 없으면 모든 쪽
  const pageList = (pages) => {
    const count = P.FPDF_GetPageCount(doc);
    if (pages == null) return Array.from({ length: count }, (_, k) => k);
    const list = [...new Set([].concat(pages).map(Number))].sort((a, b) => a - b);
    if (!list.length) throw bad('쪽을 하나 이상 고르세요.');
    for (const n of list) if (!Number.isInteger(n) || n < 0 || n >= count) throw bad(`쪽 번호가 범위를 벗어났습니다: ${n + 1}쪽`);
    return list;
  };
  const clamp01 = (v, def) => { const n = v == null || v === '' ? def : Number(v); if (!Number.isFinite(n) || n < 0 || n > 1) throw bad('불투명도는 0~1 사이로 지정하세요.'); return n; };
  const alphaOf = (opacity) => Math.round(opacity * 255);

  // ── 텍스트 페이지 글자 ↔ 문자열 · 객체 ─────────────────────────────────────
  // U+0002: PDFium이 줄 끝 하이픈 글자에 붙이는 표시(실측: 11-hyphenation.pdf "internation\u0002"). 화면·편집에는 '-'로 보인다 — 길이가 같아 위치 대응이 그대로다
  const HYPHEN_MARK = 0x02;
  const charOf = (u) => (u === HYPHEN_MARK ? '-' : u > 0 && u <= 0x10ffff && !(u >= 0xd800 && u <= 0xdfff) ? String.fromCodePoint(u) : '�');
  // 쪽 글자를 문자열로: text와 map(문자열 위치 → 텍스트 페이지 글자 번호). BMP 밖 글자는 문자열에서 두 칸이고 둘 다 같은 글자 번호
  const pageChars = (tp) => {
    const n = Math.max(0, P.FPDFText_CountChars(tp));
    let text = ''; const map = [];
    for (let c = 0; c < n; c++) {
      const ch = charOf(P.FPDFText_GetUnicode(tp, c));
      text += ch;
      for (let k = 0; k < ch.length; k++) map.push(c);
    }
    return { text, map };
  };

  // ── 객체 텍스트: 객체가 직접 그린 글자만 ─────────────────────────────────────
  // 예전에는 FPDFTextObj_GetText(= PDFium GetTextByObject)를 그대로 썼다. 그 함수는 객체 글자 바로 뒤에 오는 공백 하나를 — PDFium이
  // 끼운 공백(IsGenerated)이든 다른 객체의 진짜 공백이든 — 객체 텍스트에 덧붙인다. 그래서 Chromium 한 글자 조각은 "월 "이 되고
  // 뒤의 공백 조각까지 이으면 두 칸, 자간 넓은 줄은 "자 간 이", 지시선 점은 ". . . .", 글자별 객체는 "S A L E"가 됐다(tmp/grouping 말뭉치 실측).
  // 이제 텍스트 페이지 글자 중 그 객체 것(FPDFText_GetTextObject)만 쓴다:
  //   · 진짜 글자(IsGenerated 0)는 모두 — 진짜 공백이 여러 개 이어져도 그대로 둔다
  //   · PDFium이 객체 "안"에 끼운 공백(TJ 간격 −250처럼 글자 사이를 띄운 자리)은 그 틈이 객체의 보통 글자 간격(중앙값)보다
  //     GEN_SPACE_MIN_EM 넘게 넓을 때만 남긴다 — 낱말 사이 TJ(−250·−278)는 남고 자간용 TJ(모든 글자 사이 같은 간격)는 버린다
  //   · 객체 "사이"에 PDFium이 끼운 공백·줄바꿈은 객체 것이 아니라 들어가지 않는다 — 조각 사이 공백은 줄 묶기(text-grouping.js)가 틈을 보고 넣는다
  // 이 텍스트와 charBoxes()·rangesToParts()의 글자 대응은 모두 이 함수 하나에서 나오므로 가리기 위치가 어긋나지 않는다.
  const GEN_SPACE_MIN_EM = 0.15;
  // 쪽의 글자를 객체 포인터별로 모은다: Map(포인터 → [{ c: 글자 번호, u: 유니코드, gen: PDFium이 끼운 글자 }])
  // 유니코드가 없는 글자(0)는 뺀다 — 예전 객체 텍스트(GetTextByObject)도 건너뛰었다
  const charsByObject = (tp) => {
    const by = new Map();
    for (let c = 0, n = Math.max(0, P.FPDFText_CountChars(tp)); c < n; c++) {
      const o = P.FPDFText_GetTextObject(tp, c);
      if (!o) continue; // 객체 사이에 PDFium이 끼운 공백·\r\n
      const u = P.FPDFText_GetUnicode(tp, c);
      if (!u) continue;
      let list = by.get(o);
      if (!list) by.set(o, (list = []));
      list.push({ c, u, gen: !!P.FPDFText_IsGenerated(tp, c) });
    }
    return by;
  };
  // 글자 하나의 기준선 시작점(x,y)과 진행 폭 w(쪽 단위, 글자 방향으로). s: 32바이트 이상 scratch, m: 객체 행렬 [a,b,c,d,e,f]
  // 진행 폭은 느슨한 글자 상자(FPDFText_GetLooseCharBox = 진행 폭 × 올림~내림을 행렬로 돌린 상자의 외접 사각형)에서 푼다:
  //   외접 폭 Wx = w|a| + h|c|, 높이 Wy = w|b| + h|d| (w: 진행, h: 글자 높이) → 2×2 연립. 기울임(합성 이탤릭)·회전 글자도 기준선에서의 진행 폭이 나온다.
  //   45°처럼 풀리지 않으면 외접 폭을 쓴다(드물다).
  const glyphGeo = (tp, c, m, s) => {
    P.FPDFText_GetCharOrigin(tp, c, s, s + 8);
    const x = f64(s), y = f64(s + 8);
    let w = 0;
    if (P.FPDFText_GetLooseCharBox(tp, c, s)) { // FS_RECTF left, top, right, bottom
      const Wx = Math.abs(f32(s + 8) - f32(s)), Wy = Math.abs(f32(s + 4) - f32(s + 12));
      const a = Math.abs(m[0]), b = Math.abs(m[1]), cc = Math.abs(m[2]), d = Math.abs(m[3]), len = Math.hypot(m[0], m[1]);
      const det = a * d - cc * b;
      w = Math.abs(det) > 1e-3 * (len * len + 1e-9) ? Math.max(0, (Wx * d - cc * Wy) / det) * len : Math.max(Wx, Wy);
    }
    return { x, y, w };
  };
  // 객체 하나의 글자 목록 → { text, at, geo }
  //   at[k]: 텍스트 위치 k를 그린 텍스트 페이지 글자 번호(BMP 밖 글자는 두 칸 모두 같은 번호)
  //   geo[k]: [x, y, w] 위치 k 글자의 기준선 시작점과 진행 폭(wantGeo일 때만, 아니면 null)
  // o: 객체 포인터, s: 32바이트 scratch
  const objText = (tp, o, list, s, wantGeo) => {
    const needGeo = wantGeo || list.some((x) => x.gen);
    let m = [1, 0, 0, 1, 0, 0], em = 1;
    if (needGeo) {
      if (P.FPDFPageObj_GetMatrix(o, s)) m = [0, 1, 2, 3, 4, 5].map((k) => f32(s + k * 4));
      em = (P.FPDFTextObj_GetFontSize(o, s) ? f32(s) : 1) * Math.hypot(m[0], m[1]) || 1;
    }
    const geos = needGeo ? list.map((x) => glyphGeo(tp, x.c, m, s)) : null;
    // PDFium이 객체 안에 끼운 공백을 남길지: 앞뒤 진짜 글자 사이 틈(진행 폭 기준, em 단위)이 객체의 보통 글자 간격 + GEN_SPACE_MIN_EM보다 넓으면 남긴다
    let keep = null;
    if (list.some((x) => x.gen)) {
      const cos = m[0] / (Math.hypot(m[0], m[1]) || 1), sin = m[1] / (Math.hypot(m[0], m[1]) || 1);
      const u = (g) => g.x * cos + g.y * sin;
      const real = list.map((x, k) => k).filter((k) => !list[k].gen);
      const gaps = real.slice(1).map((k, j) => (u(geos[k]) - (u(geos[real[j]]) + geos[real[j]].w)) / em);
      const sorted = gaps.slice().sort((p, q) => p - q), base = sorted.length ? sorted[sorted.length >> 1] : 0;
      keep = new Set();
      for (let j = 0; j < real.length - 1; j++) {
        const between = [];
        for (let k = real[j] + 1; k < real[j + 1]; k++) between.push(k);
        const space = between.find((k) => list[k].u === 0x20);
        if (space != null && gaps[j] > base + GEN_SPACE_MIN_EM) keep.add(space);
      }
    }
    let text = ''; const at = [], geo = wantGeo ? [] : null;
    list.forEach((x, k) => {
      if (x.gen && !(keep && keep.has(k))) return;
      const ch = charOf(x.u);
      text += ch;
      for (let q = 0; q < ch.length; q++) {
        at.push(x.c);
        if (geo) { const g = geos[k]; geo.push(q ? [g.x + g.w, g.y, 0] : [g.x, g.y, g.w]); }
      }
    });
    return { text, at, geo };
  };
  // 글자 범위 [start, end)의 사각형(줄마다 하나, FPDFText_CountRects/GetRect) → [[l,b,r,t], …] 회전 전 페이지 좌표
  const rangeRects = (tp, start, end) => {
    const out = [], s = mal(32);
    try {
      for (let k = 0, n = P.FPDFText_CountRects(tp, start, Math.max(0, end - start)); k < n; k++) {
        if (!P.FPDFText_GetRect(tp, k, s, s + 8, s + 16, s + 24)) continue; // left, top, right, bottom
        const l = f64(s), t = f64(s + 8), r = f64(s + 16), b = f64(s + 24);
        if (r > l && t > b) out.push([l, b, r, t]);
      }
    } finally { free(s); }
    return out;
  };
  // 텍스트 페이지 글자 번호 범위들 → 가리기 조각 [{ idx, from, to }] (객체 텍스트 안의 위치, to 미포함).
  // 객체마다 그 객체가 그린 글자 번호를 차례로 모아(charsByObject) 객체 텍스트(objText — objects()·charBoxes()와 같은 함수)의 위치로 바꾼다.
  // 객체 텍스트에서 뺀 PDFium 공백(IsGenerated)은 지울 글자가 없으므로 범위에 들어 있어도 건너뛴다.
  // 쪽의 객체 목록에 없는 객체(양식 XObject 안 글자)의 글자는 unmapped로 센다(지울 수 없다 — 덮기만 된다)
  const rangesToParts = (i, ranges) => {
    const p = page(i), tp = P.FPDFText_LoadPage(p), s = mal(32);
    try {
      const ptrIdx = new Map();
      for (let k = 0, n = P.FPDFPage_CountObjects(p); k < n; k++) ptrIdx.set(P.FPDFPage_GetObject(p, k), k);
      const want = (c) => ranges.some(([a, b]) => c >= a && c < b);
      let unmapped = 0;
      const parts = [];
      for (const [o, list] of charsByObject(tp)) {
        const idx = ptrIdx.get(o);
        if (idx === undefined) { unmapped += list.filter((x) => want(x.c)).length; continue; }
        if (!list.some((x) => want(x.c))) continue;
        const { at } = objText(tp, o, list, s, false);
        // 원하는 범위마다 연속 구간으로
        for (const [a, b] of ranges) {
          let from = -1, to = -1;
          at.forEach((c, k) => { if (c >= a && c < b) { if (from < 0) from = k; to = k + 1; } });
          if (from >= 0) parts.push({ idx, from, to });
        }
      }
      return { parts, unmapped };
    } finally { free(s); P.FPDFText_ClosePage(tp); }
  };

  // ── 주석 ───────────────────────────────────────────────────────────────────
  // FPDF_ANNOT_* 번호 ↔ 이름. 만들 수 있는 것은 ANNOT_CREATE에 있는 것만
  const ANNOT_NAMES = { 1: 'text', 2: 'link', 3: 'freetext', 4: 'line', 5: 'square', 6: 'circle', 7: 'polygon', 8: 'polyline', 9: 'highlight', 10: 'underline',
    11: 'squiggly', 12: 'strikeout', 13: 'stamp', 14: 'caret', 15: 'ink', 16: 'popup', 17: 'fileattachment', 18: 'sound', 19: 'movie', 20: 'widget',
    21: 'screen', 22: 'printermark', 23: 'trapnet', 24: 'watermark', 25: '3d', 26: 'richmedia', 27: 'xfawidget', 28: 'redact' };
  const ANNOT_CREATE = { text: 1, line: 4, square: 5, circle: 6, highlight: 9, underline: 10, squiggly: 11, strikeout: 12, ink: 15 };
  const MARKUP = new Set([9, 10, 11, 12]);
  const ANNOT_FLAG_PRINT = 4, ANNOT_FLAG_NOZOOM = 8, ANNOT_FLAG_NOROTATE = 16;
  const BLEND_MULTIPLY = 1; // EPDFAnnot_GenerateAppearanceWithBlend — 형광펜은 곱하기로 그려 밑 글자가 비친다(Acrobat과 같은 방식)
  const LE_NONE = 0, LE_CLOSED_ARROW = 5; // EPDFAnnot_SetLineEndings
  const hexColor = (c) => '#' + c.slice(0, 3).map((v) => (v & 255).toString(16).padStart(2, '0')).join('');
  // PDF 날짜 문자열(D:YYYYMMDDHHmmSS+09'00') ↔ ISO
  const pdfDate = (d = new Date()) => {
    const z = (n, l = 2) => String(Math.abs(n)).padStart(l, '0'), off = -d.getTimezoneOffset();
    return `D:${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
      + (off === 0 ? 'Z' : `${off > 0 ? '+' : '-'}${z(Math.floor(Math.abs(off) / 60))}'${z(Math.abs(off) % 60)}'`);
  };
  const isoDate = (s) => {
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?'?/.exec(String(s || '').trim());
    if (!m) return null;
    const [y, mo = '01', d = '01', h = '00', mi = '00', se = '00'] = m.slice(1, 7).map((v) => v ?? undefined);
    const sign = m[7] === '-' ? -1 : m[7] === '+' ? 1 : 0;
    const offMin = sign ? sign * (Number(m[8] || 0) * 60 + Number(m[9] || 0)) : 0;
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - offMin * 60000;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  };
  const annotStr = (a, key) => {
    const n = P.FPDFAnnot_GetStringValue(a, key, 0, 0);
    if (!(n > 2)) return '';
    const b = mal(n);
    try { P.FPDFAnnot_GetStringValue(a, key, b, n); return M.UTF16ToString(b); } finally { free(b); }
  };
  const setAnnotStr = (a, key, value) => { const u = utf16(String(value ?? '')); try { return !!P.FPDFAnnot_SetStringValue(a, key, u); } finally { free(u); } };
  // FS_RECTF { left, top, right, bottom }
  const annotRect = (a) => {
    const b = mal(16);
    try { if (!P.FPDFAnnot_GetRect(a, b)) return null; const l = f32(b), t = f32(b + 4), r = f32(b + 8), bt = f32(b + 12); return [Math.min(l, r), Math.min(bt, t), Math.max(l, r), Math.max(bt, t)]; } finally { free(b); }
  };
  const setAnnotRect = (a, [l, b, r, t]) => {
    const m = mal(16);
    try { [Math.min(l, r), Math.max(b, t), Math.max(l, r), Math.min(b, t)].forEach((v, k) => M.setValue(m + k * 4, v, 'float')); return !!P.FPDFAnnot_SetRect(a, m); } finally { free(m); }
  };
  const annotColor = (a, type) => {
    const b = mal(16);
    try {
      if (P.EPDFAnnot_GetColor(a, type, b, b + 4, b + 8)) return [i32(b) & 255, i32(b + 4) & 255, i32(b + 8) & 255];
      return null;
    } finally { free(b); }
  };
  const withAnnot = (i, index, fn) => {
    const p = page(i), n = P.FPDFPage_GetAnnotCount(p);
    if (!Number.isInteger(index) || index < 0 || index >= n) throw Object.assign(new Error('주석을 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 고르세요.'), { status: 404 });
    const a = P.FPDFPage_GetAnnot(p, index);
    if (!a) throw new Error('주석을 읽지 못했습니다.');
    try { return fn(a, p); } finally { P.FPDFPage_CloseAnnot(a); }
  };
  // 외형(/AP /N) 다시 만들기. 형광펜은 곱하기 섞기
  const regenAppearance = (a) => (P.FPDFAnnot_GetSubtype(a) === 9 ? P.EPDFAnnot_GenerateAppearanceWithBlend(a, BLEND_MULTIPLY) : P.EPDFAnnot_GenerateAppearance(a));
  const readAnnot = (a, index, rotation) => {
    const st = P.FPDFAnnot_GetSubtype(a), b = mal(64);
    try {
      const item = { index, subtype: ANNOT_NAMES[st] || `unknown${st}`, rect: annotRect(a), color: null, opacity: 1,
        contents: annotStr(a, 'Contents'), author: annotStr(a, 'T'), modified: isoDate(annotStr(a, 'M')), rotation };
      const c = annotColor(a, 0);
      if (c) item.color = hexColor(c);
      const ic = annotColor(a, 1);
      if (ic) item.fill = hexColor(ic);
      if (P.EPDFAnnot_GetOpacity(a, b)) item.opacity = Math.round((i32(b) & 255) / 255 * 1000) / 1000;
      // 선 굵기: /BS /W(EPDFAnnot_GetBorderStyle — 스타일 번호를 돌려주고 굵기를 쓴다, 0이면 /BS 없음) → 없으면 옛 /Border [가로 세로 굵기]
      M.setValue(b, 0, 'float');
      if (P.EPDFAnnot_GetBorderStyle(a, b) > 0) item.width = Math.round(f32(b) * 1000) / 1000;
      else if (P.FPDFAnnot_GetBorder(a, b, b + 4, b + 8)) item.width = f32(b + 8);
      const nq = P.FPDFAnnot_CountAttachmentPoints(a);
      if (nq > 0) {
        item.quads = [];
        for (let k = 0; k < nq; k++) if (P.FPDFAnnot_GetAttachmentPoints(a, k, b)) item.quads.push([0, 1, 2, 3, 4, 5, 6, 7].map((q) => f32(b + q * 4)));
      }
      if (st === 15) {
        item.inkPaths = [];
        for (let k = 0, n = P.FPDFAnnot_GetInkListCount(a); k < n; k++) {
          const cnt = P.FPDFAnnot_GetInkListPath(a, k, 0, 0);
          if (!(cnt > 0)) continue;
          const buf = mal(cnt * 8);
          try { P.FPDFAnnot_GetInkListPath(a, k, buf, cnt); item.inkPaths.push(Array.from({ length: cnt }, (_, q) => [f32(buf + q * 8), f32(buf + q * 8 + 4)])); } finally { free(buf); }
        }
      }
      if (st === 4 && P.FPDFAnnot_GetLine(a, b, b + 8)) {
        item.line = { from: [f32(b), f32(b + 4)], to: [f32(b + 8), f32(b + 12)] };
        if (P.EPDFAnnot_GetLineEndings(a, b + 16, b + 20)) item.line.arrow = i32(b + 20) !== LE_NONE;
      }
      item.hasAppearance = !!P.EPDFAnnot_HasAppearanceStream(a, 0);
      return item;
    } finally { free(b); }
  };
  // 사각형 두 개가 겹치는가([l,b,r,t] / {x0,y0,x1,y1} 둘 다 받는다)
  const asBox = (r) => (Array.isArray(r) ? { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) } : r);
  const overlaps = (a, b) => { a = asBox(a); b = asBox(b); return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; };
  // 주석 지우기(index들, 내림차순으로). 딸린 팝업(/Popup)도 함께 지운다 — 팝업만 남으면 지운 메모 내용이 다른 뷰어에 계속 보인다
  const removeAnnots = (p, indices) => {
    const all = new Set(indices);
    for (const index of indices) {
      const a = P.FPDFPage_GetAnnot(p, index);
      if (!a) continue;
      const pop = P.FPDFAnnot_GetLinkedAnnot(a, 'Popup');
      if (pop) { const k = P.FPDFPage_GetAnnotIndex(p, pop); if (k >= 0) all.add(k); P.FPDFPage_CloseAnnot(pop); }
      P.FPDFPage_CloseAnnot(a);
    }
    let removed = 0;
    for (const k of [...all].sort((x, y) => y - x)) if (P.FPDFPage_RemoveAnnot(p, k)) removed++;
    return removed;
  };
  // 가린 영역과 겹치는 주석을 지운다(진짜 가리기의 일부 — 메모·형광펜·도형에 가린 글자가 남지 않게). 링크·양식 칸은 남긴다
  const removeAnnotsIn = (i, rects) => {
    if (!rects.length) return 0;
    const p = page(i), hits = [];
    for (let k = 0, n = P.FPDFPage_GetAnnotCount(p); k < n; k++) {
      const a = P.FPDFPage_GetAnnot(p, k);
      if (!a) continue;
      try {
        const st = P.FPDFAnnot_GetSubtype(a), r = annotRect(a);
        if (st === 2 || st === 20 || st === 16 || !r) continue; // 링크·양식 칸·팝업(팝업은 부모와 함께 지운다)
        if (rects.some((x) => overlaps(r, x))) hits.push(k);
      } finally { P.FPDFPage_CloseAnnot(a); }
    }
    return hits.length ? removeAnnots(p, hits) : 0;
  };

  // ── v6 Wave E: 양식(AcroForm) ───────────────────────────────────────────────
  // 양식 채우기 환경(FPDFDOC_InitFormFillEnvironment)은 양식 기능을 처음 부를 때만 만든다 — 양식 없는 문서·다른 편집은 예전과 똑같다.
  // FORM_OnAfterLoadPage는 부르지 않는다(쪽 보기를 만들면 쪽을 닫을 때마다 OnBeforeClosePage가 필요하다). 실측 2026-10-15: 값 쓰기
  // (EPDFAnnot_SetFormFieldValue)와 외형 만들기(EPDFAnnot_GenerateFormFieldAP)는 쪽 보기 없이 된다 — 라디오는 같은 묶음의 /AS까지 바꾼다
  let formEnv = null; // { info, handle }
  const formHandle = () => {
    if (formEnv) return formEnv.handle;
    const info = P.PDFiumExt_OpenFormFillInfo();
    const handle = info ? P.PDFiumExt_InitFormFillEnvironment(doc, info) : 0;
    if (!handle) { if (info) P.PDFiumExt_CloseFormFillInfo(info); throw new Error('양식 기능을 시작하지 못했습니다.'); }
    formEnv = { info, handle };
    return handle;
  };
  // FPDF_FORMFIELD_* → 이름. FPDF_GetFormType: 0 없음 · 1 AcroForm · 2 XFA 전용(full) · 3 XFA 앞면(foreground — AcroForm 칸도 있다)
  const FIELD_TYPES = { 1: 'button', 2: 'checkbox', 3: 'radio', 4: 'combo', 5: 'list', 6: 'text', 7: 'signature' };
  const FORM_TYPES = ['none', 'acroform', 'xfa-full', 'xfa-foreground'];
  const FF_READONLY = 1, FF_REQUIRED = 2, FF_MULTILINE = 1 << 12, FF_PASSWORD = 1 << 13, FF_EDIT = 1 << 18, FF_MULTISELECT = 1 << 21, FF_COMB = 1 << 24;
  const ANNOT_FLAG_HIDDEN = 2, ANNOT_FLAG_NOVIEW = 32;
  // 양식 문자열 읽기(UTF-16, 길이 질의 → 다시 읽기)
  const formStr = (call) => {
    const n = call(0, 0);
    if (!(n > 2)) return '';
    const b = mal(n);
    try { call(b, n); return M.UTF16ToString(b); } finally { free(b); }
  };
  // WinAnsi(표준 14 글꼴 /Helv 등)로 그릴 수 있는 글자인가 — 아니면(한글·한자 등) 외형을 맑은 고딕 서브셋으로 다시 만든다(pdf-forms.js)
  const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
  const needsUnicodeFont = (s) => [...String(s)].some((c) => { const k = c.codePointAt(0); return k > 0xff && !WINANSI_EXTRA.has(c); });
  const readField = (form, a, i, index, rotation) => {
    const b = mal(16);
    try {
      const type = FIELD_TYPES[P.FPDFAnnot_GetFormFieldType(form, a)] || 'unknown';
      const flags = P.FPDFAnnot_GetFormFieldFlags(form, a) >>> 0, aflags = P.FPDFAnnot_GetFlags(a) >>> 0;
      const f = {
        i, index, rotation, type,
        name: formStr((p, n) => P.FPDFAnnot_GetFormFieldName(form, a, p, n)),
        alt: formStr((p, n) => P.FPDFAnnot_GetFormFieldAlternateName(form, a, p, n)),
        value: formStr((p, n) => P.FPDFAnnot_GetFormFieldValue(form, a, p, n)),
        rect: annotRect(a), flags,
        required: !!(flags & FF_REQUIRED), readOnly: !!(flags & FF_READONLY) || type === 'signature',
        hidden: !!(aflags & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NOVIEW)),
        objNum: P.EPDFAnnot_GetObjectNumber(a),
      };
      if (P.FPDFAnnot_GetFontSize(form, a, b)) f.fontSize = Math.round(f32(b) * 100) / 100;
      if (P.FPDFAnnot_GetFontColor(form, a, b, b + 4, b + 8)) f.color = hexColor([i32(b), i32(b + 4), i32(b + 8)]);
      if (P.FPDFAnnot_GetNumberValue(a, 'Q', b)) f.align = Math.round(f32(b));
      if (type === 'text') {
        f.multiline = !!(flags & FF_MULTILINE); f.password = !!(flags & FF_PASSWORD); f.comb = !!(flags & FF_COMB);
        if (P.FPDFAnnot_GetNumberValue(a, 'MaxLen', b)) f.maxLen = Math.round(f32(b));
      }
      if (type === 'checkbox' || type === 'radio') {
        f.exportValue = formStr((p, n) => P.FPDFAnnot_GetFormFieldExportValue(form, a, p, n)) || 'Yes';
        f.checked = !!P.FPDFAnnot_IsChecked(form, a);
        f.control = P.FPDFAnnot_GetFormControlIndex(form, a); f.controls = P.FPDFAnnot_GetFormControlCount(form, a);
      }
      if (type === 'combo' || type === 'list') {
        f.editable = type === 'combo' && !!(flags & FF_EDIT); f.multiSelect = type === 'list' && !!(flags & FF_MULTISELECT);
        f.options = [];
        for (let k = 0, n = Math.min(1000, P.FPDFAnnot_GetOptionCount(form, a)); k < n; k++) {
          f.options.push({ label: formStr((p, len) => P.FPDFAnnot_GetOptionLabel(form, a, k, p, len)), selected: !!P.FPDFAnnot_IsOptionSelected(form, a, k) });
        }
      }
      return f;
    } finally { free(b); }
  };
  // 쪽 보기(FORM_OnAfterLoadPage)를 fn 동안만 붙인다. 내보내기 값·체크 여부·글자 크기·목록 고르기는 쪽 보기가 있어야 읽힌다(실측 2026-10-15: 없으면
  // GetFormFieldExportValue가 빈 값, IsChecked가 늘 false). 쪽 보기를 남겨 두면 그 쪽의 주석을 지우거나 고정할 때 PDFium이 옛 위젯을 가리키므로 곧바로 뗀다
  const withFormPage = (i, fn) => {
    const form = formHandle(), p = page(i);
    P.FORM_OnAfterLoadPage(p, form);
    try { return fn(form, p); } finally { P.FORM_OnBeforeClosePage(p, form); }
  };
  // 문서의 모든 양식 칸(위젯) 훑기. fn(form, a, i, k) — 위젯마다. false를 돌려주면 멈춘다
  const eachWidget = (fn) => {
    for (let i = 0, n = P.FPDF_GetPageCount(doc); i < n; i++) {
      const p = page(i);
      let has = false;
      for (let k = 0, m = P.FPDFPage_GetAnnotCount(p); k < m && !has; k++) { const a = P.FPDFPage_GetAnnot(p, k); if (a) { has = P.FPDFAnnot_GetSubtype(a) === 20; P.FPDFPage_CloseAnnot(a); } }
      if (!has) continue; // 양식 칸이 없는 쪽에는 쪽 보기를 붙이지 않는다
      const stop = withFormPage(i, (form) => {
        for (let k = 0, m = P.FPDFPage_GetAnnotCount(p); k < m; k++) {
          const a = P.FPDFPage_GetAnnot(p, k);
          if (!a) continue;
          try { if (P.FPDFAnnot_GetSubtype(a) === 20 && fn(form, a, i, k) === false) return true; } finally { P.FPDFPage_CloseAnnot(a); }
        }
        return false;
      });
      if (stop) return;
    }
  };
  // 한 칸에 값 쓰기(검사 포함). 반환 쓴 값. f: readField 결과
  const writeField = (form, a, f, value, p) => {
    if (f.readOnly || f.type === 'button' || f.type === 'unknown') throw bad(`「${f.name}」은(는) ${f.type === 'signature' ? '서명 칸이라' : '읽기 전용이라'} 값을 바꿀 수 없습니다.`);
    let v;
    if (f.type === 'checkbox') v = value === true || (value !== false && value != null && String(value) !== 'Off' && String(value) !== '') ? f.exportValue : 'Off';
    else if (f.type === 'radio') v = value === true ? f.exportValue : value === false || value == null || value === '' ? 'Off' : String(value);
    else if (f.type === 'combo' || f.type === 'list') {
      v = Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
      // 내보내기 값(/Opt [[(ko) (Korean)]]의 ko)으로 준 값은 그 값을 가진 항목의 이름으로 바꾼다 — 항목을 하나씩 골라 보고 칸 값이 같아지는 것을 찾는다
      if (v && !f.editable && !f.options.some((o) => o.label === v) && f.type === 'list') {
        const hit = f.options.find((o) => { writeField(form, a, { ...f, options: f.options.map((x) => ({ ...x, selected: false })) }, o.label, p); return formStr((q, n) => P.FPDFAnnot_GetFormFieldValue(form, a, q, n)) === v; });
        if (hit) v = hit.label;
      }
      if (v && !f.editable && !f.options.some((o) => o.label === v)) throw bad(`「${f.name}」에 없는 항목입니다: ${v}`);
    } else {
      v = String(value ?? '').replace(/\r\n?/g, '\n');
      if (!f.multiline) v = v.replace(/\n/g, ' ');
      if (f.maxLen > 0 && [...v].length > f.maxLen) throw bad(`「${f.name}」은(는) ${f.maxLen}자까지 넣을 수 있습니다.`);
      if (v.length > 20000) throw bad('양식 값은 20,000자 이하로 넣으세요.');
    }
    if (f.type === 'list') {
      // 목록 상자는 EPDFAnnot_SetFormFieldValue가 받지 않는다(실측) → 칸에 초점을 주고 항목을 고른다(FORM_SetIndexSelected, 쪽 보기 필요)
      const want = f.options.findIndex((o) => o.label === v);
      let ok = P.FORM_SetFocusedAnnot(form, a);
      if (ok) {
        f.options.forEach((o, k) => { if (o.selected && k !== want) ok = P.FORM_SetIndexSelected(form, p, k, false) && ok; });
        if (want >= 0) ok = P.FORM_SetIndexSelected(form, p, want, true) && ok;
      }
      P.FORM_ForceToKillFocus(form);
      if (!ok) throw new Error(`「${f.name}」에서 항목을 고르지 못했습니다.`);
      return v;
    }
    const u = utf16(v);
    try { if (!P.EPDFAnnot_SetFormFieldValue(form, a, u)) throw new Error(`「${f.name}」에 값을 쓰지 못했습니다.`); } finally { free(u); }
    return v;
  };
  // 같은 이름의 글·선택 칸 위젯 외형을 모두 다시 만든다(한 칸이 여러 쪽에 나뉜 양식). 확인란·라디오는 /AS가 바뀌면 그 상태 외형을 그대로 쓴다.
  // 반환: 한글처럼 표준 글꼴로 못 그리는 값을 가진 위젯 목록(pdf-forms.js가 맑은 고딕 서브셋으로 외형을 다시 쓴다)
  const regenFields = (names) => {
    const unicode = [];
    eachWidget((form, a, i, k) => {
      const name = formStr((p, n) => P.FPDFAnnot_GetFormFieldName(form, a, p, n));
      if (!names.has(name)) return;
      const t = FIELD_TYPES[P.FPDFAnnot_GetFormFieldType(form, a)];
      if (t !== 'text' && t !== 'combo' && t !== 'list') return;
      P.EPDFAnnot_GenerateFormFieldAP(a);
      if (t === 'list') return; // 목록 상자는 고른 항목을 칠할 뿐 값 글자를 새로 그리지 않는다
      const f = readField(form, a, i, k, 0);
      if (f.value && needsUnicodeFont(f.value)) unicode.push({ i, index: k, objNum: f.objNum, value: f.value, kind: t, fontSize: f.fontSize || 0, color: f.color || '#000000', align: f.align || 0, multiline: !!f.multiline, comb: !!f.comb, maxLen: f.maxLen || 0, password: !!f.password });
    });
    return unicode;
  };

  const api = {
    get pageCount() { return P.FPDF_GetPageCount(doc); },

    // 열 때 읽은 보안 정보 { encrypted, openPassword, restricted }. 저장 바이트는 암호가 풀린 문서다(saveDoc)
    get security() { return { ...security }; },
    // 권한 비트(FPDF_GetDocPermissions, 부호 없는 32비트). 암호 없는 문서·소유자 암호로 연 문서는 0xFFFFFFFF
    get permissions() { return P.FPDF_GetDocPermissions(doc) >>> 0; },
    // 보안 처리기 리비전(암호 없으면 -1, AES-256은 6)
    get securityRevision() { return P.FPDF_GetSecurityHandlerRevision(doc); },
    // 문서 정보(/Info) 값 하나 — tag: 'Title' · 'Author' · 'Subject' · 'Producer' 등. 없으면 ''
    metaText(tag) {
      const t = String(tag), n = P.FPDF_GetMetaText(doc, t, 0, 0);
      if (n <= 2) return '';
      const b = mal(n);
      try { P.FPDF_GetMetaText(doc, t, b, n); return M.UTF16ToString(b); } finally { free(b); }
    },

    // fn() 안의 편집이 부르는 GenerateContent를 모아 가장 바깥 batch가 끝날 때(정상·예외 모두) 페이지당 한 번만 부른다. 중첩 가능. fn의 반환값을 돌려준다
    batch(fn) {
      batchDepth++;
      try { return fn(); } finally { if (--batchDepth === 0) flush(); }
    },

    // 상자 묶기/풀기. idxs의 객체에 같은 그룹 id를 붙인다 (id 생략 시 새로 발급, null이면 해제)
    setGroup(i, idxs, id) {
      const p = page(i), gid = id === null ? null : id || newGroupId();
      let n = 0;
      for (const ix of [].concat(idxs)) { const o = P.FPDFPage_GetObject(p, ix); if (!o) continue; tagGroup(o, gid); n++; }
      regen(p);
      return { ok: n > 0, id: gid, count: n };
    },

    // 실측 2026-09-09: FPDF_GetPageWidthF/HeightF는 /Rotate를 반영한다(같은 핸들에 SetRotation(1) → 595×842 이 842×595 로 바뀜).
    // 렌더 비트맵도 842×595 로 나오므로 pageSize·render는 서로 맞는다.
    // rotation(0..3, ×90°)을 함께 돌려준다 — objects()·charBoxes()·find()의 좌표는 회전 전 페이지 좌표계라
    // 화면 겹침 상자를 그리려면 호출자가 이 값으로 변환해야 한다(아래 rotatePages 주석 참고).
    // v6 Wave D: 보이는 상자(CropBox ∩ MediaBox)의 왼쪽 아래가 (0,0)이 아니면 ox·oy(회전 전 쪽 좌표)를 싣는다 — 화면 좌표 변환(pdfToScreen)이 원점을 뺀다.
    //   자르기(CropBox)를 한 쪽·원점이 옮겨진 쪽에서 상자가 어긋나지 않게. 원점이 (0,0)이면 예전 모양 그대로
    pageSize(i) {
      const p = page(i), out = { w: P.FPDF_GetPageWidthF(p), h: P.FPDF_GetPageHeightF(p), rotation: P.FPDFPage_GetRotation(p) };
      const b = mal(16);
      try {
        if (P.FPDF_GetPageBoundingBox(p, b)) { // FS_RECTF { left, top, right, bottom }
          const ox = Math.min(f32(b), f32(b + 8)), oy = Math.min(f32(b + 4), f32(b + 12));
          if (Math.abs(ox) > 0.001 || Math.abs(oy) > 0.001) { out.ox = ox; out.oy = oy; }
        }
      } finally { free(b); }
      return out;
    },

    async render(i, scale = 1) {
      return withBitmap(i, scale, (bmp, pw, ph) => {
        const outPP = mal(4);
        try {
          // EPDF_PNG_EncodeRGBA(data, w, h, stride, zlibLevel, outPtrPtr) → 바이트 수
          const size = P.EPDF_PNG_EncodeRGBA(
            P.FPDFBitmap_GetBuffer(bmp), pw, ph, P.FPDFBitmap_GetStride(bmp), 6, outPP);
          const png = i32(outPP);
          if (!size || !png) throw new Error('PNG 인코딩 실패');
          const out = Buffer.from(heap().subarray(png, png + size));
          free(png);
          return out;
        } finally { free(outPP); }
      });
    },

    // 페이지를 JPEG로. render()와 같은 비트맵(흰 배경 위 RGBA)을 jpeg-js로 인코딩한다.
    // 동기(Promise 아님) — render()처럼 await해도, 안 해도 Buffer를 받는다.
    renderJpeg(i, scale = 1, quality = 85) {
      const q = Math.max(1, Math.min(100, Math.round(Number(quality) || 85)));
      return withBitmap(i, scale, (bmp, pw, ph) => {
        // jpeg-js는 stride 없는 촘촘한 RGBA를 받는다 → 줄 단위로 옮긴다
        const buf = P.FPDFBitmap_GetBuffer(bmp), stride = P.FPDFBitmap_GetStride(bmp), H = heap();
        const data = Buffer.alloc(pw * ph * 4);
        for (let y = 0; y < ph; y++) data.set(H.subarray(buf + y * stride, buf + y * stride + pw * 4), y * pw * 4);
        return encodeJpeg(data, pw, ph, q);
      });
    },

    // Render only the selected region; no full document image is sent to AI.
    renderRegion(i, bounds, scale = 2) {
      const size = api.pageSize(i);
      if (!bounds || !Object.values(bounds).every(Number.isFinite)) throw new Error('잘못된 미리보기 범위');
      const d = deviceRect(i, { x0: bounds.x0 - 8, y0: bounds.y0 - 8, x1: bounds.x1 + 8, y1: bounds.y1 + 8 }, 1); // 회전·CropBox 반영
      const x = d.x0, top = d.y0, w = d.x1 - d.x0 + 1, h = d.y1 - d.y0 + 1;
      if (!(w > 1 && h > 1)) throw new Error('선택 영역이 페이지 밖에 있습니다.');
      const s = Math.min(scale, 1600 / w, 600 / h), pw = Math.max(1, Math.ceil(w * s)), ph = Math.max(1, Math.ceil(h * s));
      const bmp = P.FPDFBitmap_Create(pw, ph, 0), outPP = mal(4);
      if (!bmp) { free(outPP); throw new Error('미리보기 생성 실패'); }
      try {
        P.FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 0xffffffff);
        renderInto(bmp, i, -Math.round(x * s), -Math.round(top * s), Math.round(size.w * s), Math.round(size.h * s));
        const len = P.EPDF_PNG_EncodeRGBA(P.FPDFBitmap_GetBuffer(bmp), pw, ph, P.FPDFBitmap_GetStride(bmp), 6, outPP);
        const ptr = i32(outPP);
        if (!len || !ptr) throw new Error('미리보기 PNG 생성 실패');
        try { return Buffer.from(heap().subarray(ptr, ptr + len)); } finally { free(ptr); }
      } finally { free(outPP); P.FPDFBitmap_Destroy(bmp); }
    },

    // maxWidth: 줄 단위 상자처럼 여러 조각을 한 객체로 합칠 때 "기존 폭"의 기준(없으면 이 객체의 폭)
    setFontText(i, idx, text, { fontId, size, fit = true, maxWidth: lineWidth }) {
      const o = P.FPDFPage_GetObject(page(i), idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) throw new Error('텍스트 상자를 선택하세요.');
      if (typeof text !== 'string' || !text.trim() || text.length > 2000 || /[\r\n]/.test(text)) throw new Error('폰트 맞추기는 2,000자 이하의 한 줄씩 적용하세요.');
      if (!Number.isFinite(size) || size < 1 || size > 300) throw new Error('글자 크기는 1~300pt 범위로 입력하세요.');
      const entry = fontRegistry.get(fontId), absent = fontRegistry.missing(entry, text);
      if (absent.length) throw new Error(`선택한 폰트에 없는 글자: ${absent.slice(0, 12).join(' ')}`);
      const before = api.objects(i)[idx], previous = selectedFont;
      selectedFont = entry;
      try {
        // Preserve the old bounds for image covering; change size on the newly created object.
        selectedFont = { ...entry, size };
        const r = api.setText(i, idx, text);
        if (!r.ok) throw new Error('선택한 폰트로 글자를 그리지 못했습니다.');
        const index = r.idx ?? idx, neo = P.FPDFPage_GetObject(page(i), index);
        const after = api.objects(i)[index], width = after.bounds.x1 - after.bounds.x0;
        const maxWidth = lineWidth > 0 ? lineWidth : before.bounds.x1 - before.bounds.x0;
        if (fit && width > maxWidth && maxWidth > 0) {
          const factor = maxWidth / width, m = mal(24);
          try {
            if (P.FPDFPageObj_GetMatrix(neo, m)) {
              for (const k of [0, 4, 8, 12]) M.setValue(m + k, f32(m + k) * factor, 'float');
              P.FPDFPageObj_SetMatrix(neo, m);
            }
          } finally { free(m); }
        }
        regen(page(i));
        return { ...r, idx: index, fontId, fontLabel: entry.label };
      } finally { selectedFont = previous; }
    },

    fontStatus(i, idx, text) {
      const object = api.objects(i)[idx];
      if (!object || object.type !== 'text') throw new Error('텍스트 상자를 선택하세요.');
      const o = P.FPDFPage_GetObject(page(i), idx);
      if (object.hidden) return { needsAi: true, reason: '화면 글자가 그림으로 표시되어 검색용 폰트만으로 같은 모양을 재현할 수 없습니다.' };
      if (object.fontId) {
        try {
          if (!fontRegistry.missing(fontRegistry.get(object.fontId), text).length) return { needsAi: false, reason: '지정한 폰트로 직접 편집할 수 있습니다.' };
        } catch {}
        return { needsAi: true, reason: '지정한 폰트가 없거나 입력한 글자를 지원하지 않습니다.' };
      }
      if (canRender(P.FPDFTextObj_GetFont(o), text, object.size)) return { needsAi: false, reason: 'PDFium이 현재 폰트로 직접 편집할 수 있습니다.' };
      return { needsAi: true, reason: '원본 폰트를 재사용할 수 없거나 입력한 글리프가 없습니다.' };
    },

    // 자체 검사용: PNG 인코딩 없이 RGBA 원본 픽셀
    _renderRaw(i, scale = 1) {
      return withBitmap(i, scale, (bmp, pw, ph) => {
        const buf = P.FPDFBitmap_GetBuffer(bmp), stride = P.FPDFBitmap_GetStride(bmp);
        return { w: pw, h: ph, stride, data: Buffer.from(heap().subarray(buf, buf + stride * ph)) };
      });
    },

    // 텍스트 객체에는 glyphs도 싣는다: 텍스트 위치마다 [x, y, w] — 그 글자의 기준선 시작점(회전 전 쪽 좌표)과 글자 방향 진행 폭.
    // 줄 묶기(text-grouping.js)가 낱말 틈·자간·칸 사이 빈 띠를 글자 단위로 재는 데 쓴다(객체 상자는 뒤 공백·기울임 때문에 넓다).
    objects(i) {
      const p = page(i), n = P.FPDFPage_CountObjects(p);
      const tp = P.FPDFText_LoadPage(p);
      const scratch = mal(32); // float 4개(bounds) + uint 4개(color) 공용
      const mbuf = mal(24);    // FS_MATRIX {a,b,c,d,e,f} — 텍스트 객체의 기준선 원점(e,f)을 읽는다
      const gbuf = mal(32);    // objText(글자 원점·느슨한 상자) 전용
      const r2 = (v) => Math.round(v * 100) / 100;
      try {
        const byObj = charsByObject(tp);
        const list = [];
        for (let idx = 0; idx < n; idx++) {
          const o = P.FPDFPage_GetObject(p, idx);
          const t = P.FPDFPageObj_GetType(o);
          const item = {
            idx,
            type: t === OBJ_TEXT ? 'text' : t === OBJ_IMAGE ? 'image' : t === OBJ_PATH ? 'path' : 'other',
            text: null, font: null, size: null,
            bounds: null, color: [0, 0, 0, 255], mask: false,
          };
          item.mask = !!findMark(o, MARK_MASK);
          if (findMark(o, MARK_PAGENUM)) item.pageNum = true; // 쪽 번호 글자(다시 매기기·지우기 대상)
          if (findMark(o, MARK_HF)) item.headerFooter = true; // 머리말·꼬리말 글자
          if (findMark(o, MARK_WM)) item.watermark = true;    // 워터마크 글자·그림
          if (findMark(o, MARK_BATES)) item.bates = true;     // v6 Wave D: 베이츠 번호 글자
          if (findMark(o, MARK_DECO)) item.deco = true;       // v6 밑줄·취소선 선(syncDeco가 다시 그린다)
          const st = t === OBJ_TEXT ? styleOf(o) : null;
          if (st) item.style = st;                            // v6 글자 모양 표시(밑줄·취소선·가짜 굵게/기울임·첨자)
          const sb = t === OBJ_TEXT ? substOf(o) : null;      // v6 Wave B 대체 글꼴: { orig, used, kind, session(이번 실행에서 바꿨다) }
          if (sb) item.subst = { orig: sb.orig || '', used: sb.used || '', kind: sb.kind || 'fallback', session: sb.sid === SESSION_ID };
          // 보이지 않는 글자: 채움 알파 0 또는 렌더 모드 3(invisible)/7(clip). PowerPoint가 글자 효과를 그림으로 내보내며 검색용으로 깔아 둔 투명 글자
          if (t === OBJ_TEXT) {
            const rm = P.FPDFTextObj_GetTextRenderMode(o); item.hidden = rm === 3 || rm === 7;
            item.renderMode = rm; // 2 = 채움+외곽선: Word가 굵게를 흉내낼 때 쓴다(가짜 굵게)
            item.strokeWidth = P.FPDFPageObj_GetStrokeWidth(o, scratch) ? f32(scratch) : null;
            item.weight = P.FPDFFont_GetWeight ? P.FPDFFont_GetWeight(P.FPDFTextObj_GetFont(o)) : null;
          }
          item.group = groupOf(o); // 줄바꿈 줄들·사용자 그룹 (없으면 null)
          const fm = findMark(o, 'RetextPdfFont');
          if (fm) { item.fontId = markParam(fm, 'id'); item.fontLabel = markParam(fm, 'label'); }
          P.FPDFPageObj_GetBounds(o, scratch, scratch + 4, scratch + 8, scratch + 12);
          item.bounds = { x0: f32(scratch), y0: f32(scratch + 4), x1: f32(scratch + 8), y1: f32(scratch + 12) };
          if (P.FPDFPageObj_GetFillColor(o, scratch, scratch + 4, scratch + 8, scratch + 12)) {
            item.color = [i32(scratch), i32(scratch + 4), i32(scratch + 8), i32(scratch + 12)];
          }
          if (t === OBJ_TEXT && item.color[3] === 0) item.hidden = true; // 알파 0도 투명 글자
          if (t === OBJ_TEXT) {
            // 객체가 직접 그린 글자만(objText 참고). 텍스트 페이지가 중복으로 보고 뺀 사본(가짜 굵게)은 글자가 없어 ''
            const info = objText(tp, o, byObj.get(o) || [], gbuf, true);
            item.text = info.text;
            item.glyphs = info.geo.map((g) => [r2(g[0]), r2(g[1]), r2(g[2])]);
            P.FPDFTextObj_GetFontSize(o, scratch);
            item.size = f32(scratch);
            const font = P.FPDFTextObj_GetFont(o);
            const nb = mal(256);
            const len = P.FPDFFont_GetBaseFontName(font, nb, 256);
            item.font = len ? M.UTF8ToString(nb) : '';
            free(nb);
            // 기준선(baseline). bounds.y0는 글자 잉크의 아래끝이라 같은 줄이라도 글자마다 다르다
            // ("(" 처럼 아래로 내려가는 글자, 받침 없는 글자…) → 줄 묶기에 쓰면 한 줄이 여러 행으로 쪼개진다.
            // 텍스트 행렬의 (e,f)가 그 객체가 그려지기 시작한 기준선 원점이므로 줄 판정은 이것으로 한다.
            if (P.FPDFPageObj_GetMatrix(o, mbuf)) {
              const m = [0, 1, 2, 3, 4, 5].map((k) => f32(mbuf + k * 4));
              item.matrix = m;                        // [a,b,c,d,e,f]
              item.origin = { x: m[4], y: m[5] };     // 기준선 시작점
              item.scaledSize = item.size * Math.hypot(m[0], m[1]); // 행렬 배율까지 반영한 실제 글자 크기
            }
          }
          list.push(item);
        }
        return list;
      } finally { free(scratch); free(mbuf); free(gbuf); P.FPDFText_ClosePage(tp); }
    },

    // 줄바꿈 지원: PDF 텍스트 객체는 한 줄이라 '\n'을 넣으면 □로 그려진다.
    // 첫 줄은 기존 객체에(setOne), 나머지 줄은 같은 폰트·크기·색으로 새 객체를 만들어 행간만큼 아래(idx+k)에 넣는다.
    setText(i, idx, newText) {
      const lines = String(newText ?? '').split(/\r?\n/);
      const p = page(i), orig = P.FPDFPage_GetObject(p, idx);
      if (orig && P.FPDFPageObj_GetType(orig) === OBJ_TEXT) {
        const entry = chosenFont(orig);
        if (entry && fontRegistry.missing(entry, lines.join('')).length) return { ok: false, reason: '선택한 폰트에 입력한 글자가 없습니다.', fallbackFont: false };
      }
      // 굵기는 원래 객체에서 읽어 둔다 — _setOne이 폴백으로 바꾸면 폰트 이름이 "Untitled"라 굵기를 잃는다
      const bold = orig && P.FPDFPageObj_GetType(orig) === OBJ_TEXT ? isBold(orig) : false;
      const r = api._setOne(i, idx, lines[0]);
      if (!r.ok) return r;
      if (r.idx != null) idx = r.idx; // 투명 글자를 드러내면 객체가 맨 뒤로 간다
      if (lines.length < 2) { // 한 줄로 돌아오면 줄바꿈 그룹 표시는 뗀다
        const o1 = P.FPDFPage_GetObject(p, idx);
        if (o1 && findMark(o1, MARK_GROUP)) { tagGroup(o1, null); regen(p); }
        return r;
      }
      const o = P.FPDFPage_GetObject(p, idx), gid = newGroupId();
      tagGroup(o, gid);
      const m = mal(24), c = mal(16);
      try {
        P.FPDFTextObj_GetFontSize(o, c); const size = f32(c);
        if (!P.FPDFPageObj_GetMatrix(o, m)) return r;
        // 행간 이동을 행렬(a b c d e f)에 통과시킨다: 텍스트 공간의 (0, −lh)는 사용자 공간에서 (−lh·c, −lh·d).
        // 기울임(synthetic italic, c≠0)·회전(b,c≠0) 텍스트도 같은 식으로 줄이 따라간다 — 계약서의 이탤릭 날짜 셀에서 둘째 줄이 사라지던 원인
        const cc = f32(m + 8), d = f32(m + 12), e = f32(m + 16), f = f32(m + 20);
        const lh = LINE_HEIGHT * size; // ponytail: 행간은 PDFium이 알려주지 않는다 → 글자 크기의 1.2배(텍스트 공간). 문서에 안 맞으면 LINE_HEIGHT 조정
        const color = P.FPDFPageObj_GetFillColor(o, c, c + 4, c + 8, c + 12) ? [i32(c), i32(c + 4), i32(c + 8), i32(c + 12)] : null;
        let fallback = r.fallbackFont; const lineIdxs = [idx];
        for (let k = 1; k < lines.length; k++) {
          const text = lines[k] || ' ';
          const entry = chosenFont(o);
          let font = entry ? customFont(entry, text) : P.FPDFTextObj_GetFont(o), fb = false, sub = null;
          if (!canRender(font, text, size)) { sub = substituteFont(o, text, bold); font = sub.font; fb = true; if (!font || !canRender(font, text, size)) return { ok: false, reason: noGlyphReason(font, text, size) }; }
          const neo = P.FPDFPageObj_CreateTextObj(doc, font, size);
          const u = utf16(text); const ok = neo && P.FPDFText_SetText(neo, u); free(u);
          if (!ok) { if (neo) P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '새 줄을 만들지 못했습니다.' }; }
          M.setValue(m + 16, e - k * lh * cc, 'float'); M.setValue(m + 20, f - k * lh * d, 'float'); P.FPDFPageObj_SetMatrix(neo, m);
          if (color) P.FPDFPageObj_SetFillColor(neo, color[0], color[1], color[2], color[3]);
          copyTextStyle(o, neo); copyStyleMark(o, neo); if (sub) setSubst(neo, sub);
          // 맨 뒤(가장 위 z-순서)에 넣는다. 원래 글자 바로 뒤에 끼우면 표 셀 배경 같은 뒤쪽 채움 도형이 새 줄을 덮어 글자가 사라진다
          tagGroup(neo, gid);
          if (entry) tagFont(neo, entry);
          P.FPDFPage_InsertObject(p, neo);
          lineIdxs.push(P.FPDFPage_CountObjects(p) - 1); fallback = fallback || fb;
        }
        regen(p);
        return { ok: true, fallbackFont: fallback, inserted: lineIdxs.length - 1, lineIdxs, group: gid, ...(r.revealed ? { revealed: true } : {}) };
      } finally { free(m); free(c); }
    },
    // 폭 맞춤. 긴 글을 넣어도 옆 글자와 겹치지 않게:
    //   'wrap'   사용 가능한 폭(maxWidth)에 맞춰 단어 단위 줄바꿈 → setText의 여러 줄 배치. 폭 측정은 실제로 SetText 해보고 bounds를 읽는다(폰트 메트릭 추정 없음)
    //   'shrink' 첫 줄 폭이 넘치면 행렬(a,b,c,d)을 같은 비율로 줄여 글자를 축소 (표 셀처럼 줄을 늘릴 수 없을 때)
    //   'none'   그대로 (setText)
    // 폭을 재느라 _setOne을 여러 번 부르므로 batch로 묶어 콘텐츠 재생성을 한 번만 한다
    fitText(i, idx, text, maxWidth, mode = 'wrap') { return api.batch(() => api._fitText(i, idx, text, maxWidth, mode)); },
    _fitText(i, idx, text, maxWidth, mode) {
      if (!(maxWidth > 0) || mode === 'none') return api.setText(i, idx, text);
      let revealed = false, measurementFailure = null;
      const width = (s) => { const r = api._setOne(i, idx, s); if (!r.ok) { measurementFailure = r; return -1; } if (r.idx != null) idx = r.idx; revealed ||= !!r.revealed; const b = api.objects(i)[idx].bounds; return b.x1 - b.x0; };
      const result = (r) => revealed ? { ...r, revealed: true, ...(r.lineIdxs ? {} : { idx: r.idx ?? idx }) } : r;
      const lines = String(text ?? '').split(/\r?\n/);
      // 줄이 여럿이면 먼저 전부 한 번 재 둔다: 뒤 줄 때문에 대체 글꼴로 바뀌면(한 번 바뀌면 계속 대체 글꼴) 앞서 원래 글꼴로 잰 폭이
      // 최종 그림(첫 줄도 대체 글꼴)과 달라진다. 이 한 번으로 이후 측정이 모두 최종과 같은 글꼴이 된다
      if (lines.length > 1) { lines.forEach(width); if (measurementFailure) return measurementFailure; }
      if (mode === 'shrink') {
        const w = Math.max(...lines.map(width));
        if (measurementFailure) return measurementFailure;
        const r = api.setText(i, idx, text);
        if (r.ok && w > maxWidth) {
          const s = maxWidth / w, m = mal(24), p = page(i);
          try {
            for (const li of r.lineIdxs || [idx]) {
              const o = P.FPDFPage_GetObject(p, li);
              if (!P.FPDFPageObj_GetMatrix(o, m)) continue;
              for (const k of [0, 4, 8, 12]) M.setValue(m + k, f32(m + k) * s, 'float'); // a b c d 축소 (원점 e,f 유지) — 회전·기울임 글자도 모양 그대로
              P.FPDFPageObj_SetMatrix(o, m);
            }
            regen(p);
          } finally { free(m); }
          r.scaled = s;
        }
        return result(r);
      }
      const out = [];
      for (let line of lines) {
        for (let guard = 0; line !== null; guard++) {
          const w = width(line);
          if (measurementFailure) return measurementFailure;
          // 50번을 넘기면 남은 글을 한 줄로 둔다 — 글자를 버리지 않는다
          if (guard >= 50 || w <= maxWidth || line.trim().length < 2) { out.push(line); break; }
          // 폭 비례로 자르고, 그 앞의 공백이 있으면 단어 경계로. 비례 추정은 넓은 글자(한글)와 좁은 글자(라틴·공백)가 섞이면
          // 틀린다(실측: 줄이 maxWidth보다 최대 28% 넓었다) → 자른 앞부분을 실제로 재 보고 넘치면 더 줄인다
          let cut = Math.floor(line.length * maxWidth / w);
          for (;;) {
            const sp = line.lastIndexOf(' ', cut);
            let c = sp > 0 ? sp : Math.max(1, cut);
            if (/[\uD800-\uDBFF]/.test(line[c - 1])) c += c > 1 ? -1 : 1; // 서로게이트 쌍을 가르지 않는다
            const hw = [...line.slice(0, c)].length < 2 ? 0 : width(line.slice(0, c).trimEnd()); // 한 글자는 더 못 자른다
            if (measurementFailure) return measurementFailure;
            if (hw <= maxWidth) { cut = c; break; }
            cut = Math.min(c - 1, Math.floor(c * maxWidth / hw));
          }
          out.push(line.slice(0, cut).trimEnd()); line = line.slice(cut).trimStart();
          if (!line) line = null;
        }
      }
      const r = api.setText(i, idx, out.join('\n'));
      r.wrapped = out.length;
      return result(r);
    },

    // 한 줄 교체(내부). 1) 원본 폰트로 그릴 수 있으면 그대로 SetText (폰트·모양 보존)
    //                   2) 글리프가 없으면 시스템 한글 폰트로 새 객체를 만들어 자리 바꿔치기
    // 한 줄 교체 + 투명 글자 처리. 투명 글자(hidden)를 고치면: 그 자리의 그림을 배경색 사각형으로 덮고, 글자를 글자색으로 보이게 바꿔 맨 위에 올린다.
    // 객체가 맨 뒤로 가므로 idx가 바뀐다 → {idx}로 돌려준다.
    _setOne(i, idx, newText) {
      const p = page(i), o0 = P.FPDFPage_GetObject(p, idx);
      if (!o0 || P.FPDFPageObj_GetType(o0) !== OBJ_TEXT) return { ok: false, fallbackFont: false, reason: '텍스트 상자를 다시 선택하세요.' };
      const hidden = !!(o0 && P.FPDFPageObj_GetType(o0) === OBJ_TEXT && [3, 7].includes(P.FPDFTextObj_GetTextRenderMode(o0)) || (o0 && (() => { const c = mal(16); try { return P.FPDFPageObj_GetFillColor(o0, c, c + 4, c + 8, c + 12) && i32(c + 12) === 0; } finally { free(c); } })()));
      let cover = null, ink = null, background = null;
      if (hidden) { // 편집 전에 재야 한다: 그림(보이는 글자)이 아직 있을 때 배경색·글자색을 뽑는다
        const all = api.objects(i), b = all[idx].bounds, pad = 3;
        cover = { x0: b.x0 - pad, y0: b.y0 - pad, x1: b.x1 + pad, y1: b.y1 + pad };
        // 보이는 글자는 그림 타일이고, 타일은 투명 텍스트 상자와 어긋나 있다(PowerPoint: 한 조각의 타일이 옆 조각 자리까지 걸침).
        // 텍스트 상자와 세로로 절반 이상 겹치고 가로로 겹치거나 맞닿은(2pt) 이미지 타일을 모두 덮는 범위에 넣는다.
        const th = b.y1 - b.y0;
        for (const o of all) {
          if (o.type !== 'image' || !o.bounds) continue;
          const vy = Math.min(o.bounds.y1, b.y1) - Math.max(o.bounds.y0, b.y0);
          const hx = Math.min(o.bounds.x1, b.x1) - Math.max(o.bounds.x0, b.x0);
          const tw = o.bounds.x1 - o.bounds.x0;
          // 가로로 '실질적으로' 겹치는 타일만(겹침 폭이 타일·텍스트 중 좁은 쪽의 절반 이상). 맞닿기만 한 옆 조각 타일은 제외
          if (vy > 0.5 * th && hx > 0.5 * Math.min(tw, b.x1 - b.x0)) cover = { x0: Math.min(cover.x0, o.bounds.x0), y0: Math.min(cover.y0, o.bounds.y0), x1: Math.max(cover.x1, o.bounds.x1), y1: Math.max(cover.y1, o.bounds.y1) };
        }
        // 타일은 옆 단어까지 걸치므로, 타일 범위 안에서 '이 단어의 잉크가 이어지는 가로 구간'만 덮는다:
        // 텍스트 상자 가운데에서 좌우로 나가며 잉크 없는 빈 열이 gap(글자 크기의 0.25) 이상 이어지면 멈춘다
        cover = api._inkExtent(i, cover, b);
        ink = api.sampleInk(i, cover);
        background = api.sampleColor(i, cover);
      }
      // 투명 글자는 항상 새 객체로 다시 만든다(forceNew): 제자리 SetText면 옛 객체의 ExtGState(ca 0)가 저장 시 그대로 기록돼 다시 투명해진다
      const r = api._setOneRaw(i, idx, newText, hidden);
      if (!r.ok || !hidden) return r;
      const o = P.FPDFPage_GetObject(p, idx);
      P.FPDFTextObj_SetTextRenderMode(o, 0);
      // 알파 254: PDFium은 알파가 정확히 1.0이면 gs를 안 써서 원래의 ca 0(투명)이 저장 후 되살아난다. 1.0이 아닌 값이어야 명시적으로 기록된다
      P.FPDFPageObj_SetFillColor(o, ink[0], ink[1], ink[2], 254);
      // 폰트/글리프 검사에 실패하면 원본 화면을 그대로 둔다. 배경은 교체 전에 측정하되 덮개는 성공 후에만 추가한다.
      api.addRect(i, cover, background);
      P.FPDFPage_RemoveObject(p, o); P.FPDFPage_InsertObject(p, o); // 맨 위(z-순서)로
      regen(p);
      return { ...r, idx: P.FPDFPage_CountObjects(p) - 1, revealed: true, ink };
    },

    _setOneRaw(i, idx, newText, forceNew = false) {
      if (!newText) newText = ' '; // 빈 문자열로 SetText하면 PDFium(WASM)이 unreachable 트랩으로 죽는다
      const p = page(i);
      const o = P.FPDFPage_GetObject(p, idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, fallbackFont: false, reason: '텍스트 상자를 다시 선택하세요.' };

      const scratch = mal(24); // FS_MATRIX(6 float) 겸 float/색 버퍼
      const u16 = utf16(newText);
      try {
        P.FPDFTextObj_GetFontSize(o, scratch);
        const entry = chosenFont(o);
        const size = selectedFont?.size || f32(scratch);
        // 우리가 넣은 대체 폰트("Untitled")는 제자리 SetText를 하지 않는다: 저장·재열기(실행 취소) 뒤에 그 객체를 다시 SetText하면
        // PDFium이 임베드 폰트 대신 시스템 폰트로 대체해 가늘고 벌어진 글자가 된다(사용자 보고). 항상 새 서브셋으로 객체를 다시 만든다.
        const nb0 = mal(256); const fname = P.FPDFFont_GetBaseFontName(P.FPDFTextObj_GetFont(o), nb0, 256) ? M.UTF8ToString(nb0) : ''; free(nb0);
        const origOk = !entry && fname !== 'Untitled' && canRender(P.FPDFTextObj_GetFont(o), newText, size);
        if (origOk && !forceNew) {
          const ok = !!P.FPDFText_SetText(o, u16);
          if (ok) regen(p);
          return { ok, fallbackFont: false };
        }

        const bold = isBold(o);
        // forceNew이고 원본 폰트로 그릴 수 있으면 원본 폰트로 새 객체(폰트 보존), 아니면 대체 폰트
        const usingOrig = origOk && forceNew;
        const sub = entry || usingOrig ? null : substituteFont(o, newText, bold); // v6 Wave B: 같은 집안 설치 폰트 → 고정폭 → 맑은 고딕
        const font = entry ? customFont(entry, newText) : usingOrig ? P.FPDFTextObj_GetFont(o) : sub.font;
        // 시스템 한글 폰트가 없거나, 서브셋에도 없는 글자(폰트 자체에 글리프 없음)면 두부(□)로 그려질 테니 거절
        if (!font || !canRender(font, newText, size)) return { ok: false, fallbackFont: false, reason: noGlyphReason(font, newText, size) };

        const neo = P.FPDFPageObj_CreateTextObj(doc, font, size);
        if (!neo || !P.FPDFText_SetText(neo, u16)) {
          if (neo) P.FPDFPageObj_Destroy(neo);
          return { ok: false, fallbackFont: false, reason: '새 텍스트 객체를 만들지 못했습니다.' };
        }
        if (P.FPDFPageObj_GetMatrix(o, scratch)) P.FPDFPageObj_SetMatrix(neo, scratch);
        if (P.FPDFPageObj_GetFillColor(o, scratch, scratch + 4, scratch + 8, scratch + 12)) {
          P.FPDFPageObj_SetFillColor(neo, i32(scratch), i32(scratch + 4), i32(scratch + 8), i32(scratch + 12));
        }
        copyTextStyle(o, neo); copyStyleMark(o, neo);
        if (sub) setSubst(neo, sub);
        if (entry) tagFont(neo, entry);
        const gid = groupOf(o); if (gid) tagGroup(neo, gid);
        // 같은 자리에 넣어 idx가 밀리지 않게 한다
        if (!P.FPDFPage_InsertObjectAtIndex(p, neo, idx)) P.FPDFPage_InsertObject(p, neo);
        P.FPDFPage_RemoveObject(p, o);
        P.FPDFPageObj_Destroy(o); // 페이지에서 뗀 객체는 직접 해제해야 샘 안 남
        // 투명 글자 교체는 _setOne에서 색/알파를 확정한 뒤 콘텐츠를 만든다.
        // ca=0인 중간 객체를 먼저 기록하면 PDFium의 ExtGState 리소스가 재사용돼 저장 후 다시 투명해질 수 있다.
        if (!forceNew) regen(p);
        return { ok: true, fallbackFont: !usingOrig && !entry, ...(sub ? { substitute: { orig: sub.orig, used: sub.used, kind: sub.kind } } : {}) };
      } finally { free(u16); free(scratch); }
    },

    // ── 2단계(조각별 모양 보존 편집·문단 다시 흘리기, pdf-edit-service.editRuns)가 쓰는 도구 ─────────────
    // 편집 뒤 이 객체(또는 이 객체를 본뜬 새 객체)가 text를 그릴 글꼴 — _setOneRaw와 같은 규칙:
    // 지정 폰트가 있으면 그것, 원래 글꼴로 그릴 수 있으면(대체 글꼴 "Untitled"는 제외) 원래 글꼴, 아니면 굵기에 맞춘 대체 글꼴
    _fontFor(o, text, size) {
      const entry = chosenFont(o);
      if (entry) return { font: customFont(entry, text), entry, fallback: false };
      const nb = mal(256); const fname = P.FPDFFont_GetBaseFontName(P.FPDFTextObj_GetFont(o), nb, 256) ? M.UTF8ToString(nb) : ''; free(nb);
      if (fname !== 'Untitled' && canRender(P.FPDFTextObj_GetFont(o), text, size)) return { font: P.FPDFTextObj_GetFont(o), entry: null, fallback: false };
      const sub = substituteFont(o, text);
      return { font: sub.font, entry: null, fallback: true, sub };
    },
    // 글자별 진행 폭 추정(쪽 단위, UTF-16 위치마다 — 서로게이트 쌍의 둘째 칸은 0). 줄 나누기 판단용이다:
    // 실제 위치는 고쳐 쓴 뒤 objects()의 글자 위치로 다시 잰다. 폭 = 글리프 폭(FPDFFont_GetGlyphWidth, 유니코드 기준) × 행렬 배율.
    // 자간(Tc)·장평(Tz)은 반영하지 않는다 — 호출 쪽이 원래 글의 실측 폭으로 보정한다(calib)
    measureText(i, idx, text) {
      const o = P.FPDFPage_GetObject(page(i), idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: '텍스트 상자를 다시 선택하세요.' };
      const s = mal(24);
      try {
        P.FPDFTextObj_GetFontSize(o, s); const size = f32(s);
        const scale = P.FPDFPageObj_GetMatrix(o, s) ? Math.hypot(f32(s), f32(s + 4)) : 1;
        const { font, fallback } = api._fontFor(o, text, size);
        if (!font) return { ok: false, reason: noGlyphReason(font, text, size) };
        const adv = [];
        for (let k = 0; k < text.length; k++) {
          const cp = text.codePointAt(k);
          adv.push(P.FPDFFont_GetGlyphWidth(font, cp, size, s) ? f32(s) * scale : 0.5 * size * scale);
          if (cp > 0xffff) { adv.push(0); k++; }
        }
        return { ok: true, adv, fallback };
      } finally { free(s); }
    },
    // 객체 idx를 본뜬 새 텍스트 객체(글꼴·크기·행렬·색·그리기 방식·마크 그대로)를 맨 뒤(가장 위 z-순서)에 넣는다 — 앞 인덱스는 그대로다.
    // 줄을 나눠 다음 줄로 넘기는 조각·한 객체를 둘로 가르는 뒷부분에 쓴다. 위치는 원래 행렬 그대로(호출 쪽이 move로 옮긴다)
    cloneText(i, idx, text) {
      const p = page(i), o = P.FPDFPage_GetObject(p, idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: '텍스트 상자를 다시 선택하세요.' };
      if (!text) text = ' ';
      const s = mal(24), u16 = utf16(text);
      try {
        P.FPDFTextObj_GetFontSize(o, s); const size = f32(s);
        const { font, entry, fallback, sub } = api._fontFor(o, text, size);
        if (!font || !canRender(font, text, size)) return { ok: false, reason: noGlyphReason(font, text, size) };
        const neo = P.FPDFPageObj_CreateTextObj(doc, font, size);
        if (!neo || !P.FPDFText_SetText(neo, u16)) { if (neo) P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '새 텍스트 객체를 만들지 못했습니다.' }; }
        if (P.FPDFPageObj_GetMatrix(o, s)) P.FPDFPageObj_SetMatrix(neo, s);
        if (P.FPDFPageObj_GetFillColor(o, s, s + 4, s + 8, s + 12)) P.FPDFPageObj_SetFillColor(neo, i32(s), i32(s + 4), i32(s + 8), i32(s + 12));
        copyTextStyle(o, neo); copyStyleMark(o, neo); if (sub) setSubst(neo, sub);
        if (entry) tagFont(neo, entry);
        const gid = groupOf(o); if (gid) tagGroup(neo, gid);
        P.FPDFPage_InsertObject(p, neo);
        regen(p);
        return { ok: true, idx: P.FPDFPage_CountObjects(p) - 1, fallbackFont: fallback, ...(sub ? { substitute: { orig: sub.orig, used: sub.used, kind: sub.kind } } : {}) };
      } finally { free(u16); free(s); }
    },
    // ── v6 Wave B: 글자 간격(TJ 커닝) 지키며 고쳐 쓰기 ─────────────────────────────
    // PDFium의 SetText는 객체의 TJ 간격(커닝·낱말 사이 숫자)을 모두 지운다 — 고치지 않은 글자까지 기본 진행 폭으로 다시 놓여 "T o tal"이 "To tal"처럼 벌어진다.
    // 앞뒤가 같은 글(가운데만 고침)이면: 안 고친 앞·뒤 글자는 간격이 바뀌는 자리마다 작은 객체로 나눠 원래 글자 자리에 그대로 놓고
    // (조각 안에는 간격 조정이 없으므로 SetText해도 자리가 같다), 고친 가운데만 새로 쓴다. 뒤 글자들은 가운데 폭이 바뀐 만큼 함께 민다.
    // PDFium이 끼운 공백(TJ의 큰 음수 = 낱말 사이)은 글자가 아니므로 쓰지 않고 그 자리 간격으로 남긴다.
    // 간격 조정이 없는 객체·앞뒤가 모두 바뀐 글은 { ok:false, reason } — 호출한 쪽이 보통 SetText로 고친다.
    // 잃는 것: 바뀐 가운데 글자 안의 커닝, 가운데와 뒤 글자 사이의 원래 커닝(뒤 글자끼리의 간격은 지킨다). 자간(Tc)을 쓴 객체는 글자마다 나뉜다
    // 반환 { ok, idxs(보이는 순서의 객체들 — 원래 객체 idx도 그 안), texts, kept(지킨 글자 수), fallbackFont, substitute? }
    rewriteKerned(i, idx, newText) {
      return api.batch(() => {
        const p = page(i), o = P.FPDFPage_GetObject(p, idx);
        if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: 'not-text' };
        const item = api.objects(i)[idx], text = item.text || '', n = text.length, g = item.glyphs, m = item.matrix;
        newText = String(newText ?? '');
        if (!m || !g || g.length !== n || item.hidden || n < 2) return { ok: false, reason: 'geometry' };
        // 같은 앞·뒤(서로게이트 쌍을 가르지 않는다)
        let pre = 0;
        while (pre < n && pre < newText.length && text[pre] === newText[pre]) pre++;
        if (pre > 0 && pre < n && /[\uDC00-\uDFFF]/.test(text[pre])) pre--;
        let suf = 0;
        while (suf < n - pre && suf < newText.length - pre && text[n - 1 - suf] === newText[newText.length - 1 - suf]) suf++;
        if (suf > 0 && /[\uDC00-\uDFFF]/.test(text[n - suf])) suf--;
        if (text === newText) return { ok: false, reason: 'same' };
        if (!pre && !suf) return { ok: false, reason: 'nothing-kept' };
        // 글자마다 PDFium이 끼운 글자인가(objects()의 글과 같은 함수로 대응)
        const gen = new Array(n).fill(false);
        {
          const tp = P.FPDFText_LoadPage(p), sc = mal(32);
          try {
            const list = [];
            for (let c = 0, cn = P.FPDFText_CountChars(tp); c < cn; c++) {
              if (P.FPDFText_GetTextObject(tp, c) !== o) continue;
              const u = P.FPDFText_GetUnicode(tp, c);
              if (u) list.push({ c, u, gen: !!P.FPDFText_IsGenerated(tp, c) });
            }
            const { at } = objText(tp, o, list, sc, false);
            if (at.length !== n) return { ok: false, reason: 'charmap' };
            const genC = new Set(list.filter((x) => x.gen).map((x) => x.c));
            at.forEach((c, k) => { gen[k] = genC.has(c); });
          } finally { free(sc); P.FPDFText_ClosePage(tp); }
        }
        const len = Math.hypot(m[0], m[1]) || 1, cos = m[0] / len, sin = m[1] / len, em = (item.size || 1) * len;
        const U = (k) => g[k][0] * cos + g[k][1] * sin, endOf = (k) => U(k) + g[k][2];
        const low = (k) => /[\uDC00-\uDFFF]/.test(text[k]);
        // 간격이 바뀌는 자리(k 앞에서 끊는다): 끼운 글자 앞뒤 · 앞 글자의 진행 끝과 이 글자 자리가 0.005em 넘게 다른 곳
        const brk = new Array(n + 1).fill(false);
        let kerned = false;
        for (let k = 1; k < n; k++) {
          if (low(k)) continue;
          if (gen[k] || gen[k - 1] || Math.abs(U(k) - endOf(k - 1)) > 0.005 * em) { brk[k] = true; kerned = true; }
        }
        if (!kerned) return { ok: false, reason: 'plain' };
        const runsIn = (a, b) => {
          const out = [];
          let s0 = -1;
          for (let k = a; k < b; k++) {
            if (gen[k]) { if (s0 >= 0) out.push([s0, k]); s0 = -1; continue; }
            if (s0 < 0) s0 = k; else if (brk[k]) { out.push([s0, k]); s0 = k; }
          }
          if (s0 >= 0) out.push([s0, b]);
          return out;
        };
        const preRuns = runsIn(0, pre), sufRuns = runsIn(n - suf, n), mid = newText.slice(pre, newText.length - suf);
        if (!preRuns.length && !sufRuns.length) return { ok: false, reason: 'nothing-kept' };
        const font = P.FPDFTextObj_GetFont(o), size = item.size;
        if ([...preRuns, ...sufRuns].some(([a, b]) => !canRender(font, text.slice(a, b), size))) return { ok: false, reason: 'font' };
        const ff = mid ? api._fontFor(o, mid, size) : null;
        if (mid && (!ff.font || !canRender(ff.font, mid, size))) return { ok: false, reason: noGlyphReason(ff?.font, mid, size) };
        // 가운데 시작: 옛 가운데 첫 글자 자리(바꾼 글 — 앞 간격 유지), 순수 삽입이면 앞 글자(끼운 공백이면 그 간격)의 진행 끝
        const midStart = pre < n - suf && !gen[pre] ? U(pre) : pre > 0 ? endOf(pre - 1) : U(0);
        const oldMidEnd = n - suf - 1 >= pre ? endOf(n - suf - 1) : midStart;
        let midW = 0;
        if (mid) {
          const s = mal(4);
          try { for (const ch of mid) midW += (P.FPDFFont_GetGlyphWidth(ff.font, ch.codePointAt(0), size, s) ? f32(s) : 0.5 * size) * len; } finally { free(s); }
        }
        const delta = midStart + midW - oldMidEnd;
        const U0 = U(0), at = (u) => [g[0][0] + (u - U0) * cos, g[0][1] + (u - U0) * sin];
        // 보이는 순서의 조각: { text, u(시작 — 글자 방향 좌표), orig(원래 글꼴) }. 원래 객체는 원래 글꼴의 첫 조각을 맡는다(자리·마크 그대로)
        const segs = [
          ...preRuns.map(([a, b]) => ({ text: text.slice(a, b), u: U(a), orig: true })),
          ...(mid ? [{ text: mid, u: midStart, orig: ff.font === font, ff }] : []),
          ...sufRuns.map(([a, b]) => ({ text: text.slice(a, b), u: U(a) + delta, orig: true })),
        ];
        const host = segs.find((sg) => sg.orig);
        for (const sg of segs) {
          const [x, y] = at(sg.u), mm = [m[0], m[1], m[2], m[3], x, y];
          if (sg === host) {
            const u16 = utf16(sg.text); const ok = P.FPDFText_SetText(o, u16); free(u16);
            if (!ok) return { ok: false, reason: '앞 조각을 고치지 못했습니다.' };
            setMatrix(o, mm); sg.idx = idx; continue;
          }
          const f = sg.orig ? font : sg.ff.font;
          const neo = P.FPDFPageObj_CreateTextObj(doc, f, size), u16 = utf16(sg.text);
          const ok = neo && P.FPDFText_SetText(neo, u16); free(u16);
          if (!ok) { if (neo) P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '나눈 조각을 만들지 못했습니다.' }; }
          setMatrix(neo, mm);
          P.FPDFPageObj_SetFillColor(neo, item.color[0], item.color[1], item.color[2], item.color[3]);
          copyTextStyle(o, neo); copyStyleMark(o, neo);
          if (!sg.orig && sg.ff.sub) setSubst(neo, sg.ff.sub);
          if (!sg.orig && sg.ff.entry) tagFont(neo, sg.ff.entry);
          else { const fm = findMark(o, 'RetextPdfFont'); if (fm) tagFont(neo, { id: markParam(fm, 'id') || '', label: markParam(fm, 'label') || '' }); }
          const gid = groupOf(o); if (gid) tagGroup(neo, gid);
          P.FPDFPage_InsertObject(p, neo);
          sg.idx = P.FPDFPage_CountObjects(p) - 1;
        }
        regen(p);
        const sub = mid && ff.sub && ff.font !== font ? ff.sub : null;
        return { ok: true, idxs: segs.map((sg) => sg.idx), texts: segs.map((sg) => sg.text), kept: pre + suf, fallbackFont: !!sub,
          ...(sub ? { substitute: { orig: sub.orig, used: sub.used, kind: sub.kind } } : {}) };
      });
    },
    // v6 Wave B: 이 글을 이 객체 자리에 쓰면 어떤 글꼴로 그려지나(문서는 바꾸지 않는다 — 속성 창 안내용).
    // { original(원래 글꼴로 다 그린다), missing(원래 글꼴에 없는 글자), used(대체 글꼴 이름), kind, orig(원래 글꼴 이름), chosen(지정 폰트) }
    glyphCheck(i, idx, text) {
      const o = P.FPDFPage_GetObject(page(i), idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: '텍스트 상자를 다시 선택하세요.' };
      const size = (() => { const s = mal(4); try { return P.FPDFTextObj_GetFontSize(o, s) ? f32(s) : 12; } finally { free(s); } })();
      text = String(text || '');
      const entry = chosenFont(o);
      if (entry) { const miss = fontRegistry.missing(entry, text); return { ok: true, original: !miss.length, chosen: entry.label, missing: miss.slice(0, 12) }; }
      const font = P.FPDFTextObj_GetFont(o), own = fontNameOf(font) !== 'Untitled';
      const missing = own ? [...new Set([...text].filter((ch) => !/\s/.test(ch) && !canRender(font, ch, size)))] : [];
      if (own && !missing.length) return { ok: true, original: true, missing: [], orig: fontNameOf(font).replace(/^[A-Z]{6}\+/, '') };
      const pick = pickSubstitute(o, text);
      const fbPath = FALLBACK_FONTS.find((f) => fs.existsSync(f) && (!pick.b || /bd\.ttf$/i.test(f))) || FALLBACK_FONTS.find((f) => fs.existsSync(f));
      const used = pick.entry ? pick.entry.label : (fbPath && fontRegistry.byPath(fbPath)?.label) || '맑은 고딕';
      return { ok: true, original: false, missing: missing.slice(0, 12), used, kind: pick.kind, orig: pick.orig, ...(substOf(o) ? { already: true } : {}) };
    },
    // v6 Wave B: 회전·기울어진 줄의 가림 덮개 — 글자 방향으로 돌린 사각형(꼭짓점 pts [[x,y]×4], 쪽 좌표). addRect와 같은 가림 표시(RetextPdfMask)
    addPolygon(i, pts, color = [0, 0, 0, 255]) {
      const p = page(i);
      if (!Array.isArray(pts) || pts.length < 3) return { idx: -1 };
      const o = P.FPDFPageObj_CreateNewPath(pts[0][0], pts[0][1]);
      if (!o) return { idx: -1 };
      for (const [x, y] of pts.slice(1)) P.FPDFPath_LineTo(o, x, y);
      P.FPDFPath_Close(o);
      P.FPDFPageObj_SetFillColor(o, color[0], color[1], color[2], color[3] == null ? 255 : color[3]);
      P.FPDFPath_SetDrawMode(o, 1, false);
      P.FPDFPageObj_AddMark(o, MARK_MASK);
      P.FPDFPage_InsertObject(p, o);
      regen(p);
      return { idx: P.FPDFPage_CountObjects(p) - 1 };
    },
    // v6 Wave B: 전자서명 수(PDFium FPDF_GetSignatureCount — 서명 값 /V가 있는 /Sig 칸). 못 읽으면 0
    // v6 Wave E: FPDF_GetSignatureCount는 값이 없는 빈 서명 칸(/FT /Sig, /V 없음)까지 센다(실측 2026-10-15: 빈 양식이 "서명된 문서"로 잡혀 저장이 막혔다)
    //   → 서명 사전에 /Contents나 /ByteRange가 있는 것만 센다
    get signatureCount() {
      try {
        const n = Math.max(0, P.FPDF_GetSignatureCount ? P.FPDF_GetSignatureCount(doc) : 0);
        let signed = 0;
        for (let k = 0; k < n; k++) {
          const sig = P.FPDF_GetSignatureObject(doc, k);
          if (sig && (P.FPDFSignatureObj_GetContents(sig, 0, 0) > 0 || P.FPDFSignatureObj_GetByteRange(sig, 0, 0) > 0)) signed++;
        }
        return signed;
      } catch { return 0; }
    },
    // 한 객체를 글자 위치 cuts(오름차순, 0 < k < 글자 수)에서 여러 객체로 가른다(15d: TJ 안의 큰 점프로 두 칸이 된 객체).
    // 앞 조각은 제자리(같은 인덱스), 뒤 조각들은 원래 글꼴로 새 객체를 만들어 그 글자의 기준선 시작점에 놓고 맨 뒤에 넣는다.
    // 원래 글꼴로 다시 그릴 수 없는 글자(글자 대응이 없는 서브셋)면 가르지 않는다 — 모양이 바뀌면 안 되는 "고치지 않은" 글자다
    splitText(i, idx, cuts) {
      return api.batch(() => {
        const p = page(i), o = P.FPDFPage_GetObject(p, idx);
        if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: '텍스트 상자를 다시 선택하세요.' };
        const item = api.objects(i)[idx], text = item.text || '';
        const ks = [...new Set(cuts)].filter((k) => k > 0 && k < text.length).sort((a, b) => a - b);
        if (!ks.length) return { ok: true, idxs: [idx] };
        if (item.glyphs.length !== text.length || !item.matrix || Math.abs(item.matrix[1]) > 1e-3) return { ok: false, reason: '이 글자 조각은 나눌 수 없습니다(회전·글자 대응 문제).' };
        const bounds = [0, ...ks, text.length], segs = bounds.slice(0, -1).map((a, j) => text.slice(a, bounds[j + 1]));
        const font = P.FPDFTextObj_GetFont(o), size = item.size;
        if (segs.some((t) => !canRender(font, t, size))) return { ok: false, reason: '이 글자 조각은 원래 글꼴로 나눌 수 없습니다.' };
        const s = mal(24), idxs = [idx];
        try {
          if (!P.FPDFPageObj_GetMatrix(o, s)) return { ok: false, reason: 'matrix' };
          const m = [0, 4, 8, 12, 16, 20].map((k) => f32(s + k));
          for (let j = 1; j < segs.length; j++) {
            const neo = P.FPDFPageObj_CreateTextObj(doc, font, size), u = utf16(segs[j]);
            const ok = neo && P.FPDFText_SetText(neo, u); free(u);
            if (!ok) { if (neo) P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '나눈 조각을 만들지 못했습니다.' }; }
            const g = item.glyphs[bounds[j]];
            m.forEach((v, k) => M.setValue(s + k * 4, k === 4 ? g[0] : k === 5 ? g[1] : v, 'float'));
            P.FPDFPageObj_SetMatrix(neo, s);
            P.FPDFPageObj_SetFillColor(neo, item.color[0], item.color[1], item.color[2], item.color[3]);
            copyTextStyle(o, neo); copyStyleMark(o, neo);
            const fm = findMark(o, 'RetextPdfFont'); if (fm) tagFont(neo, { id: markParam(fm, 'id') || '', label: markParam(fm, 'label') || '' });
            P.FPDFPage_InsertObject(p, neo);
            idxs.push(P.FPDFPage_CountObjects(p) - 1);
          }
          const u = utf16(segs[0]); const ok = P.FPDFText_SetText(o, u); free(u);
          if (!ok) return { ok: false, reason: '앞 조각을 고치지 못했습니다.' };
          regen(p);
          return { ok: true, idxs };
        } finally { free(s); }
      });
    },
    // 객체들을 점 (cx, cy)를 중심으로 s배(글자 크기·간격 모두) — 줄 하나를 통째로 줄일 때(넘치면: 글자 축소)
    scaleAbout(i, idxs, s, cx, cy) {
      const p = page(i), n = P.FPDFPage_CountObjects(p);
      let done = 0;
      for (const idx of [].concat(idxs)) {
        if (!(idx >= 0 && idx < n)) continue;
        const o = P.FPDFPage_GetObject(p, idx);
        if (!o) continue;
        P.FPDFPageObj_Transform(o, s, 0, 0, s, cx * (1 - s), cy * (1 - s));
        done++;
      }
      if (done) regen(p);
      return { ok: done > 0, scaled: done };
    },

    // ── v6: 고른 글자 모양 바꾸기(글자 조각 하나 = 텍스트 객체 하나) ─────────────────────────────
    // opts: { bold, italic (true/false — 없으면 그대로), fontId(설치 폰트 집안 바꾸기), size(pt, 보이는 크기), color('#rrggbb'),
    //         script('super'|'sub'|null), underline, strike }
    // 굵게·기울임: 같은 집안의 진짜 굵게·기울임 면(설치 폰트)이 있고 글자가 다 있으면 그 글꼴로 다시 만든다(RetextPdfFont 표시 — 다음 편집도 그 글꼴).
    //   없으면 흉내: 굵게 = 렌더 모드 2(채움+외곽선, 선 굵기 0.03em — Word가 쓰는 방식), 기울임 = 행렬 c = 0.2·a(글자 공간에서 x += 0.2·y)
    // 첨자: 기준선 원점을 중심으로 0.65배 + 기준선 ±0.33em. 되돌릴 때 쓰려고 배율(k)·이동(sy)을 RetextPdfStyle에 적는다
    // 객체 자리(인덱스)는 그대로다(새로 만들 때도 같은 자리에 넣는다). 반환 { ok, idx, face, fakeBold, fakeItalic, skipped: [이유] }
    restyleText(i, idx, opts = {}) {
      return api.batch(() => {
        const p = page(i);
        let o = P.FPDFPage_GetObject(p, idx);
        if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: '텍스트 상자를 다시 선택하세요.' };
        const item = api.objects(i)[idx], text = item.text || '';
        if (item.hidden) return { ok: false, reason: '그림 위 투명 글자는 모양을 바꿀 수 없습니다.' };
        if (!item.matrix || Math.abs(item.matrix[1]) > 1e-3 || !(item.matrix[0] > 0) || !(item.matrix[3] > 0)) return { ok: false, reason: '회전한 글자는 모양을 바꿀 수 없습니다.' };
        const st = { ...(styleOf(o) || {}) }, skipped = [];
        const font = P.FPDFTextObj_GetFont(o);
        const ia = mal(4); let italicAngle = 0; try { if (P.FPDFFont_GetItalicAngle(font, ia)) italicAngle = i32(ia); } finally { free(ia); }
        const entryNow = fontOf(o) ? (() => { try { return fontRegistry.get(fontOf(o)); } catch { return null; } })() : null;
        const realB = isBold(o), realI = /italic|oblique/i.test(item.font || '') || italicAngle !== 0 || (entryNow ? fontRegistry.isItalicFace(entryNow) : false);
        const m = [...item.matrix], skew = m[0] ? m[2] / m[0] : 0;
        const curB = realB || item.renderMode === 2, curI = realI || Math.abs(skew) > 0.05;
        const B = opts.bold ?? curB, I = opts.italic ?? curI;
        const family = opts.fontId ? fontRegistry.get(opts.fontId).family : entryNow ? entryNow.family : fontRegistry.familyFor(item.font);
        const usable = (e) => e && !fontRegistry.missing(e, text).length;
        // 바꿀 글꼴(면): 진짜 면이 필요하면(집안 바꾸기·진짜 굵게/기울임 빼기) 반드시, 굵게·기울임을 더할 때는 있으면 쓴다
        const mustSwitch = !!opts.fontId || (realB && !B) || (realI && !I);
        const wantSwitch = mustSwitch || (B && !realB) || (I && !realI);
        let face = null;
        if (wantSwitch && family) {
          const exact = fontRegistry.faceFor(family, B, I);
          if (usable(exact)) face = exact;
          else if (mustSwitch) face = [fontRegistry.faceFor(family, B, false), fontRegistry.faceFor(family, false, I), fontRegistry.faceFor(family, false, false), opts.fontId ? fontRegistry.get(opts.fontId) : null].find(usable) || null;
          if (mustSwitch && !face) {
            if (opts.fontId) return { ok: false, reason: `선택한 폰트에 없는 글자: ${fontRegistry.missing(fontRegistry.get(opts.fontId), text).slice(0, 12).join(' ')}` };
            skipped.push(realB && !B ? 'bold' : 'italic');
          }
        } else if (mustSwitch && !family) skipped.push(realB && !B ? 'bold' : 'italic');
        if (face && face.id === entryNow?.id) face = null; // 이미 그 면이다
        // 진짜 굵게·기울임을 뺄 면을 못 찾았으면 그 모양은 그대로 둔다(skipped로 알린다)
        const faceB = face ? fontRegistry.isBoldFace(face) : realB, faceI = face ? fontRegistry.isItalicFace(face) : realI;
        const fakeBold = B && !faceB, fakeItalic = I && !faceI;
        // 행렬: 진짜 기울임 면이면 흉내 기울임을 뺀다. 흉내 기울임은 원래 기울어 있던 값(Chromium 합성 기울임)을 그대로 두고, 없으면 0.2
        m[2] = fakeItalic ? (Math.abs(skew) > 0.05 ? skew : 0.2) * m[0] : 0;
        const fill = item.color || [0, 0, 0, 255];
        const color = opts.color ? parseColor(opts.color) : [...fill];
        color[3] = fill[3] ?? 255;
        if (face) { // 새 면으로 다시 만든다(같은 자리)
          const f = customFont(face, text);
          const neo = P.FPDFPageObj_CreateTextObj(doc, f, item.size);
          const u = utf16(text || ' '); const ok = neo && P.FPDFText_SetText(neo, u); free(u);
          if (!ok) { if (neo) P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '새 글꼴로 글자를 만들지 못했습니다.' }; }
          copyTextStyle(o, neo);
          const gid = groupOf(o); if (gid) tagGroup(neo, gid);
          tagFont(neo, face);
          if (!P.FPDFPage_InsertObjectAtIndex(p, neo, idx)) { P.FPDFPageObj_Destroy(neo); return { ok: false, reason: '새 글꼴로 바꾸지 못했습니다.' }; }
          P.FPDFPage_RemoveObject(p, o); P.FPDFPageObj_Destroy(o);
          o = neo;
        }
        setMatrix(o, m);
        P.FPDFPageObj_SetFillColor(o, color[0], color[1], color[2], color[3]);
        const origin = () => { const b = mal(24); try { P.FPDFPageObj_GetMatrix(o, b); return [f32(b + 16), f32(b + 20), Math.hypot(f32(b), f32(b + 4))]; } finally { free(b); } };
        // 크기(보이는 크기, pt): 기준선 원점을 중심으로 늘리고 줄인다
        if (opts.size != null && opts.size !== '') {
          if (!(Number(opts.size) >= 1 && Number(opts.size) <= 300)) return { ok: false, reason: '글자 크기는 1~300pt 범위로 입력하세요.' };
          const [ox, oy, sc] = origin(), k = Number(opts.size) / (item.size * sc);
          if (Math.abs(k - 1) > 1e-3) P.FPDFPageObj_Transform(o, k, 0, 0, k, ox * (1 - k), oy * (1 - k));
        }
        // 첨자: 먼저 옛 첨자를 되돌리고(이동 → 배율) 새 첨자를 건다(배율 → 이동)
        if (opts.script !== undefined && (opts.script || null) !== ({ sup: 'super', sub: 'sub' }[st.sc] || null)) {
          if (st.sc) {
            const k = Number(st.k) || 0.65, sy = Number(st.sy) || 0;
            P.FPDFPageObj_Transform(o, 1, 0, 0, 1, 0, -sy);
            const [ox, oy] = origin();
            P.FPDFPageObj_Transform(o, 1 / k, 0, 0, 1 / k, ox * (1 - 1 / k), oy * (1 - 1 / k));
            st.sc = st.k = st.sy = null;
          }
          if (opts.script === 'super' || opts.script === 'sub') {
            const [ox, oy, sc] = origin(), base = item.size * sc, k = 0.65;
            const sy = (opts.script === 'super' ? 0.33 : -0.33) * base;
            P.FPDFPageObj_Transform(o, k, 0, 0, k, ox * (1 - k), oy * (1 - k));
            P.FPDFPageObj_Transform(o, 1, 0, 0, 1, 0, sy);
            Object.assign(st, { sc: opts.script === 'super' ? 'sup' : 'sub', k: String(k), sy: sy.toFixed(3) });
          }
        }
        // 굵게 흉내: 채움+외곽선, 선 굵기는 지금 보이는 크기의 0.03em
        // 이미 렌더 모드 2(Word의 굵게 흉내)였으면 원래 선 굵기를 지킨다 — 색만 바꿀 때 굵기가 달라지지 않게
        if (fakeBold) {
          if (item.renderMode !== 2 || (opts.size != null && opts.size !== '') || face) {
            P.FPDFTextObj_SetTextRenderMode(o, 2);
            P.FPDFPageObj_SetStrokeWidth(o, Math.max(0.1, 0.03 * item.size * origin()[2]));
          }
          P.FPDFPageObj_SetStrokeColor(o, color[0], color[1], color[2], color[3]);
        } else if (P.FPDFTextObj_GetTextRenderMode(o) === 2) P.FPDFTextObj_SetTextRenderMode(o, 0);
        st.fb = fakeBold ? '1' : null;
        st.fi = fakeItalic ? '1' : null;
        if (opts.underline !== undefined) st.u = opts.underline ? '1' : null;
        if (opts.strike !== undefined) st.s = opts.strike ? '1' : null;
        setStyleMark(o, st);
        regen(p);
        return { ok: true, idx, face: face ? face.label : null, fakeBold, fakeItalic, skipped };
      });
    },
    // 밑줄·취소선 선을 쪽 전체에서 다시 그린다: 옛 선(RetextPdfDeco)을 모두 지우고, RetextPdfStyle u·s가 있는 글자마다
    // 공백을 뺀 잉크 폭만큼 얇은 채움 사각형(글자색). 같은 줄·같은 색·같은 크기로 0.6em 안에 이어진 선은 하나로 잇는다(낱말 사이 공백 포함).
    // 지운 옛 선의 인덱스(오름차순)를 돌려준다 — 호출한 쪽이 다른 객체 인덱스를 고친다(새 선은 맨 뒤라 앞 인덱스를 밀지 않는다)
    syncDeco(i) {
      return api.batch(() => {
        const p = page(i), removed = [];
        for (let k = P.FPDFPage_CountObjects(p) - 1; k >= 0; k--) {
          const o = P.FPDFPage_GetObject(p, k);
          if (o && findMark(o, MARK_DECO) && P.FPDFPage_RemoveObject(p, o)) { P.FPDFPageObj_Destroy(o); removed.push(k); }
        }
        if (removed.length) regen(p);
        removed.reverse();
        const segs = [];
        for (const it of api.objects(i)) {
          if (it.type !== 'text' || !it.style || !(it.style.u || it.style.s) || it.hidden || !it.matrix || Math.abs(it.matrix[1]) > 1e-3) continue;
          const g = it.glyphs || [], t = it.text || '';
          if (!g.length || g.length !== t.length) continue;
          let a = 0, b = g.length - 1;
          while (a <= b && /\s/.test(t[a])) a++;
          while (b >= a && /\s/.test(t[b])) b--;
          if (a > b) continue;
          const em = it.scaledSize || it.size || 10;
          for (const kind of ['u', 's']) if (it.style[kind]) segs.push({ kind, x0: g[a][0], x1: g[b][0] + g[b][2], y: it.matrix[5], em, color: it.color || [0, 0, 0, 255] });
        }
        segs.sort((s1, s2) => s1.kind.localeCompare(s2.kind) || s2.y - s1.y || s1.x0 - s2.x0);
        const merged = [];
        for (const s of segs) {
          const L = merged[merged.length - 1];
          if (L && L.kind === s.kind && Math.abs(L.y - s.y) < 0.05 * s.em && Math.abs(L.em - s.em) < 0.05 * s.em && L.color.slice(0, 3).join() === s.color.slice(0, 3).join() && s.x0 - L.x1 < 0.6 * s.em) { L.x1 = Math.max(L.x1, s.x1); continue; }
          merged.push({ ...s });
        }
        for (const s of merged) {
          const th = Math.max(0.4, 0.055 * s.em), cy = s.kind === 'u' ? s.y - 0.12 * s.em : s.y + 0.3 * s.em;
          const r = P.FPDFPageObj_CreateNewRect(s.x0, cy - th / 2, s.x1 - s.x0, th);
          if (!r) continue;
          P.FPDFPageObj_SetFillColor(r, s.color[0], s.color[1], s.color[2], s.color[3] ?? 255);
          P.FPDFPath_SetDrawMode(r, 1, false);
          P.FPDFPageObj_AddMark(r, MARK_DECO);
          P.FPDFPage_InsertObject(p, r);
        }
        if (merged.length) regen(p);
        return { ok: true, removed, added: merged.length };
      });
    },

    // ── H: 글자 상자 / 이동 / 사각형 / 마스킹 ──────────────────────────────
    // 텍스트 페이지의 글자 인덱스는 페이지 전체 기준이라 객체별로 나눠야 한다.
    // FPDFText_GetTextObject(tp, c)가 그 글자를 그린 페이지 객체 포인터를 그대로 준다
    // → 좌표 허용오차나 유니코드 대조 없이 정확히 매칭된다.
    //   (객체 사이에 끼는 합성 \r\n 은 포인터 0 이라 자동으로 걸러진다)
    charBoxes(i, idx) {
      const p = page(i);
      const o = P.FPDFPage_GetObject(p, idx);
      if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return [];
      const tp = P.FPDFText_LoadPage(p);
      const s = mal(32); // double 4개: left, right, bottom, top
      try {
        // objects()의 text와 같은 함수(objText)로 글자를 고른다 → 인덱스가 텍스트(UTF-16)와 1:1
        const list = [];
        for (let c = 0, n = P.FPDFText_CountChars(tp); c < n; c++) {
          if (P.FPDFText_GetTextObject(tp, c) !== o) continue;
          const u = P.FPDFText_GetUnicode(tp, c);
          if (u) list.push({ c, u, gen: !!P.FPDFText_IsGenerated(tp, c) });
        }
        const { text, at } = objText(tp, o, list, s, false);
        const gen = new Set(list.filter((x) => x.gen).map((x) => x.c));
        const out = [];
        for (let k = 0; k < text.length; k++) {
          const c = at[k], prev = out[out.length - 1];
          // BMP 밖 글자 하나가 문자열에서는 두 칸(서로게이트 쌍) → 0폭 빈 상자를 하나 더 넣는다
          if (k && at[k - 1] === c && prev) { out.push({ ch: '', x0: prev.x1, y0: prev.y0, x1: prev.x1, y1: prev.y1 }); continue; }
          const ch = String.fromCodePoint(text.codePointAt(k));
          // PDFium이 객체 안에 끼운 공백(남긴 것)은 상자가 비어 있다 → 앞 글자 오른쪽 끝에 0폭 상자. 진짜 공백은 PDFium이 진행 폭만큼의 납작한 상자를 준다
          const ok = !gen.has(c) && P.FPDFText_GetCharBox(tp, c, s, s + 8, s + 16, s + 24);
          if (ok) out.push({ ch, x0: f64(s), y0: f64(s + 16), x1: f64(s + 8), y1: f64(s + 24) });
          else out.push(prev ? { ch, x0: prev.x1, y0: prev.y0, x1: prev.x1, y1: prev.y1 } : { ch, x0: 0, y0: 0, x1: 0, y1: 0 });
        }
        return out;
      } finally { free(s); P.FPDFText_ClosePage(tp); }
    },

    move(i, idxs, dx, dy) {
      const p = page(i), n = P.FPDFPage_CountObjects(p);
      let moved = 0;
      for (const idx of [].concat(idxs)) {
        if (!(idx >= 0 && idx < n)) continue;
        const o = P.FPDFPage_GetObject(p, idx);
        if (!o) continue;
        P.FPDFPageObj_Transform(o, 1, 0, 0, 1, dx, dy);
        moved++;
      }
      if (moved) regen(p);
      return { ok: moved > 0, moved };
    },

    // FPDFPageObj_CreateNewRect(x, y, w, h) — x1,y1 이 아니라 폭·높이다
    addRect(i, r, color = [0, 0, 0, 255]) {
      const p = page(i);
      const o = P.FPDFPageObj_CreateNewRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      if (!o) return { idx: -1 };
      P.FPDFPageObj_SetFillColor(o, color[0], color[1], color[2], color[3] == null ? 255 : color[3]);
      P.FPDFPath_SetDrawMode(o, 1, false); // FPDF_FILLMODE_WINDING, stroke=false
      P.FPDFPageObj_AddMark(o, MARK_MASK); // 콘텐츠 마크: 저장·재열기 후에도 "이게 우리가 만든 가림 상자"임을 식별
      P.FPDFPage_InsertObject(p, o);       // 맨 위에 얹는다
      regen(p);
      return { idx: P.FPDFPage_CountObjects(p) - 1 };
    },

    // 객체 하나를 페이지에서 제거 (가림 상자 삭제용)
    removeObject(i, idx) {
      const p = page(i);
      const o = P.FPDFPage_GetObject(p, idx);
      if (!o) return { ok: false };
      const ok = !!P.FPDFPage_RemoveObject(p, o);
      if (ok) { P.FPDFPageObj_Destroy(o); regen(p); }
      return { ok };
    },

    // 글자 [from,to)를 텍스트에서 실제로 지우고 그 자리에 검은 사각형을 덮는다.
    // 뒤쪽 글자는 새 텍스트 객체로 분리해 원래 위치에 다시 놓는다(idx+1에 삽입 → 뒤 인덱스가 1씩 밀린다).
    // 영역의 배경색 추출: 페이지를 1배로 렌더해 영역 픽셀을 32단계로 양자화, 가장 많은 색 묶음의 평균 → [r,g,b,255]
    // 글자·선은 소수라 최빈색은 배경(흰색, 셀 색, 슬라이드 배경)이 된다. 영역이 이미지 한가운데면 이미지의 주 색이 나온다.
    sampleColor(i, b) {
      const raw = api._renderRaw(i, 1);
      const { x0, x1, y0, y1 } = deviceRect(i, b, 1);
      const buckets = new Map();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * raw.stride + x * 4, r = raw.data[p], g = raw.data[p + 1], bl = raw.data[p + 2];
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
        const acc = buckets.get(key) || [0, 0, 0, 0]; acc[0] += r; acc[1] += g; acc[2] += bl; acc[3]++; buckets.set(key, acc);
      }
      let best = null; for (const a of buckets.values()) if (!best || a[3] > best[3]) best = a;
      if (!best) return [255, 255, 255, 255];
      return [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3]), 255];
    },

    // region 안에서 seed(텍스트 상자) 가운데를 기준으로 잉크가 이어지는 가로 구간을 찾는다 (2배 렌더, 배경과 다른 픽셀 = 잉크)
    // 페이지 x축은 회전 0·2에서 비트맵 가로, 1·3에서 세로다 → 그 축(t)을 따라 훑고, 찾은 끝을 선형으로 페이지 x로 되돌린다
    _inkExtent(i, region, seed) {
      const s = 2, raw = api._renderRaw(i, s), bg = api.sampleColor(i, region);
      const d = deviceRect(i, region, s), vert = api.pageSize(i).rotation % 2 === 1;
      const [t0, t1, c0, c1] = vert ? [d.y0, d.y1, d.x0, d.x1] : [d.x0, d.x1, d.y0, d.y1];
      const inkCol = (t) => { for (let c = c0; c <= c1; c++) { const p = vert ? t * raw.stride + c * 4 : c * raw.stride + t * 4; if (Math.abs(raw.data[p] - bg[0]) + Math.abs(raw.data[p + 1] - bg[1]) + Math.abs(raw.data[p + 2] - bg[2]) >= 120) return true; } return false; };
      const gap = Math.max(3, Math.round(0.25 * (seed.y1 - seed.y0) * s));
      const ym = (region.y0 + region.y1) / 2, axis = (x) => toDevice(i, x, ym, s)[vert ? 1 : 0];
      const tA = axis(region.x0), tB = axis(region.x1);
      if (tA === tB) return region;
      const cx = axis((seed.x0 + seed.x1) / 2);
      let L = cx, R = cx;
      for (let t = cx, blank = 0; t >= t0; t--) { if (inkCol(t)) { blank = 0; L = t; } else if (++blank >= gap) break; }
      for (let t = cx, blank = 0; t <= t1; t++) { if (inkCol(t)) { blank = 0; R = t; } else if (++blank >= gap) break; }
      if (R - L < 4) return region; // 잉크를 못 찾으면(이미 덮였거나 비어 있음) 그대로
      const toX = (t) => region.x0 + (t - tA) / (tB - tA) * (region.x1 - region.x0), xa = toX(L), xb = toX(R);
      const pad = 1.5;
      return { x0: Math.max(region.x0, Math.min(xa, xb) - pad), x1: Math.min(region.x1, Math.max(xa, xb) + pad), y0: region.y0, y1: region.y1 };
    },

    // 시험용: 객체 채움색 강제 (알파 0 → 투명 글자 재현)
    _setFillColor(i, idx, c) { const o = P.FPDFPage_GetObject(page(i), idx); const ok = !!(o && P.FPDFPageObj_SetFillColor(o, c[0], c[1], c[2], c[3])); if (ok) regen(page(i)); return ok; },

    // 영역의 글자색 추출: 배경색과 충분히 다른 픽셀(글자·선) 중 최빈색. 없으면 검정
    sampleInk(i, b) {
      const bg = api.sampleColor(i, b);
      const raw = api._renderRaw(i, 1);
      const { x0, x1, y0, y1 } = deviceRect(i, b, 1);
      const buckets = new Map();
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const p = y * raw.stride + x * 4, r = raw.data[p], g = raw.data[p + 1], bl = raw.data[p + 2];
        if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(bl - bg[2]) < 120) continue;
        const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (bl >> 3);
        const acc = buckets.get(key) || [0, 0, 0, 0]; acc[0] += r; acc[1] += g; acc[2] += bl; acc[3]++; buckets.set(key, acc);
      }
      let best = null; for (const a of buckets.values()) if (!best || a[3] > best[3]) best = a;
      return best ? [Math.round(best[0] / best[3]), Math.round(best[1] / best[3]), Math.round(best[2] / best[3]), 255] : [0, 0, 0, 255];
    },

    // 가림 덮개의 세로 범위(줄 높이). 글자 상자는 글자마다 높이가 달라(독서모임_안내.pdf 11pt 실측: 하이픈 기준선 위 2.8~3.5pt,
    // 숫자 0~8.2pt, 한글 −1.0~9.5pt) 글자별로 덮으면 들쭉날쭉하다 → 기준선(행렬 f) −0.25em ~ +0.85em 과,
    // 같은 줄(기준선 차 0.2em 이내·글자 크기 0.8~1.25배)의 글자 객체 상자 합집합(+0.5pt) 중 넓은 쪽. 같은 줄은 따로 가려도 높이가 같다.
    // 회전·기울임·뒤집힌 객체나 행렬이 없으면 null(호출한 쪽이 글자 상자를 그대로 쓴다). all: 미리 읽은 objects(i)
    lineBand(i, item, all = api.objects(i)) {
      const flat = (m) => m && Math.abs(m[1]) <= 0.01 && Math.abs(m[2]) <= 0.01 && m[0] > 0 && m[3] > 0;
      if (!item || item.type !== 'text' || !flat(item.matrix)) return null;
      const em = (item.size || 0) * item.matrix[3], y = item.matrix[5], PAD = 0.5;
      if (!(em > 0)) return null;
      let y0 = y - 0.25 * em, y1 = y + 0.85 * em;
      for (const o of all) {
        if (o.type !== 'text' || o.mask || !o.bounds || !flat(o.matrix) || !(o.text || '').trim()) continue;
        const oem = (o.size || 0) * o.matrix[3];
        if (Math.abs(o.matrix[5] - y) > 0.2 * em || !(oem >= 0.8 * em && oem <= 1.25 * em)) continue;
        if (o.bounds.y1 - o.bounds.y0 > 1.6 * em) continue; // 글리프 상자가 비정상적으로 큰 글꼴(Type3 등)은 줄 높이에 넣지 않는다
        y0 = Math.min(y0, o.bounds.y0 - PAD); y1 = Math.max(y1, o.bounds.y1 + PAD);
      }
      return { y, em, y0, y1 };
    },

    // color: [r,g,b,a] | 'auto'(배경색 추출) | 생략(검정)
    // 겹쳐 그린 사본: InDesign·한글의 가짜 굵게·그림자는 같은 낱말을 같은 자리에 같은 글꼴로 두 번 그린다.
    // PDFium 텍스트 페이지는 뒤 것을 중복으로 보고 빼므로(objects() 텍스트 '', charBoxes 빈 배열) 화면에 안 잡히지만,
    // 보이는 것만 지우면 저장 뒤 더는 중복이 아닌 사본에서 지운 글자가 다시 읽힌다(글리프도 덮개 밑에 남는다).
    // → 같은 글꼴·상자가 큰 쪽의 0.8 이상 겹침·텍스트 ''(또는 같은 텍스트)인 객체를 사본으로 보고,
    //   대상의 텍스트·글자 상자로 같은 자르기를 한다. 인덱스가 밀리지 않게 큰 인덱스부터 처리한다.
    // opts.draw === false: 덮개를 그리지 않고 영역(rects)과 줄 정보(line: 기준선 y·글자 크기 em)만 돌려준다 —
    // /api/pdf/mask(pdf-edit-service.maskParts)가 한 요청의 덮개를 줄마다 사각형 하나로 합쳐 그린다(4.0.1)
    redact(i, idx, from, to, color, opts = {}) {
      return api.batch(() => {
        const p = page(i);
        const o = P.FPDFPage_GetObject(p, idx);
        if (!o || P.FPDFPageObj_GetType(o) !== OBJ_TEXT) return { ok: false, reason: 'not-text' };

        const all = api.objects(i), item = all[idx];
        const text = item.text || '';
        from = Math.max(0, Math.min(from | 0, text.length));
        to = Math.max(from, Math.min(to | 0, text.length));
        if (from === to) return { ok: false, reason: 'empty' };

        const area = (r) => (r.x1 - r.x0) * (r.y1 - r.y0);
        const overlap = (a, b) => {
          const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
          return w > 0 && h > 0 ? (w * h) / Math.max(area(a), area(b)) : 0;
        };
        const twins = all.filter((t) => t.idx !== idx && t.type === 'text' && t.font === item.font
          && (t.text === '' || t.text === text) && overlap(t.bounds, item.bounds) >= 0.8).map((t) => t.idx);

        // 글자 단위로 못 자르면(charmap·rotated) 서버가 객체 전체를 비운다 — 사본도 함께 비우도록 실패 결과에 사본 인덱스를 싣는다
        const boxes = api.charBoxes(i, idx);
        if (boxes.length !== text.length) return { ok: false, reason: 'charmap', twins };

        const scratch = mal(24);
        try {
          const mats = new Map(); // 객체별 행렬 a b c d e f
          for (const j of [idx, ...twins]) {
            if (!P.FPDFPageObj_GetMatrix(P.FPDFPage_GetObject(p, j), scratch)) return { ok: false, reason: 'matrix' };
            const m = [0, 4, 8, 12, 16, 20].map((k) => f32(scratch + k));
            if (Math.abs(m[1]) > 0.01 || Math.abs(m[2]) > 0.01) return { ok: false, reason: 'rotated', twins };
            mats.set(j, m);
          }

          // 가릴 영역: 지워지는 글자 상자들의 합집합 (빈 상자는 무시), 없으면 객체 전체
          let cover = null;
          for (let k = from; k < to; k++) {
            const b = boxes[k];
            if (b.x1 <= b.x0) continue;
            cover = cover
              ? { x0: Math.min(cover.x0, b.x0), y0: Math.min(cover.y0, b.y0), x1: Math.max(cover.x1, b.x1), y1: Math.max(cover.y1, b.y1) }
              : { ...b };
          }
          if (!cover) cover = { ...item.bounds };
          const PAD = 0.5;
          cover = { x0: cover.x0 - PAD, y0: cover.y0 - PAD, x1: cover.x1 + PAD, y1: cover.y1 + PAD };
          // 세로는 글자 상자가 아니라 줄 높이로(하이픈은 얇고 숫자·받침 글자는 굵어 글자별 덮개가 들쭉날쭉하다). 줄 정보가 없으면 글자 상자 그대로
          const band = api.lineBand(i, item, all);
          if (band) cover = { ...cover, y0: Math.min(cover.y0, band.y0), y1: Math.max(cover.y1, band.y1) };

          const prefix = text.slice(0, from), suffix = text.slice(to);
          // 상자 기준 상대 이동량. e 는 펜 시작점이라 첫 글자 상자 x0 와 lsb 만큼 어긋나므로
          // 절대값이 아니라 (지운 뒤 첫 글자 − 원래 첫 글자) 차이를 쓴다. 사본은 같은 글자라 같은 이동량
          const dx = suffix ? (boxes[to] && boxes[to].x1 > boxes[to].x0 ? boxes[to].x0 : cover.x1 + PAD) - boxes[0].x0 : 0;
          let inserted = -1;

          for (const j of [idx, ...twins].sort((a, b) => b - a)) {
            const obj = P.FPDFPage_GetObject(p, j), it = all[j], m = mats.get(j);
            // 대상보다 앞(z 아래)의 사본도 뒷부분은 대상 바로 뒤에 넣는다 — idx보다 앞 인덱스가 그대로여야 서버가 뒤에서부터 차례로 처리할 수 있다
            const at = Math.max(j, idx) + 1;
            if (suffix) {
              const font = P.FPDFTextObj_GetFont(obj);
              const neo = font ? P.FPDFPageObj_CreateTextObj(doc, font, it.size || 12) : 0;
              const u16 = neo ? utf16(suffix) : 0;
              if (!neo || !P.FPDFText_SetText(neo, u16)) {
                if (u16) free(u16);
                if (neo) P.FPDFPageObj_Destroy(neo);
                return { ok: false, reason: 'suffix-font' };
              }
              free(u16);
              m.forEach((v, k) => M.setValue(scratch + k * 4, k === 4 ? v + dx : v, 'float'));
              P.FPDFPageObj_SetMatrix(neo, scratch);
              P.FPDFPageObj_SetFillColor(neo, it.color[0], it.color[1], it.color[2], it.color[3]);
              // 그리기 방식·마크도 옮긴다. 렌더 모드는 투명(3·7)까지 그대로 — OCR 투명 글자의 뒷부분이 보이게 되면 안 된다
              copyTextStyle(obj, neo);
              P.FPDFTextObj_SetTextRenderMode(neo, P.FPDFTextObj_GetTextRenderMode(obj));
              const gid = groupOf(obj); if (gid) tagGroup(neo, gid);
              const fm = findMark(obj, 'RetextPdfFont'); if (fm) tagFont(neo, { id: markParam(fm, 'id') || '', label: markParam(fm, 'label') || '' });
              copyStyleMark(obj, neo);
              let k = at;
              if (!P.FPDFPage_InsertObjectAtIndex(p, neo, at)) { P.FPDFPage_InsertObject(p, neo); k = P.FPDFPage_CountObjects(p) - 1; }
              if (j === idx) inserted = k;
              else if (j < idx && inserted >= 0 && k <= inserted) inserted++; // 대상 뒷부분 앞에 끼면 한 칸 밀린다
            }
            // 빈 문자열로 SetText 하면 PDFium이 트랩으로 죽는다 → 공백 하나 (민감한 글자는 남지 않는다)
            const pre = utf16(prefix || ' ');
            const okPre = !!P.FPDFText_SetText(obj, pre);
            free(pre);
            if (!okPre) return { ok: false, reason: 'prefix' };
          }

          if (opts.draw !== false) api.addRect(i, cover, color === 'auto' ? api.sampleColor(i, cover) : (color || [0, 0, 0, 255]));
          regen(p);
          return { ok: true, rects: [cover], inserted, ...(band ? { line: { y: band.y, em: band.em } } : {}), ...(twins.length ? { twins: twins.length } : {}) };
        } finally { free(scratch); }
      });
    },

    // ── 페이지 삭제 ───────────────────────────────────────────────────────
    // indices는 0 기준. 중복·범위 밖은 무시. 전부 지우려 하면 거절한다.
    deletePages(indices) {
      const count = P.FPDF_GetPageCount(doc);
      const targets = [...new Set([].concat(indices ?? []).map(Number))]
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count);
      if (!targets.length) return { ok: false, removed: 0, pageCount: count };
      if (targets.length >= count) throw new Error('페이지를 최소 한 장은 남겨야 합니다');
      // 삭제하면 뒤쪽 인덱스가 밀린다 → 캐시된 페이지 핸들을 모두 닫고 캐시 전체를 버린다
      flush();
      for (const h of pages.values()) P.FPDF_ClosePage(h);
      pages.clear();
      targets.sort((a, b) => b - a); // 내림차순이어야 앞 페이지 인덱스가 안 밀린다
      for (const n of targets) P.FPDFPage_Delete(doc, n);
      return { ok: true, removed: targets.length, pageCount: P.FPDF_GetPageCount(doc) };
    },

    // ── 페이지 회전 ───────────────────────────────────────────────────────
    // delta는 90의 배수(±90, 180, 360…). FPDFPage_GetRotation(0..3) + delta/90 을 4로 나눈 나머지 → SetRotation.
    // 회전은 같은 페이지 핸들에 걸리므로 페이지 캐시를 비우지 않는다(인덱스가 안 바뀐다).
    //
    // 실측 2026-09-09 (workspace/sample.pdf):
    //   · SetRotation(1) 뒤 같은 핸들의 FPDF_GetPageWidthF/HeightF = 842×595 (595×842 에서 뒤바뀜), 렌더 비트맵도 842×595.
    //   · 저장·재열기 후에도 GetRotation()=1, 크기 842×595 로 유지된다.
    //   · 그러나 FPDFPageObj_GetBounds 는 회전 전후가 같다(60.6,737.4,263.1,748.8 그대로). 즉
    //     **objects()/charBoxes()/find()의 좌표는 회전 전 페이지 좌표계**이고 pageSize()·render()는 회전 후다.
    //     화면 좌표는 (x0·s, (h−y1)·s) 공식이 회전 페이지에서 어긋난다 → 호출자가 pageSize().rotation 으로 변환해야 한다
    //     (rot 1: 화면x = y0, 화면y = x0 … FPDF_PageToDevice 와 같은 매핑). UI 대응은 WP-B2 몫.
    rotatePages(indices, delta) {
      const d = Number(delta);
      if (!Number.isFinite(d) || d % 90 !== 0) throw new Error('회전 각도는 90의 배수로 지정하세요.');
      const count = P.FPDF_GetPageCount(doc);
      const targets = [...new Set([].concat(indices ?? []).map(Number))]
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count)
        .sort((a, b) => a - b);
      const step = (((d / 90) % 4) + 4) % 4; // 360의 배수면 0 → 아무것도 바꾸지 않는다
      const rotations = [];
      for (const i of targets) {
        const p = page(i);
        const cur = P.FPDFPage_GetRotation(p); // 알 수 없으면 −1
        const next = (((cur >= 0 ? cur : 0) + step) % 4 + 4) % 4;
        if (step) P.FPDFPage_SetRotation(p, next);
        rotations.push({ i, rotation: next });
      }
      return { ok: targets.length > 0, changed: step ? targets.length : 0, rotations };
    },

    // ── 페이지 순서 변경 ──────────────────────────────────────────────────
    // order는 현재 인덱스의 순열(길이 = pageCount, 중복·누락·범위 밖은 throw). order[k] = "새 k번째 자리에 올 현재 페이지".
    //
    // 구현 선택(실측 2026-09-09, 계약서 0·3·5쪽을 뽑아 만든 3쪽 문서):
    //   ① FPDF_MovePages(doc, order, count, 0) — [2,0,1]·[1,2,0]·[2,1,0]·[0,2,1] 네 순열 모두 기대한 순서가 나왔고
    //      저장·재열기 뒤에도 유지, 저장 바이트 230,940 로 원본과 같다(마크·폰트 리소스 그대로, swapDoc 불필요).
    //   ② CreateNewDocument + ImportPagesByIndex — 되지만 문서를 새로 만들어 호출자가 swapDoc 해야 한다.
    //   → ①을 쓴다. 전체를 한 번에 옮기므로 dest_index는 0.
    // 인덱스가 통째로 바뀌므로 deletePages와 같은 이유로 페이지 핸들 캐시를 버린다.
    reorderPages(order) {
      const count = P.FPDF_GetPageCount(doc);
      const list = [].concat(order ?? []).map(Number);
      if (list.length !== count) throw new Error(`페이지 순서는 ${count}개를 모두 지정해야 합니다 (받은 값 ${list.length}개).`);
      const seen = new Set();
      for (const n of list) {
        if (!Number.isInteger(n) || n < 0 || n >= count) throw new Error(`페이지 번호가 범위를 벗어났습니다: ${n}`);
        if (seen.has(n)) throw new Error(`페이지 번호가 중복됐습니다: ${n + 1}쪽`);
        seen.add(n);
      }
      if (list.every((n, k) => n === k)) return { ok: true, pageCount: count }; // 이미 그 순서
      flush();
      for (const h of pages.values()) P.FPDF_ClosePage(h);
      pages.clear();
      const arr = mal(count * 4);
      try {
        list.forEach((n, k) => M.setValue(arr + k * 4, n, 'i32'));
        if (!P.FPDF_MovePages(doc, arr, count, 0)) throw new Error('페이지 순서를 바꾸지 못했습니다.');
      } finally { free(arr); }
      return { ok: true, pageCount: P.FPDF_GetPageCount(doc) };
    },

    // ── 빈 페이지 끼우기 ──────────────────────────────────────────────────
    // at(0 기준) 자리에 넣는다(at = pageCount면 맨 뒤). 크기를 안 주면 옆 쪽(at−1, 맨 앞이면 0쪽)의 보이는 크기 —
    // 회전된 가로 쪽 옆이면 회전 없는 가로 쪽이 된다(보이는 모양이 같다). FPDFPage_New가 돌려준 핸들은 바로 닫는다
    insertBlankPage(at, width, height) {
      const count = P.FPDF_GetPageCount(doc);
      const pos = Number.isInteger(Number(at)) ? Math.max(0, Math.min(count, Number(at))) : count;
      let w = Number(width), h = Number(height);
      if (!(w > 0 && h > 0)) { const s = api.pageSize(pos > 0 ? pos - 1 : 0); w = s.w; h = s.h; }
      if (!(w >= 1 && h >= 1 && w <= 14400 && h <= 14400)) throw new Error('쪽 크기는 1~14400pt 범위로 지정하세요.');
      resetPages();
      const p = P.FPDFPage_New(doc, pos, w, h);
      if (!p) throw new Error('빈 페이지를 만들지 못했습니다.');
      P.FPDF_ClosePage(p);
      return { ok: true, at: pos, width: w, height: h, pageCount: P.FPDF_GetPageCount(doc) };
    },

    // ── 페이지 복제 ───────────────────────────────────────────────────────
    // 각 쪽의 사본을 원래 쪽 바로 뒤에 넣는다. FPDF_ImportPagesByIndex(doc, doc, …) — 같은 문서에서 가져와도 된다
    // (실측 2026-10-14: 3쪽 문서의 1쪽을 2번 자리로 → 4쪽, 저장·재열기 뒤 텍스트 1·2·2·3). 사본은 콘텐츠 스트림을 따로 갖는다(시험: 사본 편집이 원본에 번지지 않음).
    // 뒤쪽부터 처리해 앞쪽 인덱스가 밀리지 않게 한다. pages: 사본이 놓인 최종 인덱스(오름차순)
    duplicatePages(indices) {
      const count = P.FPDF_GetPageCount(doc);
      const targets = [...new Set([].concat(indices ?? []).map(Number))]
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count).sort((a, b) => a - b);
      if (!targets.length) return { ok: false, pages: [], pageCount: count };
      resetPages(); // 가져오기는 콘텐츠 스트림을 읽는다 + 인덱스가 밀린다
      const arr = mal(4);
      try {
        for (const n of [...targets].reverse()) {
          M.setValue(arr, n, 'i32');
          if (!P.FPDF_ImportPagesByIndex(doc, doc, arr, 1, n + 1)) throw new Error(`${n + 1}쪽을 복제하지 못했습니다.`);
        }
      } finally { free(arr); }
      return { ok: true, pages: targets.map((n, k) => n + k + 1), pageCount: P.FPDF_GetPageCount(doc) };
    },

    // ── 다른 PDF 끼우기 ───────────────────────────────────────────────────
    // buffer(파일 바이트)의 모든 쪽을 at 자리에 넣는다. 암호가 걸린 원본은 code SOURCE_ENCRYPTED로 거절한다
    // (권한만 걸린 문서는 빈 암호로 열리므로 그대로 들어간다). 가져오기는 객체를 복사한다 — 원본 문서를 닫고 버퍼를 0xAB로 덮은 뒤에도
    // 저장·재열기 텍스트가 그대로다(시험). 그래서 원본은 바로 닫고 해제한다
    insertPdf(at, buffer) {
      const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
      if (!b.length) throw new Error('넣을 PDF가 비어 있습니다.');
      const count = P.FPDF_GetPageCount(doc);
      const pos = Number.isInteger(Number(at)) ? Math.max(0, Math.min(count, Number(at))) : count;
      const ptr = mal(b.length);
      heap().set(b, ptr);
      const src = P.FPDF_LoadMemDocument(ptr, b.length, 0);
      try {
        if (!src) {
          if (isPasswordError(P)) throw Object.assign(new Error('암호가 걸린 PDF는 끼울 수 없습니다. 그 파일을 열어 암호를 푼 뒤 다른 이름으로 저장하고 다시 넣으세요.'), { code: 'SOURCE_ENCRYPTED' });
          throw new Error('넣을 PDF를 열 수 없습니다 (손상된 파일)');
        }
        const n = P.FPDF_GetPageCount(src);
        if (!n) throw new Error('넣을 PDF에 페이지가 없습니다.');
        resetPages();
        if (!P.FPDF_ImportPages(doc, src, null, pos)) throw new Error('페이지를 가져오지 못했습니다.');
        return { ok: true, at: pos, inserted: n, pageCount: P.FPDF_GetPageCount(doc) };
      } finally {
        if (src) P.FPDF_CloseDocument(src);
        heap().fill(0xab, ptr, ptr + b.length); // 가져온 객체가 원본 버퍼를 참조하면 시험이 깨지게
        free(ptr);
      }
    },

    // ── 쪽 번호 ───────────────────────────────────────────────────────────
    // opts: { format:'n'|'n/N'|'dash'|'ko', position:'bottom-center'|'bottom-right'|'bottom-left'|'top-center'|'top-right',
    //         size(pt, 기본 10), margin(pt, 기본 24), startAt(기본 1), skipFirst(표지 건너뜀), color '#rrggbb', fontId? }
    // 쪽마다 글자 객체 하나를 만들어 RetextPdfPageNum 마크를 단다. 다시 부르면 옛 번호를 지우고 새로 넣는다(겹쳐 쌓이지 않음).
    // 위치는 보이는 방향 기준(visualFrame) — 회전된 쪽도 보이는 아래쪽에 똑바로, CropBox 안쪽 여백만큼.
    // 번호: skipFirst면 1쪽(표지)은 비우고 2쪽부터 startAt. N = 마지막 번호
    addPageNumbers(opts = {}) {
      const fmt = opts.format || 'n', pos = opts.position || 'bottom-center';
      const label = { n: (n) => `${n}`, 'n/N': (n, N) => `${n} / ${N}`, dash: (n) => `- ${n} -`, ko: (n) => `${n}쪽` }[fmt];
      if (!label) throw new Error(`알 수 없는 쪽 번호 형식입니다: ${fmt}`);
      if (!['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right'].includes(pos)) throw new Error(`알 수 없는 쪽 번호 위치입니다: ${pos}`);
      const size = opts.size == null ? 10 : Number(opts.size), margin = opts.margin == null ? 24 : Number(opts.margin);
      if (!(size >= 4 && size <= 72)) throw new Error('쪽 번호 글자 크기는 4~72pt 범위로 지정하세요.');
      if (!(margin >= 0 && margin <= 300)) throw new Error('쪽 번호 여백은 0~300pt 범위로 지정하세요.');
      const startAt = opts.startAt == null ? 1 : Number(opts.startAt);
      if (!Number.isInteger(startAt) || startAt < 0 || startAt > 99999) throw new Error('시작 번호는 0~99999 정수로 지정하세요.');
      const color = parseColor(opts.color);
      const count = P.FPDF_GetPageCount(doc), first = opts.skipFirst ? 1 : 0;
      const N = startAt + Math.max(0, count - first) - 1;
      const labels = Array.from({ length: count }, (_, i) => (i < first ? null : label(startAt + i - first, N)));
      const { font } = newTextFont(opts.fontId, labels.filter(Boolean).join('') || '0', size); // 쓰는 글자 전부를 담은 서브셋 하나
      return api.batch(() => {
        const removed = api.removePageNumbers().removed;
        let numbered = 0;
        // 자리 계산은 머리말·꼬리말·워터마크와 같은 placeText(회전 0이면 예전 공식 그대로: 가운데 (W−폭)/2−x0, 오른쪽 W−여백−x1, 아래는 기준선이 여백에, 위는 W−여백−y1)
        const at = { h: pos.endsWith('center') ? 'center' : pos.endsWith('right') ? 'right' : 'left', v: pos.startsWith('bottom') ? 'bottom' : 'top' };
        for (let i = 0; i < count; i++) {
          if (!labels[i]) continue;
          placeText(i, { font, size, text: labels[i], color, at, margin, mark: MARK_PAGENUM });
          numbered++;
        }
        return { ok: true, numbered, removed, last: N };
      });
    },

    // 쪽 번호 지우기: 모든 쪽에서 RetextPdfPageNum 마크가 달린 객체를 뺀다
    removePageNumbers() {
      const removed = removeMarked(MARK_PAGENUM);
      return { ok: removed > 0, removed };
    },

    // ── 글상자(빈 자리에 새 글자) ─────────────────────────────────────────
    // { x, y: 상자 왼쪽 위(페이지 사용자 좌표), text('\n'으로 여러 줄), fontId(/api/fonts의 id, 없으면 맑은 고딕), size(기본 12), color '#rrggbb' }
    // 줄마다 글자 객체 하나, 행간 1.25배. 첫 기준선은 위끝에서 0.9em 아래. 회전된 쪽은 보이는 방향으로 똑바로 쓴다(visualFrame의 행렬).
    // 여러 줄이면 RetextPdfGroup으로 묶어 한 상자로 보이게 하고, 폰트를 고르면 RetextPdfFont 마크를 달아 이후 줄 편집(/api/pdf/edit)도 같은 폰트를 쓴다.
    // 돌려주는 idxs는 페이지 맨 뒤(가장 위 z-순서)에 들어간 객체 인덱스
    addTextBox(i, opts = {}) {
      const text = String(opts.text ?? '');
      if (!text.trim() || text.length > 5000) throw new Error('글상자 내용은 1~5,000자로 입력하세요.');
      const size = opts.size == null ? 12 : Number(opts.size);
      if (!(size >= 1 && size <= 300)) throw new Error('글자 크기는 1~300pt 범위로 입력하세요.');
      const x = Number(opts.x), y = Number(opts.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('글상자 위치가 잘못됐습니다.');
      const lines = text.split(/\r?\n/);
      const { font, entry } = newTextFont(opts.fontId, lines.join(''), size);
      const color = parseColor(opts.color);
      const p = page(i), [a, b, c, d] = visualFrame(i).rotm, lh = 1.25 * size;
      const gid = lines.length > 1 ? newGroupId() : null;
      const idxs = [];
      return api.batch(() => {
        lines.forEach((line, k) => {
          const down = 0.9 * size + k * lh; // 보이는 아래 방향 = −(c, d)
          const o = makeText(font, size, line, [a, b, c, d, x - c * down, y - d * down], color);
          if (gid) tagGroup(o, gid);
          if (entry) tagFont(o, entry);
          P.FPDFPage_InsertObject(p, o);
          idxs.push(P.FPDFPage_CountObjects(p) - 1);
        });
        regen(p);
        return { ok: true, idx: idxs[0], idxs, group: gid, ...(entry ? { fontId: entry.id, fontLabel: entry.label } : {}) };
      });
    },

    // ── 페이지 추출 (새 문서 바이트) ───────────────────────────────────────
    // indices 순서대로 새 문서를 만들어 저장 바이트를 돌려준다. 원본 doc는 바뀌지 않는다(실측: 계약서 10쪽 그대로).
    // 중복 인덱스는 그대로 두 번 담는다(같은 쪽을 두 번 넣고 싶을 수 있다). 분할은 서버가 이 함수를 반복 호출한다.
    // 실측 2026-09-09: 계약서(632,063 B·10쪽)에서 [0,3] 추출 → 210,682 B·2쪽, 텍스트가 원본 0·3쪽과 문자열 일치.
    extractPages(indices) {
      const count = P.FPDF_GetPageCount(doc);
      const list = [].concat(indices ?? []).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n < count);
      if (!list.length) throw new Error('추출할 페이지를 고르세요.');
      flush(); // 가져오기는 콘텐츠 스트림을 읽는다
      const dest = P.FPDF_CreateNewDocument();
      if (!dest) throw new Error('새 PDF를 만들지 못했습니다.');
      const arr = mal(list.length * 4);
      try {
        list.forEach((n, k) => M.setValue(arr + k * 4, n, 'i32'));
        if (!P.FPDF_ImportPagesByIndex(dest, doc, arr, list.length, 0)) throw new Error('페이지를 가져오지 못했습니다.');
        return saveDoc(P, dest);
      } finally { free(arr); P.FPDF_CloseDocument(dest); }
    },

    // ── 이미지 삽입 / 크기 조절 ───────────────────────────────────────────
    // image: { kind:'jpeg', data } | { kind:'rgba', data, width, height, quality? }
    // box: { x, y, w, h } PDF 좌표(pt, 원점 좌하단). 종횡비는 호출자가 맞춘다.
    insertImage(i, image, box) {
      const p = page(i);
      for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(box?.[k])) throw new Error('이미지 위치·크기가 잘못됐습니다.');
      if (!(box.w > 0 && box.h > 0)) throw new Error('이미지 크기는 0보다 커야 합니다.');
      const alpha = transparent(image); // 투명이 있으면 JPEG 대신 비트맵(+SMask)으로
      const data = alpha ? null : toJpeg(image);
      const io = P.FPDFPageObj_NewImageObj(doc);
      if (!io) throw new Error('이미지 객체를 만들지 못했습니다.');
      try {
        if (alpha) putBitmap(io, image.data, image.width, image.height); else putJpeg(io, data);
        // 이미지는 단위 정사각형(0..1)에 그려진다 → 행렬 [w 0 0 h x y]가 곧 화면 상자
        const m = mal(24);
        try {
          [box.w, 0, 0, box.h, box.x, box.y].forEach((v, k) => M.setValue(m + k * 4, v, 'float'));
          P.FPDFPageObj_SetMatrix(io, m);
        } finally { free(m); }
      } catch (e) { P.FPDFPageObj_Destroy(io); throw e; }
      P.FPDFPage_InsertObject(p, io); // 맨 뒤 = 가장 위 z-순서
      regen(p);
      const idx = P.FPDFPage_CountObjects(p) - 1;
      return { ok: true, idx, bounds: api.objects(i)[idx].bounds };
    },

    // 객체를 box에 맞춘다. 이미지는 행렬을 다시 쓰고, 그 밖의 객체는 현재 bounds 대비 배율·이동을 건다.
    resizeObject(i, idx, box) {
      const p = page(i), o = P.FPDFPage_GetObject(p, idx);
      if (!o) throw new Error('객체를 찾을 수 없습니다.');
      for (const k of ['x', 'y', 'w', 'h']) if (!Number.isFinite(box?.[k])) throw new Error('위치·크기가 잘못됐습니다.');
      if (!(box.w > 0 && box.h > 0)) throw new Error('크기는 0보다 커야 합니다.');
      if (P.FPDFPageObj_GetType(o) === OBJ_IMAGE) {
        const m = mal(24);
        try {
          [box.w, 0, 0, box.h, box.x, box.y].forEach((v, k) => M.setValue(m + k * 4, v, 'float'));
          if (!P.FPDFPageObj_SetMatrix(o, m)) throw new Error('이미지 크기를 바꾸지 못했습니다.');
        } finally { free(m); }
      } else {
        const b = api.objects(i)[idx].bounds, bw = b.x1 - b.x0, bh = b.y1 - b.y0;
        if (!(bw > 0 && bh > 0)) throw new Error('크기를 잴 수 없는 객체입니다.');
        const sx = box.w / bw, sy = box.h / bh;
        P.FPDFPageObj_Transform(o, sx, 0, 0, sy, box.x - b.x0 * sx, box.y - b.y0 * sy);
      }
      regen(p);
      return { ok: true, idx, bounds: api.objects(i)[idx].bounds };
    },

    // ── 이미지 통계 (용량 줄이기 대화상자용) ───────────────────────────────
    // FPDF_IMAGEOBJ_METADATA: width(0) height(4) horizontal_dpi(8) vertical_dpi(12) bits_per_pixel(16) colorspace(20) marked_content_id(24) — 28바이트
    // bytes는 압축된 스트림 길이(GetImageDataRaw). dpi는 픽셀 수 ÷ 표시 크기(가로·세로 중 큰 값).
    imageStats(i) {
      const p = page(i), n = P.FPDFPage_CountObjects(p);
      const md = mal(28), bb = mal(16);
      try {
        const out = [];
        for (let idx = 0; idx < n; idx++) {
          const o = P.FPDFPage_GetObject(p, idx);
          if (P.FPDFPageObj_GetType(o) !== OBJ_IMAGE) continue;
          const okMeta = P.FPDFImageObj_GetImageMetadata(o, p, md);
          const width = okMeta ? i32(md) >>> 0 : 0, height = okMeta ? i32(md + 4) >>> 0 : 0;
          const bpp = okMeta ? i32(md + 16) >>> 0 : 0, colorspace = okMeta ? i32(md + 20) : 0;
          P.FPDFPageObj_GetBounds(o, bb, bb + 4, bb + 8, bb + 12);
          const bounds = { x0: f32(bb), y0: f32(bb + 4), x1: f32(bb + 8), y1: f32(bb + 12) };
          const wpt = bounds.x1 - bounds.x0, hpt = bounds.y1 - bounds.y0;
          const dpi = Math.max(wpt > 0 ? width / (wpt / 72) : 0, hpt > 0 ? height / (hpt / 72) : 0);
          const filters = [];
          for (let k = 0, fc = P.FPDFImageObj_GetImageFilterCount(o); k < fc; k++) {
            const need = P.FPDFImageObj_GetImageFilter(o, k, 0, 0);
            if (!need) continue;
            const buf = mal(need);
            try { if (P.FPDFImageObj_GetImageFilter(o, k, buf, need)) filters.push(M.UTF8ToString(buf)); } finally { free(buf); }
          }
          out.push({
            idx, width, height, bounds,
            dpi: Math.round(dpi),
            bytes: P.FPDFImageObj_GetImageDataRaw(o, 0, 0),
            hasAlpha: hasAlpha(p, o),
            filter: filters.join('+') || null,
            filters, bpp, colorspace,
          });
        }
        return out;
      } finally { free(md); free(bb); }
    },

    // ── 용량 줄이기: 문서 전체의 큰 이미지를 maxDpi에 맞춰 줄이고 JPEG로 다시 넣는다 ──
    // 정수 배율 박스 필터라 배율은 ceil(dpi/maxDpi) — dpi가 maxDpi를 넘으면 항상 2배 이상 줄어든다
    // (예: 276dpi를 150dpi로 맞추면 배율 2 → 138dpi. maxDpi 바로 위(160dpi)면 80dpi까지 떨어진다)
    // 알파(SMask)가 있으면 건너뛴다 — JPEG는 투명을 못 담아 배경이 흰색으로 채워져 버린다.
    downsample(opts = {}) {
      const maxDpi = Number(opts.maxDpi) > 0 ? Number(opts.maxDpi) : 150;
      const quality = Math.max(1, Math.min(100, Math.round(Number(opts.quality) || 75)));
      const minPixels = Number.isFinite(opts.minPixels) ? opts.minPixels : 200 * 200;
      flush();
      const before = saveDoc(P, doc).length;
      let changed = 0;
      const skipped = [];
      for (let i = 0, n = P.FPDF_GetPageCount(doc); i < n; i++) {
        const p = page(i);
        let dirty = false;
        for (const st of api.imageStats(i)) {
          const skip = (reason) => skipped.push({ page: i, idx: st.idx, dpi: st.dpi, bytes: st.bytes, reason });
          // 애초에 대상이 아닌 이미지(해상도가 이미 낮거나 아주 작은 것)는 skipped에 넣지 않는다 —
          // UI가 "N개 건너뜀"으로 보여 주므로 손댈 수 있었는데 안 한 것만 남긴다
          if (!(st.dpi > maxDpi)) continue;
          if (st.width * st.height < minPixels) continue;
          if (st.bpp <= 1) { skip('1비트 흑백 스캔'); continue; }           // 이미 작다
          // hasAlpha가 null(렌더 실패로 알 수 없음)이면 건드리지 않는다 — 투명이 깨지는 쪽이 되돌리기 어렵다
          if (st.hasAlpha !== false) { skip(st.hasAlpha === null ? '투명 여부를 알 수 없음' : '투명(SMask)'); continue; }
          const factor = Math.ceil(st.dpi / maxDpi);
          const o = P.FPDFPage_GetObject(p, st.idx);
          const px = o && imagePixels(o);
          if (!px) { skip('픽셀을 읽을 수 없음'); continue; }
          if (Math.floor(px.width / factor) < 1 || Math.floor(px.height / factor) < 1) { skip('너무 작아 줄일 수 없음'); continue; }
          const small = boxDown(px.data, px.width, px.height, factor);
          const data = encodeJpeg(small.data, small.width, small.height, quality);
          if (data.length >= st.bytes) { skip('줄여도 커짐'); continue; }   // 이미 잘 압축된 이미지
          try { putJpeg(o, data, [p]); } catch (e) { skip(e.message); continue; }
          changed++; dirty = true;
        }
        if (dirty) regen(p);
      }
      flush();
      const after = saveDoc(P, doc).length;
      return { ok: true, changed, skipped, before, after };
    },

    // ── 텍스트 검색 ───────────────────────────────────────────────────────
    // 한 페이지에서 query를 찾아 [{ start, length, rects: [{x0,y0,x1,y1}] }] 를 돌려준다.
    // rects는 charBoxes()와 같은 PDF 페이지 좌표계(원점 좌하단, y 위쪽 +).
    //   FPDFText_GetRect(tp, k, left, top, right, bottom) — 인자 순서가 CharBox(left,right,bottom,top)와 다르다.
    //
    // 실측 2026-09-09:
    //   · 한글: 계약서(10쪽)에서 "개인정보" 31건 / rect 31개 / 39ms (p3 16건, p4 10건, p5 5건).
    //     FPDFText_FindStart는 UTF-16LE를 받으므로 한글이 그대로 된다. 결과 하나가 rect 하나(줄이 안 나뉨).
    //     rect0 = L28.77 T642.50 R57.78 B635.35 로 그 4글자의 CharBox 합집합과 일치 → 좌표계가 charBoxes와 같다.
    //   · 슬라이드 문서(11쪽): "데이터" 13건 33ms, "대시보드" 16건 15ms → 문서 전체 검색이 수십 ms.
    //   · 플래그: MATCHCASE=1("SAMPLE" 1건→0건), MATCHWHOLEWORD=2("sam" 1건→0건, "PDF" 3건).
    //   · **빈 질의('')를 넘기면 FPDFText_FindNext가 돌아오지 않는다**(100초 무응답으로 강제 종료).
    //     → FindStart를 부르기 전에 걸러낸다. FIND_LIMIT은 그 밖의 폭주에 대한 안전판.
    find(i, query, opts = {}) {
      const q = String(query ?? '').replace(/\0/g, ''); // NUL이 있으면 UTF-16 질의가 빈 문자열이 되어 FindNext가 멈춘다(서버 전체가 굳는다)
      if (!q) return [];
      const limit = Number(opts.limit) > 0 ? Number(opts.limit) : FIND_LIMIT;
      const flags = (opts.matchCase ? FIND_MATCHCASE : 0) | (opts.wholeWord ? FIND_MATCHWHOLEWORD : 0);
      const tp = P.FPDFText_LoadPage(page(i));
      const u = utf16(q), s = mal(32); // double 4개: left, top, right, bottom
      let h = 0;
      try {
        h = P.FPDFText_FindStart(tp, u, flags, 0);
        if (!h) return [];
        const out = [];
        while (P.FPDFText_FindNext(h)) {
          const start = P.FPDFText_GetSchResultIndex(h), length = P.FPDFText_GetSchCount(h);
          const rects = [];
          for (let k = 0, n = P.FPDFText_CountRects(tp, start, length); k < n; k++) {
            if (!P.FPDFText_GetRect(tp, k, s, s + 8, s + 16, s + 24)) continue;
            rects.push({ x0: f64(s), y0: f64(s + 24), x1: f64(s + 16), y1: f64(s + 8) });
          }
          out.push({ start, length, rects });
          if (out.length >= limit) break;
        }
        return out;
      } finally { if (h) P.FPDFText_FindClose(h); free(s); free(u); P.FPDFText_ClosePage(tp); }
    },

    pageText(i) {
      const tp = P.FPDFText_LoadPage(page(i));
      try {
        const n = P.FPDFText_CountChars(tp);
        if (n <= 0) return '';
        // CountChars는 글자 수다. BMP 밖 글자(이모지)는 UTF-16 두 칸으로 나오므로 버퍼를 두 배로 잡는다 — 모자라면 뒷부분이 잘린다
        const buf = mal((2 * n + 1) * 2);
        heap().fill(0, buf, buf + (2 * n + 1) * 2);
        P.FPDFText_GetText(tp, 0, n, buf);
        const s = M.UTF16ToString(buf);
        free(buf);
        return s;
      } finally { P.FPDFText_ClosePage(tp); }
    },

    // ── 머리말·꼬리말 ─────────────────────────────────────────────────────
    // opts: { slots: { tl, tc, tr, bl, bc, br }(왼쪽 위·가운데 위·오른쪽 위·왼쪽 아래·가운데 아래·오른쪽 아래), fontId, size(기본 9), color '#rrggbb',
    //         margin(pt, 기본 24), pages(0 기준 배열, 생략 = 전체), startAt(기본 1), skipFirst, file(파일 이름, 확장자 없이), title }
    // 글자 안의 표시: {page} 쪽 번호 · {pages} 마지막 번호 · {date} 오늘(YYYY-MM-DD) · {file} 파일 이름 · {title} 문서 제목(없으면 파일 이름)
    // 번호는 쪽 번호(addPageNumbers)와 같은 규칙 — skipFirst면 1쪽(표지)은 비우고 2쪽이 startAt. 자리 계산은 쪽 번호와 같은 placeText(보이는 방향·CropBox 기준)
    // RetextPdfHeaderFooter 마크를 달아 다시 넣으면 옛것을 모두 지우고 새로 넣는다
    addHeaderFooter(opts = {}) {
      const SLOT = { tl: ['left', 'top'], tc: ['center', 'top'], tr: ['right', 'top'], bl: ['left', 'bottom'], bc: ['center', 'bottom'], br: ['right', 'bottom'] };
      const slots = opts.slots && typeof opts.slots === 'object' ? opts.slots : {};
      for (const k of Object.keys(slots)) if (!SLOT[k]) throw bad(`알 수 없는 자리입니다: ${k} (tl·tc·tr·bl·bc·br)`);
      const used = Object.entries(slots).filter(([, v]) => typeof v === 'string' && v.trim());
      if (!used.length) throw bad('머리말·꼬리말 내용을 한 자리 이상 입력하세요.');
      for (const [, v] of used) if (v.length > 300 || /[\r\n]/.test(v)) throw bad('머리말·꼬리말은 자리마다 300자 이하의 한 줄로 입력하세요.');
      const size = opts.size == null ? 9 : Number(opts.size), margin = opts.margin == null ? 24 : Number(opts.margin);
      if (!(size >= 4 && size <= 72)) throw bad('글자 크기는 4~72pt 범위로 지정하세요.');
      if (!(margin >= 0 && margin <= 300)) throw bad('여백은 0~300pt 범위로 지정하세요.');
      const startAt = opts.startAt == null ? 1 : Number(opts.startAt);
      if (!Number.isInteger(startAt) || startAt < 0 || startAt > 99999) throw bad('시작 번호는 0~99999 정수로 지정하세요.');
      const color = parseColor(opts.color);
      const count = P.FPDF_GetPageCount(doc), first = opts.skipFirst ? 1 : 0;
      const N = startAt + Math.max(0, count - first) - 1;
      const now = new Date(), z = (n) => String(n).padStart(2, '0');
      const values = { pages: String(N), date: `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`, file: String(opts.file ?? '') };
      values.title = String(opts.title ?? (api.metaText('Title') || values.file));
      const jobs = [];
      for (const i of pageList(opts.pages)) {
        if (i < first) continue;
        for (const [slot, tpl] of used) {
          const text = tpl.replace(/\{(page|pages|date|file|title)\}/g, (_, k) => (k === 'page' ? String(startAt + i - first) : values[k])).trim();
          if (text) jobs.push({ i, text, at: { h: SLOT[slot][0], v: SLOT[slot][1] } });
        }
      }
      const font = jobs.length ? newTextFont(opts.fontId, jobs.map((j) => j.text).join(''), size).font : 0;
      return api.batch(() => {
        const removed = removeMarked(MARK_HF);
        for (const j of jobs) placeText(j.i, { font, size, text: j.text, color, at: j.at, margin, mark: MARK_HF });
        return { ok: true, placed: jobs.length, pages: new Set(jobs.map((j) => j.i)).size, removed, last: N };
      });
    },
    removeHeaderFooter() { const removed = api.batch(() => removeMarked(MARK_HF)); return { ok: removed > 0, removed }; },

    // ── 워터마크 ───────────────────────────────────────────────────────────
    // opts: { kind:'text'|'image', text, fontId, size(글자 pt, 기본 60), color, opacity(0~1, 기본 0.3), rotation(도, 보이는 방향 반시계 — 글자 기본 45, 그림 기본 0),
    //         position:'center'|'top'|'bottom', margin(pt, 기본 36), pages(0 기준 배열, 생략 = 전체), layer:'front'(본문 위, 기본)|'back'(본문 뒤),
    //         image: { kind:'jpeg'|'rgba', data, width, height }, scale(그림 폭 = 보이는 쪽 폭 × scale, 기본 0.5) }
    // 반투명은 채움 알파로 건다: 글자는 FPDFPageObj_SetFillColor의 알파, 그림도 같은 함수로 객체 알파를 준다 —
    //   PDFium이 ExtGState(/ca)를 써서 저장하고 저장·재열기 뒤에도 섞인 색으로 그린다(실측 2026-10-14: 파랑 바탕 위 빨강 그림 알파 128 → [127,0,127]).
    // 쪽 회전·CropBox는 쪽 번호와 같은 보이는 방향 기준. RetextPdfWatermark 마크 — 다시 넣으면 모든 쪽의 옛 워터마크를 지우고 새로 넣는다
    addWatermark(opts = {}) {
      const kind = opts.kind || 'text';
      if (!['text', 'image'].includes(kind)) throw bad(`알 수 없는 워터마크 종류입니다: ${kind}`);
      const position = opts.position || 'center';
      const v = { center: 'middle', top: 'top', bottom: 'bottom' }[position];
      if (!v) throw bad(`알 수 없는 워터마크 위치입니다: ${position} (center·top·bottom)`);
      if (opts.layer != null && !['front', 'back'].includes(opts.layer)) throw bad(`알 수 없는 층입니다: ${opts.layer} (front·back)`);
      const back = opts.layer === 'back';
      const opacity = clamp01(opts.opacity, 0.3), alpha = alphaOf(opacity);
      const rotation = opts.rotation == null || opts.rotation === '' ? (kind === 'text' ? 45 : 0) : Number(opts.rotation);
      if (!(rotation >= -360 && rotation <= 360)) throw bad('회전은 -360~360도로 지정하세요.');
      const margin = opts.margin == null ? 36 : Number(opts.margin);
      if (!(margin >= 0 && margin <= 300)) throw bad('여백은 0~300pt 범위로 지정하세요.');
      const targets = pageList(opts.pages);
      if (kind === 'text') {
        const text = String(opts.text ?? '').trim();
        if (!text || text.length > 200 || /[\r\n]/.test(text)) throw bad('워터마크 글자는 200자 이하의 한 줄로 입력하세요.');
        const size = opts.size == null ? 60 : Number(opts.size);
        if (!(size >= 4 && size <= 400)) throw bad('글자 크기는 4~400pt 범위로 지정하세요.');
        const c = parseColor(opts.color || '#888888'), color = [c[0], c[1], c[2], alpha];
        const { font } = newTextFont(opts.fontId, text, size);
        return api.batch(() => {
          const removed = removeMarked(MARK_WM);
          for (const i of targets) placeText(i, { font, size, text, color, at: { h: 'center', v }, margin, rotation, baseline: false, mark: MARK_WM, back });
          return { ok: true, placed: targets.length, removed };
        });
      }
      const image = opts.image;
      if (!image || !(image.width > 0 && image.height > 0)) throw bad('워터마크 그림을 고르세요.');
      const scale = opts.scale == null ? 0.5 : Number(opts.scale);
      if (!(scale >= 0.02 && scale <= 1)) throw bad('그림 크기(scale)는 0.02~1 사이로 지정하세요.');
      const alphaImage = transparent(image), jpegData = alphaImage ? null : toJpeg(image); // 쪽마다 같은 JPEG 바이트를 넣는다(서버가 저장 뒤 같은 그림 스트림을 하나로 합친다)
      const t = rotation * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
      return api.batch(() => {
        const removed = removeMarked(MARK_WM);
        for (const i of targets) {
          const p = page(i), f = visualFrame(i);
          const w = f.width * scale, h = w * (image.height / image.width);
          const ext = Math.abs(w * sin) + Math.abs(h * cos); // 돌린 그림의 세로 길이
          const tx = f.width / 2, ty = v === 'middle' ? f.height / 2 : v === 'top' ? f.height - margin - ext / 2 : margin + ext / 2;
          // 단위 정사각형 → 보이는 쪽: 가로 w·세로 h로 늘리고 t만큼 돌린 뒤 가운데를 (tx, ty)에
          const vm = [w * cos, w * sin, -h * sin, h * cos, tx - (w * cos - h * sin) / 2, ty - (w * sin + h * cos) / 2];
          const io = P.FPDFPageObj_NewImageObj(doc);
          if (!io) throw new Error('이미지 객체를 만들지 못했습니다.');
          try {
            if (alphaImage) putBitmap(io, image.data, image.width, image.height); else putJpeg(io, jpegData);
            setMatrix(io, toPageMatrix(f, vm));
            if (alpha < 255) P.FPDFPageObj_SetFillColor(io, 255, 255, 255, alpha);
          } catch (e) { P.FPDFPageObj_Destroy(io); throw e; }
          P.FPDFPageObj_AddMark(io, MARK_WM);
          if (!(back && P.FPDFPage_InsertObjectAtIndex(p, io, 0))) P.FPDFPage_InsertObject(p, io);
          regen(p);
        }
        return { ok: true, placed: targets.length, removed };
      });
    },
    removeWatermark() { const removed = api.batch(() => removeMarked(MARK_WM)); return { ok: removed > 0, removed }; },

    // ── 텍스트 페이지 글자 (개인정보 찾기·가리기) ─────────────────────────────
    // 쪽 글자 전체를 문자열로: { text, map } — map[문자열 위치] = 텍스트 페이지 글자 번호(FPDFText 인덱스)
    pageChars(i) {
      const tp = P.FPDFText_LoadPage(page(i));
      try { return pageChars(tp); } finally { P.FPDFText_ClosePage(tp); }
    },
    // 글자 번호 범위 [start, end)의 줄별 사각형 [[l,b,r,t], …](회전 전 페이지 좌표 — objects()와 같다)
    charRangeRects(i, start, end) {
      const tp = P.FPDFText_LoadPage(page(i));
      try { return rangeRects(tp, start, end); } finally { P.FPDFText_ClosePage(tp); }
    },
    // 영역(rect: {x0,y0,x1,y1}) 안에 글자 상자 가운데가 드는 글자들 → 연속 범위 [[start, end], …]. 상자 없는 글자(공백)는 양옆이 들면 함께 넣는다
    charRangesIn(i, rect) {
      const tp = P.FPDFText_LoadPage(page(i)), s = mal(32);
      try {
        const ranges = [];
        let cur = null; // 열린 범위. 상자 없는 글자는 범위를 닫지도 늘리지도 않는다 — 다음 안쪽 글자가 오면 그 사이까지 이어진다
        for (let c = 0, n = P.FPDFText_CountChars(tp); c < n; c++) {
          const ok = P.FPDFText_GetCharBox(tp, c, s, s + 8, s + 16, s + 24); // left right bottom top
          const l = f64(s), r = f64(s + 8), b = f64(s + 16), t = f64(s + 24);
          if (!ok || !(r > l) || !(t > b)) continue;
          const cx = (l + r) / 2, cy = (b + t) / 2;
          if (cx >= rect.x0 && cx <= rect.x1 && cy >= rect.y0 && cy <= rect.y1) { if (cur) cur[1] = c + 1; else { cur = [c, c + 1]; ranges.push(cur); } }
          else cur = null;
        }
        return ranges;
      } finally { free(s); P.FPDFText_ClosePage(tp); }
    },
    // 글자 번호 범위들 → 가리기 조각 { parts:[{ idx, from, to, whole? }], unmapped }(rangesToParts 참고)
    partsForRanges(i, ranges) { return rangesToParts(i, [].concat(ranges || []).map(([s, e]) => [Number(s), Number(e)])); },

    // ── 영역 가리기의 그림·도형 부분 ─────────────────────────────────────────
    // rect와 겹치는 그림: 영역 안에 다 들면 객체를 빼고, 걸치면 원본 픽셀에서 영역에 해당하는 부분을 color로 칠해 다시 넣는다
    // (행렬의 역변환으로 영역 네 모서리를 그림 픽셀로 옮겨 그 외곽 상자를 칠한다 — 돌린 그림은 조금 더 넓게 칠해진다).
    // 다시 넣는 그림은 JPEG(품질 92). 투명(SMask) 그림은 원본 픽셀에 마스크가 빠져 있어 불투명 그림으로 다시 들어간다(가린 쪽이 안전하다).
    // 픽셀을 읽지 못하는 그림은 통째로 뺀다. 양식 XObject 안의 그림은 건드리지 못한다(덮개로만 가려진다)
    redactImagesIn(i, rect, color = [0, 0, 0, 255]) {
      const p = page(i);
      let painted = 0, removed = 0;
      const inside = (b) => b.x0 >= rect.x0 && b.x1 <= rect.x1 && b.y0 >= rect.y0 && b.y1 <= rect.y1;
      const m = mal(24);
      try {
        for (let idx = P.FPDFPage_CountObjects(p) - 1; idx >= 0; idx--) {
          const o = P.FPDFPage_GetObject(p, idx);
          if (!o || P.FPDFPageObj_GetType(o) !== OBJ_IMAGE) continue;
          const b = boundsOf(o);
          if (!overlaps(b, rect)) continue;
          const drop = () => { if (P.FPDFPage_RemoveObject(p, o)) { P.FPDFPageObj_Destroy(o); removed++; } };
          if (inside(b)) { drop(); continue; }
          const px = P.FPDFPageObj_GetMatrix(o, m) ? imagePixels(o) : null;
          if (!px) { drop(); continue; }
          const [a, bb, c, d, e, f] = [0, 1, 2, 3, 4, 5].map((k) => f32(m + k * 4));
          const det = a * d - bb * c;
          if (!det) { drop(); continue; }
          const toPx = (x, y) => { const u = (d * (x - e) - c * (y - f)) / det, v = (-bb * (x - e) + a * (y - f)) / det; return [u * px.width, (1 - v) * px.height]; };
          const q = [toPx(rect.x0, rect.y0), toPx(rect.x1, rect.y0), toPx(rect.x0, rect.y1), toPx(rect.x1, rect.y1)];
          const X0 = Math.max(0, Math.floor(Math.min(...q.map((z) => z[0])))), X1 = Math.min(px.width, Math.ceil(Math.max(...q.map((z) => z[0]))));
          const Y0 = Math.max(0, Math.floor(Math.min(...q.map((z) => z[1])))), Y1 = Math.min(px.height, Math.ceil(Math.max(...q.map((z) => z[1]))));
          if (X1 <= X0 || Y1 <= Y0) continue;
          for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) { const k = (y * px.width + x) * 4; px.data[k] = color[0]; px.data[k + 1] = color[1]; px.data[k + 2] = color[2]; px.data[k + 3] = 255; }
          try { putJpeg(o, encodeJpeg(px.data, px.width, px.height, 92), [p]); painted++; } catch { drop(); }
        }
      } finally { free(m); }
      if (painted || removed) regen(p);
      return { painted, removed };
    },
    // rect 안에 완전히 든 선·도형(경로) 객체를 뺀다(가린 영역 밑에 그림처럼 그린 글자·서명이 남지 않게). 걸친 도형은 덮개로만 가려진다
    removePathsIn(i, rect) {
      const p = page(i), E = 0.01;
      let removed = 0;
      for (let idx = P.FPDFPage_CountObjects(p) - 1; idx >= 0; idx--) {
        const o = P.FPDFPage_GetObject(p, idx);
        if (!o || P.FPDFPageObj_GetType(o) !== OBJ_PATH) continue;
        const b = boundsOf(o);
        if (b.x0 >= rect.x0 - E && b.x1 <= rect.x1 + E && b.y0 >= rect.y0 - E && b.y1 <= rect.y1 + E && P.FPDFPage_RemoveObject(p, o)) { P.FPDFPageObj_Destroy(o); removed++; }
      }
      if (removed) regen(p);
      return removed;
    },
    // 가린 영역(rects: [{x0,y0,x1,y1}] 또는 [[l,b,r,t]])과 겹치는 주석(링크·양식 칸 제외)을 딸린 팝업과 함께 지운다 → 지운 수
    removeAnnotsIn(i, rects) { return removeAnnotsIn(i, [].concat(rects || [])); },

    // ── 주석 ───────────────────────────────────────────────────────────────
    // 한 쪽의 주석 목록. 좌표는 objects()와 같은 회전 전 페이지 좌표(rotation = 그 쪽의 /Rotate, 0..3 — 화면 변환은 호출자)
    // { index, subtype, rect:[l,b,r,t], color:'#rrggbb'|null, fill?, opacity, width?, contents, author, modified(ISO|null), quads?, inkPaths?, line?, hasAppearance, rotation }
    annots(i) {
      const p = page(i), rot = api.pageSize(i).rotation, out = [];
      for (let k = 0, n = P.FPDFPage_GetAnnotCount(p); k < n; k++) {
        const a = P.FPDFPage_GetAnnot(p, k);
        if (!a) continue;
        try { out.push(readAnnot(a, k, rot)); } finally { P.FPDFPage_CloseAnnot(a); }
      }
      return out;
    },
    // 주석 만들기. spec: { subtype, color, opacity, width, contents, author, … 종류별 모양 }
    //   highlight·underline·strikeout·squiggly: quads [[x1 y1 x2 y2 x3 y3 x4 y4]…](왼쪽 위·오른쪽 위·왼쪽 아래·오른쪽 아래) 또는 chars { start, end }(텍스트 페이지 글자 번호 → 줄마다 사각형)
    //   text(메모): x, y(아이콘 왼쪽 위) · square·circle: rect [l,b,r,t], fill?(안쪽 색) · line: from [x,y], to [x,y], arrow · ink: strokes [[[x,y]…]…]
    // 외형(/AP /N)을 EPDFAnnot_GenerateAppearance로 만든다(형광펜은 곱하기 섞기) — 다른 뷰어도 그대로 그린다. 외형을 못 만들면 주석을 지우고 던진다.
    // /T 작성자 · /Contents · /M · /CreationDate · /NM · /F(인쇄, 메모는 확대·회전 안 함까지)를 쓴다. 돌려주는 index는 그 쪽 /Annots 안의 위치
    createAnnot(i, spec = {}) {
      const st = ANNOT_CREATE[spec.subtype];
      if (!st) throw bad(`만들 수 없는 주석 종류입니다: ${spec.subtype} (highlight·underline·strikeout·squiggly·text·square·circle·line·ink)`);
      const p = page(i);
      const defColor = st === 9 || st === 1 ? '#ffd400' : '#e53935';
      if (spec.color != null && !/^#?[0-9a-f]{6}$/i.test(String(spec.color))) throw bad('색은 #rrggbb 형식으로 지정하세요.');
      const color = parseColor(spec.color || defColor);
      const opacity = clamp01(spec.opacity, 1);
      const width = spec.width == null ? (st === 15 ? 2 : 1) : Number(spec.width);
      if (!(width >= 0.25 && width <= 50)) throw bad('선 굵기는 0.25~50pt 범위로 지정하세요.');
      const finite = (...v) => v.every((x) => Number.isFinite(x));
      const pt = (q, what) => { if (!Array.isArray(q) || q.length !== 2 || !finite(+q[0], +q[1])) throw bad(`${what} 좌표가 잘못됐습니다.`); return [+q[0], +q[1]]; };
      const bbox = (pts, pad) => [Math.min(...pts.map((q) => q[0])) - pad, Math.min(...pts.map((q) => q[1])) - pad, Math.max(...pts.map((q) => q[0])) + pad, Math.max(...pts.map((q) => q[1])) + pad];
      let rect, quads = null, line = null, strokes = null;
      if (MARKUP.has(st)) {
        if (spec.chars) {
          const s = Number(spec.chars.start), e = Number(spec.chars.end);
          if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s) throw bad('글자 범위(chars)가 잘못됐습니다.');
          quads = api.charRangeRects(i, s, e).map(([l, b, r, t]) => [l, t, r, t, l, b, r, b]);
        } else {
          quads = [].concat(spec.quads || []).map((q) => { if (!Array.isArray(q) || q.length !== 8 || !finite(...q.map(Number))) throw bad('quads는 숫자 8개짜리 배열의 목록이어야 합니다.'); return q.map(Number); });
        }
        if (!quads.length || quads.length > 500) throw bad('표시할 글자 위치가 없습니다.');
        rect = bbox(quads.flatMap((q) => [[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]), 0);
      } else if (st === 1) {
        const [x, y] = pt([spec.x, spec.y], '메모');
        rect = [x, y - 20, x + 20, y];
      } else if (st === 5 || st === 6) {
        const r = spec.rect;
        if (!Array.isArray(r) || r.length !== 4 || !finite(...r.map(Number))) throw bad('rect는 [왼쪽, 아래, 오른쪽, 위] 숫자 4개여야 합니다.');
        rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])].map(Number);
        if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) throw bad('도형이 너무 작습니다.');
      } else if (st === 4) {
        line = { from: pt(spec.from, '선 시작'), to: pt(spec.to, '선 끝'), arrow: !!spec.arrow };
        if (Math.hypot(line.to[0] - line.from[0], line.to[1] - line.from[1]) < 1) throw bad('선이 너무 짧습니다.');
        rect = bbox([line.from, line.to], line.arrow ? width * 3 + 6 : width + 2);
      } else if (st === 15) {
        strokes = [].concat(spec.strokes || []).map((s) => [].concat(s || []).map((q) => pt(q, '펜'))).filter((s) => s.length);
        const total = strokes.reduce((n, s) => n + s.length, 0);
        if (!strokes.length || total > 20000) throw bad('펜 획이 없거나 너무 많습니다(점 20,000개 이하).');
        rect = bbox(strokes.flat(), width + 1);
      }
      if (spec.fill != null && !/^#?[0-9a-f]{6}$/i.test(String(spec.fill))) throw bad('안쪽 색은 #rrggbb 형식으로 지정하세요.');
      const contents = String(spec.contents ?? ''), author = String(spec.author || 'Retext PDF');
      if (contents.length > 20000) throw bad('메모는 20,000자 이하로 입력하세요.');
      const a = P.EPDFPage_CreateAnnot(p, st);
      if (!a) throw new Error('주석을 만들지 못했습니다.');
      let ok = true;
      const step = (v) => { ok = ok && !!v; };
      const buf = mal(Math.max(64, (strokes ? Math.max(...strokes.map((s) => s.length)) : 0) * 8));
      try {
        step(setAnnotRect(a, rect));
        if (quads) for (const q of quads) { q.forEach((v, k) => M.setValue(buf + k * 4, v, 'float')); step(P.FPDFAnnot_AppendAttachmentPoints(a, buf)); }
        if (line) {
          [...line.from, ...line.to].forEach((v, k) => M.setValue(buf + k * 4, v, 'float'));
          step(P.EPDFAnnot_SetLine(a, buf, buf + 8));
          step(P.EPDFAnnot_SetLineEndings(a, LE_NONE, line.arrow ? LE_CLOSED_ARROW : LE_NONE));
        }
        if (strokes) for (const s of strokes) { s.forEach(([x, y], k) => { M.setValue(buf + k * 8, x, 'float'); M.setValue(buf + k * 8 + 4, y, 'float'); }); step(P.FPDFAnnot_AddInkStroke(a, buf, s.length) >= 0); }
        if (st === 1) step(P.EPDFAnnot_SetName(a, 0)); // 아이콘 Comment
        step(P.EPDFAnnot_SetColor(a, 0, color[0], color[1], color[2]));
        if (spec.fill && (st === 5 || st === 6)) { const fc = parseColor(spec.fill); step(P.EPDFAnnot_SetColor(a, 1, fc[0], fc[1], fc[2])); }
        if ([4, 5, 6, 15].includes(st)) step(P.EPDFAnnot_SetBorderStyle(a, 1, width)); // 1 = 실선
        step(P.EPDFAnnot_SetOpacity(a, alphaOf(opacity)));
        const now = pdfDate();
        step(setAnnotStr(a, 'T', author)); step(setAnnotStr(a, 'Contents', contents));
        step(setAnnotStr(a, 'M', now)); step(setAnnotStr(a, 'CreationDate', now));
        step(setAnnotStr(a, 'NM', 'retext-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
        step(P.FPDFAnnot_SetFlags(a, st === 1 ? ANNOT_FLAG_PRINT | ANNOT_FLAG_NOZOOM | ANNOT_FLAG_NOROTATE : ANNOT_FLAG_PRINT));
        step(regenAppearance(a));
        step(P.EPDFAnnot_HasAppearanceStream(a, 0));
        const index = P.FPDFPage_GetAnnotIndex(p, a);
        if (!ok || index < 0) {
          if (index >= 0) P.FPDFPage_RemoveAnnot(p, index);
          throw new Error('주석을 만들지 못했습니다(속성·외형 쓰기 실패).');
        }
        return { ok: true, index, annot: readAnnot(a, index, api.pageSize(i).rotation) };
      } finally { free(buf); P.FPDFPage_CloseAnnot(a); }
    },
    // 주석 고치기: { contents, author, color, fill, opacity, width, rect } 중 준 것만. rect는 메모·사각형·원만(나머지는 모양 좌표가 따로 있어 옮기지 않는다).
    // /M을 지금으로 바꾸고 외형을 다시 만든다
    updateAnnot(i, index, patch = {}) {
      return withAnnot(i, index, (a) => {
        const st = P.FPDFAnnot_GetSubtype(a);
        let ok = true;
        const step = (v) => { ok = ok && !!v; };
        if (patch.contents != null) { if (String(patch.contents).length > 20000) throw bad('메모는 20,000자 이하로 입력하세요.'); step(setAnnotStr(a, 'Contents', patch.contents)); }
        if (patch.author != null) step(setAnnotStr(a, 'T', patch.author));
        for (const [key, type] of [['color', 0], ['fill', 1]]) {
          if (patch[key] == null) continue;
          if (!/^#?[0-9a-f]{6}$/i.test(String(patch[key]))) throw bad('색은 #rrggbb 형식으로 지정하세요.');
          const c = parseColor(patch[key]); step(P.EPDFAnnot_SetColor(a, type, c[0], c[1], c[2]));
        }
        if (patch.opacity != null) step(P.EPDFAnnot_SetOpacity(a, alphaOf(clamp01(patch.opacity, 1))));
        if (patch.width != null) {
          const w = Number(patch.width);
          if (!(w >= 0.25 && w <= 50)) throw bad('선 굵기는 0.25~50pt 범위로 지정하세요.');
          if ([4, 5, 6, 15].includes(st)) step(P.EPDFAnnot_SetBorderStyle(a, 1, w));
        }
        if (patch.rect != null) {
          if (![1, 5, 6].includes(st)) throw Object.assign(new Error('이 주석은 위치를 rect로 바꿀 수 없습니다(메모·사각형·원만).'), { status: 400 });
          const r = patch.rect;
          if (!Array.isArray(r) || r.length !== 4 || !r.every((x) => Number.isFinite(Number(x)))) throw bad('rect는 [왼쪽, 아래, 오른쪽, 위] 숫자 4개여야 합니다.');
          step(setAnnotRect(a, r.map(Number)));
        }
        step(setAnnotStr(a, 'M', pdfDate()));
        step(regenAppearance(a));
        if (!ok) throw new Error('주석을 고치지 못했습니다.');
        return { ok: true, index, annot: readAnnot(a, index, api.pageSize(i).rotation) };
      });
    },
    // 주석 지우기(딸린 팝업도). 링크·양식 칸도 지울 수 있다(사용자가 고른 것이므로)
    deleteAnnot(i, index) {
      withAnnot(i, index, () => {});
      const removed = removeAnnots(page(i), [index]);
      return { ok: removed > 0, removed };
    },
    // 주석 고정(평면화): 외형을 쪽 내용(양식 XObject)으로 옮기고 주석은 뺀다(EPDFAnnot_Flatten). indices를 안 주면 그 쪽 전부.
    // 링크·팝업은 건너뛴다(링크는 보이는 외형이 없고, 팝업은 부모를 고정할 때 함께 뺀다)
    flattenAnnots(i, indices) {
      const p = page(i), n = P.FPDFPage_GetAnnotCount(p);
      const list = indices == null ? Array.from({ length: n }, (_, k) => k) : [...new Set([].concat(indices).map(Number))];
      for (const k of list) if (!Number.isInteger(k) || k < 0 || k >= n) throw Object.assign(new Error(`주석을 찾을 수 없습니다: ${k}`), { status: 404 });
      const flat = new Set(), pops = new Set();
      let skipped = 0;
      for (const k of list) {
        const a = P.FPDFPage_GetAnnot(p, k);
        if (!a) continue;
        try {
          const st = P.FPDFAnnot_GetSubtype(a);
          if (st === 2 || st === 16) { skipped++; continue; }
          flat.add(k);
          const pop = P.FPDFAnnot_GetLinkedAnnot(a, 'Popup');
          if (pop) { const pk = P.FPDFPage_GetAnnotIndex(p, pop); if (pk >= 0) pops.add(pk); P.FPDFPage_CloseAnnot(pop); }
        } finally { P.FPDFPage_CloseAnnot(a); }
      }
      let flattened = 0, failed = 0;
      for (const k of [...new Set([...flat, ...pops])].sort((x, y) => y - x)) { // 뒤에서부터 — 앞 주석의 번호가 밀리지 않는다
        if (!flat.has(k)) { P.FPDFPage_RemoveAnnot(p, k); continue; }
        const a = P.FPDFPage_GetAnnot(p, k);
        if (!a) { failed++; continue; }
        const ok = P.EPDFAnnot_Flatten(p, a);
        P.FPDFPage_CloseAnnot(a);
        if (ok) flattened++; else failed++;
      }
      if (flattened) regen(p);
      return { ok: flattened > 0, flattened, skipped, failed };
    },

    // ── v6 Wave E: 양식(AcroForm) ───────────────────────────────────────────
    // 양식 종류: 'none' · 'acroform' · 'xfa-full'(XFA 전용 — 칸을 채울 수 없다) · 'xfa-foreground'(XFA와 AcroForm 칸이 함께 — AcroForm 칸만 채운다)
    formType() { return FORM_TYPES[P.FPDF_GetFormType(doc)] || 'none'; },
    // 모든 칸: [{ i, index(그 쪽 /Annots 안 위치), name, alt(/TU), type, value, rect[l,b,r,t](회전 전 쪽 좌표), rotation(쪽 회전),
    //   required, readOnly, hidden, fontSize(0 = 자동), color, align(/Q), multiline, password, comb, maxLen, exportValue, checked, options[{label, selected}] … }]
    // 순서 = 쪽 순서 → 그 쪽 /Annots 순서(탭 순서)
    formFields() {
      const type = api.formType();
      if (type === 'none' || type === 'xfa-full') return { type, fields: [] };
      const fields = [], rot = new Map();
      eachWidget((form, a, i, k) => {
        if (!rot.has(i)) rot.set(i, P.FPDFPage_GetRotation(page(i)));
        fields.push(readField(form, a, i, k, rot.get(i)));
      });
      return { type, fields };
    },
    // 칸 하나에 값 쓰기. value: 글·콤보·목록은 문자열, 확인란은 true/false(또는 내보내기 값·'Off'), 라디오는 고른 위젯의 내보내기 값('Off'면 해제)
    // 반환 { ok, name, type, value, unicode:[…](외형을 맑은 고딕으로 다시 써야 할 위젯) }
    setFormValue(i, index, value) {
      const r = withFormPage(i, (form) => withAnnot(i, index, (a) => {
        if (P.FPDFAnnot_GetSubtype(a) !== 20) throw bad('양식 칸이 아닙니다.');
        const f = readField(form, a, i, index, 0);
        return { ok: true, name: f.name, type: f.type, value: writeField(form, a, f, value, page(i)) };
      }));
      return { ...r, unicode: regenFields(new Set([r.name])) };
    },
    // 이름 → 값 여러 개 한꺼번에(가져오기). 라디오는 그 값을 내보내기 값으로 가진 위젯에 쓴다. 반환 { ok, set, unknown[], failed[{name, error}], unicode }
    setFormValues(values = {}) {
      const want = new Map(Object.entries(values || {}).map(([k, v]) => [String(k), v]));
      const done = new Set(), failed = [];
      eachWidget((form, a, i, k) => {
        const f = readField(form, a, i, k, 0);
        if (!want.has(f.name) || done.has(f.name)) return;
        const v = want.get(f.name);
        if (f.type === 'radio' && v !== 'Off' && v !== false && v != null && v !== '' && String(v) !== f.exportValue) return; // 다른 위젯이 그 값을 가진다
        try { writeField(form, a, f, v, page(i)); done.add(f.name); } catch (e) { failed.push({ name: f.name, error: e.message }); done.add(f.name); }
      });
      const set = [...done].filter((n) => !failed.some((x) => x.name === n));
      const unknown = [...want.keys()].filter((n) => !done.has(n));
      return { ok: set.length > 0, set: set.length, names: set, unknown, failed, unicode: set.length ? regenFields(new Set(set)) : [] };
    },
    // 양식 초기화: 글·선택 칸은 기본값(/DV, 없으면 빈 값), 확인란·라디오는 해제. 읽기 전용·서명 칸은 그대로
    resetForm() {
      const names = new Set();
      let changed = 0;
      eachWidget((form, a, i, k) => {
        const f = readField(form, a, i, k, 0);
        if (f.readOnly || names.has(f.name) || !['text', 'combo', 'list', 'checkbox', 'radio'].includes(f.type)) return;
        names.add(f.name);
        const dv = annotStr(a, 'DV');
        const target = f.type === 'checkbox' || f.type === 'radio' ? 'Off' : dv;
        const isEmpty = f.type === 'checkbox' || f.type === 'radio' ? f.value === 'Off' || f.value === '' : f.value === target;
        if (isEmpty) return;
        try { writeField(form, a, f, f.type === 'checkbox' ? false : target, page(i)); changed++; } catch {}
      });
      return { ok: changed > 0, reset: changed, unicode: changed ? regenFields(names) : [] };
    },
    // 양식 고정(평면화): 모든 칸의 지금 외형을 쪽 내용으로 굳히고 칸을 뺀다. 숨은 칸·외형 없는 칸(빈 서명 칸)은 그냥 뺀다.
    // /AcroForm 사전 정리는 서버가 pdf-forms.stripAcroForm으로 한다(PDFium API에 카탈로그를 고치는 길이 없다)
    flattenForm() {
      let flattened = 0, removed = 0;
      for (let i = 0, n = P.FPDF_GetPageCount(doc); i < n; i++) {
        const p = page(i), flat = [], drop = [];
        for (let k = 0, m = P.FPDFPage_GetAnnotCount(p); k < m; k++) {
          const a = P.FPDFPage_GetAnnot(p, k);
          if (!a) continue;
          try {
            if (P.FPDFAnnot_GetSubtype(a) !== 20) continue;
            const hidden = (P.FPDFAnnot_GetFlags(a) >>> 0) & (ANNOT_FLAG_HIDDEN | ANNOT_FLAG_NOVIEW);
            (hidden ? drop : flat).push(k); // 외형 없는 칸(빈 서명 칸)은 고정이 실패하면 아래에서 뺀다 — 확인란처럼 상태별 외형(/N 사전)은 HasAppearanceStream이 false라 먼저 거르지 않는다
          } finally { P.FPDFPage_CloseAnnot(a); }
        }
        if (!flat.length && !drop.length) continue;
        // 뒤에서부터 — 앞 칸의 번호가 밀리지 않는다
        for (const k of [...flat, ...drop].sort((x, y) => y - x)) {
          if (drop.includes(k)) { if (P.FPDFPage_RemoveAnnot(p, k)) removed++; continue; }
          const a = P.FPDFPage_GetAnnot(p, k);
          if (!a) continue;
          const ok = P.EPDFAnnot_Flatten(p, a);
          P.FPDFPage_CloseAnnot(a);
          if (ok) flattened++; else if (P.FPDFPage_RemoveAnnot(p, k)) removed++;
        }
        regen(p);
      }
      return { ok: flattened + removed > 0, flattened, removed };
    },

    // ── 목차(책갈피) ─────────────────────────────────────────────────────────
    // 읽기: [{ title, page(0 기준, 목적지가 없거나 다른 파일이면 null), children }]. 순환·과도한 깊이(64)·개수(10,000)에서 멈춘다
    outline() {
      const seen = new Set(), tb = mal(2048);
      let total = 0;
      const pageOf = (bm) => {
        let dest = P.FPDFBookmark_GetDest(doc, bm);
        if (!dest) { const act = P.FPDFBookmark_GetAction(bm); if (act && P.FPDFAction_GetType(act) === 1) dest = P.FPDFAction_GetDest(doc, act); } // 1 = GOTO
        const k = dest ? P.FPDFDest_GetDestPageIndex(doc, dest) : -1;
        return k >= 0 ? k : null;
      };
      const read = (parent, depth) => {
        const out = [];
        for (let bm = P.FPDFBookmark_GetFirstChild(doc, parent); bm && !seen.has(bm) && total < 10000; bm = P.FPDFBookmark_GetNextSibling(doc, bm)) {
          seen.add(bm); total++;
          const n = P.FPDFBookmark_GetTitle(bm, tb, 2048);
          const title = n > 2 ? M.UTF16ToString(tb) : '';
          out.push({ title, page: pageOf(bm), children: depth < 64 ? read(bm, depth + 1) : [] });
        }
        return out;
      };
      try { return read(0, 0); } finally { free(tb); }
    },
    // 목차 통째로 바꾸기(EPDFBookmark_Clear → EPDFBookmark_AppendChild). 목적지는 그 쪽 보이는 왼쪽 위 XYZ(배율 유지). page:null이면 목적지 없는 제목
    setOutline(items) {
      const count = P.FPDF_GetPageCount(doc);
      let total = 0;
      const check = (list, depth) => {
        if (!Array.isArray(list)) throw bad('목차 형식이 잘못됐습니다(items 배열).');
        if (depth > 32) throw bad('목차는 32단계까지만 넣을 수 있습니다.');
        for (const it of list) {
          if (!it || typeof it !== 'object') throw bad('목차 항목 형식이 잘못됐습니다.');
          const title = String(it.title ?? '').trim();
          if (!title || title.length > 500) throw bad('목차 제목은 1~500자로 입력하세요.');
          if (it.page != null && !(Number.isInteger(it.page) && it.page >= 0 && it.page < count)) throw bad(`'${title.slice(0, 30)}'의 쪽 번호가 범위를 벗어났습니다 (1~${count}쪽).`);
          if (++total > 10000) throw bad('목차 항목은 10,000개까지입니다.');
          if (it.children != null) check(it.children, depth + 1);
        }
      };
      check(items, 1);
      if (!P.EPDFBookmark_Clear(doc)) throw new Error('기존 목차를 지우지 못했습니다.');
      const build = (parent, list) => {
        for (const it of list) {
          const u = utf16(String(it.title).trim());
          let bm;
          try { bm = P.EPDFBookmark_AppendChild(doc, parent, u); } finally { free(u); }
          if (!bm) throw new Error('목차 항목을 만들지 못했습니다.');
          if (it.page != null) {
            const f = visualFrame(it.page), [x, y] = f.map(0, f.height); // 보이는 쪽의 왼쪽 위
            const dest = P.EPDFDest_CreateXYZ(page(it.page), true, x, true, y, false, 0);
            if (!dest || !P.EPDFBookmark_SetDest(doc, bm, dest)) throw new Error('목차 목적지를 만들지 못했습니다.');
          }
          if (it.children?.length) build(bm, it.children);
        }
      };
      build(0, items);
      return { ok: true, count: total };
    },

    // ── 문서 정보 ──────────────────────────────────────────────────────────
    // 날짜(CreationDate·ModDate)는 ISO로(읽을 수 없으면 원문). 나머지는 글자 그대로
    meta() {
      const out = {};
      for (const k of META_KEYS) { const v = api.metaText(k); out[k] = /Date$/.test(k) ? (isoDate(v) || v) : v; }
      return out;
    },
    // fields: { Title, Author, Subject, Keywords } 중 준 것만. 빈 글자면 그 키를 지운다. ModDate는 지금으로.
    // 주의: /Info가 없는 문서는 PDFium이 저장할 때 트레일러에 /Info를 달지 않는다 — 서버가 저장본을 다시 읽어 확인하고 pdf-rewrite.setInfoPdf로 보충한다
    setMeta(fields = {}) {
      const applied = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!META_EDITABLE.includes(k)) throw bad(`바꿀 수 없는 문서 정보입니다: ${k} (Title·Author·Subject·Keywords)`);
        const s = String(v ?? '');
        if (s.length > 2000) throw bad('문서 정보는 항목마다 2,000자 이하로 입력하세요.');
        applied[k] = s;
      }
      applied.ModDate = pdfDate();
      for (const [k, s] of Object.entries(applied)) {
        const u = s ? utf16(s) : 0;
        try { if (!P.EPDF_SetMetaText(doc, k, u)) throw new Error(`문서 정보를 쓰지 못했습니다: ${k}`); } finally { if (u) free(u); }
      }
      return { ok: true, fields: applied };
    },
    // 문서 정보 키를 모두 비운다(숨은 데이터 지우기). 서버가 저장 뒤 /Info 자체도 떼어 낸다(pdf-rewrite.sanitizePdf) → 지운 키 수
    clearMeta() {
      let n = 0;
      for (const k of [...META_KEYS, 'Trapped']) if (api.metaText(k)) { if (P.EPDF_SetMetaText(doc, k, 0)) n++; }
      return n;
    },

    // ── 이미지 PDF(글자 없는 사본) ─────────────────────────────────────────
    // 새 문서를 만들어 쪽마다 렌더한 JPEG 한 장을 보이는 쪽 크기 그대로 깐다. 지금 문서는 바뀌지 않는다.
    // 긴 작업이라 서버가 쪽 사이에 진행·취소를 본다: const r = doc.rasterizer(); r.addPage(i, dpi, quality) …; r.finish() → 바이트; 끝나면 r.close()
    rasterizer() {
      flush();
      const dest = P.FPDF_CreateNewDocument();
      if (!dest) throw new Error('새 PDF를 만들지 못했습니다.');
      let pages = 0, closed = false;
      return {
        addPage(i, dpi = 150, quality = 0.85) {
          const d = Math.max(36, Math.min(600, Number(dpi) || 150)), q = Math.max(0.1, Math.min(1, Number(quality) || 0.85));
          const { w, h } = api.pageSize(i); // 보이는 크기(회전 반영)
          const jpg = api.renderJpeg(i, d / 72, Math.round(q * 100));
          const pg = P.FPDFPage_New(dest, pages, w, h);
          if (!pg) throw new Error('새 쪽을 만들지 못했습니다.');
          try {
            const io = P.FPDFPageObj_NewImageObj(dest);
            if (!io) throw new Error('이미지 객체를 만들지 못했습니다.');
            try { putJpeg(io, jpg); setMatrix(io, [w, 0, 0, h, 0, 0]); } catch (e) { P.FPDFPageObj_Destroy(io); throw e; }
            P.FPDFPage_InsertObject(pg, io);
            P.FPDFPage_GenerateContent(pg);
          } finally { P.FPDF_ClosePage(pg); }
          pages++;
          return jpg.length;
        },
        finish() { return saveDoc(P, dest); },
        close() { if (!closed) { closed = true; P.FPDF_CloseDocument(dest); } },
      };
    },

    // ── v6 Wave D: 쪽 자르기(CropBox) · 쪽 크기 바꾸기 · 영역 그림 · 링크 · 첨부 파일 · 베이츠 번호 ─────────────
    // 쪽 상자: 모두 회전 전 쪽 좌표 [왼, 아래, 오른, 위]. media = MediaBox, crop = CropBox(없으면 null), view = 보이는 상자(CropBox ∩ MediaBox — PDFium과 같다)
    pageBoxes(i) {
      const p = page(i), b = mal(16);
      try {
        const norm = (l, bt, r, t) => [Math.min(l, r), Math.min(bt, t), Math.max(l, r), Math.max(bt, t)];
        const get = (fn) => (fn.call(P, p, b, b + 4, b + 8, b + 12) ? norm(f32(b), f32(b + 4), f32(b + 8), f32(b + 12)) : null);
        const crop = get(P.FPDFPage_GetCropBox);
        let media = get(P.FPDFPage_GetMediaBox), view = null;
        if (P.FPDF_GetPageBoundingBox(p, b)) view = norm(f32(b), f32(b + 12), f32(b + 8), f32(b + 4)); // FS_RECTF { left, top, right, bottom }
        if (!media) media = view || [0, 0, P.FPDF_GetPageWidthF(p), P.FPDF_GetPageHeightF(p)]; // 부모(Pages)에서 물려받은 MediaBox
        return { media, crop, view: view || crop || media, rotation: ((P.FPDFPage_GetRotation(p) % 4) + 4) % 4 };
      } finally { free(b); }
    },
    // 보이는 방향의 여백 { top, right, bottom, left }(pt, MediaBox 가장자리에서) → 회전 전 쪽 좌표 사각형. 회전된 쪽도 사용자가 보는 위·아래·왼·오른쪽 그대로
    marginsToRect(i, m = {}) {
      const { media, rotation: rot } = api.pageBoxes(i);
      const [x0, y0, x1, y1] = media, W = x1 - x0, H = y1 - y0;
      const map = [ // visualFrame과 같은 대응(보이는 왼쪽 아래가 원점, 위가 +y)
        (vx, vy) => [x0 + vx, y0 + vy], (vx, vy) => [x0 + W - vy, y0 + vx],
        (vx, vy) => [x1 - vx, y1 - vy], (vx, vy) => [x0 + vy, y1 - vx],
      ][rot];
      const VW = rot % 2 ? H : W, VH = rot % 2 ? W : H;
      const n = (v) => { const x = v == null || v === '' ? 0 : Number(v); if (!Number.isFinite(x) || x < 0) throw bad('여백은 0 이상의 숫자(pt)로 입력하세요.'); return x; };
      const left = n(m.left), right = n(m.right), top = n(m.top), bottom = n(m.bottom);
      const [ax, ay] = map(left, bottom), [bx, by] = map(VW - right, VH - top);
      return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
    },
    // 내용이 그려진 곳의 외곽 상자(회전 전 쪽 좌표 [l,b,r,t]) — 쪽을 그려 흰색이 아닌 픽셀을 찾는다. 빈 쪽이면 null
    contentBox(i, { scale = 1.5, threshold = 245 } = {}) {
      const raw = api._renderRaw(i, scale);
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
      for (let y = 0; y < raw.h; y++) {
        const row = y * raw.stride;
        for (let x = 0; x < raw.w; x++) {
          const q = row + x * 4;
          if (raw.data[q] >= threshold && raw.data[q + 1] >= threshold && raw.data[q + 2] >= threshold) continue;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
      if (x1 < 0) return null;
      const out = mal(16), p = page(i);
      try {
        const pt = (dx, dy) => { P.FPDF_DeviceToPage(p, 0, 0, raw.w, raw.h, 0, dx, dy, out, out + 8); return [f64(out), f64(out + 8)]; };
        const [ax, ay] = pt(x0, y0), [bx, by] = pt(x1 + 1, y1 + 1);
        return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      } finally { free(out); }
    },
    // 쪽 자르기: spec 하나를 고른 쪽들에 건다(CropBox). 화면은 보이는 상자만 그리고, 잘린 바깥 내용은 파일에 남는다(다시 풀 수 있다).
    //   { rect:[l,b,r,t] } 모든 쪽에 같은 사각형(쪽마다 MediaBox 안으로 자른다) · { margins:{top,right,bottom,left} } 보이는 방향 여백(MediaBox에서)
    //   · { auto:true, pad } 쪽마다 내용 외곽 + pad(pt, 기본 6) · { reset:true } 자르기 풀기(CropBox = MediaBox)
    // 반환 { ok, pages:[{ i, crop }], skipped:[{ i, reason }] }. 18pt보다 작아지는 쪽은 건너뛴다
    cropPages(pages, spec = {}) {
      const list = pageList(pages);
      const MIN = 18, out = [], skipped = [];
      let rect = null;
      if (spec.rect != null) {
        const r = spec.rect;
        if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(Number(v)))) throw bad('자를 사각형은 [왼쪽, 아래, 오른쪽, 위] 숫자 4개여야 합니다.');
        rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])].map(Number);
      } else if (!spec.margins && !spec.auto && !spec.reset) throw bad('자를 방법(rect·margins·auto·reset)을 고르세요.');
      const pad = spec.pad == null ? 6 : Number(spec.pad);
      if (!(pad >= 0 && pad <= 200)) throw bad('자동 자르기 여유는 0~200pt로 지정하세요.');
      for (const i of list) {
        const { media } = api.pageBoxes(i);
        let box;
        if (spec.reset) box = media.slice();
        else if (rect) box = rect.slice();
        else if (spec.margins) box = api.marginsToRect(i, spec.margins);
        else {
          const c = api.contentBox(i);
          if (!c) { skipped.push({ i, reason: '빈 쪽' }); continue; }
          box = [c[0] - pad, c[1] - pad, c[2] + pad, c[3] + pad];
        }
        box = [Math.max(box[0], media[0]), Math.max(box[1], media[1]), Math.min(box[2], media[2]), Math.min(box[3], media[3])];
        if (box[2] - box[0] < MIN || box[3] - box[1] < MIN) { skipped.push({ i, reason: '너무 작습니다' }); continue; }
        P.FPDFPage_SetCropBox(page(i), box[0], box[1], box[2], box[3]);
        out.push({ i, crop: box.map((v) => Math.round(v * 100) / 100) });
      }
      return { ok: out.length > 0, pages: out, skipped };
    },
    // 쪽 크기 바꾸기: 보이는 방향의 새 크기 width×height(pt). mode 'fit' = 보이는 내용을 비율을 지켜 맞춰 키우거나 줄이고 가운데로,
    //   'center' = 크기는 그대로 가운데로(새 쪽보다 크면 가장자리가 잘린다).
    //   새 쪽에 XObject로 옮기지 않고 쪽의 객체·주석을 직접 옮긴다(FPDFPageObj_Transform + 자르기 경로 + FPDFPage_TransformAnnots) — 글자를 계속 고칠 수 있다.
    //   MediaBox·CropBox를 새 크기로 바꾼다. 회전된 쪽은 회전 전 좌표에서 가로·세로를 바꿔 계산한다
    //   keepOrientation: 쪽마다 원래 방향(가로 쪽은 가로로 — width·height를 바꿔 쓴다)
    resizePages(pages, { width, height, mode = 'fit', keepOrientation = false } = {}) {
      const list = pageList(pages);
      const W = Number(width), H = Number(height);
      if (!(W >= 36 && W <= 14400 && H >= 36 && H <= 14400)) throw bad('쪽 크기는 36~14400pt(약 1.3cm~5m)로 지정하세요.');
      if (!['fit', 'center'].includes(mode)) throw bad(`알 수 없는 맞춤 방식입니다: ${mode} (fit·center)`);
      const done = [];
      for (const i of list) {
        const p = page(i), { view, rotation: rot } = api.pageBoxes(i);
        const landscape = (rot % 2 ? view[3] - view[1] : view[2] - view[0]) > (rot % 2 ? view[2] - view[0] : view[3] - view[1]);
        const [VW, VH] = keepOrientation && landscape !== (W > H) ? [H, W] : [W, H];
        const TW = rot % 2 ? VH : VW, TH = rot % 2 ? VW : VH;
        const vw = view[2] - view[0], vh = view[3] - view[1];
        const s = mode === 'fit' ? Math.min(TW / vw, TH / vh) : 1;
        const tx = (TW - vw * s) / 2 - view[0] * s, ty = (TH - vh * s) / 2 - view[1] * s;
        for (let k = 0, n = P.FPDFPage_CountObjects(p); k < n; k++) {
          const o = P.FPDFPage_GetObject(p, k);
          if (!o) continue;
          P.FPDFPageObj_Transform(o, s, 0, 0, s, tx, ty);
          P.FPDFPageObj_TransformClipPath(o, s, 0, 0, s, tx, ty);
        }
        P.FPDFPage_TransformAnnots(p, s, 0, 0, s, tx, ty);
        P.FPDFPage_SetMediaBox(p, 0, 0, TW, TH);
        P.FPDFPage_SetCropBox(p, 0, 0, TW, TH);
        regen(p);
        done.push({ i, scale: Math.round(s * 10000) / 10000 });
      }
      return { ok: done.length > 0, pages: done };
    },
    // 영역 그림(PNG): rect {x0,y0,x1,y1}(회전 전 쪽 좌표) 안을 scale 배율로. 보이는 방향 그대로(회전·CropBox 반영). 영역 스냅샷·Markdown 그림 저장이 쓴다
    renderArea(i, rect, scale = 2) {
      if (!rect || ![rect.x0, rect.y0, rect.x1, rect.y1].every(Number.isFinite)) throw bad('그릴 영역이 잘못됐습니다.');
      const s0 = Math.max(0.25, Math.min(8, Number(scale) || 2));
      const area = Math.abs((rect.x1 - rect.x0) * (rect.y1 - rect.y0));
      const s = Math.min(s0, Math.sqrt(24e6 / Math.max(1, area))); // 2,400만 화소까지(약 96MB)
      const size = api.pageSize(i), PW = Math.max(1, Math.round(size.w * s)), PH = Math.max(1, Math.round(size.h * s));
      const [ax, ay] = toDevice(i, rect.x0, rect.y0, s), [bx, by] = toDevice(i, rect.x1, rect.y1, s);
      const dx0 = Math.max(0, Math.min(ax, bx)), dx1 = Math.min(PW, Math.max(ax, bx)), dy0 = Math.max(0, Math.min(ay, by)), dy1 = Math.min(PH, Math.max(ay, by));
      const pw = dx1 - dx0, ph = dy1 - dy0;
      if (!(pw >= 1 && ph >= 1)) throw bad('영역이 쪽 밖에 있습니다.');
      const bmp = P.FPDFBitmap_Create(pw, ph, 0), outPP = mal(4);
      if (!bmp) { free(outPP); throw new Error('그림을 만들지 못했습니다(메모리 부족).'); }
      try {
        P.FPDFBitmap_FillRect(bmp, 0, 0, pw, ph, 0xffffffff);
        renderInto(bmp, i, -dx0, -dy0, PW, PH);
        const len = P.EPDF_PNG_EncodeRGBA(P.FPDFBitmap_GetBuffer(bmp), pw, ph, P.FPDFBitmap_GetStride(bmp), 6, outPP);
        const ptr = i32(outPP);
        if (!len || !ptr) throw new Error('PNG를 만들지 못했습니다.');
        try { return Buffer.from(heap().subarray(ptr, ptr + len)); } finally { free(ptr); }
      } finally { free(outPP); P.FPDFBitmap_Destroy(bmp); }
    },

    // ── 링크(/Link 주석) ───────────────────────────────────────────────────
    // 읽기: [{ index(그 쪽 /Annots 안 위치), rect:[l,b,r,t], kind:'uri'|'page'|'file'|'other', uri?, page?(0 기준) }]
    links(i) {
      const p = page(i), out = [];
      for (let k = 0, n = P.FPDFPage_GetAnnotCount(p); k < n; k++) {
        const a = P.FPDFPage_GetAnnot(p, k);
        if (!a) continue;
        try {
          if (P.FPDFAnnot_GetSubtype(a) !== 2) continue;
          const item = { index: k, rect: annotRect(a), kind: 'other' };
          const link = P.FPDFAnnot_GetLink(a);
          const act = link ? P.FPDFLink_GetAction(link) : 0;
          const type = act ? P.FPDFAction_GetType(act) : 0;
          let dest = 0;
          if (type === 3) { // URI
            const n2 = P.FPDFAction_GetURIPath(doc, act, 0, 0);
            if (n2 > 1) { const sb = mal(n2); try { P.FPDFAction_GetURIPath(doc, act, sb, n2); item.uri = M.UTF8ToString(sb); } finally { free(sb); } }
            item.kind = 'uri';
          } else if (type === 1) dest = P.FPDFAction_GetDest(doc, act);
          else if (type === 2 || type === 4) item.kind = 'file';
          else if (link) dest = P.FPDFLink_GetDest(doc, link);
          if (dest) { const pi = P.FPDFDest_GetDestPageIndex(doc, dest); if (pi >= 0) { item.kind = 'page'; item.page = pi; } }
          out.push(item);
        } finally { P.FPDFPage_CloseAnnot(a); }
      }
      return out;
    },
    // 링크 만들기: rect [l,b,r,t] + 대상 { uri } 또는 { page(0 기준) }. 테두리 없음(/Border [0 0 0]), 인쇄 표시. 반환 { ok, index, link }
    addLink(i, rect, target = {}) {
      const r = rect;
      if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(Number(v)))) throw bad('링크 자리는 [왼쪽, 아래, 오른쪽, 위] 숫자 4개여야 합니다.');
      const box = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])].map(Number);
      if (box[2] - box[0] < 2 || box[3] - box[1] < 2) throw bad('링크 자리가 너무 작습니다.');
      const p = page(i);
      let action;
      if (target.uri != null) {
        const uri = normalizeLinkUri(target.uri);
        action = P.EPDFAction_CreateURI(doc, uri);
      } else if (target.page != null) {
        const pi = Number(target.page);
        if (!Number.isInteger(pi) || pi < 0 || pi >= P.FPDF_GetPageCount(doc)) throw bad(`쪽 번호가 범위를 벗어났습니다 (1~${P.FPDF_GetPageCount(doc)}쪽).`);
        const f = visualFrame(pi), [x, y] = f.map(0, f.height); // 보이는 쪽의 왼쪽 위(목차와 같다)
        const dest = P.EPDFDest_CreateXYZ(page(pi), true, x, true, y, false, 0);
        action = dest ? P.EPDFAction_CreateGoTo(doc, dest) : 0;
      } else throw bad('링크 대상(주소 또는 쪽)을 고르세요.');
      if (!action) throw new Error('링크 동작을 만들지 못했습니다.');
      const a = P.EPDFPage_CreateAnnot(p, 2);
      if (!a) throw new Error('링크를 만들지 못했습니다.');
      try {
        const ok = setAnnotRect(a, box) && P.EPDFAnnot_SetAction(a, action) && P.FPDFAnnot_SetBorder(a, 0, 0, 0) && P.FPDFAnnot_SetFlags(a, ANNOT_FLAG_PRINT)
          && setAnnotStr(a, 'NM', 'retext-link-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        const index = P.FPDFPage_GetAnnotIndex(p, a);
        if (!ok || index < 0) { if (index >= 0) P.FPDFPage_RemoveAnnot(p, index); throw new Error('링크 속성을 쓰지 못했습니다.'); }
        return { ok: true, index, link: api.links(i).find((l) => l.index === index) };
      } finally { P.FPDFPage_CloseAnnot(a); }
    },
    // 링크 고치기: 대상(uri·page)이나 자리(rect)를 바꾼다. 같은 자리에 새 링크를 만들고 옛 것을 지운다(/Dest와 /A가 함께 남지 않게) → 새 index
    updateLink(i, index, patch = {}) {
      const old = api.links(i).find((l) => l.index === Number(index));
      if (!old) throw Object.assign(new Error('링크를 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 고르세요.'), { status: 404 });
      const target = patch.uri != null ? { uri: patch.uri } : patch.page != null ? { page: patch.page }
        : old.kind === 'uri' ? { uri: old.uri } : old.kind === 'page' ? { page: old.page } : null;
      if (!target) throw bad('이 링크는 대상을 읽을 수 없어 고칠 수 없습니다. 지우고 새로 만드세요.');
      const made = api.addLink(i, patch.rect || old.rect, target);
      removeAnnots(page(i), [old.index]);
      const now = api.links(i), link = now.find((l) => l.rect && made.link && l.rect.every((v, k) => Math.abs(v - made.link.rect[k]) < 0.01) && l.kind === made.link.kind && l.uri === made.link.uri && l.page === made.link.page);
      return { ok: true, index: link ? link.index : now.length - 1, link: link || now[now.length - 1] };
    },
    deleteLink(i, index) {
      if (!api.links(i).some((l) => l.index === Number(index))) throw Object.assign(new Error('링크를 찾을 수 없습니다.'), { status: 404 });
      const removed = removeAnnots(page(i), [Number(index)]);
      return { ok: removed > 0, removed };
    },

    // ── 첨부 파일(문서 /EmbeddedFiles) ────────────────────────────────────
    attachments() {
      const out = [];
      for (let k = 0, n = P.FPDFDoc_GetAttachmentCount(doc); k < n; k++) {
        const at = P.FPDFDoc_GetAttachment(doc, k);
        if (!at) continue;
        const item = { index: k, name: '', size: null, desc: '' };
        const nl = P.FPDFAttachment_GetName(at, 0, 0);
        if (nl > 2) { const b = mal(nl); try { P.FPDFAttachment_GetName(at, b, nl); item.name = M.UTF16ToString(b); } finally { free(b); } }
        const sz = mal(4);
        try { if (P.FPDFAttachment_GetFile(at, 0, 0, sz)) item.size = M.getValue(sz, 'i32') >>> 0; } finally { free(sz); }
        const dl = P.EPDFAttachment_GetDescription ? P.EPDFAttachment_GetDescription(at, 0, 0) : 0;
        if (dl > 2) { const b = mal(dl); try { P.EPDFAttachment_GetDescription(at, b, dl); item.desc = M.UTF16ToString(b); } finally { free(b); } }
        out.push(item);
      }
      return out;
    },
    attachmentData(index) {
      const k = Number(index);
      if (!Number.isInteger(k) || k < 0 || k >= P.FPDFDoc_GetAttachmentCount(doc)) throw Object.assign(new Error('첨부 파일을 찾을 수 없습니다.'), { status: 404 });
      const at = P.FPDFDoc_GetAttachment(doc, k), sz = mal(4);
      try {
        if (!at || !P.FPDFAttachment_GetFile(at, 0, 0, sz)) throw new Error('첨부 파일 내용을 읽지 못했습니다.');
        const n = M.getValue(sz, 'i32') >>> 0, b = mal(Math.max(1, n));
        try { if (!P.FPDFAttachment_GetFile(at, b, n, sz)) throw new Error('첨부 파일 내용을 읽지 못했습니다.'); return Buffer.from(heap().subarray(b, b + n)); } finally { free(b); }
      } finally { free(sz); }
    },
    // 첨부 넣기: 이름(경로 빼고 파일 이름만) + 바이트. 같은 이름이 있으면 400. 반환 { ok, index, name, size }
    addAttachment(name, bytes, desc) {
      const nm = String(name ?? '').split(/[\\/]/).pop().trim();
      if (!nm || nm.length > 255) throw bad('첨부 파일 이름은 1~255자여야 합니다.');
      const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
      if (data.length > 256 * 1024 * 1024) throw bad('첨부 파일은 256MB까지 넣을 수 있습니다.');
      if (api.attachments().some((a) => a.name.toLowerCase() === nm.toLowerCase())) throw bad(`같은 이름의 첨부 파일이 이미 있습니다: ${nm}`);
      const u = utf16(nm);
      let at;
      try { at = P.FPDFDoc_AddAttachment(doc, u); } finally { free(u); }
      if (!at) throw new Error('첨부 파일을 넣지 못했습니다.');
      const ptr = mal(Math.max(1, data.length));
      try {
        heap().set(data, ptr);
        if (!P.FPDFAttachment_SetFile(at, doc, ptr, data.length)) throw new Error('첨부 파일 내용을 쓰지 못했습니다.');
      } finally { free(ptr); }
      if (desc && P.EPDFAttachment_SetDescription) { const d = utf16(String(desc).slice(0, 500)); try { P.EPDFAttachment_SetDescription(at, d); } finally { free(d); } }
      const index = P.FPDFDoc_GetAttachmentCount(doc) - 1;
      const found = api.attachments().find((a) => a.name === nm);
      return { ok: true, index: found ? found.index : index, name: nm, size: data.length };
    },
    // 첨부 지우기: 이름표(EmbeddedFiles)에서 뺀다. 내용 스트림이 고아로 남지 않게 서버가 다시 쓰기(compactDoc)를 한다
    deleteAttachment(index) {
      const k = Number(index);
      if (!Number.isInteger(k) || k < 0 || k >= P.FPDFDoc_GetAttachmentCount(doc)) throw Object.assign(new Error('첨부 파일을 찾을 수 없습니다.'), { status: 404 });
      return { ok: !!P.FPDFDoc_DeleteAttachment(doc, k) };
    },

    // ── 베이츠 번호(법률·감사 문서의 쪽 일련번호) ─────────────────────────────
    // opts: { prefix, suffix, digits(1~12, 기본 6), start(기본 1), position(쪽 번호와 같은 다섯 자리 + 'bottom-right' 기본), size(기본 9), margin(기본 24),
    //         color, fontId, pages(0 기준 배열, 생략 = 전체) } → 고른 쪽에 차례로 prefix + 0을 채운 번호 + suffix.
    //   RetextPdfBates 마크 — 다시 넣으면 옛 번호를 모두 지우고 새로 넣는다. 반환 { ok, placed, first, last, next(다음 파일이 이어 쓸 번호), removed }
    addBates(opts = {}) {
      const pos = opts.position || 'bottom-right';
      if (!['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right', 'top-left'].includes(pos)) throw bad(`알 수 없는 위치입니다: ${pos}`);
      const prefix = String(opts.prefix ?? ''), suffix = String(opts.suffix ?? '');
      if (prefix.length > 40 || suffix.length > 40 || /[\r\n]/.test(prefix + suffix)) throw bad('접두어·접미어는 40자 이하의 한 줄로 입력하세요.');
      const digits = opts.digits == null ? 6 : Number(opts.digits);
      if (!Number.isInteger(digits) || digits < 1 || digits > 12) throw bad('자릿수는 1~12로 지정하세요.');
      const start = opts.start == null ? 1 : Number(opts.start);
      if (!Number.isInteger(start) || start < 0 || start > 999999999999) throw bad('시작 번호는 0 이상의 정수로 지정하세요.');
      const size = opts.size == null ? 9 : Number(opts.size), margin = opts.margin == null ? 24 : Number(opts.margin);
      if (!(size >= 4 && size <= 72)) throw bad('글자 크기는 4~72pt 범위로 지정하세요.');
      if (!(margin >= 0 && margin <= 300)) throw bad('여백은 0~300pt 범위로 지정하세요.');
      const color = parseColor(opts.color);
      const list = pageList(opts.pages);
      const labels = list.map((_, k) => prefix + String(start + k).padStart(digits, '0') + suffix);
      const { font } = newTextFont(opts.fontId, labels.join('') || '0', size);
      const at = { h: pos.endsWith('center') ? 'center' : pos.endsWith('right') ? 'right' : 'left', v: pos.startsWith('bottom') ? 'bottom' : 'top' };
      return api.batch(() => {
        const removed = removeMarked(MARK_BATES);
        list.forEach((i, k) => placeText(i, { font, size, text: labels[k], color, at, margin, mark: MARK_BATES }));
        return { ok: true, placed: list.length, first: labels[0], last: labels[labels.length - 1], next: start + list.length, removed };
      });
    },
    removeBates() { const removed = api.batch(() => removeMarked(MARK_BATES)); return { ok: removed > 0, removed }; },

    save() { flush(); return saveDoc(P, doc); },

    close() {
      pending.clear();
      for (const h of pages.values()) P.FPDF_ClosePage(h);
      pages.clear();
      if (formEnv) { P.PDFiumExt_ExitFormFillEnvironment(formEnv.handle); P.PDFiumExt_CloseFormFillInfo(formEnv.info); formEnv = null; } // v6 Wave E: 양식 환경은 문서보다 먼저 닫는다
      P.FPDF_CloseDocument(doc);
      free(srcPtr);
      for (const p of fbPtrs.splice(0)) free(p);
      fb.regular = fb.bold = null;
    },
  };
  return api;
}

module.exports = { open, merge, normalizeLinkUri, _subsetTTF: subsetTTF }; // _subsetTTF: 시험 픽스처(고정폭 서브셋 글꼴 PDF)용
