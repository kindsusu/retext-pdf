// v6 Wave E2: 글자 인식(OCR) 작업 스레드의 입구. tesseract.js의 Node 작업 스크립트를 부르기 전에 이 스레드의 네트워크 길을 모두 막는다.
// 인식 데이터·엔진(WASM)은 앱에 들어 있는 파일만 읽는다(pdf-ocr.js가 langPath를 앱 안 폴더로 준다). 설정이 잘못돼 CDN 주소로 가려 해도
// 여기서 바로 실패한다 — 문서 그림이 PC 밖으로 나갈 길이 없다. 시험(pdf-ocr.test.js)이 실제로 주소를 줘서 막히는지 확인한다
'use strict';
const BLOCKED = 'OCR 작업은 네트워크를 쓰지 않습니다';
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

// WASM 중단(메모리 부족·데이터 손상) 같은 잡히지 않은 오류: 하던 작업을 실패로 돌려보내고 이 스레드를 끝낸다.
// 그냥 두면 부모(서버)가 처리하지 않은 'error' 이벤트로 죽을 수 있다(pdf-ocr.js도 따로 막는다)
const { parentPort } = require('worker_threads');
let last = null;
parentPort.on('message', (packet) => { last = packet; }); // tesseract 처리기보다 먼저 등록 — 지금 하는 작업을 기억한다
const fail = (e) => {
  try { if (last) parentPort.postMessage({ workerId: last.workerId, jobId: last.jobId, action: last.action, status: 'reject', data: `글자 인식 엔진 오류: ${(e && e.message) || e}` }); } catch {}
  setTimeout(() => process.exit(1), 20);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

// tesseract.js의 Node 작업 스크립트(같은 node_modules에서 찾는다 — 설치본에서는 app.asar.unpacked 안)
require('tesseract.js/src/worker-script/node/index.js');
