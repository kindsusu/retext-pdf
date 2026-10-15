// v6 Wave F: 한국어·영어 맞춤법 검사(오프라인). 문서 글은 PC 밖으로 나가지 않는다.
//   · 엔진: Hunspell 1.7 WebAssembly(npm hunspell-wasm 0.3.0, MPL-1.1/GPL-2.0/LGPL-2.1) — 작업 스레드 app/spell-worker.js(네트워크를 막는다)에서 돈다
//   · 사전: 한국어 hunspell-dict-ko 0.1.0(= spellcheck-ko/hunspell-dict-ko 0.6.1, MPL-1.1/GPL-2.0/LGPL-2.1 + 낱말 CC-BY-4.0)
//           영어 dictionary-en 4.0.0(SCOWL en_US 2020.12.07, MIT AND BSD). 처음 쓸 때 크기·SHA-256을 확인한다(바뀐 파일로는 검사하지 않는다)
//     더 새 한국어 사전(dictionary-ko 2.0.0 = 0.7.94)은 만든 파일이 GPL-3.0이라 쓰지 않았다(THIRD-PARTY-NOTICES.md)
//   · 사용자 사전: $RETEXTPDF_DATA/spell-user-dict.json({ words:[…] }) — [사전에 추가]한 낱말. [무시]는 이번 실행에서만(메모리)
//   · 문서 검사(scanDoc): 화면 상자와 같은 줄(groupLines mergeStyledRuns)의 표시 글을 낱말로 나눠 검사한다 — 찾아 바꾸기와 같은 줄 번호라
//     고치기(applyFixes)가 조각별 편집(editRuns — 글자 모양 보존)으로 그 자리만 바꾼다
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('./spell-core');

const unpacked = (p) => p.replace(/([\\/])app\.asar(?=[\\/])/i, '$1app.asar.unpacked');
// 꾸러미 폴더: dictionary-en처럼 exports가 package.json을 감춘 꾸러미도 있어 node_modules 자리를 직접 찾는다
function pkgDir(name) {
  for (const dir of require.resolve.paths(name) || []) {
    const p = path.join(dir, name);
    if (fs.existsSync(path.join(unpacked(p), 'package.json'))) return unpacked(p);
  }
  throw Object.assign(new Error(`${name} 꾸러미가 없습니다`), { code: 'MODULE_NOT_FOUND' });
}
const ENGINE_PKG = 'hunspell-wasm', ENGINE = 'Hunspell (hunspell-wasm 0.3.0, WebAssembly)';
const DICTS = {
  ko: { label: '한국어', pkg: 'hunspell-dict-ko', version: '0.1.0 (hunspell-dict-ko 0.6.1)', aff: 'ko.aff', dic: 'ko.dic',
    bytes: { aff: 5786653, dic: 11128599 }, sha256: { aff: 'de5c54d313dbbf781a8b521129ca3ec3e0fa128263aeefd2f31e339a85a9f53e', dic: '7ae3b3ca5ea1b344129d2e425c46e77fc36dc353c2afe8fb0f4b5093ff92d873' } },
  en: { label: '영어', pkg: 'dictionary-en', version: '4.0.0 (SCOWL en_US 2020.12.07)', aff: 'index.aff', dic: 'index.dic',
    bytes: { aff: 3086, dic: 551762 }, sha256: { aff: '8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b', dic: 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647' } },
};
const WORKER_PATH = unpacked(path.join(__dirname, 'spell-worker.js'));
const IDLE_MS = 10 * 60 * 1000;  // 10분 쓰지 않으면 작업 스레드를 끝낸다(사전 메모리 약 80MB 반환)
const SUGGEST_LIMIT = 6;

// ── 사전 파일 확인 ──────────────────────────────────────────────────────────
const verified = new Map(); // lang → { aff, dic } | Error
function dictFiles(lang) {
  if (verified.has(lang)) { const v = verified.get(lang); if (v instanceof Error) throw v; return v; }
  const d = DICTS[lang];
  let out;
  try {
    const dir = pkgDir(d.pkg);
    out = { aff: path.join(dir, d.aff), dic: path.join(dir, d.dic) };
    for (const k of ['aff', 'dic']) {
      const buf = fs.readFileSync(out[k]);
      if (buf.length !== d.bytes[k]) throw new Error(`맞춤법 사전(${d.label})의 크기가 다릅니다 — 앱을 다시 설치하세요`);
      if (crypto.createHash('sha256').update(buf).digest('hex') !== d.sha256[k]) throw new Error(`맞춤법 사전(${d.label})이 손상됐습니다 — 앱을 다시 설치하세요`);
    }
  } catch (e) { out = e.code ? new Error(`맞춤법 사전(${d.label})을 찾을 수 없습니다 — 앱을 다시 설치하세요 (${e.code})`) : e; }
  verified.set(lang, out);
  if (out instanceof Error) throw out;
  return out;
}
function enginePath() { return unpacked(require.resolve(ENGINE_PKG)); }
function status() {
  const langs = Object.entries(DICTS).map(([code, d]) => {
    let ok = true, error = null;
    try { dictFiles(code); } catch (e) { ok = false; error = e.message; }
    return { code, label: d.label, version: d.version, ok, ...(error ? { error } : {}) };
  });
  let engineOk = true;
  try { enginePath(); } catch { engineOk = false; }
  return { available: engineOk && langs.some((l) => l.ok) && fs.existsSync(WORKER_PATH), engine: ENGINE, langs, userWords: userDict().length, running: !!thread };
}

// ── 사용자 사전·무시 ─────────────────────────────────────────────────────────
const dictPath = () => path.join(process.env.RETEXTPDF_DATA || path.join(os.homedir(), '.retext-pdf-data'), 'spell-user-dict.json');
let userWords = null;
const ignored = new Set(); // 이번 실행에서 무시할 낱말
function userDict() {
  if (!userWords) {
    try { userWords = (JSON.parse(fs.readFileSync(dictPath(), 'utf8')).words || []).map(core.normWord).filter(Boolean); } catch { userWords = []; }
  }
  return userWords;
}
function saveUserDict() {
  fs.mkdirSync(path.dirname(dictPath()), { recursive: true });
  const tmp = dictPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, words: userDict() }, null, 1));
  fs.renameSync(tmp, dictPath());
}
const langOf = (w) => (/[가-힣]/.test(w) ? 'ko' : 'en');
async function addWords(words) {
  const list = [].concat(words || []).map(core.normWord).filter(Boolean);
  if (!list.length) throw Object.assign(new Error('사전에 넣을 낱말을 주세요'), { status: 400 });
  const have = new Set(userDict()), fresh = list.filter((w) => !have.has(w));
  userWords.push(...fresh); saveUserDict();
  for (const w of list) cache.delete(w);
  if (thread) await call({ op: 'add', words: fresh.map((w) => [w, langOf(w)]) });
  return { ok: true, added: fresh, words: userDict().slice() };
}
async function removeWords(words) {
  const list = new Set([].concat(words || []).map(core.normWord).filter(Boolean));
  userWords = userDict().filter((w) => !list.has(w)); saveUserDict();
  for (const w of list) cache.delete(w);
  if (thread) await call({ op: 'remove', words: [...list].map((w) => [w, langOf(w)]) });
  return { ok: true, words: userDict().slice() };
}
function ignore(words) { for (const w of [].concat(words || []).map(core.normWord).filter(Boolean)) ignored.add(w); return { ok: true, ignored: [...ignored] }; }

// ── 작업 스레드 ────────────────────────────────────────────────────────────
let thread = null, starting = null, idleTimer = null, seq = 0;
const waiting = new Map(); // id → { resolve, reject }
function touch() { clearTimeout(idleTimer); idleTimer = setTimeout(() => shutdown(), IDLE_MS); idleTimer.unref?.(); }
function start() {
  if (thread) return Promise.resolve(thread);
  if (starting) return starting;
  const p = new Promise((resolve, reject) => {
    const langs = {};
    for (const code of Object.keys(DICTS)) { try { langs[code] = dictFiles(code); } catch (e) { if (code === 'ko') { reject(e); return; } } }
    const { Worker } = require('worker_threads');
    const t0 = Date.now();
    const w = new Worker(WORKER_PATH, { workerData: { engine: enginePath(), dicts: langs, userWords: userDict().map((x) => [x, langOf(x)]) } });
    const fail = (e) => {
      for (const p of waiting.values()) p.reject(e);
      waiting.clear();
      if (thread === w) thread = null;
      starting = null;
      reject(e);
    };
    w.on('message', (m) => {
      if (m.ready) { thread = w; starting = null; loadMs = Date.now() - t0; if (!waiting.size) w.unref(); touch(); resolve(w); return; }
      if (m.fatal) { fail(new Error(`맞춤법 검사 엔진을 시작하지 못했습니다: ${m.fatal}`)); return; }
      const q = waiting.get(m.id); if (!q) return;
      waiting.delete(m.id);
      if (!waiting.size) w.unref(); // 기다리는 요청이 없으면 이 스레드가 프로세스를 붙잡지 않는다(시험·종료)
      if (m.error) q.reject(new Error(m.error)); else q.resolve(m);
    });
    w.on('error', (e) => fail(new Error(`맞춤법 검사 엔진 오류: ${e.message}`)));
    w.on('exit', () => { if (thread === w) thread = null; if (waiting.size) fail(new Error('맞춤법 검사 엔진이 멈췄습니다 — 다시 시도하세요')); });
  });
  starting = p;
  p.catch(() => { if (starting === p) starting = null; }); // 실패한 시작은 기억하지 않는다(다음 요청이 다시 시도)
  return p;
}
let loadMs = 0;
async function call(msg) {
  const w = await start();
  touch();
  return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); w.ref(); w.postMessage({ ...msg, id }); });
}
async function shutdown() { clearTimeout(idleTimer); const w = thread; thread = null; starting = null; if (w) await w.terminate(); }

// ── 낱말 검사 ──────────────────────────────────────────────────────────────
const cache = new Map(); // 낱말 → 맞음(사용자 사전·무시 반영 전 사전 판정)
const CACHE_MAX = 50000;
// words: ['낱말' …] 또는 [{ word, lang }] → 같은 순서로 { word, lang, ok }
async function check(words) {
  const list = [].concat(words || []).map((x) => (typeof x === 'string' ? { word: x, lang: langOf(x) } : { word: String(x.word || ''), lang: x.lang || langOf(String(x.word || '')) }));
  const users = new Set(userDict());
  const need = [...new Set(list.filter((x) => x.word && !users.has(x.word) && !ignored.has(x.word) && !cache.has(x.word)).map((x) => x.word))];
  if (need.length) {
    const r = await call({ op: 'check', words: need.map((w) => [w, langOf(w)]) });
    if (cache.size + need.length > CACHE_MAX) cache.clear();
    need.forEach((w, k) => cache.set(w, !!r.results[k]));
  }
  return list.map((x) => ({ word: x.word, lang: x.lang, ok: !x.word || users.has(x.word) || ignored.has(x.word) || cache.get(x.word) !== false }));
}
async function suggest(word, limit = SUGGEST_LIMIT) {
  const w = core.normWord(word);
  if (!w) return [];
  return (await call({ op: 'suggest', word: w, lang: langOf(w), limit })).suggestions || [];
}
// 글 하나 검사(쪽 위 편집기): 틀린 낱말의 [{ at, len, word }]
async function checkText(text) {
  const toks = core.checkable(text);
  const res = await check(toks.map((t) => ({ word: t.word, lang: t.lang })));
  return toks.filter((t, k) => !res[k].ok).map((t) => ({ at: t.at, len: t.len, word: t.word }));
}

// ── 문서 검사 · 고치기 ──────────────────────────────────────────────────────
const SHY_RE = /­/g;
const MASK = '■';
const mergedLines = (objs) => require('./text-grouping').groupLines(objs, { mergeStyledRuns: true });
// 낱말의 쪽 위 사각형(글자 위치로) — 화면이 고를 때 칠한다(찾아 바꾸기 matchRect와 같은 계산)
function wordRect(line, at, len) {
  const raw = line.text, d2r = [];
  for (let r = 0; r < raw.length; r++) if (raw[r] !== '­') d2r.push(r);
  d2r.push(raw.length);
  const a = d2r[at], b = d2r[at + len] ?? raw.length;
  let off = 0, box = null;
  line.objs.forEach((o, j) => {
    const s = off, e = off + o.text.length; off = e + (line.seps[j] || '').length;
    const lo = Math.max(a, s), hi = Math.min(b, e);
    if (lo >= hi) return;
    const g = o.glyphs?.length === o.text.length ? o.glyphs : null;
    const x0 = g ? g[lo - s][0] : o.bounds.x0, x1 = g ? g[hi - s - 1][0] + g[hi - s - 1][2] : o.bounds.x1;
    const r = { x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: o.bounds.y0, y1: o.bounds.y1 };
    box = box ? { x0: Math.min(box.x0, r.x0), y0: Math.min(box.y0, r.y0), x1: Math.max(box.x1, r.x1), y1: Math.max(box.y1, r.y1) } : r;
  });
  return box;
}
// 문서 전체 검사: [{ i, line, at, len, word, lineText, context, rect, editable, reason, suggestions? }]
//   · 보이지 않는 글자(그림 위 OCR 검색용 층)는 검사하지 않는다 — 고칠 수도 없고 인식 실수가 대부분이다
//   · 제안은 처음 suggestFirst개 낱말만 미리 구한다(한국어 제안은 낱말마다 수십 ms) — 나머지는 화면이 고를 때 /api/spell/suggest로
async function scanDoc(doc, { pages = null, suggestFirst = 40, limit = 1000 } = {}) {
  const fr = require('./find-replace');
  const t0 = Date.now(), rows = [];
  let lines = 0, words = 0;
  for (const i of pages || Array.from({ length: doc.pageCount }, (_, k) => k)) {
    mergedLines(doc.objects(i)).forEach((line, k) => {
      if (line.objs.every((o) => o.hidden)) return;
      lines++;
      const disp = line.text.replace(SHY_RE, ''), block = fr.editBlock(line);
      for (const t of core.checkable(disp)) { words++; rows.push({ i, line: k, at: t.at, len: t.len, word: t.word, lang: t.lang, lineText: line.text, disp, block, l: line }); }
    });
  }
  const res = await check(rows.map((r) => ({ word: r.word, lang: r.lang })));
  const issues = [];
  rows.forEach((r, k) => {
    if (res[k].ok || issues.length >= limit) return;
    const masked = r.disp.slice(r.at, r.at + r.len).includes(MASK);
    issues.push({ i: r.i, line: r.line, at: r.at, len: r.len, word: r.word, lang: r.lang, lineText: r.lineText, context: require('./find-replace').context(r.disp, r.at, r.len, 16),
      rect: wordRect(r.l, r.at, r.len), editable: !r.block && !masked, reason: masked ? '가린 자리' : r.block || null });
  });
  const uniq = [...new Set(issues.map((x) => x.word))], sugs = new Map();
  for (const w of uniq.slice(0, suggestFirst)) { if (Date.now() - t0 > 4000) break; sugs.set(w, await suggest(w)); }
  for (const x of issues) if (sugs.has(x.word)) x.suggestions = sugs.get(x.word);
  return { issues, lines, words, unique: uniq.length, truncated: issues.length >= limit, ms: Date.now() - t0 };
}
// 고치기: fixes [{ i, line, at, len, word, lineText, replacement }] — 같은 줄의 여러 고침은 한 번에(조각별 편집 한 번), 쪽 안에서는 아래 줄부터.
// 고칠 자리가 그새 바뀌었으면 409. 반환 { count, pages, written: { [i]: [{ idx, text }] } } — 서버가 한 트랜잭션(실행 취소 한 번)으로 감싼다
function applyFixes(doc, fixes) {
  const { editRuns, syncDecoAfter } = require('./pdf-edit-service');
  const fr = require('./find-replace');
  const list = [].concat(fixes || []);
  if (!list.length) throw Object.assign(new Error('고칠 낱말이 없습니다'), { status: 400 });
  for (const f of list) {
    if (!Number.isInteger(f.i) || f.i < 0 || f.i >= doc.pageCount) throw Object.assign(new Error('쪽 번호가 잘못됐습니다.'), { status: 400 });
    if (typeof f.replacement !== 'string' || !f.replacement || f.replacement.length > 200 || /[\r\n]/.test(f.replacement)) throw Object.assign(new Error('바꿀 말은 한 줄(200자 이하)로 넣으세요.'), { status: 400 });
  }
  const runLineOf = (line) => ({ objs: line.objs.map((o) => ({ idx: o.idx, text: o.text, ...(o.partFrom != null ? { from: o.partFrom, to: o.partFrom + o.text.length } : {}) })), seps: line.seps });
  const written = {}, pages = new Set();
  let count = 0;
  const byPage = new Map();
  for (const f of list) { if (!byPage.has(f.i)) byPage.set(f.i, []); byPage.get(f.i).push(f); }
  for (const [i, fs0] of byPage) {
    // 줄마다 묶는다(줄 번호 + 줄 글로 찾은 자리). 아래 줄부터 고쳐야 위 줄의 번호·같은 글 순서가 흔들리지 않는다
    const lines0 = mergedLines(doc.objects(i));
    const groups = new Map();
    for (const f of fs0) {
      const k = Number.isInteger(f.line) && lines0[f.line]?.text === f.lineText ? f.line : lines0.findIndex((L) => L.text === f.lineText);
      if (k < 0) throw Object.assign(new Error('문서가 바뀌었습니다. 다시 검사하세요.'), { status: 409 });
      const disp = lines0[k].text.replace(SHY_RE, '');
      if (disp.slice(f.at, f.at + f.len) !== f.word) throw Object.assign(new Error('문서가 바뀌었습니다. 다시 검사하세요.'), { status: 409 });
      const block = fr.editBlock(lines0[k]);
      if (block) throw Object.assign(new Error(`이 자리는 고칠 수 없습니다(${block}).`), { status: 400 });
      if (!groups.has(k)) groups.set(k, { k, lineText: lines0[k].text, nth: lines0.slice(0, k).filter((L) => L.text === lines0[k].text).length, fixes: [] });
      groups.get(k).fixes.push(f);
    }
    for (const g of [...groups.values()].sort((a, b) => b.k - a.k)) {
      const lines = mergedLines(doc.objects(i));
      const same = lines.map((L, k) => (L.text === g.lineText ? k : -1)).filter((k) => k >= 0);
      const k = same.includes(g.k) ? g.k : same[Math.min(g.nth, same.length - 1)];
      if (k == null) throw Object.assign(new Error('문서가 바뀌었습니다. 다시 검사하세요.'), { status: 409 });
      const line = lines[k], disp = line.text.replace(SHY_RE, '');
      // 겹치지 않게 뒤에서부터 바꾼다
      let newText = disp, last = Infinity;
      for (const f of [...g.fixes].sort((a, b) => b.at - a.at)) {
        if (f.at + f.len > last) continue;
        newText = newText.slice(0, f.at) + f.replacement + newText.slice(f.at + f.len);
        last = f.at; count++;
      }
      const r = editRuns(doc, i, { lines: [runLineOf(line)], oldText: line.text, newText, mode: 'none' });
      const gone = r.removed || [];
      const kept = (written[i] || []).filter((w) => !gone.includes(w.idx)).map((w) => ({ ...w, idx: w.idx - gone.filter((x) => x < w.idx).length }));
      written[i] = [...kept, ...(r.written || [])];
      pages.add(i);
    }
  }
  for (const i of pages) written[i] = syncDecoAfter(doc, i, { written: written[i] || [] }).written;
  return { count, pages: [...pages], written };
}

module.exports = { status, check, checkText, suggest, scanDoc, applyFixes, addWords, removeWords, ignore, userDict: () => userDict().slice(), shutdown,
  _test: { unpacked, dictPath, start, call, loadMs: () => loadMs, wordRect, clearCache: () => cache.clear(), resetIgnored: () => ignored.clear(), reloadUserDict: () => { userWords = null; } } };
