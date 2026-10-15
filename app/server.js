// Retext PDF 백엔드: 정적 UI + 파일 읽기/쓰기 + PDF 편집(PDFium). 127.0.0.1에서만 열고 문서를 PC 밖으로 보내지 않는다
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.RETEXTPDF_PORT) || 4747;
const MARKED_BROWSER = path.join(path.dirname(require.resolve('marked')), 'marked.umd.js');
const DOMPURIFY_BROWSER = path.join(path.dirname(require.resolve('dompurify')), 'purify.min.js');
const CONF = path.join(os.homedir(), '.retext-pdf.json');
const pdfEngine = require('./pdf-engine');
const pdfEncrypt = require('./pdf-encrypt');
const pdfFonts = require('./pdf-fonts');
const fontService = require('./pdf-font-service');
const { applyEdits, verifyEdits, maskParts, redactRanges, redactArea, editRuns, verifyRuns } = require('./pdf-edit-service');
const pdfRewrite = require('./pdf-rewrite');
const pii = require('./pii');
const { parsePageRange } = require('./page-range');
const { parseOutlineText } = require('./outline-text');
const { jpegSize, decodePng, sniff, MIME } = require('./image-util');
const stamps = require('./stamp-store');
const { buildPrintHtml } = require('./print-html');
const APP_VERSION = require('../package.json').version;

let conf = {}; try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
// 기본 작업 폴더. 패키징된 앱에서는 __dirname이 app.asar 안이라 소스 옆 workspace는 읽기만 되고 저장이 실패한다
// → 사용자 문서 폴더 아래 Retext PDF를 만들고 첫 실행에만 샘플을 복사해 쓴다. 개발 실행(npm start / node server.js)은 저장소의 workspace 그대로
const SAMPLES = path.join(ROOT, '..', 'workspace');
// 앱에 동봉해 첫 실행에 복사하는 샘플(package.json build.files와 같은 목록). 회사 문서처럼 보이지 않는 가상 안내문만 넣는다(4.0.1).
// workspace의 sample.pdf·회의록_초안.*은 테스트 픽스처로만 저장소에 남는다
const BUNDLED_SAMPLES = ['독서모임_안내.md', '독서모임_안내.pdf'];
const PACKAGED = /[\\/]app\.asar[\\/]/i.test(ROOT);
function defaultWorkspace() {
  if (!PACKAGED) return SAMPLES;
  let documents = path.join(os.homedir(), 'Documents');
  try { documents = require('electron').app.getPath('documents'); } catch {}
  for (const dir of [path.join(documents, 'Retext PDF'), path.join(os.homedir(), 'Retext PDF')]) {
    try {
      if (!fs.existsSync(dir)) { // 사용자가 지운 샘플을 되살리지 않도록 폴더가 없을 때만 복사
        fs.mkdirSync(dir, { recursive: true });
        for (const name of BUNDLED_SAMPLES) {
          try { fs.copyFileSync(path.join(SAMPLES, name), path.join(dir, name)); } catch {}
        }
      }
      return dir;
    } catch (e) { console.error(`workspace ${dir}: ${e.message}`); }
  }
  return os.tmpdir();
}
let WS = conf.workspace && fs.existsSync(conf.workspace) ? conf.workspace : defaultWorkspace();
const pdfDocs = {}; // docKey(파일) → { doc, mtimeMs, dirty, busy, externalChange, undo, redo, ... }
const MAX_RENDER_SCALE = 4; // A4 기준 2380×3368px. 그 이상은 WASM 힙만 먹고 화면에서 구분되지 않는다
// 상태 코드를 실은 오류 — 공통 catch가 e.status로 응답한다
const httpError = (status, message) => Object.assign(new Error(message), { status });
// 캐시 키: 상대·절대 표기가 달라도 같은 파일이면 한 항목(Windows는 대소문자 무시)
const docKey = (name) => { const p = safe(name); return process.platform === 'win32' ? p.toLowerCase() : p; };

// ── 암호 PDF ───────────────────────────────────────────────────────────────
// 여는 암호가 걸린 파일은 /api/pdf/unlock {name, password}로 연다. 그 전까지 이 파일을 쓰는 PDF 요청은 모두
// 401 { error, needPassword:true, wrong } (wrong = 암호를 받았는데 틀림). 암호는 메모리의 캐시 항목(entry.password)에만 두고
// 디스크·설정에 쓰지 않는다 — 문서를 닫으면(dropDoc) 항목과 함께 사라진다. 디스크 파일이 바뀌어 다시 열 때만 다시 쓴다.
// entry.security는 처음 연 파일의 보안 정보 { encrypted, openPassword, restricted }. 엔진 저장 바이트는 암호가 풀린 문서라
// 실행 취소로 바꿔 끼운 문서는 암호가 없지만 "원본 파일이 암호 문서"라는 사실은 이 값으로 남긴다(덮어쓰기 저장 확인용)
const PLAIN = { encrypted: false, openPassword: false, restricted: false };
async function openPdf(bytes, password) {
  try { return await pdfEngine.open(bytes, password); }
  catch (e) {
    // AES-256 암호는 SASLprep(≈NFKC)한 UTF-8로 만든다(Acrobat·이 앱의 /api/pdf/protect). PDFium은 받은 그대로 비교하므로
    // 정규화로 바뀌는 암호(전각 문자 등)가 틀리면 정규화본으로 한 번 더 열어 본다
    const alt = e.code === 'PASSWORD_WRONG' && typeof password === 'string' ? pdfEncrypt.normalizePassword(password) : null;
    if (alt && alt !== password) {
      try { return await pdfEngine.open(bytes, alt); } catch (e2) { if (e2.code !== 'PASSWORD_WRONG') throw e2; }
    }
    if (e.code !== 'PASSWORD_REQUIRED' && e.code !== 'PASSWORD_WRONG') throw e;
    throw Object.assign(httpError(401, e.message), { extra: { needPassword: true, wrong: e.code === 'PASSWORD_WRONG' } });
  }
}
const newEntry = (doc, mtimeMs, password) => ({ doc, mtimeMs, dirty: false, undo: [], redo: [], undoBytes: 0, undoTrimmed: false,
  security: { ...(doc.security || PLAIN) }, ...(password ? { password } : {}) });

// 캐시된 PDF 문서를 반환. 없거나 디스크에서 파일이 바뀌었으면 (다시) 연다.
// 미저장 편집이 있으면(또는 긴 작업 중이면) 다시 열지 않는다 — 편집과 실행 취소 기록을 지키고
// externalChange로 "디스크의 파일이 바뀌었다"만 알린다(OneDrive 동기화·백신이 mtime을 바꾸는 경우). 저장하면 풀린다.
// password: /api/pdf/unlock이 넘긴다(처음 열기). 다시 열 때는 캐시 항목이 기억한 암호를 쓴다
async function getPdfDoc(name, password) {
  const p = safe(name), key = docKey(name), cached = pdfDocs[key];
  let mtimeMs;
  try { mtimeMs = fs.statSync(p).mtimeMs; } // 미저장 편집 중 파일이 사라져도(동기화가 옮김) 편집은 남겨 저장할 수 있게 한다
  catch (e) { if (cached?.dirty) { cached.externalChange = true; return cached; } throw e; }
  if (cached && cached.mtimeMs === mtimeMs) return cached;
  if (cached && (cached.dirty || cached.busy)) { if (cached.dirty) cached.externalChange = true; return cached; }
  const pw = password || cached?.password;
  if (cached) { delete pdfDocs[key]; cached.doc.close(); } // 다시 열기가 실패해도 닫힌 문서가 캐시에 남지 않게 먼저 뺀다
  const doc = await openPdf(fs.readFileSync(p), pw);
  if (pdfDocs[key]) { doc.close(); return pdfDocs[key]; } // 같은 파일을 동시에 연 다른 요청이 먼저 넣었다
  return (pdfDocs[key] = newEntry(doc, mtimeMs, doc.security?.openPassword ? pw : null));
}
// 문서를 바꾸는 요청용: 긴 작업이 같은 문서를 쓰는 중이면 409. 끼어들면 작업의 되돌리기·스냅샷이 엉킨다.
// 긴 작업 라우트는 이것으로 문서를 얻은 뒤 (await 없이) entry.busy = true, finally에서 푼다
async function getEditableDoc(name) {
  const entry = await getPdfDoc(name);
  if (entry.busy) throw httpError(409, '긴 작업이 끝난 뒤 다시 시도하세요.');
  return entry;
}
// 캐시에서 문서를 버린다(다른 파일로 덮어쓴 경우·닫기). 긴 작업이 쓰는 중이면 닫지 않고 409
function dropDoc(name) {
  const key = docKey(name), entry = pdfDocs[key];
  if (!entry) return;
  if (entry.busy) throw httpError(409, '긴 작업이 끝난 뒤 다시 시도하세요.');
  delete pdfDocs[key]; entry.doc.close();
}

// ponytail: undo 스택은 문서당 최대 20개(save() 바이트 통짜) — 600KB 문서 기준 12MB, 개인용 데스크톱 앱이라 넉넉함.
//   더 큰 문서/더 긴 히스토리가 필요해지면 diff 기반으로 바꿔야 함.
const UNDO_MAX = 20;
// P6 C3: 개수만으로는 모자란다 — 이미지가 많은 문서는 한 장(save() 바이트)이 수십 MB라 20개면 수 GB가 된다.
//   undo+redo 바이트 합계(entry.undoBytes)를 상한 아래로 유지한다. 최근 3단계는 무슨 일이 있어도 남긴다
//   (방금 한 편집을 되돌릴 수 없으면 편집기가 아니다). 잘라냈으면 undoTrimmed 플래그를 한 번 UI로 보낸다.
const UNDO_MAX_BYTES = 256 * 1024 * 1024;
const stackBytes = (entry) => [...entry.undo, ...entry.redo].reduce((n, s) => n + s.bytes.length, 0);
function trimStacks(entry) { // 합계를 다시 재고(최대 20+20개라 비용이 없다) 상한을 넘는 동안 가장 오래된 undo부터 버린다
  entry.undoBytes = stackBytes(entry);
  while (entry.undoBytes > UNDO_MAX_BYTES && entry.undo.length > 3) {
    entry.undoBytes -= entry.undo.shift().bytes.length;
    entry.undoTrimmed = true;
  }
  return entry.undoBytes;
}
function snapshot(entry, i, bytes = entry.doc.save()) {
  entry.undo.push({ bytes, page: i });
  if (entry.undo.length > UNDO_MAX) entry.undo.shift();
  entry.redo = [];
  trimStacks(entry);
}
// 엔진이 doc.batch를 지원하면 fn 동안 콘텐츠 재생성을 미뤄 쪽마다 한 번만 만든다(조각마다 쪽 전체를 다시 쓰면
// 옛 스트림이 파일에 쌓인다). 지원하지 않는 엔진이면 그냥 실행한다. 반환값은 fn의 것
function batch(doc, fn) {
  let r;
  if (typeof doc.batch === 'function') doc.batch(() => { r = fn(); }); else r = fn();
  return r;
}
// 실패한 변경을 되돌린다: 변경 전 바이트로 문서를 다시 연다. 다시 열지도 못하면(힙 부족 등) 바뀐 문서를 그대로 두되
// 변경 전 바이트를 실행 취소 스택에 넣고 미저장으로 표시한다 — 적어도 Ctrl+Z로 돌아갈 수 있다
async function restore(entry, i, before) {
  try { await swapDoc(entry, before); } catch { snapshot(entry, i, before); entry.dirty = true; }
}
// 스냅샷을 찍고 fn(동기 엔진 호출)으로 문서를 바꾼다. fn이 던지거나 { ok:false }를 주면 문서를 되돌리고
// 실행 취소 스택·redo·dirty는 손대지 않는다(하지 않은 일은 되돌릴 것도 없다). 성공하면 스냅샷을 쌓고 dirty.
async function mutate(entry, i, fn) {
  const before = entry.doc.save();
  let r;
  try { r = batch(entry.doc, fn); } catch (error) { await restore(entry, i, before); throw error; }
  if (r?.ok === false) { await restore(entry, i, before); return r; }
  snapshot(entry, i, before);
  entry.dirty = true;
  return r;
}
// 줄 편집 트랜잭션: 살아 있는 문서를 직접 고친 뒤 저장 바이트로 다시 열어 검증하고, 그 재열기 문서를 새 정본으로 쓴다
// (재열기는 고아 스트림도 떨군다). 실패하면 변경 전 바이트로 되돌리고 스택·dirty는 그대로 둔다.
// 비용: 저장 2회 + 열기 1회. 예전(사본 열기 + 저장 3회 + 열기 2회)은 290MB 문서에서 WASM 힙(2GB)을 넘겨 엔진이 죽었다.
async function editTransaction(entry, i, edits, options = {}) {
  return textTransaction(entry, i, (doc) => applyEdits(doc, i, edits, options),
    (persisted, result) => verifyEdits(persisted, i, edits, result.results, options)); // 지운 곁가지 조각만큼 인덱스를 고쳐 둔다
}
// 편집 트랜잭션 본체: apply(doc)로 살아 있는 문서를 고치고, 저장·재열기한 문서에 verify(persisted, result)를 돌린다(2단계 조각별 편집도 같은 틀)
async function textTransaction(entry, i, apply, verify) {
  const doc = entry.doc, before = doc.save(); // before = 실행 취소 스냅샷
  let persisted = null, result;
  try {
    result = batch(doc, () => apply(doc));
    persisted = await pdfEngine.open(doc.save());
    // 열기는 await라 이론상 다른 요청이 끼어들 수 있다 — 그새 문서가 바뀌었으면(실행 취소 등) 덮어쓰지 않는다
    if (entry.doc !== doc) throw new Error('파일이 변경됐습니다. 다시 편집하세요.');
    batch(persisted, () => verify(persisted, result));
  } catch (error) {
    if (persisted) persisted.close();
    if (entry.doc === doc) await restore(entry, i, before);
    throw error;
  }
  snapshot(entry, i, before);
  entry.doc = persisted;
  entry.dirty = true;
  doc.close();
  return result;
}
// undoTrimmed는 1회성: 한 번 실어 보낸 뒤 되돌린다(UI가 "오래된 실행 취소 기록을 버렸습니다"를 한 번만 알리게)
const stacks = (entry) => {
  const trimmed = !!entry.undoTrimmed;
  entry.undoTrimmed = false;
  return { undoLeft: entry.undo.length, redoLeft: entry.redo.length, undoBytes: entry.undoBytes || 0, ...(trimmed ? { undoTrimmed: true } : {}),
    ...(entry.externalChange ? { externalChange: true } : {}) }; // 미저장 편집 중 디스크 파일이 바뀌었다(getPdfDoc) — 저장하면 덮어쓴다
};
// 바이트를 다른 문서 객체로 바꿔 끼운다. 새 문서를 먼저 열고 나서 옛 것을 닫아, 열기에 실패해도 닫힌 핸들이 남지 않게 한다
async function swapDoc(entry, bytes) { const doc = await pdfEngine.open(bytes); entry.doc.close(); entry.doc = doc; }

// ── P6 C1: 긴 작업의 진행·취소 ─────────────────────────────────────────────
// 클라이언트가 요청 본문에 jobId(자기가 만든 문자열)를 넣으면 그 작업의 진행을 GET /api/jobs?id=… 로 볼 수 있고
// POST /api/jobs/cancel 로 멈출 수 있다. jobId가 없으면 추적만 없고 동작은 같다(등록하지 않는다).
// **취소는 단위 작업(페이지 1장·파일 1개·시도 1회) 사이에서만 본다** — PDFium은 WASM 동기 호출이라
// 한 장을 렌더하거나 한 번 downsample하는 중에는 이벤트 루프가 돌지 않아 끼어들 수 없다.
const JOB_TTL = 60000; // 끝난 작업은 60초 뒤 지운다(UI가 마지막 폴링으로 결과를 받을 시간)
const jobs = new Map();
// 등록 전에 온 취소(요청 본문을 읽거나 문서를 여는 사이 [취소]를 누른 경우): id를 기억했다가 startJob이 곧바로 취소 상태로 시작한다
const earlyCancels = new Map(); // id → 정리 타이머
function startJob(id, phase, total = 0) {
  const job = { id: id || null, phase, done: 0, total, message: '', cancelled: false, finished: false, error: null, timer: null };
  if (!id) return job; // 추적 안 함
  const old = jobs.get(id);
  if (old?.timer) clearTimeout(old.timer);
  if (earlyCancels.has(id)) { clearTimeout(earlyCancels.get(id)); earlyCancels.delete(id); job.cancelled = true; }
  jobs.set(id, job);
  return job;
}
// 진행 상황을 갱신하고 "계속해도 되는가"를 돌려준다 — 라우트는 if (!progress(...)) 로 취소를 처리한다
function progress(job, patch = {}) { Object.assign(job, patch); return !job.cancelled; }
function endJob(job, patch = {}) {
  if (job.finished) return job; // 오류 경로(catch)와 finally가 겹쳐 불려도 처음 상태를 지킨다
  Object.assign(job, patch, { finished: true });
  if (job.id && jobs.get(job.id) === job) { job.timer = setTimeout(() => jobs.delete(job.id), JOB_TTL); job.timer.unref(); }
  return job;
}
const jobView = (job) => ({ id: job.id, phase: job.phase, done: job.done, total: job.total, message: job.message, finished: job.finished, cancelled: job.cancelled, error: job.error });
// 단위 작업 사이에 이벤트 루프로 한 번 돌아간다. **이게 없으면 취소가 전혀 먹지 않는다**:
// await는 이미 이룬 프로미스에 대해 마이크로태스크만 돌리므로 HTTP 요청(폴링·취소)이 처리되지 않는다
// (실측 2026-09-10: setImmediate 없이 100쪽 용량 줄이기를 돌리니 127초 동안 /api/jobs 응답이 한 번도 오지 않았다).
const tick = () => new Promise((resolve) => setImmediate(resolve));

// P5 WP-B2: 용량 줄이기의 "목표 용량까지 반복" 로직을 공유 함수로 뽑는다 — /api/pdf/downsample(열린 문서)와
// /api/pdf/downsample-files(파일 여러 개, 열지 않고 처리)가 함께 쓴다. entry는 { doc } 모양이면 충분(undo/redo는 호출자 몫).
// P6 C4: 조기 종료 — 목표에 닿지 못하는 문서(이미 잘 압축된 스캔 등)에서 12번을 다 돌지 않는다.
//   비교 기준은 "전체 최선"이 아니라 **같은 dpi 단계 안의 직전 시도**다(검수 결정):
//   전체 최선과 견주면 낮은 dpi의 첫 시도가 최선보다 크기만 해도 그 단계의 품질 단계를 통째로 잃어버린다.
//   · 같은 dpi 안에서: 품질을 한 단 낮춘 시도가 그 단계의 직전 시도보다 1% 이상 줄지 않으면 남은 품질 단계를 건너뛴다
//     (품질을 더 낮춰도 안 줄어드는 이미지는 해상도를 낮춰야 줄어든다).
//   · dpi 단계 사이에서: 그 단계의 최선이 직전 단계의 최선보다 1% 이상 작지 않으면 "개선 없음"으로 센다.
//   · 개선 없는 dpi 단계가 두 번 연속이면 멈춘다(더 낮춰도 같은 결과 — 대개 전부 '줄여도 커짐'으로 건너뛴 문서).
//   · 목표에 닿으면 즉시 멈추고, 목표 미달이면 전체 최소 결과로 확정한다.
//   · attempts에는 실제로 돌린 시도만 남는다(건너뛴 조합은 기록하지 않는다).
//   · 맞바꿈: 품질 단계를 건너뛰다가 목표를 스칠 수 있다(예: q60이 0.5%만 줄었는데 q45라면 목표에 닿는 경우).
//     그래도 최선 결과는 언제나 확정되고, 시간을 몇 분씩 쓰는 쪽이 사용자에게 더 나쁘다.
// report(patch) → false면 취소. 호출자(라우트)가 진행 단위를 자기 방식으로 세므로(시도 1회 / 파일 1개) 여기서는 job을 직접 만지지 않는다.
const DOWNSAMPLE_MIN_GAIN = 0.01;
async function downsampleToTarget(entry, originalBytes, { maxDpi, quality, targetBytes, report }) {
  if (!targetBytes) { // 목표 용량 없이 한 번만 실행
    const r = entry.doc.downsample({ maxDpi, quality });
    return {
      before: r.before, after: r.after, changed: r.changed, skipped: r.skipped,
      reached: true, used: { maxDpi, quality }, attempts: [{ maxDpi, quality, before: r.before, after: r.after, changed: r.changed }],
    };
  }
  // 목표 용량이 있으면: maxDpi를 [입력,120,96,72] 순, quality를 [입력,60,45] 순으로 낮추며 반복. 매 시도는 원본에서 다시 시작한다.
  const dpis = [...new Set([maxDpi, 120, 96, 72])];
  const quals = [...new Set([quality, 60, 45])];
  const attempts = [];
  const keepGoing = (patch) => !report || report(patch) !== false;
  let best = null, reached = false, finalResult = null, stalledDpis = 0, cancelled = false;
  let prevStepBest = null; // 직전 dpi 단계의 최선 바이트(단계 사이 비교 기준)
  outer:
  for (const d of dpis) {
    let stepBest = null; // 이 dpi 단계의 최선
    let prevInStep = null; // 이 dpi 단계의 직전 시도 결과(단계 안 비교 기준)
    for (const qv of quals) {
      await tick(); // 시도 1회는 몇 초~수십 초짜리 동기 WASM 호출 → 그 앞에서만 멈출 수 있다
      if (!keepGoing({ message: `${d}dpi / 품질 ${qv} 시도 중`, attempt: attempts.length + 1 })) { cancelled = true; break outer; }
      await swapDoc(entry, originalBytes);
      const r = entry.doc.downsample({ maxDpi: d, quality: qv });
      attempts.push({ maxDpi: d, quality: qv, before: r.before, after: r.after, changed: r.changed, skipped: r.skipped.length });
      // P6 버그 고침: 옛 best에는 after 필드가 없어 `r.after < best.after`가 언제나 false였다 —
      // 목표 미달이면 "최소 결과"가 아니라 첫 시도 결과로 확정됐다(실측: 12회를 돌아 3.15MB를 찾고도 16.53MB로 확정).
      if (!best || r.after < best.after) best = { maxDpi: d, quality: qv, after: r.after, bytes: entry.doc.save(), result: r };
      if (!keepGoing({ message: `${d}dpi / 품질 ${qv} → ${(r.after / 1048576).toFixed(1)}MB`, attempt: attempts.length })) { cancelled = true; break outer; }
      if (r.after <= targetBytes) { reached = true; finalResult = { maxDpi: d, quality: qv, result: r }; break outer; }
      // 단계 안 비교: 첫 시도는 이 단계의 기준이므로 언제나 통과, 그 뒤는 직전 시도보다 1% 이상 줄어야 계속한다
      const stepImproved = prevInStep === null || r.after <= prevInStep * (1 - DOWNSAMPLE_MIN_GAIN);
      if (stepBest === null || r.after < stepBest) stepBest = r.after;
      prevInStep = r.after;
      if (!stepImproved) break; // 이 dpi에서 품질을 더 낮춰도 소용없다 → 다음 dpi
    }
    // 단계 사이 비교: 첫 단계는 기준이므로 개선으로 보고, 그 뒤는 직전 단계 최선보다 1% 이상 작아야 개선이다
    const dpiImproved = stepBest !== null && (prevStepBest === null || stepBest <= prevStepBest * (1 - DOWNSAMPLE_MIN_GAIN));
    if (stepBest !== null) prevStepBest = stepBest;
    if (dpiImproved) stalledDpis = 0;
    else if (++stalledDpis >= 2) break; // 두 dpi 단계 연속 제자리 → 더 낮춰도 같다
  }
  if (cancelled) return { cancelled: true, attempts, before: originalBytes.length };
  if (!reached) { await swapDoc(entry, best.bytes); finalResult = { maxDpi: best.maxDpi, quality: best.quality, result: best.result }; }
  return {
    before: originalBytes.length, after: finalResult.result.after, changed: finalResult.result.changed, skipped: finalResult.result.skipped,
    reached, used: { maxDpi: finalResult.maxDpi, quality: finalResult.quality }, attempts,
  };
}
// 건너뛴 이미지 대부분이 투명(SMask)이면 더 줄일 방법이 없다는 힌트를 덧붙인다 (downsample·downsample-files 공용)
function downsampleHint(skipped) {
  const alphaCount = skipped.filter((s) => s.reason === '투명(SMask)').length;
  return skipped.length && alphaCount / skipped.length > 0.5 ? { hint: '투명 이미지가 많아 더 줄일 수 없습니다' } : {};
}

// 절대경로는 그대로 씀 (로컬 단일 사용자 데스크톱 앱, OS 파일 대화상자에서 온 경로). 상대경로는 WS 밖으로 나갈 수 없다.
const safe = (p) => {
  if (p && path.isAbsolute(p)) return path.resolve(p);
  const abs = path.resolve(WS, p || ''), relative = path.relative(path.resolve(WS), abs);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('bad path');
  return abs;
};
// 임시 파일에 쓴 뒤 바꿔치기: 크래시로 원본이 잘리지 않는다. 다른 프로그램(Acrobat 등)이 잡고 있으면 rename이 EPERM/EBUSY → 이유를 알려준다
function writeAtomic(p, data) {
  const tmp = p + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); }
  catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    const busy = e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES';
    throw new Error(busy ? '저장 실패: 파일이 다른 프로그램에서 열려 있거나 쓰기 권한이 없습니다' : `저장 실패: ${e.message}`);
  }
}
// 인터넷에서 받아 연결 프로그램으로 바로 연 파일인지 판정한다(WP-B1: 임시 위치면 저장을 "다른 이름으로"로 유도).
// 브라우저·메일 클라이언트의 임시 다운로드 폴더 이름을 폭넓게 잡되, Downloads(사용자가 내려받아 보관하는 곳)는 임시로 치지 않는다.
const TEMP_DIR_ROOTS = [os.tmpdir(), path.join(process.env.LOCALAPPDATA || '', 'Temp')]
  .filter(Boolean).map((p) => path.resolve(p).toLowerCase());
const TEMP_NAME_MARKERS = ['inetcache', 'temporary internet files', 'content.outlook']; // 대소문자 무시, 경로 어디든 있으면 임시로 본다
function isTempPath(p) {
  const norm = path.resolve(p).toLowerCase();
  if (/[\\/]downloads[\\/]/.test(norm)) return false; // 사용자가 내려받아 보관하는 위치는 임시가 아님
  if (TEMP_DIR_ROOTS.some((root) => norm === root || norm.startsWith(root + path.sep))) return true;
  return TEMP_NAME_MARKERS.some((marker) => norm.includes(marker));
}
function isReadOnlyPath(p) {
  try { fs.accessSync(p, fs.constants.W_OK); return false; } catch { return true; }
}
// 이미지 바이트 → insertImage가 받는 모양 { image, width, height }. JPEG는 그대로(DCTDecode), PNG는 RGBA로 풀어 투명을 살린다.
// PNG 풀기는 image-util(node:zlib) — 못 푸는 PNG(인터레이스)는 Electron이면 nativeImage로 한 번 더 시도한다
function imageForPdf(data) {
  const type = sniff(data);
  if (type === 'jpeg') {
    const size = jpegSize(data);
    if (!size) throw httpError(400, 'JPEG 크기를 읽을 수 없습니다');
    return { image: { kind: 'jpeg', data }, width: size.width, height: size.height };
  }
  if (type !== 'png') throw httpError(400, '지원하지 않는 이미지 형식입니다 (PNG/JPEG만 가능)');
  try {
    const png = decodePng(data);
    return { image: { kind: 'rgba', data: png.data, width: png.width, height: png.height }, width: png.width, height: png.height };
  } catch (e) {
    if (!process.versions.electron) throw httpError(400, e.message);
    const img = require('electron').nativeImage.createFromBuffer(data);
    const { width, height } = img.getSize();
    if (!width || !height) throw httpError(400, '이미지를 읽을 수 없습니다');
    const bgra = img.toBitmap(), rgba = Buffer.alloc(bgra.length); // BGRA → RGBA
    for (let k = 0; k < bgra.length; k += 4) { rgba[k] = bgra[k + 2]; rgba[k + 1] = bgra[k + 1]; rgba[k + 2] = bgra[k]; rgba[k + 3] = bgra[k + 3]; }
    return { image: { kind: 'rgba', data: rgba, width, height }, width, height };
  }
}
// 상자를 안 주면 쪽 가운데에 폭 frac(쪽 폭 비율)로, 이미지 종횡비를 지켜 놓는다
function defaultBox(doc, i, imgW, imgH, frac) {
  const { w: pw, h: ph } = doc.pageSize(i);
  const boxW = pw * frac, boxH = boxW * (imgH / imgW);
  return { x: (pw - boxW) / 2, y: (ph - boxH) / 2, w: boxW, h: boxH };
}
// P9 공용: 쪽 범위 글 → 0 기준 쪽 배열(page-range.js, 잘못되면 400) · 쪽 번호 하나 검사 · 가리기 덮개 색 · 주석 작성자 기본값
const PII_LIMIT = 2000; // 개인정보 찾기 결과 상한(넘으면 truncated)
function pageRange(spec, count) {
  try { return parsePageRange(spec, count); } catch (e) { throw httpError(400, e.message); }
}
function pageIndex(doc, i) {
  const n = Number(i);
  if (i === null || i === '' || !Number.isInteger(n) || n < 0 || n >= doc.pageCount) throw httpError(400, `쪽 번호(i)가 잘못됐습니다: ${i}`);
  return n;
}
// 'black'(기본) · 'auto'(그 자리 배경색) · '#rrggbb'
function maskColorOf(color) {
  if (color == null || color === '' || color === 'black') return [0, 0, 0, 255];
  if (color === 'auto') return 'auto';
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (!m) throw httpError(400, `덮개 색이 잘못됐습니다: ${color} ('black'·'auto'·'#rrggbb')`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
function defaultAuthor() {
  try { return os.userInfo().username || 'Retext PDF'; } catch { return 'Retext PDF'; }
}
// 지운 것이 파일에 남지 않게 다시 쓰기: 저장 바이트에서 문서 카탈로그·/Info에서 닿는 객체만 남겨(pdf-rewrite.writePdf) 그 바이트로 다시 연다.
// 실측 2026-10-14: 이 세션에서 만든 주석을 지우면 /Annots에서는 빠져도 PDFium 저장본에 주석 사전(메모 글 포함)이 고아 객체로 그대로 쓰였다
// (파일에서 읽어 온 주석은 지우면 저장본에 남지 않는다). 세션 중 바꿔 넣은 그림의 옛 스트림도 같은 처지다.
// 그래서 진짜 가리기(개인정보·영역)·주석 지우기·숨은 데이터 지우기 뒤에는 이것을 부른다. 실패하면 false(문서는 그대로 — 가린 결과는 화면·글자에서 이미 유효)
async function compactDoc(entry) {
  try { await swapDoc(entry, pdfRewrite.writePdf(pdfRewrite.parsePdf(entry.doc.save()))); return true; }
  catch (e) { console.error('compact:', e.message); return false; }
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
// 요청 본문을 Buffer로 모은다. 조각마다 따로 UTF-8로 풀면 조각 경계에 걸린 한글이 깨진다(U+FFFD) → 다 모아 한 번에 푼다.
// 상한을 넘으면 413, 연결이 끊기면 거절해 라우트가 멈춰 있지 않게 한다
const BODY_MAX = 64 * 1024 * 1024;
const body = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > BODY_MAX) return reject(httpError(413, '요청이 너무 큽니다 (최대 64MB)')); // 나머지는 읽어 버린다
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
  req.on('close', () => { if (!req.complete) reject(httpError(400, '요청이 중간에 끊겼습니다')); });
});
// JSON 본문 → 객체. 깨진 JSON은 500이 아니라 400
async function readJson(req) {
  const text = (await body(req)).toString('utf8');
  let q; try { q = JSON.parse(text); } catch { throw httpError(400, '요청 형식이 잘못됐습니다 (JSON)'); }
  if (!q || typeof q !== 'object') throw httpError(400, '요청 형식이 잘못됐습니다 (JSON)');
  return q;
}
// 로컬 요청만 받는다. Host 검사는 DNS 리바인딩(외부 도메인을 127.0.0.1로 돌려 같은 출처처럼 요청) 방지, Origin 검사는 다른 사이트의 교차 출처 요청 방지
let port = PORT; // 실제로 연 포트 — 기본 포트가 다른 프로그램에 잡혀 있으면 아래 listen이 다음 포트로 옮긴다
const localHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
const trustedRequest = (req) => localHosts().includes(req.headers.host || '')
  && (!req.headers.origin || localHosts().map((h) => `http://${h}`).includes(req.headers.origin));

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, 'http://x'); // '//' 같은 경로는 여기서 던진다 — 잡지 않으면 처리되지 않은 거절로 프로세스가 죽었다
  } catch { return json(res, 400, { error: '잘못된 요청 주소' }); }
  try {
    if (!trustedRequest(req)) return json(res, 403, { error: '허용되지 않은 요청 출처' });
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, 'index.html')).pipe(res); }
    if (url.pathname === '/font-editor.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, 'font-editor.js')).pipe(res); }
    if (url.pathname === '/text-grouping.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, 'text-grouping.js')).pipe(res); }
    // P9: 쪽 범위 해석기·목차 글 형식은 화면과 서버가 같은 파일을 쓴다(window.parsePageRange · window.parseOutlineText)
    if (url.pathname === '/page-range.js' || url.pathname === '/outline-text.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(ROOT, url.pathname.slice(1))).pipe(res); }
    if (url.pathname === '/vendor/marked.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(MARKED_BROWSER).pipe(res); }
    if (url.pathname === '/vendor/purify.js') { res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(DOMPURIFY_BROWSER).pipe(res); }
    if (url.pathname === '/api/health') return json(res, 200, { appVersion: APP_VERSION }); // 화면 머리줄의 앱 버전(#ver)이 읽는다
    // P6 C1: 진행 조회·취소. UI는 긴 작업을 시작할 때 만든 jobId로 500ms마다 폴링하고 [취소]에서 cancel을 부른다
    if (url.pathname === '/api/jobs' && req.method === 'GET') {
      const job = jobs.get(url.searchParams.get('id') || '');
      if (!job) return json(res, 404, { error: '작업을 찾을 수 없습니다' }); // 아직 시작 전이거나 끝난 뒤 60초가 지났다
      return json(res, 200, jobView(job));
    }
    if (url.pathname === '/api/jobs/cancel' && req.method === 'POST') {
      const { id } = await readJson(req);
      if (!id) return json(res, 400, { error: '작업 id가 없습니다' });
      const job = jobs.get(id);
      if (!job) { // 아직 등록 전 — 기억해 두면 startJob이 취소 상태로 시작한다(끝난 지 오래된 id면 JOB_TTL 뒤 잊는다)
        clearTimeout(earlyCancels.get(id));
        const timer = setTimeout(() => earlyCancels.delete(id), JOB_TTL); timer.unref();
        earlyCancels.set(id, timer);
        return json(res, 200, { ok: true, pending: true });
      }
      job.cancelled = true; // 실제 중단은 라우트가 다음 단위 작업 사이에서 확인한다
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/workspace' && req.method === 'GET') return json(res, 200, { path: WS });
    if (url.pathname === '/api/workspace' && req.method === 'POST') {
      const { path: p } = await readJson(req);
      if (!fs.existsSync(p)) return json(res, 400, { error: '폴더 없음' });
      WS = path.resolve(p); fs.writeFileSync(CONF, JSON.stringify({ ...conf, workspace: WS })); return json(res, 200, { path: WS });
    }
    if (url.pathname === '/api/files') {
      const dir = url.searchParams.get('dir');
      if (dir) return json(res, 200, fs.readdirSync(dir).filter((f) => /\.(md|pdf)$/i.test(f)).sort().map((f) => path.join(dir, f)));
      return json(res, 200, fs.readdirSync(WS).filter((f) => /\.(md|pdf)$/i.test(f)).sort());
    }
    if (url.pathname === '/api/file' && req.method === 'GET') {
      const p = safe(url.searchParams.get('name'));
      if (!fs.existsSync(p)) return json(res, 404, { error: '파일 없음' }); // 헤더 전송 후 스트림 오류가 나면 프로세스가 죽는다 → 먼저 확인
      // Markdown은 원문 스트림이라 JSON 필드를 못 넣는다 → temp/readOnly는 헤더로 실어 보낸다(렌더러가 fetch 응답 헤더에서 읽음)
      res.writeHead(200, {
        'Content-Type': p.endsWith('.pdf') ? 'application/pdf' : 'text/plain; charset=utf-8',
        'X-Retext-Pdf-Temp': isTempPath(p) ? '1' : '0',
        'X-Retext-Pdf-Readonly': isReadOnlyPath(p) ? '1' : '0',
      });
      return fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
    }
    if (url.pathname === '/api/file' && req.method === 'PUT') { writeAtomic(safe(url.searchParams.get('name')), await body(req)); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/pdf/info' && req.method === 'GET') { // 서버가 문서 상태의 정본: 미저장 여부와 실행취소 스택도 함께 준다(새로고침·재열기 뒤 화면과 어긋나지 않게)
      const name = url.searchParams.get('name');
      const entry = await getPdfDoc(name);
      const p = safe(name);
      return json(res, 200, {
        pages: Array.from({ length: entry.doc.pageCount }, (_, i) => entry.doc.pageSize(i)), dirty: entry.dirty,
        temp: isTempPath(p), readOnly: isReadOnlyPath(p), security: entry.security || PLAIN, ...stacks(entry),
      });
    }
    // P7: 여는 암호가 걸린 PDF 열기. 맞으면 보통 열기처럼 캐시에 넣고(암호는 메모리에만) info와 같은 security를 준다.
    // 틀리면 401 { needPassword:true, wrong:true }. 이미 열려 있으면 그대로 ok
    if (url.pathname === '/api/pdf/unlock' && req.method === 'POST') {
      const { name, password } = await readJson(req);
      if (typeof password !== 'string' || !password) return json(res, 400, { error: '암호를 입력하세요' });
      const entry = await getPdfDoc(name, password);
      return json(res, 200, { ok: true, pageCount: entry.doc.pageCount, security: entry.security || PLAIN });
    }
    if (url.pathname === '/api/pdf/page' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      const scale = Math.max(0.25, Math.min(MAX_RENDER_SCALE, +(url.searchParams.get('scale') || 1.5) || 1.5));
      const png = await doc.render(+url.searchParams.get('i'), scale);
      res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png);
    }
    if (url.pathname === '/api/pdf/objects' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, doc.objects(+url.searchParams.get('i')));
    }
    // ── P4 WP-B2: 이미지 변환·페이지 추출·병합·이미지 삽입·용량 압축 ────────────
    if (url.pathname === '/api/pdf/export-images' && req.method === 'POST') { // 문서 상태는 바꾸지 않으므로 snapshot 없음
      const { name, pages, format, dpi, dir, jobId } = await readJson(req);
      const entry = await getEditableDoc(name), { doc } = entry; // 내보내는 동안 실행 취소 등이 doc을 닫지 못하게 잡는다
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: '저장할 폴더를 찾을 수 없습니다' });
      const scale = Math.max(36, Math.min(600, Number(dpi) || 150)) / 72;
      const base = path.basename(name).replace(/\.pdf$/i, '');
      const list = Array.isArray(pages) && pages.length ? pages.map(Number) : Array.from({ length: doc.pageCount }, (_, i) => i);
      const files = [];
      const job = startJob(jobId, 'export-images', list.length); // 진행 단위: 페이지 1장
      entry.busy = true;
      try {
        for (const i of list) {
          await tick(); // 이벤트 루프로 한 번 돌아가 취소·폴링을 받는다
          if (!progress(job, { message: `${i + 1}쪽 내보내는 중` })) return json(res, 200, { cancelled: true, files });
          const num = String(i + 1).padStart(2, '0');
          if (format === 'jpeg') {
            const file = path.join(dir, `${base}-p${num}.jpg`);
            writeAtomic(file, doc.renderJpeg(i, scale, 85));
            files.push(file);
          } else {
            const file = path.join(dir, `${base}-p${num}.png`);
            writeAtomic(file, await doc.render(i, scale));
            files.push(file);
          }
          progress(job, { done: files.length });
        }
        return json(res, 200, { files });
      } catch (e) { job.error = e.message; throw e; }
      finally { entry.busy = false; endJob(job); }
    }
    if (url.pathname === '/api/pdf/pages/delete' && req.method === 'POST') { // page:null 스냅샷 → undo/redo가 reloadAll을 준다
      const { name, indices, jobId } = await readJson(req);
      const entry = await getEditableDoc(name);
      // 진행 단위: 삭제 1회(한 번의 WASM 호출이라 그 앞에서만 취소를 본다. 빠르지만 다른 긴 작업과 형식을 맞춘다)
      const job = startJob(jobId, 'pages-delete', 1);
      entry.busy = true;
      try {
        await tick();
        if (!progress(job, { message: '쪽 지우는 중' })) return json(res, 200, { cancelled: true, ...stacks(entry) }); // 아직 아무것도 바꾸지 않았다
        const r = await mutate(entry, null, () => entry.doc.deletePages(indices));
        progress(job, { done: 1 });
        return json(res, 200, { ...r, ...stacks(entry) });
      } catch (e) { job.error = e.message; throw e; }
      finally { entry.busy = false; endJob(job); }
    }
    // ── P5 WP-B2: 회전·순서 변경·추출·분할·검색 ──────────────────────────────
    if (url.pathname === '/api/pdf/pages/rotate' && req.method === 'POST') { // page:null 스냅샷 → 회전은 쪽 크기(가로/세로)가 뒤바뀌어 문서 전체를 다시 그린다
      const { name, indices, delta } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.rotatePages(indices, delta));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/pages/reorder' && req.method === 'POST') { // FPDF_MovePages가 페이지 캐시를 비우므로 문서 전체를 다시 그린다(swapDoc은 불필요)
      const { name, order } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.reorderPages(order));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    // ── P7: 빈 쪽·복제·다른 PDF 끼우기 · 쪽 번호 — 모두 문서 전체 스냅샷(page:null) 하나 = 실행 취소 한 번, 응답에 reloadAll ──
    if (url.pathname === '/api/pdf/pages/blank' && req.method === 'POST') { // at 자리에 빈 쪽. width·height를 안 주면 옆 쪽 크기
      const { name, at, width, height } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.insertBlankPage(at, width, height));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/pages/duplicate' && req.method === 'POST') { // 각 쪽의 사본을 바로 뒤에. pages: 사본의 최종 인덱스
      const { name, pages } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.duplicatePages(pages));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/pages/insert-pdf' && req.method === 'POST') { // path: 다른 PDF(절대경로 또는 작업 폴더 상대). 암호 걸린 원본은 400
      const { name, at, path: src } = await readJson(req);
      if (!src) return json(res, 400, { error: '끼울 PDF를 고르세요' });
      const entry = await getEditableDoc(name);
      const file = safe(src);
      if (!fs.existsSync(file)) return json(res, 404, { error: '끼울 PDF를 찾을 수 없습니다' });
      const bytes = fs.readFileSync(file);
      let r;
      try { r = await mutate(entry, null, () => entry.doc.insertPdf(at, bytes)); }
      catch (e) { if (e.code === 'SOURCE_ENCRYPTED') throw Object.assign(httpError(400, e.message), { extra: { sourceEncrypted: true } }); throw e; }
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/page-numbers' && req.method === 'POST') { // 다시 부르면 옛 번호를 바꿔 끼운다(RetextPdfPageNum 마크)
      const { name, format, position, size, margin, startAt, skipFirst, color, font } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.addPageNumbers({ format, position, size, margin, startAt, skipFirst, color, fontId: font }));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/page-numbers/remove' && req.method === 'POST') { // 지울 번호가 없으면 ok:false(스냅샷도 없음)
      const { name } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.removePageNumbers());
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    // P7: 글상자 — 빈 자리에 새 글자. x·y는 상자 왼쪽 위(PDF 사용자 좌표). idxs의 객체는 이후 /api/pdf/edit 등 줄 편집으로 고칠 수 있다
    if (url.pathname === '/api/pdf/textbox' && req.method === 'POST') {
      const { name, i, x, y, text, font, size, color } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.addTextBox(i, { x, y, text, fontId: font, size, color }));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    // P7: 인쇄용 HTML(main.js 'print'가 숨은 창으로 연다). pages=0,2,5 (생략하면 전체). 저장하지 않은 편집까지 그린다
    if (url.pathname === '/api/pdf/print-html' && req.method === 'GET') {
      const name = url.searchParams.get('name');
      const { doc } = await getPdfDoc(name);
      const want = (url.searchParams.get('pages') || '').split(',').filter((s) => s.trim() !== '').map(Number);
      const list = (want.length ? want : Array.from({ length: doc.pageCount }, (_, i) => i)).filter((i) => Number.isInteger(i) && i >= 0 && i < doc.pageCount);
      if (!list.length) return json(res, 400, { error: '인쇄할 쪽이 없습니다' });
      const html = buildPrintHtml({ name, pages: list.map((i) => { const s = doc.pageSize(i); return { i, w: s.w, h: s.h }; }) });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    // ── P7: 도장 보관함(앱 데이터 폴더, 문서와 무관하게 다시 쓴다) ──
    if (url.pathname === '/api/stamps' && req.method === 'GET') return json(res, 200, stamps.list());
    if (url.pathname === '/api/stamps/image' && req.method === 'GET') {
      const { meta, data } = stamps.get(url.searchParams.get('id'));
      res.writeHead(200, { 'Content-Type': MIME[meta.type], 'Cache-Control': 'no-store' });
      return res.end(data);
    }
    // 넣기: JSON { name, data(base64) } 또는 { name, path(이미지 파일) }, 아니면 본문 = 이미지 바이트 + ?name=
    if (url.pathname === '/api/stamps' && req.method === 'POST') {
      const raw = await body(req);
      let name = url.searchParams.get('name'), data = raw;
      if (/json/i.test(req.headers['content-type'] || '') || raw[0] === 0x7b) { // '{'
        let q; try { q = JSON.parse(raw.toString('utf8')); } catch { throw httpError(400, '요청 형식이 잘못됐습니다 (JSON)'); }
        name = q.name ?? name;
        if (q.path) {
          const file = safe(q.path);
          if (fs.statSync(file).size > stamps.MAX_BYTES) throw httpError(413, '도장 이미지는 20MB 이하만 넣을 수 있습니다.');
          data = fs.readFileSync(file);
          if (name == null) name = path.basename(file).replace(/\.[^.]+$/, '');
        } else data = Buffer.from(String(q.data || ''), 'base64');
      }
      return json(res, 200, stamps.add(name, data));
    }
    if (url.pathname === '/api/stamps/delete' && req.method === 'POST') { const { id } = await readJson(req); return json(res, 200, stamps.remove(id)); }
    if (url.pathname === '/api/stamps/rename' && req.method === 'POST') { const { id, name } = await readJson(req); return json(res, 200, stamps.rename(id, name)); }
    // 도장 찍기: 보관함 이미지를 쪽에 넣는다(투명 PNG는 투명 그대로). w·h를 안 주면 쪽 폭의 25%로 가운데. 이후 /api/pdf/object/resize·/api/pdf/move로 조절
    if (url.pathname === '/api/pdf/stamp' && req.method === 'POST') {
      const { name, i, id, x, y, w, h } = await readJson(req);
      const { data } = stamps.get(id);
      const entry = await getEditableDoc(name);
      const { image, width, height } = imageForPdf(data);
      const box = [x, y, w, h].every(Number.isFinite) ? { x, y, w, h } : defaultBox(entry.doc, i, width, height, 0.25);
      const r = await mutate(entry, i, () => entry.doc.insertImage(i, image, box));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/pages/extract' && req.method === 'POST') { // 새 문서를 만드는 동작이라 실행취소 스택에는 넣지 않는다(병합과 같은 이유)
      const { name, indices, out } = await readJson(req);
      const { doc } = await getPdfDoc(name);
      const bytes = doc.extractPages(indices);
      const outPath = safe(out);
      dropDoc(out); // 같은 이름으로 이미 열려 있었으면 캐시를 버려 새 내용을 읽게 한다(긴 작업 중이면 409)
      writeAtomic(outPath, bytes);
      const check = await pdfEngine.open(bytes);
      const pageCount = check.pageCount;
      check.close();
      return json(res, 200, { path: out, pageCount });
    }
    if (url.pathname === '/api/pdf/split' && req.method === 'POST') { // N쪽씩 잘라 <이름>-1.pdf, -2.pdf … 로 폴더에 저장 (extractPages 반복 호출, 원본 불변)
      const { name, every, outDir, jobId } = await readJson(req);
      const entry = await getEditableDoc(name), { doc } = entry; // 자르는 동안 doc을 잡아 둔다
      const n = Number(every);
      if (!Number.isInteger(n) || n < 1) return json(res, 400, { error: '쪽 수는 1 이상의 정수로 입력하세요' });
      const dir = safe(outDir);
      if (!outDir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(res, 400, { error: '저장할 폴더를 찾을 수 없습니다' });
      const base = path.basename(name).replace(/\.pdf$/i, '');
      const files = [];
      const job = startJob(jobId, 'split', Math.ceil(doc.pageCount / n)); // 진행 단위: 조각 파일 1개
      entry.busy = true;
      try {
        for (let start = 0, part = 1; start < doc.pageCount; start += n, part++) {
          await tick();
          if (!progress(job, { message: `${part}번째 조각 만드는 중` })) return json(res, 200, { cancelled: true, files });
          const indices = Array.from({ length: Math.min(n, doc.pageCount - start) }, (_, k) => start + k);
          const bytes = doc.extractPages(indices);
          const file = path.join(dir, `${base}-${part}.pdf`);
          writeAtomic(file, bytes);
          files.push(file);
          progress(job, { done: files.length });
        }
        return json(res, 200, { files });
      } catch (e) { job.error = e.message; throw e; }
      finally { entry.busy = false; endJob(job); }
    }
    // 빈 질의는 PDFium FindNext가 영영 돌아오지 않는다(엔진 주석 참고) → 라우트 입구에서 바로 거절한다. 문서를 열기 전에 검사해 헛되이 열지 않는다.
    if (url.pathname === '/api/pdf/find' && req.method === 'POST') {
      const { name, query, matchCase } = await readJson(req);
      if (!query) return json(res, 400, { error: '검색어를 입력하세요' });
      const { doc } = await getPdfDoc(name);
      const LIMIT = 500;
      const hits = [];
      let truncated = false;
      for (let i = 0; i < doc.pageCount; i++) {
        const found = doc.find(i, query, { matchCase: !!matchCase, limit: LIMIT - hits.length });
        for (const f of found) hits.push({ i, ...f });
        if (hits.length >= LIMIT) { truncated = true; break; }
      }
      return json(res, 200, { hits, total: hits.length, truncated });
    }
    if (url.pathname === '/api/pdf/merge' && req.method === 'POST') { // 새 파일을 만드는 동작이라 실행취소 스택에는 넣지 않는다(대상이 열려 있던 문서면 캐시만 닫는다)
      const { paths, out, jobId } = await readJson(req);
      const list = [].concat(paths || []);
      if (!list.length) return json(res, 400, { error: '병합할 파일이 없습니다' });
      // 진행 단위: 읽는 파일 1개 + 마지막 병합 1단계(merge 자체는 한 번의 WASM 호출이라 중간에 멈출 수 없다)
      const job = startJob(jobId, 'merge', list.length + 1);
      try {
        const buffers = [];
        for (const p of list) {
          await tick();
          if (!progress(job, { message: `${path.basename(p)} 읽는 중` })) return json(res, 200, { cancelled: true, files: [] });
          buffers.push(fs.readFileSync(safe(p)));
          progress(job, { done: buffers.length });
        }
        await tick();
        if (!progress(job, { message: '병합하는 중' })) return json(res, 200, { cancelled: true, files: [] });
        const merged = await pdfEngine.merge(buffers);
        dropDoc(out);
        writeAtomic(safe(out), merged);
        const check = await pdfEngine.open(merged);
        const pageCount = check.pageCount;
        check.close();
        progress(job, { done: list.length + 1 });
        return json(res, 200, { path: out, pageCount });
      } catch (e) { job.error = e.message; throw e; }
      finally { endJob(job); }
    }
    if (url.pathname === '/api/pdf/image' && req.method === 'POST') {
      const { name, i, path: imgPath, box } = await readJson(req);
      const entry = await getEditableDoc(name);
      const imgFile = safe(imgPath || ''); // 다른 파일 경로와 같은 규칙(절대경로 그대로, 상대경로는 작업 폴더 안)
      if (!/\.(png|jpe?g)$/i.test(imgFile)) return json(res, 400, { error: '지원하지 않는 이미지 형식입니다 (PNG/JPEG만 가능)' });
      // P7: PNG는 Electron 없이도 풀고(image-util), 투명(알파)이 있으면 엔진이 SMask로 살린다 — 예전에는 흰 배경에 합성돼 밑 글자를 가렸다
      const { image, width: imgW, height: imgH } = imageForPdf(fs.readFileSync(imgFile));
      const finalBox = box || defaultBox(entry.doc, i, imgW, imgH, 0.4);
      const r = await mutate(entry, i, () => entry.doc.insertImage(i, image, finalBox));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/object/resize' && req.method === 'POST') {
      const { name, i, idx, box } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.resizeObject(i, idx, box));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/images' && req.method === 'POST') {
      const { name } = await readJson(req);
      const entry = await getPdfDoc(name);
      const images = []; let totalBytes = 0;
      for (let i = 0; i < entry.doc.pageCount; i++) {
        for (const st of entry.doc.imageStats(i)) { images.push({ page: i, ...st }); totalBytes += st.bytes; }
      }
      const fileBytes = fs.statSync(safe(name)).size;
      return json(res, 200, { images, totalBytes, fileBytes });
    }
    if (url.pathname === '/api/pdf/downsample' && req.method === 'POST') {
      const q = await readJson(req);
      const { name, targetBytes } = q;
      const maxDpi = Number(q.maxDpi) > 0 ? Number(q.maxDpi) : 150;
      const quality = Number(q.quality) > 0 ? Number(q.quality) : 75;
      const entry = await getEditableDoc(name);
      const originalBytes = entry.doc.save(); // 문서 전체 스냅샷(undo/redo가 reloadAll을 준다) — 성공했을 때만 실행 취소 스택에 쌓는다
      // 진행 단위: 시도 1회(dpi×품질 조합). 목표 용량이 없으면 한 번만 돈다
      const maxAttempts = targetBytes ? new Set([maxDpi, 120, 96, 72]).size * new Set([quality, 60, 45]).size : 1;
      const job = startJob(q.jobId, 'downsample', maxAttempts);
      entry.busy = true;
      try {
        let result;
        try {
          result = await downsampleToTarget(entry, originalBytes, { maxDpi, quality, targetBytes,
            report: ({ message, attempt }) => progress(job, { message, done: Math.max(0, attempt - 1) }) });
        } catch (e) { await restore(entry, null, originalBytes); throw e; } // 도중 실패 → 원본으로(스택·dirty는 그대로)
        if (result.cancelled) { // 문서를 바꾸는 작업 → 원본으로 되돌린다. 하지 않은 일이라 실행 취소 스택에도 넣지 않는다
          await restore(entry, null, originalBytes);
          return json(res, 200, { cancelled: true, attempts: result.attempts, ...stacks(entry) });
        }
        snapshot(entry, null, originalBytes);
        entry.dirty = true;
        return json(res, 200, { ...result, ...downsampleHint(result.skipped), ...stacks(entry) });
      } catch (e) { job.error = e.message; throw e; }
      finally { entry.busy = false; endJob(job); }
    }
    // P5 WP-B2: 빈 상태 빠른 도구 "여러 파일 용량 줄이기" — 문서를 열어 두지 않고 파일 경로 여러 개를 바로 처리한다.
    // 각 파일을 열어 downsampleToTarget을 돌리고 "<이름>-축소.pdf"로 저장한다(원본은 건드리지 않음, 실행취소 스택도 없음).
    if (url.pathname === '/api/pdf/downsample-files' && req.method === 'POST') {
      const q = await readJson(req);
      const paths = [].concat(q.paths || []);
      if (!paths.length) return json(res, 400, { error: '파일을 선택하세요' });
      const maxDpi = Number(q.maxDpi) > 0 ? Number(q.maxDpi) : 150;
      const quality = Number(q.quality) > 0 ? Number(q.quality) : 75;
      const targetBytes = q.targetBytes;
      const results = [];
      const files = [];
      const job = startJob(q.jobId, 'downsample-files', paths.length); // 진행 단위: 파일 1개(파일 안의 시도 사이에서도 취소를 본다)
      try {
        for (const p of paths) {
          await tick();
          if (!progress(job, { message: `${path.basename(p)} 줄이는 중` })) return json(res, 200, { cancelled: true, files, results });
          let entry = null;
          try {
            const src = safe(p);
            const originalBytes = fs.readFileSync(src);
            entry = { doc: await pdfEngine.open(originalBytes) };
            // 파일 안의 시도 진행은 메시지로만 보여 준다(진행 막대는 파일 수 기준을 유지)
            const result = await downsampleToTarget(entry, originalBytes, { maxDpi, quality, targetBytes,
              report: ({ message }) => progress(job, { message: `${path.basename(p)} — ${message}` }) });
            if (result.cancelled) return json(res, 200, { cancelled: true, files, results }); // 만들던 파일은 쓰지 않는다(writeAtomic 전)
            const dir = q.outDir ? safe(q.outDir) : path.dirname(src);
            const outPath = path.join(dir, path.basename(src).replace(/\.pdf$/i, '') + '-축소.pdf');
            writeAtomic(outPath, entry.doc.save());
            files.push(outPath);
            results.push({ path: p, out: outPath, before: result.before, after: result.after, reached: result.reached, used: result.used, ...downsampleHint(result.skipped) });
          } catch (e) { results.push({ path: p, error: e.message }); }
          finally { if (entry) entry.doc.close(); }
          progress(job, { done: results.length });
        }
        return json(res, 200, { results, files });
      } catch (e) { job.error = e.message; throw e; }
      finally { endJob(job); }
    }
    if (url.pathname === '/api/fonts' && req.method === 'GET') return json(res, 200, pdfFonts.list(url.searchParams.get('text') || ''));
    if (url.pathname === '/api/fonts/add' && req.method === 'POST') {
      const { path: file } = await readJson(req);
      return json(res, 200, pdfFonts.publicInfo(pdfFonts.register(file)));
    }
    if (url.pathname === '/api/pdf/font-context' && req.method === 'POST') {
      const q = await readJson(req), { doc } = await getPdfDoc(q.name);
      const ctx = fontService.context(doc, q.i, q.idx, q.text, q.token, q.remove), fonts = pdfFonts.list(q.text);
      return json(res, 200, { ...ctx, ...doc.fontStatus(q.i, q.idx, q.text), fonts, suggestedFontId: pdfFonts.suggest(ctx.object.font, fonts), image: doc.renderRegion(q.i, ctx.region).toString('base64') });
    }
    if (url.pathname === '/api/pdf/font-status' && req.method === 'POST') {
      const q = await readJson(req), { doc } = await getPdfDoc(q.name);
      fontService.context(doc, q.i, q.idx, q.text);
      return json(res, 200, doc.fontStatus(q.i, q.idx, q.text));
    }
    if (['/api/pdf/font-preview', '/api/pdf/font-apply'].includes(url.pathname) && req.method === 'POST') {
      const q = await readJson(req), entry = await getEditableDoc(q.name);
      const prepared = await fontService.prepare(entry.doc, q);
      if (await getPdfDoc(q.name) !== entry) throw new Error('파일이 변경됐습니다. 다시 선택하세요.');
      fontService.context(entry.doc, q.i, q.idx, q.text, q.token, q.remove);
      if (url.pathname.endsWith('font-apply')) {
        const next = await pdfEngine.open(prepared.bytes);
        try {
          fontService.context(entry.doc, q.i, q.idx, q.text, q.token, q.remove);
          snapshot(entry, q.i);
        } catch (error) { next.close(); throw error; }
        entry.doc.close(); entry.doc = next; entry.dirty = true;
      }
      return json(res, 200, { ...prepared.result, image: prepared.image, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/edit' && req.method === 'POST') {
      const { name, i, idx, text } = await readJson(req);
      const entry = await getEditableDoc(name);
      const { primaryResult: r } = await editTransaction(entry, i, [{ idx, text }], { primary: idx });
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/edits' && req.method === 'POST') {
      // remove: 지울 곁가지 조각(보이는 조각), align: { mode:'center'|'right', oldBounds } — 정렬까지 한 트랜잭션(실행 취소 한 번)
      const { name, i, edits, remove, align } = await readJson(req);
      const entry = await getEditableDoc(name);
      const result = await editTransaction(entry, i, edits, { primary: edits?.at(-1)?.idx, remove: [].concat(remove || []), align });
      return json(res, 200, { ...result, lineIdxs: result.primaryResult.lineIdxs || [result.primaryResult.idx], ...stacks(entry) });
    }
    // 2단계: 글꼴·색이 섞인 줄(조각별 모양 보존)·문단 다시 흘리기·객체 안 부분(15d) 편집 — pdf-edit-service.editRuns. 한 요청 = 스냅샷 하나(실행 취소 한 번)
    if (url.pathname === '/api/pdf/edit-runs' && req.method === 'POST') {
      const q = await readJson(req);
      const entry = await getEditableDoc(q.name);
      if (typeof q.oldText === 'string' && q.newText === q.oldText.replace(/­/g, '')) return json(res, 200, { ok: true, unchanged: true, lineIdxs: [], ...stacks(entry) });
      const r = await textTransaction(entry, q.i, (doc) => editRuns(doc, q.i, q), (persisted, result) => verifyRuns(persisted, q.i, result));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/group' && req.method === 'POST') { // 상자 묶기(id 생략→새 그룹) / 풀기(id:null)
      const { name, i, idxs, id } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.setGroup(i, idxs, id === undefined ? undefined : id));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/fit' && req.method === 'POST') { // 폭 맞춤 편집: wrap(줄바꿈) / shrink(축소) / none
      // blank: 같은 줄의 나머지 조각 idx들 — 여기서 함께 비운다. 편집 한 번은 실행 취소 한 번이어야 하는데,
      // 예전에는 UI가 /api/pdf/edits로 먼저 비우고 /api/pdf/fit을 또 불러 스냅샷이 두 개 쌓였다(Ctrl+Z 두 번 필요).
      const { name, i, idx, text, maxWidth, mode, blank, remove, align } = await readJson(req);
      const entry = await getEditableDoc(name);
      const result = await editTransaction(entry, i, [
        ...[].concat(blank || []).map((b) => ({ idx: b, text: ' ' })),
        { idx, text },
      ], { primary: idx, fit: { maxWidth: +maxWidth, mode }, remove: [].concat(remove || []), align });
      const r = result.primaryResult;
      return json(res, 200, { ...r, lineIdxs: r.lineIdxs || [r.idx], ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/charboxes' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, doc.charBoxes(+url.searchParams.get('i'), +url.searchParams.get('idx')));
    }
    if (url.pathname === '/api/pdf/move' && req.method === 'POST') {
      const { name, i, idxs, dx, dy } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.move(i, idxs, dx, dy));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/rect' && req.method === 'POST') {
      const { name, i, bounds, color } = await readJson(req);
      const entry = await getEditableDoc(name);
      const col = color === 'auto' ? entry.doc.sampleColor(i, bounds) : (color || [0, 0, 0, 255]); // 'auto' = 그 자리 배경색
      const r = await mutate(entry, i, () => { const a = entry.doc.addRect(i, bounds, col); return a.idx < 0 ? { ...a, ok: false } : a; });
      return json(res, 200, { ...r, color: col, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/remove' && req.method === 'POST') {
      const { name, i, idx } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.removeObject(i, idx));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/redact' && req.method === 'POST') {
      const { name, i, idx, from, to } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, i, () => entry.doc.redact(i, idx, from, to));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/mask' && req.method === 'POST') {
      const { name, i, parts, fallbackRects, color } = await readJson(req);
      if (!Array.isArray(parts)) return json(res, 400, { error: '가릴 글자를 고르세요' });
      const entry = await getEditableDoc(name);
      // 글자 제거 + 줄마다 덮개 하나(pdf-edit-service.maskParts). 하나라도 가렸으면 성공(건너뛴 조각은 skipped로 알린다).
      // 아무것도 못 가렸으면 ok:false — mutate가 문서를 되돌리고 스택은 그대로. 서버 라우트 하나 = 스냅샷 하나라 실행 취소 한 번
      // P9: 덮개와 겹치는 주석(메모·형광펜·도형, 링크·양식 칸 제외)도 같은 스냅샷 안에서 지운다 — 가린 글자가 주석 메모로 남지 않게.
      // 지운 주석이 있으면 저장본에 고아 객체로 남지 않게 다시 쓴다(compactDoc)
      const r = await mutate(entry, i, () => { const m = maskParts(entry.doc, i, parts, { color, fallbackRects }); if (m.ok) m.annots = entry.doc.removeAnnotsIn ? entry.doc.removeAnnotsIn(i, m.rects) : 0; return m; });
      if (r.annots) await compactDoc(entry);
      return json(res, 200, { ok: r.ok, rects: r.ok ? r.rects : [], skipped: r.skipped, annots: r.annots || 0, textLeft: entry.doc.pageText(i), ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/undo' && req.method === 'POST') {
      const { name } = await readJson(req);
      const entry = await getEditableDoc(name);
      if (!entry.undo.length) return json(res, 200, { ok: false });
      const { bytes, page } = entry.undo.at(-1), current = entry.doc.save();
      await swapDoc(entry, bytes); // 먼저 바꿔 끼운다 — 열기에 실패하면 스택은 그대로다
      entry.undo.pop();
      entry.redo.push({ bytes: current, page });
      trimStacks(entry); // redo로 옮겨도 합계는 그대로다 → 상한을 다시 확인한다(P6 C3)
      entry.dirty = true;
      return json(res, 200, { ok: true, page, reloadAll: page === null, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/redo' && req.method === 'POST') {
      const { name } = await readJson(req);
      const entry = await getEditableDoc(name);
      if (!entry.redo.length) return json(res, 200, { ok: false });
      const { bytes, page } = entry.redo.at(-1), current = entry.doc.save();
      await swapDoc(entry, bytes);
      entry.redo.pop();
      entry.undo.push({ bytes: current, page });
      trimStacks(entry); // P6 C3
      entry.dirty = true;
      return json(res, 200, { ok: true, page, reloadAll: page === null, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/text' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, { text: doc.pageText(+url.searchParams.get('i')) });
    }
    if (url.pathname === '/api/pdf/save' && req.method === 'POST') {
      const { name, force } = await readJson(req);
      const entry = await getEditableDoc(name);
      // P7: 암호·권한이 걸린 원본을 그대로 덮어쓰면 암호가 풀린 파일로 바뀐다 → 처음에는 409로 "다른 이름으로 저장"을 유도하고, force:true면 덮어쓴다
      if (entry.security?.encrypted && !force) {
        throw Object.assign(httpError(409, '암호나 권한 제한이 걸린 원본입니다. 저장하면 암호가 풀린 파일이 되므로 다른 이름으로 저장하세요.'), { extra: { needSaveAs: true } });
      }
      const p = safe(name);
      writeAtomic(p, entry.doc.save());
      entry.mtimeMs = fs.statSync(p).mtimeMs; entry.dirty = false; entry.externalChange = false;
      entry.security = { ...PLAIN }; delete entry.password; // 디스크 파일이 이제 암호 없는 문서
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/pdf/saveas' && req.method === 'POST') {
      const { name, to } = await readJson(req);
      const entry = await getEditableDoc(name);
      const p = safe(to), from = docKey(name), key = docKey(to);
      if (from !== key) dropDoc(to); // 대상이 따로 열려 있었으면 버린다(긴 작업 중이면 409 — 쓰기 전에)
      writeAtomic(p, entry.doc.save());
      entry.mtimeMs = fs.statSync(p).mtimeMs; entry.dirty = false; entry.externalChange = false;
      entry.security = { ...PLAIN }; delete entry.password; // 새 파일은 암호 없는 보통 문서(엔진이 암호를 벗겨 저장한다)
      if (from !== key) { delete pdfDocs[from]; pdfDocs[key] = entry; }
      return json(res, 200, { ok: true, path: to });
    }
    // PDF 암호 걸기: 지금 문서(미저장 편집 포함)를 AES-256(R6)으로 암호화한 사본을 to에 쓴다(pdf-encrypt.js).
    // allow: { print, copy, modify } 생략하면 모두 허용. 열린 문서는 그대로(메모리는 암호 없음·dirty 유지·경로 그대로).
    // 단 to가 지금 파일이면 디스크가 암호 문서가 됐으므로 dirty를 풀고 security를 암호 문서로 바꾸고 암호를 메모리에만 둔다
    // → 이후 /api/pdf/save는 409 needSaveAs(덮어쓰면 암호가 풀린다). 암호는 로그·디스크에 남기지 않는다
    if (url.pathname === '/api/pdf/protect' && req.method === 'POST') {
      const { name, to, userPassword, ownerPassword, allow } = await readJson(req);
      const bad = pdfEncrypt.passwordProblem(userPassword, '여는 암호')
        || (ownerPassword != null && ownerPassword !== '' ? pdfEncrypt.passwordProblem(ownerPassword, '권한 암호') : null);
      if (bad) return json(res, 400, { error: bad });
      if (typeof to !== 'string' || !to) return json(res, 400, { error: '저장할 파일을 고르세요' });
      const entry = await getEditableDoc(name);
      const p = safe(to), from = docKey(name), key = docKey(to);
      const perms = { print: allow?.print !== false, copy: allow?.copy !== false, modify: allow?.modify !== false };
      let bytes;
      try { bytes = pdfEncrypt.encryptPdf(entry.doc.save(), { userPassword, ownerPassword: ownerPassword || undefined, allow: perms }); }
      catch (e) { throw httpError(e.code === 'BAD_PASSWORD' ? 400 : 500, `암호를 걸지 못했습니다: ${e.message}`); }
      if (from !== key) dropDoc(to); // 대상이 따로 열려 있었으면 버린다(긴 작업 중이면 409 — 쓰기 전에)
      writeAtomic(p, bytes);
      if (from === key) {
        entry.mtimeMs = fs.statSync(p).mtimeMs; entry.dirty = false; entry.externalChange = false;
        entry.security = { encrypted: true, openPassword: true, restricted: !(perms.print && perms.copy && perms.modify) };
        entry.password = userPassword; // 디스크 파일이 바뀌어 다시 열 때 쓴다(메모리에만)
      }
      return json(res, 200, { ok: true, path: to });
    }
    // ── P9: 개인정보 일괄 가리기 · 영역 가리기 · 숨은 데이터 지우기 · 워터마크 · 머리말·꼬리말 · 주석 · 목차 · 문서 정보 · 이미지 PDF ──
    // 쪽 범위(pages)는 사람이 쓰는 1 기준 글('all'·'odd'·'even'·'1,3,5-7'·'-3'·'5-', page-range.js). 잘못된 범위는 400
    // 문서를 바꾸는 라우트는 모두 요청 하나 = 스냅샷 하나(실행 취소 한 번). 여러 쪽을 바꾸는 것은 page:null 스냅샷이라 응답·undo가 reloadAll
    if (url.pathname === '/api/pdf/pii/find' && req.method === 'POST') { // 문서를 바꾸지 않는다
      const { name, kinds, regex, pages } = await readJson(req);
      const want = kinds == null ? pii.KINDS : [].concat(kinds);
      const unknown = want.find((k) => !pii.KINDS.includes(k));
      if (unknown) return json(res, 400, { error: `알 수 없는 종류입니다: ${unknown} (${pii.KINDS.join('·')})` });
      const custom = pii.compileCustom(regex); // 문법 오류·빈 일치 패턴은 400
      if (!want.length && !custom) return json(res, 400, { error: '찾을 종류를 하나 이상 고르거나 정규식을 입력하세요' });
      const { doc } = await getPdfDoc(name);
      const list = pageRange(pages, doc.pageCount);
      const matches = [];
      let truncated = false;
      for (const i of list) {
        const { text, map } = doc.pageChars(i);
        const hits = pii.findPii(text, { kinds: want, regex: custom, limit: PII_LIMIT - matches.length + 1 });
        for (const h of hits) {
          if (matches.length >= PII_LIMIT) { truncated = true; break; }
          const start = map[h.start], end = map[h.end - 1] + 1; // 문자열 위치 → 텍스트 페이지 글자 번호(BMP 밖 글자는 두 칸이 한 글자)
          matches.push({ id: `${i}:${start}:${end}`, i, kind: h.kind, text: h.text, start, end, ...(h.valid !== undefined ? { valid: h.valid } : {}), rects: doc.charRangeRects(i, start, end) });
        }
        if (truncated) break;
      }
      return json(res, 200, { matches, truncated });
    }
    // 고른 일치(글자 번호 범위)를 진짜로 가린다: 글자를 객체에서 지우고 줄마다 덮개, 덮개와 겹치는 주석도 지운다(pdf-edit-service.redactRanges).
    // 확인: 가리기 전후의 쪽 글자에서 고른 글(공백 무시)이 고른 수만큼 줄었는지 센다 — 덜 줄었으면 그 일치는 failed. 하나도 못 가렸으면 되돌리고 ok:false
    if (url.pathname === '/api/pdf/pii/redact' && req.method === 'POST') {
      const { name, matches, color } = await readJson(req);
      if (!Array.isArray(matches) || !matches.length) return json(res, 400, { error: '가릴 항목을 고르세요' });
      if (matches.length > PII_LIMIT * 2) return json(res, 400, { error: '한 번에 가릴 수 있는 항목이 너무 많습니다' });
      const col = maskColorOf(color);
      const entry = await getEditableDoc(name), doc0 = entry.doc;
      const byPage = new Map();
      for (const m of matches) {
        const i = Number(m?.i), start = Number(m?.start), end = Number(m?.end);
        if (!Number.isInteger(i) || i < 0 || i >= doc0.pageCount || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
          return json(res, 400, { error: '가릴 항목의 위치(i·start·end)가 잘못됐습니다' });
        }
        if (!byPage.has(i)) byPage.set(i, []);
        byPage.get(i).push({ i, start, end });
      }
      // 고른 글: 가리기 전 쪽 글자에서 그 범위의 문자열(공백 뺀 것)
      const squeeze = (s) => s.replace(/\s+/g, '');
      const occurrences = (hay, needle) => { let n = 0; for (let k = hay.indexOf(needle); needle && k >= 0; k = hay.indexOf(needle, k + needle.length)) n++; return n; };
      const textOf = ({ text, map }, s, e) => { let out = ''; for (let k = 0; k < map.length; k++) if (map[k] >= s && map[k] < e) out += text[k]; return out; };
      const beforeChars = new Map([...byPage.keys()].map((i) => [i, doc0.pageChars(i)]));
      for (const [i, list] of byPage) for (const m of list) m.text = squeeze(textOf(beforeChars.get(i), m.start, m.end));
      const before = doc0.save();
      const pagesOut = [];
      try {
        batch(doc0, () => {
          for (const [i, list] of byPage) pagesOut.push({ i, ...redactRanges(doc0, i, list.map((m) => [m.start, m.end]), { color: col }) });
        });
      } catch (e) { await restore(entry, null, before); throw e; }
      const failed = [];
      let redacted = 0;
      for (const [i, list] of byPage) {
        const was = squeeze(beforeChars.get(i).text), now = squeeze(doc0.pageChars(i).text);
        const groups = new Map();
        for (const m of list) { if (!groups.has(m.text)) groups.set(m.text, []); groups.get(m.text).push(m); }
        for (const [t, ms] of groups) {
          const gone = t ? occurrences(was, t) - occurrences(now, t) : 0;
          if (t && gone >= ms.length) redacted += ms.length;
          else for (const m of ms) failed.push({ i, start: m.start, end: m.end, text: m.text, reason: '가린 뒤에도 글자가 남아 있습니다(그림·양식 안 글자이거나 글자 대응이 어긋남)' });
        }
      }
      if (!redacted) { await restore(entry, null, before); return json(res, 200, { ok: false, redacted: 0, failed, ...stacks(entry) }); }
      const compacted = await compactDoc(entry);
      snapshot(entry, null, before);
      entry.dirty = true;
      const annots = pagesOut.reduce((n, p) => n + (p.annots || 0), 0);
      return json(res, 200, { ok: true, redacted, failed, annots, compacted, pages: pagesOut.map((p) => ({ i: p.i, rects: p.rects, annots: p.annots })), reloadAll: true, ...stacks(entry) });
    }
    // 영역 진짜 가리기(여러 쪽): rect [l,b,r,t](기준 쪽의 PDF 사용자 좌표 — 모든 쪽에 같은 좌표로) 안의 글자 제거 · 그림 픽셀 칠하기 · 도형·주석 빼기 + 덮개
    if (url.pathname === '/api/pdf/redact-area' && req.method === 'POST') {
      const { name, rect, pages, color } = await readJson(req);
      if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((v) => Number.isFinite(Number(v)))) return json(res, 400, { error: 'rect는 [왼쪽, 아래, 오른쪽, 위] 숫자 4개여야 합니다' });
      const [l, b, r, t] = rect.map(Number);
      const box = { x0: Math.min(l, r), y0: Math.min(b, t), x1: Math.max(l, r), y1: Math.max(b, t) };
      if (box.x1 - box.x0 < 1 || box.y1 - box.y0 < 1) return json(res, 400, { error: '가릴 영역이 너무 작습니다' });
      const col = maskColorOf(color);
      const entry = await getEditableDoc(name);
      const list = pageRange(pages, entry.doc.pageCount);
      const out = await mutate(entry, null, () => ({ ok: true, pages: list.map((i) => ({ i, ...redactArea(entry.doc, i, box, { color: col }) })) }));
      const compacted = await compactDoc(entry); // 같은 스냅샷 안 — 실행 취소는 한 번
      return json(res, 200, { ok: true, compacted, pages: out.pages.map((p) => ({ i: p.i, rects: p.rects, unmapped: p.unmapped, annots: p.annots, paths: p.paths, images: p.images, skipped: p.skipped.length })), reloadAll: true, ...stacks(entry) });
    }
    // 숨은 데이터 지우기: 문서 정보는 EPDF_SetMetaText(빈 값)로 비운 뒤, 저장 바이트를 pdf-rewrite.sanitizePdf로 다시 써서(XMP·첨부·자바스크립트·주석·목차·/Info)
    // 그 바이트로 문서를 다시 연다. 다시 쓸 때 닿지 않는 객체는 버리므로 지운 것이 파일에 남지 않는다. 기본: info·xmp·attachments·javascript는 켜고 annotations·bookmarks는 끈다
    if (url.pathname === '/api/pdf/sanitize' && req.method === 'POST') {
      const q = await readJson(req);
      const opts = { info: q.info !== false, xmp: q.xmp !== false, attachments: q.attachments !== false, annotations: q.annotations === true, bookmarks: q.bookmarks === true, javascript: q.javascript !== false };
      if (!Object.values(opts).some(Boolean)) return json(res, 400, { error: '지울 항목을 하나 이상 고르세요' });
      const entry = await getEditableDoc(q.name);
      const before = entry.doc.save();
      let removed;
      try {
        const cleared = opts.info ? entry.doc.clearMeta() : 0;
        const out = pdfRewrite.sanitizePdf(entry.doc.save(), opts);
        removed = { ...out.removed, info: Math.max(cleared, out.removed.info) };
        if (!Object.values(removed).some((n) => n > 0)) { await restore(entry, null, before); return json(res, 200, { ok: false, removed, ...stacks(entry) }); }
        await swapDoc(entry, out.bytes);
      } catch (e) { await restore(entry, null, before); throw e; }
      snapshot(entry, null, before);
      entry.dirty = true;
      return json(res, 200, { ok: true, removed, reloadAll: true, ...stacks(entry) });
    }
    // 워터마크: 다시 부르면 모든 쪽의 옛 워터마크를 바꿔 끼운다(RetextPdfWatermark). 그림은 보관함 도장(imageStampId) 또는 파일(imagePath, PNG/JPEG)
    if (url.pathname === '/api/pdf/watermark' && req.method === 'POST') {
      const q = await readJson(req);
      const kind = q.kind || 'text';
      let image = null;
      if (kind === 'image') {
        let data;
        if (q.imageStampId) data = stamps.get(q.imageStampId).data;
        else if (q.imagePath) {
          const file = safe(q.imagePath);
          if (!/\.(png|jpe?g)$/i.test(file)) return json(res, 400, { error: '지원하지 않는 이미지 형식입니다 (PNG/JPEG만 가능)' });
          if (!fs.existsSync(file)) return json(res, 404, { error: '그림 파일을 찾을 수 없습니다' });
          data = fs.readFileSync(file);
        } else return json(res, 400, { error: '워터마크 그림을 고르세요(imageStampId 또는 imagePath)' });
        image = imageForPdf(data).image;
      }
      const entry = await getEditableDoc(q.name);
      const pages = pageRange(q.pages, entry.doc.pageCount);
      const r = await mutate(entry, null, () => entry.doc.addWatermark({ kind, text: q.text, fontId: q.font, size: q.size, color: q.color, opacity: q.opacity,
        rotation: q.rotation, position: q.position, margin: q.margin, pages, layer: q.layer, image, scale: q.scale }));
      // 그림은 쪽마다 사본이 생긴다 → 같은 그림 스트림을 하나로 합쳐 다시 연다(같은 스냅샷 안 — 실행 취소는 여전히 한 번)
      if (r.ok && image && pages.length > 1) { try { await swapDoc(entry, pdfRewrite.writePdf(pdfRewrite.parsePdf(entry.doc.save()), { dedupe: true })); } catch (e) { console.error('watermark dedupe:', e.message); } }
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/watermark/remove' && req.method === 'POST') { // 지울 것이 없으면 ok:false(스냅샷도 없음)
      const { name } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.removeWatermark());
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    // 머리말·꼬리말: slots { tl, tc, tr, bl, bc, br } — {page} {pages} {date} {file} {title}. 쪽 번호와 같은 자리 계산(placeText). 다시 부르면 교체
    if (url.pathname === '/api/pdf/header-footer' && req.method === 'POST') {
      const q = await readJson(req);
      const entry = await getEditableDoc(q.name);
      const pages = q.pages == null || q.pages === '' ? undefined : pageRange(q.pages, entry.doc.pageCount);
      const file = path.basename(String(q.name || '')).replace(/\.pdf$/i, '');
      const r = await mutate(entry, null, () => entry.doc.addHeaderFooter({ slots: q.slots, fontId: q.font, size: q.size, color: q.color, margin: q.margin, pages, startAt: q.startAt, skipFirst: q.skipFirst, file }));
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/header-footer/remove' && req.method === 'POST') {
      const { name } = await readJson(req);
      const entry = await getEditableDoc(name);
      const r = await mutate(entry, null, () => entry.doc.removeHeaderFooter());
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    // 주석 목록: 한 쪽(i) 또는 문서 전체(/all — 항목마다 i). 좌표는 objects와 같은 회전 전 페이지 좌표
    if (url.pathname === '/api/pdf/annots' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, doc.annots(pageIndex(doc, url.searchParams.get('i'))));
    }
    if (url.pathname === '/api/pdf/annots/all' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      const all = [];
      for (let i = 0; i < doc.pageCount; i++) for (const a of doc.annots(i)) all.push({ i, ...a });
      return json(res, 200, all);
    }
    if (url.pathname === '/api/pdf/annot/create' && req.method === 'POST') { // 작성자 기본값: OS 사용자 이름(없으면 'Retext PDF'). author로 바꿀 수 있다
      const q = await readJson(req);
      const entry = await getEditableDoc(q.name);
      const i = pageIndex(entry.doc, q.i);
      const { name: _n, i: _i, ...spec } = q;
      const r = await mutate(entry, i, () => entry.doc.createAnnot(i, { ...spec, author: q.author || defaultAuthor() }));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/annot/update' && req.method === 'POST') {
      const q = await readJson(req);
      const entry = await getEditableDoc(q.name);
      const i = pageIndex(entry.doc, q.i);
      const r = await mutate(entry, i, () => entry.doc.updateAnnot(i, Number(q.index), { contents: q.contents, author: q.author, color: q.color, fill: q.fill, opacity: q.opacity, width: q.width, rect: q.rect }));
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    if (url.pathname === '/api/pdf/annot/delete' && req.method === 'POST') {
      const { name, i: pi, index } = await readJson(req);
      const entry = await getEditableDoc(name);
      const i = pageIndex(entry.doc, pi);
      const r = await mutate(entry, i, () => entry.doc.deleteAnnot(i, Number(index)));
      if (r.ok) r.compacted = await compactDoc(entry); // 지운 메모 글이 고아 객체로 저장되지 않게
      return json(res, 200, { ...r, ...stacks(entry) });
    }
    // 주석 고정(평면화): indices [{i, index}]를 주면 그것만, 아니면 pages(1 기준 범위 글, 생략 = 전체)의 모든 주석(링크·팝업 제외)
    if (url.pathname === '/api/pdf/annot/flatten' && req.method === 'POST') {
      const { name, pages, indices } = await readJson(req);
      const entry = await getEditableDoc(name);
      const plan = new Map();
      if (Array.isArray(indices) && indices.length) {
        for (const x of indices) { const i = pageIndex(entry.doc, x?.i); if (!plan.has(i)) plan.set(i, []); plan.get(i).push(Number(x?.index)); }
      } else for (const i of pageRange(pages, entry.doc.pageCount)) plan.set(i, null);
      const r = await mutate(entry, null, () => {
        let flattened = 0, skipped = 0, failed = 0;
        for (const [i, list] of plan) { const x = entry.doc.flattenAnnots(i, list); flattened += x.flattened; skipped += x.skipped; failed += x.failed; }
        return { ok: flattened > 0, flattened, skipped, failed };
      });
      return json(res, 200, { ...r, reloadAll: true, ...stacks(entry) });
    }
    // 목차(책갈피): 읽기 / 통째로 바꾸기. items [{ title, page(0 기준|null), children }] 또는 text('제목<TAB>쪽번호', 들여쓰기 = 단계, outline-text.js)
    if (url.pathname === '/api/pdf/outline' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, { items: doc.outline() });
    }
    if (url.pathname === '/api/pdf/outline' && req.method === 'POST') {
      const q = await readJson(req);
      const entry = await getEditableDoc(q.name);
      let items = q.items;
      if (typeof q.text === 'string') {
        const parsed = parseOutlineText(q.text, entry.doc.pageCount);
        if (parsed.errors.length) return json(res, 400, { error: `목차 글에 고칠 곳이 ${parsed.errors.length}군데 있습니다 (${parsed.errors[0].line}번째 줄: ${parsed.errors[0].message})`, errors: parsed.errors });
        items = parsed.items;
      }
      if (!Array.isArray(items)) return json(res, 400, { error: 'items(배열) 또는 text를 보내세요' });
      const r = await mutate(entry, null, () => entry.doc.setOutline(items));
      return json(res, 200, { ...r, items: entry.doc.outline(), ...stacks(entry) });
    }
    // 문서 정보: 읽기 { Title, Author, Subject, Keywords, Creator, Producer, CreationDate, ModDate(ISO) } / 쓰기 fields { Title?, Author?, Subject?, Keywords? }(빈 글자 = 지우기)
    // PDFium은 /Info가 없던 문서의 값을 저장하지 않는다 → 저장본을 다시 열어 확인하고, 다르면 pdf-rewrite.setInfoPdf로 /Info를 직접 넣은 바이트로 바꿔 끼운다
    if (url.pathname === '/api/pdf/meta' && req.method === 'GET') {
      const { doc } = await getPdfDoc(url.searchParams.get('name'));
      return json(res, 200, doc.meta());
    }
    if (url.pathname === '/api/pdf/meta' && req.method === 'POST') {
      const { name, fields } = await readJson(req);
      if (!fields || typeof fields !== 'object' || !Object.keys(fields).length) return json(res, 400, { error: '바꿀 문서 정보(fields)를 보내세요' });
      const entry = await getEditableDoc(name);
      const before = entry.doc.save();
      try {
        const { fields: applied } = entry.doc.setMeta(fields);
        const same = (d) => Object.entries(applied).every(([k, v]) => k === 'ModDate' || d.metaText(k) === v);
        const check = await pdfEngine.open(entry.doc.save());
        const ok = (() => { try { return same(check); } finally { check.close(); } })();
        if (!ok) {
          await swapDoc(entry, pdfRewrite.setInfoPdf(entry.doc.save(), applied));
          if (!same(entry.doc)) throw new Error('문서 정보를 저장하지 못했습니다.');
        }
      } catch (e) { await restore(entry, null, before); throw e; }
      snapshot(entry, null, before);
      entry.dirty = true;
      return json(res, 200, { ok: true, meta: entry.doc.meta(), ...stacks(entry) });
    }
    // 이미지 PDF로 저장: 쪽마다 렌더한 JPEG만 담은 새 PDF(글자 없음)를 to에 쓴다. 열린 문서는 그대로. 긴 작업(쪽 1장 = 진행 1, 저장 1)
    if (url.pathname === '/api/pdf/rasterize' && req.method === 'POST') {
      const { name, to, dpi, quality, pages, jobId } = await readJson(req);
      if (typeof to !== 'string' || !to) return json(res, 400, { error: '저장할 파일을 고르세요' });
      if (!/\.pdf$/i.test(to)) return json(res, 400, { error: '저장할 파일 이름은 .pdf로 끝나야 합니다' });
      if (docKey(to) === docKey(name)) return json(res, 400, { error: '지금 문서와 다른 파일 이름을 고르세요(이미지 PDF는 글자를 없앤 사본입니다)' });
      const d = dpi == null ? 150 : Number(dpi), qv = quality == null ? 0.85 : Number(quality);
      if (!(d >= 36 && d <= 600)) return json(res, 400, { error: '해상도는 36~600dpi로 지정하세요' });
      if (!(qv >= 0.1 && qv <= 1)) return json(res, 400, { error: '품질은 0.1~1 사이로 지정하세요' });
      const out = safe(to);
      const entry = await getEditableDoc(name), { doc } = entry;
      const list = pageRange(pages, doc.pageCount);
      const job = startJob(jobId, 'rasterize', list.length + 1); // 진행 단위: 쪽 1장 + 저장 1
      entry.busy = true;
      const raster = doc.rasterizer();
      try {
        for (let k = 0; k < list.length; k++) {
          await tick();
          if (!progress(job, { message: `${list[k] + 1}쪽 그리는 중`, done: k })) return json(res, 200, { cancelled: true });
          raster.addPage(list[k], d, qv);
        }
        await tick();
        if (!progress(job, { message: '저장하는 중', done: list.length })) return json(res, 200, { cancelled: true });
        const bytes = raster.finish();
        dropDoc(to); // 같은 이름으로 열려 있었으면 버린다(긴 작업 중이면 409)
        writeAtomic(out, bytes);
        progress(job, { done: list.length + 1 });
        return json(res, 200, { ok: true, path: to, pageCount: list.length, bytes: bytes.length });
      } catch (e) { job.error = e.message; throw e; }
      finally { raster.close(); entry.busy = false; endJob(job); }
    }
    if (url.pathname === '/api/pdf/close' && req.method === 'POST') {
      const { name } = await readJson(req);
      dropDoc(name);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) return res.end();
    json(res, e.status || 500, { error: e.message, ...(e.extra || {}) }); // extra: 암호(needPassword·wrong)·저장 확인(needSaveAs) 같은 UI용 표시
  }
});
// 기본 포트가 사용 중이면(다른 프로그램, 개발용 서버) 다음 포트를 차례로 시도한다. ready는 실제로 연 포트로 resolve — Electron 창은 이 포트로 접속
// listen(p, cb)의 cb는 'listening' 리스너로 남아 실패한 시도의 것까지 다음 성공 때 함께 불린다 → 리스너를 직접 달고 실패하면 떼어 낸다
// RETEXTPDF_NO_LISTEN=1 이면 포트를 열지 않는다 — server.test.js가 순수 함수(snapshot·downsampleToTarget·jobs)만 불러 쓰기 위한 것
const ready = process.env.RETEXTPDF_NO_LISTEN === '1' ? Promise.resolve(0) : new Promise((resolve, reject) => {
  const listen = (p, retries) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && retries > 0) { console.warn(`포트 ${p} 사용 중 → ${p + 1} 시도`); return listen(p + 1, retries - 1); }
      reject(e);
    };
    const onListening = () => {
      server.off('error', onError); server.on('error', (e) => console.error('server:', e.message));
      port = server.address().port; console.log(`Retext PDF → http://localhost:${port}  workspace=${WS}`); resolve(port);
    };
    server.once('error', onError); server.once('listening', onListening);
    server.listen(p, '127.0.0.1');
  };
  listen(PORT, 10);
});
ready.catch((e) => console.error('server:', e.message));
module.exports = { PORT, ready, port: () => port,
  // 자체 검사용(server.test.js): P6 C1·C3·C4 로직을 직접 부르고, server를 4848에 직접 listen해 라우트를 가짜 엔진으로 검사한다
  _test: { server, pdfDocs, jobs, startJob, progress, endJob, jobView, snapshot, stacks, trimStacks, downsampleToTarget, UNDO_MAX, UNDO_MAX_BYTES } };
