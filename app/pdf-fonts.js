// Installed/imported static TrueType fonts. The UI receives IDs and labels, never paths or font bytes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fontkit = require('fontkit');
const fonts = new Map();
let scanned = false;

const normFamily = (s) => String(s || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');

function register(file) {
  const absolute = fs.realpathSync(file);
  if (!/\.ttf$/i.test(absolute)) throw new Error('현재 일반 TTF 폰트만 지원합니다.');
  const stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('32MB 이하의 TTF 파일을 선택하세요.');
  const data = fs.readFileSync(absolute);
  const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 24);
  if (fonts.has(id)) return fonts.get(id);
  const face = fontkit.create(data);
  if (!face.directory?.tables?.glyf || Object.keys(face.variationAxes || {}).length) throw new Error('가변 폰트와 CFF 폰트는 아직 지원하지 않습니다. 일반 TTF를 선택하세요.');
  return addFace(face, id, absolute, 0);
}
// 글리프 검사용 코드포인트 집합과 이름만 남기고 폰트 객체·바이트는 버린다. 설치 폰트 478개의 face를 전부 들고 있으면 서버 메모리가 600MB를 넘는다
// names: 이 면을 PDF 글꼴 이름과 맞춰 볼 이름들(모든 언어의 집안 이름 — "맑은 고딕"·"Malgun Gothic" — 과 PostScript 이름, 정규화)
function addFace(face, id, file, index) {
  const label = face.fullName || face.postscriptName || path.basename(file);
  const names = new Set();
  for (const key of ['fontFamily', 'preferredFamily']) for (const v of Object.values(face.name?.records?.[key] || {})) if (v) names.add(normFamily(v));
  const ps = normFamily(face.postscriptName || '');
  if (ps) names.add(ps);
  const entry = { id, label, family: face.familyName || label, style: face.subfamilyName || '', path: file, index, chars: new Set(face.characterSet), ps, names };
  fonts.set(id, entry);
  return entry;
}
// 글꼴 모음(TTC — 바탕·굴림·돋움): 면마다 하나씩. 대체 글꼴 고르기(같은 집안)에도 쓴다 — 사용자가 직접 추가하는 폰트는 여전히 TTF만
function registerCollection(file) {
  const absolute = fs.realpathSync(file), stat = fs.statSync(absolute);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return;
  const data = fs.readFileSync(absolute), hash = crypto.createHash('sha256').update(data).digest('hex').slice(0, 20);
  const coll = fontkit.create(data);
  (coll.fonts || []).forEach((face, k) => {
    const id = `${hash}${String(k).padStart(4, '0')}`;
    if (fonts.has(id) || !face.directory?.tables?.glyf || Object.keys(face.variationAxes || {}).length) return;
    addFace(face, id, absolute, k);
  });
}
function scan() {
  if (scanned) return;
  scanned = true;
  const dirs = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:/Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || os.homedir(), 'Microsoft/Windows/Fonts')]
    : ['/usr/share/fonts/truetype', path.join(os.homedir(), '.fonts'), '/Library/Fonts'];
  const walk = (dir, depth = 0) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) walk(file, depth + 1);
      else if (entry.isFile() && /\.ttf$/i.test(file)) { try { register(file); } catch {} }
      else if (entry.isFile() && /\.ttc$/i.test(file)) { try { registerCollection(file); } catch {} }
    }
  };
  dirs.forEach((dir) => walk(dir));
}
function get(id) {
  scan();
  const font = fonts.get(id);
  if (!font) throw new Error('지정한 폰트가 없습니다. 같은 TTF 파일을 추가하거나 다른 폰트를 선택하세요.');
  return font;
}
function missing(font, text) {
  return [...new Set([...String(text)].filter((c) => !/\s/.test(c) && (c.codePointAt(0) >= 0xffff || !font.chars.has(c.codePointAt(0)))))];
}
// PDF에 적힌 폰트 이름("ABCDEF+MalgunGothicBold", "Malgun Gothic,Bold" 등)과 가장 비슷한 설치 폰트의 id. 대화상자의 기본 선택용, 없으면 null
function suggest(pdfFontName, list) {
  const norm = (s) => String(s || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  const want = norm(pdfFontName);
  if (!want) return null;
  const score = (f) => {
    const label = norm(f.label), familyStyle = norm(f.family + f.style), family = norm(f.family);
    if (label === want || familyStyle === want) return 3;
    if (want.includes(label) || label.includes(want)) return 2;
    if (family && want.includes(family)) return 1;
    return 0;
  };
  let best = null, bestScore = 0;
  for (const f of list) { if (!f.supported) continue; const s = score(f); if (s > bestScore) { best = f; bestScore = s; } }
  return best ? best.id : null;
}
// ── 굵게·기울임의 진짜 글꼴 찾기(v6 글자 모양) · 같은 집안 대체 글꼴(v6 Wave B) ─────────────────
// 같은 글꼴 집안(family)의 굵게·기울임 면(face)을 설치 폰트에서 찾는다. 없으면 null — 호출한 쪽이 가짜 굵게(렌더 모드 2)·가짜 기울임(행렬 기울이기)으로 흉내 낸다
const styleBold = (s) => /bold|black|heavy/i.test(s || '') && !/semi|demi/i.test(s || '');
const styleItalic = (s) => /italic|oblique/i.test(s || '');
// PDF 글꼴 이름에서 서브셋 접두어("ABCDEF+")와 굵기·기울임·MT/PS 꼬리를 뗀 이름 후보들(긴 것부터).
// "BAAAAA+MalgunGothic-Bold" → MalgunGothic-Bold, MalgunGothic · "Arial-BoldMT" → Arial-Bold, Arial · "NanumGothicBold" → NanumGothic · "CourierNewPSMT" → CourierNew
const STYLE_TAIL = /[-,_ ]?(bold|black|heavy|semibold|demibold|extrabold|light|medium|italic|oblique|regular|roman|book|normal|psmt|mt|ps)$/i;
function nameCandidates(pdfFontName) {
  let base = String(pdfFontName || '').replace(/^[A-Z]{6}\+/, '').trim();
  const out = [base];
  for (let guard = 0; guard < 6 && STYLE_TAIL.test(base); guard++) { base = base.replace(STYLE_TAIL, ''); if (base) out.push(base); }
  return out;
}
// PDF 글꼴 이름("BAAAAA+MalgunGothic-Bold", "Arial,BoldItalic", "ArialMT", "NanumGothicBold", 한글 이름 "맑은고딕")에서
// 설치 폰트 집안(이름표의 모든 언어 집안 이름·PostScript 이름과 비교)을 찾으면 그 집안 이름(영문 familyName), 없으면 null
function familyFor(pdfFontName) {
  scan();
  for (const cand of nameCandidates(pdfFontName)) {
    const want = normFamily(cand);
    if (!want) continue;
    for (const f of fonts.values()) if (normFamily(f.family) === want) return f.family;
    for (const f of fonts.values()) if (f.names?.has(want)) return f.family;
  }
  return null;
}
// PostScript 이름이 정확히 같은 면("Consolas-Bold" → consolab.ttf). 서브셋 접두어는 뗀다. 없으면 null
function faceByName(pdfFontName) {
  scan();
  const want = normFamily(String(pdfFontName || '').replace(/^[A-Z]{6}\+/, ''));
  if (!want) return null;
  for (const f of fonts.values()) if (f.ps === want) return f;
  return null;
}
// 집안 family에서 굵기·기울임이 맞는 면. 보통 면은 Regular·Normal·이름 없음을 먼저 고른다(Light·Thin보다)
function faceFor(family, bold, italic) {
  scan();
  if (!family) return null;
  const want = normFamily(family);
  const cands = [...fonts.values()].filter((f) => normFamily(f.family) === want && styleBold(f.style) === !!bold && styleItalic(f.style) === !!italic);
  if (!cands.length) return null;
  const rank = (f) => (/^(regular|normal|book|roman|bold|italic|bold italic|)$/i.test(String(f.style || '').trim()) ? 0 : 1);
  return cands.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label))[0];
}
// 파일 경로(+모음 안 번호)의 면 — 대체 글꼴(맑은 고딕) 이름표 표시용
function byPath(file, index = 0) {
  scan();
  const want = path.resolve(file).toLowerCase();
  for (const f of fonts.values()) if (f.path.toLowerCase() === want && (f.index || 0) === index) return f;
  return null;
}
const isBoldFace = (entry) => styleBold(entry?.style) || styleBold(entry?.label);
const isItalicFace = (entry) => styleItalic(entry?.style) || styleItalic(entry?.label);
const publicInfo = ({ id, label, family, style }) => ({ id, label, family, style });
function list(text = '') {
  scan();
  return [...fonts.values()].map((font) => ({ ...publicInfo(font), supported: missing(font, text).length === 0 }))
    .sort((a, b) => Number(b.supported) - Number(a.supported) || a.label.localeCompare(b.label));
}
module.exports = { register, get, list, missing, suggest, publicInfo, familyFor, faceFor, faceByName, byPath, isBoldFace, isItalicFace, nameCandidates };
