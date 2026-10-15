// 쪽 범위 해석기 — 서버(워터마크·머리말·개인정보 찾기·영역 가리기·이미지 PDF)와 화면이 같이 쓴다.
// 화면은 /page-range.js로 읽어 window.parsePageRange를, Node는 require('./page-range')를 쓴다.
//   parsePageRange(spec, pageCount) → 0 기준 쪽 번호 배열(오름차순·중복 없음). 잘못되면 던진다(e.code = 'BAD_RANGE')
// 입력은 사람이 보는 1 기준 번호다:
//   ''·'all'·'전체'·생략 → 모든 쪽 / 'odd'·'홀수' / 'even'·'짝수' / '1,3,5-7' / '-3'(1~3쪽) / '5-'(5쪽~끝)
//   쉼표·공백으로 여러 조각을 잇는다. 물결(~)·전각 하이픈·'쪽'도 받아 준다('3~5쪽').
// 범위를 벗어나거나(0쪽, 쪽 수보다 큰 번호) 거꾸로 된 범위(7-5)는 조용히 잘라 내지 않고 오류로 알린다 — 잘못 친 범위로 엉뚱한 쪽을 가리지 않게
(function (root) {
  function rangeError(message) {
    const e = new Error(message);
    e.code = 'BAD_RANGE';
    return e;
  }

  function parsePageRange(spec, pageCount) {
    const count = Number(pageCount);
    if (!Number.isInteger(count) || count < 1) throw rangeError('문서에 쪽이 없습니다.');
    const all = () => Array.from({ length: count }, (_, i) => i);
    if (Array.isArray(spec)) { // 이미 0 기준 번호 배열로 받은 경우(서버 내부 호출): 검사만 한다
      const out = new Set();
      for (const n of spec) {
        if (!Number.isInteger(n) || n < 0 || n >= count) throw rangeError(`쪽 번호가 범위를 벗어났습니다: ${n + 1}쪽 (1~${count}쪽)`);
        out.add(n);
      }
      if (!out.size) throw rangeError('쪽을 하나 이상 고르세요.');
      return [...out].sort((a, b) => a - b);
    }
    const text = String(spec == null ? '' : spec)
      .replace(/[‐-―−－~〜～]/g, '-') // 여러 가지 하이픈·물결 → '-'
      .replace(/쪽|페이지|p\./gi, '')
      .replace(/\s*-\s*/g, '-') // '5 - 7'도 한 조각
      .trim().toLowerCase();
    if (!text || text === 'all' || text === '전체' || text === '모두') return all();
    if (text === 'odd' || text === '홀수') return all().filter((i) => i % 2 === 0);
    if (text === 'even' || text === '짝수') return all().filter((i) => i % 2 === 1);
    const out = new Set();
    for (const raw of text.split(/[,\s]+/).filter(Boolean)) {
      const m = /^(\d*)\s*(-?)\s*(\d*)$/.exec(raw);
      if (!m || (!m[1] && !m[3])) throw rangeError(`쪽 범위를 읽을 수 없습니다: '${raw}' (예: 1,3,5-7 · -3 · 5- · 홀수 · 짝수)`);
      const dash = m[2] === '-';
      if (!dash && m[3]) throw rangeError(`쪽 범위를 읽을 수 없습니다: '${raw}'`);
      const a = m[1] ? Number(m[1]) : 1;
      const b = dash ? (m[3] ? Number(m[3]) : count) : a;
      for (const n of [a, b]) {
        if (n < 1 || n > count) throw rangeError(`쪽 번호가 범위를 벗어났습니다: ${n}쪽 (1~${count}쪽)`);
      }
      if (a > b) throw rangeError(`쪽 범위가 거꾸로입니다: ${a}-${b}`);
      for (let n = a; n <= b; n++) out.add(n - 1);
    }
    if (!out.size) throw rangeError('쪽을 하나 이상 고르세요.');
    return [...out].sort((x, y) => x - y);
  }

  // 0 기준 번호 배열 → 사람이 읽는 1 기준 범위 글('1-3,5'). 화면 표시용
  function formatPageRange(indices) {
    const list = [...new Set(indices)].filter(Number.isInteger).sort((a, b) => a - b);
    const parts = [];
    for (let k = 0; k < list.length;) {
      let j = k;
      while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
      parts.push(j > k ? `${list[k] + 1}-${list[j] + 1}` : `${list[k] + 1}`);
      k = j + 1;
    }
    return parts.join(',');
  }

  const api = { parsePageRange, formatPageRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
