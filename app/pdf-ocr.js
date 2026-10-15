// v6 Wave E2: 글자 인식(OCR) — tesseract.js 7(Apache-2.0, WASM)를 앱 안에서만 돌린다. 문서 그림은 PC 밖으로 나가지 않는다.
//   · 인식 데이터: app/vendor/ocr/{kor,eng}.traineddata (tesseract-ocr/tessdata_fast, 커밋·SHA-256은 아래 LANGS와 THIRD-PARTY-NOTICES.md)
//     처음 쓸 때 크기·SHA-256을 확인한다(바뀐 파일로는 인식하지 않는다).
//   · 작업 스레드: app/ocr-worker.js(네트워크 길을 막은 뒤 tesseract의 Node 작업 스크립트를 부른다). 인식은 그 스레드에서 돌아
//     서버의 이벤트 루프(진행 조회·취소)를 막지 않는다. 설치본에서는 app.asar.unpacked 안의 파일을 쓴다(package.json build.asarUnpack).
//   · 엔진·쪽 그리기를 모른다 — 서버가 쪽을 RGBA로 그려(bitmap {w,h,stride,data}) 넘기고, 돌려받은 좌표(비트맵 px)를 쪽 좌표로 바꾼다.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

// 설치본(app.asar)에서는 작업 스레드·인식 데이터를 asar 밖(app.asar.unpacked)에서 읽는다 — 작업 스레드는 asar 안 파일을 못 연다
const unpacked = (p) => p.replace(/([\\/])app\.asar(?=[\\/])/i, '$1app.asar.unpacked');
const DATA_DIR = unpacked(path.join(__dirname, 'vendor', 'ocr'));
const WORKER_PATH = unpacked(path.join(__dirname, 'ocr-worker.js'));
const ENGINE = 'tesseract.js 7.0.0 (tesseract.js-core 7.0.0, LSTM)';
const DATA_SOURCE = 'https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd';
const LANGS = {
  kor: { label: '한국어', bytes: 1677415, sha256: '6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2' },
  eng: { label: '영어', bytes: 4113088, sha256: '7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2' },
};
const DEFAULT_LANGS = ['kor', 'eng'];
const MIN_WORD_CONF = 20;     // 이보다 낮은 낱말은 버린다(얼룩·선을 글자로 읽은 것)
const IDLE_MS = 60000;         // 쓰지 않는 작업 스레드는 60초 뒤 끝낸다(메모리 반환)
// 쪽 나누기 방식: 4 = 크기가 섞인 한 단 글(실측 2026-10-15 안내문 스캔: 3(자동)은 굵은 제목 아래 절반을 통째로 놓치고, 6(한 덩어리)은 한글 낱말을 영문으로 더 자주 읽었다)
const PSM_PAGE = '4';

// 언어 목록 정리: 아는 것만, 한국어를 앞에(같은 글자를 두 언어가 다르게 읽으면 앞 언어가 이긴다)
function normLangs(langs) {
  const want = [].concat(langs == null || langs === '' ? DEFAULT_LANGS : langs).map((l) => String(l).trim().toLowerCase()).filter(Boolean);
  const bad = want.find((l) => !LANGS[l]);
  if (bad) throw Object.assign(new Error(`지원하지 않는 인식 언어입니다: ${bad} (${Object.keys(LANGS).join('·')})`), { status: 400 });
  const out = Object.keys(LANGS).filter((l) => want.includes(l));
  if (!out.length) throw Object.assign(new Error('인식할 언어를 하나 이상 고르세요'), { status: 400 });
  return out;
}

// ── 인식 데이터 확인 ────────────────────────────────────────────────────────
const verified = new Map(); // lang → true | Error
function verifyLang(lang) {
  if (verified.has(lang)) { const v = verified.get(lang); if (v !== true) throw v; return true; }
  const file = path.join(DATA_DIR, `${lang}.traineddata`), want = LANGS[lang];
  let err = null;
  try {
    const buf = fs.readFileSync(file);
    if (buf.length !== want.bytes) err = new Error(`인식 데이터(${lang})의 크기가 다릅니다 — 앱을 다시 설치하세요`);
    else if (crypto.createHash('sha256').update(buf).digest('hex') !== want.sha256) err = new Error(`인식 데이터(${lang})가 손상됐습니다 — 앱을 다시 설치하세요`);
  } catch (e) { err = new Error(`인식 데이터(${lang})를 찾을 수 없습니다 — 앱을 다시 설치하세요 (${e.code || e.message})`); }
  verified.set(lang, err || true);
  if (err) throw err;
  return true;
}
// 화면이 묻는 상태: 쓸 수 있는가 · 언어별 이름·크기
function status() {
  const langs = Object.entries(LANGS).map(([code, l]) => {
    let ok = true, error = null;
    try { verifyLang(code); } catch (e) { ok = false; error = e.message; }
    return { code, label: l.label, bytes: l.bytes, ok, ...(error ? { error } : {}) };
  });
  let engineOk = true;
  try { require.resolve('tesseract.js'); require.resolve('tesseract.js-core/package.json'); } catch { engineOk = false; }
  return { available: engineOk && langs.some((l) => l.ok) && fs.existsSync(WORKER_PATH), engine: ENGINE, langs, defaultLangs: DEFAULT_LANGS, source: DATA_SOURCE };
}
// tesseract 작업 설정 — 모든 경로가 앱 안 파일이다(시험이 이 값을 확인한다)
function workerOptions() {
  return { workerPath: WORKER_PATH, langPath: DATA_DIR, gzip: false, cacheMethod: 'none', workerBlobURL: false, logger: () => {}, errorHandler: () => {} };
}

// ── 작업 스레드 ────────────────────────────────────────────────────────────
// tesseract.js는 작업 스레드가 죽으면(WASM 중단 등) 'error'를 듣는 곳이 없어 서버 프로세스까지 죽는다 →
// tesseract.js를 처음 부를 때만 worker_threads.Worker를 감싼 것으로 바꿔 두어(spawnWorker가 그때 붙잡는다) 오류·종료를 여기서 받는다
let T = null, lastSpawned = null;
function tesseract() {
  if (T) return T;
  const wt = require('worker_threads'), Orig = wt.Worker;
  class GuardedWorker extends Orig {
    constructor(...args) {
      super(...args);
      this.ocrDied = new Promise((resolve) => {
        this.on('error', (e) => resolve(new Error(`글자 인식 엔진이 멈췄습니다: ${e && e.message || e}`)));
        this.on('exit', (code) => resolve(new Error(`글자 인식 엔진이 끝났습니다(코드 ${code})`)));
      });
      lastSpawned = this;
    }
  }
  wt.Worker = GuardedWorker;
  try { T = require('tesseract.js'); } finally { wt.Worker = Orig; }
  return T;
}
const pool = new Map(); // key → { ready: Promise<{ w, thread }>, timer, busy }
function dropWorker(key) {
  const e = pool.get(key);
  if (!e) return;
  pool.delete(key); clearTimeout(e.timer);
  e.ready.then(({ w }) => w.terminate()).catch(() => {});
}
async function getWorker(langs, psm = '3') {
  langs.forEach(verifyLang);
  const key = `${langs.join('+')}|${psm}`;
  let e = pool.get(key);
  if (!e) {
    const { createWorker, OEM } = tesseract();
    e = { timer: null, ready: null };
    e.ready = (async () => {
      lastSpawned = null;
      // 언어 데이터를 못 읽으면 tesseract.js의 createWorker는 끝나지 않는다(오류를 errorHandler로만 알린다) → 그 알림으로 실패시킨다
      let failCreate;
      const createFailed = new Promise((_, reject) => { failCreate = reject; });
      const pending = createWorker(langs, OEM.LSTM_ONLY, { ...workerOptions(), errorHandler: (msg) => failCreate(new Error(`글자 인식 엔진을 시작하지 못했습니다: ${msg}`)) });
      const thread = lastSpawned;
      let w;
      try { w = await Promise.race([pending, createFailed, ...(thread ? [thread.ocrDied.then((err) => { throw err; })] : [])]); }
      catch (err) { try { await thread?.terminate(); } catch {} throw err; }
      await w.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: '300', debug_file: '/dev/null' }); // debug_file: 'Detected N diacritics' 같은 엔진 잡담을 서버 로그에 찍지 않는다
      return { w, thread };
    })();
    e.ready.catch(() => { if (pool.get(key) === e) pool.delete(key); });
    pool.set(key, e);
  }
  clearTimeout(e.timer);
  const got = await e.ready;
  e.timer = setTimeout(() => dropWorker(key), IDLE_MS); e.timer.unref();
  return { ...got, key };
}
// 한 번 인식. 취소(isCancelled)는 200ms마다 보고, 취소되면 작업 스레드를 끝내 바로 돌아온다(쪽 하나 인식이 몇 초라 기다리지 않는다)
async function run(langs, psm, image, opts, isCancelled) {
  const { w, thread, key } = await getWorker(langs, psm);
  let timer = null;
  const cancel = new Promise((resolve) => { if (isCancelled) timer = setInterval(() => { if (isCancelled()) resolve('cancel'); }, 200); });
  const died = thread ? thread.ocrDied : new Promise(() => {});
  try {
    const r = await Promise.race([w.recognize(image, opts, { text: true, blocks: true }).then((x) => x.data), cancel, died.then((err) => { throw err; })]);
    if (r === 'cancel') { dropWorker(key); return null; }
    return r;
  } catch (e) {
    dropWorker(key); // 이상해진 스레드는 버린다(다음 인식은 새로)
    throw e instanceof Error ? e : new Error(`글자 인식에 실패했습니다: ${e}`);
  } finally { clearInterval(timer); }
}
async function shutdown() { for (const key of [...pool.keys()]) dropWorker(key); }

// ── 그림 다루기(순수) ──────────────────────────────────────────────────────
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
// 회색조(8비트) PNG — 컬러 RGBA보다 4배 작고 tesseract도 회색조로 읽는다. 압축은 빠르게(level 1)
function grayPng(g, w, h) {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) rows.set(g.subarray(y * w, y * w + w), y * (w + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}
// RGBA 비트맵의 사각형(px) → 회색조 { g, w, h }
function toGray(bmp, rect) {
  const { x, y, w, h } = rect, g = Buffer.alloc(w * h), d = bmp.data;
  for (let r = 0; r < h; r++) {
    let p = (y + r) * bmp.stride + x * 4, q = r * w;
    for (let c = 0; c < w; c++, p += 4, q++) g[q] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  }
  return { g, w, h };
}
// 회색조 그림을 시계 방향 90°×k 돌린다
function rotGray({ g, w, h }, k) {
  k = ((k % 4) + 4) % 4;
  if (!k) return { g, w, h };
  const W = k % 2 ? h : w, H = k % 2 ? w : h, o = Buffer.alloc(W * H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = k === 1 ? [h - 1 - y, x] : k === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    o[Y * W + X] = g[y * w + x];
  }
  return { g: o, w: W, h: H };
}
// 돌린 그림의 점 → 돌리기 전 그림의 점(rotGray의 역)
function unrot(k, X, Y, w, h) {
  k = ((k % 4) + 4) % 4;
  return k === 0 ? [X, Y] : k === 1 ? [Y, h - X] : k === 2 ? [w - X, h - Y] : [w - Y, X];
}
// 반으로 줄이기(방향 찾기 미리 보기용)
function halfGray({ g, w, h }) {
  const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), o = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const p = 2 * y * w + 2 * x; o[y * W + x] = (g[p] + g[p + 1] + g[p + w] + g[p + w + 1] + 2) >> 2; }
  return { g: o, w: W, h: H };
}
const hasInk = ({ g }) => { let n = 0; for (let i = 0; i < g.length; i += 7) if (g[i] < 128) n++; return n > 40; };

// 줄 하나의 배경·글자 색(편집 가능한 글자로 바꿀 때 쓴다): 줄 상자 둘레(바깥 2~5px)의 중앙값 = 배경,
// 상자 안에서 배경과 가장 다른 8% 픽셀의 평균 = 글자 색. bmp px 사각형 { x0, y0, x1, y1 }
function lineColors(bmp, b) {
  const W = bmp.w, H = bmp.h, d = bmp.data, px = (x, y) => { const p = y * bmp.stride + x * 4; return [d[p], d[p + 1], d[p + 2]]; };
  const ring = [];
  const x0 = Math.max(0, Math.floor(b.x0) - 5), x1 = Math.min(W - 1, Math.ceil(b.x1) + 5), y0 = Math.max(0, Math.floor(b.y0) - 5), y1 = Math.min(H - 1, Math.ceil(b.y1) + 5);
  const step = Math.max(1, Math.round((x1 - x0 + y1 - y0) / 400));
  for (let x = x0; x <= x1; x += step) for (const y of [y0, y0 + 1, y0 + 2, y1 - 2, y1 - 1, y1]) if (y >= 0 && y < H) ring.push(px(x, y));
  for (let y = y0; y <= y1; y += step) for (const x of [x0, x0 + 1, x0 + 2, x1 - 2, x1 - 1, x1]) if (x >= 0 && x < W) ring.push(px(x, y));
  const med = (k) => { const v = ring.map((c) => c[k]).sort((a, z) => a - z); return v.length ? v[v.length >> 1] : 255; };
  const bg = [med(0), med(1), med(2)];
  const inside = [];
  const ix0 = Math.max(0, Math.floor(b.x0)), ix1 = Math.min(W - 1, Math.ceil(b.x1)), iy0 = Math.max(0, Math.floor(b.y0)), iy1 = Math.min(H - 1, Math.ceil(b.y1));
  const st2 = Math.max(1, Math.round(Math.sqrt(((ix1 - ix0 + 1) * (iy1 - iy0 + 1)) / 20000)));
  for (let y = iy0; y <= iy1; y += st2) for (let x = ix0; x <= ix1; x += st2) { const c = px(x, y); inside.push([Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]), c]); }
  inside.sort((a, z) => z[0] - a[0]);
  const top = inside.slice(0, Math.max(1, Math.round(inside.length * 0.08))); // 가장 진한 8%(가장자리 흐린 픽셀은 빼야 회색으로 바래지 않는다)
  const fg = top.length && top[0][0] > 60 ? [0, 1, 2].map((k) => Math.round(top.reduce((s, t) => s + t[1][k], 0) / top.length)) : [0, 0, 0];
  return { bg, fg };
}

// ── 인식 결과 정리 ─────────────────────────────────────────────────────────
// 낱말 잇기: tesseract는 한글 낱말을 음절마다 따로 "낱말"로 주면서 줄 글(line.text)에는 진짜 띄어쓰기만 넣는다 →
// 줄 글에서 사이에 공백이 없는 낱말들을 하나로 합친다(상자는 합집합, 신뢰도는 글자 수 가중 평균). '개/인/정보' → '개인정보'
function joinWords(words, lineText) {
  const t = String(lineText || '');
  const out = [];
  let pos = 0;
  for (const w of words) {
    const text = String(w.text || '');
    const k = text ? t.indexOf(text, pos) : -1;
    const spaced = k < 0 || /\s/.test(t.slice(pos, k));
    if (k >= 0) pos = k + text.length;
    const prev = out[out.length - 1];
    if (!prev || spaced || !text) { out.push({ ...w, bbox: { ...w.bbox } }); continue; }
    const n0 = [...prev.text].length, n1 = [...text].length;
    prev.conf = (prev.conf * n0 + w.conf * n1) / (n0 + n1);
    prev.text += text;
    prev.bbox = { x0: Math.min(prev.bbox.x0, w.bbox.x0), y0: Math.min(prev.bbox.y0, w.bbox.y0), x1: Math.max(prev.bbox.x1, w.bbox.x1), y1: Math.max(prev.bbox.y1, w.bbox.y1) };
  }
  return out;
}
// 글자 수로 가중한 중앙값
function wmedian(words, f) {
  const rows = words.map((w) => [f(w), Math.max(1, [...w.text].length)]).sort((a, b) => a[0] - b[0]);
  const half = rows.reduce((s, r) => s + r[1], 0) / 2;
  let acc = 0;
  for (const [v, n] of rows) { acc += n; if (acc >= half) return v; }
  return rows.length ? rows[rows.length - 1][0] : 0;
}
const linesOf = (data) => (data.blocks || []).flatMap((b) => (b.paragraphs || []).flatMap((p) => p.lines || []));
const cleanText = (s) => String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
const HANGUL = /[ㄱ-ㆎ가-힣]/, LATIN = /[A-Za-z]/;
// 한국어+영어로 읽은 줄 중에 한국어만으로 다시 읽어 볼 줄: 신뢰도가 낮거나, 한글 줄에 영문 낱말이 섞였다
// (tessdata_fast의 kor+eng는 한글 낱말 몇 개를 'SAWS' 같은 영문으로 읽는 일이 있다 — 실측 2026-10-15 독서모임 안내문)
const needsKorRetry = (line) => line.confidence < 80 || (line.words.some((w) => HANGUL.test(w.text)) && line.words.some((w) => LATIN.test(w.text) && !HANGUL.test(w.text)));

// bmp(RGBA {w,h,stride,data})를 인식한다. rect(px {x,y,w,h})가 있으면 그 안만. 반환(좌표는 모두 bmp px):
//   { lines:[{ text, conf, quad:{bl,br,tl}, box:{x0,y0,x1,y1}, words:[{ text, conf, quad, box }], fg, bg }], text, confidence, angle(도), orientation(0·90·180·270), ms }
// 취소되면 null. opts: { langs, isCancelled, orientation:'auto'|0, colors:true }
async function recognize(bmp, opts = {}) {
  const t0 = Date.now();
  const langs = normLangs(opts.langs);
  const rect = opts.rect ? clampRect(opts.rect, bmp) : { x: 0, y: 0, w: bmp.w, h: bmp.h };
  if (!rect) throw Object.assign(new Error('인식할 영역이 쪽 밖에 있습니다'), { status: 400 });
  const base = toGray(bmp, rect);
  const isCancelled = opts.isCancelled || (() => false);
  const empty = { lines: [], text: '', confidence: 0, angle: 0, orientation: 0, ms: 0, langs };
  if (!hasInk(base)) return { ...empty, ms: Date.now() - t0 };
  // 1) 바로 읽기(기울기는 tesseract가 재서 바로 세운다 — rotateAuto)
  let k = 0, img = base;
  let data = await run(langs, PSM_PAGE, grayPng(img.g, img.w, img.h), { rotateAuto: true }, isCancelled);
  if (!data) return null;
  // 2) 잘 못 읽었으면(신뢰도×낱말 수 점수 70 미만) 방향을 의심한다: 반 크기로 네 방향을 읽어 점수가 15 이상 높은 방향으로 다시 읽는다(OSD 데이터 없이).
  //    실측(2026-10-15 안내문): 바로 선 쪽 85~94, 거꾸로 선 쪽도 엉터리 낱말을 많이 내며 51 — 그래서 문턱이 45면 180°를 놓쳤다
  const score = (d) => (d.confidence || 0) * Math.min(1, linesOf(d).reduce((n, l) => n + l.words.length, 0) / 8);
  if (opts.orientation !== 0 && score(data) < 70) {
    const small = halfGray(base);
    let best = { k: 0, s: -1 };
    for (const kk of [0, 1, 2, 3]) {
      const im = rotGray(small, kk);
      const d = await run(langs, PSM_PAGE, grayPng(im.g, im.w, im.h), {}, isCancelled);
      if (!d) return null;
      const s = score(d);
      if (s > best.s) best = { k: kk, s };
    }
    if (best.k && best.s >= score(data) + 15) {
      k = best.k; img = rotGray(base, k);
      data = await run(langs, PSM_PAGE, grayPng(img.g, img.w, img.h), { rotateAuto: true }, isCancelled);
      if (!data) return null;
    }
  }
  // 인식 좌표(바로 세운 그림) → 돌리기 전 회색조 그림 → bmp px. tesseract는 기울기 θ만큼 그림 가운데를 돌려 세운 좌표를 준다(실측: 3° 돌린 그림 → 원래 좌표)
  const th = Number(data.rotateRadians) || 0, cx = img.w / 2, cy = img.h / 2, cos = Math.cos(th), sin = Math.sin(th);
  const toBmp = (X, Y) => {
    const dx = X - cx, dy = Y - cy;
    const [ux, uy] = th ? [cx + dx * cos + dy * sin, cy - dx * sin + dy * cos] : [X, Y];
    const [gx, gy] = unrot(k, ux, uy, base.w, base.h);
    return [gx + rect.x, gy + rect.y];
  };
  const quadOf = (bb) => ({ bl: toBmp(bb.x0, bb.y1), br: toBmp(bb.x1, bb.y1), tl: toBmp(bb.x0, bb.y0), tr: toBmp(bb.x1, bb.y0) });
  const boxOf = (q) => { const xs = [q.bl[0], q.br[0], q.tl[0], q.tr[0]], ys = [q.bl[1], q.br[1], q.tl[1], q.tr[1]]; return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
  // 3) 한국어+영어면 의심스러운 줄을 한국어만으로 다시 읽어 신뢰도가 높으면 바꾼다(기울기를 세운 경우는 줄 그림을 다시 만들 수 없어 건너뛴다)
  const raw = linesOf(data).map((l) => ({ line: l, words: joinWords(l.words.map((w) => ({ text: w.text, conf: w.confidence, bbox: w.bbox })), l.text), conf: l.confidence }));
  if (langs.includes('kor') && langs.length > 1 && !th) {
    for (const r of raw) {
      if (!needsKorRetry(r.line)) continue;
      const pad = 6, bb = r.line.bbox;
      const x0 = Math.max(0, bb.x0 - pad), y0 = Math.max(0, bb.y0 - pad), x1 = Math.min(img.w, bb.x1 + pad), y1 = Math.min(img.h, bb.y1 + pad);
      if (x1 - x0 < 8 || y1 - y0 < 8) continue;
      const crop = Buffer.alloc((x1 - x0) * (y1 - y0));
      for (let y = y0; y < y1; y++) img.g.copy(crop, (y - y0) * (x1 - x0), y * img.w + x0, y * img.w + x1);
      const d = await run(['kor'], '7', grayPng(crop, x1 - x0, y1 - y0), {}, isCancelled);
      if (!d) return null;
      const alt = linesOf(d)[0];
      if (!alt || !(d.confidence > r.conf)) continue;
      r.words = joinWords(alt.words.map((w) => ({ text: w.text, conf: w.confidence, bbox: { x0: w.bbox.x0 + x0, y0: w.bbox.y0 + y0, x1: w.bbox.x1 + x0, y1: w.bbox.y1 + y0 } })), alt.text);
      r.conf = d.confidence; r.retried = true;
    }
  }
  const lines = [];
  for (const r of raw) {
    const words = r.words.map((w) => ({ ...w, text: cleanText(w.text) })).filter((w) => w.text && w.conf >= MIN_WORD_CONF);
    if (!words.length) continue;
    // 줄의 위·아래는 낱말 상자 위·아래끝의 (글자 수 가중) 중앙값 — tesseract가 낱말 하나를 아래 줄까지 크게 잡는 일이 있어(실측: 44px 줄에 94px 낱말) 합집합은 쓰지 않는다
    const bb = { x0: Math.min(...words.map((w) => w.bbox.x0)), y0: wmedian(words, (w) => w.bbox.y0), x1: Math.max(...words.map((w) => w.bbox.x1)), y1: wmedian(words, (w) => w.bbox.y1) };
    if (!(bb.y1 - bb.y0 >= 2)) continue;
    const quad = quadOf(bb), box = boxOf(quad);
    const line = { text: words.map((w) => w.text).join(' '), conf: Math.round(r.conf), quad, box,
      words: words.map((w) => { const q = quadOf(w.bbox); return { text: w.text, conf: Math.round(w.conf), quad: q, box: boxOf(q) }; }) };
    if (opts.colors !== false) Object.assign(line, lineColors(bmp, box));
    lines.push(line);
  }
  const conf = lines.length ? Math.round(lines.reduce((s, l) => s + l.conf * l.words.length, 0) / lines.reduce((s, l) => s + l.words.length, 0)) : 0;
  return { lines, text: lines.map((l) => l.text).join('\n'), confidence: conf, angle: Math.round(th * 18000 / Math.PI) / 100, orientation: k * 90, ms: Date.now() - t0, langs };
}
function clampRect(r, bmp) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(bmp.w, Math.ceil(r.x + r.w)), y1 = Math.min(bmp.h, Math.ceil(r.y + r.h));
  return x1 - x >= 4 && y1 - y >= 4 ? { x, y, w: x1 - x, h: y1 - y } : null;
}

// ── 쪽 좌표로 ──────────────────────────────────────────────────────────────
// 인식 결과(bmp px) → 엔진 addOcrLayers가 받는 줄 모양(쪽 좌표 pt). toPage(px 점 배열) → 쪽 점 배열.
//   줄: { text, o(줄 아래 왼쪽), u(글 방향 단위), v(위 방향 단위), w, h, words:[{ text, t0, t1 }](줄 방향 위치), fg, bg, conf }
//   글자 방향·위 방향은 줄 사각형의 세 모서리로 정한다 — 쪽 회전(/Rotate)·기울기를 그대로 따라간다
function toPageLines(lines, toPage) {
  const out = [];
  for (const l of lines) {
    const [o, br, tl] = toPage([l.quad.bl, l.quad.br, l.quad.tl]);
    const U = [br[0] - o[0], br[1] - o[1]], V = [tl[0] - o[0], tl[1] - o[1]];
    const w = Math.hypot(U[0], U[1]), h = Math.hypot(V[0], V[1]);
    if (!(w > 0.5 && h > 0.5)) continue;
    const u = [U[0] / w, U[1] / w];
    let v = [V[0] / h, V[1] / h];
    const dot = v[0] * u[0] + v[1] * u[1]; v = [v[0] - dot * u[0], v[1] - dot * u[1]]; const vn = Math.hypot(v[0], v[1]) || 1; v = [v[0] / vn, v[1] / vn]; // u에 수직으로
    const words = [];
    for (const wd of l.words) {
      const [a, b] = toPage([wd.quad.bl, wd.quad.br]);
      const t0 = (a[0] - o[0]) * u[0] + (a[1] - o[1]) * u[1], t1 = (b[0] - o[0]) * u[0] + (b[1] - o[1]) * u[1];
      if (t1 - t0 > 0.2) words.push({ text: wd.text, t0, t1, conf: wd.conf });
    }
    if (words.length) out.push({ text: words.map((x) => x.text).join(' '), o, u, v, w, h, words, conf: l.conf, ...(l.fg ? { fg: l.fg, bg: l.bg } : {}) });
  }
  return out;
}

module.exports = { LANGS, DEFAULT_LANGS, DATA_DIR, WORKER_PATH, ENGINE, DATA_SOURCE, normLangs, verifyLang, status, workerOptions, recognize, toPageLines, shutdown,
  _test: { tesseract, lastThread: () => lastSpawned, joinWords, grayPng, toGray, rotGray, unrot, halfGray, lineColors, needsKorRetry, run, pool, unpacked } };
