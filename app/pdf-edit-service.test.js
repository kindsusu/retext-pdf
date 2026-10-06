// Integration regression: node app/pdf-edit-service.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('./pdf-engine');
const { verifyEdits } = require('./pdf-edit-service');

process.env.RETEXTPDF_PORT = '4861';
const app = require('./server');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retext-pdf-edits-'));
  try {
    const port = await app.ready;
    const post = async (route, data) => {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
      return { status: response.status, ...(await response.json()) };
    };
    const get = async (route, name) => (await fetch(`http://127.0.0.1:${port}${route}?${new URLSearchParams({ name, i: 0 })}`)).json();
    const source = fs.readFileSync(path.join(__dirname, '..', 'workspace', 'sample.pdf'));
    const fixture = await open(source);
    for (let idx = 1; idx <= 3; idx++) {
      assert(fixture.setText(0, idx, ['','AAA','BBB','CCC'][idx]).ok);
      const object = fixture.objects(0)[idx];
      fixture.move(0, [idx], 60 + (idx - 1) * 40 - object.origin.x, 690 - object.origin.y);
      fixture._setFillColor(0, idx, [0, 0, 0, 0]);
    }
    const bytes = fixture.save(); fixture.close();
    for (const route of ['edits', 'fit']) {
      const name = path.join(dir, `${route}.pdf`);
      fs.writeFileSync(name, bytes);
      const payload = route === 'edits'
        ? { name, i: 0, edits: [{ idx: 2, text: ' ' }, { idx: 3, text: ' ' }, { idx: 1, text: 'REPLACED' }] }
        : { name, i: 0, idx: 1, text: 'REPLACED', maxWidth: 200, mode: 'wrap', blank: [2, 3] };
      const result = await post(`/api/pdf/${route}`, payload);
      assert.strictEqual(result.status, 200, JSON.stringify(result));
      assert.strictEqual(result.undoLeft, 1);
      const objects = await get('/api/pdf/objects', name);
      assert(objects.some((o) => o.text === 'Key points:'), 'unrelated object survives');
      assert(!objects.some((o) => o.text === 'CCC'), 'last fragment was cleared');
      assert.strictEqual(objects[result.lineIdxs[0]].text, 'REPLACED', 'returned index addresses replacement');
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert(undone.some((o) => o.text?.trim() === 'CCC'), 'one undo restores all fragments');
    }
    {
      const name = path.join(dir, 'group.pdf'); fs.writeFileSync(name, bytes);
      const r = await post('/api/pdf/fit', { name, i: 0, idx: 1, text: 'WHOLE', maxWidth: 200, mode: 'wrap', remove: [2, 3] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name);
      assert(!after.some((o) => ['BBB', 'CCC'].includes(o.text?.trim())));
      assert.strictEqual(after[r.lineIdxs[0]].text, 'WHOLE');
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert(undone.some((o) => o.text?.trim() === 'BBB') && undone.some((o) => o.text?.trim() === 'CCC'));
    }
    {
      const name = path.join(dir, 'failure.pdf'); fs.writeFileSync(name, source);
      const beforeObjects = await get('/api/pdf/objects', name), beforeInfo = await get('/api/pdf/info', name);
      const failed = await post('/api/pdf/fit', { name, i: 0, idx: 1, text: '\u{1f680}', maxWidth: 300, mode: 'wrap', blank: [2] });
      assert.notStrictEqual(failed.status, 200);
      assert.deepStrictEqual(await get('/api/pdf/objects', name), beforeObjects, 'failed edit leaves live document untouched');
      assert.deepStrictEqual(await get('/api/pdf/info', name), beforeInfo, 'failed edit leaves dirty and history untouched');
      assert(fs.readFileSync(name).equals(source), 'failed edit leaves file bytes untouched');
      const failedSingle = await post('/api/pdf/edit', { name, i: 0, idx: 1, text: '\u{1f680}' });
      assert.notStrictEqual(failedSingle.status, 200);
      assert.deepStrictEqual(await get('/api/pdf/info', name), beforeInfo, 'single edit also preserves history on failure');
    }
    {
      // edits + remove 함께: 투명 곁가지는 ' ' 편집, 보이는 곁가지는 remove — 한 번의 실행 취소
      const name = path.join(dir, 'mixed.pdf'); fs.writeFileSync(name, bytes);
      const r = await post('/api/pdf/edits', { name, i: 0, edits: [{ idx: 2, text: ' ' }, { idx: 1, text: 'MIXED' }], remove: [3] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name);
      assert.strictEqual(after[r.lineIdxs[0]].text, 'MIXED');
      assert(!after.some((o) => ['BBB', 'CCC'].includes(o.text?.trim())));
      assert.strictEqual(r.undoLeft, 1);
    }
    {
      // 기준 조각이 가장 높은 인덱스인 투명 글자 줄(180° 회전 쪽처럼 화면 순서와 인덱스가 거꾸로):
      // 곁가지를 나중에 드러내면 그 배경 덮개가 새 글자 위에 얹혀 글자가 안 보였다 → 기준 조각을 마지막에 처리
      const fx = await open(source);
      for (let idx = 1; idx <= 3; idx++) {
        assert(fx.setText(0, idx, ['', 'AAA', 'BBB', 'CCC'][idx]).ok);
        const object = fx.objects(0)[idx];
        fx.move(0, [idx], 60 + (3 - idx) * 40 - object.origin.x, 690 - object.origin.y);
        fx._setFillColor(0, idx, [0, 0, 0, 0]);
      }
      const name = path.join(dir, 'reversed.pdf'); fs.writeFileSync(name, fx.save()); fx.close();
      const r = await post('/api/pdf/edits', { name, i: 0, edits: [{ idx: 1, text: ' ' }, { idx: 2, text: ' ' }, { idx: 3, text: 'REPLACED TEXT' }] });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      const after = await get('/api/pdf/objects', name), p = r.lineIdxs[0], b = after[p].bounds;
      assert.strictEqual(after[p].text, 'REPLACED TEXT');
      const over = after.filter((o) => o.idx > p && o.type === 'path' && o.bounds.x0 < b.x1 && o.bounds.x1 > b.x0 && o.bounds.y0 < b.y1 && o.bounds.y1 > b.y0);
      assert.deepStrictEqual(over, [], 'no cover rect is painted above the edited text');
    }
    for (const [route, mode] of [['edits', 'right'], ['fit', 'center']]) {
      // 정렬도 같은 트랜잭션: 실행 취소 한 번, 반환한 lineIdxs가 옮겨진 최종 위치
      const name = path.join(dir, `align-${mode}.pdf`); fs.writeFileSync(name, source);
      const old = (await get('/api/pdf/objects', name))[1].bounds;
      const align = { mode, oldBounds: old };
      const r = await post(`/api/pdf/${route}`, route === 'edits'
        ? { name, i: 0, edits: [{ idx: 1, text: 'Short line' }], align }
        : { name, i: 0, idx: 1, text: 'Short line', maxWidth: 400, mode: 'wrap', align });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      assert.strictEqual(r.undoLeft, 1, 'edit + align is one undo step');
      const nb = (await get('/api/pdf/objects', name))[r.lineIdxs[0]].bounds;
      assert(nb.x0 > old.x0 + 40, `moved: ${JSON.stringify([old, nb])}`);
      if (mode === 'right') assert(Math.abs(nb.x1 - old.x1) < 0.5, JSON.stringify([old, nb]));
      else assert(Math.abs((nb.x0 + nb.x1) - (old.x0 + old.x1)) < 1, JSON.stringify([old, nb]));
    }
    {
      // 공백으로 비운 곁가지가 저장 뒤 'ÿ'로 읽히면 검사를 느슨하게 하지 않고 그 객체를 지운다(기준 조각 인덱스도 당긴다)
      const objs = [{ type: 'text', text: 'X' }, { type: 'text', text: 'ÿ' }, { type: 'text', text: 'NEW' }];
      const removed = [];
      const fake = { objects: () => objs, removeObject: (i, idx) => { removed.push(idx); objs.splice(idx, 1); return { ok: true }; } };
      const results = [{ idx: 1 }, { idx: 2 }];
      assert.strictEqual(verifyEdits(fake, 0, [{ idx: 1, text: ' ' }, { idx: 2, text: 'NEW' }], results, { primary: 2 }), 1);
      assert.deepStrictEqual(removed, [1]);
      assert.strictEqual(results[1].idx, 1, 'primary index shifts down');
      assert.strictEqual(results[0].removed, true);
      assert.throws(() => verifyEdits({ objects: () => [{ type: 'text', text: 'old' }] }, 0, [{ idx: 0, text: 'new' }], [{ idx: 0 }], { primary: 0 }), /그대로 저장하지 못합니다/, 'primary mismatch still fails');
    }
    {
      // 4.0.1 가리기 덮개: 같은 줄 여러 조각(한글 PDF는 글자마다 객체)을 한 번에 가리면 덮개(mask 객체)는 줄마다 1개,
      // 높이는 줄 높이로 균일(하이픈 자리도 숫자 자리와 같은 높이), 가린 글자는 텍스트에 0건, 실행 취소 한 번에 원상
      const notice = fs.readFileSync(path.join(__dirname, '..', 'workspace', '독서모임_안내.pdf'));
      const { groupLines } = require('./text-grouping');
      const partsFor = (line, sub) => {
        const from = line.text.indexOf(sub), to = from + sub.length; let off = 0; const parts = [];
        line.objs.forEach((o, j) => {
          const s = off, e = off + o.text.length; off = e + (line.seps[j] || '').length;
          const a = Math.max(from, s), b = Math.min(to, e);
          if (a < b) parts.push({ idx: o.idx, from: a - s, to: b - s });
        });
        return parts;
      };
      const masks = (objs) => objs.filter((o) => o.mask);
      const name = path.join(dir, 'notice.pdf'); fs.writeFileSync(name, notice);
      const before = await get('/api/pdf/objects', name);
      const ask = groupLines(before).find((l) => l.text.startsWith('문의:'));
      const phone = partsFor(ask, '010-1234-5678');
      assert(phone.length >= 13, `연락처는 여러 조각(${phone.length})`);
      const r = await post('/api/pdf/mask', { name, i: 0, parts: phone });
      assert.strictEqual(r.status, 200, JSON.stringify(r));
      assert.deepStrictEqual([r.ok, r.rects.length, r.skipped.length, r.undoLeft], [true, 1, 0, 1], JSON.stringify(r));
      const after = await get('/api/pdf/objects', name), added = masks(after);
      assert.strictEqual(added.length, 1, '같은 줄 13조각 → 덮개 1개');
      const cover = added[0].bounds, em = ask.objs[0].size * ask.objs[0].matrix[3], base = ask.objs[0].origin.y;
      assert(cover.y0 <= base - 0.25 * em + 0.01 && cover.y1 >= base + 0.85 * em - 0.01, `줄 높이(기준선 −0.25em ~ +0.85em 이상): ${JSON.stringify(cover)}`);
      const dash = ask.objs.find((o) => o.text === '-').bounds, digit = ask.objs.find((o) => o.text === '0').bounds;
      assert(cover.y0 < dash.y0 - 2 && cover.y1 > dash.y1 + 4 && cover.y0 < digit.y0 && cover.y1 > digit.y1, '하이픈 자리도 숫자 자리와 같은 높이로 덮인다');
      const last = ask.objs.find((o) => o.text === '8').bounds;
      assert(cover.x0 <= digit.x0 && cover.x1 >= last.x1, '가로는 첫 글자 왼쪽 ~ 마지막 글자 오른쪽(사이 틈 포함)');
      for (const k of ['010', '1234', '5678']) assert(!r.textLeft.includes(k), `가린 글자 텍스트 0건: ${k}`);
      assert(r.textLeft.includes('문의: 모임지기'), '앞부분은 남는다');
      // 같은 줄을 따로 한 번 더 가려도(남은 한글) 높이가 같다 — 줄 높이는 같은 줄 글자 전체 기준
      const ask2 = groupLines(after).find((l) => l.text.startsWith('문의:'));
      const r2 = await post('/api/pdf/mask', { name, i: 0, parts: partsFor(ask2, '모임지기'), color: 'auto' });
      assert.deepStrictEqual([r2.ok, r2.rects.length], [true, 1], JSON.stringify(r2));
      assert(Math.abs((r2.rects[0].y1 - r2.rects[0].y0) - (cover.y1 - cover.y0)) < 0.01, '같은 줄의 두 번째 덮개도 같은 높이');
      const autoMask = masks(await get('/api/pdf/objects', name)).at(-1);
      assert(autoMask.color.slice(0, 3).every((v) => v >= 250), `'auto'는 배경색(흰색): ${autoMask.color}`);
      // 실행 취소 한 번 = 가리기 한 번
      await post('/api/pdf/undo', { name });
      await post('/api/pdf/undo', { name });
      const undone = await get('/api/pdf/objects', name);
      assert.strictEqual(masks(undone).length, 0, '두 번 되돌리면 덮개 0개');
      assert((await get('/api/pdf/text', name)).text.includes('010-1234-5678'), '되돌리면 연락처 글자가 돌아온다');
      // 여러 줄(장소·문의 줄 전체)을 한 요청으로 가리면 줄마다 1개
      const lines = groupLines(undone).filter((l) => l.text.startsWith('장소:') || l.text.startsWith('문의:'));
      const both = lines.flatMap((l) => l.objs.filter((o) => o.text.length).map((o) => ({ idx: o.idx, from: 0, to: o.text.length })));
      const r3 = await post('/api/pdf/mask', { name, i: 0, parts: both });
      assert.deepStrictEqual([r3.ok, r3.rects.length, r3.undoLeft], [true, 2, 1], JSON.stringify(r3));
      const [h1, h2] = r3.rects.map((b) => b.y1 - b.y0);
      assert(r3.rects[0].y0 > r3.rects[1].y1 || r3.rects[1].y0 > r3.rects[0].y1, '두 줄의 덮개는 겹치지 않는다');
      assert(Math.abs(h1 - h2) < 0.5, `같은 글자 크기의 두 줄은 높이가 거의 같다: ${h1} / ${h2}`);
      const left = (await get('/api/pdf/text', name)).text;
      assert(!left.includes('동네') && !left.includes('010'), '두 줄의 글자 모두 제거');
      console.log(`mask covers: OK — 연락처 ${phone.length}조각 → 덮개 1개(높이 ${(cover.y1 - cover.y0).toFixed(2)}pt), 두 줄 → 2개`);
    }
    console.log('pdf edit transaction: OK');
  } finally {
    const absolute = path.resolve(dir), root = path.resolve(os.tmpdir()) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('test cleanup outside temporary directory');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
