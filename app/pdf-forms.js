// v6 Wave E: 양식(AcroForm) 바이트 손질 · 양식 데이터 내보내기/가져오기. 엔진(PDFium)이 값을 쓰고 외형을 만든 뒤 여기서 마무리한다.
//   · fixUnicodeAppearances: 한글처럼 /DA 글꼴(/Helv 등 표준 14 글꼴)로 못 그리는 값 — PDFium은 그 글자를 빈칸으로 그린다(실측 2026-10-15).
//       그 위젯의 외형(/AP /N)을 맑은 고딕 서브셋(Type0 Identity-H, 글꼴 파일을 넣는다)으로 다시 써서 다른 뷰어에서도 보이게 한다.
//       PDFium이 그린 테두리·배경·콤보 단추는 그대로 두고 /Tx BMC … EMC 안(글자)만 바꾼다
//   · stripAcroForm: 양식 고정 뒤 카탈로그의 /AcroForm(·/NeedsRendering)을 뗀다 — 칸이 없는 빈 양식 사전이 남지 않게
//   · 데이터: JSON(이 앱 형식 · 이름→값 평면 객체) · FDF · XFDF 쓰기와 읽기(형식은 내용으로 알아낸다)
// 외부 의존성 없음(node:zlib, fontkit은 package.json에 이미 있다)
const zlib = require('zlib');
const fs = require('fs');
const fontkit = require('fontkit');
const R = require('./pdf-rewrite');

const KR_FONTS = ['C:\\Windows\\Fonts\\malgun.ttf', 'C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'];
const krFontPath = () => KR_FONTS.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
const ref = (n) => ({ t: 'ref', n, g: 0 });
const pdfStr = (s) => ({ t: 'str', v: Buffer.from(s, 'latin1') });

// ── 외형 글자 배치 ─────────────────────────────────────────────────────────
// face: fontkit 글꼴(서브셋), text: 그릴 글, box: { w, h }, opts: { size(0 = 자동), align 0/1/2, multiline, comb, maxLen }
// 반환 [{ x, y, text }] (글자 공간 좌표, 기준선) · size
function layoutText(face, text, box, opts) {
  const upm = face.unitsPerEm, asc = face.ascent / upm, desc = face.descent / upm; // desc는 음수
  const adv = (s, size) => [...s].reduce((n, c) => n + (face.glyphForCodePoint(c.codePointAt(0))?.advanceWidth || upm / 2), 0) / upm * size;
  const pad = 2, innerW = Math.max(1, box.w - 2 * pad), lineH = (asc - desc) * 1.0;
  let size = opts.size > 0 ? opts.size : 0;
  if (opts.comb && opts.maxLen > 0 && !opts.multiline) {
    size ||= Math.max(4, Math.min(12, (box.h - 2) / lineH));
    const cell = box.w / opts.maxLen, y = (box.h - (asc - desc) * size) / 2 - desc * size;
    return { size, lines: [...text].slice(0, opts.maxLen).map((c, k) => ({ x: cell * k + (cell - adv(c, size)) / 2, y, text: c })) };
  }
  if (!opts.multiline) {
    if (!size) { size = Math.max(4, Math.min(12, (box.h - 2) / lineH)); const w = adv(text, size); if (w > innerW) size = Math.max(4, size * innerW / w); }
    const w = adv(text, size), y = (box.h - (asc - desc) * size) / 2 - desc * size;
    const x = opts.align === 1 ? (box.w - w) / 2 : opts.align === 2 ? box.w - pad - w : pad;
    return { size, lines: [{ x, y, text }] };
  }
  size ||= 12;
  // 여러 줄: 줄바꿈 글자로 나누고, 넘치면 낱말(없으면 글자) 단위로 접는다
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const tok of para.match(/\s+|[^\s]+/g) || ['']) {
      if (adv(line + tok, size) <= innerW || !line) {
        if (adv(tok, size) > innerW && !line.trim()) { // 한 낱말이 칸보다 길다 → 글자 단위로
          for (const c of tok) { if (adv(line + c, size) > innerW && line) { lines.push(line); line = ''; } line += c; }
        } else line += tok;
      } else { lines.push(line.replace(/\s+$/, '')); line = tok.replace(/^\s+/, ''); }
    }
    lines.push(line.replace(/\s+$/, ''));
  }
  const lead = (asc - desc) * size * 1.05;
  return { size, lines: lines.map((t, k) => {
    const w = adv(t, size);
    return { x: opts.align === 1 ? (box.w - w) / 2 : opts.align === 2 ? box.w - pad - w : pad, y: box.h - pad - asc * size - k * lead, text: t };
  }) };
}

// 서브셋 글꼴 → Type0(Identity-H) 글꼴 객체 묶음. add(value) → 참조. 반환 Type0 참조
function addType0(add, ttf, face, chars) {
  const upm = face.unitsPerEm, s = (v) => Math.round(v * 1000 / upm);
  const gl = [...chars].map((c) => face.glyphForCodePoint(c.codePointAt(0))).filter((g) => g && g.id);
  const byId = new Map(gl.map((g) => [g.id, g]));
  const W = [...byId.values()].sort((a, b) => a.id - b.id).flatMap((g) => [R.num(g.id), [R.num(s(g.advanceWidth))]]);
  const file = add({ t: 'stream', dict: R.dict([['Length1', R.num(ttf.length)], ['Filter', R.name('FlateDecode')]]), data: zlib.deflateSync(ttf) });
  const bb = face.bbox;
  const fontName = 'RTXKRA+MalgunGothic';
  const desc = add(R.dict([['Type', R.name('FontDescriptor')], ['FontName', R.name(fontName)], ['Flags', R.num(4)],
    ['FontBBox', [s(bb.minX), s(bb.minY), s(bb.maxX), s(bb.maxY)].map(R.num)], ['ItalicAngle', R.num(0)], ['Ascent', R.num(s(face.ascent))],
    ['Descent', R.num(s(face.descent))], ['CapHeight', R.num(s(face.capHeight || face.ascent))], ['StemV', R.num(80)], ['FontFile2', file]]));
  const cid = add(R.dict([['Type', R.name('Font')], ['Subtype', R.name('CIDFontType2')], ['BaseFont', R.name(fontName)],
    ['CIDSystemInfo', R.dict([['Registry', pdfStr('Adobe')], ['Ordering', pdfStr('Identity')], ['Supplement', R.num(0)]])],
    ['FontDescriptor', desc], ['DW', R.num(1000)], ['W', W], ['CIDToGIDMap', R.name('Identity')]]));
  // 글자 찾기·복사용 ToUnicode
  const pairs = [...chars].map((c) => [face.glyphForCodePoint(c.codePointAt(0))?.id, c]).filter(([id]) => id);
  const hex4 = (n) => n.toString(16).padStart(4, '0');
  const u16 = (c) => Buffer.from(c, 'utf16le').swap16().toString('hex');
  const cmap = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'];
  for (let k = 0; k < pairs.length; k += 100) {
    const part = pairs.slice(k, k + 100);
    cmap.push(`${part.length} beginbfchar`, ...part.map(([id, c]) => `<${hex4(id)}> <${u16(c)}>`), 'endbfchar');
  }
  cmap.push('endcmap', 'CMapName currentdict /CMapResource defineresource pop', 'end', 'end');
  const tu = add({ t: 'stream', dict: R.dict([]), data: Buffer.from(cmap.join('\n'), 'latin1') });
  return add(R.dict([['Type', R.name('Font')], ['Subtype', R.name('Type0')], ['BaseFont', R.name(fontName)], ['Encoding', R.name('Identity-H')], ['DescendantFonts', [cid]], ['ToUnicode', tu]]));
}

const FONT_KEY = 'RtxKR';
// targets: 엔진 regenFields가 준 [{ objNum, value, fontSize, color('#rrggbb'), align, multiline, comb, maxLen, password }]. 반환 새 PDF 바이트(전체 다시 쓰기)
function fixUnicodeAppearances(bytes, targets, opts = {}) {
  const list = (targets || []).filter((t) => t && t.objNum > 0 && t.value && !t.password);
  if (!list.length) return bytes;
  const fontPath = opts.fontPath || krFontPath();
  if (!fontPath) throw new Error('한글 글꼴(맑은 고딕)을 찾지 못해 양식 외형을 만들 수 없습니다.');
  const { _subsetTTF } = require('./pdf-engine');
  const chars = new Set(list.flatMap((t) => [...t.value].filter((c) => c !== '\n' && c !== '\r')));
  const ttf = _subsetTTF(fontPath, chars), face = fontkit.create(ttf);
  const pdf = R.parsePdf(bytes);
  const extra = new Map();
  let next = Math.max(0, ...pdf.nums) + 1;
  const add = (v) => { const n = next++; extra.set(n, v); return ref(n); };
  const get = (n) => (extra.has(n) ? extra.get(n) : pdf.get(n));
  const res = (v) => (v && v.t === 'ref' ? get(v.n) : v);
  const type0 = addType0(add, ttf, face, chars);
  let fixed = 0;
  for (const t of list) {
    let w; try { w = pdf.get(t.objNum); } catch { continue; }
    if (!R.isDict(w)) continue;
    const ap = res(w.v.get('AP')), old = R.isDict(ap) ? res(ap.v.get('N')) : null;
    if (!old || old.t !== 'stream') continue;
    let content = '';
    try { content = R.decodeStream(old, res).toString('latin1'); } catch { content = ''; }
    const bb = res(old.dict.v.get('BBox'));
    const nums = Array.isArray(bb) ? bb.map((x) => Number(res(x)?.raw)) : null;
    const box = nums && nums.every(Number.isFinite) ? { x: Math.min(nums[0], nums[2]), y: Math.min(nums[1], nums[3]), w: Math.abs(nums[2] - nums[0]), h: Math.abs(nums[3] - nums[1]) } : null;
    if (!box || box.w < 1 || box.h < 1) continue;
    // PDFium이 그린 글자 부분(/Tx BMC … EMC)을 빼고 테두리·배경·단추는 남긴다
    const m = /\/Tx\s+BMC[\s\S]*?EMC/.exec(content);
    const before = m ? content.slice(0, m.index) : content, after = m ? content.slice(m.index + m[0].length) : '';
    const { size, lines } = layoutText(face, t.value.replace(/\r\n?/g, '\n'), box, { size: t.fontSize || 0, align: t.align || 0, multiline: !!t.multiline, comb: !!t.comb, maxLen: t.maxLen || 0 });
    const [r, g, b] = /^#[0-9a-f]{6}$/i.test(t.color || '') ? [1, 3, 5].map((k) => parseInt(t.color.slice(k, k + 2), 16) / 255) : [0, 0, 0];
    const f3 = (v) => (Math.round(v * 1000) / 1000).toString();
    const hex = (s) => '<' + [...s].map((c) => (face.glyphForCodePoint(c.codePointAt(0))?.id || 0).toString(16).padStart(4, '0')).join('') + '>';
    const body = [`/Tx BMC`, 'q', `${f3(box.x + 1)} ${f3(box.y + 1)} ${f3(box.w - 2)} ${f3(box.h - 2)} re W n`, 'BT', `${f3(r)} ${f3(g)} ${f3(b)} rg`, `/${FONT_KEY} ${f3(size)} Tf`,
      ...lines.filter((l) => l.text).map((l) => `1 0 0 1 ${f3(box.x + l.x)} ${f3(box.y + l.y)} Tm ${hex(l.text)} Tj`), 'ET', 'Q', 'EMC'].join('\n');
    const data = Buffer.from(`${before.trimEnd()}\n${body}\n${after.trimStart()}`, 'latin1');
    // 자원: 옛 /Resources를 복사해 /Font에 맑은 고딕을 더한다
    const oldRes = res(old.dict.v.get('Resources'));
    const resMap = new Map(R.isDict(oldRes) ? oldRes.v : []);
    const oldFonts = res(resMap.get('Font'));
    const fonts = new Map(R.isDict(oldFonts) ? oldFonts.v : []);
    fonts.set(FONT_KEY, type0);
    resMap.set('Font', R.dict([...fonts]));
    const dict = new Map([...old.dict.v].filter(([k]) => !['Length', 'Filter', 'DecodeParms', 'Resources'].includes(k)));
    dict.set('Resources', R.dict([...resMap])); dict.set('Filter', R.name('FlateDecode'));
    const nref = add({ t: 'stream', dict: { t: 'dict', v: dict }, data: zlib.deflateSync(data) });
    const apMap = new Map(ap.v); apMap.set('N', nref);
    w.v.set('AP', R.dict([...apMap]));
    fixed++;
  }
  if (!fixed) return bytes;
  return R.writePdf({ ...pdf, nums: [...pdf.nums, ...extra.keys()], get });
}

// 양식 고정 전: 확인란·라디오처럼 외형이 상태별 사전(/AP /N << /Yes … /Off … >>)인 칸은 지금 상태(/AS)의 외형 하나로 바꾼다.
// PDFium의 EPDFAnnot_Flatten은 상태 사전 외형을 고정하지 못한다(실측 2026-10-15: 확인란·라디오가 고정에 실패). 반환 { bytes, changed }
function resolveAppearanceStates(bytes) {
  const pdf = R.parsePdf(bytes);
  const res = (v) => (v && v.t === 'ref' ? (() => { try { return pdf.get(v.n); } catch { return null; } })() : v);
  let changed = 0;
  for (const n of pdf.nums) {
    let w; try { w = pdf.get(n); } catch { continue; }
    if (!R.isDict(w) || R.nameOf(w.v.get('Subtype')) !== 'Widget') continue;
    const ap = res(w.v.get('AP'));
    if (!R.isDict(ap)) continue;
    const N = res(ap.v.get('N'));
    if (!R.isDict(N)) continue; // 이미 스트림 하나
    const as = R.nameOf(res(w.v.get('AS'))) || 'Off';
    const pick = N.v.get(as) || null;
    const apMap = new Map(ap.v); apMap.delete('D'); apMap.delete('R');
    if (pick) apMap.set('N', pick); else apMap.delete('N');
    w.v.set('AP', R.dict([...apMap]));
    changed++;
  }
  return { bytes: changed ? R.writePdf(pdf) : bytes, changed };
}

// 양식 고정 뒤: 카탈로그의 /AcroForm·/NeedsRendering을 뗀다(닿지 않게 된 칸 사전·XFA는 writePdf가 떨군다)
function stripAcroForm(bytes) {
  const pdf = R.parsePdf(bytes);
  const root = pdf.trailer.v.get('Root'), cat = root && root.t === 'ref' ? pdf.get(root.n) : null;
  if (!R.isDict(cat) || (!cat.v.has('AcroForm') && !cat.v.has('NeedsRendering'))) return bytes;
  cat.v.delete('AcroForm'); cat.v.delete('NeedsRendering');
  return R.writePdf(pdf);
}

// ── 양식 데이터 ─────────────────────────────────────────────────────────────
// fields: 엔진 formFields().fields → 이름마다 값 하나. 확인란·라디오는 켠 값(내보내기 값) 또는 'Off', 서명·단추는 뺀다
function collectValues(fields) {
  const out = {};
  for (const f of fields || []) {
    if (!f.name || ['signature', 'button', 'unknown'].includes(f.type) || f.name in out) continue;
    out[f.name] = f.type === 'checkbox' || f.type === 'radio' ? (f.value && f.value !== '' ? f.value : 'Off') : f.value || '';
  }
  return out;
}
const fieldTypes = (fields) => new Map((fields || []).map((f) => [f.name, f.type]));
// PDF 문자열(FDF용): 출력 가능한 ASCII는 ( ) 이스케이프, 그 밖은 UTF-16BE <FEFF…>
const fdfString = (s) => (/^[\x20-\x7e]*$/.test(s) ? `(${s.replace(/[\\()]/g, '\\$&')})` : `<${R.textString(s).toString('hex').toUpperCase()}>`);
function toJson(fields, source) {
  return JSON.stringify({ format: 'retext-pdf-form', version: 1, source: source || '', fields: collectValues(fields) }, null, 2) + '\n';
}
function toFdf(fields, source) {
  const types = fieldTypes(fields), vals = collectValues(fields);
  const items = Object.entries(vals).map(([k, v]) => {
    const t = types.get(k), val = (t === 'checkbox' || t === 'radio') ? R.writeName(v || 'Off') : fdfString(String(v));
    return `<< /T ${fdfString(k)} /V ${val} >>`;
  });
  const f = source ? ` /F ${fdfString(source)}` : '';
  return Buffer.from(`%FDF-1.2\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<< /FDF << /Fields [\n${items.join('\n')}\n]${f} >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function toXfdf(fields, source) {
  const vals = collectValues(fields);
  const items = Object.entries(vals).map(([k, v]) => `    <field name="${xmlEsc(k)}"><value>${xmlEsc(v)}</value></field>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n  <f href="${xmlEsc(source || '')}"/>\n  <fields>\n${items.join('\n')}\n  </fields>\n</xfdf>\n`;
}

// PDF 문자열 바이트 → 글(UTF-16BE BOM · UTF-8 BOM · PDFDocEncoding≈latin1)
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('latin1');
}
// FDF: /Fields 배열(/Kids는 이름을 점으로 잇는다). 값: 문자열·이름·배열(목록 여러 개 → 첫 값)
function parseFdf(buf) {
  const text = buf.toString('latin1'), k = text.indexOf('/Fields');
  if (k < 0) throw Object.assign(new Error('FDF에 /Fields가 없습니다.'), { status: 400 });
  const lx = new R.Lexer(buf, k + '/Fields'.length);
  const arr = lx.value();
  if (!Array.isArray(arr)) throw Object.assign(new Error('FDF /Fields를 읽지 못했습니다.'), { status: 400 });
  const out = {};
  const val = (v) => (v == null ? '' : v.t === 'str' ? decodeText(v.v) : v.t === 'name' ? v.v : Array.isArray(v) ? val(v[0]) : v.t === 'num' ? v.raw : '');
  const visit = (list, prefix) => {
    for (const f of list) {
      if (!R.isDict(f)) continue;
      const t = f.v.get('T'), name = prefix + (t && t.t === 'str' ? decodeText(t.v) : '');
      if (f.v.has('V')) out[name] = val(f.v.get('V'));
      const kids = f.v.get('Kids');
      if (Array.isArray(kids)) visit(kids, name ? name + '.' : '');
    }
  };
  visit(arr, '');
  return out;
}
const xmlUnesc = (s) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (m, n, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[n.toLowerCase()]));
// XFDF: <field name="a"><field name="b"><value>…</value></field></field> → a.b
function parseXfdf(xml) {
  const out = {}, stack = [];
  const re = /<field\s+name\s*=\s*"([^"]*)"\s*(\/?)>|<\/field\s*>|<value(?:-richtext)?\s*>([\s\S]*?)<\/value(?:-richtext)?\s*>/gi;
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) { if (!m[2]) stack.push(xmlUnesc(m[1])); }
    else if (m[0].startsWith('</')) stack.pop();
    else if (stack.length) { const name = stack.join('.'); if (!(name in out)) out[name] = xmlUnesc(m[3].replace(/<[^>]+>/g, '')); }
  }
  return out;
}
// 파일 바이트 → { format, values }. 형식은 내용으로 알아낸다
function parseData(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const head = b.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (head.startsWith('%FDF')) return { format: 'fdf', values: parseFdf(b) };
  if (head.startsWith('<')) return { format: 'xfdf', values: parseXfdf(b.toString('utf8')) };
  if (head.startsWith('{')) {
    let j; try { j = JSON.parse(b.toString('utf8').replace(/^\ufeff/, '')); } catch (e) { throw Object.assign(new Error(`JSON을 읽지 못했습니다: ${e.message}`), { status: 400 }); }
    const values = j && typeof j.fields === 'object' && !Array.isArray(j.fields) ? j.fields : j;
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw Object.assign(new Error('JSON은 { "칸 이름": 값 } 모양이어야 합니다.'), { status: 400 });
    return { format: 'json', values };
  }
  throw Object.assign(new Error('JSON·FDF·XFDF 양식 데이터가 아닙니다.'), { status: 400 });
}

module.exports = { fixUnicodeAppearances, resolveAppearanceStates, stripAcroForm, layoutText, collectValues, toJson, toFdf, toXfdf, parseFdf, parseXfdf, parseData, krFontPath };
