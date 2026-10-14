// 인쇄용 HTML: 쪽마다 서버가 그린 그림(/api/pdf/page, 약 200dpi) 한 장을 그 쪽 크기의 종이에 꽉 채운다.
// 서버의 열린 문서를 그리므로 저장하지 않은 편집까지 인쇄된다. main.js의 'print'가 숨은 창으로 이 페이지를 열고 인쇄한다.
// 쪽 크기가 섞인 문서(세로·가로): 크기마다 이름 붙은 @page(page: 속성)를 만든다 — Chromium은 쪽마다 다른 용지 크기·방향으로 내보낸다
// (printToPDF로 확인: tmp 검증 스크립트, 보고서 참고). pageSize()는 /Rotate를 반영한 보이는 크기라 가로로 돌린 쪽은 가로 용지가 된다.
// 쪽 상자 높이는 용지보다 0.5pt 작게 둔다 — 같게 두면 반올림으로 한 줄이 넘쳐 빈 쪽이 끼는 경우가 있다
const PRINT_DPI = 200;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pt = (n) => `${Math.round(n * 100) / 100}pt`;

// pages: [{ i, w, h }] (pt, 보이는 크기). name: 서버 문서 이름. 반환: HTML 문자열
// window.printReady: 모든 그림을 다 받아 디코딩하면 true(하나라도 실패하면 false)로 끝나는 Promise — main.js가 기다린 뒤 인쇄한다
function buildPrintHtml({ name, pages, dpi = PRINT_DPI }) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('인쇄할 쪽이 없습니다.');
  const scale = Math.round((dpi / 72) * 1000) / 1000;
  const sizes = new Map(); // "w×h" → 이름 붙은 @page
  const blocks = pages.map(({ i, w, h }) => {
    const key = `${pt(w)} ${pt(h)}`;
    if (!sizes.has(key)) sizes.set(key, { id: `s${sizes.size}`, w, h });
    const { id } = sizes.get(key);
    const src = `/api/pdf/page?${new URLSearchParams({ name, i: String(i), scale: String(scale) })}`;
    return `<div class="pg ${id}"><img src="${esc(src)}" alt=""></div>`;
  });
  const css = [...sizes.entries()].map(([key, { id, w, h }]) =>
    `@page ${id} { size: ${key}; margin: 0 }\n.${id} { page: ${id}; width: ${pt(w)}; height: ${pt(Math.max(1, h - 0.5))} }`).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(String(name).split(/[\\/]/).pop())}</title>
<style>
@page { margin: 0 }
html, body { margin: 0; padding: 0; background: #fff }
.pg { overflow: hidden; break-after: page; break-inside: avoid }
.pg:last-child { break-after: auto }
.pg img { display: block; width: 100%; height: 100%; object-fit: fill }
${css}
</style></head>
<body>
${blocks.join('\n')}
<script>
window.printReady = Promise.all([...document.images].map((img) => img.decode().then(() => true, () => false))).then((r) => r.every(Boolean));
</script>
</body></html>`;
}

module.exports = { buildPrintHtml, PRINT_DPI };
