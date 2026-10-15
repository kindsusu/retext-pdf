// 찾아 바꾸기(v6, Ctrl+H)의 순수 계산 — PDF를 만지지 않는다. 서버(pdf-edit-service.replaceInDoc)와 화면이 같이 쓴다.
// 찾는 단위는 화면 상자(groupLines mergeStyledRuns — 시각적 줄 하나)의 표시 글(소프트 하이픈을 뺀 글)이다.
// 줄을 넘는 일치(문단에서 줄바꿈된 낱말)는 찾지 않는다 — 바꿀 때 조각별 편집(/api/pdf/edit-runs)이 줄 하나씩 고치기 때문이다.
//   · 가린 자리(■, 줄 글의 seps 안)와 겹치는 일치는 masked — 바꾸지 않는다(가린 글은 이미 PDF에 없다)
//   · 대소문자: matchCase가 아니면 소문자로 비교(길이가 바뀌는 글자는 글자마다 따로 낮춘다)
//   · 단어 단위: 일치 앞뒤 글자가 글자·숫자·밑줄이 아니어야 한다(한글 "회의는"의 "회의"는 단어 단위에서 빠진다)
const SHY = '­';
const MASK_CH = '■';
const isWordCh = (c) => !!c && /[\p{L}\p{N}_]/u.test(c);
const lower = (s) => { const l = s.toLowerCase(); return l.length === s.length ? l : [...s].map((c) => { const x = c.toLowerCase(); return x.length === c.length ? x : c; }).join(''); };

// 글 text에서 query가 나오는 자리(겹치지 않게, 앞에서부터)
function findAll(text, query, { matchCase = false, wholeWord = false } = {}) {
  const q = String(query ?? '');
  if (!q) return [];
  const hay = matchCase ? text : lower(text), needle = matchCase ? q : lower(q);
  const out = [];
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (wholeWord && (isWordCh(text[at - 1]) || isWordCh(text[at + q.length]))) continue;
    if (out.length && at < out[out.length - 1] + q.length) continue; // 겹치는 일치는 건너뛴다
    out.push(at);
  }
  return out;
}

// 줄 상자 하나의 일치: [{ at, len, masked }] — at·len은 표시 글(소프트 하이픈 뺀 글) 기준. raw: 줄 글(line.text), seps·objs: 줄 상자의 것
function lineMatches(line, query, opts = {}) {
  const raw = String(line.text ?? ''), disp = raw.replace(/­/g, '');
  const ats = findAll(disp, query, opts);
  if (!ats.length) return [];
  // 가린 자리(■가 든 사이 글)의 표시 글 범위
  const d2r = []; for (let r = 0; r < raw.length; r++) if (raw[r] !== SHY) d2r.push(r);
  d2r.push(raw.length);
  const masks = [];
  let off = 0;
  (line.objs || []).forEach((o, j) => {
    off += (o.text || '').length;
    const sep = (line.seps || [])[j] || '';
    if (sep.includes(MASK_CH)) masks.push([off, off + sep.length]);
    off += sep.length;
  });
  const qlen = String(query).length;
  return ats.map((at) => {
    const a = d2r[at], b = d2r[at + qlen] ?? raw.length;
    return { at, len: qlen, masked: masks.some(([s, e]) => a < e && b > s) || disp.slice(at, at + qlen).includes(MASK_CH) };
  });
}

// 표시 글에 바꾸기를 적용한다(matches: lineMatches 결과 중 바꿀 것, at 오름차순)
function applyReplace(disp, matches, replacement) {
  let out = '', last = 0;
  for (const m of [...matches].sort((a, b) => a.at - b.at)) { out += disp.slice(last, m.at) + replacement; last = m.at + m.len; }
  return out + disp.slice(last);
}

// 조각별 편집을 쓸 수 있는 줄인가(index.html runEditable과 같은 규칙): 투명 글자(그림 위 글자)·묶음·회전 글자가 아닌 줄. 못 쓰면 이유
function editBlock(line) {
  if (line.group) return '묶은 상자';
  if ((line.objs || []).some((o) => o.hidden)) return '그림 위 투명 글자';
  if ((line.objs || []).some((o) => o.matrix && !(Math.abs(o.matrix[1]) < 1e-3 && o.matrix[0] > 0 && o.matrix[3] > 0))) return '회전한 글자';
  return null;
}

// 앞뒤 문맥(목록 표시용)
function context(disp, at, len, width = 14) {
  const a = Math.max(0, at - width), b = Math.min(disp.length, at + len + width);
  return (a > 0 ? '…' : '') + disp.slice(a, b) + (b < disp.length ? '…' : '');
}

const findReplaceApi = { findAll, lineMatches, applyReplace, editBlock, context }; // 이름이 api면 같은 창의 inplace-edit.js(const api)와 겹쳐 이 파일이 읽히지 않는다(v6 Wave C에서 고침)
if (typeof window !== 'undefined') window.findReplace = findReplaceApi;
if (typeof module !== 'undefined') module.exports = findReplaceApi;
