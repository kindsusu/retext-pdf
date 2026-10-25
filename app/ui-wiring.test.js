const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'index.html module script exists');
assert.doesNotThrow(() => new Function(script), 'index.html module script parses');
assert.match(html, /pdfRenderGeneration/, 'stale PDF renders are invalidated');
assert.match(html, /DOMPurify\.sanitize\(marked\.parse/, 'Markdown preview is sanitized');
assert.doesNotMatch(html, /https:\/\/cdnjs\.cloudflare\.com/, 'UI has no CDN runtime dependency');
assert.match(html, /addEventListener\('wheel'[\s\S]*ctrlKey/, 'Ctrl+wheel zooms the PDF');
assert.match(html, /<option value="fitWidth">폭 맞춤<\/option>/, 'fit-to-width zoom exists (zoom select, UI 개편)');
assert.doesNotMatch(serverSource, /install\.ps1|ExecutionPolicy\s+Bypass|irm\s+https:/i,
  'server never pipes a remote PowerShell script into execution');
assert.match(serverSource, /headers\.host/, 'server checks the Host header (DNS rebinding)');
assert.match(html, /id="tempBanner"/, 'temp/read-only file banner exists (WP-B1)');
assert.match(html, /window\.retextPdf\.onOpenPaths/, 'renderer wires up onOpenPaths for files opened via file association/argv (WP-B1)');

// P4 WP-B2: page extraction, merge, image export/insert, size reduction dialogs & routes
assert.match(html, /id="pageExtractDialog"/, 'page extraction dialog exists (WP-B2)');
assert.match(html, /id="mergeDialog"/, 'merge dialog exists (WP-B2)');
assert.match(html, /id="exportImagesDialog"/, 'image export dialog exists (WP-B2)');
assert.match(html, /id="downsampleDialog"/, 'downsample (size reduction) dialog exists (WP-B2)');
assert.match(html, /window\.retextPdf\.openImage/, 'renderer wires up openImage for image insertion (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/export-images/, 'server exposes export-images route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/pages\/delete/, 'server exposes page delete route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/merge/, 'server exposes merge route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/image/, 'server exposes image insert route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/downsample/, 'server exposes downsample route (WP-B2)');
assert.match(serverSource, /reloadAll/, 'undo/redo responses signal reloadAll for whole-document snapshots (WP-B2)');

// P5 WP-B1: status bar, toolbar groups (dropdown removed), sidebar tabs + thumbnails, empty state / drop overlay, terminology
assert.match(html, /id="statusbar"/, 'status bar exists (WP-B1)');
assert.match(html, /id="pageNumInput"/, 'status bar has a page-number input that jumps to a page (WP-B1)');
assert.match(html, /id="ctxHint"/, 'context bar has a one-line usage hint area (UI 개편: 상태줄 첫 안내 → 상황줄 사용법)');
assert.match(html, /retextpdf\.hintSeen/, 'first-run hint is remembered per browser via localStorage (WP-B1)');
assert.doesNotMatch(html, /id="pageMenuBtn"|id="pageMenuWrap"|class="popupMenu" id="pageMenu"/, 'the old 페이지 ▾ dropdown menu is removed in favor of direct toolbar buttons (WP-B1)');
assert.match(html, /id="groupView"/, 'toolbar has a 보기 group (WP-B1)');
assert.match(html, /id="groupEdit"/, 'toolbar has a 편집 group (WP-B1)');
assert.match(html, /id="groupPage"/, 'toolbar has a 페이지 group (WP-B1)');
assert.match(html, /id="groupDoc"/, 'toolbar has a 문서 group (WP-B1)');
assert.match(html, /id="groupFile"/, 'toolbar has a 파일 group (열기·저장·다른 이름으로·인쇄, UI 개편)');
assert.match(html, /id="groupTool"/, 'toolbar has a 도구 group (UI 개편)');
assert.match(html, /id="asideTabs"/, 'sidebar has 파일/페이지 tabs (WP-B1)');
assert.match(html, /id="pageThumbs"/, 'sidebar page tab renders page thumbnails (WP-B1)');
assert.match(html, /openPageCtxMenu/, 'page thumbnail right-click context menu exists (WP-B1)');
assert.match(html, /id="emptyState"/, 'empty state exists when no document is open (WP-B1)');
assert.match(html, /id="dropOverlay"/, 'full-window drag-and-drop overlay exists (WP-B1)');
assert.match(html, /id="rectTool"[^>]*><span class="tl">가리기</, '가리기(rect mask) toolbar button uses unified terminology, not "마스킹 삽입" (WP-B1)');
assert.match(html, /가린 영역/, 'mask panel title is renamed to 가린 영역 (WP-B1)');
assert.doesNotMatch(html, /마스킹/, 'no leftover "마스킹" wording remains in the UI (engine mark name RetextPdfMask / route /api/pdf/mask are unaffected, WP-B1)');

// P5 WP-B2: rotate/reorder/extract/split/find/downsample-files routes, search UI, thumbnail rotate/save-as, split & multi-file downsample dialogs
assert.match(serverSource, /\/api\/pdf\/pages\/rotate/, 'server exposes page rotate route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/pages\/reorder/, 'server exposes page reorder route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/pages\/extract/, 'server exposes page extract route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/split/, 'server exposes split route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/find/, 'server exposes find (search) route (WP-B2)');
assert.match(serverSource, /\/api\/pdf\/downsample-files/, 'server exposes multi-file downsample route (WP-B2)');
assert.match(serverSource, /downsampleToTarget/, 'downsample target-size loop is a shared function reused by both downsample routes (WP-B2)');
assert.match(serverSource, /if \(!query\) return json\(res, 400/, 'empty search query is rejected at the route entrance before PDFium ever sees it (WP-B2)');
assert.match(html, /id="searchBar"/, 'search bar exists (WP-B2)');
assert.match(html, /id="searchInput"/, 'search bar has a query input (WP-B2)');
assert.match(html, /id="searchCount"/, 'search bar shows a match counter (WP-B2)');
assert.match(html, /id="searchMatchCase"/, 'search bar has a match-case option (WP-B2)');
assert.match(html, /'searchHit'/, 'search hits are painted as highlight boxes on the page (WP-B2)');
assert.match(html, /openSearchHitCtxMenu/, 'right-clicking a search hit offers a context menu (WP-B2)');
assert.match(html, /줄 전체 가리기/, 'search hit context menu can mask the whole line (WP-B2)');
assert.match(html, /function pdfToScreen/, 'shared pdfToScreen() rotation-aware coordinate helper exists (WP-B2)');
assert.match(html, /function screenToPdf/, 'shared screenToPdf() rotation-aware coordinate helper exists (WP-B2)');
assert.match(html, /id="rotateLeft" data-icon="rotateLeft" data-tip="왼쪽으로 돌리기:[^>]*><span class="tl">왼쪽</, 'rotate-left toolbar button has an icon, a short label 왼쪽 and the full name in its tip (1366px 맞춤)');
assert.doesNotMatch(html, /id="rotateLeft"[^>]*disabled/, 'rotate-left toolbar button is no longer disabled (WP-B2)');
assert.match(html, /\$\('#menuSplit'\)\.onclick = openSplitDialog/, 'split is a toolbar button again (밝은 테마·아이콘 개편: 숨은 메뉴 없음)');
assert.match(html, /id="splitDialog"/, 'split dialog exists (WP-B2)');
assert.match(html, /id="downsampleFilesDialog"/, 'multi-file downsample dialog exists (WP-B2)');
assert.match(html, /id="emptyDownsampleFiles"[^>]*><b>압축\(용량 줄이기\)<\/b><span>여러 파일 용량 줄이기/, '시작 화면 압축(여러 파일 용량 줄이기) 작업 단추 (WP-B2 → v6 Wave C 시작 화면)');
assert.doesNotMatch(html, /id="emptyDownsampleFiles"[^>]*disabled/, '빈 상태 여러 파일 용량 줄이기 button is no longer disabled (WP-B2)');
assert.doesNotMatch(html, /id="emptyExportImages"[^>]*disabled/, '빈 상태 이미지로 내보내기 button is no longer disabled (WP-B2)');
assert.match(html, /function savePagesAs\(indices\)[\s\S]{0,400}\/api\/pdf\/pages\/extract/, 'thumbnail context menu saves the selected pages as a new file (따로 저장…, UI 개편)');
assert.match(html, /menuItem\('왼쪽으로 돌리기', \(\) => rotatePages\(idxs, -90/, 'thumbnail context menu rotates the selected pages (UI 개편)');
assert.match(html, /await pdfMutate\('\/api\/pdf\/pages\/reorder'/, 'drag-drop thumbnail reorder is wired to the reorder route (WP-B2)');
assert.match(html, /window\.retextPdf\.openPdfFiles/, 'renderer wires up openPdfFiles for multi-file downsample picker (WP-B2)');
// UI 개편: 도구줄 버튼은 아이콘 위 짧은 이름(.tl). 긴 설명은 data-tip(→ title)에 둔다
for (const [id, label] of [['menuExtract', '쪽 정리…'], ['menuInsertImage', '그림'], ['rotateLeft', '왼쪽'],
  ['saveAs', '다른 이름'], ['save', '저장'], ['openBtn', '열기'], ['undoBtn', '실행 취소'], ['redoBtn', '다시 실행'], ['protectBtn', '암호'],
  ['toolEdit', '글자 고치기'], ['toolText', '글 상자'], ['toolStamp', '도장'], ['printBtn', '인쇄'], ['pageBlank', '빈 쪽'], ['pageInsertPdf', '끼워 넣기'],
  ['pageNumbers', '쪽 번호'], ['rotateRight', '오른쪽'], ['searchToggle', '찾기'], ['helpBtn', '도움말'],
  ['menuMerge', '병합'], ['menuExportImages', '이미지로'], ['menuDownsample', '용량 줄이기'], ['menuSplit', '분할']]) {
  assert.match(html, new RegExp(`<button type="button" class="tb" id="${id}" data-icon="\\w+"[^>]*><span class="tl">${label}</span></button>`), `도구줄 ${id}: 아이콘 + 짧은 이름 "${label}" (UI 개편)`);
}

// --- P6 WP-B ---
const fontEditorSource = fs.readFileSync(path.join(__dirname, 'font-editor.js'), 'utf8');

// P6 WP-B1: 작업 진행 창(진행률 폴링 + 취소) — 계약 C1
assert.match(html, /id="jobDialog"/, 'job progress dialog exists (P6 WP-B1)');
assert.match(html, /id="jobProgress"/, 'job progress dialog has a progress bar (P6 WP-B1)');
assert.match(html, /id="jobCancel"/, 'job progress dialog has a cancel button (P6 WP-B1)');
assert.match(html, /function runJob\(label, task\)/, 'runJob() helper wraps long-running requests with a generated jobId (P6 WP-B1)');
assert.match(html, /\/api\/jobs\?id=/, 'UI polls GET /api/jobs?id= for progress (P6 WP-B1, contract C1)');
assert.match(html, /\/api\/jobs\/cancel/, 'UI posts to /api/jobs/cancel (P6 WP-B1, contract C1)');
for (const p of ['/api/pdf/export-images', '/api/pdf/split', '/api/pdf/merge', '/api/pdf/downsample', '/api/pdf/pages/delete']) {
  const re = new RegExp(p.replace(/[/.]/g, '\\$&') + "'[\\s\\S]{0,400}?jobId");
  assert.match(html, re, `${p} request carries a jobId (P6 WP-B1, contract C1)`);
}
assert.match(html, /\/api\/pdf\/downsample-files', \{ paths: downsampleFilesPaths, maxDpi, quality, targetBytes, jobId \}/,
  'downsample-files request carries a jobId (P6 WP-B1, contract C1)');
assert.match(html, /취소됨 — 원래 상태로 되돌렸습니다/, 'cancelled document-mutating jobs (downsample/pages-delete) report the restored state (P6 WP-B1, contract C1)');
assert.match(html, /취소됨 — \$\{n\}개 파일까지 저장됨/, 'cancelled file-producing jobs report how many files were saved before cancel (P6 WP-B1, contract C1)');
assert.match(html, /function maybeFlashUndoTrimmed/, 'a one-shot undoTrimmed flag from stacks() surfaces a flash message (P6 WP-B1, contract C3)');
assert.match(html, /실행 취소 기록이 메모리 한도로 일부 지워졌습니다/, 'undo-trim flash message text (P6 WP-B1, contract C3)');

// P6 WP-B2: 실행 취소 토스트 — flash()와 별개, 5초, 액션 포함
assert.match(html, /<div id="toasts" aria-live="polite"/, 'toast stack container exists, separate from #status/flash, announced politely (UI 개편)');
assert.match(html, /function toast\(text, opts = \{\}\)/, 'toast() keeps its (text, opts) signature with an action button (P6 WP-B2)');
assert.match(html, /setTimeout\(\(\) => hideToast\(el\), opts\.ms \?\? 5000\)/, 'toast auto-hides after 5s by default (P6 WP-B2)');
assert.match(html, /\['warning', 'error'\]\.includes\(opts\.kind\)/, 'toast kinds info/warning/error (UI 개편)');
assert.match(html, /toast\(label, \{ action: '실행 취소', onAction: undo \}\)/, 'page delete/rotate completion offers an undo toast (P6 WP-B2)');
assert.match(html, /toast\('쪽 순서를 바꿨습니다', \{ action: '실행 취소', onAction: undo \}\)/, 'page reorder completion offers an undo toast (P6 WP-B2)');
assert.match(html, /toast\('용량을 줄였습니다', \{ action: '실행 취소', onAction: undo \}\)/, 'downsample completion offers an undo toast (P6 WP-B2)');

// P6 WP-B4: 회전 페이지 이미지 크기 조절 손잡이 — 실측(브라우저, 회전 0·1·2·3, 계약 C5 표와 대조) 결과를 코드에 반영
// · box.offsetLeft/Top/Width/Height는 정수로 반올림돼 오차가 생긴다 — box.style.*(pdfToScreen이 써 넣은 소수)를 읽어야 한다
assert.match(html, /function attachResize[\s\S]{0,2000}?screenToPdf/, '이미지 손잡이 크기 조절이 screenToPdf로 화면→PDF 변환을 한다 (P6 WP-B4)');
assert.match(html, /parseFloat\(box\.style\.left\)/, '손잡이 드래그 시작점은 box\.style\.*(소수)를 읽는다 — offsetLeft 등 정수 반올림 값이 아니다 (P6 WP-B4)');
assert.doesNotMatch(html, /const left0 = box\.offsetLeft, top0 = box\.offsetTop, w0 = box\.offsetWidth/, '손잡이 크기 조절은 더 이상 반올림되는 offset\* 값으로 시작점을 잡지 않는다 (P6 WP-B4)');
assert.match(html, /const MIN_PX = 8/, '손잡이로 만들 수 있는 최소 화면 크기가 있다 — 뒤집히거나 0이 되지 않는다 (P6 WP-B4)');

console.log('OK — UI checks passed');

// --- P6 WP-A --- (서버 단언)
// C1: 작업 진행·취소 API와 6개 라우트의 jobId 수신
assert.match(serverSource, /url\.pathname === '\/api\/jobs' && req\.method === 'GET'/, '진행 조회 라우트 GET /api/jobs (C1)');
assert.match(serverSource, /url\.pathname === '\/api\/jobs\/cancel' && req\.method === 'POST'/, '취소 라우트 POST /api/jobs/cancel (C1)');
assert.match(serverSource, /function startJob/, '작업 등록 함수 (C1)');
// 긴 라우트 6개가 모두 jobId를 받아 진행·취소를 붙였다
for (const phase of ['export-images', 'split', 'merge', 'downsample', 'downsample-files', 'pages-delete']) {
  assert.ok(serverSource.includes(`startJob(jobId, '${phase}'`) || serverSource.includes(`startJob(q.jobId, '${phase}'`),
    `${phase} 라우트가 jobId를 받는다 (C1)`);
}
assert.match(serverSource, /if \(result\.cancelled\) \{ \/\/ 문서를 바꾸는 작업/, '취소된 용량 줄이기는 스냅샷으로 되돌린다 (C1)');
assert.match(serverSource, /async function restore\(entry, i, before\)/, '실패·취소한 변경은 이전 바이트로 되돌리고 실행 취소 스택에 남기지 않는다 (C1)');
assert.match(serverSource, /JOB_TTL = 60000/, '끝난 작업은 60초 뒤 지운다 (C1)');
// C3: 실행 취소 메모리 상한
assert.match(serverSource, /UNDO_MAX_BYTES = 256 \* 1024 \* 1024/, 'undo 바이트 상한 256MB (C3)');
assert.match(serverSource, /undoTrimmed/, 'undo를 잘라냈음을 UI에 알린다 (C3)');
// C4: 조기 종료
assert.match(serverSource, /DOWNSAMPLE_MIN_GAIN = 0\.01/, '1% 미만 개선이면 다음 dpi 단계로 (C4)');
assert.match(serverSource, /stalledDpis/, '두 dpi 연속 제자리면 중단 (C4)');

console.log('OK — P6 WP-A 서버 단언 통과');

// P7: 줄 단위 편집 상자 — text-grouping.js가 font-editor.js와 같은 모양으로 배선됐는지(로직 자체는 text-grouping.test.js)
assert.match(serverSource, /url\.pathname === '\/text-grouping\.js'/, '/text-grouping.js 라우트가 font-editor.js와 같은 모양으로 있다 (P7)');
assert.match(html, /<script src="\/text-grouping\.js">/, 'index.html이 모듈 스크립트보다 먼저 text-grouping.js를 읽는다 (P7)');
assert.ok(html.indexOf('<script src="/text-grouping.js">') < html.indexOf('<script type="module">'),
  'text-grouping.js는 모듈 스크립트보다 먼저 로드돼야 window.groupLines를 쓸 수 있다 (P7)');
assert.doesNotMatch(script, /function groupLines\(/, '옛 bounds.y0 기반 groupLines 정의는 지워졌다 (P7)');
assert.match(script, /window\.groupLines/, '모듈 스크립트는 text-grouping.js가 노출한 window.groupLines를 쓴다 (P7)');

console.log('OK — P7 배선 단언 통과');

// P8: 끌어다 놓기 — FileList를 contextBridge로 넘기면 프리로드에 빈 객체가 도착해 아무 파일도 열리지 않는다
// (v0.8.0~v0.10.0에서 끌어다 놓기가 동작하지 않은 원인. 실측: FileList → 0개, Array.from → 실제 경로)
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
assert.match(preloadSource, /pathForFile:\s*\(file\)/, '프리로드는 File 하나를 받는 pathForFile을 노출한다 (P8)');
{
  const drop = script.slice(script.indexOf("document.addEventListener('drop'")); // 창 전체의 파일 놓기(문서 탭 줄의 끌어 옮기기 drop과 다르다)
  const body = drop.slice(0, drop.indexOf('});') + 3);
  assert.match(body, /Array\.from\(e\.dataTransfer\?\.files/, 'drop 처리는 렌더러에서 FileList를 배열로 바꾼 뒤 넘긴다 (P8)');
  assert.doesNotMatch(body, /pathsFromFiles\(e\.dataTransfer/, 'FileList를 그대로 프리로드로 넘기지 않는다 (P8)');
  assert.match(body, /flash\(/, '경로를 못 읽으면 조용히 끝내지 않고 알린다 (P8)');
}

console.log('OK — P8 끌어다 놓기 단언 통과');

// UI 결함 수정(2026-10): 한글 조합 Enter, 적용 중복/실패 보존, 정렬은 서버에서, 링크·원격 이미지 차단
const mainSource = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
assert.match(mainSource, /will-navigate/, 'app window cannot be navigated away by Markdown links');
assert.match(mainSource, /setWindowOpenHandler/, 'new-window requests are denied and opened externally');
assert.match(html, /ta\.onkeydown = \(e\) => \{\s*if \(e\.isComposing \|\| e\.keyCode === 229\) return;/, 'inline editor ignores Enter while composing Hangul');
assert.match(html, /searchInput'\)\.addEventListener\('keydown'[\s\S]{0,120}isComposing/, 'search input ignores Enter while composing Hangul');
assert.match(html, /let committing = false/, 'inline editor commit has an in-flight guard');
assert.doesNotMatch(html, /\/api\/pdf\/move', \{ name: cur, i, idxs, dx: /, 'edit commit no longer follows up with a separate move');
assert.match(html, /align: alignReq/, 'alignment is sent with the edit so one edit is one undo');
assert.match(html, /refreshSeq\[i\]/, 'refreshPage drops out-of-order responses');
assert.match(html, /mutationSeq/, 'save only clears dirty if no edit happened during it');
assert.match(html, /externalChange/, 'external file change is surfaced');
assert.match(html, /new DOMParser\(\)\.parseFromString\(DOMPurify\.sanitize/, 'Markdown remote images are neutralised before insertion');

// AI 기능 제거(2026-10-03): Claude Code/Codex 연동(채팅 패널·설정 대화상자·로그인 배너·모델 선택·폰트 추천)이 코드에 남지 않는다.
// PDF 편집용으로만 쓰고, 문서는 PC 밖으로 나가지 않는다 — 외부 CLI를 부르는 길 자체가 없어야 한다
assert.ok(!fs.existsSync(path.join(__dirname, 'ai-providers.js')), 'app/ai-providers.js는 지워졌다');
assert.ok(!fs.existsSync(path.join(__dirname, 'claude-provider.test.js')), 'AI 공급자 어댑터 테스트도 지워졌다');
assert.doesNotMatch(html, /id="aiPanel"|class="ai"/, 'AI 채팅 패널이 없다');
assert.doesNotMatch(html, /id="modelPicker"|id="aiToggle"|id="aiRailToggle"/, '머리줄에 AI 모델 선택·채팅 버튼이 없다');
assert.doesNotMatch(html, /<dialog id="setup"/, 'AI 설치·로그인 대화상자가 없다');
assert.doesNotMatch(html, /id="authBanner"|AuthError/, 'AI 로그인 만료 배너가 없다');
assert.doesNotMatch(html, /\/api\/chat|\/api\/setup|\/api\/session\/reset|font-recommend/, '화면이 AI 라우트를 부르지 않는다');
assert.doesNotMatch(html, /ai-collapsed|editRadio|showDiff|rebuildDocText/, 'AI 패널 열·편집 모드·수정안 비교 코드가 없다');
assert.doesNotMatch(html, /claude|codex|chatgpt/i, '화면에 Claude/Codex/ChatGPT 언급이 없다');
assert.match(html, /\.workarea\{[^}]*grid-template-columns:212px 1fr\}/, '가운데는 왼쪽 패널/문서 2열이다(AI 패널 열 없음)');
assert.match(html, /<div class="statusbar" id="statusbar">[\s\S]*<span id="status" role="status"><\/span>/, '상태줄 #status는 flash() 알림 자리로만 남는다');
assert.match(html, /id="ver"/, '앱 버전 표시(#ver)는 유지된다');
assert.match(html, /fetch\('\/api\/health'\)/, '앱 버전은 /api/health에서 읽는다');
assert.doesNotMatch(html, /\.ai'|\.aiChoice'/, 'AI 설정 키(localStorage)를 읽거나 청소하는 코드가 없다');
assert.doesNotMatch(serverSource, /\/api\/chat|font-recommend|\/api\/setup|\/api\/session\/reset|ai-providers|FAKE_AUTH_ERROR|code: 'auth'/,
  'server.js에 AI 라우트·공급자 참조·인증 만료 분기가 없다');
assert.doesNotMatch(serverSource, /claude|codex|chatgpt/i, 'server.js에 Claude/Codex/ChatGPT 언급이 없다');
assert.match(serverSource, /url\.pathname === '\/api\/health'\) return json\(res, 200, \{ appVersion: APP_VERSION \}\)/, '/api/health는 앱 버전만 돌려준다');
assert.doesNotMatch(fontEditorSource, /fontRecommend|font-recommend|ensureAi|autoRecommend|AI 후보|AuthError/, '폰트 맞추기 창에 AI 추천 버튼·로그인 처리가 없다');
assert.match(fontEditorSource, /\/api\/pdf\/font-preview/, '폰트 맞추기 미리보기는 그대로 있다');
assert.match(fontEditorSource, /\/api\/pdf\/font-apply/, '폰트 맞추기 적용은 그대로 있다');
assert.match(fontEditorSource, /비슷한 글꼴을 고르세요/, '원래 글꼴을 쓸 수 없으면 사람이 고르도록 안내한다');
const pkg = require('../package.json');
assert.doesNotMatch(pkg.description + ' ' + pkg.keywords.join(' '), /claude|codex|chatgpt/i, 'package.json 설명·키워드에 AI 공급자가 없다');
assert.doesNotMatch(pkg.description, /&/, 'package.json 설명에 & 없음(appx 설명서가 깨진다)');
assert.doesNotMatch(pkg.scripts.test, /ai-providers|claude-provider/, 'npm test가 지운 테스트를 부르지 않는다');
assert.match(pkg.scripts.test, /ui-wiring\.test\.js/, 'npm test가 ui-wiring.test.js를 부른다');

console.log('OK — AI 제거 단언 통과');

// 2026-10-03: CRLF Markdown은 화면 안에서 LF로 다루고 저장할 때 원래 줄바꿈으로 되돌린다(입력 뒤 되돌려도 미저장 표시가 남던 문제)
assert.match(script, /mdEol = \/\\r\\n\/\.test\(text\)/, 'Markdown 원래 줄바꿈을 기억한다');
assert.match(script, /savedText = text\.replace\(\/\\r\\n\/g, '\\n'\)/, '비교 기준(savedText)은 LF로 정규화한다');
assert.match(script, /async function putText\(name, text, eol = mdEol, enc = curEnc\) \{\s*if \(eol === '\\r\\n'\) text = text\.replace/, '저장할 때 CRLF로 되돌린다(v6 Wave C: 탭마다 원래 줄바꿈)');
// 2026-10-03: 여러 조각으로 된 줄도 폰트 맞추기가 된다 — 나머지 조각 idx를 remove로 넘긴다
assert.doesNotMatch(script, /fontButton\.disabled = selectedObj\.objs\.length !== 1/, '폰트 맞추기가 조각 하나짜리 줄로 묶여 있지 않다');
assert.match(script, /openPdfFontEditor\(\{[^}]*remove: selection\.objs\.slice\(1\)/, '폰트 창에 나머지 조각을 넘긴다');
console.log('OK — CRLF Markdown·여러 조각 줄 폰트 맞추기 단언 통과');

// 2026-10-15 2단계(줄 묶기): 글꼴·색이 섞인 줄은 상자 하나, 조각별 편집·문단 선택·객체 안 부분(15d)
assert.match(script, /const groupLines = \(objs\) => window\.groupLines\(objs, \{ mergeStyledRuns: true \}\)/, '화면 상자는 스타일 조각을 합친 줄 하나');
assert.match(script, /mutateWithOverflow\('\/api\/pdf\/edit-runs', \{ name, i, lines: sel\.para \? sel\.para\.map\(\(m\) => runLine\(m\.line\)\) : \[runLine\(sel\.line\)\]/, '문단·조각별 편집은 /api/pdf/edit-runs 한 번(실행 취소 한 번) — v6: 쪽 아래로 넘치면 묻고 다시 보낸다');
assert.match(script, /if \(sel\.para \|\| \(sel\.line && needsRunEdit\(sel\.line\)\)\)/, '여러 모양 줄·부분 객체·문단만 조각별 편집, 나머지는 예전 경로');
assert.match(script, /box\.ondblclick = \(e\) => \{[^}]*selectParagraph\(i, line, wrap\)/, '두 번 클릭 = 문단 선택');
assert.match(script, /e && \(e\.ctrlKey \|\| e\.metaKey\) \? \(clearMulti\(\), selectParagraph\(i, line, wrap\)\)/, 'Ctrl+클릭 = 문단 선택');
assert.match(script, /window\.groupParagraphs\(lines\)/, '문단은 text-grouping.js의 groupParagraphs로 묶는다');
assert.match(script, /if \(a < b\) parts\.push\(\{ idx: o\.idx, from: a - s \+ base, to: b - s \+ base \}\)/, '가리기 위치: 객체 안 부분은 partFrom만큼 민다');
assert.match(script, /const lineIdxs = \(line\) => \[\.\.\.new Set\(line\.objs\.map\(\(o\) => o\.idx\)\)\]/, '끌어 옮기기는 객체 번호를 한 번씩만');
assert.match(script, /글자 모양이 여러 가지인 줄입니다 — 폰트 맞추기는 줄 전체를/, '여러 모양 줄의 폰트 맞추기 안내');
console.log('OK — 2단계(조각별 편집·문단 선택·15d 부분) 단언 통과');


// 2026-10-03: 앱 이름 Retext PDF(4.0.0). 보이는 이름과 내부 식별자를 모두 새 이름으로 통일했다(기존 사용자 없음 — 호환 코드 없음).
// Store identityName만 Partner Center가 정한 옛 이름 기반 값이라 그대로 둔다
assert.strictEqual(pkg.version, '6.1.1', '버전은 6.1.1이다');
assert.strictEqual(require('../package-lock.json').version, '6.1.1', 'package-lock.json 버전도 6.1.1이다');
assert.strictEqual(pkg.productName, 'Retext PDF', 'package.json productName은 Retext PDF다');
assert.strictEqual(pkg.build.productName, 'Retext PDF', 'build.productName은 Retext PDF다');
assert.strictEqual(pkg.build.appx.displayName, 'Retext PDF', 'Store 표시 이름은 Retext PDF다');
assert.strictEqual(pkg.build.nsis.shortcutName, 'Retext PDF', '바로가기 이름은 Retext PDF다');
for (const name of [pkg.build.artifactName, pkg.build.portable.artifactName, pkg.build.nsis.artifactName, pkg.build.appx.artifactName]) {
  assert.match(name, /^Retext-PDF-\S+$/, '산출물 이름은 공백 없는 Retext-PDF-...다: ' + name);
}
assert.strictEqual(pkg.name, 'retext-pdf', '패키지 이름(name)은 retext-pdf다');
assert.strictEqual(require('../package-lock.json').name, 'retext-pdf', 'package-lock.json의 name도 retext-pdf다');
assert.strictEqual(pkg.build.appId, 'com.kindsusu.retextpdf', 'appId는 com.kindsusu.retextpdf다');
assert.strictEqual(pkg.build.appx.applicationId, 'RetextPDF', 'Store applicationId는 RetextPDF다');
assert.strictEqual(pkg.build.appx.identityName, 'susukim.EDITORKIM', 'Store identityName은 Partner Center 값(옛 이름 기반) 그대로다');
assert.doesNotMatch(mainSource, /setPath\('userData'/, 'userData 폴더를 고정하지 않는다(기본값 %APPDATA%\\Retext PDF)');
assert.match(serverSource, /path\.join\(os\.homedir\(\), '\.retext-pdf\.json'\)/, '설정 파일은 ~/.retext-pdf.json이다');
assert.match(serverSource, /process\.env\.RETEXTPDF_PORT/, '포트 환경변수는 RETEXTPDF_PORT다');
for (const [label, src] of [['index.html', html], ['preload.js', preloadSource], ['main.js', mainSource], ['server.js', serverSource], ['font-editor.js', fontEditorSource]]) {
  assert.doesNotMatch(src, /editor[^a-z]?kim|dae[p]il/i, `${label}에 옛 앱 이름(대소문자·구분자 무관)이 없다`);
}
assert.match(preloadSource, /exposeInMainWorld\('retextPdf'/, '프리로드는 window.retextPdf를 노출한다');
assert.match(html, /window\.retextPdf\.openFiles/, '화면은 window.retextPdf를 쓴다');
assert.match(html, /'retextpdf\.recent'/, '최근 파일 키는 retextpdf.recent다');
assert.match(html, /X-Retext-Pdf-Temp/, '임시 파일 헤더는 X-Retext-Pdf-Temp다');
assert.match(html, /<title>Retext PDF<\/title>/, 'index.html 제목은 Retext PDF다');
assert.match(html, /<span id="ver">Retext PDF<\/span>/, '상태줄 오른쪽 끝 브랜드는 Retext PDF다(머리줄은 없앴다)');
assert.match(html, /\$\('#ver'\)\.textContent = `Retext PDF v\$\{appVersion\}`/, '버전을 받으면 상태줄에 Retext PDF vX.Y.Z로 쓴다');
assert.match(mainSource, /title: `Retext PDF v\$\{/, '창 제목은 Retext PDF vX.Y.Z다');
console.log('OK — 앱 이름 변경(Retext PDF 6.1.1) 단언 통과');

// 4.0.1: 앱에 동봉해 첫 실행에 복사하는 샘플은 가상 안내문(독서모임_안내.md/.pdf) 두 개뿐이다.
// sample.pdf(AI 기능 시절 시험 문서)·회의록_초안.*(회사 회의록처럼 보임)은 테스트 픽스처로 저장소에만 남는다
{
  const bundled = pkg.build.files.filter((f) => f.startsWith('workspace/'));
  assert.deepStrictEqual(bundled.sort(), ['workspace/독서모임_안내.md', 'workspace/독서모임_안내.pdf'], 'build.files의 샘플은 독서모임_안내 두 개다');
  assert.ok(!pkg.build.files.some((f) => /sample\.pdf|회의록/.test(f)), 'build.files에 sample.pdf·회의록이 없다');
  const copy = serverSource.match(/const BUNDLED_SAMPLES = (\[[^\]]*\])/);
  assert.ok(copy, 'server.js에 첫 실행 복사 목록(BUNDLED_SAMPLES)이 있다');
  const list = JSON.parse(copy[1].replace(/'/g, '"'));
  assert.deepStrictEqual(list.sort(), ['독서모임_안내.md', '독서모임_안내.pdf'], '첫 실행 복사 목록은 독서모임_안내 두 개다');
  assert.match(serverSource, /for \(const name of BUNDLED_SAMPLES\)/, '기본 작업 폴더는 BUNDLED_SAMPLES를 복사한다');
  assert.doesNotMatch(serverSource, /'sample\.pdf'|'회의록_초안/, 'server.js에 옛 샘플 이름이 없다');
  for (const f of list) assert.ok(fs.existsSync(path.join(__dirname, '..', 'workspace', f)), `동봉 샘플 파일이 있다: ${f}`);
  console.log('OK — 동봉 샘플(독서모임_안내 두 개) 단언 통과');
}

// UI 개편(2026-10): 도구줄(아이콘+짧은 이름) / 상황줄 / 왼쪽 패널(파일 | 쪽) / 상태줄, 쪽 목록 여러 쪽 선택·끌어 옮기기, 단축키 도움말, 토스트 쌓기
{
  // A. 창 배치: 머리줄 없음, 도구줄은 role=toolbar, 상황줄은 도구 이름·옵션·사용법
  assert.doesNotMatch(html, /<header>/, '40px 머리줄은 없앴다 — 앱 이름·버전은 상태줄 오른쪽 끝(#ver)');
  assert.match(html, /<div class="toolbar" id="toolbar" role="toolbar" aria-label="도구 모음">/, '도구줄은 role="toolbar"다');
  assert.ok(html.indexOf('id="toolbar"') < html.indexOf('id="ctxbar"') && html.indexOf('id="ctxbar"') < html.indexOf('class="workarea"') &&
    html.indexOf('class="workarea"') < html.indexOf('id="statusbar"'), '위→아래: 도구줄 / 상황줄 / (왼쪽 패널 | 문서) / 상태줄');
  assert.match(html, /\.toolbar\{[^}]*flex-wrap:nowrap[^}]*overflow-x:auto/, '도구줄은 두 줄로 접히지 않고, 넘치면 가로로 스크롤한다');
  assert.match(html, /@media \(max-width:1180px\)\{\.toolbar\{[^}]*\}\.tb \.tl\{display:none\}/, '1180px 이하에서는 도구줄 이름을 숨기고 아이콘만');
  assert.match(script, /function fitToolbar\(\)/, '창 폭을 넘으면 도구줄을 단계적으로 줄인다(c1→c2→c3)');
  for (const id of ['printBtn', 'toolText', 'toolStamp', 'pageBlank', 'pageInsertPdf', 'pageNumbers', 'toolEdit', 'rectTool', 'helpBtn', 'zoomSelect', 'zoomIn', 'zoomOut']) {
    assert.match(html, new RegExp(`id="${id}"`), `도구줄에 #${id}가 있다`);
  }
  assert.match(html, /<div class="ctxbar" id="ctxbar">[\s\S]*?<select id="maskColor"/, '가림 색(#maskColor)은 상황줄에 있다');
  assert.match(html, /id="ctxTextOpts"/, '글 상자 옵션 자리(#ctxTextOpts)가 있다(WP-C가 채운다)');
  assert.match(html, /id="ctxStampOpts"/, '도장 옵션 자리(#ctxStampOpts)가 있다(WP-C가 채운다)');
  assert.match(html, /id="ctxMulti"/, '여러 상자 선택 동작은 상황줄에 있다');
  assert.doesNotMatch(script, /bar\.id = 'multiBar'/, '떠 있는 #multiBar는 없앴다');
  assert.match(script, /const HINTS = \{[\s\S]*?edit: '고칠 줄을 클릭하세요\. 여러 줄은 Shift\+클릭'[\s\S]*?redact: '가릴 곳을 끌어서 감싸세요/, '상황줄 사용법 문구는 HINTS 한 곳에 있다');
  assert.match(script, /function setTool\(name\)/, '도구는 setTool 하나로 바꾼다(서로 배타)');
  assert.match(html, /data-tool="edit" aria-pressed="true"/, '도구 버튼은 aria-pressed로 켜짐을 알린다');
  assert.match(script, /\{ KeyE: 'edit', KeyT: 'text', KeyS: 'stamp', KeyW: 'redact' \}\[e\.code\]/, '도구 단축키 E·T·S·W(한글 입력 상태에서도 e.code로)');
  assert.match(script, /if \(e\.key === 'Escape'\) \{ if \(tool !== 'edit'\) setTool\('edit'\)/, 'Esc는 글자 고치기로 돌아간다');
  assert.match(script, /const isTyping = \(el\) => !!el && \(el\.isContentEditable \|\| \/\^\(INPUT\|TEXTAREA\|SELECT\)\$\/\.test\(el\.tagName\)\)/, '입력 중에는 한 글자 단축키를 무시한다');

  // WP-C 연결 지점: 한 블록에 모여 있고, 모두 서버 기능에 연결됐다("준비 중입니다"가 남지 않는다)
  const scriptLF = script.replace(/\r\n/g, '\n'); // 줄 끝(CRLF/LF)과 무관하게 함수 몸통을 자른다
  const wpc = scriptLF.slice(scriptLF.indexOf('// === WP-C 연결 지점 ==='), scriptLF.indexOf('// === WP-C 연결 지점 끝 ==='));
  assert.ok(wpc.length > 100, 'WP-C 연결 지점 블록이 있다');
  const fnBody = (sig) => { const k = wpc.indexOf(sig); return wpc.slice(k, wpc.indexOf('\n}\n', k)); };
  for (const sig of ['function onPrint()', 'function onPageBlank(at)', 'function onPageDuplicate(pages)', 'function onInsertPdfAt(at, paths)',
    'function onPageNumbers()', 'function onToolActivate(name)', 'function onToolDeactivate(name)', 'function onToolPageClick(name, i, pt)']) {
    assert.ok(wpc.includes(sig), `WP-C 연결 지점에 ${sig}가 있다`);
    assert.strictEqual(script.split(sig).length, 2, `${sig}는 한 번만 정의된다`);
    assert.doesNotMatch(fnBody(sig), /notReady|준비 중입니다/, `${sig}는 자리만 차지하지 않는다`);
  }
  assert.doesNotMatch(html, /준비 중입니다|notReady/, '"준비 중입니다" 자리 표시가 남지 않았다');
  assert.match(fnBody('async function onPrint()'), /window\.retextPdf\?\.print[\s\S]*printInBrowser\(name, pages\)/, '인쇄: 앱은 retextPdf.print, 브라우저 화면은 숨은 iframe');
  assert.match(script, /'\/api\/pdf\/print-html\?' \+ q[\s\S]{0,900}contentWindow\.printReady[\s\S]{0,200}contentWindow\.print\(\)/, '브라우저 화면 인쇄는 print-html을 iframe에 열어 printReady 뒤 print()');
  assert.match(script, /toast\('인쇄 준비 중…'/, '인쇄 준비 중 토스트');
  assert.match(script, /sel\.length > 1 && sel\.length < pdfPages\.length\) \{\s*const pick = await askPrintRange\(sel\)/, '여러 쪽을 골랐으면 고른 쪽만/전체를 묻는다');
  assert.match(html, /<dialog id="printDialog" class="panel"/, '인쇄 범위 창');
  assert.match(fnBody('async function onPageBlank(at)'), /pdfMutate\('\/api\/pdf\/pages\/blank', \{ name, at \}\)[\s\S]*showAddedPages\(\[r\.at\]/, '[빈 쪽] → /api/pdf/pages/blank, 새 쪽을 고른다');
  assert.match(fnBody('async function onPageDuplicate(pages)'), /pdfMutate\('\/api\/pdf\/pages\/duplicate', \{ name, pages \}\)[\s\S]*showAddedPages\(r\.pages/, '[복제] → /api/pdf/pages/duplicate, 사본을 고른다');
  assert.match(fnBody('async function onInsertPdfAt(at, paths)'), /window\.retextPdf\.openPdfFiles\(\)[\s\S]*for \(const p of paths\)[\s\S]*\/api\/pdf\/pages\/insert-pdf/, 'PDF 끼워 넣기: 파일 선택 → 여러 개면 순서대로');
  assert.match(script, /async function showAddedPages\(idxs, label, undoSteps = 1\) \{[\s\S]{0,200}pageSel\.add\(k\)[\s\S]{0,200}await renderPdfDoc\(cur\)[\s\S]{0,300}action: '실행 취소'/, '쪽을 더하면 다시 그리고 새 쪽을 고르고 실행 취소 토스트');
  assert.match(script, /pdfMutate\('\/api\/pdf\/textbox', payload\)/, '글 상자 → /api/pdf/textbox');
  assert.match(script, /pdfMutate\('\/api\/pdf\/stamp', \{ name, i, id: s\.id, x, y, w, h \}\)/, '도장 → /api/pdf/stamp(누른 자리 가운데)');
  assert.match(script, /if \(hit\) selectImage\(i, hit\.obj/, '찍은 도장은 기존 이동·크기 손잡이로 고른다');
  assert.match(script, /if \(e\.isComposing \|\| e\.keyCode === 229\) return; \/\/ 한글 조합 중의 Enter·Esc/, '글 상자는 한글 조합 중에 넣거나 취소하지 않는다');
  assert.match(script, /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)\) \{ e\.preventDefault\(\); d\.commit\(\); \}/, '글 상자: Ctrl+Enter로 넣는다(Enter는 줄 바꿈)');
  assert.match(script, /ta\.style\.fontSize = \(Math\.max\(1, \+\$\('#tbSize'\)\.value \|\| 12\) \* pdfScale\) \+ 'px'/, '글 상자 입력칸 글자 크기 = 크기 × 확대 비율');
  assert.match(script, /fetch\('\/api\/fonts\?text='/, '글 상자 글꼴 목록은 /api/fonts');
  for (const id of ['tbFont', 'tbSize', 'tbColor', 'stampList', 'stampAdd', 'stampFile']) assert.match(html, new RegExp(`id="${id}"`), `상황줄 글 상자·도장 옵션 #${id}`);
  assert.match(script, /fetch\('\/api\/stamps'\)/, '도장 보관함 목록');
  assert.match(script, /'\/api\/stamps\/image\?id='/, '도장 축소본');
  assert.match(script, /window\.retextPdf\?\.openImage\) \{ const p = await window\.retextPdf\.openImage\(\); if \(p\) await addStampFrom\(\{ path: p \}\)/, '도장 추가(앱): openImage → 경로');
  assert.match(script, /readAsDataURL\(f\)[\s\S]{0,400}addStampFrom\(\{ name: [\s\S]{0,60}, data \}\)/, '도장 추가(브라우저 화면): 파일 → base64');
  assert.match(script, /apiPost\('\/api\/stamps\/delete', \{ id: s\.id \}\)/, '도장 지우기');
  assert.match(script, /stampEmpty: '도장 그림\(PNG·JPEG\)을 추가하세요\. 투명 PNG면 글자 위에 찍어도 글자가 보입니다\.'/, '빈 보관함 안내');

  // 암호 PDF: 암호 창(type=password) → /api/pdf/unlock. 틀리면 창 안에 "암호가 맞지 않습니다". 암호는 어디에도 남기지 않는다
  assert.match(html, /<dialog id="passwordDialog" class="panel"/, '암호 창');
  assert.match(html, /<input id="passwordInput" type="password" autocomplete="off"/, '암호 입력칸은 type=password, 자동 완성 없음');
  assert.match(html, /id="passwordError"[^>]*>암호가 맞지 않습니다</, '틀린 암호 안내');
  const ask = scriptLF.slice(scriptLF.indexOf('function askPdfPassword(name)'), scriptLF.indexOf('\n}\n', scriptLF.indexOf('function askPdfPassword(name)')));
  assert.ok(ask.length > 200, 'askPdfPassword가 있다');
  assert.match(ask, /fetch\('\/api\/pdf\/unlock', \{ method: 'POST', body: JSON\.stringify\(\{ name, password: input\.value \}\) \}\)/, '암호는 /api/pdf/unlock 요청 본문으로만 보낸다');
  assert.match(ask, /data\.wrong \? '암호가 맞지 않습니다'/, '틀리면 창을 연 채 안내');
  assert.match(ask, /input\.value = ''/, '끝나면 입력칸을 비운다');
  assert.doesNotMatch(ask, /localStorage|sessionStorage|console\.|indexedDB|document\.cookie/, '암호 창은 저장소·로그를 건드리지 않는다');
  assert.doesNotMatch(script, /(localStorage|sessionStorage)\.setItem\([^)]*(password|passwordInput|암호)/i, '암호를 localStorage·sessionStorage에 쓰지 않는다');
  assert.doesNotMatch(script, /console\.\w+\([^)]*password/i, '암호를 로그에 남기지 않는다');
  assert.match(script, /if \(info\.needPassword\) \{[\s\S]{0,200}await askPdfPassword\(name\)/, 'PDF를 열 때 401 needPassword면 암호 창');
  assert.match(script, /return r\.ok \|\| r\.status === 401 \|\| r\.status === 413;/, '최근 파일 확인에서 암호 PDF(401)를 "없는 파일"로 지우지 않는다');
  assert.match(script, /'암호를 풀고 열었습니다\. 저장하면 암호 없는 사본이 됩니다\.'/, '암호를 풀고 연 문서 안내');
  assert.match(script, /'편집 제한을 풀고 열었습니다\./, '편집 제한을 풀고 연 문서 안내');
  assert.match(script, /if \(error\.data\?\.needSaveAs && cur === name\) return saveProtected\(name, error\.data\)/, '저장 409 needSaveAs → 다른 이름으로 저장으로');
  assert.match(script, /throw Object\.assign\(new Error\(message\), \{ status: r\.status, data \}\)/, 'apiPost 예외는 응답 표시(needSaveAs 등)를 싣는다');

  // 쪽 번호 창: 모양 4가지(보기 글), 위치 5가지, 크기·여백·시작 번호·첫 쪽 건너뛰기·색, [넣기]/[번호 지우기]/[취소]. 고른 값은 기억한다
  assert.match(html, /<dialog id="pageNumDialog" class="panel"/, '쪽 번호 창');
  for (const v of ['n', 'n/N', 'dash', 'ko']) assert.ok(html.includes(`<input type="radio" name="pnFormat" value="${v}">`), `쪽 번호 모양 ${v}`);
  for (const v of ['bottom-center', 'bottom-right', 'bottom-left', 'top-center', 'top-right']) assert.ok(html.includes(`<option value="${v}">`), `쪽 번호 위치 ${v}`);
  for (const id of ['pnSize', 'pnMargin', 'pnStart', 'pnSkipFirst', 'pnColor', 'pnApply', 'pnRemove', 'pnCancel']) assert.match(html, new RegExp(`id="${id}"`), `쪽 번호 창 #${id}`);
  assert.match(html, /id="pnApply" class="pri" type="button">넣기</, '[넣기]');
  assert.match(html, /id="pnRemove" type="button">번호 지우기</, '[번호 지우기]');
  assert.match(script, /pdfMutate\('\/api\/pdf\/page-numbers', \{ name, \.\.\.o \}\)/, '쪽 번호 → /api/pdf/page-numbers');
  assert.match(script, /pdfMutate\('\/api\/pdf\/page-numbers\/remove', \{ name \}\)/, '번호 지우기 → /api/pdf/page-numbers/remove');
  assert.match(script, /localStorage\.setItem\('retextpdf\.pageNumbers'/, '쪽 번호 설정을 기억한다');
  {
    const lbl = new Function(`${script.match(/const pnLabel = [^\n]+/)[0]}; return pnLabel;`)();
    assert.deepStrictEqual(['n', 'n/N', 'dash', 'ko'].map((f) => lbl(f, 1, 12)), ['1', '1 / 12', '- 1 -', '1쪽'], '쪽 번호 모양 보기 글이 서버 형식과 같다');
  }

  // 숨은 메뉴 없음: [문서 ▾] 드롭다운을 없애고 병합·이미지로·용량 줄이기·분할을 각각 아이콘+이름 버튼으로. [그림]은 도구 묶음, 돌리기 이름은 왼쪽/오른쪽
  assert.doesNotMatch(html, /id="menuDoc"|openDocMenu|data-icon="docMenu"|문서 ▾/, '[문서 ▾] 드롭다운은 없다');
  const groupDoc = html.slice(html.indexOf('id="groupDoc"'), html.indexOf('</div>', html.indexOf('id="groupDoc"')));
  for (const id of ['menuMerge', 'menuExportImages', 'menuDownsample', 'menuSplit']) assert.ok(groupDoc.includes(`id="${id}"`), `문서 묶음에 #${id} 버튼이 있다`);
  assert.match(script, /\$\('#menuMerge'\)\.onclick = openMergeDialog/, '[병합] → 병합 창');
  assert.match(script, /\$\('#menuExportImages'\)\.onclick = \(\) => \(pdfIsOpen\(\) \? openExportImagesDialog\(\) : exportImagesFromFile\(\)\)/, '[이미지로]: 문서가 없으면 파일을 골라 내보낸다');
  assert.match(script, /\$\('#menuDownsample'\)\.onclick = \(\) => \(pdfIsOpen\(\) \? openDownsampleDialog\(\) : openDownsampleFilesDialog\(\)\)/, '[용량 줄이기]: 문서가 없으면 여러 파일 용량 줄이기');
  assert.match(html, /id="menuSplit" data-icon="split" data-modes="pdf"/, '[분할]은 PDF를 열었을 때만 보인다');
  // 아이콘: 22px·같은 굵기, 병합·끼워 넣기·분할·용량 줄이기·이미지로·암호는 서로 다른 그림
  assert.match(html, /\.tb svg\{width:22px;height:22px;[^}]*stroke-width:1\.8/, '도구줄 아이콘은 22px, 선 굵기 1.8');
  const icons = {};
  for (const k of ['merge', 'pageInsertPdf', 'split', 'downsample', 'exportImages', 'insertImage', 'lock']) {
    const m = script.match(new RegExp(`\\n  ${k}: '([^']+)'`));
    assert.ok(m, `아이콘 ${k}가 있다`); icons[k] = m[1];
  }
  assert.strictEqual(new Set(Object.values(icons)).size, Object.keys(icons).length, '문서·쪽 도구 아이콘은 모두 다른 그림이다');
  const groupTool = html.slice(html.indexOf('id="groupTool"'), html.indexOf('</div>', html.indexOf('id="groupTool"')));
  assert.ok(groupTool.includes('id="menuInsertImage"'), '[그림]은 도구 묶음에 있다');
  assert.match(script, /\$\('#printBtn'\)\.onclick = \(\) => onPrint\(\)/, '[인쇄] → onPrint');
  assert.match(script, /\$\('#pageBlank'\)\.onclick = \(\) => onPageBlank\(currentPageIndex\(\) \+ 1\)/, '[빈 쪽] → onPageBlank(현재 쪽 뒤)');
  assert.match(script, /\$\('#pageInsertPdf'\)\.onclick = \(\) => onInsertPdfAt\(currentPageIndex\(\) \+ 1, null\)/, '[PDF 끼워 넣기] → onInsertPdfAt(현재 쪽 뒤, null)');
  assert.match(script, /\$\('#pageNumbers'\)\.onclick = \(\) => onPageNumbers\(\)/, '[쪽 번호] → onPageNumbers');
  for (const item of ["menuItem('복제', () => onPageDuplicate(idxs))", "menuItem('앞에 빈 쪽', () => onPageBlank(first))", "menuItem('뒤에 빈 쪽', () => onPageBlank(last + 1))",
    "menuItem('PDF 끼워 넣기…', () => onInsertPdfAt(last + 1, null))", "menuItem('따로 저장…', () => savePagesAs(idxs)", "menuItem('지우기', deleteSelectedPages"]) {
    assert.ok(script.includes(item), `쪽 우클릭 메뉴: ${item}`);
  }

  // B. 왼쪽 패널: PDF는 쪽 목록, Markdown은 파일 목록. 축소본은 보이는 것만(IntersectionObserver)
  assert.match(script, /showAsideTab\(view\?\.aside \|\| \(isPdf \? 'page' : 'file'\)\)/, 'PDF를 열면 쪽 목록, Markdown을 열면 파일 목록(탭으로 돌아오면 그 탭에서 보던 패널)');
  assert.match(script, /new IntersectionObserver\([\s\S]{0,200}root: \$\('#pageThumbs'\)/, '축소본은 목록에 보이는 것만 그린다');
  assert.match(script, /const THUMB_W = 140/, '축소본 폭 140px');
  assert.match(html, /<div id="pageThumbs" tabindex="0" role="listbox" aria-multiselectable="true"/, '쪽 목록은 키보드로 움직일 수 있는 여러 선택 목록이다');
  assert.match(script, /e\.key === 'Delete'\) \{ e\.preventDefault\(\); deleteSelectedPages\(\); \}/, 'Delete로 고른 쪽을 지운다');
  assert.match(script, /function deleteSelectedPages\(\)[\s\S]{0,500}runDeletePages\(idxs, '쪽 지우기'\)/, '쪽 지우기는 기존 삭제 흐름(실행 취소 토스트 포함)을 쓴다');
  assert.match(script, /`\$\{pageDrag\.pages\.length\}쪽 옮기기`/, '끌 때 "N쪽 옮기기" 꼬리표');
  assert.match(script, /function autoScrollThumbs\(clientY\)/, '목록 위·아래 끝에서 저절로 스크롤');
  assert.match(script, /onInsertPdfAt\(at, paths\);/, '쪽 목록에 PDF 파일을 놓으면 그 자리에 끼워 넣는다');
  assert.match(script, /for \(const type of \['dragenter', 'dragleave'\]\)[\s\S]{0,200}e\.stopPropagation\(\)/, '쪽 목록 위의 파일 끌기는 창 전체 "놓아서 열기"를 띄우지 않는다');
  assert.match(script, /if \(!isFileDrag\(e\)\) return; dragCounter\+\+/, '쪽 축소본 끌기(파일 아님)는 "놓아서 열기" 오버레이를 띄우지 않는다');
  // 끌어 옮기기의 새 순서 계산을 실제로 돌려 본다(reorder 라우트는 전체 순서를 받는다)
  const src = script.match(/function computeMoveOrder\(n, moving, at\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(src, 'computeMoveOrder가 있다');
  const computeMoveOrder = new Function(`${src}; return computeMoveOrder;`)();
  assert.deepStrictEqual(computeMoveOrder(5, [0], 3), [1, 2, 0, 3, 4], '1쪽을 4쪽 앞으로');
  assert.deepStrictEqual(computeMoveOrder(5, [4], 0), [4, 0, 1, 2, 3], '5쪽을 맨 앞으로');
  assert.deepStrictEqual(computeMoveOrder(5, [1, 3], 5), [0, 2, 4, 1, 3], '2·4쪽을 맨 뒤로(원래 순서 유지)');
  assert.deepStrictEqual(computeMoveOrder(5, [3, 1], 0), [1, 3, 0, 2, 4], '선택 순서와 무관하게 원래 순서대로 모은다');
  assert.deepStrictEqual(computeMoveOrder(4, [1, 2], 2), [0, 1, 2, 3], '제 자리에 놓으면 그대로');
  assert.match(script, /await pdfMutate\('\/api\/pdf\/pages\/reorder', \{ name: cur, order \}\)/, '끌어 옮기기는 기존 reorder 라우트에 전체 순서를 보낸다');

  // C·D. 상태줄(쪽 · 파일 · 저장 상태 · 버전), 확대 목록
  assert.match(html, /<span id="saveState" hidden><span id="dirty" hidden>●<\/span><span id="saveText"><\/span><\/span>/, '상태줄 저장 상태(● + 글)');
  assert.match(script, /\$\('#saveText'\)\.textContent = d \? '고친 내용 있음' : '저장됨'/, '저장 상태 문구');
  for (const pct of [50, 75, 100, 125, 150, 200, 300, 400]) assert.match(html, new RegExp(`<option value="[\\d.]+">${pct}%</option>`), `확대 목록에 ${pct}%`);
  assert.match(html, /<option value="fitPage">쪽 전체 보기<\/option>/, '확대 목록에 쪽 전체 보기');
  assert.match(script, /else if \(e\.key === '1'\) \{ e\.preventDefault\(\); fitPage\(\); \}/, 'Ctrl+1 = 쪽 전체 보기');
  assert.match(script, /else if \(e\.key === '0'\) \{ e\.preventDefault\(\); fitWidth\(\); \}/, 'Ctrl+0 = 폭 맞춤(그대로)');
  assert.doesNotMatch(html, /id="zoomRange"|id="zoomPct"/, '상태줄 확대 슬라이더(중복)는 없앴다');

  // E. 단축키 도움말: SHORTCUTS 배열 하나가 도움말과 버튼 설명을 함께 만든다
  assert.match(html, /<dialog id="shortcutsDialog"/, '단축키 도움말 창');
  assert.match(script, /const SHORTCUTS = \[/, 'SHORTCUTS 배열');
  assert.match(script, /e\.key === 'F1' \|\| \(mod && !e\.altKey && \(e\.key === '\/' \|\| e\.code === 'Slash'\)\)/, 'Ctrl+/ · F1로 연다');
  assert.match(script, /b\.title = withShortcut\(b\.id, tip\)/, '도구줄 버튼 설명의 단축키는 SHORTCUTS에서 붙인다');
  assert.match(html, /kbd\{/, '<kbd> 모양');

  // G. 접근성: 아이콘 버튼 이름, 포커스 테두리
  assert.match(script, /b\.setAttribute\('aria-label', full \|\| label \|\| tip\)/, '아이콘 버튼은 aria-label을 가진다(이름을 숨겨도 읽히고, 줄인 이름 대신 설명의 온전한 이름을 읽는다)');
  assert.match(html, /:focus-visible\{outline:2px solid var\(--acc\)/, ':focus-visible 테두리');
  // 아이콘은 직접 그린 인라인 SVG — 외부 아이콘 세트·CDN 없음
  assert.match(script, /const ICONS = \{/, '인라인 SVG 아이콘');
  assert.doesNotMatch(html, /lucide|<link[^>]+href="https?:/i, '외부 아이콘 세트·외부 스타일시트를 쓰지 않는다');
  console.log('OK — UI 개편(도구줄·상황줄·쪽 목록·단축키·토스트) 단언 통과');
}

// 밝은 아이보리 테마 · 쪽 기준 보기(쪽 전체 보기 기본) · 암호 걸기(2026-10)
{
  const scriptLF = script.replace(/\r\n/g, '\n');
  const fnBody = (sig) => { const k = scriptLF.indexOf(sig); assert.ok(k >= 0, `${sig}가 있다`); return scriptLF.slice(k, scriptLF.indexOf('\n}\n', k)); };
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // A. 테마 토큰: 밝은 색만, 어두운 바탕 토큰·하드코딩 색이 남지 않는다
  const root = css.match(/:root\{([^}]*)\}/)?.[1];
  assert.ok(root, ':root 토큰이 있다');
  assert.match(root, /color-scheme:light/, 'color-scheme: light');
  const tok = Object.fromEntries([...root.matchAll(/--([\w-]+):(#[0-9a-f]{3,8})/gi)].map((m) => [m[1], m[2]]));
  const lum = (hex) => {
    const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : hex.slice(0, 7);
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const k of ['bg', 'panel', 'panel2', 'hover', 'sel', 'input', 'btn', 'docBg']) {
    assert.ok(tok[k], `바탕 토큰 --${k}가 있다`);
    assert.ok(lum(tok[k]) > 0.6, `--${k}(${tok[k]})는 밝은 바탕이다(어두운 테마 토큰이 남지 않았다)`);
  }
  assert.ok(lum(tok.panel) > 0.9, `창 틀(--panel ${tok.panel})은 거의 흰 아이보리다`);
  assert.ok(lum(tok.docBg) < lum(tok.panel) - 0.15 && lum(tok.docBg) > 0.6, `문서 영역 바탕(--docBg ${tok.docBg})은 흰 쪽이 또렷한 옅은 회색이다`);
  for (const [fg, bgs] of [['fg', ['panel', 'panel2', 'hover', 'sel']], ['mut', ['panel', 'panel2', 'hover', 'input']], ['accText', ['panel', 'panel2', 'hover', 'sel', 'input']], ['badText', ['panel', 'input']]]) {
    for (const b of bgs) assert.ok(contrast(tok[fg], tok[b]) >= 4.5, `--${fg} 글자 on --${b}: 대비 ${contrast(tok[fg], tok[b]).toFixed(2)} ≥ 4.5`);
  }
  assert.ok(contrast('#ffffff', tok.accStrong) >= 4.5, '주 버튼(흰 글자 on --accStrong) 대비 ≥ 4.5');
  assert.match(css, /button\.pri\{background:var\(--accStrong\)/, '주 버튼은 진한 강조색 바탕');
  assert.match(css, /\.pdf\{[^}]*background:var\(--docBg\)/, 'PDF 쪽 뒤 바탕은 옅은 회색(--docBg)');
  assert.match(css, /\.pdfPage\{[^}]*background:var\(--paper\)[^}]*box-shadow:/, '쪽은 흰 종이에 부드러운 그림자');
  const darkHex = /#(1b1b1f|232329|1f1f25|2c2c34|34343e|2e2e37|3a3a45|33333b|3a3a40|2b2b33|4a4a55|2f2f38|4a3418|6b4c22)\b|#000[0-9a-f]\b|#000[0-9a-f]{2}\b|#f4b9a2|#f0a0a0/i;
  assert.doesNotMatch(html, darkHex, '어두운 테마의 하드코딩 색(#1b1b1f·#2e2e37·#000a 등)이 index.html에 남지 않는다');
  // :root 밖의 CSS는 색을 토큰으로 쓴다(종이 흰색·검색 강조·의미 색 등 몇 가지 예외만). v6 Wave C 어두운 테마 토큰 칸(:root[data-theme="dark"])도 토큰이다
  const outside = css.replace(/:root\{[^}]*\}/, '').replace(/:root\[data-theme="dark"\]\{[^}]*\}/, '').match(/#[0-9a-f]{3,8}\b/gi) || [];
  for (const c of outside) assert.ok(['#fff', '#ccc', '#e6e3dc', '#2f74c0', '#1d5fa8'].includes(c.toLowerCase()), `토큰 밖 하드코딩 색 ${c}는 허용 목록에 있다`);
  // v6 Wave C 어두운 테마: 같은 토큰 이름을 모두 다시 정하고, 바탕은 어둡고(쪽은 흰 종이 그대로) 글자 대비는 밝은 테마와 같은 기준(≥ 4.5)
  const darkRoot = css.match(/:root\[data-theme="dark"\]\{([^}]*)\}/)?.[1];
  assert.ok(darkRoot, '어두운 테마 토큰 칸 :root[data-theme="dark"]이 있다');
  assert.match(darkRoot, /color-scheme:dark/, '어두운 테마는 color-scheme: dark(입력칸·스크롤 막대도 어둡게)');
  const dtok = Object.fromEntries([...darkRoot.matchAll(/--([\w-]+):(#[0-9a-f]{3,8})/gi)].map((m) => [m[1], m[2]]));
  for (const k of Object.keys(tok)) assert.ok(dtok[k], `어두운 테마도 --${k}를 정한다`);
  for (const k of ['bg', 'panel', 'panel2', 'hover', 'sel', 'input', 'btn', 'docBg', 'tabBar']) assert.ok(lum(dtok[k]) < 0.08, `어두운 테마 --${k}(${dtok[k]})는 어두운 바탕이다`);
  assert.ok(lum(dtok.docBg) > lum(dtok.panel), `어두운 테마의 문서 뒤 바탕(--docBg ${dtok.docBg})은 창 틀보다 조금 밝은 짙은 회색`);
  assert.strictEqual(dtok.paper.toLowerCase(), '#fff', '어두운 테마에서도 쪽은 흰 종이');
  const fgPairs = [['fg', ['panel', 'panel2', 'hover', 'sel', 'input', 'btn', 'tabBar']], ['mut', ['panel', 'panel2', 'hover', 'input', 'tabBar']], ['accText', ['panel', 'panel2', 'hover', 'sel', 'input']], ['badText', ['panel', 'input']], ['bannerFg', ['bannerBg']]];
  for (const [theme, T] of [['밝은', tok], ['어두운', dtok]]) {
    for (const [fg, bgs] of fgPairs) for (const b of bgs) assert.ok(contrast(T[fg], T[b]) >= 4.5, `${theme} 테마 --${fg} 글자 on --${b}: 대비 ${contrast(T[fg], T[b]).toFixed(2)} ≥ 4.5`);
    assert.ok(contrast('#ffffff', T.accStrong) >= 4.5, `${theme} 테마 주 버튼(흰 글자 on --accStrong) 대비 ≥ 4.5`);
    assert.ok(contrast(T.paperInk, T.paper) >= 4.5, `${theme} 테마 쪽 글자 대비`);
  }
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const bg = mainSrc.match(/const WINDOW_BG = \{ light: '([^']+)', dark: '([^']+)' \};/);
  assert.ok(bg, 'main.js가 테마별 창 바탕색을 둔다');
  assert.strictEqual(bg[1], tok.panel, '창 배경(시작할 때 깜빡임) = 밝은 --panel(아이보리)');
  assert.strictEqual(bg[2], dtok.panel, '어두운 테마 창 배경 = 어두운 --panel');
  assert.match(mainSrc, /backgroundColor: WINDOW_BG\[resolvedTheme\(themePref\)\]/, '창을 만들 때 기억한 테마의 바탕색');
  assert.match(mainSrc, /ipcMain\.handle\('setTheme'[\s\S]{0,200}nativeTheme\.themeSource = pref;[\s\S]{0,120}win\.setBackgroundColor\(WINDOW_BG\[resolvedTheme\(pref\)\]\)/, '테마를 바꾸면 nativeTheme·창 바탕색도 바꾼다');
  assert.match(preloadSource, /setTheme: \(pref\) => ipcRenderer\.invoke\('setTheme', pref\)/, '프리로드가 setTheme을 노출한다');
  assert.match(html, /<script>try \{ const t = localStorage\.getItem\('retextpdf\.theme'\);[^<]*prefers-color-scheme: dark[^<]*<\/script>/, '첫 그리기 전에 테마를 정한다(번쩍임 없음)');

  // B. 쪽 기준 보기: PDF를 열면 쪽 전체 보기, 맞춤 방식이면 크기가 바뀔 때 다시 맞추고, %를 고르면 그 문서 동안 유지
  assert.match(script, /let zoomMode = 'fitPage';/, '확대 방식 기본 = 쪽 전체 보기');
  assert.match(fnBody('async function open(name'), /zoomMode = 'fitPage';/, '문서를 열 때마다 쪽 전체 보기로 시작한다');
  assert.match(fnBody('async function renderPdfDoc(name'), /if \(zoomMode !== 'manual' && pdfPages\.length\) pdfScale = fitScale\(zoomMode, keepPage\);[\s\S]*buildPages\(name, pdfScale\)/, '그리기 전에 맞춤 배율을 잰다');
  assert.match(fnBody('function fitScale('), /Math\.min\(w \/ p\.w, h \/ p\.h\)/, '쪽 전체 보기 = 폭·높이가 모두 들어가는 배율');
  assert.match(fnBody('function fitScale('), /Math\.floor\(s \* 100\) \/ 100/, '맞춤 배율은 내려서(쪽 아래가 잘리지 않게)');
  assert.match(script, /new ResizeObserver\([\s\S]{0,200}if \(zoomMode === 'manual'\) return;[\s\S]{0,300}fitPage\(true\); else fitWidth\(\);[\s\S]{0,40}\.observe\(\$\('#pdf'\)\)/, '맞춤 방식이면 문서 영역 크기가 바뀔 때 다시 맞춘다');
  assert.match(fnBody('function zoomTo('), /zoomMode = 'manual'; applyZoom\(next, anchor\)/, '%로 바꾸면 맞춤을 끄고 그 배율을 유지한다');
  for (const re of [/zoomTo\(\+v\)/, /if \(next != null\) zoomTo\(next\)/, /e\.preventDefault\(\);\s*zoomTo\(pdfScale \* Math\.max\(0\.8/, /zoomTo\(pdfScale \* 1\.1\)/, /zoomTo\(pdfScale \/ 1\.1\)/]) assert.match(script, re, `% 확대 경로는 zoomTo를 거친다: ${re}`);
  assert.doesNotMatch(script, /retextpdf\.zoom/, '확대 비율을 실행 사이에 기억하지 않는다(문서마다 쪽 전체 보기로 시작)');
  assert.match(fnBody('function showZoom()'), /if \(zoomMode === 'fitPage' \|\| zoomMode === 'fitWidth'\) \{ sel\.value = zoomMode;/, '확대 목록은 "쪽 전체 보기"·"폭 맞춤"을 그대로 보인다');
  assert.match(html, /<select id="zoomSelect"[^>]*>\s*<option value="fitPage">쪽 전체 보기<\/option><option value="fitWidth">폭 맞춤<\/option>/, '확대 목록 맨 위에 쪽 전체 보기 · 폭 맞춤');
  assert.match(fnBody('function goToPage(idx)'), /el\.scrollTop = pageTop\(/, '쪽 이동은 그 쪽 맨 위를 위 여백 바로 아래에 맞춘다');
  assert.match(css, /\.pdf\{[^}]*overflow-y:scroll/, '세로 스크롤 막대를 늘 두어 맞춤 폭이 흔들리지 않는다');
  assert.match(css, /\.pdfPage\{[^}]*display:block;margin:0 auto 20px/, '쪽은 한 줄에 한 장, 쪽 사이 간격 = 위 여백');
  // 확대 묶음은 상태줄 오른쪽 끝(도구줄 이름이 1366px에서 다 보이게)
  const sb = html.slice(html.indexOf('<div class="statusbar" id="statusbar">'), html.indexOf('<div id="dropOverlay"'));
  assert.ok(sb.includes('id="pdfZoom"') && sb.indexOf('id="pdfZoom"') < sb.indexOf('id="ver"'), '확대 묶음(− 목록 +)은 상태줄 오른쪽 끝, 버전 앞');
  assert.ok(!html.slice(html.indexOf('id="toolbar"'), html.indexOf('id="ctxbar"')).includes('id="zoomSelect"'), '도구줄에는 확대 목록이 없다');

  // C. 암호 걸기: [암호] 버튼 → 창(암호·확인·보기·제한·소유자 암호) → saveAs → /api/pdf/protect. 암호는 어디에도 남기지 않는다
  assert.match(html, /<button type="button" class="tb" id="protectBtn" data-icon="lock" data-modes="pdf"[^>]*><span class="tl">암호<\/span><\/button>/, '[암호] 버튼(자물쇠)');
  // P9 리본: [암호]는 [보안] 탭의 첫 묶음으로 옮겼다(개인정보 찾기·여러 쪽 가리기·숨은 데이터 제거와 같은 탭)
  const groupSecurity = html.slice(html.indexOf('id="groupSecurity"'), html.indexOf('</div>', html.indexOf('id="groupSecurity"')));
  assert.ok(groupSecurity.includes('id="protectBtn"'), '[암호]는 보안 탭 묶음에 있다');
  assert.ok(html.indexOf('id="groupSecurity"') > html.indexOf('id="rpanel-security"'), '보안 묶음은 [보안] 탭 패널 안에 있다');
  assert.match(html, /<dialog id="protectDialog" class="panel"/, '암호 걸기 창');
  for (const id of ['protectPw', 'protectPw2', 'protectOwner']) assert.match(html, new RegExp(`<input id="${id}" type="password" autocomplete="off"`), `#${id}는 type=password, 자동 완성 없음`);
  for (const [id, label] of [['protectPrint', '인쇄 허용'], ['protectCopy', '글자 복사 허용'], ['protectModify', '수정 허용']]) assert.match(html, new RegExp(`<input type="checkbox" id="${id}" checked>${label}`), `제한: ${label}(기본 켜짐)`);
  assert.match(html, /<legend>제한 \(선택\)<\/legend>/, '제한 (선택) 묶음');
  assert.match(html, /id="protectOwnerRow" hidden[\s\S]{0,500}비우면 임의로 만듭니다/, '소유자 암호 칸(제한을 풀 때만, 비우면 임의로)');
  assert.match(html, /id="protectShow" class="eyeBtn" data-icon="eye"/, '암호 보기 단추');
  assert.match(html, /id="protectError" class="bad" role="alert" hidden>두 암호가 다릅니다</, '두 암호가 다르면 창 안에 알린다');
  assert.match(html, /id="protectOk" class="pri" type="submit">암호 걸어 저장…</, '[암호 걸어 저장…]');
  assert.match(html, /id="protectCancel" type="button">취소</, '[취소]');
  assert.match(html, /id="protectNameRow" hidden[\s\S]{0,200}id="protectName" type="text"/, '브라우저 화면용 파일 이름 칸');
  assert.match(script, /\$\('#protectBtn'\)\.onclick = openProtectDialog/, '[암호] → 암호 걸기 창');
  const submitStart = scriptLF.indexOf("$('#protectForm').onsubmit");
  const submit = scriptLF.slice(submitStart, scriptLF.indexOf('\n};\n', submitStart));
  assert.ok(submit.length > 300, '암호 걸기 제출 처리가 있다');
  assert.match(submit, /if \(pw !== \$\('#protectPw2'\)\.value\) \{ showProtectError\('두 암호가 다릅니다'\)/, '두 암호가 다르면 보내지 않는다');
  assert.match(submit, /window\.retextPdf\.saveAs\(`\$\{dirOf\(name\)\}\$\{base\}_암호\.pdf`, \{ suggestDocFolder: curTemp \|\| curReadOnly \}\)/, '앱: 같은 폴더의 "<이름>_암호.pdf"로 저장 위치를 묻는다');
  assert.match(submit, /const payload = \{ name, to, userPassword: pw, allow \};[\s\S]{0,120}payload\.ownerPassword = owner/, '요청 본문: name·to·userPassword·allow(·ownerPassword)');
  assert.match(submit, /apiPost\('\/api\/pdf\/protect', payload/, '→ POST /api/pdf/protect');
  assert.match(submit, /toast\(`암호를 건 사본을 저장했습니다: \$\{basename\(to\)\}`/, '성공 알림');
  assert.match(submit, /if \(samePath\(to, name\)\) toast\(`이 파일은 이제 암호가 걸려 있습니다[^`]*`, \{ kind: 'warning'/, '지금 연 파일에 걸었으면 경고로 알린다');
  assert.match(script, /\$\('#protectDialog'\)\.addEventListener\('close', clearProtectFields\)/, '창을 닫으면(성공·취소·Esc) 입력칸을 비운다');
  assert.match(fnBody('function clearProtectFields()'), /for \(const id of PROTECT_FIELDS\) \{ \$\(id\)\.value = ''; \$\(id\)\.type = 'password'; \}/, '암호 칸을 비우고 다시 가린다');
  const protectCode = scriptLF.slice(scriptLF.indexOf('// ---- 암호 걸기'), scriptLF.indexOf('\n};\n', submitStart)) + '\n};\n';
  assert.doesNotMatch(protectCode.replace(/^\s*\/\/.*$/gm, ''), /localStorage|sessionStorage|console\.|indexedDB|document\.cookie/, '암호 걸기 코드는 저장소·로그를 건드리지 않는다(주석 제외)');
  assert.doesNotMatch(script, /(localStorage|sessionStorage)\.setItem\([^)]*(protect|userPassword|ownerPassword)/i, '암호 걸기 값을 저장소에 쓰지 않는다');
  assert.doesNotMatch(script, /console\.\w+\([^)]*(protect|userPassword|ownerPassword)/i, '암호 걸기 값을 로그에 남기지 않는다');

  // 실제로 흐름을 돌려 본다: 가짜 DOM·apiPost·saveAs로 제출 → 요청 본문, 저장소·로그에 암호가 닿지 않는지, 닫으면 칸이 비는지
  const PW = 'Pw-7#unique-secret', OWN = 'Owner-9#unique';
  const els = {}, listeners = {};
  const el = (id) => (els[id] ||= { id, value: '', type: 'password', checked: true, hidden: false, disabled: false, open: false, textContent: '', title: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, focus() {},
    showModal() { this.open = true; }, close() { this.open = false; (listeners[`${id}:close`] || []).forEach((f) => f()); },
    addEventListener(t, f) { (listeners[`${id}:${t}`] ||= []).push(f); } });
  const fire = (id, type) => (listeners[`${id}:${type}`] || []).forEach((f) => f());
  const store = { ls: [], ss: [], log: [] }, fetched = [], toasts = [];
  const sandbox = {
    $: (s) => el(s.replace(/^#/, '')), cur: 'C:\\docs\\계약서.pdf', curTemp: false, curReadOnly: false, basename: (p) => p.split(/[\\/]/).pop(),
    pdfOpen: () => true, toast: (t, o) => toasts.push([t, o && o.kind]), pdfDirty: true, securityNoted: null, showDirty: () => {},
    apiPost: async (p, body) => { fetched.push([p, JSON.parse(JSON.stringify(body))]); return { ok: true, path: body.to }; },
    window: { retextPdf: { saveAs: async (def) => { sandbox.asked = def; return 'C:\\docs\\계약서_암호.pdf'; } } },
    localStorage: { setItem: (...a) => store.ls.push(a) }, sessionStorage: { setItem: (...a) => store.ss.push(a) },
    console: { log: (...a) => store.log.push(a), error: (...a) => store.log.push(a) },
  };
  const api = new Function(...Object.keys(sandbox), `${protectCode}\nreturn { openProtectDialog };`)(...Object.values(sandbox));
  const submitForm = () => el('protectForm').onsubmit({ preventDefault() {} });
  (async () => {
    api.openProtectDialog();
    assert.ok(el('protectDialog').open, '창이 열린다');
    assert.strictEqual(el('protectOk').textContent, '암호 걸어 저장…', '앱에서는 [암호 걸어 저장…]');
    assert.ok(el('protectNameRow').hidden, '앱에서는 파일 이름 칸을 숨긴다(저장 위치 창을 쓴다)');
    el('protectPw').value = PW; el('protectPw2').value = PW + 'x'; fire('protectForm', 'input');
    assert.ok(!el('protectError').hidden && el('protectError').textContent === '두 암호가 다릅니다', '확인이 다르면 바로 "두 암호가 다릅니다"');
    await submitForm();
    assert.strictEqual(fetched.length, 0, '두 암호가 다르면 요청하지 않는다');
    el('protectPw2').value = PW; el('protectCopy').checked = false; fire('protectForm', 'change');
    assert.ok(el('protectError').hidden, '같으면 알림이 사라진다');
    assert.ok(!el('protectOwnerRow').hidden, '제한을 하나 풀면 소유자 암호 칸이 보인다');
    el('protectOwner').value = OWN;
    await submitForm();
    assert.strictEqual(sandbox.asked, 'C:\\docs\\계약서_암호.pdf', '저장 위치 기본값 = 같은 폴더의 <이름>_암호.pdf');
    assert.deepStrictEqual(fetched, [['/api/pdf/protect', { name: 'C:\\docs\\계약서.pdf', to: 'C:\\docs\\계약서_암호.pdf', userPassword: PW, allow: { print: true, copy: false, modify: true }, ownerPassword: OWN }]], '요청 본문');
    assert.deepStrictEqual(toasts, [['암호를 건 사본을 저장했습니다: 계약서_암호.pdf', 'info']], '사본 저장 알림');
    assert.ok(!el('protectDialog').open, '성공하면 창을 닫는다');
    for (const id of ['protectPw', 'protectPw2', 'protectOwner']) assert.strictEqual(el(id).value, '', `닫으면 #${id}를 비운다`);
    // 지금 연 파일에 그대로 걸면 경고
    sandbox.window.retextPdf.saveAs = async () => 'c:/docs/계약서.pdf';
    api.openProtectDialog(); el('protectPw').value = PW; el('protectPw2').value = PW;
    await submitForm();
    assert.strictEqual(toasts[1][1], 'warning', '지금 연 파일 경로면 경고 알림');
    assert.match(toasts[1][0], /^이 파일은 이제 암호가 걸려 있습니다/, '지금 연 파일 경로면 "이 파일은 이제 암호가 걸려 있습니다"');
    // 취소(닫기)해도 칸을 비운다
    api.openProtectDialog(); el('protectPw').value = PW; el('protectCancel').onclick();
    assert.strictEqual(el('protectPw').value, '', '[취소]로 닫아도 암호 칸을 비운다');
    // 브라우저 화면(window.retextPdf 없음): 창의 파일 이름 칸 → 같은 폴더에 쓴다. 잘못된 이름은 보내지 않는다
    const browser = { ...sandbox, window: {}, cur: '독서모임_안내.pdf' };
    const api2 = new Function(...Object.keys(browser), `${protectCode}\nreturn { openProtectDialog };`)(...Object.values(browser));
    fetched.length = 0;
    api2.openProtectDialog();
    assert.ok(!el('protectNameRow').hidden && el('protectName').value === '독서모임_안내_암호.pdf' && el('protectOk').textContent === '암호 걸어 저장', '브라우저 화면: 파일 이름 칸(기본 <이름>_암호.pdf)');
    el('protectPw').value = PW; el('protectPw2').value = PW; el('protectName').value = '../밖.pdf';
    await submitForm();
    assert.strictEqual(fetched.length, 0, '폴더를 넘는 파일 이름은 보내지 않는다');
    el('protectName').value = '사본.pdf';
    await submitForm();
    assert.strictEqual(fetched[0]?.[1].to, '사본.pdf', '브라우저 화면: 같은 폴더(작업 폴더)의 그 이름으로 쓴다');
    const leaked = JSON.stringify(store);
    assert.ok(!leaked.includes(PW) && !leaked.includes(OWN), '암호가 localStorage·sessionStorage·console에 닿지 않는다');
    console.log('OK — 밝은 테마·쪽 전체 보기·암호 걸기 단언 통과');
  })().catch((error) => { console.error(error); process.exit(1); });
}

// 떠 있는 패널 밖 빈 곳 클릭 → 닫기(줄 고치기는 고친 글이 있으면 적용). 다른 상자·패널 안·문서 밖 클릭은 그대로 둔다
{
  assert.ok(/document\.addEventListener\('mousedown', closePanelsOnOutside\)/.test(html), '문서 전체 mousedown에서 패널 밖 클릭을 본다');
  const fn = html.slice(html.indexOf('function closePanelsOnOutside'), html.indexOf("document.addEventListener('mousedown', closePanelsOnOutside)"));
  assert.ok(fn.includes(".closest('.pdfEditor, .pdfBox, .searchHit, .textDraft')"), '패널 안·다른 상자 클릭은 제외');
  assert.ok(fn.includes("$('#pdf').contains(e.target)"), '문서 영역 밖(도구줄·대화상자) 클릭은 제외');
  // 비교 대상은 편집 창에 보여 준 글(shown — 소프트 하이픈을 뺀 줄 글)
  assert.ok(/panel\.onOutside = \(\) => \(ta\.value !== selectedObj\?\.shown \? commit\(\) : close\(\)\)/.test(html), '줄 고치기: 고쳤으면 적용, 아니면 닫기');
  console.log('OK — 패널 밖 클릭으로 닫기 단언 통과');
}

// P9(2026-10-14): 리본 탭 · 주석 도구/목록 · 목차 · 개인정보·여러 쪽 가리기·숨은 데이터 · 워터마크·머리말 · 문서 정보·이미지 PDF · 쪽 목록 끌기(마우스 이벤트)
{
  const scriptLF = script.replace(/\r\n/g, '\n');
  const between = (a, b) => { const s = scriptLF.indexOf(a), e = scriptLF.indexOf(b, s); assert.ok(s >= 0 && e > s, `${a} … ${b} 블록이 있다`); return scriptLF.slice(s, e); };
  // A. 리본: 탭 다섯 개(홈·주석·쪽·문서·보안) → 탭마다 버튼 한 줄. 고른 탭은 기억한다. 문서 종류에 맞지 않는 탭은 숨긴다
  const tabs = [...html.matchAll(/<button type="button" class="rtab[^"]*" id="rtab-(\w+)" data-rtab="\1"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(tabs, [['home', '홈'], ['annot', '주석'], ['page', '쪽'], ['doc', '문서'], ['security', '보안']], '리본 탭 순서');
  assert.ok(html.indexOf('id="ribbonBar"') < html.indexOf('id="toolbar"'), '탭 줄은 도구줄 위');
  assert.match(html, /id="rtab-annot" data-rtab="annot" data-modes="pdf"/, '[주석] 탭은 PDF일 때만');
  assert.match(html, /id="rtab-doc" data-rtab="doc" data-modes="empty pdf"/, '[문서] 탭은 문서가 없을 때도(병합·이미지로·용량 줄이기)');
  const panelOf = (id) => { const k = html.indexOf(`id="${id}"`); const p = html.lastIndexOf('class="rpanel"', k); return html.slice(p, p + 80).match(/data-rtab="(\w+)"/)?.[1]; };
  const layout = {
    home: ['openBtn', 'save', 'saveAs', 'printBtn', 'undoBtn', 'redoBtn', 'toolEdit', 'toolText', 'toolStamp', 'menuInsertImage', 'rectTool', 'searchToggle', 'helpBtn'],
    annot: ['toolHighlight', 'toolUnderline', 'toolStrike', 'toolNote', 'toolSquare', 'toolCircle', 'toolLine', 'toolInk', 'annotListBtn', 'annotFlattenBtn'],
    page: ['rotateLeft', 'rotateRight', 'pageBlank', 'pageInsertPdf', 'menuExtract', 'pageNumbers', 'headerFooterBtn', 'watermarkBtn', 'outlineBtn'],
    doc: ['menuMerge', 'menuSplit', 'menuExportImages', 'menuDownsample', 'docInfoBtn', 'rasterizeBtn'],
    security: ['protectBtn', 'piiBtn', 'areaRedactTool', 'sanitizeBtn'],
  };
  for (const [tab, ids] of Object.entries(layout)) for (const id of ids) {
    assert.strictEqual(panelOf(id), tab, `#${id}는 [${tab}] 탭에 있다`);
    assert.match(html, new RegExp(`<button type="button" class="tb" id="${id}" data-icon="\\w+"[^>]*><span class="tl">[^<]+</span></button>`), `#${id}: 아이콘 + 이름`);
  }
  assert.match(scriptLF, /localStorage\.setItem\('retextpdf\.ribbonTab', tab\)/, '고른 탭을 기억한다');
  assert.match(scriptLF, /function showRibbonTab\(tab, remember = true\)/, 'showRibbonTab');
  assert.match(fnBodyOf(scriptLF, 'function updateEmptyState()'), /showRibbonTab\(ribbonTabVisible\(loadRibbonTab\(\)\) \? loadRibbonTab\(\) : 'home', false\)/, '모드가 바뀌면 보이는 탭으로(기억은 그대로)');
  assert.match(scriptLF, /document\.querySelectorAll\('#toolbar \[data-tool\]'\)\.forEach\(\(b\) => b\.setAttribute\('aria-pressed'/, '도구 버튼은 탭과 무관하게 하나만 눌린다');
  for (const id of ['qaSave', 'qaUndo', 'qaRedo']) assert.match(html, new RegExp(`id="${id}"[^>]*data-proxy=`), `빠른 실행 #${id}`);
  assert.match(scriptLF, /\$\('#undoBtn'\)\.disabled = \$\('#qaUndo'\)\.disabled = !u/, '빠른 실행 실행 취소도 사용 가능 여부를 따른다');

  // B. P9 API: 새 서버 경로는 한 블록에서만 부른다(계약이 바뀌면 여기만 고친다)
  const apiBlock = between('// === P9 API ===', '// === P9 API 끝 ===');
  for (const route of ['/api/pdf/pii/find', '/api/pdf/pii/redact', '/api/pdf/redact-area', '/api/pdf/sanitize', '/api/pdf/watermark', '/api/pdf/watermark/remove',
    '/api/pdf/header-footer', '/api/pdf/header-footer/remove', '/api/pdf/annot/create', '/api/pdf/annot/delete', '/api/pdf/annot/update', '/api/pdf/annot/flatten',
    '/api/pdf/annots?', '/api/pdf/annots/all?', '/api/pdf/outline', '/api/pdf/meta', '/api/pdf/rasterize']) {
    assert.ok(apiBlock.includes(`'${route}`) || apiBlock.includes(`\`${route}`), `P9 API 블록이 ${route}를 부른다`);
    assert.strictEqual(scriptLF.replace(apiBlock, '').includes(`/api${route.slice(4)}'`) || scriptLF.replace(apiBlock, '').includes(`${route}?`), false, `${route}는 API 블록 밖에서 부르지 않는다`);
  }
  for (const fn of ['apiPiiFind', 'apiPiiRedact', 'apiRedactArea', 'apiSanitize', 'apiWatermark', 'apiWatermarkRemove', 'apiHeaderFooter', 'apiHeaderFooterRemove',
    'apiAnnotCreate', 'apiAnnotDelete', 'apiAnnotUpdate', 'apiAnnotFlatten', 'apiAnnotsPage', 'apiAnnotsAll', 'apiPageChars', 'apiOutlineGet', 'apiOutlineSave', 'apiOutlineSaveText',
    'apiMetaGet', 'apiMetaSet', 'apiRasterize']) assert.match(apiBlock, new RegExp(`(const|function) ${fn}\\b`), `래퍼 ${fn}`);
  assert.match(apiBlock, /quality: o\.quality \/ 100/, '이미지 PDF 품질은 0.1~1로 보낸다');
  assert.match(apiBlock, /META_KEY = \{ title: 'Title', author: 'Author', subject: 'Subject', keywords: 'Keywords' \}/, '문서 정보는 /Info 이름(Title…)으로 보낸다');
  assert.match(scriptLF, /runJob\('이미지 PDF로 저장', \(jobId\) => apiRasterize\(/, '이미지 PDF는 진행 창(runJob)으로');
  assert.match(scriptLF, /\$\('#piiColor'\)\.value === 'auto' \? 'auto' : 'black'/, 'P9 덮개 색은 문자열(black·auto)');

  // C. 대화상자·패널 자리
  for (const id of ['piiDialog', 'areaRedactDialog', 'sanitizeDialog', 'wmDialog', 'hfDialog', 'metaDialog', 'rasterDialog', 'olTextDialog']) assert.match(html, new RegExp(`<dialog id="${id}" class="panel`), `#${id}`);
  for (const k of ['email', 'phone', 'rrn', 'brn', 'card']) assert.ok(html.includes(`name="piiKind" value="${k}" checked`), `개인정보 종류 ${k}`);
  for (const t of ['{page}', '{pages}', '{date}', '{file}', '{title}']) assert.ok(html.includes(`data-token="${t}"`), `머리말 값 단추 ${t}`);
  assert.match(html, /글자가 없는 그림 PDF가 됩니다 — 숨은 글자·주석·메타데이터가 모두 빠집니다/, '이미지 PDF 안내');
  for (const id of ['annotTab', 'outlineTab', 'annList', 'annFilter', 'olTree', 'olAddBtn', 'olTextBtn']) assert.match(html, new RegExp(`id="${id}"`), `왼쪽 패널 #${id}`);
  assert.match(html, /data-tab="annot" data-modes="pdf"/, '왼쪽 「주석」 탭은 PDF일 때만');
  assert.match(html, /<span id="ctxAnnotOpts" hidden>/, '주석 옵션은 상황줄에');
  assert.match(scriptLF, /'retextpdf\.wmPresets'/, '워터마크 자주 쓰는 설정을 기억한다');
  assert.match(scriptLF, /\{ KeyE: 'edit', KeyT: 'text', KeyS: 'stamp', KeyW: 'redact' \}\[e\.code\] \|\| ANNOT_KEYS\[e\.code\]/, '주석 단축키(H·U·N·P)');

  // D. 쪽 목록 끌어 옮기기: HTML5 draggable 대신 마우스 이벤트(4px 문턱·꼬리표·표시선·저절로 스크롤·Esc 취소). HTML5 drop은 바깥 PDF 파일 끼워 넣기에만
  assert.doesNotMatch(scriptLF, /item\.draggable = true/, '쪽 축소본은 draggable이 아니다');
  assert.doesNotMatch(scriptLF, /\$\('#pageThumbs'\)\.addEventListener\('dragstart'/, 'HTML5 dragstart로 쪽을 끌지 않는다');
  assert.match(scriptLF, /const PAGE_DRAG_START_PX = 4;/, '4px 넘게 움직여야 끌기');
  assert.match(scriptLF, /\$\('#pageThumbs'\)\.addEventListener\('mousedown'/, '누르기는 쪽 목록에서');
  assert.match(scriptLF, /if \(Math\.hypot\(e\.clientX - pagePress\.x, e\.clientY - pagePress\.y\) <= PAGE_DRAG_START_PX\) return;/, '문턱 전에는 클릭');
  assert.match(scriptLF, /pageDrag\.raf = requestAnimationFrame\(pageDragTick\)/, '멈춰 있어도 저절로 스크롤(프레임마다)');
  assert.match(scriptLF, /if \(e\.key !== 'Escape' \|\| !pageDrag\) return;[\s\S]{0,120}endPageDrag\(\)/, 'Esc로 끌기 취소');
  assert.match(scriptLF, /if \(swallowThumbClick\) return;/, '끈 뒤의 click은 고르기가 아니다');
  assert.match(scriptLF, /if \(inside\) movePages\(pages, at\)/, '목록 안에 놓아야 옮긴다');
  assert.match(scriptLF, /const canInsertHere = \(e\) => !pageDrag && isFileDrag\(e\)/, 'HTML5 끌어다 놓기는 바깥 파일만');

  // E. 순수 함수: 블록을 잘라 실제로 돌려 본다(좌표는 pdfToScreen·screenToPdf로)
  const fnSrc = (name) => scriptLF.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const pure = between('// === P9 순수 함수 ===', '// === P9 순수 함수 끝 ===');
  const P = new Function(`let pdfScale = 1;\n${fnSrc('unrotatedSize')}\n${fnSrc('pdfToScreen')}\n${fnSrc('screenToPdf')}\n${pure}\n`
    + 'return { checkPageRange, pickPages, screenPtToPdf, pdfPtToScreen, screenRectToPdfArr, normRect, nearestChar, markupRects, rectsToQuads, maskPii, fmtPdfDate, outlineToText, flattenOutline, outlineOp, outlineInsertAfter, fillHfTokens };')();
  // 쪽 범위
  assert.deepStrictEqual(P.checkPageRange('1,3,5-7', 10), { ok: true, all: false, idxs: [0, 2, 4, 5, 6] }, '1,3,5-7');
  assert.deepStrictEqual(P.checkPageRange('', 3), { ok: true, all: true, idxs: [0, 1, 2] }, '빈칸 = 전체');
  assert.deepStrictEqual(P.checkPageRange('3~5쪽, 1', 5).idxs, [0, 2, 3, 4], '물결·"쪽"·빈칸도 받는다');
  for (const bad of ['0', '2-9', '5-3', 'a', '1-']) assert.strictEqual(P.checkPageRange(bad, 5).ok, false, `잘못된 범위 "${bad}"는 오류`);
  assert.deepStrictEqual(P.pickPages('odd', '', 5).idxs, [0, 2, 4], '홀수');
  assert.deepStrictEqual(P.pickPages('even', '', 5).idxs, [1, 3], '짝수');
  assert.strictEqual(P.pickPages('even', '', 1).ok, false, '쪽이 하나면 짝수 없음');
  assert.strictEqual(P.pickPages('custom', ' ', 5).ok, false, '직접인데 비었으면 오류');
  assert.deepStrictEqual(P.pickPages('all', 'x', 3).idxs, [0, 1, 2], '전체는 글을 보지 않는다');
  // 좌표: 회전 0·1·2·3 왕복, 알려진 값
  const near = (a, b, msg) => assert.ok(a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) < 1e-9), `${msg}: ${a} ≈ ${b}`);
  near(P.screenPtToPdf({ w: 400, h: 300, rotation: 0 }, 10, 20, 1), [10, 280], '회전 0: 화면 (10,20) → PDF (10,280)');
  near(P.screenPtToPdf({ w: 300, h: 400, rotation: 1 }, 10, 20, 1), [20, 10], '회전 1(90도 시계): 화면 (10,20) → PDF (20,10)');
  near(P.screenPtToPdf({ w: 400, h: 300, rotation: 2 }, 10, 20, 1), [390, 20], '회전 2: 화면 (10,20) → PDF (390,20)');
  near(P.screenPtToPdf({ w: 300, h: 400, rotation: 3 }, 10, 20, 1), [380, 290], '회전 3: 화면 (10,20) → PDF (380,290)');
  for (const rotation of [0, 1, 2, 3]) {
    const page = rotation % 2 ? { w: 300, h: 400, rotation } : { w: 400, h: 300, rotation };
    for (const [x, y] of [[0, 0], [37.5, 120.25], [299, 11]]) near(P.pdfPtToScreen(page, ...P.screenPtToPdf(page, x, y, 1.5), 1.5), [x, y], `회전 ${rotation} 왕복 (${x},${y})`);
  }
  near(P.screenRectToPdfArr({ w: 400, h: 300, rotation: 0 }, 110, 70, 10, 20, 2), [5, 265, 55, 290], '거꾸로 끈 사각형도 [왼,아래,오른,위](배율 2)');
  near(P.screenRectToPdfArr({ w: 300, h: 400, rotation: 1 }, 10, 20, 50, 80, 1), [20, 10, 80, 50], '회전 1 사각형');
  // 서버 사각형 모양 통일
  for (const r of [[10, 20, 30, 40], [30, 40, 10, 20], { x0: 10, y0: 20, x1: 30, y1: 40 }, { left: 10, bottom: 20, right: 30, top: 40 }, { x: 10, y: 20, w: 20, h: 20 }]) {
    assert.deepStrictEqual(P.normRect(r), { x0: 10, y0: 20, x1: 30, y1: 40 }, `normRect ${JSON.stringify(r)}`);
  }
  assert.strictEqual(P.normRect([1, 2, 3]), null, '숫자가 모자라면 null');
  // 글자 고르기: 두 줄 글자 상자 → 가까운 글자 · 줄마다 사각형 · quads
  const ch = (c, x, y) => ({ ch: c, x0: x, y0: y, x1: x + 6, y1: y + 10 });
  const chars = [ch('a', 10, 100), ch('b', 16, 100), { ch: ' ', x0: 22, y0: 100, x1: 22, y1: 110 }, ch('c', 22, 100), ch('d', 10, 80), ch('e', 16, 80), { ch: '', x0: 0, y0: 0, x1: 0, y1: 0 }];
  assert.strictEqual(P.nearestChar(chars, 17, 105), 1, '점 위의 글자');
  assert.strictEqual(P.nearestChar(chars, 60, 104), 3, '줄 끝 밖이면 그 줄의 마지막 글자(위아래 거리를 더 크게 친다)');
  assert.strictEqual(P.nearestChar(chars, 11, 79), 4, '아래 줄');
  assert.deepStrictEqual(P.markupRects(chars, 0, 6), [{ x0: 10, y0: 100, x1: 28, y1: 110 }, { x0: 10, y0: 80, x1: 22, y1: 90 }], '줄마다 사각형 하나');
  assert.deepStrictEqual(P.markupRects(chars, 1, 2), [{ x0: 16, y0: 100, x1: 22, y1: 110 }], '한 글자');
  assert.deepStrictEqual(P.rectsToQuads([{ x0: 10, y0: 100, x1: 28, y1: 110 }]), [[10, 110, 28, 110, 10, 100, 28, 100]], 'quads = 왼위·오위·왼아래·오아래');
  // 개인정보 가린 미리보기
  assert.strictEqual(P.maskPii('010-1234-5678', 'phone'), '010-****-5678', '전화');
  assert.strictEqual(P.maskPii('900101-1234567', 'rrn'), '900101-1******', '주민등록번호');
  assert.strictEqual(P.maskPii('123-45-67890', 'brn'), '123-45-*****', '사업자등록번호');
  assert.strictEqual(P.maskPii('4111-1111-1111-1111', 'card'), '****-****-****-1111', '카드');
  assert.strictEqual(P.maskPii('test.user@example.com', 'email'), 'te*******@example.com', '이메일');
  assert.strictEqual(P.maskPii('사번 123456', 'custom'), '사번 ****56', '정규식(앞뒤 두 글자, 빈칸은 그대로)');
  // 날짜
  assert.strictEqual(P.fmtPdfDate("D:20261014153000+09'00'"), '2026-10-14 15:30', 'PDF 날짜');
  assert.strictEqual(P.fmtPdfDate('D:2026'), '2026-01-01', '연도만');
  assert.strictEqual(P.fmtPdfDate(''), '—', '없음');
  assert.match(P.fmtPdfDate('2026-10-14T06:30:00.000Z'), /^2026-10-14 \d\d:30$/, 'ISO 날짜');
  // 목차 나무
  const tree = [{ title: 'A', page: 0, children: [{ title: 'A1', page: 1, children: [] }, { title: 'A2', page: null, children: [] }] }, { title: 'B\t탭', page: 2, children: [] }];
  assert.strictEqual(P.outlineToText(tree), 'A\t1\n  A1\t2\n  A2\t\nB 탭\t3', '목차 → 글(들여쓰기 두 칸, 쪽은 1-기준, 제목 속 탭은 빈칸)');
  assert.deepStrictEqual(P.flattenOutline(tree).map((r) => `${r.depth}:${r.path.join('.')}:${r.node.title}`), ['0:0:A', '1:0.0:A1', '1:0.1:A2', '0:1:B\t탭'], '나무 → 줄');
  const titles = (items) => P.flattenOutline(items).map((r) => '  '.repeat(r.depth) + r.node.title).join('|');
  let r = P.outlineOp(tree, [0, 1], 'up'); assert.deepStrictEqual([titles(r.items), r.path], ['A|  A2|  A1|B\t탭', [0, 0]], '위로');
  r = P.outlineOp(tree, [1], 'in'); assert.deepStrictEqual([titles(r.items), r.path], ['A|  A1|  A2|  B\t탭', [0, 2]], '들여 쓰기 = 앞 항목의 마지막 자식');
  r = P.outlineOp(tree, [0, 0], 'out'); assert.deepStrictEqual([titles(r.items), r.path], ['A|  A2|A1|B\t탭', [1]], '내어 쓰기 = 부모 바로 뒤');
  r = P.outlineOp(tree, [0, 1], 'delete'); assert.deepStrictEqual([titles(r.items), r.path], ['A|  A1|B\t탭', [0, 0]], '지우기 뒤 앞 형제를 고른다');
  r = P.outlineOp(tree, [0, 0], 'in'); assert.deepStrictEqual(r.path, [0, 0], '첫 형제는 들여 쓸 수 없다(그대로)');
  r = P.outlineOp(tree, [1], 'down'); assert.deepStrictEqual(r.path, [1], '마지막은 아래로 못 간다');
  assert.strictEqual(tree[0].children[0].title, 'A1', '원래 나무는 건드리지 않는다');
  r = P.outlineInsertAfter(tree, [0, 0], { title: 'N', page: 4 }); assert.deepStrictEqual([titles(r.items), r.path], ['A|  A1|  N|  A2|B\t탭', [0, 1]], '고른 항목 바로 뒤에 넣기');
  r = P.outlineInsertAfter([], null, { title: 'N', page: 0 }); assert.deepStrictEqual([r.items, r.path], [[{ title: 'N', page: 0, children: [] }], [0]], '빈 목차에 넣기');
  assert.strictEqual(P.fillHfTokens('{file} · {page}/{pages} · {date} {x}', { file: '보고서', page: 3, pages: 9, date: '2026-10-14' }), '보고서 · 3/9 · 2026-10-14 {x}', '머리말 값 채우기(모르는 표시는 그대로)');
  // F. 가리기 도구 = 진짜 가리기: 덮개만 그리던 /api/pdf/rect를 더는 부르지 않고 /api/pdf/redact-area(그 한 쪽)로 지운다
  assert.doesNotMatch(scriptLF, /(pdfMutate|apiPost|fetch)\(\s*['"`]\/api\/pdf\/rect['"`]/, '가리기 도구는 /api/pdf/rect(덮개만)를 부르지 않는다');
  assert.doesNotMatch(scriptLF, /이미지 위에 덮기만 했습니다/, '옛 "이미지 위에 덮기만" 안내는 없앴다');
  const rectUp = between("document.addEventListener('mouseup', async (e) => {\n  if (!rectDrag) return;", '\n});\n');
  assert.match(rectUp, /await redactRectOnPage\(i, screenRectToPdfArr\(pdfPages\[i\], left, top, left \+ w, top \+ h\)\)/, '가리기 도구 → redactRectOnPage(회전 반영 사각형)');
  assert.match(rectUp, /if \(maskHit\) openMaskPanel\(i, maskHit\._maskObj, wrap, maskHit\)/, '기존 가림 상자 누르기 → 패널은 그대로');
  const redactFn = fnBodyOf(scriptLF, 'async function redactRectOnPage(i, rect)');
  assert.match(redactFn, /apiRedactArea\(name, [^\n]+, String\(i \+ 1\), auto \? 'auto' : 'black'/, '한 쪽(String(i+1))만, 색은 black·auto 문자열');
  assert.match(redactFn, /배경색 \$\{hex\(cover\.color\)\}으로 가렸습니다/, "'auto'면 새 덮개 색을 알린다");
  assert.match(fnBodyOf(scriptLF, 'function redactAreaNote(pg)'), /if \(pg\.unmapped > 0\) parts\.push\('일부 내용\(양식 개체 안\)은 덮기만 했습니다'\)/, '양식 개체 안 내용은 덮기만 했다고 알린다');
  assert.match(scriptLF, /redact: '가릴 곳을 끌어서 감싸세요 — 그 안의 글자·그림은 파일에서 지워집니다/, '가리기 사용법: 안의 내용을 지운다');
  console.log('OK — P9 리본·주석·목차·보안·워터마크·쪽 목록 끌기 단언 통과');
}
// v6 Wave A: 쪽 위 편집기(순수 계산 · 한글 조합) · 찾아 바꾸기 계산 · 속성 창·꾸밈 막대·상자 테두리·Ctrl+H 배선
{
  const IE = require('./inplace-edit');
  const FR = require('./find-replace');
  // A. 키 처리: 한글 조합 중(isComposing·keyCode 229·조합 시작~끝)에는 Enter·Ctrl+Enter·Esc를 처리하지 않는다
  assert.strictEqual(IE.keyAction({ key: 'Enter', isComposing: true }), null, '조합 중 Enter는 글자 확정 — 줄바꿈·적용 안 함');
  assert.strictEqual(IE.keyAction({ key: 'Enter', keyCode: 229 }), null, 'keyCode 229(IME 처리 중)도 무시');
  assert.strictEqual(IE.keyAction({ key: 'Enter', ctrlKey: true }, true), null, '조합 상태 표시(compositionstart~end) 중 Ctrl+Enter도 무시');
  assert.strictEqual(IE.keyAction({ key: 'Escape', isComposing: true }), null, '조합 중 Esc는 조합 취소일 뿐 편집기를 닫지 않는다');
  assert.strictEqual(IE.keyAction({ key: 'Enter', ctrlKey: true }), 'apply');
  assert.strictEqual(IE.keyAction({ key: 'Enter', metaKey: true }), 'apply');
  assert.strictEqual(IE.keyAction({ key: 'Enter' }), 'hardBreak');
  assert.strictEqual(IE.keyAction({ key: 'Enter', shiftKey: true }), 'hardBreak');
  assert.strictEqual(IE.keyAction({ key: 'Escape' }), 'cancel');
  assert.strictEqual(IE.keyAction({ key: 'b', code: 'KeyB', ctrlKey: true }), 'bold');
  assert.strictEqual(IE.keyAction({ key: 'ㅠ', code: 'KeyB', ctrlKey: true }), 'bold', '한글 입력 상태에서도 e.code로');
  assert.strictEqual(IE.keyAction({ key: 'a' }), null);
  // B. 편집기 DOM → 글: 옛 줄 경계(data-raw "\n")·가린 자리(data-raw "■")·↵ 표시(.hb, 글 아님)·BR·DIV·폭 없는 공백
  const T = (v) => ({ nodeType: 3, nodeValue: v });
  const E = (tag, kids = [], { raw, cls = [] } = {}) => ({ nodeType: 1, tagName: tag, childNodes: kids, dataset: raw == null ? {} : { raw }, classList: { contains: (c) => cls.includes(c) } });
  const hb = E('SPAN', [T('↵')], { cls: ['hb'] }), soft = E('SPAN', [T(' ')], { raw: '\n', cls: ['soft'] });
  const root = E('DIV', [E('SPAN', [T('굵은 ')]), E('SPAN', [T('글씨')]), soft, E('SPAN', [T('다음')]), E('SPAN', [T('■■')], { raw: '■■' }), hb, T('\n​'), T('끝'), E('BR'), E('DIV', [T('줄')]), E('SPAN', [T('↵')], { cls: ['hb', 'end'] })]);
  assert.strictEqual(IE.extractText(root), '굵은 글씨\n다음■■\n끝\n줄', 'BR 뒤 DIV는 줄바꿈을 겹치지 않는다');
  assert.strictEqual(IE.textOffset(root, root.childNodes[1].childNodes[0], 1), 4, 'DOM 위치 → 글 위치(앞 span 3글자 + 1)');
  assert.strictEqual(IE.textOffset(root, root.childNodes[3].childNodes[0], 0), 6, '옛 줄 경계(1글자) 뒤');
  assert.strictEqual(IE.textOffset(root, root.childNodes[6], 2), 11, '↵ 표시는 0글자, 폭 없는 공백은 빼고 센다');
  // C. 줄 → 편집기 조각: 모양이 같으면 합치고, 한글이 꽉 찬 줄의 경계는 빈칸 없이, 가린 자리는 고칠 수 없는 조각
  const obj = (text, x, extra = {}) => ({ text, font: 'BAAAAA+MalgunGothic', size: 11, scaledSize: 11, color: [0, 0, 0, 255], matrix: [1, 0, 0, 1, x, 100], origin: { x, y: 100 }, renderMode: 0, weight: 400, ...extra });
  const L1 = { text: '가나다라', objs: [obj('가나', 0), obj('다라', 22, { font: 'CAAAAA+MalgunGothicBold', weight: 700 })], seps: [''], bounds: { x0: 0, x1: 100, y0: 98, y1: 110 }, size: 11 };
  const L2 = { text: '마바 ■ 사', objs: [obj('마바', 0, { origin: { x: 0, y: 86 } }), obj('사', 40, { origin: { x: 40, y: 86 }, color: [204, 0, 0, 255], style: { u: '1' } })], seps: [' ■ '], bounds: { x0: 0, x1: 50, y0: 84, y1: 96 }, size: 11 };
  const segs = IE.segmentsFor([L1, L2]);
  assert.deepStrictEqual(segs.map((g) => g.t), ['text', 'text', 'soft', 'text', 'mask', 'text']);
  assert.strictEqual(segs[1].style.bold, true); assert.strictEqual(segs[2].show, '', '한글이 꽉 찬 줄 경계는 빈칸 없이 잇는다');
  assert.strictEqual(segs[4].raw, ' ■ '); assert.ok(segs[5].style.underline && segs[5].style.color === '#cc0000');
  const shown = segs.map((g) => (g.t === 'text' ? g.text : g.raw)).join('');
  assert.strictEqual(shown, '가나다라\n마바 ■ 사', '편집기 글 = 서버가 받는 줄 글(문단은 줄 사이 \\n)');
  // D. 다시 흐른 뒤 위치 옮기기 · 속성 창 상태
  assert.strictEqual(IE.mapOffset('ab cd\nef', 'ab\ncd ef', 3, 'start'), 3); assert.strictEqual(IE.mapOffset('ab cd\nef', 'ab\ncd ef', 5, 'end'), 5);
  const st = IE.styleAt([L1, L2], 2, 4);
  assert.ok(st.bold && !st.underline && st.color === '#000000', JSON.stringify(st));
  assert.ok(IE.styleAt([L1, L2], 0, 4).bold === false, '섞이면 모두 그럴 때만 켜짐');
  assert.ok(IE.styleAt([L1, L2], 10, 11).underline, '둘째 줄 밑줄 글자');
  // E. 찾아 바꾸기 계산: 대소문자·단어 단위·가린 자리·겹치지 않게
  assert.deepStrictEqual(FR.findAll('Mix mix MIX', 'mix'), [0, 4, 8]);
  assert.deepStrictEqual(FR.findAll('Mix mix MIX', 'mix', { matchCase: true }), [4]);
  assert.deepStrictEqual(FR.findAll('회의 회의는 회의', '회의', { wholeWord: true }), [0, 7]);
  assert.deepStrictEqual(FR.findAll('aaaa', 'aa'), [0, 2], '겹치는 일치는 건너뛴다');
  const ml = FR.lineMatches({ text: '이름 ■■ 이름', objs: [{ text: '이름' }, { text: '이름' }], seps: [' ■■ '] }, '■');
  assert.ok(ml.length === 2 && ml.every((m) => m.masked), '가린 자리 일치는 masked');
  assert.strictEqual(FR.applyReplace('회의 회의록', [{ at: 0, len: 2 }, { at: 3, len: 2 }], '모임'), '모임 모임록');
  assert.strictEqual(FR.editBlock({ objs: [{ hidden: true }] }), '그림 위 투명 글자');
  // F. 화면 배선
  const s = script.replace(/\r\n/g, '\n');
  assert.match(html, /<script src="\/inplace-edit\.js"><\/script>/); assert.match(html, /<script src="\/find-replace\.js"><\/script>/);
  assert.match(serverSource, /'\/inplace-edit\.js' \|\| url\.pathname === '\/find-replace\.js'/, '서버가 두 스크립트를 내준다');
  assert.match(html, /<section class="propPanel" id="propPanel"/, '오른쪽 속성 창');
  for (const id of ['ppFont', 'ppSize', 'ppColor', 'pp-bold', 'pp-italic', 'pp-underline', 'pp-strike', 'pp-super', 'pp-sub', 'ppAlign', 'ppPitch', 'ppTracking', 'ppFontFit', 'ppMaskSel', 'ppMaskAll', 'ppPara']) assert.match(html, new RegExp(`id="${id}"`), `속성 창 ${id}`);
  assert.match(html, /\.workarea\.withProps\{grid-template-columns:212px 1fr 264px\}/, '속성 창은 문서 영역 옆 칸 — 쪽을 덮지 않는다');
  assert.match(html, /@media \(max-width:1180px\)\{\.workarea\.withProps[^}]*\}\.propPanel\{display:none!important\}/, '1180px 이하는 속성 창을 숨긴다');
  assert.match(s, /const canInPlace = \(sel\) => !narrowUI\(\) && /, '좁은 창은 떠 있는 줄 고치기 창(예전 방식)');
  assert.match(s, /return openInlineEditor\(initialText \?\? selectedObj\.shown, caret\);/, '쪽 위 편집기를 못 쓰면 떠 있는 창');
  assert.match(s, /tx\.addEventListener\('compositionstart', \(\) => \{ st\.composing = true;/, '한글 조합 시작을 기억');
  assert.match(s, /const act = IE\.keyAction\(e, st\.composing\);/, '키는 keyAction(조합 중 무시)');
  assert.match(s, /if \(st\.composing \|\| e\.isComposing\) return;\n    if \(e\.inputType === 'insertParagraph'/, '조합 중에는 줄바꿈 입력을 가로채지 않는다');
  assert.match(fnBodyOf(s, 'function openInPlaceEditor('), /el\.onOutside = \(\) => \(st\.dirty\(\) \? commit\(\) : close\(\)\);/, '바깥 누르기: 고쳤으면 적용');
  assert.match(fnBodyOf(s, 'function openInPlaceEditor('), /await whenComposed\(\);\n    const newText = IE\.extractText\(tx\);/, '적용은 조합이 끝난 뒤 글을 읽는다');
  assert.match(s, /mutateWithOverflow\('\/api\/pdf\/edit-runs', req\)/, '쪽 위 편집 적용 = edit-runs 한 번');
  assert.match(s, /pushDown: true/, '아래 내용 밀기');
  assert.match(s, /mutateWithOverflow\('\/api\/pdf\/style-runs', req\)/, '모양 바꾸기 = style-runs 한 번');
  assert.match(s, /if \(error\.data\?\.overflow && !payload\.overflow\)/, '넘치면 묻는다(줄여 맞추기·겹쳐 두기)');
  assert.match(html, /id="overflowDialog"/); assert.match(html, /id="ofShrink"/); assert.match(html, /id="ofKeep"/);
  assert.match(html, /id="miniBar"/); assert.match(s, /function placeMiniBar\(st, range\)/, '고른 글자 위 작은 꾸밈 막대');
  assert.match(s, /if \(st\.composing \|\| range\.collapsed \|\| st\.committing\) \{ bar\.hidden = true; return; \}/, '조합 중에는 꾸밈 막대를 숨긴다');
  assert.match(html, /id="outlineToggle"/); assert.match(s, /localStorage\.setItem\('retextpdf\.outlines'/, '상자 테두리는 기억한다');
  assert.match(html, /\.pdf\.showOutlines \.pdfBox/, '테두리 CSS');
  assert.match(html, /id="replaceBtn"[^>]*><span class="tl">바꾸기</, '홈 [바꾸기]');
  assert.ok(html.indexOf('id="searchToggle"') < html.indexOf('id="replaceBtn"') && html.indexOf('id="replaceBtn"') < html.indexOf('id="helpBtn"'), '[찾기] 옆');
  assert.match(s, /e\.code === 'KeyH' && pdfOpen\(\)\) \{ e\.preventDefault\(\); openReplaceDialog\(\); \}/, 'Ctrl+H');
  assert.match(s, /\{ group: '편집', keys: 'Ctrl\+H', label: '찾아 바꾸기/, '단축키 도움말');
  for (const id of ['rpFind', 'rpWith', 'rpCase', 'rpWord', 'rpOne', 'rpAll', 'rpSkipped']) assert.match(html, new RegExp(`id="${id}"`), `찾아 바꾸기 ${id}`);
  assert.match(s, /apiPost\('\/api\/pdf\/replace', \{ \.\.\.q, dryRun: true \}/, '찾기는 dryRun');
  assert.match(serverSource, /url\.pathname === '\/api\/pdf\/style-runs'/); assert.match(serverSource, /url\.pathname === '\/api\/pdf\/replace'/);
  assert.match(s, /document\.activeElement\?\.isContentEditable\) return;/, '쪽 위 편집기 안 Ctrl+Z는 글자 되돌리기(PDF 실행 취소 아님)');
  console.log('OK — v6 Wave A 쪽 위 편집기(한글 조합·↵·DOM↔글)·찾아 바꾸기 계산·속성 창·꾸밈 막대·상자 테두리·Ctrl+H 단언 통과');
}
// ── v6 Wave B: 저장 전 확인(쪽 위 편집기의 적용하지 않은 글·대체 글꼴·전자서명) · 속성 창 글꼴 안내 ─────────────
{
  const s = script.replace(/\r\n/g, '\n');
  const IE = require('./inplace-edit');
  // A. 적용하지 않은 글: settleInplace를 꺼내 가짜 편집기로 돌린다(묻기 → 적용/버리기/취소, 창 닫기는 묻지 않고 적용)
  const src = fnBodyOf(s, 'async function settleInplace(') + '\n}';
  const make = (ctx) => new Function('ctx', `with (ctx) { return (${src.replace('async function settleInplace', 'async function')}); }`)(ctx);
  const run = async (choice, { dirty = true, commitOk = true, mode } = {}) => {
    const log = [];
    const st = { committing: false, dirty: () => dirty, whenComposed: async () => {}, commit: async () => { log.push('commit'); return commitOk ? { ok: true } : false; }, cancel: () => log.push('cancel') };
    const ctx = { inplace: st, askPending: async (verb) => { log.push('ask:' + verb); return choice; }, setTimeout };
    const r = await make(ctx)('저장', mode);
    return { r, log };
  };
  (async () => {
    assert.deepStrictEqual(await run('apply'), { r: true, log: ['ask:저장', 'commit'] }, '[적용하고 저장] → 적용한 뒤 저장');
    assert.deepStrictEqual(await run('discard'), { r: true, log: ['ask:저장', 'cancel'] }, '[버리고 저장] → 편집기를 닫고 저장');
    assert.deepStrictEqual(await run(null), { r: false, log: ['ask:저장'] }, '[취소] → 저장하지 않는다');
    assert.deepStrictEqual(await run('apply', { commitOk: false }), { r: false, log: ['ask:저장', 'commit'] }, '적용에 실패하면 저장하지 않는다');
    assert.deepStrictEqual(await run(null, { dirty: false }), { r: true, log: [] }, '고친 글이 없으면 묻지 않는다');
    assert.deepStrictEqual(await run(null, { mode: 'apply' }), { r: true, log: ['commit'] }, '창 닫기(저장 고름)는 묻지 않고 적용');
  })().catch((e) => { console.error(e); process.exit(1); });
  const save = fnBodyOf(s, 'async function save(');
  assert.ok(save.indexOf("settleInplace('저장', opts.pending)") > 0 && save.indexOf("settleInplace('저장', opts.pending)") < save.indexOf("apiPost('/api/pdf/save'"), '저장(Ctrl+S·[저장])은 적용하지 않은 글부터 정리한다');
  assert.ok(save.indexOf('confirmSubstitutions(cur)') > 0 && save.indexOf('confirmSubstitutions(cur)') < save.indexOf("apiPost('/api/pdf/save'"), '저장 전 대체 글꼴 경고');
  const saveAs = fnBodyOf(s, 'async function saveAs(');
  assert.ok(saveAs.indexOf("settleInplace('저장', opts.pending)") > 0 && saveAs.indexOf('confirmSubstitutions(cur)') < saveAs.indexOf("apiPost('/api/pdf/saveas'"), '다른 이름으로 저장도 같은 확인');
  assert.match(fnBodyOf(s, 'async function onPrint('), /if \(!\(await settleInplace\('인쇄'\)\)\) return;/, '인쇄 전에도');
  // v6 Wave F: 탭을 바꿀 때는 묻지 않고 고치던 상태를 그 탭 기억에 넣는다(돌아오면 되살린다 — 아래 Wave F 시험)
  assert.match(fnBodyOf(s, 'async function open('), /if \(name !== cur && !opts\.noStash\) await parkInplace\(\);/, '다른 문서로 바꾸기 전에는 고치던 상태를 탭 기억에');
  assert.doesNotMatch(fnBodyOf(s, 'async function open('), /settleInplace\('열기'\)/, '탭을 바꿀 때 적용/버리기를 묻지 않는다');
  assert.match(fnBodyOf(s, 'async function removeFile('), /if \(cur === p && !\(await settleInplace\('닫기'\)\)\) return;/, '문서를 닫기 전에도');
  assert.match(s, /window\.isDirty = \(\) => !!dirty\(\) \|\| !!\(inplace && inplace\.dirty\(\)\) \|\| tabs\.some\(\(p\) => p !== cur && tabDirty\(p\)\);/, '창 닫기 확인은 적용하지 않은 글도(v6 Wave C: 다른 탭의 고친 내용도) 미저장으로 본다');
  assert.match(s, /window\.retextPdfSave = async \(\) => \{ await save\(\{ pending: 'apply' \}\); return !dirty\(\) && saveOtherTabs\(\); \};/, '창 닫기 → 저장은 적용하고 저장(다른 탭도)');
  for (const id of ['pendingDialog', 'pdApply', 'pdDiscard', 'pdCancel']) assert.match(html, new RegExp(`id="${id}"`), `적용 확인 창 #${id}`);
  assert.match(s, /\$\('#pdApply'\)\.textContent = `적용하고 \$\{verb\}`; \$\('#pdDiscard'\)\.textContent = `버리고 \$\{verb\}`;/, '[적용하고 저장] / [버리고 저장] / [취소]');
  // B. 대체 글꼴 경고 창: 쪽·글·원래 글꼴 → 쓴 글꼴, [그대로 저장]·[취소]·다시 보지 않기(이 문서)
  for (const id of ['substDialog', 'sbRows', 'sbNever', 'sbSave', 'sbCancel']) assert.match(html, new RegExp(`id="${id}"`), `대체 글꼴 창 #${id}`);
  assert.match(html, />그대로 저장</); assert.match(html, /다시 보지 않기 \(이 문서\)/);
  const cs = fnBodyOf(s, 'async function confirmSubstitutions(');
  assert.match(cs, /fetch\('\/api\/pdf\/substitutions\?name=' \+ encodeURIComponent\(name\)\)/, '서버의 이번 실행 대체 목록');
  assert.match(cs, /localStorage\.setItem\('retextpdf\.substOk'/, '다시 보지 않기는 문서 경로별로 기억');
  assert.match(serverSource, /url\.pathname === '\/api\/pdf\/substitutions'/); assert.match(serverSource, /url\.pathname === '\/api\/pdf\/glyph-check'/); assert.match(serverSource, /url\.pathname === '\/api\/fonts\/missing'/);
  // C. 전자서명: 열 때 토스트·상태줄 표시, 처음 고치기 전(pdfMutate 관문)·처음 저장할 때 묻고, 저장은 409 needSaveAs로 다른 이름으로
  for (const id of ['sigBadge', 'signedDialog', 'sgContinue', 'sgSaveAs', 'sgCancel']) assert.match(html, new RegExp(`id="${id}"`), `서명 #${id}`);
  assert.match(html, />전자서명 있음</); assert.match(html, /이 문서에는 전자서명이 있습니다\. 고쳐서 저장하면 서명이 무효가 됩니다\./);
  assert.match(html, />다른 이름으로 저장하도록 하기</);
  assert.match(s, /showSigned\(name, info\.security\);/, '열 때 서명 표시');
  assert.match(fnBodyOf(s, 'async function pdfMutate('), /if \(!\(await signedGate\(\)\)\) throw/, '처음 고치기 전에 묻는다');
  assert.match(save, /if \(curSigned && !signedAck\.has\(cur\)\)/, '처음 저장할 때 묻는다');
  assert.match(fnBodyOf(s, 'async function saveProtected('), /data\.signed \?/, '서명 원본의 409 needSaveAs 안내');
  assert.match(serverSource, /if \(entry\.security\?\.signed && !force\)/, '서버가 서명 원본 덮어쓰기를 막는다');
  // D. 속성 창 글꼴 안내(대체 글꼴·없는 글자) — 새로 넣은 글자와 그 글자를 받는 조각(insertedAt)
  assert.match(html, /<div class="ppNote" id="ppFontNote" role="status" hidden><\/div>/);
  assert.match(s, /선택한 글꼴\(\$\{escapeHtml\(r\.label\)\}\)에 없는 문자/, '"선택한 글꼴에 없는 문자" 안내');
  const lines = [{ objs: [{ idx: 4, text: 'Run ' }, { idx: 7, text: 'npm test' }], seps: [''] }];
  assert.deepStrictEqual(IE.insertedAt(lines, 'Run npm test', 'Run npm testZ'), { idx: 7, chars: ['Z'] }, '넣은 글자는 왼쪽 조각이 받는다');
  assert.deepStrictEqual(IE.insertedAt(lines, 'Run npm test', 'XRun npm test'), { idx: 4, chars: ['X'] }, '줄 첫머리는 첫 조각');
  assert.strictEqual(IE.insertedAt(lines, 'Run npm test', 'Run npm tes'), null, '지우기만 했으면 없음');
  console.log('OK — v6 Wave B 저장 전 확인(적용하지 않은 글·대체 글꼴·전자서명)·속성 창 글꼴 안내 단언 통과');
}

// ── v6 Wave C: 문서 탭 · 명령 검색(Ctrl+Q, 초성) · 어두운 테마 · 시작 화면 · 쪽 보기 방식 · 손 도구 · 읽기 모드 ─────────────
{
  const UM = require('./ui-model');
  const s = script.replace(/\r\n/g, '\n');
  // A. 탭 모델: 열기(이미 있으면 그 탭으로, 20개까지) · 닫기(오른쪽 이웃 → 왼쪽) · 끌어 옮기기 · 한꺼번에 닫기(고른 탭은 맨 끝) · 순환 · 미저장
  let st = { order: [], active: null };
  for (const p of ['a.pdf', 'b.md', 'c.pdf']) st = UM.tabOpen(st, p);
  assert.deepStrictEqual(st, { order: ['a.pdf', 'b.md', 'c.pdf'], active: 'c.pdf', created: true, full: false }, '새 문서는 끝에 탭으로 더하고 고른다');
  assert.deepStrictEqual(UM.tabOpen(st, 'a.pdf'), { order: ['a.pdf', 'b.md', 'c.pdf'], active: 'a.pdf', created: false, full: false }, '이미 연 문서는 그 탭으로만 간다');
  let full = { order: Array.from({ length: UM.MAX_TABS }, (_, i) => `f${i}.pdf`), active: 'f0.pdf' };
  assert.strictEqual(UM.MAX_TABS, 20, '탭은 20개까지');
  assert.deepStrictEqual(UM.tabOpen(full, 'new.pdf'), { order: full.order, active: 'f0.pdf', created: false, full: true }, '가득 차면 열지 않는다(고친 탭을 몰래 닫지 않는다)');
  const s3 = { order: ['a', 'b', 'c'], active: 'b' };
  assert.deepStrictEqual(UM.tabClose(s3, 'b'), { order: ['a', 'c'], active: 'c' }, '고른 탭을 닫으면 오른쪽 이웃으로');
  assert.deepStrictEqual(UM.tabClose({ order: ['a', 'b', 'c'], active: 'c' }, 'c'), { order: ['a', 'b'], active: 'b' }, '맨 끝 탭이면 왼쪽 이웃으로');
  assert.deepStrictEqual(UM.tabClose(s3, 'a'), { order: ['b', 'c'], active: 'b' }, '다른 탭을 닫으면 고른 탭은 그대로');
  assert.deepStrictEqual(UM.tabClose({ order: ['a'], active: 'a' }, 'a'), { order: [], active: null }, '마지막 탭을 닫으면 시작 화면');
  assert.deepStrictEqual(UM.tabMove(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'], '끌어 옮기기');
  assert.deepStrictEqual(UM.tabMove(['a', 'b', 'c', 'd'], 0, UM.dropIndex(0, 2, true)), ['b', 'c', 'a', 'd'], 'c의 오른쪽 절반에 놓으면 c 뒤로');
  assert.deepStrictEqual(UM.tabMove(['a', 'b', 'c', 'd'], 3, UM.dropIndex(3, 1, false)), ['a', 'd', 'b', 'c'], 'b의 왼쪽 절반에 놓으면 b 앞으로');
  assert.deepStrictEqual(UM.tabMove(['a', 'b', 'c'], 1, UM.dropIndex(1, 2, false)), ['a', 'b', 'c'], '바로 뒤 탭의 앞 = 제자리');
  const s4 = { order: ['a', 'b', 'c', 'd'], active: 'b' };
  assert.deepStrictEqual(UM.tabsToClose(s4, 'others', 'c'), ['a', 'd', 'b'], '다른 탭 닫기: 고른 탭(b)은 맨 끝에 닫는다');
  assert.deepStrictEqual(UM.tabsToClose(s4, 'all', 'a'), ['a', 'c', 'd', 'b'], '모든 탭 닫기도 고른 탭이 맨 끝');
  assert.deepStrictEqual(UM.tabsToClose(s4, 'right', 'a'), ['c', 'd', 'b'], '오른쪽 탭 닫기');
  assert.deepStrictEqual(UM.tabsToClose(s4, 'one', 'd'), ['d']);
  assert.strictEqual(UM.tabCycle(s4, 1), 'c'); assert.strictEqual(UM.tabCycle({ order: ['a', 'b'], active: 'b' }, 1), 'a', 'Ctrl+Tab은 끝에서 처음으로 돈다');
  assert.strictEqual(UM.tabCycle({ order: ['a', 'b'], active: 'a' }, -1), 'b', 'Ctrl+Shift+Tab은 처음에서 끝으로');
  assert.deepStrictEqual(UM.dirtyOf(['a', 'b', 'c'], (p) => p !== 'b'), ['a', 'c']);
  // 화면 배선: 탭 줄(리본 위)·[+]·닫기 확인 창, 열기는 보던 자리를 기억하고 버리지 않는다
  for (const id of ['docTabs', 'dtList', 'dtAdd', 'closeTabsDialog', 'ctList', 'ctDiscard', 'ctCancel']) assert.match(html, new RegExp(`id="${id}"`), `탭 #${id}`);
  assert.ok(html.indexOf('id="docTabs"') < html.indexOf('id="ribbonBar"'), '문서 탭 줄은 리본 위');
  assert.match(html, /<script src="\/ui-model\.js"><\/script>/); assert.match(serverSource, /url\.pathname === '\/ui-model\.js'/, '서버가 ui-model.js를 내준다');
  const openFn = fnBodyOf(s, 'async function open(name');
  assert.doesNotMatch(openFn, /버리고 다른 파일을 열까요/, '탭을 바꿔도 고친 내용을 버리라고 묻지 않는다');
  assert.doesNotMatch(openFn, /\/api\/pdf\/close/, '탭을 바꿔도 서버의 고친 PDF를 닫지 않는다');
  assert.match(openFn, /if \(!opts\.noStash\) stashView\(\);/, '떠나는 탭의 보던 자리를 기억한다');
  assert.match(openFn, /await renderPdfDoc\(name, view\);/, '돌아오면 그 탭의 쪽·위치로 그린다');
  assert.match(openFn, /if \(view\?\.tool && view\.tool !== 'edit' && pdfPages\.length\) setTool\(view\.tool\);/, '도구도 탭마다');
  assert.match(openFn, /\$\('#searchInput'\)\.value = view\?\.search\?\.query \|\| '';[\s\S]{0,160}\$\('#searchBar'\)\.hidden = !view\?\.search\?\.open;/, '찾기 상태도 탭마다');
  assert.match(openFn, /else if \(view\?\.md && view\.md\.text !== view\.md\.saved\)/, '고친 Markdown은 탭 기억의 글로 되살린다(디스크에서 다시 읽어 덮지 않는다)');
  const stash = fnBodyOf(s, 'function stashView(');
  for (const k of ['zoomMode', 'pdfScale', 'page: i', 'frac:', 'tool', 'layout:', 'search:', 'v.aside', 'v.md = { text: docText, saved: savedText, eol: mdEol']) assert.ok(stash.includes(k), `stashView가 ${k}를 기억한다`);
  const rf = fnBodyOf(s, 'async function removeFile(');
  assert.match(rf, /if \(!opts\.confirmed && tabDirty\(p\) && !\(await confirmCloseTabs\(\[p\]\)\)\) return;/, '고친 탭을 닫을 때(지금 탭이 아니어도) 묻는다');
  assert.match(rf, /if \(next && !opts\.noSwitch\) await open\(next, \{ noStash: true \}\);/, '고른 탭을 닫으면 이웃 탭으로');
  assert.match(s, /\$\('#dtList'\)\.addEventListener\('auxclick'[\s\S]{0,120}e\.button === 1[\s\S]{0,60}removeFile/, '가운데 단추로 닫기');
  assert.match(s, /\$\('#dtList'\)\.addEventListener\('dragstart'/, '끌어 순서 바꾸기');
  for (const t of ['닫기', '다른 탭 닫기', '오른쪽 탭 닫기', '모든 탭 닫기']) assert.ok(fnBodyOf(s, 'function openTabCtxMenu(').includes(`menuItem('${t}'`), `탭 메뉴 [${t}]`);
  assert.match(s, /e\.key === 'Tab' && tabs\.length > 1/, 'Ctrl+Tab'); assert.match(s, /e\.code === 'KeyW' && !e\.shiftKey && cur\) \{ e\.preventDefault\(\); removeFile\(cur\); \}/, 'Ctrl+W');
  // 여러 탭 닫기 흐름을 실제로 돌린다: 미저장 이름을 한 번에 묻고, [취소]면 아무것도 닫지 않고, [닫기]면 고른 탭을 맨 끝에 닫는다
  const closeTabsSrc = fnBodyOf(s, 'async function closeTabs(') + '\n}';
  const runClose = async (answer, kind, p) => {
    const log = { asked: null, removed: [] };
    const fn = new Function('UM', 'tabs', 'cur', 'tabDirty', 'settleInplace', 'confirmCloseTabs', 'removeFile', `${closeTabsSrc}\nreturn closeTabs;`)(
      UM, ['a.pdf', 'b.md', 'c.pdf', 'd.pdf'], 'b.md', (x) => x === 'b.md' || x === 'd.pdf', async () => true,
      async (list) => { log.asked = list; return answer; }, async (x, o) => { log.removed.push([x, !!o.confirmed]); });
    await fn(kind, p);
    return log;
  };
  (async () => {
    const no = await runClose(false, 'all', 'a.pdf');
    assert.deepStrictEqual(no, { asked: ['d.pdf', 'b.md'], removed: [] }, '모든 탭 닫기: 고친 두 문서를 한 번에 묻고, 취소하면 아무것도 닫지 않는다');
    const yes = await runClose(true, 'all', 'a.pdf');
    assert.deepStrictEqual(yes.removed, [['a.pdf', true], ['c.pdf', true], ['d.pdf', true], ['b.md', true]], '닫기를 고르면 다시 묻지 않고(confirmed) 고른 탭을 맨 끝에');
    const others = await runClose(true, 'others', 'b.md');
    assert.deepStrictEqual([others.asked, others.removed.map((r) => r[0])], [['d.pdf'], ['a.pdf', 'c.pdf', 'd.pdf']], '다른 탭 닫기: 고친 다른 탭만 묻는다');
    const clean = await runClose(true, 'others', 'd.pdf');
    assert.deepStrictEqual(clean.asked, ['b.md'], '지금 탭(b.md)이 고쳐졌으면 그것도 묻는다');
  })().catch((e) => { console.error(e); process.exit(1); });
  assert.match(s, /window\.dirtyNames = \(\) => tabs\.filter\(tabDirty\)\.map\(pendLabel\);/, '창 닫기 확인에 고친 문서 이름(v6 Wave F: 적용하지 않은 글 표시)');
  assert.match(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), /window\.dirtyNames \? window\.dirtyNames\(\) : \[\]/, 'main.js가 고친 문서 이름을 늘어놓는다');
  assert.match(fnBodyOf(s, 'async function saveAs('), /tabs = tabs\.filter\(\(f\) => f !== to \|\| f === name\)\.map\(\(f\) => \(f === name \? to : f\)\);/, '다른 이름으로 저장하면 탭이 그 자리에서 새 이름으로');

  // B. 명령 검색: 초성·별칭·부분 일치. 실제 리본 버튼 + CMD_ALIASES로 찾아 본다
  assert.strictEqual(UM.choseong('암호 걸기'), 'ㅇㅎㄱㄱ'); assert.strictEqual(UM.choseong('PDF 열기'), 'pdfㅇㄱ');
  const aliasSrc = s.slice(s.indexOf('const CMD_ALIASES = {'), s.indexOf('};', s.indexOf('const CMD_ALIASES = {')) + 2);
  const CMD_ALIASES = new Function(`${aliasSrc}\nreturn CMD_ALIASES;`)();
  const ribbon = [...html.matchAll(/<button type="button" class="tb" id="(\w+)"[^>]*?(?:data-tip="([^"]*)")?[^>]*><span class="tl">([^<]*)<\/span><\/button>/g)]
    .map(([, id, tip, short]) => ({ id, label: (tip ? tip.split(':')[0] : short).trim(), aliases: [short, ...(CMD_ALIASES[id] || [])], tip: tip || '' }));
  assert.ok(ribbon.length >= 40, `리본 명령 ${ribbon.length}개`);
  for (const id of Object.keys(CMD_ALIASES)) assert.ok(ribbon.some((c) => c.id === id), `별칭의 ${id}는 리본 버튼이다`);
  const top = (q) => UM.searchCommands(q, ribbon, 5).map((c) => c.id);
  assert.strictEqual(top('ㅇㅎ')[0], 'protectBtn', '"ㅇㅎ" → 암호');
  assert.strictEqual(top('암호')[0], 'protectBtn', '"암호" → 암호');
  assert.strictEqual(top('압축')[0], 'menuDownsample', '"압축" → 용량 줄이기(별칭)');
  assert.strictEqual(top('ㅎㄱㅍ')[0], 'toolHighlight', '"ㅎㄱㅍ" → 형광펜');
  assert.strictEqual(top('쪽정')[0], 'menuExtract', '"쪽정" → 쪽 정리(띄엄띄엄이 아니라 앞부분)');
  assert.strictEqual(top('merge')[0], 'menuMerge', '영문 별칭');
  assert.strictEqual(top('워터')[0], 'watermarkBtn');
  assert.strictEqual(top('개인정')[0], 'piiBtn');
  assert.strictEqual(top('비밀')[0], 'protectBtn', '"비밀(번호)" → 암호');
  assert.ok(top('ㅁㄹㅁ').includes('headerFooterBtn'), '"ㅁㄹㅁ" → 머리말·꼬리말');
  assert.deepStrictEqual(top('zzzz'), [], '없으면 빈 목록');
  assert.ok(top('아').includes('protectBtn'), '조합 중인 "아"도 "암호"의 앞부분으로 맞는다');
  const dis = UM.searchCommands('저장', [{ label: '저장', disabled: true }, { label: '저장' }]);
  assert.ok(!dis[0].disabled, '점수가 같으면 쓸 수 있는 명령이 먼저');
  for (const id of ['cmdBox', 'cmdInput', 'cmdList']) assert.match(html, new RegExp(`id="${id}"`), `명령 검색 #${id}`);
  assert.match(html, /placeholder="명령 검색 \(Ctrl\+Q\)"/);
  assert.ok(html.indexOf('id="cmdBox"') > html.indexOf('id="ribbonTabs"') && html.indexOf('id="cmdBox"') < html.indexOf('id="toolbar"'), '명령 검색은 리본 탭 줄 오른쪽');
  assert.match(s, /e\.code === 'KeyQ'[\s\S]{0,200}\$\('#cmdInput'\)\.focus\(\)/, 'Ctrl+Q로 명령 검색');
  const run = fnBodyOf(s, 'function runCommand(');
  assert.match(run, /if \(c\.tab\) showRibbonTab\(c\.tab\);[\s\S]*flashButton\(c\.el\);[\s\S]*c\.el\.click\(\)/, '실행: 그 리본 탭으로 → 버튼을 빛내고 → 누른다');
  assert.match(fnBodyOf(s, 'function buildCommands('), /SHORTCUTS\.find\(\(s\) => s\.target === b\.id\)/, '단축키도 명령 목록에 보인다');
  assert.doesNotMatch(aliasSrc, /마스킹/, '별칭에도 옛 낱말(마스킹)을 쓰지 않는다');

  // C. 테마 설정(밝게·어둡게·시스템 따라가기) — 대비는 위 "밝은 아이보리 테마" 칸에서 두 테마 모두 잰다
  assert.strictEqual(UM.resolveTheme('dark', false), 'dark'); assert.strictEqual(UM.resolveTheme('system', true), 'dark');
  assert.strictEqual(UM.resolveTheme('system', false), 'light'); assert.strictEqual(UM.resolveTheme('light', true), 'light');
  for (const v of ['light', 'dark', 'system']) assert.match(html, new RegExp(`<input type="radio" name="themePref" value="${v}">`), `⚙ 설정 테마 ${v}`);
  assert.match(html, /id="setOutlines"/, '⚙ 설정의 상자 테두리');
  assert.match(fnBodyOf(s, 'function applyTheme('), /document\.documentElement\.dataset\.theme = UM\.resolveTheme\(pref, darkMQ\.matches\);[\s\S]*window\.retextPdf\?\.setTheme/, '테마를 고르면 화면과 창(nativeTheme)에 같이');
  assert.match(s, /darkMQ\.addEventListener\('change', \(\) => \{ if \(themePref\(\) === 'system'\) applyTheme\(\); \}\);/, '시스템 따라가기는 OS 테마가 바뀌면 따라간다');

  // D. 시작 화면: 큰 작업 단추 · 최근 파일(이름·폴더·마지막으로 연 때)
  for (const id of ['emptyOpen', 'startEdit', 'emptyMerge', 'emptyDownsampleFiles', 'startPii', 'startRaster', 'startOrganize', 'emptyExportImages', 'startProtect', 'startRecent', 'emptyRecent']) assert.match(html, new RegExp(`id="${id}"`), `시작 화면 #${id}`);
  assert.match(html, /<b>개인정보 가리기<\/b>/); assert.match(html, /<b>이미지 PDF로<\/b>/); assert.match(html, /끌어다 놓아도 열립니다/);
  assert.match(s, /\$\('#startPii'\)\.onclick = \(\) => openThen\(openPiiDialog\);/, '개인정보 가리기 = 파일을 고르면 개인정보 찾기 창까지');
  assert.match(s, /if \(pendingAfterOpen && pendingAfterOpen\.name === name\)/, '연 뒤 그 작업을 띄운다');
  const recent = fnBodyOf(s, 'function renderEmptyRecent(');
  assert.ok(recent.includes("'.rn'") && recent.includes("'.rd'") && recent.includes('UM.whenText(at[p], Date.now())'), '최근 파일: 이름 · 폴더 · 때');
  assert.match(fnBodyOf(s, 'function pushRecent('), /at\[p\] = Date\.now\(\);/, '연 때를 기억한다');
  const now = new Date(2026, 9, 15, 15, 0).getTime();
  assert.strictEqual(UM.whenText(new Date(2026, 9, 15, 9, 5).getTime(), now), '오늘 09:05');
  assert.strictEqual(UM.whenText(new Date(2026, 9, 14, 23, 59).getTime(), now), '어제 23:59');
  assert.strictEqual(UM.whenText(new Date(2026, 9, 11, 10, 0).getTime(), now), '4일 전');
  assert.strictEqual(UM.whenText(new Date(2026, 8, 1).getTime(), now), '2026. 9. 1.');
  assert.strictEqual(UM.whenText(undefined, now), '');

  // E. 쪽 보기 방식: 두 쪽(표지 따로)·한 쪽씩 넘기기의 줄·이동·맞춤 배율
  assert.deepStrictEqual(UM.spreadRows(5, false), [[0, 1], [2, 3], [4]]);
  assert.deepStrictEqual(UM.spreadRows(5, true), [[0], [1, 2], [3, 4]], '표지 따로: 1쪽 혼자');
  assert.deepStrictEqual(UM.spreadRows(0, true), []);
  assert.strictEqual(UM.stepPage(2, 1, 6, {}), 3); assert.strictEqual(UM.stepPage(5, 1, 6, {}), 5, '끝에서 멈춘다');
  assert.strictEqual(UM.stepPage(0, 1, 6, { spread: true }), 2, '두 쪽: 줄 단위로');
  assert.strictEqual(UM.stepPage(3, -1, 6, { spread: true }), 0);
  assert.strictEqual(UM.stepPage(0, 1, 6, { spread: true, cover: true }), 1, '표지 다음은 2-3쪽 줄');
  assert.strictEqual(UM.stepPage(2, 1, 6, { spread: true, cover: true }), 3);
  assert.deepStrictEqual(UM.visiblePages(4, 6, { spread: true, cover: true }), [3, 4]); assert.deepStrictEqual(UM.visiblePages(4, 6, {}), [4]);
  const pages = [{ w: 600, h: 800 }, { w: 600, h: 800 }, { w: 800, h: 600 }];
  assert.strictEqual(UM.fitScale({ mode: 'fitPage', viewW: 1000, viewH: 700, pages, idx: 0 }), 0.87, '한 쪽 전체 보기 = min(1000/600, 700/800) 내림');
  assert.strictEqual(UM.fitScale({ mode: 'fitPage', viewW: 1000, viewH: 700, pages, idx: 0, layout: { spread: true }, gap: 12 }), 0.82, '두 쪽 전체 보기 = 두 쪽 + 사이가 폭에 들어가게');
  assert.strictEqual(UM.fitScale({ mode: 'fitWidth', viewW: 1000, viewH: 700, pages, layout: { spread: true }, gap: 12 }), 0.62, '두 쪽 폭 맞춤 = 가장 넓은 쪽 두 칸');
  assert.strictEqual(UM.fitScale({ mode: 'fitPage', viewW: 1000, viewH: 700, pages, idx: 0, layout: { spread: true, cover: true }, gap: 12 }), 0.82, '표지 혼자여도 같은 두 칸 폭 기준');
  assert.strictEqual(UM.fitScale({ mode: 'fitPage', viewW: 0, viewH: 700, pages }), null, '잴 수 없으면 null(그대로 둔다)');
  assert.strictEqual(UM.fitScale({ mode: 'fitWidth', viewW: 100000, viewH: 700, pages }), 4, '최대 400%');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.match(css, /\.pdf\.spread\{display:grid;grid-template-columns:repeat\(2,max-content\);justify-content:safe center/, '두 쪽 보기는 두 칸 격자(넓으면 왼쪽부터 스크롤)');
  assert.match(css, /\.pdf\.spread\.cover>\.pdfPage:first-child\{grid-column:2\}/, '표지는 오른쪽 칸에 혼자');
  assert.match(css, /\.pdf\.paged>\.pdfPage\.offView\{display:none\}/, '한 쪽씩 넘기기는 지금 쪽만');
  assert.match(fnBodyOf(s, 'function fitScale('), /if \(viewLayout\.spread\) return UM\.fitScale\(/, '맞춤 배율은 두 쪽 보기를 따른다');
  assert.match(fnBodyOf(s, 'function currentPageIndex('), /if \(viewLayout\.paged\) return/, '한 쪽씩 넘기기의 지금 쪽');
  assert.match(fnBodyOf(s, 'function goToPage('), /if \(viewLayout\.paged\) \{ pagedIdx = /, '한 쪽씩 넘기기에서 쪽 이동');
  assert.match(s, /goToPage\(UM\.stepPage\(currentPageIndex\(\), 1, pdfPages\.length, viewLayout\)\)/, 'PageDown은 두 쪽 보기면 줄 단위');
  assert.match(fnBodyOf(s, 'function searchStep('), /revealPage\(hit\.i\);/, '찾기 결과 쪽을 보인다');
  // F. 상태줄 보기 도구 · 손 도구(Space) · 읽기 모드(F11·Esc)
  const sb = html.slice(html.indexOf('<div class="statusbar" id="statusbar">'), html.indexOf('<div id="dropOverlay"'));
  for (const id of ['viewBox', 'vbSelect', 'vbHand', 'vbLayout', 'vbRead']) assert.ok(sb.includes(`id="${id}"`), `상태줄 #${id}`);
  assert.ok(sb.indexOf('id="viewBox"') < sb.indexOf('id="pdfZoom"'), '보기 도구는 확대 묶음 앞');
  assert.match(s, /\$\('#pdf'\)\.addEventListener\('mousedown', \(e\) => \{\s*if \(!handActive\(\) \|\| e\.button !== 0\) return;\s*e\.preventDefault\(\); e\.stopPropagation\(\);/, '손 도구는 잡기 단계에서 도구 누르기를 막는다');
  assert.match(s, /\}, true\);\nfor \(const type of \['click', 'dblclick', 'contextmenu'\]\)/, '손 도구 중에는 상자 누르기·두 번 누르기도 막는다');
  assert.match(s, /e\.code !== 'Space'[\s\S]{0,200}isTyping\(document\.activeElement\)/, 'Space 손 도구는 입력 중이면 끈다');
  assert.ok(SH(s).some((x) => /Space/.test(x.keys)) && SH(s).some((x) => /F11/.test(x.keys)) && SH(s).some((x) => x.keys === 'Ctrl+Q'), '단축키 표에 Space·F11·Ctrl+Q');
  assert.ok(!SH(s).some((x) => x.keys === 'H' && x.target !== 'toolHighlight'), 'H는 그대로 형광펜(손 도구와 겹치지 않는다)');
  assert.match(css, /body\.reading \.docTabs,body\.reading \.ribbonBar,body\.reading \.toolbar,body\.reading \.ctxbar,body\.reading aside,body\.reading \.propPanel,body\.reading \.statusbar\{display:none!important\}/, '읽기 모드는 리본·패널·상태줄을 숨긴다');
  assert.match(s, /if \(e\.key === 'F11'\)/, 'F11'); assert.match(s, /e\.key === 'Escape' && reading/, 'Esc로 읽기 모드 나가기');
  assert.match(s, /document\.addEventListener\('fullscreenchange'/, '전체 화면을 나가면 읽기 모드도');
  // G. 같은 창에 읽히는 일반 스크립트들은 맨 위 이름(const·let·function)이 겹치지 않는다 — 겹치면 뒤 파일이 통째로 읽히지 않는다(find-replace.js의 api가 그랬다)
  const classic = [...html.matchAll(/<script src="\/([\w-]+\.js)"><\/script>/g)].map((m) => m[1]).filter((f) => fs.existsSync(path.join(__dirname, f)));
  const seen = new Map();
  for (const f of classic) for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/^(?:const|let|class|function) ([A-Za-z_$][\w$]*)/gm)) {
    assert.ok(!seen.has(m[1]), `${f}의 맨 위 이름 ${m[1]}이(가) ${seen.get(m[1])}와 겹친다`); seen.set(m[1], f);
  }
  assert.ok(classic.includes('ui-model.js') && classic.includes('find-replace.js'), '일반 스크립트 목록');
  console.log('OK — v6 Wave C 문서 탭·명령 검색·테마·시작 화면·쪽 보기 방식·손 도구·읽기 모드 단언 통과');
}
// ── v6 Wave D: Markdown 내보내기 · 쪽 자르기·크기 · 두 문서 비교 · 일괄 처리 · 링크 · 첨부 파일 · 영역 스냅샷 · 베이츠 번호 ─────────────
{
  const UM = require('./ui-model');
  const s = script.replace(/\r\n/g, '\n');
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const fnSrc = (name) => s.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const btn = (id) => html.match(new RegExp(`<button type="button" class="tb" id="${id}" data-icon="(\\w+)"[^>]*data-tip="([^"]+)"[^>]*><span class="tl">([^<]+)</span></button>`));
  // A. 리본: 버튼마다 아이콘·설명·짧은 이름, 아이콘은 ICONS에 있고, 탭·묶음이 맞다
  const where = { snapTool: 'rpanel-home', linkTool: 'rpanel-annot', linkListBtn: 'rpanel-annot', cropTool: 'rpanel-page', cropBtn: 'rpanel-page', pageSizeBtn: 'rpanel-page', batesBtn: 'rpanel-page',
    mdExportBtn: 'rpanel-doc', compareBtn: 'rpanel-doc', batchBtn: 'rpanel-doc', attachBtn: 'rpanel-doc' };
  const panelOf = (id) => { const k = html.indexOf(`id="${id}"`), p = html.lastIndexOf('<div class="rpanel" id="', k); return html.slice(p + 24, html.indexOf('"', p + 24)); };
  for (const [id, panel] of Object.entries(where)) {
    const m = btn(id);
    assert.ok(m, `#${id}: 아이콘 + 설명 + 짧은 이름`);
    assert.ok(new RegExp(`\\n  ${m[1]}: '<`).test(s), `#${id} 아이콘 ${m[1]}이 ICONS에 있다`);
    assert.strictEqual(panelOf(id), panel, `#${id}는 ${panel}에`);
  }
  for (const [id, t] of [['snapTool', 'snapshot'], ['linkTool', 'link'], ['cropTool', 'crop']]) assert.match(html, new RegExp(`id="${id}" data-icon="\\w+" data-tool="${t}" aria-pressed="false"`), `#${id}는 도구(${t})`);
  assert.match(html, /id="groupConvert" data-modes="empty pdf"/, '[일괄 처리]는 문서 없이도'); assert.match(html, /id="mdExportBtn" data-icon="markdown" data-modes="pdf"/);
  assert.match(html, /<button type="button" class="tabBtn" data-tab="attach" data-modes="pdf" role="tab"/, '왼쪽 패널 「첨부」 탭');
  // B. 명령 검색: 새 버튼이 이름·별칭·초성으로 찾아진다
  const aliases = new Function(`return ${s.slice(s.indexOf('const CMD_ALIASES = ') + 'const CMD_ALIASES = '.length, s.indexOf('};', s.indexOf('const CMD_ALIASES = ')) + 1)}`)();
  const cmds = Object.keys(where).map((id) => { const m = btn(id); return { id, label: m[2].split(':')[0].trim(), aliases: [m[3], ...(aliases[id] || [])], tip: m[2], group: '' }; });
  for (const [q, id] of [['마크다운', 'mdExportBtn'], ['md', 'mdExportBtn'], ['비교', 'compareBtn'], ['diff', 'compareBtn'], ['일괄', 'batchBtn'], ['ㅇㄱ ㅊㄹ', 'batchBtn'], ['링크', 'linkTool'], ['url', 'linkTool'],
    ['첨부', 'attachBtn'], ['스냅샷', 'snapTool'], ['캡처', 'snapTool'], ['자르기', 'cropTool'], ['크롭', 'cropTool'], ['a4', 'pageSizeBtn'], ['쪽 크기', 'pageSizeBtn'], ['베이츠', 'batesBtn'], ['bates', 'batesBtn'], ['ㅂㅇㅊ', 'batesBtn']]) {
    assert.strictEqual(UM.searchCommands(q, cmds, 3)[0]?.id, id, `명령 검색 "${q}" → ${id}`);
  }
  // C. 대화상자·패널
  for (const id of ['mdDialog', 'cropDialog', 'psDialog', 'batesDialog', 'cmpPick', 'cmpView', 'batchDialog', 'linksDialog']) assert.match(html, new RegExp(`<dialog id="${id}" class="panel`), `#${id}`);
  for (const id of ['linkPop', 'attachTab', 'attachList', 'cmpPaneA', 'cmpPaneB', 'cmpList', 'cmpPixels', 'batchFiles', 'batchSummary']) assert.ok(html.includes(`id="${id}"`), `#${id}`);
  for (const id of ['mdRange', 'cropRange', 'psRange', 'batesRange']) assert.match(html, new RegExp(`class="rangePick" id="${id}"`), `${id}: 쪽 범위 고르기`);
  const acts = [...html.matchAll(/<option value="(\w+)">/g)].map((m) => m[1]);
  for (const a of ['watermark', 'headerFooter', 'pageNumbers', 'bates', 'sanitize', 'pii', 'protect', 'rasterize', 'downsample', 'markdown']) {
    assert.ok(acts.includes(a) && html.includes(`<div data-act="${a}">`), `일괄 처리 동작 ${a}와 그 옵션 칸`);
    assert.ok(serverSource.includes(`case '${a}':`), `서버 batchOne이 ${a}를 처리한다`);
  }
  // D. 화면 → 서버 길(이 길들이 서버에 있다)
  for (const route of ['/api/pdf/export-markdown', '/api/pdf/crop', '/api/pdf/boxes', '/api/pdf/page-size', '/api/pdf/compare', '/api/pdf/compare/pixels', '/api/pdf/batch', '/api/pdf/links', '/api/pdf/link/create', '/api/pdf/link/update', '/api/pdf/link/delete',
    '/api/pdf/attachments', '/api/pdf/attachment/extract', '/api/pdf/attachment/add', '/api/pdf/attachment/delete', '/api/pdf/snapshot', '/api/pdf/snapshot/save', '/api/pdf/bates', '/api/pdf/bates/remove']) {
    assert.ok(s.includes(route), `화면이 ${route}를 부른다`);
    assert.ok(serverSource.includes(`'${route}'`), `서버에 ${route}`);
  }
  assert.match(fnBodyOf(s, "$('#mdRun').onclick = async () =>"), /runJob\([^)]*\(jobId\) => apiPost\('\/api\/pdf\/export-markdown'[\s\S]*if \(format === 'md' && o\.openTab\) await open\(r\.path\);/, '내보낸 .md를 Markdown 탭으로 연다');
  assert.match(fnBodyOf(s, "$('#batchRun').onclick = async () =>"), /runJob\([\s\S]*'\/api\/pdf\/batch'[\s\S]*batchSumLine/, '일괄 처리는 진행 창(취소) + 요약');
  assert.match(fnBodyOf(s, 'async function runCompare('), /runJob\('두 문서 비교'/, '비교도 진행 창');
  assert.match(s, /\$\('#cmpPaneA'\)\.addEventListener\('scroll', \(\) => cmpSync\(\$\('#cmpPaneA'\), \$\('#cmpPaneB'\)\)\);/, '함께 스크롤');
  // E. 링크: Ctrl+클릭은 잡기 단계에서 링크 위만 가로채고, 웹 주소는 main.js가 묻고 연다(자동으로 열지 않는다)
  assert.match(s, /if \(!\(e\.ctrlKey \|\| e\.metaKey\) \|\| e\.button !== 0 \|\| inplace \|\| !pdfOpen\(\)\) return;[\s\S]{0,300}if \(!l\) return;\s*e\.preventDefault\(\); e\.stopPropagation\(\);\s*wdFollowLink\(l\);\s*\}, true\);/, 'Ctrl+클릭 링크 따라가기');
  assert.match(fnBodyOf(s, 'async function wdFollowLink('), /window\.retextPdf\.openLink\(l\.uri\)/);
  assert.match(mainSrc, /ipcMain\.handle\('openLink'[\s\S]{0,300}\^\(https\?:\\\/\\\/\|mailto:\)[\s\S]{0,300}dialog\.showMessageBox[\s\S]{0,200}if \(r\.response !== 0\) return/, 'main.js: http(s)·mailto만, 묻고 나서 연다');
  assert.match(mainSrc, /ipcMain\.handle\('copyImage'[\s\S]{0,200}clipboard\.writeImage\(img\)/, '스냅샷: Electron 클립보드');
  for (const k of ['openAnyFile', 'saveFile', 'copyImage', 'openLink']) assert.match(preloadSource, new RegExp(`${k}: \\(`), `프리로드 ${k}`);
  // F. 좌표: 자른 쪽(원점 ox·oy)도 화면 ↔ PDF가 서로 되돌아온다
  const P = new Function(`let pdfScale = 1;\n${fnSrc('unrotatedSize')}\n${fnSrc('pdfToScreen')}\n${fnSrc('screenToPdf')}\nreturn { pdfToScreen, screenToPdf };`)();
  for (const rot of [0, 1, 2, 3]) {
    const page = { w: rot % 2 ? 250 : 350, h: rot % 2 ? 350 : 250, rotation: rot, ox: 20, oy: 40 };
    const r = { x0: 60, y0: 70, x1: 90, y1: 100 }, sc = P.pdfToScreen(page, r, 2), back = P.screenToPdf(page, sc, 2);
    for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(Math.abs(back[k] - r[k]) < 1e-9, `회전 ${rot}: ${k} 되돌아옴`);
  }
  const p0 = { w: 350, h: 250, rotation: 0, ox: 20, oy: 40 };
  assert.deepStrictEqual(P.pdfToScreen(p0, { x0: 20, y0: 40, x1: 20, y1: 40 }, 1), { left: 0, top: 250, width: 0, height: 0 }, '보이는 상자 왼쪽 아래 = 화면 (0, 높이)');
  assert.deepStrictEqual(P.pdfToScreen({ w: 100, h: 100, rotation: 0 }, { x0: 10, y0: 10, x1: 20, y1: 20 }, 1), { left: 10, top: 80, width: 10, height: 10 }, '원점이 없으면 예전 그대로');
  // G. 도구: 끌기 도구는 TOOL_NAMES·HINTS에 있고 setTool이 고리를 부른다
  for (const t of ['crop', 'link', 'snapshot']) { assert.match(s, new RegExp(`const TOOL_NAMES = \\{[^}]*${t}: '`), `TOOL_NAMES.${t}`); assert.match(s, new RegExp(`\\n  ${t}: '[^']+Esc로 끝'`), `HINTS.${t}`); }
  assert.match(fnBodyOf(s, 'function setTool('), /wdToolChanged\(name\);/);
  assert.match(fnBodyOf(s, 'function p9AfterRender('), /wdAfterRender\(name\);/, '다시 그린 뒤 링크·첨부 목록');
  assert.match(fnBodyOf(s, 'function showAsideTab('), /else if \(tab === 'attach'\) loadAttachList\(\);/);
  console.log('OK — v6 Wave D 리본·명령 검색·대화상자·서버 길·링크 따라가기·자른 쪽 좌표 단언 통과');
}
// ── v6 Wave E: 양식 채우기 · Word·한글 내보내기 ─────────────────────────────────────────────
{
  const UM = require('./ui-model');
  const s = script.replace(/\r\n/g, '\n');
  const btn = (id) => html.match(new RegExp(`<button type="button" class="tb" id="${id}" data-icon="(\\w+)"[^>]*data-tip="([^"]+)"[^>]*><span class="tl">([^<]+)</span></button>`));
  const panelOf = (id) => { const k = html.indexOf(`id="${id}"`), p = html.lastIndexOf('<div class="rpanel" id="', k); return html.slice(p + 24, html.indexOf('"', p + 24)); };
  // A. 리본: 문서 탭에 「양식」 묶음(강조·초기화·내보내기·가져오기·고정)과 변환 묶음의 [Word로]·[한글(HWPX)로]
  const ids = ['formHighlightBtn', 'formResetBtn', 'formExportBtn', 'formImportBtn', 'formFlattenBtn', 'docxExportBtn', 'hwpxExportBtn'];
  for (const id of ids) {
    const m = btn(id);
    assert.ok(m, `#${id}: 아이콘 + 설명 + 짧은 이름`);
    assert.ok(new RegExp(`\\n  ${m[1]}: '<`).test(s), `#${id} 아이콘 ${m[1]}이 ICONS에 있다`);
    assert.strictEqual(panelOf(id), 'rpanel-doc', `#${id}는 문서 탭에`);
    assert.match(s, new RegExp(`\\$\\('#${id}'\\)\\.onclick = `), `#${id}에 처리기가 있다`);
  }
  assert.match(html, /<div class="tgroup" id="groupForm" data-modes="pdf" role="group" aria-label="양식">/, '「양식」 묶음은 PDF일 때만');
  assert.match(html, /id="formHighlightBtn" data-icon="formHighlight" aria-pressed="true"/, '필드 강조는 켜고 끄는 단추');
  assert.match(html, /id="formImportBtn" data-icon="formImport" data-electron/, '가져오기는 앱(파일 선택 창)에서만');
  assert.match(html, /id="docxExportBtn" data-icon="word" data-modes="pdf"/); assert.match(html, /id="hwpxExportBtn" data-icon="hwp" data-modes="pdf"/);
  assert.ok(html.indexOf('id="docxExportBtn"') > html.indexOf('id="groupConvert"') && html.indexOf('id="docxExportBtn"') < html.indexOf('id="compareBtn"'), 'Word·한글은 변환 묶음(Markdown 옆)');
  // B. 명령 검색
  const aliases = new Function(`return ${s.slice(s.indexOf('const CMD_ALIASES = ') + 'const CMD_ALIASES = '.length, s.indexOf('};', s.indexOf('const CMD_ALIASES = ')) + 1)}`)();
  const cmds = [...ids, 'mdExportBtn', 'batchBtn'].map((id) => { const m = btn(id); return { id, label: m[2].split(':')[0].trim(), aliases: [m[3], ...(aliases[id] || [])], tip: m[2], group: '' }; });
  for (const [q, id] of [['워드', 'docxExportBtn'], ['word', 'docxExportBtn'], ['docx', 'docxExportBtn'], ['한글', 'hwpxExportBtn'], ['hwp', 'hwpxExportBtn'], ['한컴', 'hwpxExportBtn'],
    ['양식', 'formHighlightBtn'], ['폼', 'formHighlightBtn'], ['fdf', 'formExportBtn'], ['양식 초기화', 'formResetBtn'], ['양식 고정', 'formFlattenBtn'], ['데이터 가져오기', 'formImportBtn'], ['ㅇㅅ ㄱㅈ', 'formFlattenBtn']]) {
    assert.strictEqual(UM.searchCommands(q, cmds, 3)[0]?.id, id, `명령 검색 "${q}" → ${id}`);
  }
  // C. 일괄 처리: Word·한글 동작과 옵션 칸, 서버가 처리한다
  for (const a of ['docx', 'hwpx']) {
    assert.ok(html.includes(`<option value="${a}">`) && html.includes(`<div data-act="${a}">`), `일괄 처리 동작 ${a}`);
    assert.ok(serverSource.includes(`case '${a}':`), `서버 batchOne이 ${a}를 처리한다`);
    assert.match(fnBodyOf(s, 'function batchOptions('), new RegExp(`case '${a}': return \\{ images: `), `batchOptions ${a}`);
  }
  assert.match(serverSource, /const BATCH_ACTIONS = \[[^\]]*'docx', 'hwpx'(, '\w+')*\]/); // 뒤에 새 동작(Wave E2 'ocr')이 붙을 수 있다
  // D. 대화상자·서버 길
  for (const id of ['officeDialog', 'formReqDialog']) assert.match(html, new RegExp(`<dialog id="${id}" class="panel`), `#${id}`);
  assert.match(html, /class="rangePick" id="officeRange"/, 'Word·한글: 쪽 범위 고르기');
  for (const route of ['/api/pdf/export-office', '/api/pdf/form', '/api/pdf/form/set', '/api/pdf/form/reset', '/api/pdf/form/export', '/api/pdf/form/import', '/api/pdf/form/flatten']) {
    assert.ok(s.includes(route), `화면이 ${route}를 부른다`);
    assert.ok(serverSource.includes(`'${route}'`), `서버에 ${route}`);
  }
  assert.match(fnBodyOf(s, "$('#officeRun').onclick = async () =>"), /runJob\(ext === 'hwpx' \? '한글\(HWPX\)로 내보내기' : 'Word로 내보내기', \(jobId\) => apiPost\('\/api\/pdf\/export-office'/, 'Word·한글 내보내기는 진행 창(runJob)');
  // E. 양식 칸: 다시 그리기·쪽 새로 고침·확대 고리, 값은 한 칸씩(pdfMutate → 실행 취소 한 번), Tab 순서, 회전, 저장 전 필수 칸
  assert.match(fnBodyOf(s, 'function p9AfterRender('), /fmAfterRender\(name\);/);
  assert.match(fnBodyOf(s, 'function p9AfterRefresh('), /fmAfterRefresh\(i\);/);
  assert.match(fnBodyOf(s, 'function p9AfterZoom('), /fmDrawAll\(\);/);
  assert.match(fnBodyOf(s, 'function fmCommit('), /pdfMutate\('\/api\/pdf\/form\/set', \{ name, i: f\.i, index: f\.index, value \}/, '칸 하나 = 요청 하나');
  assert.match(fnBodyOf(s, 'function fmCommit('), /fmState\.queue = fmState\.queue\.then\(/, '값 쓰기는 차례로');
  assert.match(fnBodyOf(s, 'function fmControl('), /e\.key === 'Tab'[^\n]*fmFocusNext\(f, e\.shiftKey \? -1 : 1\)/, 'Tab·Shift+Tab');
  assert.match(fnBodyOf(s, 'function fmControl('), /rotate\(\$\{rot \* 90\}deg\)/, '돌린 쪽은 입력칸도 돌린다');
  assert.match(fnBodyOf(s, 'function fmDrawAll('), /pdfToScreen\(pg, \{ x0: f\.rect\[0\], y0: f\.rect\[1\], x1: f\.rect\[2\], y1: f\.rect\[3\] \}\)/, '칸 자리는 pdfToScreen으로');
  assert.match(fnBodyOf(s, 'function fmAfterRender('), /지원하지 않는 XFA 양식입니다/, 'XFA 전용 양식 알림');
  assert.match(html, /<span class="tl">양식 고정<\/span>/);
  for (const fn of ['async function save(', 'async function saveAs(']) assert.match(fnBodyOf(s, fn), /if \(!\(await confirmRequiredFields\(cur\)\)\) return;/, `${fn} 저장 전 필수 칸 확인`);
  assert.match(s, /if \(\(!fmChoice && \(tag === 'TEXTAREA' \|\| tag === 'INPUT'\)\) \|\| document\.activeElement\?\.isContentEditable\) return;/, '양식 확인란에 초점이 있어도 Ctrl+Z는 문서 실행 취소');
  // 순서·다음 칸 계산(fmTabOrder · fmFocusNext)을 따로 돌려 본다
  const T = new Function('fmState', 'fmKey', 'calls', `${fnBodyOf(s, 'function fmTabOrder(')}\n}\n${fnBodyOf(s, 'function fmFocusNext(')}\n}\nconst fmFocusField = (f) => calls.push(f.name);\nreturn { fmTabOrder, fmFocusNext };`);
  const fields = [{ i: 0, index: 0, name: 'a', type: 'text', rect: [0, 0, 1, 1] }, { i: 0, index: 1, name: 'ro', type: 'text', readOnly: true, rect: [0, 0, 1, 1] },
    { i: 0, index: 2, name: 'r', type: 'radio', rect: [0, 0, 1, 1] }, { i: 0, index: 3, name: 'r', type: 'radio', rect: [0, 0, 1, 1] }, { i: 0, index: 4, name: 's', type: 'signature', readOnly: true, rect: [0, 0, 1, 1] },
    { i: 1, index: 0, name: 'b', type: 'combo', rect: [0, 0, 1, 1] }];
  const calls = [], t = T({ fields }, (f) => `${f.i}:${f.index}`, calls);
  assert.deepStrictEqual(t.fmTabOrder().map((f) => f.name), ['a', 'r', 'b'], '읽기 전용·서명 칸은 건너뛰고 라디오 묶음은 한 번');
  t.fmFocusNext(fields[0], 1); t.fmFocusNext(fields[3], 1); t.fmFocusNext(fields[5], 1); t.fmFocusNext(fields[0], -1);
  assert.deepStrictEqual(calls, ['r', 'b', 'a', 'b'], 'Tab은 다음 칸, 끝에서는 처음으로, Shift+Tab은 앞으로');
  console.log('OK — v6 Wave E 양식(리본·칸 덮개·Tab 순서·필수 칸)·Word·한글 내보내기(리본·대화상자·일괄 처리·서버 길) 단언 통과');
}
// ── v6 Wave E2: 글자 인식(OCR) — 리본·명령 검색·스캔한 쪽 알림·대화상자·영역 인식·일괄 처리 ─────────────
{
  const UM = require('./ui-model');
  const s = script.replace(/\r\n/g, '\n');
  const btn = (id) => html.match(new RegExp(`<button type="button" class="tb" id="${id}" data-icon="(\\w+)"[^>]*data-tip="([^"]+)"[^>]*><span class="tl">([^<]+)</span></button>`));
  const panelOf = (id) => { const k = html.indexOf(`id="${id}"`), p = html.lastIndexOf('<div class="rpanel" id="', k); return html.slice(p + 24, html.indexOf('"', p + 24)); };
  // A. 리본: 문서 탭 「글자 인식」 묶음 — [글자 인식…](대화상자) · [영역 인식](끌기 도구)
  for (const id of ['ocrBtn', 'ocrRegionTool']) {
    const m = btn(id);
    assert.ok(m, `#${id}: 아이콘 + 설명 + 짧은 이름`);
    assert.ok(new RegExp(`\\n  ${m[1]}: '<`).test(s), `#${id} 아이콘 ${m[1]}이 ICONS에 있다`);
    assert.strictEqual(panelOf(id), 'rpanel-doc', `#${id}는 문서 탭에`);
  }
  assert.match(html, /<div class="tgroup" id="groupOcr" data-modes="pdf" role="group" aria-label="글자 인식">/);
  assert.match(html, /id="ocrRegionTool" data-icon="ocrRegion" data-tool="ocrRegion" aria-pressed="false"/, '영역 인식은 도구(setTool)');
  assert.match(s, /const TOOL_NAMES = \{[^}]*ocrRegion: '영역 글자 인식'/);
  assert.match(s, /\n {2}ocrRegion: '[^']+Esc로 끝'/, 'HINTS.ocrRegion');
  assert.match(s, /const WD_DRAG_TOOLS = \[[^\]]*'ocrRegion'\]/, '끌어 사각형을 받는 도구');
  assert.match(s, /else if \(tool === 'ocrRegion'\) ocrRegionRun\(d\.i, rect, d\.box\);/);
  assert.match(s, /\$\('#ocrBtn'\)\.onclick = \(\) => openOcrDialog\(\);/);
  // B. 명령 검색: OCR · 초성 ㄱㅈㅇㅅ · 문자 인식 · 스캔
  const aliases = new Function(`return ${s.slice(s.indexOf('const CMD_ALIASES = ') + 'const CMD_ALIASES = '.length, s.indexOf('};', s.indexOf('const CMD_ALIASES = ')) + 1)}`)();
  const cmds = ['ocrBtn', 'ocrRegionTool', 'mdExportBtn', 'batchBtn', 'snapTool', 'searchToggle', 'rasterizeBtn'].map((id) => { const m = btn(id) || html.match(new RegExp(`id="${id}" data-icon="(\\w+)"[^>]*?(?:data-tip="([^"]+)")?[^>]*><span class="tl">([^<]+)</span>`)); return { id, label: (m[2] || m[3]).split(':')[0].trim(), aliases: [m[3], ...(aliases[id] || [])], tip: m[2] || '', group: '' }; });
  for (const [q, id] of [['OCR', 'ocrBtn'], ['ocr', 'ocrBtn'], ['ㄱㅈㅇㅅ', 'ocrBtn'], ['글자 인식', 'ocrBtn'], ['문자 인식', 'ocrBtn'], ['스캔', 'ocrBtn'], ['영역 인식', 'ocrRegionTool'], ['영역 ocr', 'ocrRegionTool']]) {
    assert.strictEqual(UM.searchCommands(q, cmds, 3)[0]?.id, id, `명령 검색 "${q}" → ${id}`);
  }
  // C. 스캔한 쪽 알림: 문구 · 다시 그린 뒤·쪽 새로 고침 뒤 다시 계산 · [글자 인식…]은 스캔한 쪽만 고른 대화상자 · [×]는 문서마다
  assert.match(html, /<div id="ocrBanner" role="status" hidden><span id="ocrBannerText">스캔한 쪽입니다 — 글자 인식\(OCR\)을 하면 검색·복사·편집할 수 있습니다<\/span>/);
  assert.match(fnBodyOf(s, 'function p9AfterRender('), /ocrAfterRender\(name\);/);
  assert.match(fnBodyOf(s, 'function p9AfterRefresh('), /ocrUpdateBanner\(\);/);
  assert.match(fnBodyOf(s, 'function p9AfterZoom('), /ocrHidePop\(\);/);
  assert.match(fnBodyOf(s, 'function ocrScannedPages('), /UM\.scanPageInfo\(pdfObjects\[i\], pg\)\.scanned/, '스캔한 쪽 계산은 서버와 같은 ui-model');
  assert.match(s, /\$\('#ocrBannerRun'\)\.onclick = \(\) => openOcrDialog\(\{ scanned: true \}\);/);
  assert.match(fnBodyOf(s, 'function updateEmptyState('), /if \(mode !== 'pdf'\) \$\('#ocrBanner'\)\.hidden = true;/, 'PDF가 아니면 알림을 숨긴다');
  const pagesText = new Function(`${fnBodyOf(s, 'function ocrPagesText(')}\n}\nreturn ocrPagesText;`)();
  assert.strictEqual(pagesText([0, 1, 2, 4, 6, 7]), '1-3,5,7-8', '스캔한 쪽 목록 → 쪽 범위 글');
  // 윤곽선 글자 쪽만 있으면 알림 문구를 바꾼다(그림 쪽이 섞이면 원래 문구)
  assert.match(fnBodyOf(s, 'function ocrUpdateBanner('), /\.kind === 'outline'\);[\s\S]*\$\('#ocrBannerText'\)\.textContent = outlineOnly \? '글자가 도형\(윤곽선\)으로 그려져 있어 고를 수 없습니다/);
  // scanPageInfo: 글자 없는 큰 그림 쪽 · 띠 그림 여러 장으로 쪼갠 쪽 · 글자를 윤곽선으로 그린 쪽
  const A4 = { w: 595, h: 842 }, SCAN = (objs, pg = A4) => UM.scanPageInfo(objs, pg);
  assert.deepStrictEqual(SCAN([{ type: 'image', bounds: { x0: 0, y0: 0, x1: 595, y1: 842 } }]), { scanned: true, kind: 'image', chars: 0, imageCover: 1, glyphPaths: 0 });
  assert.strictEqual(SCAN([{ type: 'image', bounds: { x0: 0, y0: 0, x1: 595, y1: 842 } }, { type: 'text', text: '보이지 않는 OCR 글자가 스무 자 넘게 들어 있는 쪽', hidden: true }]).scanned, false, 'OCR한 쪽(투명 글자)은 스캔한 쪽이 아니다');
  assert.strictEqual(SCAN([{ type: 'image', bounds: { x0: 0, y0: 0, x1: 200, y1: 200 } }]).scanned, false, '작은 그림은 스캔이 아니다');
  assert.strictEqual(SCAN([]).scanned, false, '빈 쪽은 스캔이 아니다');
  const strips = Array.from({ length: 28 }, (_, k) => ({ type: 'image', bounds: { x0: 0, y0: 842 - (k + 1) * 30.07, x1: 595, y1: 842 - k * 30.07 } }));
  assert.deepStrictEqual([SCAN(strips).scanned, SCAN(strips).kind, SCAN(strips).imageCover], [true, 'image', 1], '쪽 폭 띠 그림 28장(한 장은 3.6%) = 함께 덮은 넓이로 스캔한 쪽');
  const twice = [{ type: 'image', bounds: { x0: 0, y0: 0, x1: 595, y1: 337 } }, { type: 'image', bounds: { x0: 0, y0: 0, x1: 595, y1: 337 } }];
  assert.strictEqual(SCAN(twice).imageCover, 0.4, '겹친 그림은 한 번만 센다(합이 아니라 합집합)');
  assert.strictEqual(SCAN(twice).scanned, false);
  const cross = [{ type: 'image', bounds: { x0: 0, y0: 0, x1: 400, y1: 842 } }, { type: 'image', bounds: { x1: 595, y1: 600, x0: 200, y0: 0 } }];
  assert.strictEqual(SCAN(cross).imageCover, Math.round((400 * 842 + 195 * 600) / (595 * 842) * 1000) / 1000, '어긋나게 겹친 두 장의 합집합 넓이');
  const glyph = (k) => ({ type: 'path', bounds: { x0: 40 + (k % 60) * 8, y0: 780 - Math.floor(k / 60) * 14, x1: 46 + (k % 60) * 8, y1: 789 - Math.floor(k / 60) * 14 } });
  const outlined = Array.from({ length: 120 }, (_, k) => glyph(k));
  assert.deepStrictEqual(SCAN(outlined), { scanned: true, kind: 'outline', chars: 0, imageCover: 0, glyphPaths: 120 }, '글자 크기 도형 120개 = 윤곽선 글자 쪽');
  assert.strictEqual(SCAN(outlined.slice(0, 59)).scanned, false, '도형이 적으면(59개) 그림 쪽이 아니다');
  assert.strictEqual(SCAN([...outlined, { type: 'text', text: '글꼴로 쓴 진짜 글자가 스무 자 넘게 있는 쪽입니다' }]).scanned, false, '글자가 있으면 윤곽선 도형이 있어도 아니다');
  const rules = Array.from({ length: 200 }, (_, k) => (k % 2 ? { type: 'path', bounds: { x0: 40, y0: 100 + k * 3, x1: 555, y1: 100.5 + k * 3 } } : { type: 'path', bounds: { x0: 40 + k * 2, y0: 100, x1: 40.5 + k * 2, y1: 120 } }));
  assert.strictEqual(SCAN(rules).glyphPaths, 0, '표 선(한쪽이 1pt보다 얇은 선)은 글자 도형으로 세지 않는다');
  assert.strictEqual(SCAN(outlined.map((o) => ({ ...o, mask: true }))).scanned, false, '가림 상자는 세지 않는다');
  assert.strictEqual(SCAN(outlined.map((o) => ({ ...o, ocr: 'cover' }))).scanned, false, 'OCR 배경 덮개는 세지 않는다');
  assert.strictEqual(SCAN(outlined, { w: 842, h: 595 }).kind, 'outline', '가로 쪽도 같다');
  // D. 대화상자: 언어(한국어+영어 기본)·쪽·방식 둘·편집 가능 경고·건너뛰기 → 진행 창(runJob) + pdfMutate(실행 취소 한 번)
  assert.match(html, /<dialog id="ocrDialog" class="panel"/);
  assert.match(html, /<input type="checkbox" class="ocrLang" value="kor" checked>한국어<\/label><label><input type="checkbox" class="ocrLang" value="eng" checked>영어/);
  assert.match(html, /class="rangePick" id="ocrRange"/);
  assert.match(html, /name="ocrMode" value="search" checked><b>검색 가능한 텍스트<\/b>/); assert.match(html, /name="ocrMode" value="edit"><b>편집 가능한 텍스트<\/b>/);
  assert.match(html, /id="ocrEditNote" hidden>⚠ 편집 가능한 텍스트는[^<]*바뀔 수 있습니다/, '편집 가능한 텍스트는 모양이 바뀔 수 있다고 알린다');
  assert.match(fnBodyOf(s, "$('#ocrRun').onclick = async () =>"), /runJob\('글자 인식\(OCR\)', \(jobId\) => pdfMutate\('\/api\/pdf\/ocr', \{ name, pages: range\.idxs\.map\(\(k\) => k \+ 1\)\.join\(','\), langs, mode, skipText, jobId \}/);
  assert.match(fnBodyOf(s, "$('#ocrRun').onclick = async () =>"), /afterDocChange\(name, /, '끝나면 다시 그리고 실행 취소 토스트');
  // E. 영역 인식 창: [복사] · [이 자리에 글자 넣기] 검색용·보이게 · Esc
  for (const id of ['ocrPopCopy', 'ocrPopSearch', 'ocrPopEdit', 'ocrPopClose']) assert.match(html, new RegExp(`<button id="${id}"`), `#${id}`);
  assert.match(html, /<span class="hint2">이 자리에 글자 넣기:<\/span>/);
  assert.match(fnBodyOf(s, 'async function ocrRegionRun('), /apiPost\('\/api\/pdf\/ocr-region', \{ name, i, rect, langs \}/);
  assert.match(fnBodyOf(s, 'async function ocrPopApply('), /pdfMutate\('\/api\/pdf\/ocr-apply', \{ name: p\.name, i: p\.i, lines: p\.r\.lines, mode, rect: p\.rect \}/);
  assert.match(s, /\$\('#ocrPopSearch'\)\.onclick = \(\) => ocrPopApply\('search'\);/); assert.match(s, /\$\('#ocrPopEdit'\)\.onclick = \(\) => ocrPopApply\('edit'\);/);
  // F. 일괄 처리: OCR(검색 가능)
  assert.ok(html.includes('<option value="ocr">OCR(검색 가능)</option>') && html.includes('<div data-act="ocr">'), '일괄 처리 동작 ocr');
  assert.ok(serverSource.includes("case 'ocr':"), '서버 batchOne이 ocr를 처리한다');
  assert.match(fnBodyOf(s, 'function batchOptions('), /case 'ocr': return \{ langs: \[\.\.\.document\.querySelectorAll\('\.boLang:checked'\)\]/);
  assert.match(serverSource, /const BATCH_ACTIONS = \[[^\]]*'ocr'\]/);
  // G. 서버 길
  for (const route of ['/api/ocr/status', '/api/pdf/ocr', '/api/pdf/ocr-region', '/api/pdf/ocr-apply']) {
    assert.ok(s.includes(route), `화면이 ${route}를 부른다`);
    assert.ok(serverSource.includes(`'${route}'`), `서버에 ${route}`);
  }
  console.log('OK — v6 Wave E2 글자 인식(리본·명령 검색·스캔한 쪽 알림·대화상자·영역 인식 창·일괄 처리·서버 길) 단언 통과');
}
function SH(src) { const a = src.indexOf('const SHORTCUTS = ['); return new Function(`return ${src.slice(a + 'const SHORTCUTS = '.length, src.indexOf('];', a) + 1)};`)(); }
function fnBodyOf(src, sig) { const k = src.indexOf(sig); assert.ok(k >= 0, `${sig}가 있다`); return src.slice(k, src.indexOf('\n}\n', k)); }

// 다른 PDF 프로그램 이름이 소스·문서·패키지에 남지 않게 한다(2026-10-16 사용자 요청 "다른 프로그램의 이름이나 참조가 없는지").
// 이름 목록은 이 시험 파일에 글자로 남지 않도록 base64로 둔다. 파일 형식이 요구하는 이름(Adobe 네임스페이스·한컴 HWPX 네임스페이스)과
// 라이브러리 이름(PDFium·tesseract·Hunspell 등)은 대상이 아니다.
{
  const names = Buffer.from('ZXpwZGZ8YWxwZGZ87JWMUERGfOyVjCBQREZ8d2Vub3RlfHdlbml2fHdvbmRlcnNoYXJlfHBkZmVsZW1lbnR8ZXN0c29mdHx1bmlkb2NzfGdlbm9mZmljZXxnZW5zcGFya3zsnbTsiqTtirjshoztlITtirg=', 'base64').toString('utf8');
  const re = new RegExp(names, 'i');
  const root = path.join(__dirname, '..');
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'tmp', 'dist', '.git', 'vendor'].includes(e.name) && !e.name.startsWith('.')) walk(p); }
    else if (/\.(js|html|md|json|css|yml|txt|nsh|xml)$/i.test(e.name) && p !== __filename && e.name !== 'package-lock.json') files.push(p); // v6.1: 설치 스크립트(.nsh)·Store 매니페스트 조각(.xml)도
  } };
  walk(root);
  const hits = files.filter((f) => re.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepStrictEqual(hits, [], `다른 PDF 프로그램 이름이 남은 파일: ${hits.join(', ')}`);
  const sample = fs.readFileSync(path.join(root, 'workspace', 'sample.pdf'), 'latin1');
  assert.ok(!re.test(sample) && !/claude|codex|chatgpt/i.test(sample), 'sample.pdf 본문에 다른 프로그램 이름이 없다');
  console.log(`OK — 다른 프로그램 이름 없음(${files.length}개 파일 검사)`);
}

// ── v6.1 열 수 있는 파일 넓히기: .markdown·.txt·그림(PDF로) · 연결 프로그램 목록 · 패키지 정리 ──────────────────
{
  const s = script, root = path.join(__dirname, '..');
  // A. 한 목록(ui-model)을 화면·main.js·server.js가 같이 쓴다
  assert.match(mainSource, /const UM = require\('\.\/ui-model'\)/, 'main.js가 파일 종류 목록(ui-model)을 쓴다');
  assert.match(fnBodyOf(mainSource, 'function pathsFromArgv(argv)'), /if \(!UM\.fileKind\(a\)\) continue;/, '실행 인자·두 번째 실행: PDF·.md·.markdown·.txt·그림을 받는다');
  assert.match(mainSource, /ipcMain\.handle\('openFiles'[\s\S]{0,400}extensions: UM\.OPEN_EXT \}[\s\S]{0,200}extensions: \['md', 'markdown', 'txt'\][\s\S]{0,120}extensions: UM\.IMAGE_EXT/, '열기 대화상자 첫 칸 = 열 수 있는 파일 모두, 그다음 PDF · Markdown·텍스트 · 그림');
  assert.match(mainSource, /kind === 'txt' \? \[\{ name: '텍스트', extensions: \['txt'\] \}\]/, '다른 이름으로 저장: .txt는 .txt');
  assert.match(mainSource, /ext === 'markdown' \? \['markdown', 'md'\] : \['md', 'markdown'\]/, '다른 이름으로 저장: .markdown은 .markdown이 기본');
  assert.match(mainSource, /opts\.defaultDir[\s\S]{0,160}path\.join\(opts\.defaultDir, path\.basename\(defaultPath\)\)/, '그림으로 만든 새 PDF: 그림 폴더에 <그림 이름>.pdf');
  assert.match(serverSource, /const isDoc = \(f\) => \['pdf', 'md', 'txt'\]\.includes\(uiModel\.fileKind\(f\)\);/, '작업 폴더·폴더 열기 목록: PDF·.md·.markdown·.txt(그림 제외)');
  assert.doesNotMatch(serverSource, /\/\\\.\(md\|pdf\)\$\/i/, '옛 .md/.pdf 정규식이 남지 않는다');
  // B. 화면: 끌어다 놓기·열기·탭 꼬리표
  assert.match(s, /const paths = all\.filter\(\(p\) => UM\.fileKind\(p\)\);/, '끌어다 놓기도 같은 목록');
  const add = fnBodyOf(s, 'function addFiles(paths)');
  assert.match(add, /const images = paths\.filter\(\(p\) => UM\.fileKind\(p\) === 'image'\);[\s\S]*if \(images\.length\) openImages\(images\);/, '그림은 openImages(PDF로 바꿔 새 탭)로');
  assert.match(s, /<span class="ext">\$\{UM\.kindLabel\(p\)\}<\/span>/, '시작 화면 최근 파일 꼬리표(PDF·MD·TXT)');
  assert.match(s, /<span class="ext\$\{md \? ' md' : ''\}">\$\{UM\.kindLabel\(p\)\}<\/span>/, '탭 꼬리표(PDF·MD·TXT)');
  // C. 그림 → PDF: 여러 장이면 묻는다 · 서버가 못 푸는 그림은 화면 디코더로 · 새 PDF는 최근 파일에 넣지 않는다
  const oi = fnBodyOf(s, 'async function openImages(images)');
  assert.match(oi, /if \(images\.length > 1\) \{\s*const choice = await askImageMerge\(images\);/, '여러 장이면 합칠지 묻는다');
  assert.match(oi, /apiPost\('\/api\/pdf\/from-images', \{ images: images\.map/, '서버 길 /api/pdf/from-images');
  assert.match(oi, /error\.status === 422 && Array\.isArray\(error\.data\?\.needDecode\)[\s\S]*decodeImageInPage\(images\[k\]\)/, '422 needDecode면 화면에서 풀어 다시 보낸다');
  assert.match(fnBodyOf(s, 'async function decodeImageInPage(p)'), /createImageBitmap\([\s\S]*IMAGE_MAX_SIDE[\s\S]*c\.toBlob\(resolve, lossy \? 'image\/jpeg' : 'image\/png', 0\.92\)/, '브라우저 디코더 → PNG(투명)·JPEG(사진), 긴 변 상한');
  assert.match(html, /<dialog id="imgMergeDialog"[\s\S]{0,400}id="imMerge" class="pri">한 PDF로 합치기<\/button><button type="button" id="imApart">따로 열기<\/button>/, '[한 PDF로 합치기] / [따로 열기]');
  assert.match(s, /if \(!freshDocs\.has\(name\)\) pushRecent\(name\);/, '새 PDF(임시 경로)는 최근 파일에 넣지 않는다');
  assert.match(fnBodyOf(s, 'async function save(opts = {})'), /if \(curFresh && window\.retextPdf\) return saveAs\(opts\);/, '새 PDF의 처음 저장은 위치를 고른다');
  assert.match(fnBodyOf(s, 'async function saveAs(opts = {})'), /window\.retextPdf\.saveAs\(cur, fresh \? \{ defaultDir: fresh\.dir \} : \{ suggestDocFolder: curTemp \|\| curReadOnly \}\)/, '저장 기본 폴더 = 그림이 있던 폴더');
  assert.match(s, /curFresh = info\.fresh \|\| null;/, '서버 info.fresh로 새 PDF를 안다');
  for (const route of ['/api/pdf/from-images', '/api/text']) assert.ok(serverSource.includes(`'${route}'`), `서버에 ${route}`);
  assert.match(serverSource, /if \(entry\.fresh\) throw Object\.assign\(httpError\(409/, '새 PDF의 그 자리 저장은 409 fresh');
  // D. 텍스트(.txt): 미리보기 없이 폭 전체 · 인코딩 그대로 저장 · 못 쓰는 글자는 UTF-8로 저장할지 묻는다
  assert.match(html, /\.split\.plain\{grid-template-columns:1fr\}\.split\.plain \.prev\{display:none\}/, '텍스트는 편집 칸이 폭 전체');
  assert.match(s, /\$\('#md'\)\.classList\.toggle\('plain', isTxt\(name\)\)/, '.txt를 열면 plain');
  assert.match(fnBodyOf(s, 'function preview()'), /if \(cur && isTxt\(cur\)\) \{ \$\('#prev'\)\.replaceChildren\(\); return; \}/, '텍스트는 Markdown으로 그리지 않는다');
  assert.match(s, /fetch\(\(txt \? '\/api\/text\?name=' : '\/api\/file\?name='\) \+ encodeURIComponent\(name\)\)/, '.txt는 /api/text(인코딩 알아보기)');
  assert.match(fnBodyOf(s, 'async function putText(name, text, eol = mdEol, enc = curEnc)'), /isTxt\(name\) \? `\/api\/text\?name=\$\{encodeURIComponent\(name\)\}&encoding=/, '.txt 저장은 열 때의 인코딩으로');
  assert.match(fnBodyOf(s, 'async function putTextAsk(name, text, eol, enc)'), /error\.status !== 422[\s\S]*askUtf8\([\s\S]*putText\(name, text, eol, 'utf-8'\)/, 'CP949로 못 쓰면 UTF-8로 저장할지 묻는다');
  assert.match(html, /<dialog id="encDialog"[\s\S]{0,300}id="encUtf8" class="pri">UTF-8로 저장<\/button>/, 'UTF-8로 저장 확인 창');
  assert.ok(s.includes("v.md = { text: docText, saved: savedText, eol: mdEol, scrollTop: ta.scrollTop, selStart: ta.selectionStart, selEnd: ta.selectionEnd, temp: curTemp, readOnly: curReadOnly, enc: curEnc };"), '탭 기억에 인코딩');
  assert.match(s, /putTextAsk\(p, v\.md\.text, v\.md\.eol, v\.md\.enc \|\| 'utf-8'\)/, '창 닫기 → 다른 탭 저장도 그 탭의 인코딩');
  // E. 연결 프로그램: .pdf만 electron-builder fileAssociations(기본 앱 등록), 나머지는 목록에만(NSIS OpenWithProgids · Store uap:FileTypeAssociation)
  assert.deepStrictEqual(pkg.build.fileAssociations.map((f) => f.ext), ['pdf'], 'fileAssociations는 .pdf만(APP_ASSOCIATE는 기본 앱 자리를 가져간다)');
  assert.strictEqual(pkg.build.nsis.include, 'build/installer.nsh');
  assert.strictEqual(pkg.build.appx.customExtensionsPath, 'build/appx-extensions.xml');
  const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
  const exts = ['md', 'markdown', 'txt', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];
  for (const e of exts) {
    assert.match(nsh, new RegExp(`!insertmacro retextOpenWith "${e}" "RetextPDF\\.(Text|Image)"`), `설치: .${e} 연결 프로그램 목록`);
    assert.match(nsh, new RegExp(`!insertmacro retextUnOpenWith "${e}" "RetextPDF\\.(Text|Image)"`), `제거: .${e}`);
  }
  assert.match(nsh, /WriteRegNone SHELL_CONTEXT "Software\\Classes\\\.\$\{EXT\}\\OpenWithProgids" "\$\{PROGID\}"/, 'OpenWithProgids 값만 더한다');
  assert.doesNotMatch(nsh, /"Software\\Classes\\\.\$\{EXT\}" ""/, '확장자 키의 기본값(기본 앱)은 쓰지 않는다');
  assert.doesNotMatch(nsh, /DeleteRegKey[^\n]*\\\.\$\{EXT\}/, '제거할 때 확장자 키를 통째로 지우지 않는다(값 하나만)');
  const xml = fs.readFileSync(path.join(root, 'build', 'appx-extensions.xml'), 'utf8');
  for (const e of exts) assert.ok(xml.includes(`<uap:FileType>.${e}</uap:FileType>`), `Store: .${e}`);
  // F. 패키지 정리: 시험 파일·시험 데이터는 앱에 넣지 않는다(실행 코드는 시험 파일을 읽지 않는다)
  for (const f of ['!app/test-data/**', '!app/**/*.test.js', '!app/pdf-test-fixtures.js']) assert.ok(pkg.build.files.includes(f), `build.files ${f}`);
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && n !== 'pdf-test-fixtures.js')) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, f), 'utf8'), /require\(['"]\.\/[^'"]*(\.test|pdf-test-fixtures)['"]?\)/, `${f}는 시험 파일을 읽지 않는다`);
  }
  assert.ok(fs.existsSync(path.join(__dirname, 'cp949.bin')) && fs.statSync(path.join(__dirname, 'cp949.bin')).size === 126 * 190 * 2, 'CP949 표(app/cp949.bin)가 앱에 들어간다');
  assert.ok(pkg.scripts.test.includes('node app/open-formats.test.js'), 'npm test에 v6.1 시험');
  console.log('OK — v6.1 열 수 있는 파일(.markdown·.txt·그림)·연결 프로그램 목록(NSIS·Store)·패키지 정리 단언 통과');
}
