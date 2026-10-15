// 자체 검사: node app/pdf-wave-f.test.js
// v6 Wave F — ① 글자 선택·복사(글자 흐름: 여러 줄·하이픈 잇기·돌린 글자·낱말/줄·가리기 조각·형광펜 quads, 진짜 PDF 독서모임_안내)
// ② 맞춤법 검사(오프라인 Hunspell: 낱말 판정·제안·영어·낱말 나누기·사용자 사전·무시·성능 2,000 낱말 < 1초·네트워크 차단·문서 검사와 고치기 — 진짜 서버 127.0.0.1:4993)
// ③ 탭을 바꿔도 고치던 상태 유지(index.html의 parkInplace·snapshotEditing·restoreParked를 꺼내 가짜 화면으로 돌린다 — 되살리기·문서가 바뀐 경우 묻기)
// 홈 폴더·앱 데이터는 저장소 tmp\ 아래 임시 폴더로 돌린다. 사용자 앱의 4747 포트는 쓰지 않는다
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const TMP_ROOT = path.join(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_ROOT, { recursive: true });
const DIR = fs.mkdtempSync(path.join(TMP_ROOT, 'wavef-'));
const HOME = path.join(DIR, 'home'); fs.mkdirSync(HOME);
const WS = path.join(DIR, 'ws'); fs.mkdirSync(WS);
fs.writeFileSync(path.join(HOME, '.retext-pdf.json'), JSON.stringify({ workspace: WS }));
process.env.HOME = HOME; process.env.USERPROFILE = HOME;
process.env.RETEXTPDF_DATA = path.join(DIR, 'data');
const PORT = 4993;
process.env.RETEXTPDF_PORT = String(PORT);

const TS = require('./text-select');
const SC = require('./spell-core');
const spell = require('./spell-check');
const { open } = require('./pdf-engine');
const { groupLines } = require('./text-grouping');
const { buildPdf } = require('./pdf-test-fixtures');
const T0 = Date.now();
const lap = (label) => console.log(`  ${label} (${((Date.now() - T0) / 1000).toFixed(1)}초)`);

// 글자마다 고른 폭(w)으로 놓은 가짜 텍스트 객체(엔진 objects()와 같은 모양: text·glyphs[x,y,w]·matrix·scaledSize·bounds)
function fakeObj(idx, text, x, y, { size = 10, w = 6, angle = 0, partFrom } = {}) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const glyphs = [...text].map((_, k) => [x + c * w * k, y + s * w * k, w]);
  const xs = glyphs.flatMap(([gx, gy]) => [gx, gx + c * w]), ys = glyphs.flatMap(([gx, gy]) => [gy, gy + s * w]);
  return { idx, type: 'text', text, glyphs, matrix: [c * size, s * size, -s * size, c * size, x, y], size: 1, scaledSize: size,
    bounds: { x0: Math.min(...xs) - 2, y0: Math.min(...ys) - 2, x1: Math.max(...xs) + 2, y1: Math.max(...ys) + size }, ...(partFrom != null ? { partFrom } : {}) };
}
const line = (objs, seps = []) => ({ objs, seps, text: objs.map((o, j) => (j ? seps[j - 1] || '' : '') + o.text).join('') });

(async () => {
  // ── 1. 글자 선택: 순수 계산 ───────────────────────────────────────────────
  {
    // 여러 줄 + 줄 끝 하이픈(영문 소문자로 이어지면 붙인다) + 한글 줄바꿈 유지
    const L1 = line([fakeObj(1, 'Hello', 50, 700), fakeObj(2, 'inter-', 86, 700)], [' ']);
    const L2 = line([fakeObj(3, 'national', 50, 686), fakeObj(4, 'day', 104, 686)], [' ']);
    const L3 = line([fakeObj(5, '가나다', 50, 672)]);
    const L4 = line([fakeObj(6, '라마바', 50, 658)]);
    const m = TS.build([L1, L2, L3, L4]);
    assert.strictEqual(m.chars.length, 'Hello inter-'.length + 'national day'.length + 3 + 3);
    assert.strictEqual(TS.textOf(m, 0, m.chars.length), 'Hello international day\n가나다\n라마바', '줄 끝 하이픈은 이어 붙이고(소문자) 한글 줄은 줄바꿈');
    // 첫 줄 일부 ~ 둘째 줄 일부(읽기 순서로 이어진다)
    const a = 'Hello in'.length, b = m.lineStart[1] + 'nation'.length;
    assert.strictEqual(TS.textOf(m, a, b), 'ternation', '여러 줄에 걸친 고르기 + 하이픈 잇기');
    assert.strictEqual(TS.textOf(m, b, a), 'ternation', '거꾸로 끌어도 같다');
    // 대문자로 이어지면 하이픈을 남기고 줄을 바꾼다
    const mUp = TS.build([line([fakeObj(1, 'Retext-', 50, 700)]), line([fakeObj(2, 'PDF', 50, 686)])]);
    assert.strictEqual(TS.textOf(mUp, 0, mUp.chars.length), 'Retext-\nPDF', '하이픈 뒤가 대문자면 잇지 않는다');
    // 소프트 하이픈은 늘 이어 붙이고 빠진다
    const mShy = TS.build([line([fakeObj(1, 'hyphen\u00AD', 50, 700)]), line([fakeObj(2, 'ation', 50, 686)])]);
    assert.strictEqual(TS.textOf(mShy, 0, mShy.chars.length), 'hyphenation', '소프트 하이픈');
    // 점 → 칸 경계: 둘째 줄 'n' 칸 오른쪽 절반이면 그 뒤
    const nIdx = m.lineStart[1] + 'natio'.length; // 'n'
    const c = m.chars[nIdx];
    assert.strictEqual(TS.caretAt(m, c.b.x1 - 1, 690), nIdx + 1, '글자 오른쪽 절반 → 그 글자 뒤 경계');
    assert.strictEqual(TS.caretAt(m, c.b.x0 + 1, 690), nIdx, '글자 왼쪽 절반 → 그 글자 앞 경계');
    assert.strictEqual(TS.caretAt(m, 400, 690), m.lineEnd[1], '줄 오른쪽 바깥 → 그 줄 끝');
    // 낱말·줄
    assert.deepStrictEqual(TS.wordAt(m, m.lineStart[1] + 2), [m.lineStart[1], m.lineStart[1] + 'national'.length], '두 번 클릭 = 낱말');
    assert.deepStrictEqual(TS.lineAt(m, m.lineStart[2] + 1), [m.lineStart[2], m.lineEnd[2]], '세 번 클릭 = 줄');
    // 가리기 조각: 사이 글(띄어쓰기)은 빼고 객체 글 범위로, 객체 안 부분(partFrom)은 그만큼 더한다
    assert.deepStrictEqual(TS.partsOf(m, 3, 'Hello inte'.length), [{ idx: 1, from: 3, to: 5 }, { idx: 2, from: 0, to: 4 }], '가리기 조각(사이 띄어쓰기 제외)');
    const mp = TS.build([line([fakeObj(9, '부분글', 50, 700, { partFrom: 4 })])]);
    assert.deepStrictEqual(TS.partsOf(mp, 1, 3), [{ idx: 9, from: 5, to: 7 }], '객체 안 부분은 partFrom만큼 민다');
    // 형광펜 quads: 줄마다 [왼위, 오른위, 왼아래, 오른아래]
    const q = TS.quadsOf(m, 0, m.lineEnd[0]);
    assert.strictEqual(q.length, 1);
    assert.ok(q[0][1] > q[0][5] && q[0][0] < q[0][2] && Math.abs(q[0][1] - q[0][3]) < 0.01, `quads 순서 ${q[0]}`);
    // 돌린 글자(90°, 아래→위로 쓴 줄): 칸이 위로 이어지고 점 찾기·네모도 그 방향
    const rot = TS.build([line([fakeObj(1, 'ABCD', 200, 100, { angle: Math.PI / 2 })])]);
    const r0 = rot.chars[0].b, r3 = rot.chars[3].b;
    assert.ok(r3.y0 > r0.y1 - 0.01 && Math.abs(r3.x0 - r0.x0) < 0.01, '돌린 글자 칸은 위로 쌓인다');
    assert.strictEqual(TS.caretAt(rot, 198, 100 + 6 * 2 + 4.5), 3, '돌린 줄에서 셋째 글자 위쪽 절반 → 그 뒤 경계');
    const run = TS.runs(rot, 0, 4)[0].p;
    assert.ok(Math.abs(run[1][0] - run[0][0]) < 0.01 && run[1][1] > run[0][1], '돌린 줄의 네모도 글자 방향(아래→위)');
    assert.strictEqual(TS.textOf(rot, 1, 3), 'BC');
    lap('글자 선택 계산(여러 줄·하이픈·낱말/줄·가리기 조각·quads·돌린 글자) 통과');
  }
  // 진짜 PDF: 동봉 안내문 — 줄마다 글이 엔진 글과 같고, 쪽 전체 글에 한글 문장이 줄바꿈과 함께 들어 있다. 쪽을 돌려도 글자 흐름(회전 전 좌표)은 같다
  {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf'));
    const d = await open(bytes);
    const lines = groupLines(d.objects(0).filter((o) => o.type === 'text' && !o.mask), { mergeStyledRuns: true });
    const m = TS.build(lines);
    lines.forEach((L, li) => assert.strictEqual(TS.textOf(m, m.lineStart[li], m.lineEnd[li]), L.text.replace(/\u00AD/g, ''), `줄 ${li} 글`));
    const all = TS.textOf(m, 0, m.chars.length);
    assert.ok(all.includes('『어린 왕자』를 함께 읽고') && all.includes('\n하게 오세요.') && all.startsWith('10월 독서 모임 안내\n'), all.slice(0, 120));
    const k = lines.findIndex((L) => L.text.includes('읽으셨어도'));
    const w = TS.wordAt(m, m.lineStart[k] + lines[k].text.indexOf('읽으셨어도') + 1);
    assert.strictEqual(TS.textOf(m, w[0], w[1]), '읽으셨어도', '두 번 클릭 낱말(한글)');
    // 칠 네모는 줄 상자와 거의 같은 자리
    const r = TS.runs(m, m.lineStart[k], m.lineEnd[k])[0].b, lb = lines[k].bounds;
    assert.ok(Math.abs(r.x0 - lb.x0) < 3 && Math.abs(r.x1 - lb.x1) < 3 && r.y0 <= lb.y0 + 1 && r.y1 >= lb.y1 - 1, `칠 자리 ${JSON.stringify(r)} ≈ 줄 ${JSON.stringify(lb)}`);
    d.rotatePages([0], 90);
    const m2 = TS.build(groupLines(d.objects(0).filter((o) => o.type === 'text' && !o.mask), { mergeStyledRuns: true }));
    assert.strictEqual(TS.textOf(m2, 0, m2.chars.length), all, '돌린 쪽에서도 같은 글(쪽 회전은 화면 좌표 변환이 맡는다)');
    d.close();
    lap('진짜 PDF 글자 흐름(독서모임_안내 — 줄 글·한글 낱말·돌린 쪽) 통과');
  }

  // ── 2. 맞춤법: 낱말 나누기·자주 틀리는 말(순수) ─────────────────────────
  {
    const toks = SC.tokenize('『어린 왕자』를 읽고 PDF를 https://example.com/가나 ab@cd.com 2026년 iPhone XML teh 됬다');
    const pick = (w) => toks.find((t) => t.word === w);
    assert.strictEqual(pick('를').skip, 'josa', '닫는 괄호 뒤 조사는 건너뛴다');
    assert.strictEqual(pick('PDF를').skip, 'mixed');
    assert.strictEqual(pick('가나').skip, 'url'); assert.strictEqual(pick('cd').skip, 'url', '메일 주소');
    assert.strictEqual(pick('2026년').skip, 'digit'); assert.strictEqual(pick('iPhone').skip, 'caps'); assert.strictEqual(pick('XML').skip, 'caps');
    assert.deepStrictEqual(SC.checkable('『어린 왕자』를 읽고 됬다 teh').map((t) => t.word), ['어린', '왕자', '읽고', '됬다', 'teh']);
    assert.strictEqual(SC.tokenize('"책"은')[0].skip, null, '여는 따옴표 뒤 낱말은 검사한다');
    assert.deepStrictEqual(SC.commonFixes('됬다'), ['됐다']); assert.deepStrictEqual(SC.commonFixes('몇일'), ['며칠']); assert.deepStrictEqual(SC.commonFixes('안되요'), ['안돼요']);
    assert.ok(SC.alwaysWrong('됬다') && !SC.alwaysWrong('됐다') && !SC.alwaysWrong('선생님께'));
    assert.ok(SC.compoundOk('독서모임', (w) => ['독서', '모임'].includes(w)) && !SC.compoundOk('몇일', () => true), '합성어는 두 글자 이상씩');
    lap('맞춤법 낱말 나누기·자주 틀리는 말 통과');
  }

  // ── 3. 맞춤법: 진짜 사전(작업 스레드) ───────────────────────────────────
  {
    const st = spell.status();
    assert.strictEqual(st.available, true, JSON.stringify(st));
    assert.deepStrictEqual(st.langs.map((l) => [l.code, l.ok]), [['ko', true], ['en', true]], '사전 크기·SHA-256 확인');
    assert.strictEqual(spell._test.unpacked('C:\\x\\resources\\app.asar\\node_modules\\hunspell-dict-ko'), 'C:\\x\\resources\\app.asar.unpacked\\node_modules\\hunspell-dict-ko');
    const t0 = Date.now();
    const res = await spell.check(['안녕하세요', '했습니다', '읽으셨어도', '독서모임', '됬다', '안되요', '몇일', 'receive', 'recieve', 'teh', 'Hello']);
    const ok = Object.fromEntries(res.map((r) => [r.word, r.ok]));
    console.log(`  사전 읽기 ${spell._test.loadMs()}ms · 첫 검사 ${Date.now() - t0}ms`);
    for (const w of ['안녕하세요', '했습니다', '읽으셨어도', '독서모임', 'receive', 'Hello']) assert.strictEqual(ok[w], true, `${w}는 맞다`);
    for (const w of ['됬다', '안되요', '몇일', 'recieve', 'teh']) assert.strictEqual(ok[w], false, `${w}는 틀렸다`);
    for (const [w, want] of [['됬다', '됐다'], ['안되요', '안돼요'], ['몇일', '며칠'], ['recieve', 'receive']]) {
      const sugs = await spell.suggest(w);
      assert.strictEqual(sugs[0], want, `${w}의 첫 제안은 ${want} (${sugs.join(', ')})`);
    }
    const sample = '아직 다 못 읽으셨어도 편하게 오세요. 그건 됬다';
    assert.deepStrictEqual((await spell.checkText(sample)).map((x) => [x.at, x.word]), [[sample.indexOf('됬다'), '됬다']], '글 검사: 자리와 낱말');
    // 성능: 서로 다른 낱말이 섞인 2,000 낱말(데우기 뒤) < 1초
    const text = fs.readFileSync(path.join(__dirname, '..', 'README.ko.md'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    const words = SC.checkable(text).map((t) => t.word), list = [];
    for (let k = 0; list.length < 2000; k++) list.push(words[k % words.length] + (k >= words.length ? '' : ''));
    spell._test.clearCache();
    const t1 = Date.now(); await spell.check(list); const ms = Date.now() - t1;
    console.log(`  2,000 낱말(서로 다른 ${new Set(list).size}개) 검사 ${ms}ms`);
    assert.ok(ms < 1000, `2,000 낱말 < 1초 (${ms}ms)`);
    // 사용자 사전(앱 데이터 폴더 spell-user-dict.json)·무시
    assert.strictEqual((await spell.check(['렌탈']))[0].ok, false);
    await spell.addWords(['렌탈']);
    assert.strictEqual((await spell.check(['렌탈']))[0].ok, true, '사전에 넣으면 맞다');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(spell._test.dictPath(), 'utf8')).words, ['렌탈'], 'spell-user-dict.json에 저장');
    spell._test.reloadUserDict(); spell._test.clearCache(); await spell.shutdown(); // 다시 시작해도 사용자 사전을 읽는다
    assert.strictEqual((await spell.check(['렌탈']))[0].ok, true, '다시 시작해도 사용자 사전');
    await spell.removeWords(['렌탈']);
    assert.strictEqual((await spell.check(['렌탈']))[0].ok, false, '사전에서 빼면 다시 틀림');
    spell.ignore(['렌탈']);
    assert.strictEqual((await spell.check(['렌탈']))[0].ok, true, '무시(이번 실행)');
    spell._test.resetIgnored();
    // 네트워크: 작업 스레드에서 주소로 나가 보면 우리 차단 메시지로 실패한다
    const probe = await spell._test.call({ op: 'netprobe', url: 'https://example.invalid/ko.dic' });
    assert.match(probe.blocked || '', /맞춤법 검사는 네트워크를 쓰지 않습니다 \(fetch 차단/, JSON.stringify(probe));
    const wsrc = fs.readFileSync(path.join(__dirname, 'spell-worker.js'), 'utf8');
    for (const w of ['http', 'net.connect', 'dns.lookup', 'tls.connect']) assert.ok(wsrc.includes(w), `spell-worker.js가 ${w}를 막는다`);
    // 패키징: 작업 스레드·엔진·사전은 asar 밖(작업 스레드는 asar 안 파일을 못 연다), 의존성은 정확한 판
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    for (const u of ['app/spell-worker.js', 'app/spell-core.js', 'node_modules/hunspell-wasm/**', 'node_modules/hunspell-dict-ko/**', 'node_modules/dictionary-en/**']) assert.ok(pkg.build.asarUnpack.includes(u), `asarUnpack ${u}`);
    assert.deepStrictEqual([pkg.dependencies['hunspell-wasm'], pkg.dependencies['hunspell-dict-ko'], pkg.dependencies['dictionary-en']], ['0.3.0', '0.1.0', '4.0.0'], '정확한 판으로 고정');
    const notices = fs.readFileSync(path.join(__dirname, '..', 'THIRD-PARTY-NOTICES.md'), 'utf8'), lic = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
    for (const h of ['de5c54d313dbbf781a8b521129ca3ec3e0fa128263aeefd2f31e339a85a9f53e', '7ae3b3ca5ea1b344129d2e425c46e77fc36dc353c2afe8fb0f4b5093ff92d873', 'f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647']) assert.ok(notices.includes(h), `알림에 해시 ${h.slice(0, 8)}`);
    assert.ok(/hunspell-dict-ko/.test(lic) && /hunspell-wasm/.test(lic) && /dictionary-en/.test(lic), 'LICENSE §6 목록');
    lap('맞춤법 사전(판정·제안·영어·성능·사용자 사전·무시·네트워크 차단) 통과');
  }

  // ── 4. 맞춤법: 문서 검사 → 고치기(진짜 서버, 실행 취소 한 번) ───────────────
  {
    const src = await open(buildPdf({ pages: [{ w: 595, h: 842, content: '' }] }));
    const LINES = ['회의 결과를 정리했습니다.', '이번 일정은 몇일 뒤에 정하기로 됬다.', '자료는 아직 준비가 안되요.'];
    LINES.forEach((t, k) => src.addTextBox(0, { text: t, x: 60, y: 760 - k * 30, size: 14 }));
    const file = path.join(WS, '맞춤법-시험.pdf');
    fs.writeFileSync(file, src.save()); src.close();
    const { ready } = require('./server.js');
    const port = await ready;
    assert.strictEqual(port, PORT);
    const req = (method, p, body) => new Promise((resolve, reject) => {
      const data = body ? Buffer.from(JSON.stringify(body)) : null;
      const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (e) { reject(e); } });
      });
      r.on('error', reject); if (data) r.write(data); r.end();
    });
    const scan = await req('POST', '/api/spell/scan', { name: file });
    assert.strictEqual(scan.status, 200, JSON.stringify(scan.body));
    assert.deepStrictEqual(scan.body.issues.map((x) => x.word), ['몇일', '됬다', '안되요'], `심어 둔 세 낱말만 (${scan.body.issues.map((x) => x.word)})`);
    assert.ok(scan.body.issues.every((x) => x.editable && x.rect && x.suggestions?.length), '고칠 수 있는 자리·사각형·제안');
    // 하나 고치기 → 실행 취소 한 번 → 되돌아온다
    const one = scan.body.issues[0];
    const r1 = await req('POST', '/api/spell/fix', { name: file, fixes: [{ ...one, replacement: one.suggestions[0] }] });
    assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
    assert.strictEqual(r1.body.count, 1); assert.strictEqual(r1.body.undoLeft, 1, '고치기 하나 = 실행 취소 하나');
    const text1 = (await req('GET', `/api/pdf/text?name=${encodeURIComponent(file)}&i=0`)).body.text;
    assert.ok(text1.includes('며칠') && !text1.includes('몇일'), text1);
    // 그새 바뀐 자리를 고치려 하면 409
    const stale = await req('POST', '/api/spell/fix', { name: file, fixes: [{ ...one, replacement: '며칠' }] });
    assert.strictEqual(stale.status, 409, '문서가 바뀌었으면 다시 검사하라고');
    await req('POST', '/api/pdf/undo', { name: file });
    // 모두 고치기(같은 줄의 둘 + 다른 줄의 하나) = 실행 취소 한 번
    const scan2 = await req('POST', '/api/spell/scan', { name: file });
    assert.strictEqual(scan2.body.issues.length, 3, '되돌린 뒤 다시 셋');
    const all = await req('POST', '/api/spell/fix', { name: file, fixes: scan2.body.issues.map((x) => ({ ...x, replacement: x.suggestions[0] })) });
    assert.strictEqual(all.status, 200, JSON.stringify(all.body));
    assert.strictEqual(all.body.count, 3); assert.strictEqual(all.body.undoLeft, 1, '모두 고치기도 실행 취소 한 번');
    const text2 = (await req('GET', `/api/pdf/text?name=${encodeURIComponent(file)}&i=0`)).body.text.replace(/\s+/g, ' ');
    for (const want of ['며칠 뒤에 정하기로 됐다.', '준비가 안돼요.', '회의 결과를 정리했습니다.']) assert.ok(text2.includes(want), `${want} ⊂ ${text2}`);
    assert.strictEqual((await req('POST', '/api/spell/scan', { name: file })).body.issues.length, 0, '고친 뒤 다시 검사하면 없다');
    // 쪽 위 편집기 검사 길·사용자 사전 길
    assert.deepStrictEqual((await req('POST', '/api/spell/check', { text: '됬다 됐다' })).body.issues.map((x) => x.word), ['됬다']);
    assert.strictEqual((await req('POST', '/api/spell/dict', { add: ['구지구지'] })).body.ok, true);
    assert.deepStrictEqual((await req('GET', '/api/spell/dict')).body.words, ['구지구지']);
    await req('POST', '/api/spell/dict', { remove: ['구지구지'] });
    assert.strictEqual((await req('GET', '/api/spell/status')).body.available, true);
    lap('문서 검사·고치기(한 곳·모두 = 실행 취소 한 번, 바뀐 자리 409, 서버 길) 통과');
  }

  // ── 5. 탭을 바꿔도 고치던 상태 유지(index.html 함수를 가짜 화면으로) ─────────────
  {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');
    const s = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
    const body = (sig) => { const k = s.indexOf(sig); assert.ok(k >= 0, sig); return s.slice(k, s.indexOf('\n}\n', k)) + '\n}'; };
    const src = ['function snapshotEditing(', 'async function parkInplace(', 'async function restoreParked(', 'function parkedDirty('].map(body).join('\n');
    const make = (ctx) => new Function('ctx', `with (ctx) { ${src}\n return { snapshotEditing, parkInplace, restoreParked, parkedDirty }; }`)(ctx);
    const log = [];
    const objs = [{ idx: 3 }, { idx: 4, partFrom: 2 }];
    const sel = { i: 1, objs, para: null, text: '됬다 글', shown: '됬다 글' };
    const st = { sel, committing: false, whenComposed: async () => log.push('composed'), text: () => '됐다 글!', dirty: () => true, lastSel: { from: 4, to: 4 },
      tx: { innerHTML: '<span style="font-size:13px">됐다 글!</span>' }, boxChanged: true, frame: { left: 1, top: 2, width: 300, fixed: true }, spell: { text: '됐다 글!', issues: [] } };
    const fields = { '#ppTracking': { value: '0.5' } };
    const ctx = { selectedObj: sel, inplace: st, cur: 'a.pdf', tabs: ['a.pdf', 'b.pdf'], tabViews: new Map(), docStamp: { u: 2, r: 0 }, pdfScale: 1.25, tool: 'edit',
      $: (q) => fields[q] || { value: '' }, setTimeout, renderFiles: () => {}, setTool: (t) => log.push('tool:' + t), flash: (m) => log.push('flash:' + m), updatePendMark: () => {} };
    let f = make(ctx);
    await f.parkInplace();
    const p = ctx.tabViews.get('a.pdf').pending;
    assert.deepStrictEqual({ i: p.i, idxs: p.idxs, kind: p.kind, text: p.text, dirty: p.dirty, caret: p.caret, html: p.restore.html, frame: p.restore.frame, tracking: p.tracking, stamp: p.stamp },
      { i: 1, idxs: ['3:0', '4:2'], kind: 'inplace', text: '됐다 글!', dirty: true, caret: { start: 4, end: 4 }, html: st.tx.innerHTML, frame: st.frame, tracking: '0.5', stamp: { u: 2, r: 0 } }, '떠날 때 기억하는 것');
    assert.ok(f.parkedDirty('a.pdf'), '탭에 적용하지 않은 글이 있다(✎)');
    // 돌아오기: 같은 객체의 상자를 찾아 같은 글·커서·DOM·폭으로 연다
    const box = { _line: { objs, text: '됬다 글' } };
    const back = (stamp, choice, found = true) => {
      const opened = [];
      const c2 = { ...ctx, cur: 'a.pdf', docStamp: stamp, selectedObj: null, inplace: null,
        $: (q) => (q === '#pdf' ? { children: { 1: { querySelectorAll: () => (found ? [box] : []) } } } : fields[q] || { value: '' }),
        lineSelection: (i, ln, wrap, b) => ({ i, line: ln, box: b }), openTextEditor: (...a) => opened.push(a), selectParagraph: (...a) => opened.push(['para', ...a]),
        askStale: async () => { log.push('ask'); return choice; }, copyPlainText: async (t) => log.push('copy:' + t) };
      return { run: () => make(c2).restoreParked('a.pdf', { pending: JSON.parse(JSON.stringify(p)) }), opened, c2 };
    };
    let b1 = back({ u: 2, r: 0 });
    log.length = 0; await b1.run();
    assert.deepStrictEqual(b1.opened.map((a) => [a[0], a[1], a[2].html, a[2].frame, a[2].boxChanged]), [['됐다 글!', { start: 4, end: 4 }, st.tx.innerHTML, st.frame, true]], '그대로 되살린다(글·커서·DOM·손잡이 폭)');
    assert.ok(!log.includes('ask'), '문서가 그대로면 묻지 않는다');
    // 그사이 실행 취소(스택 수가 다르다) → 묻는다: 되살리기 / 복사하고 버리기 / 버리기
    let b2 = back({ u: 1, r: 1 }, 'restore');
    log.length = 0; await b2.run();
    assert.ok(log.includes('ask') && b2.opened.length === 1, '문서가 바뀌었으면 묻고, [되살리기]면 연다');
    let b3 = back({ u: 1, r: 1 }, 'copy');
    log.length = 0; await b3.run();
    assert.deepStrictEqual([log.includes('copy:됐다 글!'), b3.opened.length], [true, 0], '[글을 복사하고 버리기]');
    let b4 = back({ u: 2, r: 0 }, null, false);
    log.length = 0; await b4.run();
    assert.deepStrictEqual([log.includes('ask'), b4.opened.length], [true, 0], '줄이 사라졌으면 묻고 열지 않는다');
    // 화면 배선
    const openFn = body('async function open(name');
    assert.ok(openFn.indexOf('await parkInplace()') < openFn.indexOf('stashView()') && openFn.includes('await restoreParked(name, view)'), 'open: 떠날 때 기억 → 돌아오면 되살리기');
    assert.match(s, /const tabDirty = \(p\) => \(p === cur \? [^\n]*parkedDirty\(p\)\);/, '다른 탭의 적용하지 않은 글도 고친 내용(창 닫기·탭 닫기)');
    assert.match(body('function renderTabs('), /class="pend" title="편집 중/, '탭의 ✎ 편집 중 표시');
    assert.match(body('async function removeFile('), /if \(!opts\.confirmed && cur !== p && parkedDirty\(p\)\) \{ await open\(p\); if \(cur !== p\) return; \}/, '그 탭을 닫으면 그 탭으로 가서 예전처럼 묻는다');
    assert.match(body('async function saveOtherTabs('), /if \(parkedDirty\(p\)\) \{ await open\(p\);[^\n]*await save\(\{ pending: 'apply' \}\)/, '창 닫기 → 저장은 그 탭의 글도 적용해 저장');
    for (const id of ['staleDialog', 'stRestore', 'stCopy', 'stDiscard', 'spellDialog', 'spList', 'spFix', 'spFixAll', 'spIgnore', 'spAdd', 'toolSelect', 'spellBtn']) assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
    assert.match(s, /CSS\.highlights\.set\(SPELL_HL, new Highlight\(/, '쪽 위 편집기 물결은 CSS Custom Highlight');
    assert.match(fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8'), /copyText: \(text\) => ipcRenderer\.invoke\('copyText', text\)/, 'preload.copyText');
    assert.match(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), /ipcMain\.handle\('copyText'[\s\S]{0,300}clipboard\.writeText\(/, 'main.js copyText → 클립보드');
    lap('탭 기억(고치던 글·커서·DOM·폭 되살리기 · 문서가 바뀌면 묻기 · 화면 배선) 통과');
  }

  await spell.shutdown();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} // 임시 홈·작업 폴더(서버가 문서를 쥐고 있으면 남는다)
  console.log(`OK — v6 Wave F 글자 선택·맞춤법 검사·탭 편집 상태 검사 통과 (${((Date.now() - T0) / 1000).toFixed(1)}초)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
