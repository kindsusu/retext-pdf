// 글자 인식(OCR) 말뭉치 검사 — npm test보다 오래 걸려(1~2분) 따로 돌린다: npm run test:ocr
// 글자가 있는 PDF를 그림 PDF로 만든 뒤(기존 이미지 PDF 경로) 다시 읽어, 원래 글자(pageText)와 얼마나 같은지 잰다.
//   1) 동봉 안내문(workspace/독서모임_안내.pdf)을 150·300dpi 그림으로 → 인식 → 비슷함·시간
//   2) 줄 묶기 말뭉치(app/test-data/grouping/*.pdf 14개 — 문단·양쪽 정렬·첨자·표·두 단·회전 등) 200dpi → 인식 → 비슷함
//   3) 방향: 안내문 그림을 90°·180° 돌린 쪽 → 방향을 알아보고 읽는가
// 홈 폴더는 저장소 tmp\ 아래 임시 폴더로 돌린다. 서버·포트를 쓰지 않는다. 문서를 PC 밖으로 보내지 않는다(앱 안 tesseract)
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(ROOT, 'tmp', 'ocr-corpus-'));
process.env.HOME = process.env.USERPROFILE = TMP;
const OCR = require('../app/pdf-ocr');
const { open } = require('../app/pdf-engine');
const { buildPdf } = require('../app/pdf-test-fixtures');

function similarity(a, b) {
  a = [...String(a).replace(/\s+/g, '')]; b = [...String(b).replace(/\s+/g, '')];
  if (!a.length && !b.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, k) => k);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
const rasterize = async (bytes, dpi) => { const d = await open(bytes); const r = d.rasterizer(); for (let i = 0; i < d.pageCount; i++) r.addPage(i, dpi, 0.85); const out = r.finish(); r.close(); d.close(); return out; };
// 그림 PDF 한 쪽을 인식해 쪽 글로(서버 /api/pdf/ocr와 같은 길: 300dpi → 인식 → 보이지 않는 글자 → 글자 추출)
async function ocrText(bytes, i = 0) {
  const d = await open(bytes);
  const s = 300 / 72, bmp = d._renderRaw(i, s);
  const r = await OCR.recognize(bmp, { langs: ['kor', 'eng'] });
  d.addOcrLayers([{ i, lines: OCR.toPageLines(r.lines, (pts) => d.pixelToPage(i, s, pts)) }], { mode: 'search' });
  if (r.orientation) d.rotatePages([i], r.orientation); // 서버와 같다: 옆으로·거꾸로 스캔한 쪽은 바로 서게 돌린다
  const text = d.pageText(i);
  d.close();
  return { r, text };
}
// 쪽을 그린 픽셀을 시계 방향 90°×k 돌려 그림 하나만 든 쪽으로
async function rotatedScan(bytes, k, dpi = 200) {
  const d = await open(bytes);
  const raw = d._renderRaw(0, dpi / 72), { w: pw, h: ph } = d.pageSize(0);
  d.close();
  const w = raw.w, h = raw.h, W = k % 2 ? h : w, H = k % 2 ? w : h, out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = k === 1 ? [h - 1 - y, x] : k === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
    raw.data.copy(out, (Y * W + X) * 4, y * raw.stride + x * 4, y * raw.stride + x * 4 + 4);
  }
  const PW = k % 2 ? ph : pw, PH = k % 2 ? pw : ph;
  const e = await open(buildPdf({ pages: [{ w: PW, h: PH, content: '' }] }));
  e.insertImage(0, { kind: 'rgba', data: out, width: W, height: H, quality: 90 }, { x: 0, y: 0, w: PW, h: PH });
  const b = e.save(); e.close();
  return b;
}

(async () => {
  const T0 = Date.now(), rows = [], fails = [];
  let peak = 0;
  const mem = () => { peak = Math.max(peak, process.memoryUsage().rss); };
  const check = (label, ok, detail) => { if (!ok) fails.push(`${label}: ${detail}`); };
  // 1) 안내문
  const guide = fs.readFileSync(path.join(ROOT, 'workspace', '독서모임_안내.pdf'));
  const g0 = await open(guide), truth = g0.pageText(0); g0.close();
  for (const dpi of [150, 300]) {
    const t = Date.now();
    const { r, text } = await ocrText(await rasterize(guide, dpi));
    mem();
    const sim = similarity(text, truth);
    rows.push([`안내문 ${dpi}dpi 그림`, sim, r.confidence, Date.now() - t]);
    check(`안내문 ${dpi}dpi`, sim >= 0.9, sim.toFixed(3));
  }
  // 2) 줄 묶기 말뭉치
  const dir = path.join(ROOT, 'app', 'test-data', 'grouping'), sims = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.pdf')).sort()) {
    const bytes = fs.readFileSync(path.join(dir, f));
    const d = await open(bytes), orig = d.pageText(0); d.close();
    if (!orig.trim()) continue;
    const t = Date.now();
    const { r, text } = await ocrText(await rasterize(bytes, 200));
    mem();
    const sim = similarity(text, orig);
    sims.push(sim);
    rows.push([f, sim, r.confidence, Date.now() - t]);
  }
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
  check('말뭉치 평균', mean >= 0.85, mean.toFixed(3));
  // 3) 방향(OSD 데이터 없이 반 크기 네 방향 비교)
  for (const k of [2, 1]) {
    const t = Date.now();
    const { r, text } = await ocrText(await rotatedScan(guide, k));
    mem();
    const sim = similarity(text, truth);
    rows.push([`안내문 ${k * 90}° 돌린 그림`, sim, r.confidence, Date.now() - t, `방향 ${r.orientation}°`]);
    check(`${k * 90}° 방향`, r.orientation === (4 - k) * 90 % 360 || r.orientation === k * 90, `알아본 방향 ${r.orientation}`);
    check(`${k * 90}° 비슷함`, sim >= 0.85, sim.toFixed(3));
  }
  await OCR.shutdown();
  console.log('파일 · 비슷함 · 신뢰도 · 걸린 시간');
  for (const [name, sim, conf, ms, extra] of rows) console.log(`  ${name.padEnd(28)} ${sim.toFixed(3)}  ${String(conf).padStart(3)}%  ${String(ms).padStart(5)}ms${extra ? '  ' + extra : ''}`);
  console.log(`말뭉치 평균 비슷함 ${mean.toFixed(3)} (최저 ${Math.min(...sims).toFixed(3)}) · 최대 메모리 ${(peak / 1048576).toFixed(0)}MB · 전체 ${((Date.now() - T0) / 1000).toFixed(1)}초`);
  fs.rmSync(TMP, { recursive: true, force: true });
  if (fails.length) { console.error('FAIL\n  ' + fails.join('\n  ')); process.exit(1); }
  console.log('OK — OCR 말뭉치 검사 통과');
})().catch(async (e) => { console.error('FAIL', e); try { await OCR.shutdown(); } catch {} process.exit(1); });
