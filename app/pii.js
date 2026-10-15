// 개인정보 패턴 찾기(쪽 글자 하나에 대한 순수 함수). 서버 /api/pdf/pii/find가 쪽마다 부른다.
//   findPii(text, { kinds, regex, limit }) → [{ kind, text, start, end, valid? }]  (start·end = text 안의 UTF-16 위치, end 미포함)
// 종류(kind): email · phone(전화) · rrn(주민등록번호) · brn(사업자등록번호) · card(카드번호) · custom(사용자 정규식)
// valid: 검사 숫자가 있는 번호(rrn·brn·card)만 — 검사 숫자가 맞으면 true, 틀리면 false. 틀려도 결과에 남긴다
//   (2020-10 이후 발급된 주민등록번호는 끝자리가 임의 번호라 검사 숫자가 맞지 않는다 — 사용자가 고르게 한다)
// 숫자 앞뒤에 다른 숫자가 붙어 있으면 잡지 않는다(긴 일련번호의 일부를 전화번호로 오인하지 않게)
const vm = require('vm');

const KINDS = ['email', 'phone', 'rrn', 'brn', 'card'];
const PATTERNS = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  // 휴대전화 010-1234-5678 · 010 1234 5678 · 010.1234.5678 · 01012345678 / 지역번호 02-123-4567 · 031)123-4567 · (02) 1234-5678 · 070·050x 인터넷 전화
  phone: /(?<![\d-])(?:\(?(?:01[016789]|02|0[3-6][1-5]|070|050\d?)\)?(?:[-.\s]|\)\s?)?\d{3,4}[-.\s]\d{4}|01[016789]\d{7,8})(?![\d-])/g,
  rrn: /(?<![\d-])\d{6}\s?-\s?[1-8]\d{6}(?![\d-])/g,
  brn: /(?<![\d-])\d{3}-\d{2}-\d{5}(?![\d-])/g,
  card: /(?<![\d-])\d{4}([- ])\d{4}\1\d{4}\1\d{4}(?![\d-])/g,
};
const digits = (s) => s.replace(/\D/g, '');

// 주민등록번호 검사 숫자: 앞 12자리에 2,3,4,5,6,7,8,9,2,3,4,5를 곱해 더한 값 S → (11 − S mod 11) mod 10 = 13번째 자리
// 생년월일(앞 6자리)의 월·일도 본다(00월·13월·32일이면 false)
function rrnValid(s) {
  const d = digits(s);
  if (d.length !== 13) return false;
  const mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return false;
  const w = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
  const sum = w.reduce((n, k, i) => n + k * Number(d[i]), 0);
  return (11 - (sum % 11)) % 10 === Number(d[12]);
}
// 사업자등록번호: 앞 9자리에 1,3,7,1,3,7,1,3,5를 곱해 더하고 9번째 자리×5의 십의 자리를 더한다 → (10 − 합 mod 10) mod 10 = 10번째 자리
function brnValid(s) {
  const d = digits(s);
  if (d.length !== 10) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = w.reduce((n, k, i) => n + k * Number(d[i]), 0);
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}
// 카드번호: Luhn
function luhnValid(s) {
  const d = digits(s);
  if (d.length < 12) return false;
  let sum = 0;
  for (let k = 0; k < d.length; k++) {
    let v = Number(d[d.length - 1 - k]);
    if (k % 2 === 1) { v *= 2; if (v > 9) v -= 9; }
    sum += v;
  }
  return sum % 10 === 0;
}
const VALIDATORS = { rrn: rrnValid, brn: brnValid, card: luhnValid };

// 사용자 정규식 준비. 문법 오류·빈 문자열과 일치하는 패턴·너무 긴 패턴은 사용자에게 보여 줄 문장으로 던진다(e.status 400).
// '/패턴/i' 꼴로 주면 i·m·s·u 플래그를 받는다. 실행은 vm 시간 제한 안에서 한다(아래 runCustom) — 역추적 폭주(ReDoS)로 서버가 굳지 않게
const REGEX_MAX = 500, REGEX_TIMEOUT_MS = 1500;
const badRegex = (message) => Object.assign(new Error(message), { status: 400, code: 'BAD_REGEX' });
function compileCustom(src) {
  const s = String(src ?? '');
  if (!s.trim()) return null;
  if (s.length > REGEX_MAX) throw badRegex(`정규식은 ${REGEX_MAX}자 이하로 입력하세요.`);
  let body = s, flags = '';
  const m = /^\/(.+)\/([imsu]*)$/s.exec(s);
  if (m) { body = m[1]; flags = m[2]; }
  let re;
  try { re = new RegExp(body, 'g' + flags.replace(/g/g, '')); } catch (e) { throw badRegex(`정규식 문법이 잘못됐습니다: ${e.message}`); }
  if (re.test('')) throw badRegex('빈 문자열과도 일치하는 정규식은 쓸 수 없습니다(예: a* → a+).');
  re.lastIndex = 0;
  return re;
}
// 시간 제한 안에서 모든 일치를 모은다. 시간이 넘으면 400 — "이 정규식은 너무 오래 걸립니다"
function runCustom(re, text, limit) {
  const ctx = vm.createContext({ re: new RegExp(re.source, re.flags), text, limit, out: [] });
  try {
    vm.runInContext('let m; while ((m = re.exec(text)) && out.length < limit) { if (m[0] === "") { re.lastIndex++; continue; } out.push([m.index, m.index + m[0].length]); }', ctx, { timeout: REGEX_TIMEOUT_MS });
  } catch (e) {
    if (/timed out/i.test(e.message)) throw badRegex('정규식이 너무 오래 걸립니다(되풀이가 겹친 패턴). 더 단순한 패턴으로 바꾸세요.');
    throw badRegex(`정규식을 실행하지 못했습니다: ${e.message}`);
  }
  return Array.from(ctx.out, (p) => [p[0], p[1]]);
}

function findPii(text, { kinds = KINDS, regex = null, limit = 2000 } = {}) {
  const want = [].concat(kinds || []).filter((k) => KINDS.includes(k));
  const out = [];
  for (const kind of want) {
    const re = new RegExp(PATTERNS[kind].source, PATTERNS[kind].flags);
    let m;
    while ((m = re.exec(text)) && out.length < limit) {
      const hit = { kind, text: m[0], start: m.index, end: m.index + m[0].length };
      if (VALIDATORS[kind]) hit.valid = VALIDATORS[kind](m[0]);
      out.push(hit);
    }
  }
  const custom = regex instanceof RegExp ? regex : compileCustom(regex);
  if (custom && out.length < limit) {
    for (const [start, end] of runCustom(custom, text, limit - out.length)) out.push({ kind: 'custom', text: text.slice(start, end), start, end });
  }
  // 같은 곳을 두 종류가 잡으면(사업자등록번호 형식이 전화번호로도 읽히는 경우 등) 앞 종류 하나만 남긴다
  out.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept = [];
  for (const h of out) {
    const dup = kept.find((k) => k.start === h.start && k.end === h.end);
    if (!dup) kept.push(h);
  }
  return kept;
}

module.exports = { findPii, compileCustom, rrnValid, brnValid, luhnValid, KINDS };
