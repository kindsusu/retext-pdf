// 편집 상자를 "줄" 단위로 묶는다. 원래는 상자 = PDF 텍스트 객체 하나였다.
// Chromium·한글·엑셀이 만든 PDF는 커닝·글꼴 경계 때문에 한 줄을 수십 조각으로 쪼개므로
// 이러면 "모든 글자가 단어 단위로 표기돼 실질적으로 수정이 어렵다"(사용자 보고).
//
// 근본 원인: 줄 판정에 bounds.y0(글자 잉크의 아래끝)를 쓰면 받침·괄호·숫자 때문에
// 같은 줄이라도 글자마다 잉크 아래끝이 달라 한 줄이 여러 행으로 쪼개진다.
// (실측: workspace/회의록_초안.pdf 1쪽에서 bounds.y0 기준 행이 6개 이상으로 흩어짐.)
//
// 해결: 텍스트 행렬의 (e,f) — 기준선(baseline) 원점 — 으로 행을 나눈다.
// app/pdf-engine.js의 objects()가 이미 item.matrix/item.origin/item.scaledSize로 노출해 둔다.
// 기준선으로 묶으면 위 문서 1쪽(텍스트 객체 309개)이 정확히 15개 시각적 줄이 된다.
//
// 2026-10-15 개정(tmp/grouping 말뭉치 20건, 개정 전 4건 통과 — ezPDF(Xpdf 계열) 동작을 참고):
//   · 글자 단위 위치: objects()가 글자마다 [x, y, 진행 폭](item.glyphs)을 준다. 틈은 "앞 조각의 마지막 공백 아닌 글자 끝 → 다음 글자 시작"으로
//     잰다(진행 폭 기준이라 같은 낱말 안 글자 사이는 0, 낱말 사이는 공백 폭). 공백만 든 조각은 틈을 잇지 않는다
//     ("이름: 김영희␣×10 날짜" 가 공백 조각을 징검다리 삼아 한 상자가 되던 문제).
//   · 객체 텍스트에는 PDFium이 끼운 공백이 없다(pdf-engine objText). 조각 사이 공백은 여기서 틈을 보고 seps에 한 칸(' ')만 넣는다.
//   · 줄 잇기 판정은 줄(행)의 통계로 한다 — 아래 decideJoin 참고(양쪽 맞춤·자간·낱말 간격은 한 줄, 입력 칸·표 칸·다단은 나눈다).
//   · 위·아래 첨자(각주¹, H₂O, mc²)는 본문 줄에 붙인다. 회전 글자는 글자 방향 좌표(u: 진행, v: 기준선)에서 묶는다.
//   · 상자 순서는 읽기 순서(단: 왼→오른쪽, 단 안에서 위→아래)다.
//
// 반환 모양(소비 코드 — 편집·가리기·이동·검색 — 가 기대는 것)은 그대로다: [{ objs, seps, text, group, size, font, bounds }]
//   + line: 같은 시각적 줄(글꼴·색·크기만 달라 나뉜 상자들)의 번호(읽기 순서). 같은 line의 상자들이 한 줄의 "스타일 조각(run)"이다.
//   groupLines(objs, { mergeStyledRuns: true })이면 그 조각들을 상자 하나로 합치고 runs에 조각 범위를 싣는다(다음 단계 — 조각별 스타일을 지키며 다시 쓰기 — 용).

// ── 행(줄) 판정 ────────────────────────────────────────────────────────────
// 같은 행 판정: |Δ기준선| ≤ 이 값 × 글자크기.
// 기준선은 bounds.y0와 달리 글자마다 흔들리지 않으므로(획 하나 정도의 오차뿐) 넉넉히 잡아도 안전하다.
const ROW_BASELINE_EPS = 0.2;
// 글자 방향(텍스트 행렬의 회전각)이 이 각도(도) 안이면 같은 방향으로 묶는다.
const ANGLE_EPS_DEG = 1;
// 위·아래 첨자: 본문보다 SUPSUB_SIZE_RATIO배 이하로 작고, 기준선 차(첨자 − 본문)가 본문 크기의 −SUPSUB_DROP ~ +SUPSUB_RAISE이며,
// 본문 글자와 SUPSUB_ADJ_EM 안으로 붙어 있으면 본문 줄에 넣는다(실측 04-sup-sub.pdf: 위첨자 +0.36~+0.45, 아래첨자 −0.27, 크기 0.84배).
const SUPSUB_SIZE_RATIO = 0.9, SUPSUB_RAISE = 0.6, SUPSUB_DROP = 0.45, SUPSUB_ADJ_EM = 0.25, SUPSUB_MARKED_ADJ_EM = 1.0;

// ── 조각 잇기 판정(같은 행 안) ────────────────────────────────────────────────
// 글자 크기 차이가 이 값(pt) 이상이면 다른 글자로 보고 잇지 않는다(20c: 12 vs 11.5pt는 같은 줄). 단 첨자·작은 대문자는 예외
const SIZE_DIFF_MAX = 0.6;
// 작은 대문자(font-variant: small-caps): 같은 글꼴, 0.6배 이상 크기, 글자 사이 틈 이 값(em) 이하면 잇는다(실측 13b: 0~0.19)
const SMALLCAPS_ADJ_EM = 0.2, SMALLCAPS_MIN_RATIO = 0.6;
// 색 차이: 채널마다 이 값 이하면 같은 색(엑셀 "자동" 검정 0.02 = 5/255)
const COLOR_TOL = 16;
// 공백 글자가 없는 줄(낱말 사이를 틈으로만 띄우는 PDF)에서 줄을 잇는 틈 상한(em). ezPDF의 줄 잇기 상한과 같다
const LINE_GAP_MAX_EM = 1.5;
// 공백 글자가 있는 줄에서 공백 없는 틈이 그 줄의 보통 글자 간격(중앙값)보다 이 값(em) 넘게 넓으면 칸 경계(입력 칸·여백으로 띄운 두 번째 칸).
// 실측: 14d 여백 9px 0.62em → 나눈다, 자간 0.8em(03b)은 보통 간격 자체가 0.8이라 잇는다
const FIELD_GAP_EM = 0.5;
// 공백 글자가 이만큼 이어지면(nbsp 여러 개로 띄운 입력 칸, 14b·14c) 칸 경계
const SPACE_RUN_BREAK = 3;
// 공백 1~2개가 든 틈: 그 줄의 다른 공백 틈 중앙값 × WS_GAP_FACTOR 또는 WS_GAP_MIN_LIMIT_EM 중 큰 값까지 잇는다.
// 양쪽 맞춤 줄은 모든 낱말 틈이 고르게 넓어(02: 1~5em) 이어지고, 혼자 튀는 넓은 틈(단 사이·표 칸 + 뒤 공백)은 나뉜다
const WS_GAP_FACTOR = 1.5, WS_GAP_MIN_LIMIT_EM = 1.5;
// 단·표 칸 사이 빈 띠: 공백 없는 틈이 그 줄의 보통 간격보다 GUTTER_OUTLIER_EM 넘게 넓고(공백 있는 줄은 GUTTER_MIN_EM,
// 공백 없는 줄은 GUTTER_MIN_EM_NOSPACE 이상), 바로 위·아래 줄(줄 간격 GUTTER_PITCH_EM 이내)에도 같은 자리에 GUTTER_OVERLAP_EM 이상
// 겹치는 빈 틈이 있으면 잇지 않는다(08b 단 간격 0.4em, 09b 테두리 없는 표 0.45em).
const GUTTER_MIN_EM = 0.25, GUTTER_MIN_EM_NOSPACE = 1.0, GUTTER_OUTLIER_EM = 0.2, GUTTER_PITCH_EM = 2.5, GUTTER_OVERLAP_EM = 0.2;
// 낱말 사이 공백 넣기: 공백 글자 없는 틈 g가 T = max(ezPDF 임계, 보통 간격 + SPACE_OVER_LETTER_EM)보다 넓으면 seps에 ' ' 한 칸.
// ezPDF 임계 = (최소+최대 틈)/2, 틈은 [0, 0.2]로 자르고 1.5 넘는 틈은 빼며 결과를 [0.08, 0.2]로 자른다(기본 0.1).
// 공백 글자가 있는 줄은 만든 쪽이 공백을 직접 그렸으므로 SPACE_MIN_EXPLICIT_EM 미만의 틈에는 넣지 않는다.
const SPACE_T_MIN = 0.08, SPACE_T_MAX = 0.2, SPACE_T_DEFAULT = 0.1, SPACE_OVER_LETTER_EM = 0.1, SPACE_MIN_EXPLICIT_EM = 0.2;
// 가림 상자 다리 놓기의 허용 틈(em) — 가림 상자끼리·글자와의 사이는 이만큼 비어 있어도 이어진 것으로 본다(낱말 사이 공백 폭)
const GAP_MERGE_RATIO = 0.6;
// 세로 괘선으로 볼 비텍스트 객체의 폭 상한(pt) — 이보다 넓으면 칠해진 도형(칸 배경 등)이라 괘선이 아니다.
const RULE_MAX_WIDTH = 3;
// 세로 괘선으로 볼 비텍스트 객체의 높이 하한(pt) — 이보다 낮으면 점·장식이라 표 경계가 아니다.
const RULE_MIN_HEIGHT = 4;
// 두 조각이 모두 투명(hidden)일 때 쓰는 간격 병합 경계.
// 투명 조각은 그림 위 검색용 텍스트라 실제로 보이는 것은 그림 속 글자 한 줄이고,
// 조각의 폭·간격은 그림을 못 그리는 대체 폰트(예: 한글 그림 위의 Calibri) 기준이라 의미가 없다.
// 표 칸 사이 간격은 투명 조각에서도 3 이상으로 측정되므로(세로 괘선 검사가 여전히 칸을 분리한다)
// 3.0을 병합 경계로 잡아도 표 칸이 잘못 합쳐지지 않는다.
const HIDDEN_GAP_MERGE_RATIO = 3.0;
// 읽기 순서 계산(단 분석)을 할 최대 줄 수 — 넘으면(빽빽한 표) 위→아래, 왼→오른쪽 순서로 둔다
const ORDER_MAX_UNITS = 300;
// 단 덩어리를 끊는 세로 틈(줄 높이의 배수) — 문단 사이(1줄 안팎)는 잇고 구역 사이(08: 2.4줄)는 끊는다
const COLUMN_GAP_LINES = 2.0;

const isWs = (ch) => /\s/.test(ch);
// 폭 없는 서식 글자(U+00AD 소프트 하이픈·U+200B 등): 위치가 들쭉날쭉해(11b 실측: 앞 글자보다 0.47em 왼쪽) 틈 계산에서 뺀다. 공백으로도 세지 않는다
const isZeroWidth = (ch) => /[­​-‍⁠﻿]/.test(ch);
// 기준선(baseline) y좌표. matrix가 있고 b(기울임/회전 성분)가 거의 0이면 수평 텍스트이므로
// origin.y(=행렬의 f)를 그대로 쓴다. 회전·기울임이면 origin.y가 기울어진 선 위의 한 점이라
// 다른 조각과 그대로 비교할 수 없으므로 bounds.y0로 되돌아간다(엔진에서 matrix를 못 읽었을 때도 마찬가지).
// (줄 묶기 자체는 아래 geomOf의 v — 글자 방향 좌표의 기준선 — 를 쓴다. 이 함수는 그룹 상자 정렬용)
function baselineOf(o) {
  if (o.matrix && Math.abs(o.matrix[1]) < 1e-6) return o.origin.y;
  return o.bounds.y0;
}
// 행 안 정렬 기준 x좌표: 기준선 시작점(origin.x)이 있으면 그것, 없으면 잉크 상자의 왼쪽 끝.
function xOf(o) { return o.origin ? o.origin.x : o.bounds.x0; }
// 행렬 배율까지 반영한 실제 글자 크기. scaledSize가 없으면(비텍스트 등) size로, 그것도 없으면 0 나눗셈을 피하려 1로.
function sizeOf(o) { return (o.scaledSize != null ? o.scaledSize : o.size) || 1; }
const median = (arr) => { if (!arr.length) return 0; const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };

function unionBounds(members) {
  return members.reduce((b, o) => ({
    x0: Math.min(b.x0, o.bounds.x0), y0: Math.min(b.y0, o.bounds.y0),
    x1: Math.max(b.x1, o.bounds.x1), y1: Math.max(b.y1, o.bounds.y1),
  }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
}
function sameRow(a, b) { return Math.abs(baselineOf(a) - baselineOf(b)) <= ROW_BASELINE_EPS * Math.max(sizeOf(a), sizeOf(b)); }

// ── 조각의 글자 방향 기하 ───────────────────────────────────────────────────
// θ = 텍스트 행렬의 회전각. u = x·cosθ + y·sinθ (글자 진행 방향), v = −x·sinθ + y·cosθ (기준선 높이).
// 글자마다 [u0, u1](진행 폭 구간)과 공백 여부. glyphs가 없으면(합성 객체·옛 응답) 객체 상자를 글자 하나로 본다.
const geomCache = new WeakMap();
function geomOf(o) {
  let g = geomCache.get(o);
  if (g) return g;
  const m = o.matrix;
  const theta = m ? Math.atan2(m[1], m[0]) : 0;
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const U = (x, y) => x * cos + y * sin, V = (x, y) => -x * sin + y * cos;
  const text = o.text || '', size = sizeOf(o);
  const ox = o.origin ? o.origin.x : o.bounds.x0, oy = o.origin ? o.origin.y : o.bounds.y0;
  let glyphs;
  if (Array.isArray(o.glyphs) && o.glyphs.length === text.length) {
    glyphs = o.glyphs.map(([x, y, w], k) => { const u = U(x, y); return { u0: u, u1: u + w, ws: isWs(text[k]), zw: isZeroWidth(text[k]) }; });
  } else {
    const b = o.bounds, us = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => U(x, y));
    const u0 = Math.min(...us), u1 = Math.max(...us), t = text.trim();
    const lead = text.length - text.trimStart().length, trail = t ? text.length - text.trimEnd().length : 0;
    glyphs = [];
    for (let k = 0; k < lead; k++) glyphs.push({ u0, u1: u0, ws: true });
    if (t) {
      // 안쪽 공백은 위치를 모르므로 잉크 글자 두 개 사이의 0폭 공백으로 둔다(공백 있는 줄 판정·공백 수 세기에만 쓰인다)
      const inner = (t.match(/\s+/g) || []).length;
      glyphs.push({ u0, u1: inner ? u0 : u1, ws: false });
      if (inner) { glyphs.push({ u0, u1: u0, ws: true }); glyphs.push({ u0, u1, ws: false }); }
    }
    for (let k = 0; k < trail; k++) glyphs.push({ u0: u1, u1, ws: true });
  }
  const ink = glyphs.filter((x) => !x.ws && !x.zw);
  g = {
    theta: theta * 180 / Math.PI, size, v: V(ox, oy), uOrigin: U(ox, oy), glyphs,
    inkU0: ink.length ? Math.min(...ink.map((x) => x.u0)) : U(ox, oy),
    inkU1: ink.length ? Math.max(...ink.map((x) => x.u1)) : U(ox, oy),
    hasInk: ink.length > 0, wsOnly: !ink.length && text.length > 0, empty: !text.length,
  };
  geomCache.set(o, g);
  return g;
}
// 정렬 키: 잉크가 있으면 첫 잉크 글자, 공백 조각은 첫 글자, 빈 조각은 기준선 시작점
const keyU = (o) => { const g = geomOf(o); return g.hasInk ? g.inkU0 : g.glyphs.length ? g.glyphs[0].u0 : g.uOrigin; };

// 그룹 마크(RetextPdfGroup)가 있는 객체들 — 줄바꿈 편집으로 생긴 줄들, 사용자가 Shift 클릭으로 묶은 상자들.
// 기준선 규칙보다 우선한다: 마크가 있으면 멀리 떨어져 있어도 한 상자다.
// 상자 안 정렬·seps만 기준선으로 다시 계산한다(위→아래, 왼→오른쪽; 같은 줄이면 '', 다른 줄이면 '\n').
function buildGroupBox(members, groupId) {
  const sorted = members.slice().sort((a, b) => (sameRow(a, b) ? xOf(a) - xOf(b) : baselineOf(b) - baselineOf(a)));
  const seps = sorted.slice(1).map((o, j) => (sameRow(o, sorted[j]) ? '' : '\n'));
  const text = sorted.map((o, j) => (j ? seps[j - 1] : '') + o.text).join('');
  return { objs: sorted, seps, text, group: groupId, size: sorted[0].size, font: sorted[0].font, bounds: unionBounds(sorted) };
}

// 글자 방향이 같은(±ANGLE_EPS_DEG) 조각끼리 묶는다
function splitByAngle(items) {
  const sorted = items.slice().sort((a, b) => geomOf(a).theta - geomOf(b).theta), bins = [];
  for (const o of sorted) {
    const bin = bins[bins.length - 1];
    if (bin && geomOf(o).theta - geomOf(bin[bin.length - 1]).theta <= ANGLE_EPS_DEG) bin.push(o);
    else bins.push([o]);
  }
  return bins;
}

// 같은 방향의 조각들을 기준선(v)으로 행(줄)으로 나눈다. 위 → 아래 순서로 정렬한 뒤
// 앞 항목(대표 기준선)과 같은 행이면 그 행에 넣고, 아니면 새 행을 연다. 그 다음 첨자를 본문 행에 붙인다.
function splitIntoRows(items) {
  // 우리가 만든 첨자(v6 RetextPdfStyle sc)는 맨 뒤에 놓아 본문 행의 대표가 되지 않게 한다 — 첨자가 먼저 행을 열면 기준선이 가까운 큰 글자가 첨자 행으로 들어간다
  const sorted = items.slice().sort((a, b) => (a.style?.sc ? 1 : 0) - (b.style?.sc ? 1 : 0) || geomOf(b).v - geomOf(a).v);
  const rows = [];
  for (const o of sorted) {
    const row = rows[rows.length - 1], g = geomOf(o);
    if (row && Math.abs(g.v - row.v) <= ROW_BASELINE_EPS * Math.max(g.size, geomOf(row.rep).size)) row.items.push(o);
    else rows.push({ rep: o, v: g.v, items: [o] });
  }
  attachScripts(rows);
  return rows.filter((r) => r.items.length).map((r) => ({ items: r.items, v: r.v, size: rowSize(r.items) }));
}
// 행의 본문 크기 = 잉크 있는 조각 크기의 최댓값
function rowSize(items) { return Math.max(1, ...items.filter((o) => geomOf(o).hasInk).map((o) => geomOf(o).size)); }
// 위·아래 첨자 붙이기: 작은 글자 조각이 기준선이 조금 위·아래인 본문 행의 글자와 붙어 있으면 그 행으로 옮긴다.
// 한 번 옮긴 조각 옆의 조각도 붙을 수 있게("note¹²"의 "2") 더 옮길 것이 없을 때까지 되풀이한다.
function attachScripts(rows) {
  for (const r of rows) r.size = rowSize(r.items);
  for (let moved = true, guard = 0; moved && guard < 20; guard++) {
    moved = false;
    for (const r of rows) {
      for (const o of r.items.slice()) {
        const g = geomOf(o);
        if (!g.hasInk) continue;
        const host = rows.find((m) => m !== r && m.items.length && g.size <= SUPSUB_SIZE_RATIO * m.size && (() => {
          const d = (g.v - m.v) / m.size;
          if (d > SUPSUB_RAISE || d < -SUPSUB_DROP) return false;
          // 우리가 첨자로 만든 글자(RetextPdfStyle sc — v6 글자 모양)는 첨자임을 알므로 낱말 사이 공백 하나쯤 떨어져 있어도 붙인다
          const adj = (o.style?.sc ? SUPSUB_MARKED_ADJ_EM : SUPSUB_ADJ_EM) * m.size;
          return m.items.some((p) => { const q = geomOf(p); return q.hasInk && g.inkU0 <= q.inkU1 + adj && q.inkU0 <= g.inkU1 + adj; });
        })());
        if (!host) continue;
        r.items.splice(r.items.indexOf(o), 1);
        host.items.push(o);
        o._script = true; // 크기 다름을 줄 경계로 보지 않는다(decideJoin)
        moved = true;
      }
    }
  }
}

// a와 b(같은 행, a가 왼쪽) 사이에 표 경계로 보이는 세로 괘선이 있는지 — 있으면 잇지 않는다.
// (표 경계용 안전장치. 계약서 실측에서 인접 칸 38쌍 중 32쌍이 여기 걸린다.) 쪽 좌표로 재므로 가로 글자에만 쓴다
function hasVerticalRuleBetween(a, b, nonText) {
  const lo = a.bounds.x1, hi = b.bounds.x0;
  if (hi <= lo) return false; // 겹치는 조각 사이엔 괘선이 들어갈 틈이 없다
  return nonText.some((r) => {
    const w = r.bounds.x1 - r.bounds.x0, h = r.bounds.y1 - r.bounds.y0;
    if (!(w < RULE_MAX_WIDTH && h > RULE_MIN_HEIGHT)) return false;
    const rx = (r.bounds.x0 + r.bounds.x1) / 2;
    if (!(rx >= lo && rx <= hi)) return false;
    return r.bounds.y0 < a.bounds.y1 && r.bounds.y1 > a.bounds.y0; // y 범위가 앞 조각과 겹침
  });
}

// 가린 글자 자리 표시. 가리기는 글자를 지우고 그 자리에 가림 상자(mask)만 남기므로 앞뒤 글 사이가 벌어져
// 줄이 둘로 쪼개졌다(실측: "참석: 대표, ████, 재무팀장" → "참석: 대표, " / ", 재무팀장, 영업팀장").
// 벌어진 틈을 가림 상자가 빈틈없이 덮고 있으면 같은 줄로 잇고, 틈 자리는 이 글자로 보인다.
// 줄을 고쳐 적용해도 이 글자는 검정 사각형으로 그려지고 가림 상자가 그 위를 덮는다 — 가린 글자는 이미 지워져 있다.
const MASK_GLYPH = '■';
// 자리 표시 글자 수 = 틈 폭 / (이 값 × 글자 크기). 한글 한 글자 간격이 약 0.93em
// (실측: 회의록_초안.pdf 글자 크기 약 11pt, "대"→"표" 시작점 간격 10.2pt). 가린 "인사팀장"(틈 42.9pt) → 4글자.
const MASK_GLYPH_EM = 0.9;

// a와 b(같은 행, a가 왼쪽) 사이 틈을 가림 상자가 덮고 있으면 자리 표시 글자열, 아니면 null.
// 가림 상자끼리·글자와의 사이는 GAP_MERGE_RATIO까지 비어 있어도 이어진 것으로 본다(낱말 사이 공백 폭).
function maskBridge(a, b, nonText) {
  const lo = a.bounds.x1, hi = b.bounds.x0, size = Math.max(sizeOf(a), sizeOf(b)), tol = GAP_MERGE_RATIO * size;
  const masks = nonText
    .filter((m) => m.mask && m.bounds.x1 > lo - tol && m.bounds.x0 < hi + tol && m.bounds.y0 < a.bounds.y1 && m.bounds.y1 > a.bounds.y0)
    .sort((m, n) => m.bounds.x0 - n.bounds.x0);
  if (!masks.length) return null;
  let reach = lo;
  for (const m of masks) {
    if (m.bounds.x0 > reach + tol) return null; // 가림 상자 사이에 덮이지 않은 틈이 있다
    reach = Math.max(reach, m.bounds.x1);
  }
  if (reach < hi - tol) return null;
  const covered = Math.min(hi, reach) - Math.max(lo, masks[0].bounds.x0);
  // 틈 안을 덮은 폭이 반 글자도 안 되면(가림 상자는 옆에 있고 이 틈은 보통 낱말 사이) 다리가 아니다
  if (covered < 0.5 * MASK_GLYPH_EM * size) return null;
  return MASK_GLYPH.repeat(Math.max(1, Math.round(covered / (MASK_GLYPH_EM * size))));
}
// 조각 o가 가림 상자 안에 있는지(가린 뒤 남은 공백 조각 — 자리 표시 글자가 대신 보인다)
const insideMask = (o, nonText) => nonText.some((m) => m.mask && o.bounds.x0 >= m.bounds.x0 - 0.5 && o.bounds.x1 <= m.bounds.x1 + 0.5
  && m.bounds.y0 < o.bounds.y1 && m.bounds.y1 > o.bounds.y0);

// ── 행의 글자 흐름과 통계 ──────────────────────────────────────────────────
// 같은 글꼴이면 공백 조각을 줄의 공백으로 센다(전자계약 양식은 입력 칸 밑에 다른 글꼴의 넓은 공백 조각을 깐다 — 그건 세지 않는다)
const baseName = (f) => String(f || '').replace(/^[A-Z]{6}\+/, '');
// 우리가 고쳐 쓴 글자(대체 글꼴 "Untitled"·설치 폰트 RetextPdfFont)는 원래 글꼴의 공백 조각 옆에 놓이므로 그 공백도 센다(v6 — 굵게 바꾼 낱말 뒤 공백이 칸 경계로 보이던 문제)
const wsCounts = (w, a) => !!a && (baseName(w.font) === baseName(a.font) || !!a.fontId || baseName(a.font) === 'Untitled') && !!w.hidden === !!a.hidden;

// 행의 조각들(u 순서)을 잉크 글자 흐름으로 펴고, 이웃 잉크 글자 사이 틈 목록을 만든다.
//   gaps: [{ g(em), ws(사이 공백 글자 수), u0, u1(틈 구간), at(경계면 오른쪽 조각, 조각 안 틈이면 null) }]
// 통계: L(공백 없는 틈의 중앙값 = 보통 글자 간격), T(낱말 공백 임계), explicit(공백 글자가 낱말을 가르는 줄)
function rowStream(frags) {
  const gaps = [];
  let last = null, lastFrag = null, ws = 0;
  for (const o of frags) {
    const g = geomOf(o);
    if (g.wsOnly) { if (wsCounts(o, lastFrag)) ws += [...(o.text || '')].filter(isWs).length; continue; }
    if (!g.hasInk) continue;
    let first = true;
    for (const x of g.glyphs) {
      if (x.zw) continue;
      if (x.ws) { ws++; continue; }
      if (last) {
        const em = Math.max(last.size, g.size);
        gaps.push({ g: (x.u0 - last.u1) / em, ws, u0: last.u1, u1: x.u0, at: first ? o : null, em });
      }
      last = { u1: x.u1, size: g.size }; ws = 0; first = false;
    }
    lastFrag = o;
  }
  const only = gaps.filter((x) => !x.ws).map((x) => x.g);
  const L = only.length ? median(only) : 0;
  const c = only.filter((g) => g <= LINE_GAP_MAX_EM).map((g) => Math.min(SPACE_T_MAX, Math.max(0, g)));
  const T = c.length ? Math.min(SPACE_T_MAX, Math.max(SPACE_T_MIN, (Math.min(...c) + Math.max(...c)) / 2)) : SPACE_T_DEFAULT;
  const explicit = gaps.some((x) => x.ws > 0);
  const spaceT = Math.max(T, L + SPACE_OVER_LETTER_EM, explicit ? SPACE_MIN_EXPLICIT_EM : 0);
  // 구간(seg): 어떤 경우에도 잇지 않는 공백 없는 틈(칸 경계 — decideJoin의 'field')에서 행을 나눈다. 공백 틈의 중앙값은 같은 구간 안에서만 잰다.
  // 행 전체로 재면 다른 단의 글이 기준을 바꾼다(v6 실측 08a: 왼쪽 단을 아래로 밀자 오른쪽 양쪽 맞춤 줄과 같은 행에 보통 간격의 새 줄이 와
  // 중앙값이 0.3em으로 떨어지고, 오른쪽 줄의 넓은 낱말 틈(3~4em)이 모두 끊겨 낱말마다 상자가 됐다)
  let seg = 0;
  for (const x of gaps) {
    if (!x.ws && x.g > (explicit ? L + FIELD_GAP_EM : LINE_GAP_MAX_EM)) seg++;
    x.seg = seg;
  }
  return { gaps, L, spaceT, explicit, wsGaps: gaps.filter((x) => x.ws > 0 && x.ws < SPACE_RUN_BREAK) };
}

// 단·표 칸 사이 빈 띠: 바로 위·아래 행에 [u0, u1]과 GUTTER_OVERLAP_EM 이상 겹치는 빈 틈이 있는가
function gutterAligned(row, u0, u1, em) {
  for (const n of [row.prev, row.next]) {
    if (!n || Math.abs(n.v - row.v) > GUTTER_PITCH_EM * Math.max(em, n.size)) continue;
    if (n.stream.gaps.some((x) => Math.min(u1, x.u1) - Math.max(u0, x.u0) >= GUTTER_OVERLAP_EM * em)) return true;
  }
  return false;
}

// 앞 조각 a(마지막 잉크 조각) 다음에 b를 이을지. 반환: { join, space, reason }
//   reason: 'style'(글꼴·색·크기만 다름 — 같은 시각적 줄의 다른 run) | 'field'(칸 경계) | 'gutter' | 'rule' | 'spaces'(공백 여러 개)
function decideJoin(row, a, b, gap, nonText, box) {
  const ga = geomOf(a), gb = geomOf(b), em = gap.em;
  const g = gap.g, ws = gap.ws, st = row.stream, flat = Math.abs(ga.theta) <= ANGLE_EPS_DEG;
  const sameFont = baseName(a.font) === baseName(b.font) && (!a.fontId || !b.fontId || a.fontId === b.fontId);
  const sameHidden = !!a.hidden === !!b.hidden;
  const sameColor = [0, 1, 2].every((k) => Math.abs((a.color?.[k] ?? 0) - (b.color?.[k] ?? 0)) <= COLOR_TOL); // 알파 제외
  const smallCaps = sameFont && !ws && g <= SMALLCAPS_ADJ_EM && Math.min(ga.size, gb.size) >= SMALLCAPS_MIN_RATIO * Math.max(ga.size, gb.size);
  const sameSize = Math.abs(ga.size - gb.size) < SIZE_DIFF_MAX || Math.abs(gb.size - box.maxSize) < SIZE_DIFF_MAX || !!b._script || !!a._script || smallCaps;
  const alike = sameFont && sameHidden && sameColor && sameSize;
  if (flat && hasVerticalRuleBetween(a, b, nonText)) return { join: false, reason: 'rule' };
  // 틈만 보고 판정(글꼴 등은 그 다음 — 이을 틈인데 글꼴만 다르면 'style')
  let ok, reason = 'field';
  if (a.hidden && b.hidden) ok = g < HIDDEN_GAP_MERGE_RATIO;
  else if (ws >= SPACE_RUN_BREAK) { ok = false; reason = 'spaces'; }
  else if (ws > 0) {
    const others = st.wsGaps.filter((x) => x !== gap && x.seg === gap.seg).map((x) => x.g);
    ok = g <= Math.max(WS_GAP_MIN_LIMIT_EM, WS_GAP_FACTOR * median(others));
  } else {
    ok = st.explicit ? g <= st.L + FIELD_GAP_EM : g <= LINE_GAP_MAX_EM;
    if (ok && g >= (st.explicit ? GUTTER_MIN_EM : GUTTER_MIN_EM_NOSPACE) && g > st.L + GUTTER_OUTLIER_EM && gutterAligned(row, gap.u0, gap.u1, em)) { ok = false; reason = 'gutter'; }
  }
  if (!ok) return { join: false, reason };
  if (!alike) return { join: false, reason: 'style' };
  return { join: true, space: !ws && g > st.spaceT };
}

// 한 행 안에서 u 순서로 훑으며 이어붙일 조각을 상자(run)로 묶는다. 같은 시각적 줄인데 스타일만 달라 나뉜 run들은 line 단위로 모인다.
// 반환: [{ runs: [box…], seps: [run 사이 글자] }] (line 단위)
function mergeRow(row, nonText) {
  const frags = row.items.slice().sort((a, b) => keyU(a) - keyU(b));
  const stream = row.stream;
  const gapAt = new Map(stream.gaps.filter((x) => x.at).map((x) => [x.at, x]));
  const lines = [];
  let line = null, box = null, lastInk = null, pending = [];
  const startBox = (o) => { box = { members: [o], seps: [], maxSize: geomOf(o).size }; };
  for (const o of frags) {
    const g = geomOf(o);
    if (!g.hasInk) {
      // 공백 조각·빈 조각은 다음 잉크 조각을 이을 때 함께 넣는다(이어지지 않으면 어느 상자에도 안 들어간다 — 예전과 같다).
      // 빈 조각(겹쳐 그린 가짜 굵게 사본 등)은 앞 상자와 같은 글꼴·크기이고 겹쳐 있을 때만 — 편집 때 함께 지워져야 한다
      if (!box) continue;
      if (g.wsOnly && wsCounts(o, lastInk)) pending.push(o);
      else if (g.empty && lastInk && baseName(o.font) === baseName(lastInk.font) && Math.abs(g.size - geomOf(lastInk).size) < SIZE_DIFF_MAX
        && g.uOrigin <= geomOf(lastInk).inkU1 + 0.1 * g.size) { box.members.push(o); box.seps.push(''); }
      continue;
    }
    if (!box) { startBox(o); line = { runs: [], seps: [] }; lastInk = o; pending = []; continue; }
    const gap = gapAt.get(o) || { g: 0, ws: 0, u0: g.inkU0, u1: g.inkU0, em: g.size };
    const flat = Math.abs(g.theta) <= ANGLE_EPS_DEG;
    // 가린 자리: 가림 상자가 틈을 덮으면 자리 표시(■)로 잇는다. 틈 안의 공백 조각(가려서 비운 글자)은 글을 보태지 않는다
    // (괘선·글꼴 검사는 그대로 — 가림 상자가 덮어도 표 칸 경계는 넘지 않는다)
    const bridge = flat && gap.g > 0.3 ? maskBridge(lastInk, o, nonText) : null;
    const d = decideJoin(row, lastInk, o, bridge ? { ...gap, ws: 0, g: 0 } : gap, nonText, box);
    if (d.join) {
      for (const w of pending) {
        const blank = bridge && insideMask(w, nonText);
        box.members.push(blank ? { ...w, text: '', masked: true } : w); box.seps.push('');
      }
      box.members.push(o); box.seps.push(bridge && !d.reason ? bridge : d.space ? ' ' : '');
      box.maxSize = Math.max(box.maxSize, g.size);
    } else {
      line.runs.push(box);
      if (d.reason === 'style') {
        // 같은 줄의 다음 run — 사이 공백 조각은 앞 run 끝에 둔다(글자 대응은 조각 단위라 어느 쪽이든 맞다)
        for (const w of pending) { box.members.push(w); box.seps.push(''); }
        line.seps.push(!gap.ws && gap.g > stream.spaceT ? ' ' : '');
      } else { lines.push(line); line = { runs: [], seps: [] }; }
      startBox(o);
    }
    lastInk = o; pending = [];
  }
  if (box) { line.runs.push(box); lines.push(line); }
  return lines.map((l) => ({ runs: l.runs.map(finishBox), seps: l.seps }));
}
function finishBox(box) {
  const { members, seps } = rejoinParts(box.members, box.seps);
  return {
    objs: members, seps, text: members.map((o, j) => (j ? seps[j - 1] : '') + (o.text || '')).join(''),
    group: null, size: members[0].size, font: members[0].font, bounds: unionBounds(members),
  };
}

// ── 읽기 순서 ──────────────────────────────────────────────────────────────
// 줄(line) 단위로 Breuel의 순서 규칙을 쓴다(단 분석):
//   ① 가로 범위가 겹치면 위의 것이 먼저
//   ② a가 b의 완전히 왼쪽이고, 둘 사이 높이에 a·b 둘 다와 가로로 겹치는 줄(제목처럼 단을 가로지르는 줄)이 없으면 a가 먼저
// 그 다음 위상 정렬(가능한 것 중 가장 위, 같으면 가장 왼쪽 먼저). 단 안에서는 위→아래, 단은 왼→오른쪽이 된다(08·19d).
function readingOrder(units) {
  const n = units.length;
  const top = (a, b) => b.bounds.y1 - a.bounds.y1 || a.bounds.x0 - b.bounds.x0;
  if (n > ORDER_MAX_UNITS) return units.slice().sort(top);
  const B = units.map((u) => ({ ...u.bounds, yc: (u.bounds.y0 + u.bounds.y1) / 2 }));
  const eps = 0.5;
  // 단 덩어리: 위아래로 이어진(가로 범위가 반 이상 겹치고 세로 틈이 줄 높이의 COLUMN_GAP_LINES배 이하) 줄들의 아래끝.
  // 규칙 ②에 "a가 b 단 덩어리의 아래끝보다 위에서 시작할 것"을 더한다 — 위아래로 쌓인 두 다단 구역(08a·08b)에서
  // 아래 구역의 왼쪽 단이 위 구역의 오른쪽 단보다 먼저 오지 않게 한다(사이에 단을 가로지르는 제목이 없어도)
  const bottom = new Array(units.length);
  {
    const ord = B.map((b, k) => k).sort((p, q) => B[q].y1 - B[p].y1);
    const chainOf = new Array(units.length), chainBottom = [];
    for (const k of ord) {
      const u = B[k];
      let best = -1;
      for (const p of ord) {
        if (chainOf[p] == null || p === k) continue;
        const q = B[p], ov = Math.min(u.x1, q.x1) - Math.max(u.x0, q.x0);
        if (q.y0 < u.y1 - eps || ov < 0.5 * Math.min(u.x1 - u.x0, q.x1 - q.x0)) continue;
        if (best < 0 || q.y0 < B[best].y0) best = p;
      }
      const h = Math.max(u.y1 - u.y0, best >= 0 ? B[best].y1 - B[best].y0 : 0);
      if (best >= 0 && B[best].y0 - u.y1 <= COLUMN_GAP_LINES * h) chainOf[k] = chainOf[best];
      else { chainOf[k] = chainBottom.length; chainBottom.push(Infinity); }
      chainBottom[chainOf[k]] = Math.min(chainBottom[chainOf[k]], u.y0);
    }
    for (let k = 0; k < units.length; k++) bottom[k] = chainBottom[chainOf[k]];
  }
  const before = (i, j) => {
    const a = B[i], b = B[j];
    if (a.x0 < b.x1 - eps && b.x0 < a.x1 - eps) return a.yc > b.yc + eps || (Math.abs(a.yc - b.yc) <= eps && a.x0 < b.x0);
    if (!(a.x1 <= b.x0 + eps) || a.y1 < bottom[j] - eps) return false;
    const lo = Math.min(a.yc, b.yc), hi = Math.max(a.yc, b.yc);
    for (let k = 0; k < n; k++) {
      if (k === i || k === j) continue;
      const c = B[k];
      if (c.yc > lo + eps && c.yc < hi - eps && c.x0 < a.x1 && c.x1 > b.x0) return false;
    }
    return true;
  };
  const indeg = new Array(n).fill(0), out = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j && before(i, j)) { out[i].push(j); indeg[j]++; }
  const done = new Array(n).fill(false), order = [];
  for (let step = 0; step < n; step++) {
    let pick = -1;
    for (let k = 0; k < n; k++) if (!done[k] && indeg[k] === 0 && (pick < 0 || top(units[k], units[pick]) < 0)) pick = k;
    if (pick < 0) for (let k = 0; k < n; k++) if (!done[k] && (pick < 0 || top(units[k], units[pick]) < 0)) pick = k; // 순환이면 가장 위의 것
    done[pick] = true; order.push(units[pick]);
    for (const j of out[pick]) indeg[j]--;
  }
  return order;
}

// ── 객체 안의 칸 경계(15d) ─────────────────────────────────────────────────
// 한 텍스트 객체가 TJ 안의 큰 점프(예: [(Left field) -4000 (Right field)])로 두 칸을 그리면 객체 단위로는 나눌 수 없었다.
// 잉크 글자 사이 틈이 PART_SPLIT_EM 이상인 자리에서 객체를 "부분"으로 나눠 다른 조각처럼 판정한다(사이 공백은 앞 부분 끝에 둔다).
// 부분은 원래 객체의 사본에 partFrom(객체 글 안의 시작 위치)·partOf(원래 객체)를 싣는다 — idx는 같다.
// 판정 결과 다시 이어지면(낱말 사이 틈이었다) finishBox가 원래 객체로 되돌리므로 보통 줄은 예전과 똑같다.
// 소비 코드: 가리기 위치(index.html mapRangeToParts)는 partFrom만큼 더하고, 편집은 /api/pdf/edit-runs가 그 자리에서 객체를 실제로 가른다
const PART_SPLIT_EM = 1.0;
function splitParts(o) {
  const t = o.text || '';
  if (o.hidden || !o.matrix || !Array.isArray(o.glyphs) || o.glyphs.length !== t.length || t.length < 2) return [o];
  const g = geomOf(o);
  if (Math.abs(g.theta) > ANGLE_EPS_DEG) return [o];
  const cuts = [];
  let last = -1;
  g.glyphs.forEach((x, k) => {
    if (x.ws || x.zw) return;
    if (last >= 0 && (x.u0 - g.glyphs[last].u1) / g.size >= PART_SPLIT_EM) cuts.push(k);
    last = k;
  });
  if (!cuts.length) return [o];
  const ends = [0, ...cuts, t.length];
  return ends.slice(0, -1).map((a, j) => partOf(o, a, ends[j + 1]));
}
function partOf(o, a, b) {
  if (a === 0 && b === (o.text || '').length) return o;
  const gl = o.glyphs.slice(a, b), text = o.text.slice(a, b);
  const ink = gl.filter((q, k) => !isWs(text[k]));
  const x0 = a === 0 ? o.bounds.x0 : gl[0][0];
  const x1 = b === o.text.length ? o.bounds.x1 : Math.max(x0, ...(ink.length ? ink : gl).map((q) => q[0] + q[2]));
  const m = o.matrix.slice(); m[4] = gl[0][0]; m[5] = gl[0][1];
  return { ...o, text, glyphs: gl, matrix: m, origin: { x: gl[0][0], y: gl[0][1] }, bounds: { x0, y0: o.bounds.y0, x1, y1: o.bounds.y1 }, partFrom: a, partOf: o };
}
// 상자 안에서 이웃한 같은 객체의 부분들(이어 붙은 글자 범위)을 다시 하나로(전부면 원래 객체로). 사이 글(seps)도 함께 뺀다
function rejoinParts(members, seps) {
  const m2 = [members[0]], s2 = [];
  for (let k = 1; k < members.length; k++) {
    const p = m2[m2.length - 1], q = members[k];
    if (p.partOf && q.partOf === p.partOf && p.partFrom + p.text.length === q.partFrom) { m2[m2.length - 1] = partOf(p.partOf, p.partFrom, q.partFrom + q.text.length); continue; }
    m2.push(q); s2.push(seps[k - 1]);
  }
  return { members: m2, seps: s2 };
}

// ── 문단(9번 — ezPDF "문장 수정"의 문단 블록) ─────────────────────────────────
// groupLines(…, { mergeStyledRuns: true })의 상자(시각적 줄 하나 = 상자 하나)를 읽기 순서대로 훑어 이어지는 줄을 문단으로 묶는다:
//   · 글자 크기(줄의 본문 크기) 차 ≤ PARA_SIZE_TOL pt · 아래로 내려감(위로 뛰지 않음)
//   · 줄 간격(기준선 차): 첫 두 줄은 PARA_PITCH_MIN_EM~PARA_PITCH_MAX_EM × 크기, 그 뒤는 첫 간격의 ±PARA_PITCH_TOL(문단 사이 여백이 있으면 끊긴다)
//   · 같은 단: 가로로 겹치고 왼쪽 끝 차 ≤ PARA_ALIGN_EM × 크기(둘째 줄에서는 첫 줄 들여쓰기를 PARA_INDENT_EM까지 허용)
//   · 같은 행에 다른 상자가 있는 줄(다단·표 칸·입력 칸)·묶음 상자(group)·회전 줄은 혼자 문단 — 표의 한 열이 문단으로 잡혀 다시 흘리면 칸이 무너진다
//   · 글머리 기호·번호(•, -, 1., 가., ① …)로 시작하는 줄은 새 문단
// 실측(app/test-data/grouping/01): 11pt 본문 줄 간격 18.75pt(1.7em), 위 8pt 설명 줄과는 크기로 갈린다
const PARA_SIZE_TOL = 1, PARA_PITCH_MIN_EM = 0.8, PARA_PITCH_MAX_EM = 2.2, PARA_PITCH_TOL = 0.1, PARA_ALIGN_EM = 1.0, PARA_INDENT_EM = 4;
const BULLET_RE = /^\s*(?:[•·∙◦▪▫■□●○◆◇▶►–—\-*]\s|\(?\d{1,3}[.)]\s|\(?[가-힣A-Za-z][.)]\s|[①-⑳])/;
function lineMetrics(box) {
  const ink = box.objs.filter((o) => (o.text || '').trim() && o.matrix);
  if (!ink.length) return null;
  const size = Math.max(...ink.map(sizeOf)), main = ink.find((o) => sizeOf(o) >= size - 0.01);
  return { size, y: main.origin.y, flat: ink.every((o) => Math.abs(geomOf(o).theta) <= ANGLE_EPS_DEG) };
}
function groupParagraphs(boxes) {
  const info = boxes.map((b) => ({ b, m: lineMetrics(b) }));
  const solo = (x) => !x.m || !x.m.flat || x.b.group || info.some((y) => y !== x && y.m && Math.abs(y.m.y - x.m.y) <= ROW_BASELINE_EPS * Math.max(x.m.size, y.m.size)
    && (y.b.bounds.x0 >= x.b.bounds.x1 - 0.5 || y.b.bounds.x1 <= x.b.bounds.x0 + 0.5));
  const paras = [];
  let cur = null;
  for (const x of info) {
    const ok = cur && !solo(x) && (() => {
      const last = cur.items[cur.items.length - 1], a = last.m, b = x.m, size = Math.max(a.size, b.size);
      if (Math.abs(a.size - b.size) > PARA_SIZE_TOL) return false;
      const pitch = a.y - b.y;
      if (cur.items.length === 1 ? (pitch < PARA_PITCH_MIN_EM * size || pitch > PARA_PITCH_MAX_EM * size) : Math.abs(pitch - cur.pitch) > PARA_PITCH_TOL * cur.pitch) return false;
      const A = last.b.bounds, B = x.b.bounds;
      if (!(B.x0 < A.x1 && B.x1 > A.x0)) return false;
      const dx = A.x0 - B.x0; // 앞 줄이 오른쪽으로 들어간 정도
      if (cur.items.length === 1 ? (dx < -PARA_ALIGN_EM * size || dx > PARA_INDENT_EM * size) : Math.abs(dx) > PARA_ALIGN_EM * size && Math.abs(cur.items[1].b.bounds.x0 - B.x0) > PARA_ALIGN_EM * size) return false;
      return !BULLET_RE.test(x.b.text);
    })();
    if (ok) { if (cur.items.length === 1) cur.pitch = cur.items[0].m.y - x.m.y; cur.items.push(x); }
    else { cur = { items: [x], pitch: 0, solo: solo(x) }; paras.push(cur); }
    if (cur.solo) cur = null; // 혼자 문단 뒤에는 새 문단
  }
  return paras.map((p) => ({ boxes: p.items.map((x) => x.b), text: p.items.map((x) => x.b.text).join('\n') }));
}

// objs -> [{ objs, seps, text, group, size, font, bounds, line }]
// 반환 모양은 그대로 유지한다 — 뒤따르는 편집·가리기·이동·검색 코드가 그대로 동작해야 한다.
// opts.mergeStyledRuns: 글꼴·색·크기만 달라 나뉜 같은 줄의 run들을 상자 하나로 합친다(runs: [{ from, to(objs 범위), font, size, color, fontId }]).
//   기본(false)은 예전처럼 run마다 상자 — 상자를 고쳐 쓰면 첫 조각의 글꼴로 다시 그리므로 run별 스타일 보존이 준비되기 전에는 켜지 않는다.
function groupLines(objs, opts = {}) {
  const texts = objs.filter((o) => o.type === 'text' && o.bounds);
  const nonText = objs.filter((o) => o.type !== 'text' && o.bounds); // 세로 괘선·가림 상자 판정용
  const grouped = new Map(), ungrouped = [];
  for (const o of texts) {
    if (o.group) { if (!grouped.has(o.group)) grouped.set(o.group, []); grouped.get(o.group).push(o); }
    else ungrouped.push(...splitParts(o)); // 객체 안 큰 점프(15d)는 부분으로 나눠 판정한다
  }
  const units = []; // 읽기 순서를 매길 단위: { boxes, seps, bounds }
  for (const [gid, members] of grouped) { const b = buildGroupBox(members, gid); units.push({ boxes: [b], seps: [], bounds: b.bounds }); }
  for (const bin of splitByAngle(ungrouped)) {
    const rows = splitIntoRows(bin);
    rows.forEach((r, k) => { r.prev = rows[k - 1]; r.next = rows[k + 1]; r.stream = rowStream(r.items.slice().sort((a, b) => keyU(a) - keyU(b))); });
    for (const row of rows) {
      for (const l of mergeRow(row, nonText)) units.push({ boxes: l.runs, seps: l.seps, bounds: unionBounds(l.runs.map((b) => ({ bounds: b.bounds }))) });
    }
  }
  // 공백뿐인 상자는 만들지 않는다. 한 줄을 고치면 나머지 조각은 공백(' ')만 남는데(첫 조각이 줄 전체 글을 받는다),
  // 그 빈 조각들이 각각 상자가 되면 편집 직후 화면에 눌러도 아무 것도 없는 작은 상자가 十여 개 생긴다(실측: 15 → 31개).
  // 줄 안에 끼어 있는 공백 조각은 여기서 걸러지지 않는다 — 이미 앞뒤 글자와 한 상자로 묶여 text에 그대로 남는다.
  const visible = units.map((u) => {
    const keep = u.boxes.map((b) => (b.text || '').trim() !== '');
    return { ...u, boxes: u.boxes.filter((b, k) => keep[k]), seps: u.seps.filter((s, k) => keep[k] && keep[k + 1]) };
  }).filter((u) => u.boxes.length);
  const out = [];
  readingOrder(visible).forEach((u, line) => {
    if (opts.mergeStyledRuns && u.boxes.length > 1) {
      const objs2 = [], seps2 = [], runs = [];
      u.boxes.forEach((b, k) => {
        if (k) seps2.push(u.seps[k - 1] || '');
        runs.push({ from: objs2.length, to: objs2.length + b.objs.length, font: b.font, size: b.size, color: b.objs[0].color, fontId: b.objs[0].fontId || null });
        objs2.push(...b.objs); seps2.push(...b.seps);
      });
      out.push({ objs: objs2, seps: seps2, text: objs2.map((o, j) => (j ? seps2[j - 1] : '') + (o.text || '')).join(''),
        group: null, size: u.boxes[0].size, font: u.boxes[0].font, bounds: u.bounds, line, runs });
    } else for (const b of u.boxes) out.push({ ...b, line });
  });
  return out;
}

if (typeof window !== 'undefined') { window.groupLines = groupLines; window.groupParagraphs = groupParagraphs; }
if (typeof module !== 'undefined') module.exports = { groupLines, groupParagraphs };
