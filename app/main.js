// Electron 셸: 서버를 같은 프로세스에서 띄우고 창을 연다
const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 두 번 실행하면 창을 하나만 쓴다. 예전에는 두 번째 실행의 서버가 포트를 못 잡고 창만 첫 서버에 붙었다.
// 잠금을 얻은 뒤에만 서버 모듈을 읽는다(읽는 순간 listen이 시작되므로)
if (!app.requestSingleInstanceLock()) app.quit();
else main();

// 실행 인자에서 열어야 할 .pdf/.md 경로(존재하는 파일만)를 찾는다.
// 패키징 exe는 argv[0]이 실행 파일이라 argv[1]부터 보고, 개발 실행(`electron .`)은 argv[0]이 electron.exe·argv[1]이 '.'이라 argv[2]부터 봐야 한다.
// `--`로 시작하는 옵션 인자(--inspect 등)는 파일 경로가 아니므로 건너뛴다.
function pathsFromArgv(argv) {
  const start = app.isPackaged ? 1 : 2;
  const out = [];
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (!a || a.startsWith('--')) continue;
    if (!/\.(pdf|md)$/i.test(a)) continue;
    try { if (fs.statSync(a).isFile()) out.push(path.resolve(a)); } catch {} // 존재하지 않으면 조용히 무시
  }
  return out;
}

function main() {
  // 도장 보관함 등 앱 데이터 폴더. 서버 모듈을 읽기 전에 정한다(stamp-store가 이 값을 쓴다). 시험·개발에서 미리 정했으면 그대로
  if (!process.env.RETEXTPDF_DATA) process.env.RETEXTPDF_DATA = app.getPath('userData');
  const { ready } = require('./server.js');
  let win = null, rendererReady = false, pendingPaths = [];
  // 렌더러가 아직 준비 전(첫 로드 중)이면 파일 목록을 큐에 쌓아뒀다가 did-finish-load 뒤에 보낸다
  function sendOpenPaths(paths) {
    if (!paths.length) return;
    if (rendererReady) win.webContents.send('open-paths', paths);
    else pendingPaths.push(...paths);
  }
  app.on('second-instance', (_e, commandLine) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus();
    sendOpenPaths(pathsFromArgv(commandLine));
  });

  // 기본 메뉴를 쓰지 않는다: 그 단축키(Ctrl+R 새로고침, Ctrl+=/− 페이지 전체 확대, Ctrl+W 닫기)가 편집기 단축키(PDF 확대·축소)를 가로채고,
  // 새로고침은 편집 중인 화면 상태를 날린다. 개발자 도구는 F12로 연다.
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    let port;
    try { port = await ready; } // 기본 4747이 사용 중이면 서버가 다음 포트로 옮긴다
    catch (e) { dialog.showErrorBox('Retext PDF를 시작할 수 없습니다', `로컬 서버를 열지 못했습니다.\n${e.message}`); app.quit(); return; }
    win = new BrowserWindow({
      width: 1400, height: 900, title: `Retext PDF v${require('../package.json').version}`, autoHideMenuBar: true, backgroundColor: '#fbf9f4',
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    const appUrl = `http://localhost:${port}`;
    win.loadURL(appUrl);
    // Markdown 링크가 앱 창 자체를 이동시키지 못하게 한다: will-navigate는 loadURL·새로고침에는 발생하지 않으므로 사용자가 누른 링크만 걸린다.
    // http(s)는 기본 브라우저로 열고, 그 밖의 스킴(file:, javascript: 등)은 그냥 막는다. 새 창 요청도 같은 규칙.
    const openExternal = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {}); };
    win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); openExternal(url); });
    win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
    win.on('page-title-updated', (e) => e.preventDefault());
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
    // 페이지 전체 확대(Chromium 줌)는 쓰지 않는다 — PDF 확대는 렌더러가 Ctrl+휠·Ctrl+=/−로 처리한다
    win.webContents.on('did-finish-load', () => {
      win.webContents.setZoomFactor(1); win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
      rendererReady = true;
      if (pendingPaths.length) { win.webContents.send('open-paths', pendingPaths); pendingPaths = []; }
    });
    // 첫 실행 인자(연결 프로그램으로 더블클릭·`electron . <파일>`)도 같은 큐를 거쳐 렌더러로 전달
    sendOpenPaths(pathsFromArgv(process.argv));

    ipcMain.handle('openFolder', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '작업 폴더 선택' });
      return r.canceled ? null : r.filePaths[0];
    });

    ipcMain.handle('openFiles', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF · Markdown', extensions: ['pdf', 'md'] }], title: '파일 열기' });
      return r.canceled ? [] : r.filePaths;
    });

    // P5 WP-B2: 빈 상태 "여러 파일 용량 줄이기…" — PDF만, 여러 개 선택(문서를 열지 않고 바로 처리)
    ipcMain.handle('openPdfFiles', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF', extensions: ['pdf'] }], title: 'PDF 파일 선택' });
      return r.canceled ? [] : r.filePaths;
    });

    ipcMain.handle('openFont', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'TrueType 폰트', extensions: ['ttf'] }], title: '사용할 TTF 폰트 선택' });
      return r.canceled ? null : r.filePaths[0];
    });

    // P4 WP-B2 5번(이미지 삽입): 페이지에 넣을 PNG/JPEG 한 장 선택
    ipcMain.handle('openImage', async () => {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PNG · JPEG', extensions: ['png', 'jpg', 'jpeg'] }], title: '삽입할 이미지 선택' });
      return r.canceled ? null : r.filePaths[0];
    });

    ipcMain.handle('saveAs', async (_e, defaultPath, opts) => {
      const isPdf = /\.pdf$/i.test(defaultPath || '');
      const filters = isPdf ? [{ name: 'PDF', extensions: ['pdf'] }] : [{ name: 'Markdown', extensions: ['md'] }];
      // 임시·읽기전용 파일의 "다른 이름으로 저장"은 같은 임시 폴더가 아니라 문서 폴더의 Retext PDF에 원래 파일명으로 유도한다
      if (opts && opts.suggestDocFolder && defaultPath) {
        let documents = path.join(os.homedir(), 'Documents');
        try { documents = app.getPath('documents'); } catch {}
        const dir = path.join(documents, 'Retext PDF');
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}
        defaultPath = path.join(dir, path.basename(defaultPath));
      }
      const r = await dialog.showSaveDialog(win, { defaultPath, filters, title: '다른 이름으로 저장' });
      return r.canceled ? null : r.filePath;
    });

    // P7 인쇄: { name, pages?:[0 기준 쪽 번호] } → { ok:true } | { ok:false, cancelled:true } | { error, needPassword? }
    // 숨은 창으로 서버의 인쇄용 HTML(/api/pdf/print-html — 쪽마다 약 200dpi 그림, 쪽 크기별 @page)을 열고
    // 그림이 다 디코딩되면(window.printReady) 시스템 인쇄 대화상자를 띄운다. 서버의 열린 문서를 그리므로 저장 안 한 편집도 인쇄된다.
    // 끝나면(인쇄·취소·오류 모두) 창을 닫는다. 같은 HTML을 printToPDF로 확인한 결과는 보고서 참고(세로·가로 섞인 문서의 쪽 크기)
    let printing = false;
    ipcMain.handle('print', async (_e, opts) => {
      const { name, pages } = opts || {};
      if (!name) return { error: '인쇄할 문서가 없습니다.' };
      if (printing) return { error: '이미 인쇄를 준비하고 있습니다.' };
      const q = new URLSearchParams({ name });
      if (Array.isArray(pages) && pages.length) q.set('pages', pages.map(Number).join(','));
      const url = `${appUrl}/api/pdf/print-html?${q}`;
      printing = true;
      let pw = null;
      try {
        // 먼저 서버 응답을 확인한다 — 잠긴 문서(401)·없는 쪽(400)이면 창을 띄우지 않고 이유를 돌려준다
        const head = await fetch(url);
        if (!head.ok) { const err = await head.json().catch(() => ({})); return { error: err.error || `인쇄 준비 실패 (${head.status})`, ...(err.needPassword ? { needPassword: true } : {}) }; }
        pw = new BrowserWindow({ show: false, parent: win, webPreferences: { sandbox: true } });
        await pw.loadURL(url);
        const ready = await pw.webContents.executeJavaScript('window.printReady || false');
        if (ready !== true) return { error: '쪽 그림을 준비하지 못했습니다. 다시 시도하세요.' };
        const r = await new Promise((resolve) => pw.webContents.print({ silent: false, printBackground: true }, (success, reason) => resolve({ success, reason })));
        if (r.success) return { ok: true };
        return /cancel/i.test(r.reason || '') ? { ok: false, cancelled: true } : { error: r.reason || '인쇄하지 못했습니다.' };
      } catch (e) { return { error: e.message }; }
      finally { printing = false; if (pw && !pw.isDestroyed()) pw.destroy(); }
    });

    // 닫을 때 미저장이면 네 가지 중 선택. 저장은 렌더러의 window.retextPdfSave / retextPdfSaveAs가 수행하고 성공 여부(true/false)를 돌려준다
    let allowClose = false;
    const exec = (js) => win.webContents.executeJavaScript(js).catch(() => false);
    win.on('close', async (e) => {
      if (allowClose) return;
      e.preventDefault();
      const dirty = await exec('window.isDirty ? window.isDirty() : false');
      if (dirty) {
        const r = dialog.showMessageBoxSync(win, {
          type: 'warning', message: '저장하지 않은 변경이 있습니다.', detail: '어떻게 할까요?',
          buttons: ['이 문서에 덮어쓰기', '다른 이름으로 저장', '저장하지 않고 닫기', '취소'], defaultId: 0, cancelId: 3, noLink: true,
        });
        if (r === 3) return;
        if (r === 0 && !(await exec('window.retextPdfSave ? window.retextPdfSave() : false'))) return;
        if (r === 1 && !(await exec('window.retextPdfSaveAs ? window.retextPdfSaveAs() : false'))) return; // 저장 대화상자에서 취소하면 닫지 않음
      }
      allowClose = true; win.close();
    });
  });
  app.on('window-all-closed', () => app.quit());
}
