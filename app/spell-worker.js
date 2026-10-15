// v6 Wave F: 맞춤법 검사 작업 스레드. Hunspell(WebAssembly, hunspell-wasm)과 사전(한국어 hunspell-dict-ko · 영어 dictionary-en)을
// 이 스레드에 올려 두고 낱말을 검사한다 — 서버의 이벤트 루프를 막지 않는다(사전 읽기 0.4~0.6초, 한국어 제안은 낱말마다 수십 ms).
// 글자 인식 스레드(ocr-worker.js)처럼 시작하자마자 네트워크 길을 모두 막는다. 사전·엔진은 앱 안 파일만 읽는다(spell-check.js가 경로를 준다)
'use strict';
const BLOCKED = '맞춤법 검사는 네트워크를 쓰지 않습니다';
const block = (what) => function blocked() { throw new Error(`${BLOCKED} (${what} 차단)`); };
globalThis.fetch = async (url) => { throw new Error(`${BLOCKED} (fetch 차단: ${String(url).slice(0, 80)})`); };
for (const name of ['http', 'https']) {
  const mod = require(name);
  mod.request = block(`${name}.request`); mod.get = block(`${name}.get`);
}
const net = require('net');
net.connect = net.createConnection = block('net.connect');
net.Socket.prototype.connect = block('net.Socket.connect');
const tls = require('tls');
tls.connect = block('tls.connect');
const dns = require('dns');
dns.lookup = block('dns.lookup'); dns.resolve = block('dns.resolve');
if (dns.promises) { dns.promises.lookup = block('dns.promises.lookup'); dns.promises.resolve = block('dns.promises.resolve'); }

const fs = require('fs');
const { pathToFileURL } = require('url');
const { parentPort, workerData } = require('worker_threads');
const core = require('./spell-core');

const dicts = {}; // lang → Hunspell
const reply = (id, data) => parentPort.postMessage({ id, ...data });
// 한 낱말이 맞는가: 사전 → (한국어) 합성어 나눔. 늘 틀린 꼴(됬·몇일…)은 사전이 맞다고 해도 틀림
function spellOk(word, lang) {
  const h = dicts[lang];
  if (!h) return true; // 그 언어 사전이 없으면 검사하지 않는다
  if (core.alwaysWrong(word)) return false;
  if (h.testSpelling(word)) return true;
  return lang === 'ko' && core.compoundOk(word, (w) => h.testSpelling(w));
}
function handle(m) {
  try {
    if (m.op === 'check') return reply(m.id, { results: (m.words || []).map(([w, lang]) => spellOk(w, lang)) });
    if (m.op === 'suggest') {
      const h = dicts[m.lang];
      const t0 = Date.now(), sugs = h ? h.getSpellingSuggestions(m.word) : [];
      return reply(m.id, { suggestions: core.mergeSuggestions(m.word, sugs, m.limit || 6), ms: Date.now() - t0 });
    }
    if (m.op === 'add') { for (const [w, lang] of m.words || []) dicts[lang]?.addWord(w); return reply(m.id, { ok: true }); }
    if (m.op === 'remove') { for (const [w, lang] of m.words || []) dicts[lang]?.removeWord(w); return reply(m.id, { ok: true }); }
    // 시험용: 이 스레드에서 주소로 나가 보기 — 막혀 있으면 우리 차단 메시지로 실패한다
    if (m.op === 'netprobe') return fetch(m.url || 'https://example.invalid/').then(() => reply(m.id, { error: '네트워크가 열려 있습니다' }), (e) => reply(m.id, { blocked: String(e.message) }));
    reply(m.id, { error: `알 수 없는 요청: ${m.op}` });
  } catch (e) { reply(m.id, { error: (e && e.message) || String(e) }); }
}

(async () => {
  const t0 = Date.now();
  const { createHunspellFromStrings } = await import(pathToFileURL(workerData.engine).href);
  for (const [lang, d] of Object.entries(workerData.dicts || {})) {
    dicts[lang] = await createHunspellFromStrings(fs.readFileSync(d.aff, 'utf8'), fs.readFileSync(d.dic, 'utf8'));
  }
  for (const [w, lang] of workerData.userWords || []) dicts[lang]?.addWord(w);
  parentPort.on('message', handle);
  parentPort.postMessage({ ready: true, ms: Date.now() - t0, langs: Object.keys(dicts) });
})().catch((e) => { parentPort.postMessage({ fatal: (e && e.message) || String(e) }); setTimeout(() => process.exit(1), 20); });
