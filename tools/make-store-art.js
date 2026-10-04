// Microsoft Store 목록 이미지 생성 → store/art/
//   poster.png     9:16 포스터 아트 1440×2160 — Windows Store의 기본 로고로 쓰인다(아이콘·이름·소개 + 장면)
//   boxart.png     1:1 박스 아트 2160×2160 — 여러 Store 레이아웃에 쓰인다(아이콘·이름·소개·특징)
//   superhero.png  16:9 수퍼히어로 아트 3840×2160 — 목록 맨 위 배경. 규정상 앱 이름을 넣지 않는다(장면만, 왼쪽은 Store가 글자를 얹는 자리로 비움)
// 디자인은 README 대표 이미지(tools/make-hero.js)와 같은 언어: 어두운 바탕·크림색 종이·주황 강조, 글자는 Segoe UI(영문만).
// 각 이미지는 기준 크기(viewBox)로 그리고 2배로 렌더해 선명하게 뽑는다.
// 실행: npm run store-art  (= electron tools/make-store-art.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.disableHardwareAcceleration();

const C = { bg: '#1b1b1f', paper: '#f2ece4', fold: '#d9d2c6', ink: '#3a3a40', acc: '#d97757', text: '#f2ece4', mut: '#9a958c', card: '#26262c', line: '#3a3a42' };
const font = `font-family="Segoe UI, Arial, sans-serif"`;
const bar = (x, y, w, h = 14, fill = C.ink) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="${fill}"/>`;

// 앱 아이콘(build/icon.svg와 같은 도형) — (x,y) 왼쪽 위, s 한 변
const icon = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s / 512})">
  <rect width="512" height="512" rx="104" fill="${C.card}"/>
  <path d="M136 88 h184 l56 56 v280 a12 12 0 0 1 -12 12 h-228 a12 12 0 0 1 -12 -12 v-324 a12 12 0 0 1 12 -12 Z" fill="${C.paper}"/>
  <path d="M320 88 v44 a12 12 0 0 0 12 12 h44 Z" fill="${C.fold}"/>
  ${bar(168, 156, 132, 22)}${bar(168, 206, 176, 22)}${bar(160, 251, 192, 32, C.acc)}${bar(168, 306, 160, 22)}${bar(168, 356, 92, 22)}
</g>`;

// 장면(로컬 좌표): 종이(0,0 560×680, 살짝 기울임) + 고치는 줄 + 가린 줄 + 편집 창 카드 + "Text removed" 표시. 범위 약 x -140..680, y 0..704
const scene = () => {
  const pw = 560, ph = 680, cx = -140, cy = 490, cw = 400, ch = 214;
  return `
  <g transform="rotate(-3 ${pw / 2} ${ph / 2})">
    <rect x="14" y="22" width="${pw}" height="${ph}" rx="18" fill="#000" opacity=".35"/>
    <path d="M18 0 h${pw - 110} l92 92 v${ph - 110} a18 18 0 0 1 -18 18 h-${pw - 36} a18 18 0 0 1 -18 -18 v-${ph - 36} a18 18 0 0 1 18 -18 Z" fill="${C.paper}"/>
    <path d="M${pw - 92} 0 v72 a20 20 0 0 0 20 20 h72 Z" fill="${C.fold}"/>
    <text x="56" y="92" ${font} font-size="34" font-weight="700" fill="#26262c">Meeting notes</text>
    ${bar(56, 128, 300)}${bar(56, 164, 420)}${bar(56, 200, 360)}
    <rect x="44" y="238" width="452" height="56" rx="6" fill="none" stroke="${C.acc}" stroke-width="3"/>
    <text x="58" y="276" ${font} font-size="28" fill="#26262c">Budget approved for <tspan font-weight="700">Q4</tspan></text>
    <rect x="364" y="252" width="3" height="32" fill="${C.acc}"/>
    ${bar(56, 328, 400)}${bar(56, 364, 330)}
    <text x="56" y="440" ${font} font-size="24" fill="#26262c">Contact:</text>
    <rect x="160" y="416" width="250" height="34" rx="3" fill="#111114"/>
    ${bar(56, 486, 380)}${bar(56, 522, 260)}${bar(56, 558, 340)}
  </g>
  <g>
    <rect x="${cx + 8}" y="${cy + 14}" width="${cw}" height="${ch}" rx="16" fill="#000" opacity=".45"/>
    <rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="16" fill="${C.card}" stroke="${C.acc}" stroke-width="2"/>
    <text x="${cx + 28}" y="${cy + 46}" ${font} font-size="22" font-weight="600" fill="${C.text}">Edit this line</text>
    <rect x="${cx + 28}" y="${cy + 68}" width="${cw - 56}" height="52" rx="8" fill="#f7f5f0"/>
    <text x="${cx + 44}" y="${cy + 102}" ${font} font-size="22" fill="#26262c">Budget approved for Q4</text>
    <rect x="${cx + 284}" y="${cy + 80}" width="2" height="28" fill="${C.acc}"/>
    <rect x="${cx + 28}" y="${cy + 142}" width="120" height="44" rx="8" fill="${C.acc}"/>
    <text x="${cx + 88}" y="${cy + 171}" ${font} font-size="20" font-weight="600" fill="#fff" text-anchor="middle">Apply</text>
    <text x="${cx + 168}" y="${cy + 171}" ${font} font-size="18" fill="${C.mut}">Original font kept</text>
  </g>
  <g>
    <path d="M440 420 L500 378" stroke="${C.mut}" stroke-width="2" fill="none"/>
    <rect x="500" y="350" width="180" height="46" rx="23" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>
    <text x="590" y="380" ${font} font-size="20" fill="${C.text}" text-anchor="middle">Text removed</text>
  </g>`;
};
const placed = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">${scene()}</g>`;

// 특징 칩(가운데 정렬 가능): 폭은 글자 수로 어림(Segoe UI 평균 글자 폭 ≈ 0.495em)
const chipW = (label, fs) => fs * 2.8 + label.length * fs * 0.495;
const chips = (cxCenter, y, labels, fs) => {
  const gap = fs * 0.8, ws = labels.map((l) => chipW(l, fs)), total = ws.reduce((a, b) => a + b, 0) + gap * (labels.length - 1);
  let x = cxCenter - total / 2;
  return labels.map((label, k) => {
    const w = ws[k], h = fs * 2.2, g = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="none" stroke="${C.line}" stroke-width="2"/>
      <circle cx="${x + fs * 1.15}" cy="${y + h / 2}" r="${fs * 0.24}" fill="${C.acc}"/>
      <text x="${x + fs * 1.8}" y="${y + h / 2 + fs * 0.34}" ${font} font-size="${fs}" fill="${C.text}" opacity=".88">${label}</text>`;
    x += w + gap; return g;
  }).join('');
};
const glow = (id, cx, cy, r, op = 0.22) => `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="${C.acc}" stop-opacity="${op}"/><stop offset="1" stop-color="${C.acc}" stop-opacity="0"/></radialGradient>`;
const svg = (W, H, body, defs = '') => (outW, outH) => `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${W} ${H}">
  <defs>${defs}</defs><rect width="${W}" height="${H}" fill="${C.bg}"/>${body}</svg>`;
const wordmark = (x, y, fs, anchor = 'middle') => `<text x="${x}" y="${y}" ${font} font-size="${fs}" font-weight="600" letter-spacing="${-fs * 0.023}" fill="${C.text}" text-anchor="${anchor}">Retext <tspan fill="${C.acc}">PDF</tspan></text>`;

const ART = [
  { file: 'poster.png', out: [1440, 2160], make: svg(720, 1080, `
      <rect width="720" height="1080" fill="url(#g)"/>
      ${icon(290, 96, 140)}
      ${wordmark(360, 352, 104)}
      <text x="360" y="420" ${font} font-size="30" fill="${C.text}" text-anchor="middle">Edit the real text in your PDFs.</text>
      <text x="360" y="462" ${font} font-size="30" fill="${C.mut}" text-anchor="middle">Redact it for real.</text>
      ${placed(250, 548, 0.62)}`, glow('g', '50%', '70%', '60%')) },
  { file: 'boxart.png', out: [2160, 2160], make: svg(1080, 1080, `
      <rect width="1080" height="1080" fill="url(#g)"/>
      ${icon(420, 170, 240)}
      ${wordmark(540, 570, 150)}
      <text x="540" y="650" ${font} font-size="40" fill="${C.text}" text-anchor="middle">Edit the real text in your PDFs.</text>
      <text x="540" y="702" ${font} font-size="40" fill="${C.mut}" text-anchor="middle">Redact it for real.</text>
      ${chips(540, 790, ['Line-level editing', 'True redaction', 'Works offline'], 24)}`, glow('g', '50%', '40%', '55%')) },
  { file: 'superhero.png', out: [3840, 2160], make: svg(1920, 1080, `
      <rect width="1920" height="1080" fill="url(#g)"/>
      ${placed(1030, 150, 1.12)}`, glow('g', '68%', '50%', '50%')) },
];

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'store', 'art');
  fs.mkdirSync(outDir, { recursive: true });
  // 이미지마다 창을 새로 만들면 두 번째 창부터 로딩이 ERR_FAILED로 끝났다 → 창 하나를 크기만 바꿔 다시 쓴다
  const win = new BrowserWindow({ width: 800, height: 800, show: false, frame: false, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
  for (const art of ART) {
    const [W, H] = art.out;
    win.setContentSize(W, H);
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:${C.bg}">${art.make(W, H)}</body>`;
    // 큰 SVG를 data: URL로 연달아 넣으면 두 번째부터 ERR_FAILED가 났다 → 임시 파일로 연다
    const tmp = path.join(require('os').tmpdir(), `retext-pdf-art-${art.file}.html`);
    fs.writeFileSync(tmp, html);
    await win.loadFile(tmp);
    fs.rmSync(tmp, { force: true });
    await new Promise((r) => setTimeout(r, 800));
    const img = (await win.webContents.capturePage()).resize({ width: W, height: H, quality: 'best' });
    fs.writeFileSync(path.join(outDir, art.file), img.toPNG());
    console.log(`store/art/${art.file}`, img.getSize());
  }
  win.destroy();
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
