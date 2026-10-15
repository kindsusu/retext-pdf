// Microsoft Store 제출용 스크린샷 → store/screenshot-*.png (1366×768, Store 권장 크기) 5장: PDF 보기·쪽 위 편집(속성 창)·가리기·Markdown·어두운 테마와 문서 탭
// 저장소의 가상 문서(workspace/독서모임_안내.*)만 임시 작업 폴더에 복사해 연다. 회사 문서처럼 보이지 않는 예시를 쓴다
// (2026-10-06, 이전엔 가상 회의록이라 "회사에 너무 맞춰져 있다"는 의견). 사용자의 설정(~/.retext-pdf.json)과
// 실행 중인 앱(4747)은 건드리지 않도록 임시 홈 폴더·다른 포트(4849)·메모리 전용 세션(localStorage 비어 있음)을 쓴다.
// 실행: npx electron tools/store-screenshots.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
// 임시 홈은 %TEMP%가 아니라 store/ 아래에 둔다 — %TEMP% 안의 파일은 앱이 "임시 파일입니다" 띠를 띄워 화면에 찍힌다
const out = path.join(root, 'store');
fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(out, '.home-'));
const ws = path.join(home, '문서');
fs.mkdirSync(ws);
for (const f of ['독서모임_안내.pdf', '독서모임_안내.md']) fs.copyFileSync(path.join(root, 'workspace', f), path.join(ws, f));
fs.writeFileSync(path.join(home, '.retext-pdf.json'), JSON.stringify({ workspace: ws }));

const { app, BrowserWindow } = require('electron');
const W = 1366, H = 768;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 화면 스크립트가 실패하면 멈춰 있지 말고 끝낸다(6.0.0 준비 때 옛 선택자로 멈춘 적이 있다)
const fail = (e) => { console.error(e); try { fs.rmSync(home, { recursive: true, force: true }); } catch {} process.exit(1); };
process.on('unhandledRejection', fail);
setTimeout(() => fail(new Error('3분 안에 끝나지 않았습니다')), 180000).unref();

app.whenReady().then(async () => {
  // os.homedir()가 이 값을 쓴다 — 서버를 읽기 직전에 바꾼다(Electron 시작 전에 바꾸면 whenReady가 끝나지 않는다)
  process.env.USERPROFILE = home; process.env.HOME = home;
  process.env.RETEXTPDF_PORT = '4849';
  const port = await require(path.join(root, 'app', 'server.js')).ready;
  // 설치된 앱과 같은 화면이 되도록 preload를 붙인다(없으면 브라우저 모드 화면이 찍힌다). 대화상자용 IPC 처리기는 없지만 찍는 데는 쓰지 않는다
  const win = new BrowserWindow({ width: W, height: H, show: false, backgroundColor: '#fbf9f4',
    webPreferences: { offscreen: true, partition: 'store-shots', preload: path.join(root, 'app', 'preload.js') } });
  await win.loadURL(`http://localhost:${port}`);
  await wait(1500);
  // 쪽 위 편집기(contenteditable) 안에서 글자 고르기 — 화면 스크립트는 모듈 안이라 편집기 함수를 밖에서 부를 수 없어 DOM으로 고른다
  await win.webContents.executeJavaScript(`window.selectIn = (root, needle) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const k = n.nodeValue.indexOf(needle); if (k < 0) continue;
      const r = document.createRange(); r.setStart(n, k); r.setEnd(n, k + needle.length);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return true; }
    throw new Error('편집기에서 글자를 찾지 못했습니다: ' + needle);
  }; true`);
  const shot = async (name) => {
    await wait(1500);
    const img = await win.webContents.capturePage();
    const { width, height } = img.getSize();
    const fitted = width === W && height === H ? img : img.resize({ width: W, height: H, quality: 'best' });
    fs.writeFileSync(path.join(out, name), fitted.toPNG());
    console.log(`store/${name}`, fitted.getSize());
  };
  // 반환값(DOM 등)은 복제할 수 없어 버린다
  // 화면에서 난 오류는 메시지를 받아 여기서 던진다(그냥 두면 "Script failed to execute"만 남는다)
  const js = async (code) => {
    const r = await win.webContents.executeJavaScript(`Promise.resolve((() => { try { ${code} } catch (e) { return { err: String(e && e.stack || e) }; } })()).then((v) => (v && v.err ? v : true))`);
    if (r && r.err) throw new Error(r.err);
  };
  // 첫 실행 안내 등 떠 있는 대화상자는 닫고 찍는다
  const closeDialogs = () => js(`document.querySelectorAll('dialog[open]').forEach((d) => d.close());`);
  const pdf = path.join(ws, '독서모임_안내.pdf'), md = path.join(ws, '독서모임_안내.md');
  // 줄 상자는 마우스 누름/뗌으로 선택하므로(attachDrag) .click()이 아니라 실제 입력을 보낸다. 상자 순서는 groupLines 순서와 같다
  const clickLine = async (prefix) => {
    const at = await win.webContents.executeJavaScript(`(async () => {
      const objs = await (await fetch('/api/pdf/objects?name=' + encodeURIComponent(${JSON.stringify(pdf)}) + '&i=0')).json();
      const k = window.groupLines(objs).findIndex((l) => l.text.startsWith(${JSON.stringify(prefix)}));
      const b = [...document.querySelectorAll('#pdf .pdfBox:not(.pdfMask):not(.pdfImage)')][k];
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!at) throw new Error(`줄 상자를 찾지 못했습니다: ${prefix}`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await wait(800);
  };

  // 1) 연결 프로그램으로 연 것과 같은 경로(main.js의 open-paths) — 목록에 둘 다 넣고 첫 파일(PDF)을 연다
  win.webContents.send('open-paths', [pdf, md]);
  await wait(2500);
  await closeDialogs();
  await shot('screenshot-1-pdf.png');
  // 2·3은 글자가 읽히도록 "폭 맞춤"으로 키운다(5.0.0부터 PDF는 "쪽 전체 보기"로 열려 글자가 작다). 바꾼 뒤 쪽 위쪽으로 돌린다
  await js(`const s = document.querySelector('#zoomSelect'); s.value = 'fitWidth'; s.dispatchEvent(new Event('change')); document.querySelector('#pdf').scrollTop = 0;`);
  await wait(1500);
  // 2) "일시" 줄을 눌러 쪽 위에서 날짜를 고치는 중인 장면(17일 → 24일, 적용 전). 6.0부터 넓은 창은 쪽 위 편집기(.ipText)와
  //    오른쪽 속성 창으로 고친다. 고친 "24일"을 골라 두면 작은 꾸밈 막대와 속성 창이 함께 보인다
  await clickLine('일시:');
  await js(`const tx = document.querySelector('.pdfEditor.inplace .ipText'); tx.focus(); selectIn(tx, '17'); document.execCommand('insertText', false, '24');`);
  await wait(400);
  await js(`selectIn(document.querySelector('.pdfEditor.inplace .ipText'), '24일');`);
  await shot('screenshot-2-edit.png');
  await js(`document.querySelector('.pdfEditor.inplace .ipText').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));`);
  await wait(800);
  // 3) "문의" 줄의 연락처를 골라 [선택 글자 가리기](속성 창) — 글자를 지우고 검은 상자로 덮은 결과
  await clickLine('문의:');
  await js(`const tx = document.querySelector('.pdfEditor.inplace .ipText'); tx.focus(); selectIn(tx, '010-1234-5678');`);
  await wait(400);
  await js(`document.querySelector('#ppMaskSel').click();`);
  await wait(2500);
  await shot('screenshot-3-redact.png');
  // 4) Markdown 편집과 미리보기. 가린 PDF는 저장해 둔다(임시 홈의 사본) — 미저장 표시 없이 탭을 옮긴다
  await js(`document.querySelector('#save').click();`);
  await wait(1500);
  await js(`document.querySelector('#files [data-f$=".md"]').click();`);
  await closeDialogs();
  await shot('screenshot-4-markdown.png');
  // 5) 어두운 테마 + 리본 [문서] 탭(글자 인식·양식·맞춤법·Markdown/Word/한글로·비교·일괄 처리)
  await js(`document.querySelector('#files [data-f$=".pdf"]').click();`);
  await wait(2000);
  await closeDialogs();
  await js(`window.retextPdfC.setThemePref('dark'); document.querySelector('#rtab-doc').click();`);
  await wait(800);
  await js(`const s = document.querySelector('#zoomSelect'); s.value = 'fitWidth'; s.dispatchEvent(new Event('change')); document.querySelector('#pdf').scrollTop = 0;`);
  await wait(1200);
  await shot('screenshot-5-dark.png');

  win.destroy();
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(0);
});
