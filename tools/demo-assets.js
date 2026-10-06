// README용 실제 렌더 이미지 생성: 편집·가리기 전/후 (워크스페이스의 가상 안내문 PDF 사용)
// node tools/demo-assets.js  → assets/edit-before.png, assets/edit-after.png
// 예시 문서는 회사 문서처럼 보이지 않도록 「10월 독서 모임 안내」를 쓴다(2026-10-06, 이전 예시는 가상 회의록이었다).
// 앱과 같은 경로로 고친다: 줄 묶기(groupLines) → 첫 조각에 줄 전체 + 나머지 조각 지우기(applyEdits),
// 가리기는 /api/pdf/mask와 같은 maskParts(글자 제거 + 줄마다 고른 덮개 하나)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { open } = require('../app/pdf-engine');
const { groupLines } = require('../app/text-grouping');
const { applyEdits, maskParts } = require('../app/pdf-edit-service');

const SRC = path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf');
const OUT = path.join(__dirname, '..', 'assets');
const SCALE = 2, CROP_TOP = 0.055, CROP_H = 0.3; // 위 여백을 빼고 제목·일시·장소·문의·이번 달 책까지만

function png(rgba, w, h, stride) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * stride, y * stride + w * 4); }
  const crc = (b) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
async function shot(doc, file) {
  const r = doc._renderRaw(0, SCALE);
  const top = Math.round(r.h * CROP_TOP), h = Math.round(r.h * CROP_H);
  fs.writeFileSync(path.join(OUT, file), png(r.data.subarray(top * r.stride), r.w, h, r.stride));
  console.log(file, r.w + 'x' + h);
}
const lineStarting = (doc, prefix) => {
  const line = groupLines(doc.objects(0)).find((l) => l.text.startsWith(prefix));
  if (!line) throw new Error(`줄을 찾지 못했습니다: ${prefix}`);
  return line;
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const doc = await open(fs.readFileSync(SRC));
  await shot(doc, 'edit-before.png');

  // 1) 날짜 고치기: "10월 17일" → "10월 24일" (앱의 줄 편집과 같이 첫 조각이 줄 전체를 받고 나머지 조각은 지운다)
  const when = lineStarting(doc, '일시:');
  const [first, ...rest] = when.objs;
  applyEdits(doc, 0, [{ idx: first.idx, text: when.text.replace('10월 17일', '10월 24일') }], { primary: first.idx, remove: rest.map((o) => o.idx) });

  // 2) 연락처 가리기: "010-1234-5678"을 글자에서 지우고 검은 사각형으로 덮는다(UI의 [선택 글자 가리기]와 같은 절차)
  const ask = lineStarting(doc, '문의:');
  const from = ask.text.indexOf('010-'), to = from + '010-1234-5678'.length;
  let off = 0; const parts = [];
  ask.objs.forEach((o, j) => {
    const s = off, e = off + o.text.length; off = e + (ask.seps[j] || '').length;
    const a = Math.max(from, s), b = Math.min(to, e);
    if (a < b) parts.push({ idx: o.idx, from: a - s, to: b - s });
  });
  const masked = maskParts(doc, 0, parts);
  if (!masked.ok || masked.skipped.length) throw new Error(`가리지 못했습니다(${JSON.stringify(masked.skipped)})`);
  const text = doc.pageText(0);
  console.log('edited:', text.includes('10월 24일'), '| phone left in text:', text.includes('010-1234-5678') || text.includes('1234'), '| covers:', masked.rects.length);
  await shot(doc, 'edit-after.png');
  doc.close();
})().catch((e) => { console.error(e); process.exitCode = 1; });
