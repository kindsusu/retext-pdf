// 쪽 위에서 바로 고치기(v6 in-place 편집기)의 순수 계산 — 화면(index.html)과 Node 시험(ui-wiring.test.js)이 같이 쓴다.
// 편집기는 상자 자리에 겹친 contenteditable 하나다. 줄(문단이면 여러 줄)의 조각(PDF 텍스트 객체)마다 글꼴·크기·색·굵기·기울임을 흉내 낸
// <span>을 두고, 그 사이에 글로 고칠 수 없는 표시를 끼운다:
//   · 옛 줄 경계(soft): data-raw="\n" — 보기에는 띄어쓰기 한 칸(한글이 줄 끝까지 찬 줄이면 빈칸 없이). 지우면 두 줄이 붙는다(편집 서버의 soft 지움)
//   · 가린 자리(■): data-raw="■■" — 고칠 수 없다(가린 글은 이미 PDF에 없다)
//   · 강제 줄바꿈 표시(↵, class hb): 글자가 아니다. 바로 뒤의 '\n' 글자가 실제 줄바꿈이다(white-space: pre-wrap)
// 편집기 글 = extractText(편집기 뿌리) — 서버 /api/pdf/edit-runs의 newText(소프트 하이픈을 뺀 표시 글, 줄 사이 '\n')와 같은 모양이다.
// 한글 조합(IME) 중에는 Enter·Ctrl+Enter·Esc를 처리하지 않는다(keyAction) — 조합 중 Enter는 글자 확정이다.
const SHY_RE = /­/g;
const ZW_RE = /​/g;
const MASK = '■';
const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;

// PDF 글꼴 이름 → 화면 글꼴(가까운 것). 정확한 모양은 적용한 뒤 쪽 그림으로 본다
function cssFamily(font, label) {
  const n = String(label || font || '').replace(/^[A-Z]{6}\+/, '');
  if (/consol|courier|mono|d2coding/i.test(n)) return "Consolas, 'D2Coding', monospace";
  if (/batang|myeong|myung|명조|바탕|serif|times|georgia/i.test(n)) return "'Batang', 'Times New Roman', serif";
  if (/gulim|굴림/i.test(n)) return "'Gulim', sans-serif";
  if (/dotum|돋움/i.test(n)) return "'Dotum', sans-serif";
  if (/nanum.*gothic|나눔고딕/i.test(n)) return "'NanumGothic', 'Malgun Gothic', sans-serif";
  if (/arial|helvet/i.test(n)) return "Arial, 'Malgun Gothic', sans-serif";
  return "'Malgun Gothic', '맑은 고딕', sans-serif";
}
const isBoldObj = (o) => /bold|black|heavy/i.test(o.font || '') || /bold|black|heavy/i.test(o.fontLabel || '') || (o.weight || 0) >= 600 || o.renderMode === 2 || !!o.style?.fb;
const isItalicObj = (o) => /italic|oblique/i.test(o.font || '') || /italic|oblique/i.test(o.fontLabel || '') || (!!o.matrix && o.matrix[0] && Math.abs(o.matrix[2] / o.matrix[0]) > 0.05);
const hexColor = (c) => '#' + (c || [0, 0, 0]).slice(0, 3).map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
// 조각 하나의 모양(편집기 span과 속성 창이 쓴다). base: 그 줄의 본문 기준선·크기(첨자 판정)
function objStyle(o, base = {}) {
  const size = o.scaledSize || o.size || base.size || 10;
  const sc = o.style?.sc === 'sup' ? 'super' : o.style?.sc === 'sub' ? 'sub'
    : base.y != null && o.origin && base.size && size < 0.9 * base.size && Math.abs(o.origin.y - base.y) > 0.15 * base.size ? (o.origin.y > base.y ? 'super' : 'sub') : null;
  return {
    size, color: hexColor(o.color), bold: isBoldObj(o), italic: isItalicObj(o), underline: !!o.style?.u, strike: !!o.style?.s, script: sc,
    family: cssFamily(o.font, o.fontLabel), font: o.fontLabel || String(o.font || '').replace(/^[A-Z]{6}\+/, ''), fontId: o.fontId || null,
  };
}
const styleKey = (s) => [s.size.toFixed(2), s.color, s.bold, s.italic, s.underline, s.strike, s.script, s.family].join('|');

// 두 줄이 이어질 때 사이 띄어쓰기를 보일지(편집 서버 editRuns의 soft 판단과 같은 규칙):
// 앞 줄이 '-'·공백으로 끝나거나 다음 줄이 공백으로 시작하면 붙이고, 한글끼리 이어지며 앞 줄이 문단 오른쪽 끝까지 찼으면(1em 안) 붙인다
function softGlue(prev, next, paraRight) {
  const a = String(prev.text || '').replace(SHY_RE, ''), b = String(next.text || '').replace(SHY_RE, '');
  if (!a || !b || /[-\s]$/.test(a) || /^\s/.test(b)) return true;
  const full = prev.bounds && paraRight != null && prev.bounds.x1 >= paraRight - (prev.size || 10);
  return !!(full && CJK.test(a.slice(-1)) && CJK.test(b[0]));
}

// 선택한 줄들 → 편집기 조각 목록: { t:'text', text, style } | { t:'soft', raw:'\n', show } | { t:'mask', raw }
// 같은 모양이 이어지면 한 조각으로 합친다. 사이 글(seps)의 공백은 앞 조각 모양으로 글에 넣는다(고칠 수 있다)
function segmentsFor(lines) {
  const out = [], paraRight = Math.max(...lines.map((L) => L.bounds?.x1 ?? 0));
  const push = (seg) => {
    const last = out[out.length - 1];
    if (seg.t === 'text' && last?.t === 'text' && styleKey(last.style) === styleKey(seg.style)) { last.text += seg.text; return; }
    if (seg.t === 'text' && !seg.text) return;
    out.push(seg);
  };
  lines.forEach((L, li) => {
    if (li) push({ t: 'soft', raw: '\n', show: softGlue(lines[li - 1], L, paraRight) ? '' : ' ' });
    const ink = (L.objs || []).filter((o) => (o.text || '').trim());
    const main = ink.reduce((m, o) => ((o.scaledSize || o.size || 0) > (m?.scaledSize || m?.size || 0) + 0.01 ? o : m), ink[0]);
    const base = main ? { y: main.origin?.y, size: main.scaledSize || main.size } : {};
    let prevStyle = null;
    (L.objs || []).forEach((o, j) => {
      const st = objStyle(o, base);
      if (j) {
        const sep = (L.seps || [])[j - 1] || '';
        if (sep.includes(MASK)) push({ t: 'mask', raw: sep });
        else if (sep) push({ t: 'text', text: sep, style: prevStyle || st });
      }
      push({ t: 'text', text: String(o.text || '').replace(SHY_RE, ''), style: st });
      prevStyle = st;
    });
  });
  return out;
}

// 편집기 DOM(또는 같은 모양의 가짜 노드) → 편집기 글. data-raw가 있는 요소는 그 값, .hb(↵ 표시)는 빈 글, BR은 줄바꿈,
// 브라우저가 Enter로 끼운 DIV·P는 앞에 줄바꿈(맨 앞 제외). 폭 없는 공백(U+200B, 빈 줄 자리 잡기)은 뺀다
function extractText(root) {
  let out = '';
  const walk = (n) => {
    for (const c of Array.from(n.childNodes || [])) {
      if (c.nodeType === 3) { out += String(c.nodeValue || '').replace(ZW_RE, ''); continue; }
      if (c.nodeType !== 1) continue;
      const raw = c.dataset ? c.dataset.raw : c.getAttribute?.('data-raw');
      if (raw != null) { out += raw; continue; }
      if (c.classList?.contains('hb')) continue;
      const tag = String(c.tagName || '').toUpperCase();
      if (tag === 'BR') { out += '\n'; continue; }
      if ((tag === 'DIV' || tag === 'P') && out && !out.endsWith('\n')) out += '\n';
      walk(c);
    }
  };
  walk(root);
  return out;
}
// 노드 하나가 편집기 글에서 차지하는 길이(extractText와 같은 규칙)
function nodeLength(c) {
  if (c.nodeType === 3) return String(c.nodeValue || '').replace(ZW_RE, '').length;
  if (c.nodeType !== 1) return 0;
  const raw = c.dataset ? c.dataset.raw : c.getAttribute?.('data-raw');
  if (raw != null) return raw.length;
  if (c.classList?.contains('hb')) return 0;
  if (String(c.tagName || '').toUpperCase() === 'BR') return 1;
  return extractText(c).length;
}
// DOM 위치(node, offset — Range의 start/end) → 편집기 글 위치. 노드가 뿌리 밖이면 -1
function textOffset(root, node, offset) {
  let acc = 0, found = -1;
  const walk = (n) => {
    for (const c of Array.from(n.childNodes || [])) {
      if (found >= 0) return;
      if (c === node) {
        if (c.nodeType === 3) {
          const s = String(c.nodeValue || '');
          found = acc + s.slice(0, offset).replace(ZW_RE, '').length;
        } else found = acc + Array.from(c.childNodes || []).slice(0, offset).reduce((x, k) => x + nodeLength(k), 0);
        return;
      }
      if (c.nodeType === 1 && (c.dataset?.raw != null || c.classList?.contains('hb') || String(c.tagName || '').toUpperCase() === 'BR')) { acc += nodeLength(c); continue; }
      if (c.nodeType === 1) { walk(c); continue; }
      acc += nodeLength(c);
    }
  };
  if (node === root) return Array.from(root.childNodes || []).slice(0, offset).reduce((x, k) => x + nodeLength(k), 0);
  walk(root);
  return found;
}

// 키 처리: 한글 조합 중(isComposing·keyCode 229·조합 시작~끝 사이)이면 아무것도 하지 않는다.
// Ctrl/⌘+Enter = 적용, Esc = 취소, Enter·Shift+Enter = 강제 줄바꿈(↵), Ctrl/⌘+B·I·U = 굵게·기울임·밑줄
function keyAction(e, composing = false) {
  if (composing || e.isComposing || e.keyCode === 229) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Enter') return mod ? 'apply' : 'hardBreak';
  if (e.key === 'Escape') return 'cancel';
  if (mod && !e.altKey && !e.shiftKey) {
    const k = { KeyB: 'bold', KeyI: 'italic', KeyU: 'underline' }[e.code];
    if (k) return k;
  }
  return null;
}

// 고친 뒤 글이 다시 흘러 줄 경계(\n)·이음 띄어쓰기가 달라져도 같은 글자를 가리키게: 공백·줄바꿈이 아닌 글자 수로 위치를 옮긴다.
// side 'start'(고른 범위 앞끝)는 다음 글자 앞, 'end'(뒤끝·커서)는 앞 글자 뒤로 — 낱말 앞뒤 공백이 범위에 끼지 않게
function mapOffset(oldText, newText, k, side = 'end') {
  let n = 0;
  for (let p = 0; p < Math.min(k, oldText.length); p++) if (!/\s/.test(oldText[p])) n++;
  if (!n && side !== 'start') return 0;
  let c = 0;
  for (let p = 0; p < newText.length; p++) {
    if (/\s/.test(newText[p])) continue;
    if (side === 'start' && c === n) return p;
    c++;
    if (side !== 'start' && c === n) return p + 1;
  }
  return side === 'start' && n === 0 ? 0 : newText.length;
}

// 속성 창 표시: 편집기 글 위치 [from, to)의 조각 모양을 모은다(골라 놓은 글자가 없으면 커서 앞 글자).
// lines: 선택한 줄들. 반환 { bold, italic, underline, strike(모두 그러면 true), script, size, color, font, fontId, mixed: { size, color, font } }
function styleAt(lines, from, to) {
  const segs = [];
  let off = 0;
  lines.forEach((L, li) => {
    if (li) off += 1;
    const ink = (L.objs || []).filter((o) => (o.text || '').trim());
    const main = ink.reduce((m, o) => ((o.scaledSize || o.size || 0) > (m?.scaledSize || m?.size || 0) + 0.01 ? o : m), ink[0]);
    const base = main ? { y: main.origin?.y, size: main.scaledSize || main.size } : {};
    (L.objs || []).forEach((o, j) => {
      if (j) off += ((L.seps || [])[j - 1] || '').length;
      const t = String(o.text || '').replace(SHY_RE, '');
      if (t.trim()) segs.push({ s: off, e: off + t.length, st: objStyle(o, base) });
      off += t.length;
    });
  });
  if (!segs.length) return null;
  const a = Math.min(from, to), b = Math.max(from, to);
  let hit = segs.filter((g) => g.s < b && g.e > a);
  if (!hit.length) hit = [segs.filter((g) => g.s < Math.max(1, a)).pop() || segs[0]];
  const all = (k) => hit.every((g) => g.st[k]);
  const same = (k) => hit.every((g) => g.st[k] === hit[0].st[k]);
  const f = hit[0].st;
  return { bold: all('bold'), italic: all('italic'), underline: all('underline'), strike: all('strike'), script: same('script') ? f.script : null,
    size: f.size, color: f.color, font: f.font, fontId: f.fontId, mixed: { size: !hit.every((g) => Math.abs(g.st.size - f.size) < 0.05), color: !same('color'), font: !same('font') } };
}

// v6 Wave B: 편집기에서 새로 넣은 글자와 그 글자를 그릴 조각(속성 창 "원래 글꼴에 없는 문자" 안내용).
// 옛 글·새 글의 같은 앞뒤를 뺀 가운데가 넣은 글이고, 그 글은 편집 서버(planRuns)처럼 왼쪽 글자의 조각이 받는다(줄 첫머리면 오른쪽).
// 반환 { idx(조각 객체 번호), chars(공백·■·줄바꿈을 뺀 넣은 글자, 중복 없이) } — 넣은 글자가 없으면 null
function insertedAt(lines, oldText, newText) {
  const a = String(oldText || ''), b = String(newText || '');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const chars = [...new Set([...b.slice(p, b.length - s)].filter((ch) => !/\s/.test(ch) && ch !== MASK))];
  if (!chars.length) return null;
  const segs = [];
  let off = 0;
  lines.forEach((L, li) => {
    if (li) off += 1;
    (L.objs || []).forEach((o, j) => {
      if (j) off += ((L.seps || [])[j - 1] || '').length;
      const t = String(o.text || '').replace(SHY_RE, '');
      if (t.trim()) segs.push({ s: off, e: off + t.length, idx: o.idx });
      off += t.length;
    });
  });
  if (!segs.length) return null;
  const k = p > 0 ? p - 1 : 0;
  const hit = segs.find((g) => k >= g.s && k < g.e) || segs.filter((g) => g.s <= k).pop() || segs[0];
  return { idx: hit.idx, chars };
}

const api = { cssFamily, objStyle, segmentsFor, softGlue, extractText, textOffset, keyAction, mapOffset, styleAt, insertedAt, isBoldObj, isItalicObj, hexColor };
if (typeof window !== 'undefined') window.inplaceEdit = api;
if (typeof module !== 'undefined') module.exports = api;
