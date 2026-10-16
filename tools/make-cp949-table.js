// app/cp949.bin 만들기: CP949(windows-949, WHATWG 'euc-kr') 두 바이트 → 글자 표.
// 실행: npx electron tools/make-cp949-table.js  (또는 ELECTRON_RUN_AS_NODE=1 electron tools/make-cp949-table.js)
//
// 왜 Electron인가: Node의 TextDecoder('euc-kr')는 ICU의 EUC-KR(KS X 1001, 8,412자)이라 확장 완성형(UHC — 똠·갂 등 8,636자)을
// 풀지 못하고, Electron(Chromium)의 것은 WHATWG 표준 windows-949(17,048자)다(실측 2026-10-16: Node 24.18 8,412 / Electron 44.1 17,048).
// 실행 환경마다 결과가 달라지지 않게 표를 파일로 두고 text-codec.js가 직접 읽는다.
// 형식: 포인터((앞 − 0x81) × 190 + (뒤 − 0x41), 앞 0x81~0xFE · 뒤 0x41~0xFE)마다 UTF-16 코드 단위(uint16 LE), 없는 칸은 0
const fs = require('fs');
const path = require('path');
const dec = new TextDecoder('euc-kr');
const out = Buffer.alloc(126 * 190 * 2);
let n = 0;
for (let lead = 0x81; lead <= 0xfe; lead++) {
  for (let trail = 0x41; trail <= 0xfe; trail++) {
    const s = dec.decode(Buffer.from([lead, trail]));
    if (s.length !== 1 || s === '�') continue;
    out.writeUInt16LE(s.charCodeAt(0), ((lead - 0x81) * 190 + (trail - 0x41)) * 2);
    n++;
  }
}
if (n < 17000) { console.error(`이 실행 환경의 euc-kr 디코더는 ${n}자만 압니다 — Electron으로 실행하세요`); process.exit(1); }
fs.writeFileSync(path.join(__dirname, '..', 'app', 'cp949.bin'), out);
console.log(`app/cp949.bin: ${n}자 (${out.length} 바이트)`);
if (process.versions.electron && require('electron').app) require('electron').app.quit();
