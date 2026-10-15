// 목차(책갈피)를 글로 주고받기 — 서버 /api/pdf/outline {text}와 화면(/outline-text.js → window.parseOutlineText·formatOutlineText)이 같이 쓴다.
// 한 줄 = 항목 하나: [들여쓰기]제목<TAB>쪽번호
//   들여쓰기: 공백 2칸 또는 탭 1개가 한 단계(섞어도 된다). 바로 윗줄보다 두 단계 이상 깊어질 수 없다
//   쪽번호: 1 기준. 탭 대신 공백 두 칸 이상 뒤에 숫자로 끝나도 쪽번호로 읽는다('1장 시작  3'). 쪽번호가 없으면 목적지 없는 제목
//   빈 줄은 건너뛴다
// parseOutlineText(text, pageCount) → { items:[{ title, page(0 기준|null), children }], errors:[{ line(1 기준), message }] }
// formatOutlineText(items) → 같은 형식의 글(들여쓰기는 공백 2칸, 쪽번호 앞은 탭)
(function (root) {
  function parseOutlineText(text, pageCount) {
    const count = Number(pageCount) || 0;
    const items = [], errors = [], stack = []; // stack[k] = k단계의 마지막 항목
    const lines = String(text ?? '').split(/\r\n|\r|\n/);
    if (lines.length > 10000) return { items: [], errors: [{ line: 10001, message: '목차는 10,000줄까지입니다.' }] };
    lines.forEach((raw, k) => {
      const line = k + 1;
      if (!raw.trim()) return;
      const lead = /^[ \t]*/.exec(raw)[0];
      const tabs = (lead.match(/\t/g) || []).length, spaces = lead.length - tabs;
      if (spaces % 2) { errors.push({ line, message: '들여쓰기는 공백 2칸 또는 탭 1개 단위로 하세요.' }); return; }
      const level = tabs + spaces / 2;
      let body = raw.slice(lead.length).replace(/\s+$/, ''), page = null;
      const m = /^(.*?)(?:\t+|\s{2,})(\S+)$/.exec(body);
      if (m && (m[0].includes('\t') || /^\d+$/.test(m[2]))) {
        if (!/^\d+$/.test(m[2])) { errors.push({ line, message: `쪽 번호가 숫자가 아닙니다: '${m[2]}'` }); return; }
        const n = Number(m[2]);
        if (n < 1 || n > count) { errors.push({ line, message: `쪽 번호가 범위를 벗어났습니다: ${n} (1~${count})` }); return; }
        body = m[1].trim(); page = n - 1;
      }
      const title = body.trim();
      if (!title) { errors.push({ line, message: '제목이 비어 있습니다.' }); return; }
      if (title.length > 500) { errors.push({ line, message: '제목은 500자 이하로 입력하세요.' }); return; }
      if (level > stack.length) { errors.push({ line, message: `들여쓰기가 윗줄보다 두 단계 이상 깊습니다(${level + 1}단계).` }); return; }
      if (level >= 32) { errors.push({ line, message: '목차는 32단계까지만 넣을 수 있습니다.' }); return; }
      const item = { title, page, children: [] };
      (level === 0 ? items : stack[level - 1].children).push(item);
      stack.length = level;
      stack.push(item);
    });
    return { items, errors };
  }

  function formatOutlineText(items) {
    const out = [];
    const walk = (list, depth) => {
      for (const it of list || []) {
        out.push('  '.repeat(depth) + String(it.title ?? '').replace(/[\t\r\n]+/g, ' ') + (it.page != null ? '\t' + (it.page + 1) : ''));
        walk(it.children, depth + 1);
      }
    };
    walk(items, 0);
    return out.join('\n');
  }

  const api = { parseOutlineText, formatOutlineText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
