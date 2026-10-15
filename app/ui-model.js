// v6 Wave C 화면 모델의 순수 계산 — DOM·서버를 만지지 않는다. 화면(window.uiModel)과 Node 시험(ui-wiring.test.js)이 같이 쓴다.
//   · 문서 탭: 순서·고른 탭·열기(최대 개수)·닫은 뒤 옮겨 갈 탭·끌어 옮기기·한꺼번에 닫을 탭·Ctrl+Tab 순환
//   · 명령 검색(Ctrl+Q): 한글 이름·별칭·초성(ㅇㅎ → 암호)·영문으로 리본 명령을 찾는다
//   · 보기 방식: 쪽 두 개씩(표지 따로)·한 쪽씩 넘기기의 줄 나누기, 쪽 이동 단계, 맞춤 배율
//   · 테마: 밝게·어둡게·시스템 따라가기 → 실제 테마
(function () {
  // ---- 문서 탭 ----
  const MAX_TABS = 20;
  // 탭 열기: 이미 열려 있으면 그 탭으로만 간다. 가득 찼으면 열지 않는다(고친 내용이 있을지 모르는 탭을 몰래 닫지 않는다)
  function tabOpen(state, path, max = MAX_TABS) {
    if (state.order.includes(path)) return { order: state.order.slice(), active: path, created: false, full: false };
    if (state.order.length >= max) return { order: state.order.slice(), active: state.active, created: false, full: true };
    return { order: [...state.order, path], active: path, created: true, full: false };
  }
  // 탭 닫기: 고른 탭을 닫으면 오른쪽 이웃(없으면 왼쪽 이웃)으로 간다. 다른 탭을 닫으면 고른 탭은 그대로
  function tabClose(state, path) {
    const k = state.order.indexOf(path);
    if (k < 0) return { order: state.order.slice(), active: state.active };
    const order = state.order.filter((p) => p !== path);
    if (state.active !== path) return { order, active: state.active };
    return { order, active: order.length ? order[Math.min(k, order.length - 1)] : null };
  }
  // 끌어 옮기기: from 자리의 탭을 to 자리(옮긴 뒤 기준 인덱스)로
  function tabMove(order, from, to) {
    const out = order.slice();
    if (from < 0 || from >= out.length) return out;
    const [p] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(out.length, to)), 0, p);
    return out;
  }
  // 끌어 놓는 자리: 대상 탭의 왼쪽 절반이면 그 앞, 오른쪽 절반이면 그 뒤 → 옮긴 뒤 기준 인덱스
  function dropIndex(from, target, after) {
    let to = target + (after ? 1 : 0);
    if (from < to) to--;
    return to;
  }
  // 한꺼번에 닫을 탭: 'one' 그 탭 · 'others' 그 탭 말고 모두 · 'right' 그 탭 오른쪽 · 'all' 모두.
  // 고른 탭(active)은 맨 끝에 둔다 — 다른 탭을 먼저 닫아야 닫힐 탭으로 옮겨 갔다가 다시 닫는 일이 없다
  function tabsToClose(state, kind, path) {
    const k = state.order.indexOf(path);
    let list = kind === 'one' ? [path] : kind === 'others' ? state.order.filter((p) => p !== path)
      : kind === 'right' ? (k < 0 ? [] : state.order.slice(k + 1)) : state.order.slice();
    list = list.filter((p) => state.order.includes(p));
    return [...list.filter((p) => p !== state.active), ...list.filter((p) => p === state.active)];
  }
  // Ctrl+Tab(앞으로)·Ctrl+Shift+Tab(뒤로): 끝에서 처음으로 돈다
  function tabCycle(state, dir) {
    const n = state.order.length;
    if (!n) return null;
    const k = state.order.indexOf(state.active);
    return state.order[(((k < 0 ? 0 : k + dir) % n) + n) % n];
  }
  // 미저장 탭 목록(닫기 확인 창에 이름을 늘어놓는다)
  const dirtyOf = (paths, isDirty) => paths.filter((p) => !!isDirty(p));

  // ---- 명령 검색 ----
  const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
  const isSyllable = (c) => c >= '가' && c <= '힣';
  const isJamo = (c) => c >= 'ㄱ' && c <= 'ㅎ';
  const choOf = (c) => (isSyllable(c) ? CHO[Math.floor((c.charCodeAt(0) - 0xac00) / 588)] : c);
  // 글의 초성: '암호 걸기' → 'ㅇㅎㄱㄱ'(공백·기호는 빼고, 한글이 아닌 글자는 그대로)
  const choseong = (s) => [...norm(s)].map(choOf).join('');
  // 비교용: 소문자, 공백·기호(·…:()/-) 제거
  function norm(s) { return String(s ?? '').toLowerCase().replace(/[\s·…:()[\]/\-_,.'"!?]+/g, ''); }
  // 글자 하나 비교: 같거나, 찾는 글자가 초성(ㅇ)이면 그 초성으로 시작하는 음절(암)과 맞는다.
  // 조합 중인 마지막 음절(받침 없는 '아')은 받침이 붙은 '암'의 앞부분과도 맞는다
  function charEq(q, t, last) {
    if (q === t) return true;
    if (isJamo(q)) return choOf(t) === q;
    if (last && isSyllable(q) && isSyllable(t)) {
      const qi = q.charCodeAt(0) - 0xac00, ti = t.charCodeAt(0) - 0xac00;
      return qi % 28 === 0 && Math.floor(qi / 28) === Math.floor(ti / 28);
    }
    return false;
  }
  // q가 t의 어디서 나오는가(연속): 처음 자리, 없으면 -1
  function findSeq(q, t) {
    const Q = [...q], T = [...t];
    for (let s = 0; s + Q.length <= T.length; s++) {
      let ok = true;
      for (let j = 0; j < Q.length && ok; j++) ok = charEq(Q[j], T[s + j], j === Q.length - 1);
      if (ok) return s;
    }
    return -1;
  }
  // 띄엄띄엄(순서만 맞게) 나오는가: '쪽정' → '쪽 정리'
  function isSubseq(q, t) {
    const Q = [...q], T = [...t];
    let j = 0;
    for (let s = 0; s < T.length && j < Q.length; s++) if (charEq(Q[j], T[s], j === Q.length - 1)) j++;
    return j === Q.length;
  }
  // 한 글에 대한 점수: 같다 100 · 앞에서 일치 80 · 안에서 일치 60 · 띄엄띄엄 30 · 없음 0
  function fieldScore(q, text) {
    const t = norm(text);
    if (!t) return 0;
    if (t === q) return 100;
    const k = findSeq(q, t);
    if (k === 0) return 80;
    if (k > 0) return 60;
    return q.length >= 2 && isSubseq(q, t) ? 30 : 0;
  }
  // 명령 하나의 점수: 이름 > 별칭 > 설명·묶음. 이름이 맞으면 별칭보다 앞에 온다
  function commandScore(query, cmd) {
    const q = norm(query);
    if (!q) return 0;
    let best = fieldScore(q, cmd.label) * 1.0;
    for (const a of cmd.aliases || []) best = Math.max(best, fieldScore(q, a) * 0.9);
    best = Math.max(best, fieldScore(q, cmd.tip) * 0.6, fieldScore(q, cmd.group) * 0.5);
    return Math.round(best);
  }
  // 찾기: 점수 순(같으면 쓸 수 있는 것 먼저, 그다음 원래 순서). 빈 검색어면 쓸 수 있는 명령을 원래 순서로
  function searchCommands(query, cmds, limit = 8) {
    const q = norm(query);
    const rows = cmds.map((c, k) => ({ c, k, s: q ? commandScore(q, c) : 1 })).filter((r) => r.s > 0);
    rows.sort((a, b) => b.s - a.s || (a.c.disabled ? 1 : 0) - (b.c.disabled ? 1 : 0) || a.k - b.k);
    return rows.slice(0, limit).map((r) => r.c);
  }

  // ---- 보기 방식 ----
  // 쪽 두 개씩 보기의 줄: 표지 따로(cover)면 1쪽 혼자, 그다음 2-3, 4-5 … / 아니면 1-2, 3-4 …(0-기준 인덱스)
  function spreadRows(n, cover) {
    const rows = [];
    let i = 0;
    if (cover && n > 0) { rows.push([0]); i = 1; }
    for (; i < n; i += 2) rows.push(i + 1 < n ? [i, i + 1] : [i]);
    return rows;
  }
  const rowOf = (i, n, cover) => spreadRows(n, cover).findIndex((r) => r.includes(i));
  // 쪽 이동(PageUp/PageDown·한 쪽씩 넘기기): 두 개씩이면 줄 단위로 움직이고 그 줄의 첫 쪽을 돌려준다
  function stepPage(i, dir, n, layout = {}) {
    if (n <= 0) return 0;
    i = Math.max(0, Math.min(n - 1, i));
    if (!layout.spread) return Math.max(0, Math.min(n - 1, i + dir));
    const rows = spreadRows(n, layout.cover), r = rows.findIndex((x) => x.includes(i));
    return rows[Math.max(0, Math.min(rows.length - 1, r + dir))][0];
  }
  // 그 쪽과 함께 보이는 쪽들(한 쪽씩 넘기기에서 보일 쪽)
  function visiblePages(i, n, layout = {}) {
    if (n <= 0) return [];
    i = Math.max(0, Math.min(n - 1, i));
    if (!layout.spread) return [i];
    return spreadRows(n, layout.cover).find((r) => r.includes(i)) || [i];
  }
  // 맞춤 배율: fitWidth = 가장 넓은 쪽(두 개씩이면 두 칸 + 사이)이 폭에 맞게, fitPage = idx쪽(두 개씩이면 그 줄)이 통째로 보이게.
  // 두 개씩 보기는 두 칸 격자라 칸 폭이 같은 열의 가장 넓은 쪽을 따른다 → 줄 폭 = 2 × 넓은 쪽 + 사이로 잰다. 소수 둘째 자리에서 내린다
  function fitScale({ mode, viewW, viewH, pages, idx = 0, layout = {}, gap = 12, min = 0.25, max = 4 }) {
    if (!(viewW > 0 && viewH > 0) || !pages || !pages.length) return null;
    const n = pages.length, k = Math.max(0, Math.min(n - 1, idx));
    let s;
    if (!layout.spread) {
      const p = pages[k];
      s = mode === 'fitWidth' ? viewW / Math.max(...pages.map((q) => q.w)) : Math.min(viewW / p.w, viewH / p.h);
    } else if (mode === 'fitWidth') {
      s = viewW / (2 * Math.max(...pages.map((q) => q.w)) + gap);
    } else {
      const row = visiblePages(k, n, layout).map((j) => pages[j]);
      s = Math.min(viewW / (2 * Math.max(...row.map((q) => q.w)) + gap), viewH / Math.max(...row.map((q) => q.h)));
    }
    return Math.max(min, Math.min(max, Math.floor(s * 100) / 100));
  }

  // ---- 최근 파일의 "마지막으로 연 때" ----
  // 오늘 14:32 · 어제 09:05 · 3일 전 · 2026. 9. 1.
  function whenText(ts, now = Date.now()) {
    if (!ts) return '';
    const d = new Date(ts), n = new Date(now);
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(n) - day(d)) / 86400000);
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (diff <= 0) return `오늘 ${hm}`;
    if (diff === 1) return `어제 ${hm}`;
    if (diff < 7) return `${diff}일 전`;
    return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  }

  // ---- 테마 ----
  const THEMES = ['light', 'dark', 'system'];
  const resolveTheme = (pref, systemDark) => (pref === 'dark' || (pref === 'system' && systemDark) ? 'dark' : 'light');

  // ---- v6 Wave E2: 스캔한 쪽 알아보기(글자 인식 권하기 · 일괄 OCR이 글자 있는 쪽을 건너뛰기) ----
  // objs = 엔진 objects(i), page = { w, h }(쪽 크기 pt). 글자(보이는 것·투명한 것 모두)가 거의 없고(공백 빼고 20자 미만)
  // 가장 큰 그림이 쪽의 절반 이상을 덮으면 스캔한 쪽 → { scanned, chars, imageCover(0~1) }. OCR을 한 쪽은 글자가 생겨 더는 스캔한 쪽이 아니다
  const SCAN_MAX_CHARS = 20, SCAN_MIN_COVER = 0.5;
  function scanPageInfo(objs, page) {
    const list = Array.isArray(objs) ? objs : [];
    const chars = list.filter((o) => o && o.type === 'text').reduce((n, o) => n + String(o.text || '').replace(/\s/g, '').length, 0);
    const area = Math.max(1, (Number(page?.w) || 0) * (Number(page?.h) || 0));
    let cover = 0;
    for (const o of list) {
      if (!o || o.type !== 'image' || !o.bounds) continue;
      const b = o.bounds, a = Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
      cover = Math.max(cover, Math.min(1, a / area));
    }
    return { scanned: chars < SCAN_MAX_CHARS && cover >= SCAN_MIN_COVER, chars, imageCover: Math.round(cover * 1000) / 1000 };
  }

  const api = {
    scanPageInfo,
    MAX_TABS, tabOpen, tabClose, tabMove, dropIndex, tabsToClose, tabCycle, dirtyOf,
    choseong, norm, commandScore, searchCommands,
    spreadRows, rowOf, stepPage, visiblePages, fitScale,
    whenText, THEMES, resolveTheme,
  };
  if (typeof window !== 'undefined') window.uiModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
