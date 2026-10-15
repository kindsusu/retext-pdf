// Installed/imported static TrueType fonts. The UI receives IDs and labels, never paths or font bytes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fontkit = require('fontkit');
const fonts = new Map();
let scanned = false;

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
  const label = face.fullName || face.postscriptName || path.basename(absolute);
  // 글리프 검사용 코드포인트 집합만 남기고 폰트 객체·바이트는 버린다. 설치 폰트 478개의 face를 전부 들고 있으면 서버 메모리가 600MB를 넘는다
  const chars = new Set(face.characterSet);
  const entry = { id, label, family: face.familyName || label, style: face.subfamilyName || '', path: absolute, chars };
  fonts.set(id, entry);
  return entry;
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
// ── 굵게·기울임의 진짜 글꼴 찾기(v6 글자 모양) ─────────────────────────────────────
// 같은 글꼴 집안(family)의 굵게·기울임 면(face)을 설치 폰트에서 찾는다. 없으면 null — 호출한 쪽이 가짜 굵게(렌더 모드 2)·가짜 기울임(행렬 기울이기)으로 흉내 낸다
const normFamily = (s) => String(s || '').replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const styleBold = (s) => /bold|black|heavy/i.test(s || '') && !/semi|demi/i.test(s || '');
const styleItalic = (s) => /italic|oblique/i.test(s || '');
// PDF 글꼴 이름("BAAAAA+MalgunGothic-Bold", "Arial,BoldItalic", "ArialMT")에서 굵기·기울임·MT 꼬리를 떼고 설치 폰트 집안과 이름이 같으면 그 집안 이름
function familyFor(pdfFontName) {
  scan();
  const base = String(pdfFontName || '').replace(/^[A-Z]{6}\+/, '')
    .replace(/[-,](bold|black|heavy|italic|oblique|regular|roman|book|normal|mt|ps)*$/i, '').replace(/(bold|black|heavy|italic|oblique)+(mt|ps)?$/i, '').replace(/(MT|PS)$/, '');
  const want = normFamily(base);
  if (!want) return null;
  for (const f of fonts.values()) if (normFamily(f.family) === want) return f.family;
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
const isBoldFace = (entry) => styleBold(entry?.style) || styleBold(entry?.label);
const isItalicFace = (entry) => styleItalic(entry?.style) || styleItalic(entry?.label);
const publicInfo = ({ id, label, family, style }) => ({ id, label, family, style });
function list(text = '') {
  scan();
  return [...fonts.values()].map((font) => ({ ...publicInfo(font), supported: missing(font, text).length === 0 }))
    .sort((a, b) => Number(b.supported) - Number(a.supported) || a.label.localeCompare(b.label));
}
module.exports = { register, get, list, missing, suggest, publicInfo, familyFor, faceFor, isBoldFace, isItalicFace };
