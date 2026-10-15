// v6 Wave F 맞춤법 검사의 순수 계산 — 사전(Hunspell)을 모른다. 작업 스레드(spell-worker.js)·서버(spell-check.js)·화면(window.spellCore)·Node 시험이 같이 쓴다.
//   · 낱말 나누기(tokenize): 글자·숫자가 이어진 덩어리. 검사하지 않는 것 — 숫자가 든 덩어리(2026년·A4·v6) · 주소·메일 · 모두 대문자(PDF)·
//     안에 대문자가 낀 영문(iPhone) · 한 글자 영문 · 한글과 영문이 붙은 덩어리(PDF를) · 닫는 괄호·따옴표 바로 뒤에 붙은 짧은 한글(』를 — 조사)
//   · 합성어(compoundOk): 한국어 사전(hunspell-dict-ko)은 붙여 쓴 합성 명사(독서모임·인사팀장)를 모른다 → 두 글자 이상씩 둘로 나눠 둘 다 맞으면 맞다고 본다
//   · 자주 틀리는 말(COMMON): 됬다→됐다 · 안되요→안돼요 · 몇일→며칠처럼 늘 틀린 꼴은 사전이 무엇이라 하든 틀렸다고 보고, 고칠 말을 맨 앞에 둔다
(function () {
  const HANGUL = /[가-힣]/;
  const HANGUL_ONLY = /^[가-힣]+$/;
  const LATIN_ONLY = /^[A-Za-z]+(?:['’][A-Za-z]+)*$/;
  // 주소·메일(그 안의 낱말은 검사하지 않는다)
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;
  // 낱말 덩어리: 글자·숫자(영문 안의 ' ’는 이어 붙인다 — don't)
  const CHUNK_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
  // 띄어쓰기 없이 닫는 괄호·따옴표·백틱·% 바로 뒤에 붙은 짧은 한글(세 글자까지)은 조사로 본다(『어린 왕자』를 · "책"은 · `.md`로 · (주)의 · 50%를).
  // '/'·'·'·'-' 같은 사이 기호 뒤(저장/열기)는 낱말이라 검사한다
  const CLOSERS = new Set([...')]}」』"\'”’》〉>»`%']);
  const MAX_WORD = 40;

  // 글 → [{ at, len, word, lang:'ko'|'en'|null, skip: 이유|null }] (at·len은 글 위치)
  function tokenize(text) {
    const s = String(text ?? '');
    const covered = [];
    for (const m of s.matchAll(URL_RE)) covered.push([m.index, m.index + m[0].length]);
    const inUrl = (a, b) => covered.some(([x, y]) => a < y && b > x);
    const out = [];
    for (const m of s.matchAll(CHUNK_RE)) {
      const word = m[0], at = m.index, len = word.length;
      let lang = null, skip = null;
      if (inUrl(at, at + len)) skip = 'url';
      else if (/\p{N}/u.test(word)) skip = 'digit';
      else if (len > MAX_WORD) skip = 'long';
      else if (HANGUL_ONLY.test(word)) {
        lang = 'ko';
        const prev = s[at - 1];
        const opening = (prev === '"' || prev === "'") && (at < 2 || /\s/.test(s[at - 2])); // 곧은 따옴표는 앞이 빈칸이면 여는 쪽
        if (prev && CLOSERS.has(prev) && !opening && len <= 3) skip = 'josa';
      } else if (LATIN_ONLY.test(word)) {
        lang = 'en';
        const letters = word.replace(/['’]/g, '');
        if (letters.length < 2) skip = 'short';
        else if (letters === letters.toUpperCase()) skip = 'caps';
        else if (/[A-Z]/.test(letters.slice(1))) skip = 'caps';
      } else skip = HANGUL.test(word) && /[A-Za-z]/.test(word) ? 'mixed' : 'script';
      out.push({ at, len, word, lang, skip });
    }
    return out;
  }
  // 검사할 낱말만
  const checkable = (text) => tokenize(text).filter((t) => !t.skip);

  // 합성어: 앞·뒤를 두 글자 이상씩 나눠 둘 다 사전에 있으면 맞다(독서+모임, 재무+팀장이). test(낱말) → 참/거짓
  function compoundOk(word, test) {
    const w = String(word || '');
    if (w.length < 4 || !HANGUL_ONLY.test(w)) return false;
    for (let k = 2; k <= w.length - 2; k++) if (test(w.slice(0, k)) && test(w.slice(k))) return true;
    return false;
  }

  // 자주 틀리는 말: [틀린 꼴(정규식), 바른 꼴, 늘 틀림(사전이 맞다고 해도 틀림)]. 바른 꼴은 틀린 자리만 바꾼다
  const COMMON = [
    [/됬/g, '됐', true],
    [/안되요$/g, '안돼요', true], [/되요$/g, '돼요', true], [/안되서/g, '안돼서', true], [/되서$/g, '돼서', true],
    [/^몇일/g, '며칠', true],
    [/할께/g, '할게', true], [/(갈|올|볼|줄|살)께/g, '$1게', true],
    [/어떻해/g, '어떡해', true],
    [/^왠만/g, '웬만', true],
    [/^금새$/g, '금세', true],
    [/설겆이/g, '설거지', true],
    [/희안/g, '희한', true],
    [/일일히/g, '일일이', true], [/깨끗히/g, '깨끗이', true], [/곰곰히/g, '곰곰이', true],
    [/오랫만/g, '오랜만', true],
    [/역활/g, '역할', true],
    [/어의없/g, '어이없', true],
    [/^구지$/g, '굳이', true],
    [/뵈요$/g, '봬요', true],
    [/(하|가|오)실려고/g, '$1시려고', true],
    [/^않(되|돼|하|해)/g, '안 $1', true],
  ];
  // 틀린 꼴이면 바른 꼴 목록(사전 제안보다 앞에 둔다)
  function commonFixes(word) {
    const w = String(word || ''), out = [];
    for (const [re, to] of COMMON) {
      re.lastIndex = 0;
      if (!re.test(w)) continue;
      re.lastIndex = 0;
      const fixed = w.replace(re, to);
      if (fixed !== w && !out.includes(fixed)) out.push(fixed);
    }
    // 여러 규칙이 함께 걸리면(안되요 → 안돼요·안됐요?) 모두 적용한 것도 넣는다
    if (out.length > 1) {
      let all = w;
      for (const [re, to] of COMMON) { re.lastIndex = 0; all = all.replace(re, to); }
      if (!out.includes(all)) out.unshift(all);
    }
    return out;
  }
  const alwaysWrong = (word) => COMMON.some(([re, , force]) => { re.lastIndex = 0; return force && re.test(String(word || '')); });

  // 제안 합치기: 자주 틀리는 말의 바른 꼴 → 사전 제안(중복·원래 낱말 빼고 limit개)
  function mergeSuggestions(word, dictSugs, limit = 6) {
    const out = [];
    for (const s of [...commonFixes(word), ...(dictSugs || [])]) {
      const v = String(s || '').trim();
      if (v && v !== word && !out.includes(v)) out.push(v);
      if (out.length >= limit) break;
    }
    return out;
  }

  // 사용자 사전 낱말 정리: 앞뒤 공백을 빼고 한 낱말(공백 없음, 1~40자)만
  function normWord(w) {
    const v = String(w ?? '').normalize('NFC').trim();
    return v && v.length <= MAX_WORD && !/\s/.test(v) ? v : '';
  }

  const spellCoreApi = { tokenize, checkable, compoundOk, commonFixes, alwaysWrong, mergeSuggestions, normWord, COMMON, MAX_WORD };
  if (typeof window !== 'undefined') window.spellCore = spellCoreApi;
  if (typeof module !== 'undefined') module.exports = spellCoreApi;
})();
