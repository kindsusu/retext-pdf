// 2단계 편집(조각별 모양 보존 · 문단 다시 흘리기)의 순수 계산 — PDF를 만지지 않는다. 실행은 pdf-edit-service.editRuns가 엔진으로 한다.
//
// 줄 하나(또는 문단의 여러 줄)는 "조각(item)" — PDF 텍스트 객체 하나(또는 15d처럼 객체 안의 한 부분) — 들의 줄이다.
// 조각마다 글꼴·크기·색이 있고(굵게·기울임·색 글자·코드 글꼴), 그 모양을 지키려면 고친 글자만 그 조각에서 고쳐 써야 한다.
//   ① diffChars: 옛 글 → 새 글의 글자 차이(LCS)를 덩어리 [{ a, b, ins }]로(옛 글 [a,b)를 지우고 a 자리에 ins)
//   ② planRuns: 덩어리를 조각에 배정 → 조각마다 새 글, 조각 사이(seps)·줄 사이(soft) 지움 여부, 새로 넣은 줄바꿈(hard)
//      끼워 넣은 글은 그 자리 조각의 모양을 받는다: 바꾼 글(선택해서 덮어쓴 글)은 지워진 첫 글자의 조각,
//      순수 삽입은 왼쪽 글자의 조각(조각 경계에서도 왼쪽), 왼쪽이 조각 글자가 아니면(줄 첫머리·사이 공백 뒤) 오른쪽 조각
//   ③ breakAtoms: 글자 폭으로 줄을 나눈다(공백 뒤·조각 사이 공백·옛 줄 경계에서 끊고, 한 낱말이 폭보다 길면 글자 단위로)
// 사이 글(seps)은 PDF 글자가 아니다('' · ' ' · ■ — 가린 자리). 위치는 옛 틈(gap, pt)으로 지킨다.

const SHY = '­';
// 같은 글자 이만큼 이하(공백 없음)로만 떨어진 차이 덩어리는 하나로 합친다 — "굵은"→"굵다란"처럼 낱말 하나를 바꿨는데
// 우연히 같은 글자 하나 때문에 덩어리가 쪼개져 엉뚱한 조각에 글자가 배정되지 않게
const HUNK_MERGE_GAP = 2;
// LCS 표 크기 상한(글자 수 곱) — 넘으면 앞뒤 같은 부분만 빼고 가운데를 한 덩어리로 바꾼다
const LCS_MAX_CELLS = 4e6;

function diffChars(old, neu) {
  let p = 0;
  while (p < old.length && p < neu.length && old[p] === neu[p]) p++;
  let s = 0;
  while (s < old.length - p && s < neu.length - p && old[old.length - 1 - s] === neu[neu.length - 1 - s]) s++;
  const A = old.slice(p, old.length - s), B = neu.slice(p, neu.length - s);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > LCS_MAX_CELLS) return [{ a: p, b: old.length - s, ins: B }];
  const n = A.length, m = B.length, W = m + 1, dp = new Uint32Array((n + 1) * W); // dp[i][j] = A[i..]·B[j..]의 LCS 길이
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  }
  const hunks = [];
  let i = 0, j = 0, cur = null;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { if (cur) { hunks.push(cur); cur = null; } i++; j++; continue; }
    if (!cur) cur = { a: p + i, b: p + i, ins: '' };
    // 지우기를 먼저(같은 값이면) — 바꾼 글이 지운 글자 자리에 들어가 그 조각의 모양을 받는다
    if (i < n && (j >= m || dp[(i + 1) * W + j] >= dp[i * W + j + 1])) { i++; cur.b = p + i; } else { cur.ins += B[j]; j++; }
  }
  if (cur) hunks.push(cur);
  const out = [];
  for (const h of hunks) {
    const last = out[out.length - 1];
    const between = last ? old.slice(last.b, h.a) : null;
    if (last && between.length <= HUNK_MERGE_GAP && !/\s/.test(between)) { last.ins += between + h.ins; last.b = h.b; }
    else out.push({ ...h });
  }
  return out;
}

// 차이 덩어리를 낱말 끝까지 넓힌다 — 단, 같은 모양(style)의 글자까지만(조각 경계는 넘지 않는다).
// "npm test"→"npm run lint"가 LCS로는 "test"→"run lin" + 남은 "t"가 되어, 끝 글자 하나만 원래 글꼴로 남고 나머지는 대체 글꼴이 되던 것을 막는다.
// 한글처럼 한 낱말 안에서 굵기가 바뀌는 곳("글씨"(굵게)+"와")은 넓히지 않는다 — "와"만 고치면 "와" 조각에서만 고친다
// disp·neu: 옛·새 표시 글, styleAt(d): 옛 글 d번째 글자의 모양 열쇠(조각 글자가 아니면 null)
function snapWords(hunks, disp, neu, styleAt) {
  const wordCh = (d) => d >= 0 && d < disp.length && !/\s/.test(disp[d]) && styleAt(d) != null;
  let delta = 0;
  const wide = hunks.map((h) => {
    const nA = h.a + delta; delta += h.ins.length - (h.b - h.a);
    const left = h.b > h.a ? styleAt(h.a) : styleAt(h.a - 1) ?? styleAt(h.a);
    const right = h.b > h.a ? styleAt(h.b - 1) : styleAt(h.a - 1) ?? styleAt(h.a);
    let a = h.a, b = h.b;
    if (left != null) while (wordCh(a - 1) && styleAt(a - 1) === left) a--;
    if (right != null) while (wordCh(b) && styleAt(b) === right) b++;
    return { a, b, nA: nA - (h.a - a), nB: nA + h.ins.length + (b - h.b) };
  });
  const out = [];
  for (const h of wide) {
    const last = out[out.length - 1];
    if (last && h.a <= last.b) { if (h.b >= last.b) { last.b = h.b; last.nB = h.nB; } }
    else out.push({ ...h });
  }
  return out.map((h) => ({ a: h.a, b: h.b, ins: neu.slice(h.nA, h.nB) }));
}

// lines: [{ items: [{ text, style? }], seps: [string](items 사이, items.length − 1개) }] — 문단이면 줄 사이는 '\n'(soft)
//   style: 조각 모양 열쇠(글꼴·크기·색) — 차이 덩어리를 낱말 끝까지 넓힐 때 이 값이 같은 글자까지만 넓힌다(없으면 조각마다 다르다고 본다)
// newText: 편집 창 글(소프트 하이픈을 뺀 표시 글 기준)
// 반환: { oldRaw, texts: [[조각마다 새 글(삽입한 '\n' 포함)]], stream: [요소], firstChanged, lastChanged, changed }
//   요소: { t:'piece', line, j, text, orig } · { t:'sep', line, j, value, deleted } · { t:'soft', line, deleted } · { t:'hard' }
//   orig: 조각 글이 옛 글 그대로이고 나뉘지 않았다(객체를 고쳐 쓰지 않고 옮기기만 하면 된다)
function planRuns(lines, newText) {
  const owners = []; // 옛 글 위치마다 { t:'ch', line, j, k } | { t:'sep', line, j } | { t:'soft', line }
  let raw = '';
  lines.forEach((L, li) => {
    if (li) { owners.push({ t: 'soft', line: li - 1 }); raw += '\n'; }
    L.items.forEach((it, j) => {
      if (j) { const sep = L.seps[j - 1] || ''; for (let q = 0; q < sep.length; q++) owners.push({ t: 'sep', line: li, j: j - 1 }); raw += sep; }
      for (let k = 0; k < it.text.length; k++) owners.push({ t: 'ch', line: li, j, k });
      raw += it.text;
    });
  });
  // 표시 글(소프트 하이픈 뺀 것) 위치 → 옛 글 위치
  const d2r = [];
  for (let r = 0; r < raw.length; r++) if (raw[r] !== SHY) d2r.push(r);
  d2r.push(raw.length);
  const disp = raw.replace(/­/g, ''), neu = String(newText ?? '');
  const styleAt = (d) => { const o = owners[d2r[d]]; return o && o.t === 'ch' ? (lines[o.line].items[o.j].style ?? `${o.line}:${o.j}`) : null; };
  const hunks = snapWords(diffChars(disp, neu), disp, neu, styleAt)
    .map((h) => ({ a: d2r[h.a], b: h.b >= disp.length ? raw.length : d2r[h.b], ins: h.ins }));
  const del = new Uint8Array(raw.length);
  for (const h of hunks) for (let r = h.a; r < h.b; r++) del[r] = 1;
  // 끼워 넣을 조각 고르기
  const chAt = (r) => (r >= 0 && r < owners.length && owners[r].t === 'ch' ? owners[r] : null);
  const ownerFor = (h) => {
    if (h.b > h.a && chAt(h.a)) return { ...chAt(h.a), at: chAt(h.a).k }; // 덮어쓴 글: 지운 첫 글자의 조각, 그 글자 앞
    const L = chAt(h.a - 1);
    if (L) return { ...L, at: L.k + 1 };                                  // 왼쪽 글자 뒤
    const R = chAt(h.b);
    if (R) return { ...R, at: R.k };                                      // 줄 첫머리·사이 공백 뒤 → 오른쪽 글자 앞
    for (let r = h.a - 1; r >= 0; r--) if (chAt(r)) return { ...chAt(r), at: chAt(r).k + 1 };
    for (let r = h.b; r < owners.length; r++) if (chAt(r)) return { ...chAt(r), at: chAt(r).k };
    return null;
  };
  const inserts = lines.map((L) => L.items.map((it) => Array.from({ length: it.text.length + 1 }, () => '')));
  for (const h of hunks) {
    if (!h.ins) continue;
    const o = ownerFor(h);
    if (!o) throw new Error('고칠 글자 자리를 찾지 못했습니다.');
    inserts[o.line][o.j][o.at] += h.ins;
  }
  // 조각마다 새 글 + 흐름(stream)
  let pos = 0, firstChanged = Infinity, lastChanged = -1;
  const mark = (li) => { firstChanged = Math.min(firstChanged, li); lastChanged = Math.max(lastChanged, li); };
  const texts = [], stream = [];
  lines.forEach((L, li) => {
    if (li) {
      const deleted = !!del[pos]; pos++;
      if (deleted) { mark(li - 1); mark(li); }
      stream.push({ t: 'soft', line: li - 1, deleted });
    }
    texts.push(L.items.map((it, j) => {
      if (j) {
        const value = L.seps[j - 1] || '';
        let deleted = false;
        for (let q = 0; q < value.length; q++, pos++) if (del[pos]) deleted = true;
        if (deleted) mark(li);
        stream.push({ t: 'sep', line: li, j: j - 1, value, deleted });
      }
      let s = '';
      for (let k = 0; k < it.text.length; k++, pos++) { s += inserts[li][j][k]; if (!del[pos]) s += it.text[k]; }
      s += inserts[li][j][it.text.length];
      if (s !== it.text) mark(li);
      const parts = s.split(/\r?\n/);
      parts.forEach((t, q) => {
        if (q) stream.push({ t: 'hard', line: li });
        if (t) stream.push({ t: 'piece', line: li, j, text: t, orig: parts.length === 1 && t === it.text });
      });
      return s;
    }));
  });
  return { oldRaw: raw, texts, stream, hunks, firstChanged: Number.isFinite(firstChanged) ? firstChanged : -1, lastChanged, changed: hunks.length > 0 };
}

// 줄 나누기. atoms: { t:'c', w, ws } (글자) | { t:'g', w, brk } (조각 사이 틈·옛 줄 경계 — 줄 머리·끝에서는 폭 0) | { t:'h' } (강제 줄바꿈)
// widthOf(n): n번째 출력 줄의 쓸 수 있는 폭(Infinity면 강제 줄바꿈에서만 나눈다)
// stopAt(start, n): n번째 줄을 atoms[start]에서 시작하려 할 때 true면 거기서 멈춘다(나머지는 옛 줄 그대로 — 뒤쪽 안정화)
// 반환: { lines: [[start, end)], rest: 멈춘 atom 위치(끝까지 갔으면 atoms.length) }
//   공백 글자 뒤·끊을 수 있는 틈에서 끊는다(공백은 앞 줄 끝에 남는다). 끊을 데가 없으면 넘치는 글자 앞에서(글자 단위). 한 줄에 글자 하나는 꼭 둔다
function breakAtoms(atoms, widthOf, stopAt = () => false) {
  const lines = [];
  let start = 0;
  const EPS = 0.01;
  while (start < atoms.length) {
    if (lines.length && stopAt(start, lines.length)) return { lines, rest: start };
    const max = widthOf(lines.length);
    let w = 0, lastBreak = -1, k = start, seenInk = false, end = -1;
    for (; k < atoms.length; k++) {
      const a = atoms[k];
      if (a.t === 'h') { end = k; break; }
      if (a.t === 'g') { if (seenInk) w += a.w; if (a.brk && seenInk) lastBreak = k; continue; }
      w += a.w;
      if (!a.ws) {
        if (seenInk && w > max + EPS) { end = lastBreak >= start ? lastBreak + 1 : k; break; }
        seenInk = true;
      } else if (seenInk) lastBreak = k;
    }
    if (end < 0) end = atoms.length;
    lines.push([start, end]);
    start = end < atoms.length && atoms[end].t === 'h' ? end + 1 : end;
    if (end === atoms.length) break;
  }
  return { lines, rest: atoms.length };
}

const api = { diffChars, planRuns, breakAtoms };
if (typeof module !== 'undefined') module.exports = api;
