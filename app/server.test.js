// 자체 검사: node app/server.test.js
// 서버의 P6 로직(C1 작업 진행·취소, C3 실행 취소 메모리 상한, C4 용량 줄이기 조기 종료)을 라우트 없이 함수 단위로 검사한다.
// PDFium을 쓰지 않도록 pdf-engine.open을 가짜 문서로 바꿔 둔 뒤 server.js를 읽어 들인다(RETEXTPDF_NO_LISTEN=1 → 포트를 열지 않는다).
const assert = require('assert');

process.env.RETEXTPDF_NO_LISTEN = '1';
process.env.RETEXTPDF_PORT = '4848'; // 라우트 검사는 아래에서 직접 listen한다(사용자 앱의 4747은 쓰지 않는다)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const engine = require('./pdf-engine');
const realOpen = engine.open; // P7 라우트 검사(진짜 PDFium)에서 잠시 되돌린다
// 도장 보관함은 시험용 임시 폴더로(사용자 앱 데이터에 쓰지 않는다)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retext-pdf-data-'));
process.env.RETEXTPDF_DATA = DATA_DIR;

// 가짜 문서: downsample()은 아래 script(maxDpi·quality → after 바이트)가 정하고,
// 문서 내용은 문자열 state로 흉내 낸다 — open(bytes)이 state를 읽고 save()가 그대로 돌려준다.
// move(i, idxs, dx): state에 '+m'을 붙인다. idxs가 비면 일부만 바꾼 뒤 ok:false, dx==='throw'면 바꾼 뒤 던진다(되돌리기 검사용)
let script = () => 1000;
let failOpen = false;
const closed = [];
// 'LOCK:<암호>:<내용>' 바이트는 암호 문서 흉내 — 암호가 없거나 틀리면 엔진처럼 code를 단 오류, 맞으면 내용만 남긴다(저장본은 암호 없음)
engine.open = async (bytes, password) => {
  if (failOpen) throw new Error('열기 실패(가짜)');
  let state = Buffer.from(bytes).toString(), security;
  const lock = /^LOCK:([^:]*):/.exec(state);
  if (lock) {
    if (!password) throw Object.assign(new Error('암호가 걸린 PDF입니다. 암호를 입력하세요.'), { code: 'PASSWORD_REQUIRED' });
    if (password !== lock[1]) throw Object.assign(new Error('암호가 맞지 않습니다.'), { code: 'PASSWORD_WRONG' });
    state = state.slice(lock[0].length);
    security = { encrypted: true, openPassword: true, restricted: false };
  }
  const doc = {
    state, security,
    downsample({ maxDpi, quality }) {
      const after = script(maxDpi, quality);
      return { ok: true, changed: 1, skipped: [], before: bytes.length, after };
    },
    pageCount: 1,
    pageSize: () => ({ w: 100, h: 100, rotation: 0 }),
    move(i, idxs, dx) {
      doc.state += '+partial';
      if (dx === 'throw') throw new Error('엔진 오류(가짜)');
      if (!idxs.length) return { ok: false, moved: 0 };
      doc.state = doc.state.replace('+partial', '+m');
      return { ok: true, moved: idxs.length };
    },
    save() { return Buffer.from(doc.state); },
    close() { closed.push(doc); },
  };
  return doc;
};
const { _test } = require('./server.js');
const { server, pdfDocs, jobs, startJob, progress, endJob, jobView, snapshot, stacks, trimStacks, downsampleToTarget, UNDO_MAX_BYTES } = _test;

(async () => {
  // ── C1: 작업 등록·진행·취소·완료 ──────────────────────────────────────────
  {
    const job = startJob('j1', 'split', 5);
    assert.strictEqual(jobs.get('j1'), job, 'jobId가 있으면 등록된다');
    assert.deepStrictEqual(jobView(job), { id: 'j1', phase: 'split', done: 0, total: 5, message: '', finished: false, cancelled: false, error: null });
    assert.strictEqual(progress(job, { done: 2, message: '2번째' }), true, '취소 전에는 계속 진행');
    assert.deepStrictEqual([job.done, job.message], [2, '2번째']);
    job.cancelled = true; // POST /api/jobs/cancel 이 하는 일
    assert.strictEqual(progress(job, { done: 3 }), false, '취소되면 progress가 false');
    assert.strictEqual(job.done, 3, '취소 뒤에도 마지막 진행은 기록된다');
    endJob(job);
    assert.strictEqual(job.finished, true);
    assert.ok(job.timer, '끝난 작업은 자동 삭제 타이머가 걸린다');
    clearTimeout(job.timer); jobs.delete('j1');

    const untracked = startJob(null, 'merge', 3);
    assert.strictEqual(untracked.id, null);
    assert.strictEqual(jobs.size, 0, 'jobId가 없으면 등록하지 않는다(진행 추적 없음)');
    assert.strictEqual(progress(untracked, { done: 1 }), true, '추적하지 않는 작업도 같은 경로로 돈다');

    const failed = startJob('j2', 'downsample', 1);
    failed.error = '저장 실패';
    endJob(failed);
    endJob(failed, { error: '두 번째 오류' }); // catch와 finally가 겹쳐 불려도
    assert.strictEqual(jobView(failed).error, '저장 실패', '처음 오류가 남는다');
    clearTimeout(failed.timer); jobs.delete('j2');
    const reused = startJob('j3', 'split', 1); endJob(reused);
    const again = startJob('j3', 'split', 2); // 같은 id를 다시 쓰면 옛 타이머를 끄고 새로 시작
    assert.strictEqual(again.finished, false);
    assert.strictEqual(jobs.get('j3'), again);
    clearTimeout(again.timer); jobs.delete('j3');
  }

  // ── C3: 실행 취소 메모리 상한 ─────────────────────────────────────────────
  {
    // 실제로 100MB를 네 번 만들 필요는 없다 — snapshot·trimStacks는 bytes.length만 본다(가짜 entry)
    const size = 100 * 1024 * 1024; // 100MB 문서 → 3장이면 300MB로 상한(256MB)을 넘는다
    const entry = { doc: { save: () => ({ length: size }) }, undo: [], redo: [], undoBytes: 0, undoTrimmed: false };
    snapshot(entry, 0); snapshot(entry, 1);
    assert.deepStrictEqual([entry.undo.length, entry.undoBytes], [2, 2 * size]);
    assert.strictEqual(stacks(entry).undoTrimmed, undefined, '상한 아래에서는 undoTrimmed를 보내지 않는다');
    snapshot(entry, 2); snapshot(entry, 3);
    assert.strictEqual(entry.undo.length, 3, '최소 3단계는 남긴다(상한을 넘더라도)');
    assert.strictEqual(entry.undoBytes, 3 * size);
    assert.ok(entry.undoBytes > UNDO_MAX_BYTES, '3단계 보장이 상한보다 우선한다');
    const first = stacks(entry);
    assert.strictEqual(first.undoTrimmed, true, '잘라냈으면 한 번 알린다');
    assert.strictEqual(stacks(entry).undoTrimmed, undefined, 'undoTrimmed는 1회성');
    assert.deepStrictEqual([first.undoLeft, first.redoLeft], [3, 0]);
    assert.deepStrictEqual([entry.undo[0].page, entry.undo[2].page], [1, 3], '가장 오래된 것부터 버린다');

    // redo도 같은 합계에 들어간다
    const e2 = { undo: [], redo: [], undoBytes: 0, undoTrimmed: false };
    for (let i = 0; i < 5; i++) e2.undo.push({ bytes: { length: 10 * 1024 * 1024 }, page: i });
    e2.redo.push({ bytes: { length: 250 * 1024 * 1024 }, page: null });
    trimStacks(e2);
    assert.strictEqual(e2.undo.length, 3, 'redo가 자리를 차지하면 undo를 더 버린다');
    assert.strictEqual(e2.undoBytes, 250 * 1024 * 1024 + 3 * 10 * 1024 * 1024);
    assert.strictEqual(e2.undoTrimmed, true);
  }

  // ── C4: 조기 종료 ────────────────────────────────────────────────────────
  const target = 500;
  const combos = (list) => list.map((c) => `${c.maxDpi}/${c.quality}`);
  {
    // ① 아무리 줄여도 안 줄어드는 문서(단계 안·단계 사이 모두 제자리): dpi마다 품질 2회로 제자리를 확인하고
    //    개선 없는 dpi 단계가 두 번 연속되면 멈춘다 → 6회(이전 구현은 12회)
    script = () => 1000;
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.strictEqual(r.attempts.length, 6, `시도 6회여야 한다: ${JSON.stringify(combos(r.attempts))}`);
    assert.deepStrictEqual(combos(r.attempts), ['150/75', '150/60', '120/75', '120/60', '96/75', '96/60']);
    assert.strictEqual(r.reached, false);
    assert.ok(r.attempts.every((a) => a.skipped === 0), 'attempts에는 실제 시도만 들어간다(건너뛴 조합은 없다)');
  }
  {
    // ①-2 단계 안에서는 계속 줄지만 단계 사이에서는 제자리: 첫 dpi는 품질 3단계를 다 쓰고,
    //     그 뒤 두 dpi가 연속으로 직전 단계 최선을 1% 이상 못 줄이면 멈춘다 → 3+2+2 = 7회
    script = (dpi, q) => (dpi === 150 ? { 75: 1000, 60: 900, 45: 810 }[q] : 810);
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.deepStrictEqual(combos(r.attempts), ['150/75', '150/60', '150/45', '120/75', '120/60', '96/75', '96/60']);
    assert.strictEqual(r.after, 810);
    assert.deepStrictEqual(r.used, { maxDpi: 150, quality: 45 });
  }
  {
    // ①-3 낮은 dpi의 첫 시도가 전체 최선보다 오히려 크지만 같은 단계에서 품질을 낮추면 확 줄어드는 문서.
    //     비교 기준이 전체 최선이면 120/75(1100 > 1000)에서 단계를 접어 120/60(600)을 놓쳤다 —
    //     같은 단계의 직전 시도와 견주므로 이제 놓치지 않는다.
    script = (dpi, q) => ({ 150: { 75: 1000, 60: 1000, 45: 1000 }, 120: { 75: 1100, 60: 600, 45: 600 }, 96: { 75: 400, 60: 400, 45: 400 } }[dpi][q]);
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.deepStrictEqual(combos(r.attempts), ['150/75', '150/60', '120/75', '120/60', '120/45', '96/75']);
    assert.strictEqual(r.reached, true, '96dpi에서 목표(500)에 닿는다');
    assert.deepStrictEqual(r.used, { maxDpi: 96, quality: 75 });
  }
  {
    // ② 단계마다 1% 넘게 줄어드는 문서: 목표에 못 닿으면 12회를 다 돈다(이전과 같은 동작)
    const seq = [1000, 970, 941, 913, 886, 859, 833, 808, 784, 760, 737, 715]; // 단계마다 3%씩
    let k = 0; script = () => seq[k++];
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.strictEqual(r.attempts.length, 12, '개선이 계속되면 모든 조합을 시도한다');
    assert.strictEqual(r.reached, false);
    assert.strictEqual(r.after, 715, '목표 미달이면 최선 결과로 확정한다');
    assert.deepStrictEqual(r.used, { maxDpi: 72, quality: 45 });
  }
  {
    // ③ 목표에 닿으면 그 자리에서 멈춘다

    const seq = [1000, 900, 400];
    let k = 0; script = () => seq[k++];
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.strictEqual(r.attempts.length, 3);
    assert.strictEqual(r.reached, true);
    assert.deepStrictEqual(r.used, { maxDpi: 150, quality: 45 });
  }
  {
    // ④ 품질 단계는 제자리인데 dpi 단계가 효과가 있는 문서: 품질 단계만 건너뛴다

    script = (dpi) => ({ 150: 1000, 120: 800, 96: 640, 72: 512 })[dpi];
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.deepStrictEqual(combos(r.attempts), ['150/75', '150/60', '120/75', '120/60', '96/75', '96/60', '72/75', '72/60'],
      'dpi마다 품질 2단계에서 제자리를 확인하고 다음 dpi로 간다');
    assert.strictEqual(r.after, 512);
  }
  {
    // ⑤ 목표 용량이 없으면 한 번만 실행한다(기존 동작)
    script = () => 700;
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75 });
    assert.strictEqual(r.attempts.length, 1);
    assert.strictEqual(r.reached, true);
  }
  {
    // ⑥ 취소: report가 false를 주면 시도 사이에서 멈추고 cancelled를 돌려준다
    script = () => 900;
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    let seen = 0;
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target,
      report: () => ++seen < 3 });
    assert.strictEqual(r.cancelled, true);
    assert.strictEqual(r.attempts.length, 1, '취소 시점까지의 시도만 남는다');
  }

  {
    // ⑦ 목표 미달이면 최소 결과로 확정한다 — 마지막 시도가 더 크면 앞선 최선으로 되돌려야 한다
    //    (P6 전에는 best에 after 필드가 없어 비교가 항상 false → 첫 시도 결과로 확정되는 버그가 있었다)
    const seq = [1000, 600, 700, 650, 650, 650, 650];
    let k = 0; script = () => seq[k++];
    const entry = { doc: await engine.open(Buffer.alloc(1000)) };
    const r = await downsampleToTarget(entry, Buffer.alloc(1000), { maxDpi: 150, quality: 75, targetBytes: target });
    assert.strictEqual(r.reached, false);
    assert.strictEqual(r.attempts.length, 7, `150dpi 3회 + 제자리 dpi 2단계 2회씩: ${JSON.stringify(combos(r.attempts))}`);
    assert.strictEqual(r.after, 600, `최소 결과로 확정: ${JSON.stringify(r.attempts.map((a) => a.after))}`);
    assert.deepStrictEqual(r.used, { maxDpi: 150, quality: 60 });
  }

  // ── 라우트 검사(가짜 엔진, 127.0.0.1:4848) ─────────────────────────────────
  await new Promise((resolve) => server.listen(4848, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retext-pdf-server-'));
  const raw = (method, route, data, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 4848, method, path: route, headers }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); let body = text; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, body }); });
    });
    req.on('error', reject);
    req.end(data);
  });
  const post = (route, data) => raw('POST', route, JSON.stringify(data));
  const info = async (name) => (await raw('GET', '/api/pdf/info?' + new URLSearchParams({ name }))).body;
  try {
    // 1: '//' 같은 경로가 프로세스를 죽이지 않고 400
    assert.strictEqual((await raw('GET', '//')).status, 400);
    assert.strictEqual((await raw('GET', '/api/workspace')).status, 200, '서버가 살아 있다');

    // 2: 큰 한글 본문이 조각 경계에서 깨지지 않는다 / 깨진 JSON은 400 / 상한 초과는 413
    {
      const md = path.join(dir, '한글.md'), text = '# 회의록\n' + '가나다라마바사아자차카타파하 한글 문장입니다. '.repeat(7000);
      assert.ok(Buffer.byteLength(text) > 280000);
      assert.strictEqual((await raw('PUT', '/api/file?' + new URLSearchParams({ name: md }), Buffer.from(text))).status, 200);
      assert.ok(fs.readFileSync(md, 'utf8') === text, '저장한 글자가 그대로다(U+FFFD 없음)'); // strictEqual은 실패 시 280KB 차이를 찍는다
      const bad = await raw('POST', '/api/pdf/move', '{not json');
      assert.strictEqual(bad.status, 400);
      assert.match(bad.body.error, /요청 형식/);
      const big = await raw('PUT', '/api/file?' + new URLSearchParams({ name: path.join(dir, 'big.md') }), Buffer.alloc(65 * 1024 * 1024, 0x61));
      assert.strictEqual(big.status, 413);
      assert.ok(!fs.existsSync(path.join(dir, 'big.md')), '상한을 넘으면 쓰지 않는다');
    }

    const name = path.join(dir, 'a.pdf');
    fs.writeFileSync(name, 'v1');
    let clock = Date.now();
    const bump = (content) => { fs.writeFileSync(name, content); const t = new Date((clock += 10000)); fs.utimesSync(name, t, t); };
    const count = Object.keys(pdfDocs).length;
    // 3c: 같은 파일의 다른 표기는 한 항목
    assert.strictEqual((await info(name)).dirty, false);
    assert.strictEqual((await info(dir + path.sep + '.' + path.sep + 'a.pdf')).dirty, false);
    if (process.platform === 'win32') assert.strictEqual((await info(name.toUpperCase())).dirty, false);
    assert.strictEqual(Object.keys(pdfDocs).length, count + 1, '표기가 달라도 캐시 항목은 하나');
    const entry = () => Object.values(pdfDocs)[count];

    // 3a: 디스크가 바뀌어 다시 열다 실패해도 닫힌 문서가 캐시에 남지 않는다(다음 요청에서 이중 close·해제 후 사용 없음)
    {
      const old = entry().doc;
      bump('v2'); failOpen = true;
      assert.strictEqual((await raw('GET', '/api/pdf/info?' + new URLSearchParams({ name }))).status, 500);
      failOpen = false;
      assert.strictEqual(Object.keys(pdfDocs).length, count, '실패한 항목은 캐시에서 빠졌다');
      assert.strictEqual((await info(name)).dirty, false);
      assert.strictEqual(closed.filter((d) => d === old).length, 1, '옛 문서는 정확히 한 번 닫혔다');
      assert.strictEqual(entry().doc.state, 'v2');
    }

    // 4: 실패한 변경(ok:false·예외)은 스택·dirty·문서를 건드리지 않는다
    {
      const live = entry().doc;
      const before = await info(name);
      const noop = await post('/api/pdf/move', { name, i: 0, idxs: [], dx: 1, dy: 0 });
      assert.deepStrictEqual([noop.status, noop.body.ok], [200, false]);
      const thrown = await post('/api/pdf/move', { name, i: 0, idxs: [1], dx: 'throw', dy: 0 });
      assert.strictEqual(thrown.status, 500);
      assert.deepStrictEqual(await info(name), before, 'undo/redo/dirty 그대로');
      assert.strictEqual(entry().doc.state, 'v2', '부분 변경은 되돌려졌다');
      assert.notStrictEqual(entry().doc, live, '되돌리기는 변경 전 바이트로 다시 연 문서');
      const ok = await post('/api/pdf/move', { name, i: 0, idxs: [1], dx: 1, dy: 0 });
      assert.deepStrictEqual([ok.status, ok.body.undoLeft, ok.body.redoLeft], [200, 1, 0]);
      assert.strictEqual(entry().dirty, true);
      assert.strictEqual((await post('/api/pdf/mask', { name, i: 0 })).status, 400, 'parts가 없으면 400');
    }

    // 5: 실행 취소·다시 실행 — 바꿔 끼우기가 실패하면 스택은 그대로
    {
      failOpen = true;
      assert.strictEqual((await post('/api/pdf/undo', { name })).status, 500);
      failOpen = false;
      const after = await info(name);
      assert.deepStrictEqual([after.undoLeft, after.redoLeft], [1, 0], '실패한 undo는 스택을 옮기지 않는다');
      assert.strictEqual(entry().doc.state, 'v2+m');
      const u = await post('/api/pdf/undo', { name });
      assert.deepStrictEqual([u.body.ok, u.body.undoLeft, u.body.redoLeft], [true, 0, 1]);
      assert.strictEqual(entry().doc.state, 'v2');
      failOpen = true;
      assert.strictEqual((await post('/api/pdf/redo', { name })).status, 500);
      failOpen = false;
      const mid = await info(name);
      assert.deepStrictEqual([mid.undoLeft, mid.redoLeft], [0, 1], '실패한 redo도 스택을 옮기지 않는다');
      const r = await post('/api/pdf/redo', { name });
      assert.deepStrictEqual([r.body.undoLeft, r.body.redoLeft], [1, 0]);
      assert.strictEqual(entry().doc.state, 'v2+m');
    }

    // 3b: 미저장 편집 중 디스크 파일이 바뀌어도 다시 열지 않고 externalChange로 알린다
    {
      bump('v3');
      const i3 = await info(name);
      assert.strictEqual(i3.externalChange, true);
      assert.deepStrictEqual([i3.dirty, i3.undoLeft], [true, 1], '편집과 실행 취소 기록이 남는다');
      assert.strictEqual(entry().doc.state, 'v2+m');
      const moved = await post('/api/pdf/move', { name, i: 0, idxs: [1], dx: 1, dy: 0 });
      assert.strictEqual(moved.body.externalChange, true, '변경 응답에도 실린다');
      assert.strictEqual((await post('/api/pdf/save', { name })).body.ok, true);
      assert.strictEqual((await info(name)).externalChange, undefined, '저장하면 풀린다');
      assert.strictEqual(fs.readFileSync(name, 'utf8'), 'v2+m+m');
    }

    // 11: 긴 작업 중인 문서를 바꾸는 요청은 409 / 등록 전에 온 취소는 기억된다
    {
      entry().busy = true;
      for (const [route, data] of [['/api/pdf/move', { name, i: 0, idxs: [1], dx: 1, dy: 0 }], ['/api/pdf/undo', { name }], ['/api/pdf/save', { name }], ['/api/pdf/close', { name }]]) {
        const r = await post(route, data);
        assert.deepStrictEqual([r.status, r.body.error], [409, '긴 작업이 끝난 뒤 다시 시도하세요.'], route);
      }
      entry().busy = false;
      const c = await post('/api/jobs/cancel', { id: 'early-1' });
      assert.deepStrictEqual([c.status, c.body.pending], [200, true]);
      const job = startJob('early-1', 'downsample', 1);
      assert.strictEqual(job.cancelled, true, '먼저 온 취소가 적용된다');
      assert.strictEqual(progress(job), false);
      endJob(job); clearTimeout(job.timer); jobs.delete('early-1');
    }

    // 12 (P7, 가짜 엔진): 암호 문서 — 잠긴 동안 401, 잠금 풀기, 덮어쓰기 저장은 409(force면 저장), 암호는 메모리에만
    {
      const locked = path.join(dir, 'locked.pdf');
      fs.writeFileSync(locked, 'LOCK:s3cret:body');
      const q = '?' + new URLSearchParams({ name: locked });
      let r = await raw('GET', '/api/pdf/info' + q);
      assert.deepStrictEqual([r.status, r.body.needPassword, r.body.wrong], [401, true, false], '잠긴 문서는 401 needPassword');
      assert.strictEqual((await raw('GET', '/api/pdf/objects' + q + '&i=0')).status, 401, '다른 PDF 요청도 401');
      assert.strictEqual((await post('/api/pdf/unlock', { name: locked, password: '' })).status, 400);
      r = await post('/api/pdf/unlock', { name: locked, password: 'nope' });
      assert.deepStrictEqual([r.status, r.body.needPassword, r.body.wrong], [401, true, true], '틀린 암호');
      r = await post('/api/pdf/unlock', { name: locked, password: 's3cret' });
      assert.deepStrictEqual([r.status, r.body.ok, r.body.security], [200, true, { encrypted: true, openPassword: true, restricted: false }]);
      const i1 = await info(locked);
      assert.deepStrictEqual(i1.security, { encrypted: true, openPassword: true, restricted: false }, 'info에 security');
      const key = Object.keys(pdfDocs).find((k) => k.endsWith(path.sep + 'locked.pdf'));
      assert.strictEqual(pdfDocs[key].password, 's3cret', '다시 열기용 암호는 메모리의 캐시 항목에만');
      assert.ok(!fs.readdirSync(dir).some((f) => fs.readFileSync(path.join(dir, f)).includes('s3cret') && f !== 'locked.pdf'), '디스크에 암호를 쓰지 않는다');
      // 디스크 파일이 바뀌어 다시 열 때도 기억한 암호로 열린다(편집 없음)
      fs.writeFileSync(locked, 'LOCK:s3cret:body2'); const t = new Date(Date.now() + 60000); fs.utimesSync(locked, t, t);
      assert.strictEqual((await raw('GET', '/api/pdf/info' + q)).status, 200);
      assert.strictEqual(Object.values(pdfDocs).find((e) => e.doc.state === 'body2') !== undefined, true);
      r = await post('/api/pdf/save', { name: locked });
      assert.deepStrictEqual([r.status, r.body.needSaveAs], [409, true], '암호 원본 덮어쓰기는 먼저 409');
      assert.match(r.body.error, /다른 이름으로 저장/);
      const out = path.join(dir, 'unlocked.pdf');
      r = await post('/api/pdf/saveas', { name: locked, to: out });
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(fs.readFileSync(out, 'utf8'), 'body2', '저장본은 암호 없음');
      assert.deepStrictEqual((await info(out)).security, { encrypted: false, openPassword: false, restricted: false }, '새 파일은 보통 문서');
      assert.strictEqual((await post('/api/pdf/save', { name: out })).body.ok, true, '이제 덮어쓰기 저장 가능');
      // force: 확인 뒤 원본에 그대로 덮어쓰기
      fs.writeFileSync(locked, 'LOCK:s3cret:again');
      await post('/api/pdf/unlock', { name: locked, password: 's3cret' });
      r = await post('/api/pdf/save', { name: locked, force: true });
      assert.strictEqual(r.body.ok, true);
      assert.strictEqual(fs.readFileSync(locked, 'utf8'), 'again');
      assert.strictEqual((await info(locked)).security.encrypted, false);
      await post('/api/pdf/close', { name: locked });
      assert.ok(!Object.keys(pdfDocs).some((k) => k.endsWith(path.sep + 'locked.pdf')), '닫으면 항목(암호 포함)이 사라진다');
    }

    // 13 (P7, 진짜 PDFium): 암호 PDF · 쪽 작업 · 쪽 번호 · 글상자 · 도장 · 인쇄 HTML
    engine.open = realOpen; // 이 뒤로는 가짜 엔진을 쓰지 않는다
    {
      const { buildPdf, makePng } = require('./pdf-test-fixtures');
      const pageTexts = (e) => Array.from({ length: e.doc.pageCount }, (_, i) => e.doc.pageText(i));
      const entryOf = (file) => pdfDocs[process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)];

      // 암호(AES-128) PDF: 401 → 잠금 풀기 → 덮어쓰기 409 → 다른 이름으로 저장한 파일은 암호 없이 열린다
      const enc = path.join(dir, 'enc.pdf');
      fs.writeFileSync(enc, buildPdf({ pages: [{}, { w: 600, h: 300 }], encrypt: { user: 'pw', owner: 'owner', P: -4 } }));
      let r = await raw('GET', '/api/pdf/info?' + new URLSearchParams({ name: enc }));
      assert.deepStrictEqual([r.status, r.body.needPassword, r.body.wrong], [401, true, false]);
      assert.deepStrictEqual((await post('/api/pdf/unlock', { name: enc, password: 'bad' })).body.wrong, true);
      r = await post('/api/pdf/unlock', { name: enc, password: 'pw' });
      assert.deepStrictEqual([r.body.pageCount, r.body.security.encrypted], [2, true]);
      assert.strictEqual((await post('/api/pdf/move', { name: enc, i: 0, idxs: [0], dx: 5, dy: 0 })).body.ok, true, '암호 문서도 편집(스냅샷 재열기 포함)');
      assert.strictEqual((await post('/api/pdf/undo', { name: enc })).body.ok, true, '실행 취소(암호 없는 스냅샷으로 바꿔 끼움)');
      assert.strictEqual((await info(enc)).security.encrypted, true, '바꿔 끼운 뒤에도 원본이 암호 문서라는 표시는 남는다');
      assert.strictEqual((await post('/api/pdf/save', { name: enc })).status, 409);
      const encOut = path.join(dir, 'enc-open.pdf');
      assert.strictEqual((await post('/api/pdf/saveas', { name: enc, to: encOut })).body.ok, true);
      const check = await realOpen(fs.readFileSync(encOut));
      assert.deepStrictEqual([check.security.encrypted, check.pageCount, check.pageText(1)], [false, 2, 'Page 2'], '저장본은 암호 없이 열리고 내용 그대로');
      check.close();
      const ro = path.join(dir, 'restricted.pdf');
      fs.writeFileSync(ro, buildPdf({ pages: [{}], encrypt: { user: '', owner: 'o', P: -3904 } }));
      assert.deepStrictEqual((await info(ro)).security, { encrypted: true, openPassword: false, restricted: true }, '권한만 걸린 문서는 바로 열린다');
      assert.strictEqual((await post('/api/pdf/save', { name: ro })).body.needSaveAs, true);

      // PDF 암호 걸기(/api/pdf/protect): 암호화한 사본을 쓰고 열린 문서는 그대로. 같은 경로에 걸면 이후 덮어쓰기 저장은 409
      {
        const plain = path.join(dir, 'protect-src.pdf');
        fs.writeFileSync(plain, buildPdf({ pages: [{}, { w: 500, h: 300 }] }));
        await info(plain);
        assert.strictEqual((await post('/api/pdf/move', { name: plain, i: 0, idxs: [0], dx: 7, dy: 0 })).body.ok, true);
        const before = entryOf(plain);
        const prot = path.join(dir, 'protected.pdf');
        for (const [bad, why] of [[{ userPassword: '' }, '빈 암호'], [{}, '암호 없음'], [{ userPassword: 'a'.repeat(128) }, '127바이트 초과'],
          [{ userPassword: '가'.repeat(43) }, '한글 43자 = 129바이트'], [{ userPassword: 'ok', ownerPassword: 'b'.repeat(200) }, '권한 암호 초과']]) {
          r = await post('/api/pdf/protect', { name: plain, to: prot, ...bad });
          assert.strictEqual(r.status, 400, why);
          assert.ok(r.body.error, why);
        }
        assert.ok(!fs.existsSync(prot), '거절하면 쓰지 않는다');
        r = await post('/api/pdf/protect', { name: plain, to: prot, userPassword: 'open-pw', ownerPassword: 'owner-pw' });
        assert.deepStrictEqual([r.status, r.body], [200, { ok: true, path: prot }]);
        await assert.rejects(realOpen(fs.readFileSync(prot)), (e) => e.code === 'PASSWORD_REQUIRED', '암호 없이는 안 열린다');
        for (const pw of ['open-pw', 'owner-pw']) {
          const d = await realOpen(fs.readFileSync(prot), pw);
          assert.deepStrictEqual([d.pageCount, d.pageText(1), d.securityRevision], [2, 'Page 2', 6]);
          d.close();
        }
        const i1 = await info(plain);
        assert.deepStrictEqual([i1.dirty, i1.security, i1.undoLeft], [true, { encrypted: false, openPassword: false, restricted: false }, 1], '열린 문서는 그대로(미저장·암호 없음)');
        assert.strictEqual(entryOf(plain), before, '새 경로로 옮겨 가지 않는다');
        assert.ok(!entryOf(prot), '사본은 캐시에 열지 않는다');
        assert.ok(!fs.readFileSync(prot).includes('open-pw') && !fs.readFileSync(prot).includes('owner-pw'), '파일에 암호 원문이 없다');
        // 한글 암호 + 인쇄·복사 금지
        const ko = path.join(dir, 'protected-ko.pdf');
        r = await post('/api/pdf/protect', { name: plain, to: ko, userPassword: '비밀번호123', allow: { print: false, copy: false } });
        assert.strictEqual(r.status, 200);
        const k = await realOpen(fs.readFileSync(ko), '비밀번호123');
        assert.deepStrictEqual([k.permissions & 4, k.permissions & 16, k.permissions & 8, k.security.restricted], [0, 0, 8, true]);
        k.close();
        // 같은 경로에 걸기: 디스크가 암호 문서가 된다 → dirty 풀림 · security 암호 문서 · 덮어쓰기 저장 409 · 암호는 메모리에만
        r = await post('/api/pdf/protect', { name: plain, to: plain, userPassword: 'same-pw', allow: { modify: false } });
        assert.deepStrictEqual([r.status, r.body.ok], [200, true]);
        const i2 = await info(plain);
        assert.deepStrictEqual([i2.dirty, i2.security], [false, { encrypted: true, openPassword: true, restricted: true }]);
        assert.strictEqual(entryOf(plain), before, '같은 항목 그대로(다시 열지 않는다)');
        assert.strictEqual(before.password, 'same-pw');
        await assert.rejects(realOpen(fs.readFileSync(plain)), (e) => e.code === 'PASSWORD_REQUIRED');
        r = await post('/api/pdf/save', { name: plain });
        assert.deepStrictEqual([r.status, r.body.needSaveAs], [409, true], '암호를 건 파일을 암호 없이 덮어쓰지 않는다');
        assert.strictEqual(entryOf(plain).doc.pageText(1), 'Page 2', '메모리 문서는 암호 없이 계속 편집된다');
        await post('/api/pdf/close', { name: plain });
        // 닫은 뒤 다시 열면 암호를 묻는다
        assert.deepStrictEqual([(await raw('GET', '/api/pdf/info?' + new URLSearchParams({ name: plain }))).status], [401]);
        assert.strictEqual((await post('/api/pdf/unlock', { name: plain, password: 'same-pw' })).status, 200);
        await post('/api/pdf/close', { name: plain });
      }

      // 쪽 작업: 빈 쪽 · 복제 · 다른 PDF 끼우기(암호 원본 거절) · 떨어진 쪽 순서 변경 — 각각 실행 취소 한 번
      const doc5 = path.join(dir, 'pages.pdf');
      fs.writeFileSync(doc5, buildPdf({ pages: [{}, {}, {}] }));
      await info(doc5);
      const E = () => entryOf(doc5);
      r = await post('/api/pdf/pages/blank', { name: doc5, at: 1 });
      assert.deepStrictEqual([r.body.ok, r.body.reloadAll, r.body.undoLeft, E().doc.pageCount], [true, true, 1, 4]);
      r = await post('/api/pdf/pages/duplicate', { name: doc5, pages: [0, 3] });
      assert.deepStrictEqual([r.body.pages, r.body.undoLeft], [[1, 5], 2]);
      assert.deepStrictEqual(pageTexts(E()), ['Page 1', 'Page 1', '', 'Page 2', 'Page 3', 'Page 3']);
      const other = path.join(dir, 'other.pdf');
      fs.writeFileSync(other, buildPdf({ pages: [{ content: 'BT /F1 20 Tf 40 40 Td (Inserted) Tj ET' }] }));
      r = await post('/api/pdf/pages/insert-pdf', { name: doc5, at: 0, path: other });
      assert.deepStrictEqual([r.body.inserted, r.body.pageCount], [1, 7]);
      assert.strictEqual(E().doc.pageText(0), 'Inserted');
      r = await post('/api/pdf/pages/insert-pdf', { name: doc5, at: 0, path: enc });
      assert.deepStrictEqual([r.status, r.body.sourceEncrypted], [400, true], '암호 걸린 원본은 400');
      assert.match(r.body.error, /암호/);
      assert.strictEqual((await info(doc5)).undoLeft, 3, '거절은 실행 취소 기록을 남기지 않는다');
      r = await post('/api/pdf/pages/reorder', { name: doc5, order: [2, 4, 0, 1, 3, 5, 6] }); // 떨어진 두 쪽(2·4)을 맨 앞으로
      assert.deepStrictEqual(pageTexts(E()), ['Page 1', 'Page 2', 'Inserted', 'Page 1', '', 'Page 3', 'Page 3']);
      for (const want of [7, 7, 6, 4, 3]) { // reorder → insert → duplicate → blank 순으로 되돌린다
        assert.strictEqual(E().doc.pageCount, want);
        if (want === 3) break;
        await post('/api/pdf/undo', { name: doc5 });
      }
      assert.deepStrictEqual(pageTexts(E()), ['Page 1', 'Page 2', 'Page 3']);

      if (process.platform === 'win32') {
        // 쪽 번호: 다시 매기면 바뀌고, 실행 취소 한 번이면 직전 상태로
        r = await post('/api/pdf/page-numbers', { name: doc5, format: 'n/N', position: 'bottom-center' });
        assert.deepStrictEqual([r.body.ok, r.body.numbered, r.body.reloadAll], [true, 3, true]);
        r = await post('/api/pdf/page-numbers', { name: doc5, format: 'ko', skipFirst: true });
        assert.deepStrictEqual([r.body.numbered, r.body.removed], [2, 3]);
        const nums = () => Array.from({ length: 3 }, (_, i) => E().doc.objects(i).filter((o) => o.pageNum).map((o) => o.text).join());
        assert.deepStrictEqual(nums(), ['', '1쪽', '2쪽']);
        await post('/api/pdf/undo', { name: doc5 });
        assert.deepStrictEqual(nums(), ['1 / 3', '2 / 3', '3 / 3'], '실행 취소 한 번 = 쪽 번호 한 번');
        assert.strictEqual((await post('/api/pdf/page-numbers/remove', { name: doc5 })).body.removed, 3);
        assert.deepStrictEqual(nums(), ['', '', '']);
        assert.strictEqual((await post('/api/pdf/page-numbers/remove', { name: doc5 })).body.ok, false, '지울 것이 없으면 ok:false');

        // 글상자: 한글 두 줄 → 줄 편집(/api/pdf/edit)으로 고칠 수 있다
        r = await post('/api/pdf/textbox', { name: doc5, i: 1, x: 60, y: 300, text: '새 글상자\n둘째 줄', size: 16, color: '#336699' });
        assert.ok(r.body.ok && r.body.idxs.length === 2, JSON.stringify(r.body));
        const objs = E().doc.objects(1);
        assert.deepStrictEqual(r.body.idxs.map((k) => objs[k].text), ['새 글상자', '둘째 줄']);
        assert.deepStrictEqual(objs[r.body.idx].color, [0x33, 0x66, 0x99, 255]);
        const ed = await post('/api/pdf/edit', { name: doc5, i: 1, idx: r.body.idx, text: '고친 글상자' });
        assert.strictEqual(ed.body.ok, true, JSON.stringify(ed.body));
        assert.ok(E().doc.objects(1).some((o) => o.text === '고친 글상자'), '편집 반영');
        assert.strictEqual((await post('/api/pdf/textbox', { name: doc5, i: 1, x: 0, y: 0, text: '' })).status, 500);
      }

      // 도장 보관함: PNG/JPEG만 · 같은 이미지는 하나 · 이름 바꾸기 · 지우기 · 40개 상한
      const seal = makePng(40, 40, (x, y) => ((x - 20) ** 2 + (y - 20) ** 2 < 300 ? [220, 0, 0, 255] : [255, 255, 255, 0])); // 투명 바탕의 빨간 원
      r = await post('/api/stamps', { name: '회사 직인', data: seal.toString('base64') });
      assert.deepStrictEqual([r.body.name, r.body.width, r.body.height, r.body.type, r.body.id.length], ['회사 직인', 40, 40, 'png', 16]);
      const sealId = r.body.id;
      const jpg = require('jpeg-js').encode({ data: Buffer.alloc(16 * 8 * 4, 128), width: 16, height: 8 }, 80).data;
      r = await raw('POST', '/api/stamps?' + new URLSearchParams({ name: '서명' }), Buffer.from(jpg), { 'Content-Type': 'image/jpeg' }); // 본문 = 이미지 바이트
      assert.deepStrictEqual([r.body.type, r.body.width, r.body.height], ['jpeg', 16, 8]);
      let list = (await raw('GET', '/api/stamps')).body;
      assert.deepStrictEqual(list.map((s) => s.name), ['서명', '회사 직인'], '최근 것이 앞');
      r = await post('/api/stamps', { name: '다른 이름', data: seal.toString('base64') });
      assert.deepStrictEqual([r.body.id, r.body.duplicate, r.body.name], [sealId, true, '회사 직인'], '같은 이미지는 새로 만들지 않는다');
      list = (await raw('GET', '/api/stamps')).body;
      assert.deepStrictEqual(list.map((s) => s.name), ['회사 직인', '서명'], '다시 넣으면 맨 앞으로');
      assert.strictEqual((await post('/api/stamps', { name: 'x', data: Buffer.from('GIF89a........').toString('base64') })).status, 400, 'PNG/JPEG만');
      const img = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: 4848, path: '/api/stamps/image?id=' + sealId }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ type: res.headers['content-type'], data: Buffer.concat(c) })); }));
      assert.deepStrictEqual([img.type, img.data.equals(seal)], ['image/png', true]);
      assert.strictEqual((await post('/api/stamps/rename', { id: sealId, name: '  대표 인감 ' })).body.name, '대표 인감');
      assert.ok(fs.existsSync(path.join(DATA_DIR, 'stamps', 'stamps.json')), 'RETEXTPDF_DATA/stamps에 보관');
      assert.strictEqual((await raw('GET', '/api/stamps/image?id=zz')).status, 400);

      // 도장 찍기: 투명 PNG의 바탕이 비친다(밑 글자가 보인다) → 크기 조절·이동도 같은 객체로
      const sealPage = path.join(dir, 'seal.pdf');
      fs.writeFileSync(sealPage, buildPdf({ pages: [{ content: '0 0 1 rg 0 0 400 400 re f' }] })); // 파란 바탕
      await info(sealPage);
      r = await post('/api/pdf/stamp', { name: sealPage, i: 0, id: sealId, x: 100, y: 100, w: 200, h: 200 });
      assert.ok(r.body.ok && r.body.idx >= 0 && r.body.undoLeft === 1, JSON.stringify(r.body));
      const px = (x, y) => { const raw2 = entryOf(sealPage).doc._renderRaw(0, 1), p = y * raw2.stride + x * 4; return [...raw2.data.subarray(p, p + 3)]; };
      assert.deepStrictEqual(px(110, 110), [0, 0, 255], '도장의 투명한 귀퉁이로 밑의 파랑이 보인다');
      assert.deepStrictEqual(px(200, 200), [220, 0, 0], '도장 가운데는 빨강');
      assert.strictEqual((await post('/api/pdf/object/resize', { name: sealPage, i: 0, idx: r.body.idx, box: { x: 0, y: 0, w: 50, h: 50 } })).body.ok, true);
      assert.strictEqual((await post('/api/pdf/move', { name: sealPage, i: 0, idxs: [r.body.idx], dx: 10, dy: 10 })).body.ok, true);
      { // PNG 풀기(image-util): PDFium이 만든 PNG(줄마다 필터가 섞임)를 풀어 렌더 원본 픽셀과 같아야 한다
        const { decodePng } = require('./image-util');
        const doc = entryOf(sealPage).doc, png = await doc.render(0, 0.7), rawPx = doc._renderRaw(0, 0.7), dec = decodePng(png);
        assert.deepStrictEqual([dec.width, dec.height], [rawPx.w, rawPx.h]);
        let diff = 0;
        for (let y = 0; y < rawPx.h; y++) for (let x = 0; x < rawPx.w * 4; x++) if (dec.data[y * rawPx.w * 4 + x] !== rawPx.data[y * rawPx.stride + x]) diff++;
        assert.strictEqual(diff, 0, 'PNG 풀기 결과가 렌더 픽셀과 같다');
      }
      r = await post('/api/pdf/stamp', { name: sealPage, i: 0, id: sealId }); // 상자를 안 주면 쪽 폭 25% 가운데
      assert.deepStrictEqual(r.body.bounds, { x0: 150, y0: 150, x1: 250, y1: 250 });
      assert.strictEqual((await post('/api/pdf/stamp', { name: sealPage, i: 0, id: '0123456789abcdef' })).status, 404);

      assert.deepStrictEqual((await post('/api/stamps/delete', { id: sealId })).body, { ok: true });
      assert.deepStrictEqual((await raw('GET', '/api/stamps')).body.map((s) => s.name), ['서명']);
      assert.strictEqual((await post('/api/stamps/delete', { id: sealId })).status, 404);
      for (let k = 0; k < 39; k++) { // '서명' + 39개 = 40개까지
        const rr = await post('/api/stamps', { name: `s${k}`, data: makePng(2, 2, () => [k, 0, 0, 255]).toString('base64') });
        assert.strictEqual(rr.status, 200, JSON.stringify(rr.body));
      }
      r = await post('/api/stamps', { name: 'over', data: makePng(2, 2, () => [0, 99, 0, 255]).toString('base64') });
      assert.deepStrictEqual([r.status, /40개/.test(r.body.error)], [409, true], '41번째는 거절');

      // 인쇄 HTML: 세로·가로(회전 포함) 쪽마다 맞는 @page, 쪽 고르기
      const mixed = path.join(dir, 'mixed.pdf');
      fs.writeFileSync(mixed, buildPdf({ pages: [{ w: 595, h: 842 }, { w: 842, h: 595 }, { w: 595, h: 842, extra: '/Rotate 90' }] }));
      r = await raw('GET', '/api/pdf/print-html?' + new URLSearchParams({ name: mixed }));
      assert.strictEqual(r.status, 200);
      assert.match(r.body, /@page s0 \{ size: 595pt 842pt; margin: 0 \}/);
      assert.match(r.body, /@page s1 \{ size: 842pt 595pt; margin: 0 \}/);
      assert.strictEqual((r.body.match(/class="pg s1"/g) || []).length, 2, '가로 쪽과 가로로 돌린 쪽은 같은 가로 용지');
      assert.ok(r.body.includes('/api/pdf/page?name=') && r.body.includes('scale=2.778'), '약 200dpi로 그린 쪽 그림');
      r = await raw('GET', '/api/pdf/print-html?' + new URLSearchParams({ name: mixed, pages: '2' }));
      assert.strictEqual((r.body.match(/class="pg /g) || []).length, 1);
      assert.strictEqual((await raw('GET', '/api/pdf/print-html?' + new URLSearchParams({ name: mixed, pages: '9' }))).status, 400);
      assert.strictEqual((await raw('GET', '/api/pdf/print-html?' + new URLSearchParams({ name: enc }))).status, 401, '잠긴 문서는 인쇄 HTML도 401(다른 이름 저장으로 항목이 옮겨 갔다)');
      await post('/api/pdf/unlock', { name: enc, password: 'pw' });
      assert.strictEqual((await raw('GET', '/api/pdf/print-html?' + new URLSearchParams({ name: enc }))).status, 200, '잠금 푼 문서는 인쇄 가능');
      const { buildPrintHtml } = require('./print-html');
      assert.ok(buildPrintHtml({ name: 'a"<b>.pdf', pages: [{ i: 0, w: 10, h: 10 }] }).includes('<title>a&quot;&lt;b&gt;.pdf</title>'), '이름 이스케이프');
      assert.throws(() => buildPrintHtml({ name: 'a.pdf', pages: [] }), /인쇄할 쪽/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('OK — P6 서버 로직(C1 작업·C3 undo 상한·C4 조기 종료)·라우트(주소·본문·캐시·되돌리기·409)·P7(암호·쪽 작업·쪽 번호·글상자·도장·인쇄 HTML) 검사 통과');
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
