// v6 Wave D: PDF → Markdown / 텍스트 내보내기. 순수 계산 — 엔진·파일을 만지지 않는다(서버가 쪽마다 objects()·pageSize()를 넘긴다).
//   · 읽기 순서: text-grouping.js의 groupLines(단: 왼→오른쪽, 단 안에서 위→아래)·groupParagraphs(문단)
//   · 제목: 문서 전체에서 글자 수가 가장 많은 크기를 본문으로 보고, 그보다 뚜렷이 큰 크기를 큰 순서대로 # · ## · ###
//   · 목록: 글머리 글자(•·-·▪ …)·번호(1. 2)) 또는 줄 왼쪽의 작은 도형(Chromium·워드가 글머리를 도형으로 그린다) → '- ' · '1. '
//   · 굵게·기울임: 글꼴 이름(Bold·Italic)·글자 행렬 기울기·이 앱의 가짜 굵게/기울임 표시 → **…** · _…_
//   · 표: 같은 기준선에 칸이 둘 이상인 줄이 이어지고 칸이 세로로 맞으면 GFM 표(테두리 유무 상관없이). 아니면 줄 그대로
//   · 머리말·꼬리말: 위·아래 띠(쪽 높이 12%)에서 여러 쪽에 되풀이되는 줄(숫자는 같은 것으로 본다)과 쪽 번호 모양 줄을 뺀다(선택)
//   · 그림: 빼거나(omit) 자리만 표시해 서버가 PNG로 그려 .md 옆에 저장한다(files)
(function () {
  const TG = typeof module !== 'undefined' && typeof require === 'function' ? require('./text-grouping') : window;
  const { groupLines, groupParagraphs } = TG;

  const BAND = 0.12;                // 머리말·꼬리말을 찾는 위·아래 띠(쪽 높이 비율)
  const HEADING_RATIO = 1.15, HEADING_MIN_PT = 1.5; // 제목: 본문 크기의 1.15배 이상이고 1.5pt 이상 큰 크기
  const TEXT_BULLET = /^\s*([•·∙◦▪▫■□●○◆◇▶►‣⁃–—*\-+])\s+/;
  const NUMBERED = /^\s*\(?(\d{1,3})[.)]\s+/;
  const PAGE_NUM = /^(?:[-–—\s]*\d{1,5}[-–—\s]*|\d{1,5}\s*\/\s*\d{1,5}|\d{1,5}\s*쪽|page\s*\d{1,5}(?:\s*of\s*\d{1,5})?|-\s*\d{1,5}\s*-)$/i;
  const CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯豈-﫿＀-￯]/;

  const sizeOf = (o) => (o.scaledSize != null ? o.scaledSize : o.size) || 1;
  const baseFont = (o) => String(o.font || '').replace(/^[A-Z]{6}\+/, '');
  function isBold(o) {
    if (o.style && (o.style.fb === '1' || o.style.fb === 1 || o.style.fb === true)) return true;
    if (/bold|black|heavy|semibold|demibold|extrabold|ultrabold|[-,]w[6-9]\b/i.test(baseFont(o))) return true;
    return o.renderMode === 2 && o.strokeWidth > 0; // 채움+외곽선 = 워드의 가짜 굵게
  }
  function isItalic(o) {
    if (o.style && (o.style.fi === '1' || o.style.fi === 1 || o.style.fi === true)) return true;
    if (/italic|oblique|kursiv/i.test(baseFont(o))) return true;
    const m = o.matrix;
    if (!m) return false;
    const a = m[0], b = m[1], c = m[2], d = m[3];
    if (Math.abs(b) > 0.01 * Math.abs(a)) return false; // 돌린 글자는 보지 않는다
    return Math.abs(d) > 0 && c / d > 0.12;             // 오른쪽으로 기운 글자(합성 기울임)
  }
  // 상자(시각적 줄)의 잣대: 본문 크기·기준선·왼쪽·오른쪽
  function lineInfo(box) {
    const ink = box.objs.filter((o) => (o.text || '').trim());
    const size = Math.max(1, ...ink.map(sizeOf));
    const main = ink.find((o) => sizeOf(o) >= size - 0.01) || box.objs[0];
    const y = main && main.origin ? main.origin.y : box.bounds.y0;
    return { size, y, x0: box.bounds.x0, x1: box.bounds.x1, top: box.bounds.y1, bottom: box.bounds.y0 };
  }
  const normText = (s) => String(s || '').replace(/­/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const hfKey = (t) => normText(t).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();

  // ── 쪽 하나 → 상자(줄) 목록. marks: 이 앱이 넣은 쪽 번호·머리말·꼬리말·베이츠·워터마크 글자는 내용이 아니다 ──
  function pageLines(pg, opts) {
    const objs = (pg.objs || []).filter((o) => !o.watermark && !(opts.stripHeaderFooter && (o.pageNum || o.headerFooter || o.bates)));
    const boxes = groupLines(objs, { mergeStyledRuns: true });
    return boxes.map((b, k) => ({ box: b, k, ...lineInfo(b) }));
  }
  // 문서 전체에서 위·아래 띠에 되풀이되는 줄의 열쇠(숫자 무시)
  function repeatedKeys(pages, perPage) {
    const count = new Map();
    perPage.forEach((lines, p) => {
      const h = pages[p].h || 0, seen = new Set();
      for (const l of lines) {
        if (!(l.bottom > h * (1 - BAND) || l.top < h * BAND)) continue;
        const key = hfKey(l.box.text);
        if (!key || seen.has(key)) continue;
        seen.add(key); count.set(key, (count.get(key) || 0) + 1);
      }
    });
    const need = Math.max(2, Math.ceil(pages.length * 0.5));
    return new Set([...count].filter(([, n]) => n >= need).map(([k]) => k));
  }
  const isHeaderFooter = (l, h, keys) => (l.bottom > h * (1 - BAND) || l.top < h * BAND)
    && (keys.has(hfKey(l.box.text)) || PAGE_NUM.test(normText(l.box.text).trim()));

  // ── 표 찾기: 같은 기준선에 서로 떨어진 칸이 둘 이상인 행이 이어지고, 가장 칸이 많은 행의 칸 자리에 다른 행의 칸이 하나씩 들어맞는다 ──
  function findTables(lines, pageW) {
    const rows = [];
    for (const l of lines.slice().sort((a, b) => b.y - a.y)) {
      const r = rows[rows.length - 1];
      if (r && Math.abs(r.y - l.y) <= 0.5 * Math.max(r.size, l.size)) { r.cells.push(l); r.size = Math.max(r.size, l.size); }
      else rows.push({ y: l.y, size: l.size, cells: [l] });
    }
    for (const r of rows) r.cells.sort((a, b) => a.x0 - b.x0);
    const multi = (r) => r.cells.length >= 2 && r.cells.every((c, k) => !k || c.x0 >= r.cells[k - 1].x1 + 0.2 * c.size);
    const tables = [];
    let run = [];
    const flush = () => {
      if (run.length >= 2) { const t = makeTable(run, pageW); if (t) tables.push(t); }
      run = [];
    };
    for (const r of rows) {
      const prev = run[run.length - 1];
      if (multi(r) && (!prev || prev.y - r.y <= 3.2 * Math.max(prev.size, r.size))) run.push(r);
      else { flush(); if (multi(r)) run.push(r); }
    }
    flush();
    return tables;
  }
  function makeTable(rows, pageW) {
    const ref = rows.reduce((a, b) => (b.cells.length > a.cells.length ? b : a));
    const cols = ref.cells.map((c) => ({ x0: c.x0, x1: c.x1 }));
    const grid = [];
    for (const r of rows) {
      const line = cols.map(() => []);
      for (const c of r.cells) {
        let best = -1, bestScore = -Infinity;
        cols.forEach((col, k) => {
          const ov = Math.min(col.x1, c.x1) - Math.max(col.x0, c.x0);
          const score = ov > 0 ? ov : -Math.abs((col.x0 + col.x1) / 2 - (c.x0 + c.x1) / 2);
          if (score > bestScore) { bestScore = score; best = k; }
        });
        line[best].push(c);
      }
      if (line.some((cell) => cell.length > 1)) return null; // 한 칸에 두 조각 — 표가 아니다
      grid.push(line);
    }
    // 다단 글(두 단, 각 단이 쪽 폭의 30% 이상·긴 줄)은 표가 아니다 — 읽기 순서(단별)를 그대로 쓴다
    if (cols.length === 2) {
      const span = (k) => { const xs = grid.map((l) => l[k][0]).filter(Boolean); return Math.max(...xs.map((c) => c.x1)) - Math.min(...xs.map((c) => c.x0)); };
      const avgLen = rows.flatMap((r) => r.cells).reduce((n, c) => n + normText(c.box.text).length, 0) / rows.reduce((n, r) => n + r.cells.length, 0);
      if ((span(0) >= pageW * 0.3 && span(1) >= pageW * 0.3) || avgLen > 40) return null;
    }
    const all = rows.flatMap((r) => r.cells);
    return { grid: grid.map((l) => l.map((cell) => (cell[0] ? cell[0] : null))), lines: new Set(all), first: Math.min(...all.map((c) => c.k)), top: Math.max(...all.map((c) => c.top)) };
  }

  // ── 줄 하나의 글 조각(굵게·기울임) ──
  function segments(box) {
    const objs = box.objs, seps = box.seps || [];
    const out = [];
    objs.forEach((o, j) => {
      const sep = j ? seps[j - 1] || '' : '';
      const t = normText(o.text || '');
      const st = { b: isBold(o), i: isItalic(o) };
      const last = out[out.length - 1];
      if (last && last.b === st.b && last.i === st.i) last.text += sep + t;
      else out.push({ text: (last ? sep : '') + t, ...st });
    });
    return out;
  }
  const MD_ESC = /([\\`*_[\]<>])/g;
  const escInline = (s) => s.replace(MD_ESC, '\\$1');
  function styledText(box, { md, plainStyle }) {
    if (!md) return normText(box.text);
    const segs = segments(box);
    return segs.map((s) => {
      const lead = s.text.match(/^\s*/)[0], trail = s.text.slice(lead.length).match(/\s*$/)[0], core = s.text.trim();
      if (!core) return s.text;
      const e = escInline(core);
      const b = s.b && !plainStyle?.b, i = s.i && !plainStyle?.i;
      return lead + (b && i ? `**_${e}_**` : b ? `**${e}**` : i ? `_${e}_` : e) + trail;
    }).join('');
  }
  // v6 Wave E: Word·한글 내보내기용 글 조각(runs) — 굵게·기울임에 더해 색·크기·글꼴까지 같은 것끼리 묶는다.
  //   run: { text, b, i, color('#rrggbb'), size(pt, 0.5 단위), font(글꼴 이름 — 서브셋 접두어·굵기 꼬리를 뗀 것) }
  const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v || 0))).toString(16).padStart(2, '0');
  const familyOf = (o) => baseFont(o).replace(/[-,]?(PSMT|MT)$/, '').replace(/[-,]?(bold|italic|oblique|regular|medium|light|semibold|demibold|heavy)+$/i, '').trim();
  const sameStyle = (a, b) => a.b === b.b && a.i === b.i && a.color === b.color && a.size === b.size && a.font === b.font;
  function richRuns(box) {
    const out = [], seps = box.seps || [];
    box.objs.forEach((o, j) => {
      const sep = j ? seps[j - 1] || '' : '';
      const t = normText(o.text || '');
      const c = o.color || [0, 0, 0];
      const st = { b: isBold(o), i: isItalic(o), color: '#' + hex2(c[0]) + hex2(c[1]) + hex2(c[2]), size: Math.round(sizeOf(o) * 2) / 2, font: familyOf(o) };
      const last = out[out.length - 1];
      if (last && (sameStyle(last, st) || !t.trim())) last.text += sep + t; // 같은 모양이거나 빈 조각이면 앞 조각에 붙인다
      else { if (last) last.text += sep; out.push({ text: t, ...st }); }
    });
    return out.filter((r) => r.text);
  }
  // 여러 줄을 한 문단의 runs로 — 줄 잇기 규칙은 joinLines와 같다(하이픈 · 줄 끝 공백 · 한글끼리 붙임)
  function joinRuns(lines) {
    const out = [];
    lines.forEach((l, k) => {
      const runs = richRuns(l.box).map((r) => ({ ...r }));
      if (!runs.length) return;
      runs[0].text = runs[0].text.replace(/^\s+/, '');
      if (k && out.length) {
        const prev = out[out.length - 1], prevRaw = lines[k - 1].box.text, next = runs[0].text;
        prev.text = prev.text.replace(/\s+$/, '');
        if (/[A-Za-z][-‐]$/.test(prev.text) && /^[a-z]/.test(next)) prev.text = prev.text.slice(0, -1);
        else if (/\s$/.test(prevRaw) || !(CJK.test(prev.text.slice(-1)) && CJK.test(next.charAt(0)))) runs[0].text = ' ' + next;
      }
      for (const r of runs) { const last = out[out.length - 1]; if (last && sameStyle(last, r)) last.text += r.text; else out.push(r); }
    });
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    return out.filter((r) => r.text);
  }
  // runs 맨 앞의 글머리·번호 표시를 뗀다
  function stripMarker(runs, re) {
    const out = runs.map((r) => ({ ...r }));
    while (out.length) {
      const m = out[0].text.match(re);
      if (m) { out[0].text = out[0].text.slice(m[0].length); if (!out[0].text) out.shift(); return out; }
      if (out[0].text.trim()) return out;
      out.shift();
    }
    return out;
  }

  // 줄 잇기: 줄 끝 하이픈 + 소문자로 시작 → 하이픈을 빼고 붙임 · 줄 끝에 공백이 있으면 한 칸 · 한글·한자끼리는 붙임(줄 끝 음절 나눔) · 나머지는 한 칸
  function joinLines(parts) {
    let out = '';
    parts.forEach((p, k) => {
      const text = p.text;
      if (!k) { out = text.replace(/\s+$/, ''); return; }
      const prevRaw = parts[k - 1].raw, next = text.replace(/^\s+/, '');
      if (/[A-Za-z][-‐]$/.test(out) && /^[a-z]/.test(next)) out = out.slice(0, -1) + next;
      else if (/\s$/.test(prevRaw)) out += ' ' + next;
      else if (CJK.test(out.slice(-1)) && CJK.test(next.charAt(0))) out += next;
      else out += ' ' + next;
      out = out.replace(/\s+$/, '');
    });
    return out;
  }

  // 줄 왼쪽의 작은 도형(글머리 기호). 같은 행 왼쪽에 다른 글이 있는 줄(차례의 쪽 번호 앞 점선 등)은 목록이 아니다
  function pathMarker(l, paths, lines) {
    if (lines.some((o) => o !== l && Math.abs(o.y - l.y) <= 0.5 * Math.max(o.size, l.size) && o.x1 <= l.x0 + 0.5)) return false;
    return paths.some((p) => {
      const b = p.bounds, w = b.x1 - b.x0, h = b.y1 - b.y0, cy = (b.y0 + b.y1) / 2;
      return w > 0.5 && h > 0.5 && w <= 0.7 * l.size && h <= 0.7 * l.size && b.x1 <= l.x0 + 0.5 && l.x0 - b.x1 <= 2.5 * l.size
        && cy >= l.y - 0.3 * l.size && cy <= l.y + 0.9 * l.size;
    });
  }

  // ── 문서 전체 ──
  // pages: [{ w, h, objs }] (objs = 엔진 objects(i)) · opts: { format:'md'|'txt', stripHeaderFooter, images:'omit'|'files', pageBreaks, imageName(p, k) }
  // 반환 { text, images:[{ page, rect:{x0,y0,x1,y1}, name }], stats:{ headings, lists, tables, paragraphs, removed } }
  function convert(pages, opts = {}) {
    const md = (opts.format || 'md') !== 'txt';
    const perPage = pages.map((pg) => pageLines(pg, opts));
    const keys = opts.stripHeaderFooter ? repeatedKeys(pages, perPage) : new Set();
    const stats = { headings: 0, lists: 0, tables: 0, paragraphs: 0, removed: 0, images: 0 };
    const kept = perPage.map((lines, p) => lines.filter((l) => {
      const drop = opts.stripHeaderFooter && isHeaderFooter(l, pages[p].h || 0, keys);
      if (drop) stats.removed++;
      return !drop;
    }));
    // 제목 크기: 본문(글자 수 최다 크기)보다 뚜렷이 큰 크기를 큰 순서로
    const chars = new Map();
    for (const lines of kept) for (const l of lines) { const s = Math.round(l.size * 2) / 2; chars.set(s, (chars.get(s) || 0) + normText(l.box.text).replace(/\s/g, '').length); }
    const body = [...chars].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 10;
    const headSizes = [...chars.keys()].filter((s) => s >= body * HEADING_RATIO && s >= body + HEADING_MIN_PT).sort((a, b) => b - a);
    const headLevel = (size) => { const k = headSizes.indexOf(Math.round(size * 2) / 2); return k < 0 ? 0 : Math.min(3, k + 1); };

    const blocks = []; // 쪽마다 [문자열]
    const images = [];
    const model = opts.blocks ? [] : null; // v6 Wave E: 쪽마다 { w, h, blocks:[구조 블록] } — Word·한글 내보내기(pdf-office.js)가 쓴다
    pages.forEach((pg, p) => {
      const lines = kept[p];
      const paths = (pg.objs || []).filter((o) => o.type === 'path' && o.bounds && !o.mask && !o.deco);
      const tables = findTables(lines, pg.w || 600);
      const inTable = new Set(tables.flatMap((t) => [...t.lines]));
      const items = []; // { pos, top, text }
      for (const t of tables) {
        stats.tables++;
        const cell = (c) => (c ? (md ? styledText(c.box, { md }).replace(/\|/g, '\\|') : normText(c.box.text)).replace(/\s+/g, ' ').trim() : '');
        const rows = t.grid.map((r) => r.map(cell));
        const text = md
          ? [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n')
          : rows.map((r) => r.join('\t')).join('\n');
        const block = model ? { type: 'table', rows: t.grid.map((r) => r.map((c) => (c ? { runs: joinRuns([c]) } : null))) } : null;
        items.push({ pos: t.first, top: t.top, text, block });
      }
      const rest = lines.filter((l) => !inTable.has(l));
      const infoOf = new Map(rest.map((l) => [l.box, l]));
      for (const para of groupParagraphs(rest.map((l) => l.box))) {
        const ls = para.boxes.map((b) => infoOf.get(b));
        // 목록 표시가 있는 줄에서 나눈다(글머리 줄 + 이어지는 줄)
        const groups = [];
        for (const l of ls) {
          const t = normText(l.box.text);
          const marker = TEXT_BULLET.test(t) ? 'bullet' : NUMBERED.test(t) ? 'number' : pathMarker(l, paths, lines) ? 'shape' : null;
          if (marker || !groups.length) groups.push({ marker, lines: [l] }); else groups[groups.length - 1].lines.push(l);
        }
        const minX = Math.min(...groups.filter((g) => g.marker).map((g) => g.lines[0].x0), Infinity);
        for (const g of groups) {
          const first = g.lines[0], size = Math.max(...g.lines.map((l) => l.size));
          const level = g.marker ? 0 : headLevel(size);
          const allBold = g.lines.every((l) => l.box.objs.filter((o) => (o.text || '').trim()).every(isBold));
          const parts = g.lines.map((l) => ({ raw: l.box.text, text: styledText(l.box, { md, plainStyle: level ? { b: allBold } : null }) }));
          let text = joinLines(parts);
          let block = null;
          if (model) {
            const runs = joinRuns(g.lines);
            if (g.marker) {
              const indent = Math.max(0, Math.min(3, Math.round((first.x0 - minX) / (1.5 * first.size))));
              block = g.marker === 'number' ? { type: 'list', ordered: true, n: Number(normText(first.box.text).match(NUMBERED)[1]), level: indent, runs: stripMarker(runs, NUMBERED) }
                : { type: 'list', ordered: false, level: indent, runs: g.marker === 'bullet' ? stripMarker(runs, TEXT_BULLET) : runs };
            } else if (level && text.length <= 200 && g.lines.length <= 3) block = { type: 'heading', level, runs };
            else block = { type: 'para', runs };
          }
          if (g.marker) {
            stats.lists++;
            const indent = md ? '  '.repeat(Math.max(0, Math.min(3, Math.round((first.x0 - minX) / (1.5 * first.size))))) : '';
            if (g.marker === 'number') { const n = normText(first.box.text).match(NUMBERED)[1]; text = `${indent}${n}. ${text.replace(md ? /^\s*\\?\(?\d{1,3}[.)]\s+/ : NUMBERED, '')}`; }
            else if (g.marker === 'bullet') text = md ? `${indent}- ${text.replace(/^\s*(?:\\[*\-+]|[•·∙◦▪▫■□●○◆◇▶►‣⁃–—*\-+])\s+/, '')}` : text;
            else text = md ? `${indent}- ${text}` : `• ${text}`;
          } else if (level && md && text.length <= 200 && g.lines.length <= 3) {
            stats.headings++; text = `${'#'.repeat(level)} ${text}`;
          } else {
            stats.paragraphs++;
            if (md) text = text.replace(/^(\s*)([#>+-]|\d{1,3}[.)])(\s)/, '$1\\$2$3');
          }
          items.push({ pos: first.k, top: first.top, text, list: !!g.marker, block });
        }
      }
      items.sort((a, b) => a.pos - b.pos);
      // 그림: 그 그림 위끝보다 아래에서 시작하는 첫 글 앞에 둔다
      if (opts.images === 'files') {
        let k = 0;
        for (const o of (pg.objs || []).filter((x) => x.type === 'image' && x.bounds && !x.watermark && !x.mask)) {
          const b = o.bounds;
          if ((b.x1 - b.x0) < 8 || (b.y1 - b.y0) < 8) continue;
          k++;
          const name = opts.imageName ? opts.imageName(p, k) : `p${p + 1}-${k}.png`;
          images.push({ page: p, rect: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }, name });
          stats.images++;
          const at = items.findIndex((it) => it.top <= b.y1 + 1);
          const it = { pos: -1, top: b.y1, text: md ? `![](${encodeURI(name)})` : `[그림: ${name}]`, block: model ? { type: 'image', name, page: p, rect: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 } } : null };
          if (at < 0) items.push(it); else items.splice(at, 0, it);
        }
      }
      // 이어지는 목록 항목은 빈 줄 없이
      const out = [];
      items.forEach((it, k) => { if (k && !(it.list && items[k - 1].list)) out.push(''); out.push(it.text); });
      blocks.push(out.join('\n'));
      if (model) model.push({ w: pg.w, h: pg.h, rotation: pg.rotation || 0, blocks: items.map((it) => it.block).filter(Boolean) });
    });
    const sep = opts.pageBreaks ? (md ? '\n\n---\n\n' : '\n\n\f\n') : '\n\n';
    const text = blocks.filter((b, k) => b || opts.pageBreaks || k === 0).join(sep).replace(/\n{3,}/g, '\n\n').trim() + '\n';
    return model ? { text, images, stats, pages: model } : { text, images, stats };
  }

  const api = { convert, isBold, isItalic, findTables, joinLines, richRuns, joinRuns, PAGE_NUM };
  if (typeof module !== 'undefined') module.exports = api;
})();
