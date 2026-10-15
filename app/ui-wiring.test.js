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
assert.match(html, /id="emptyDownsampleFiles"[^>]*>여러 파일 용량 줄이기/, '빈 상태 여러 파일 용량 줄이기 quick tool is enabled (WP-B2)');
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
  const drop = script.slice(script.indexOf("addEventListener('drop'"));
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
assert.match(script, /if \(mdEol === '\\r\\n'\) text = text\.replace/, '저장할 때 CRLF로 되돌린다');
// 2026-10-03: 여러 조각으로 된 줄도 폰트 맞추기가 된다 — 나머지 조각 idx를 remove로 넘긴다
assert.doesNotMatch(script, /fontButton\.disabled = selectedObj\.objs\.length !== 1/, '폰트 맞추기가 조각 하나짜리 줄로 묶여 있지 않다');
assert.match(script, /openPdfFontEditor\(\{[^}]*remove: selection\.objs\.slice\(1\)/, '폰트 창에 나머지 조각을 넘긴다');
console.log('OK — CRLF Markdown·여러 조각 줄 폰트 맞추기 단언 통과');

// 2026-10-15 2단계(줄 묶기): 글꼴·색이 섞인 줄은 상자 하나, 조각별 편집·문단 선택·객체 안 부분(15d)
assert.match(script, /const groupLines = \(objs\) => window\.groupLines\(objs, \{ mergeStyledRuns: true \}\)/, '화면 상자는 스타일 조각을 합친 줄 하나');
assert.match(script, /pdfMutate\('\/api\/pdf\/edit-runs', \{ name, i, lines: sel\.para \? sel\.para\.map\(\(m\) => runLine\(m\.line\)\) : \[runLine\(sel\.line\)\]/, '문단·조각별 편집은 /api/pdf/edit-runs 한 번(실행 취소 한 번)');
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
assert.strictEqual(pkg.version, '5.1.0', '버전은 5.1.0이다');
assert.strictEqual(require('../package-lock.json').version, '5.1.0', 'package-lock.json 버전도 5.1.0이다');
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
console.log('OK — 앱 이름 변경(Retext PDF 5.1.0) 단언 통과');

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
  assert.match(script, /return r\.ok \|\| r\.status === 401;/, '최근 파일 확인에서 암호 PDF(401)를 "없는 파일"로 지우지 않는다');
  assert.match(script, /'암호를 풀고 열었습니다\. 저장하면 암호 없는 사본이 됩니다\.'/, '암호를 풀고 연 문서 안내');
  assert.match(script, /'편집 제한을 풀고 열었습니다\./, '편집 제한을 풀고 연 문서 안내');
  assert.match(script, /if \(error\.data\?\.needSaveAs && cur === name\) return saveProtected\(name\)/, '저장 409 needSaveAs → 다른 이름으로 저장으로');
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
  assert.match(script, /showAsideTab\(isPdf \? 'page' : 'file'\)/, 'PDF를 열면 쪽 목록, Markdown을 열면 파일 목록');
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
  // :root 밖의 CSS는 색을 토큰으로 쓴다(종이 흰색·검색 강조·의미 색 등 몇 가지 예외만)
  const outside = css.replace(/:root\{[^}]*\}/, '').match(/#[0-9a-f]{3,8}\b/gi) || [];
  for (const c of outside) assert.ok(['#fff', '#ccc', '#e6e3dc', '#2f74c0', '#1d5fa8'].includes(c.toLowerCase()), `토큰 밖 하드코딩 색 ${c}는 허용 목록에 있다`);
  const mainSrc = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  assert.match(mainSrc, /backgroundColor: '#fbf9f4'/, '창 배경(시작할 때 깜빡임)도 아이보리');
  assert.strictEqual(mainSrc.match(/backgroundColor: '([^']+)'/)[1], tok.panel, '창 배경색 = --panel');

  // B. 쪽 기준 보기: PDF를 열면 쪽 전체 보기, 맞춤 방식이면 크기가 바뀔 때 다시 맞추고, %를 고르면 그 문서 동안 유지
  assert.match(script, /let zoomMode = 'fitPage';/, '확대 방식 기본 = 쪽 전체 보기');
  assert.match(fnBody('async function open(name)'), /zoomMode = 'fitPage';/, '문서를 열 때마다 쪽 전체 보기로 시작한다');
  assert.match(fnBody('async function renderPdfDoc(name)'), /if \(zoomMode !== 'manual' && pdfPages\.length\) pdfScale = fitScale\(zoomMode, keepPage\);[\s\S]*buildPages\(name, pdfScale\)/, '그리기 전에 맞춤 배율을 잰다');
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
function fnBodyOf(src, sig) { const k = src.indexOf(sig); assert.ok(k >= 0, `${sig}가 있다`); return src.slice(k, src.indexOf('\n}\n', k)); }
