// tools/md2pdf.js — Markdown → PDF via Chromium printToPDF (real embedded/subset fonts).
// Usage: node_modules\.bin\electron tools\md2pdf.js <in.md> <out.pdf>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: electron tools/md2pdf.js <in.md> <out.pdf>');
  process.exit(1);
}

app.disableHardwareAcceleration();

async function main() {
  let md;
  try {
    md = fs.readFileSync(path.resolve(inPath), 'utf-8');
  } catch (e) {
    console.error('Failed to read input:', e.message);
    process.exit(1);
  }

  // <title>이 없으면 Chromium이 data: 주소 전체(HTML 원문)를 PDF 제목(/Title)으로 적는다 → 첫 제목 줄이나 파일 이름을 넣는다
  const heading = (md.match(/^#\s+(.+)$/m) || [])[1];
  const title = (heading || path.basename(inPath, path.extname(inPath))).trim().replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.7/marked.min.js"></script>
<style>
@page{size:A4;margin:20mm}
body{font-family:'Malgun Gothic','맑은 고딕',sans-serif;font-size:11pt;line-height:1.6;padding:0}
table{border-collapse:collapse}
td,th{border:1px solid #666;padding:4px 8px}
</style></head>
<body><div id="out">렌더링 중...</div>
<script>
window.__MD__ = ${JSON.stringify(md)};
</script>
</body></html>`;

  await app.whenReady();
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

  // Wait for the CDN-loaded marked script, then render markdown into #out.
  await win.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const start = Date.now();
      (function wait() {
        if (typeof marked !== 'undefined') {
          document.getElementById('out').innerHTML = marked.parse(window.__MD__);
          resolve();
        } else if (Date.now() - start > 15000) {
          reject(new Error('marked failed to load from CDN'));
        } else {
          setTimeout(wait, 50);
        }
      })();
    })
  `);

  try {
    const buf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    });
    fs.writeFileSync(path.resolve(outPath), buf);
    console.log('Wrote', outPath, buf.length, 'bytes');
  } catch (e) {
    console.error('printToPDF failed:', e.message);
    process.exit(1);
  }
  app.quit();
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
