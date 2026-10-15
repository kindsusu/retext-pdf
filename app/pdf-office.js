// v6 Wave E: PDF → Word(.docx) · 한글(.hwpx) 내보내기. 순수 계산 — pdf-markdown.js의 구조 모델(convert(…, { blocks:true }).pages)을 받아
// 압축 파일(ZIP) 바이트를 돌려준다. 외부 의존성 없음(node:zlib — ZIP도 직접 쓴다).
//   모델: pages [{ w, h, blocks:[ {type:'heading', level, runs} · {type:'para', runs} · {type:'list', ordered, n, level, runs}
//                                · {type:'table', rows:[[{runs}|null]]} · {type:'image', name} ] }]
//   run: { text, b, i, color('#rrggbb'), size(pt), font(PDF 글꼴 이름) } · images: Map(name → { data(PNG), w, h(pt) })
//   · DOCX: OOXML 최소 꾸러미 — [Content_Types].xml · _rels · word/document.xml · styles.xml(Heading1–3·ListParagraph·TableGrid) ·
//           numbering.xml(글머리·번호) · 그림(word/media) · docProps. 쪽 크기는 첫 쪽, PDF 쪽 사이는 쪽 나눔
//   · HWPX: OWPML(KS X 6101) 꾸러미 — mimetype(맨 앞·무압축) · version.xml · META-INF(container.xml·manifest.xml·container.rdf) ·
//           Contents/content.hpf · header.xml(글꼴·글자 모양·문단 모양·스타일) · section0.xml · settings.xml · Preview/PrvText.txt · BinData(그림).
//           한컴오피스 한글이 쓰는 1.2 형식(교육용 공지 .hwpx 실물의 구조)을 따랐다. 글머리·번호는 글자(•, 1.)와 내어쓰기로 넣는다
//           (한글의 글머리표 정의가 어긋나면 파일 전체가 열리지 않으므로 — 보이는 모양은 같다)
const zlib = require('zlib');

// ── ZIP ───────────────────────────────────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
// entries: [{ name, data(Buffer|string), store?(무압축) }] — 넣은 순서대로 쓴다
function zip(entries, when = new Date()) {
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const locals = [], centrals = [];
  let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const name = Buffer.from(e.name, 'utf8'), utf = /[^\x20-\x7e]/.test(e.name) ? 0x0800 : 0;
    const comp = e.store ? data : zlib.deflateRawSync(data, { level: 9 }), method = e.store ? 0 : 8, crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(utf, 6); h.writeUInt16LE(method, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(utf, 8); c.writeUInt16LE(method, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, name, comp); centrals.push(c, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
// 읽기(시험·검증용): 중앙 디렉터리 → [{ name, method, data, offset }] (넣은 순서)
function unzip(buf) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('ZIP 끝 레코드가 없습니다');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리가 깨졌습니다');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42), name = buf.toString('utf8', p + 46, p + 46 + nl);
    const lnl = buf.readUInt16LE(offset + 26), lxl = buf.readUInt16LE(offset + 28), start = offset + 30 + lnl + lxl;
    const raw = buf.subarray(start, start + csize);
    out.push({ name, method, offset, extra: lxl, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

// ── 공통 ───────────────────────────────────────────────────────────────────
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
// XML 1.0에 쓸 수 없는 제어 글자는 뺀다(탭·줄바꿈은 따로 다룬다)
const xml = (s) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// PDF 글꼴 이름 → 문서 프로그램의 글꼴 이름. 한글 글꼴이 아니면 동아시아 글자는 맑은 고딕으로
const FONT_MAP = [[/malgun/i, '맑은 고딕', true], [/batang|myeongjo/i, '바탕', true], [/gulim/i, '굴림', true], [/dotum/i, '돋움', true], [/gungsuh/i, '궁서', true],
  [/nanumgothic/i, '나눔고딕', true], [/nanummyeongjo/i, '나눔명조', true], [/notosans(kr|cjk)/i, 'Noto Sans KR', true], [/hcr\s*batang|hamchorom.*batang/i, '함초롬바탕', true],
  [/hcr\s*dotum|hamchorom.*dotum/i, '함초롬돋움', true], [/arial|helvetica/i, 'Arial'], [/times/i, 'Times New Roman'], [/courier/i, 'Courier New'], [/consolas/i, 'Consolas'],
  [/calibri/i, 'Calibri'], [/cambria/i, 'Cambria'], [/segoe/i, 'Segoe UI'], [/verdana/i, 'Verdana'], [/georgia/i, 'Georgia'], [/tahoma/i, 'Tahoma'], [/d2coding/i, 'D2Coding', true]];
const DEFAULT_FONT = '맑은 고딕';
function officeFont(pdfName) {
  const s = String(pdfName || '').replace(/\s+/g, '');
  for (const [re, name, cjk] of FONT_MAP) if (re.test(s)) return { latin: name, eastAsia: cjk ? name : DEFAULT_FONT };
  const clean = String(pdfName || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return { latin: clean.length >= 2 ? clean : DEFAULT_FONT, eastAsia: DEFAULT_FONT };
}
const hexColor = (c) => (/^#[0-9a-f]{6}$/i.test(c || '') ? c.slice(1).toUpperCase() : '000000');
const runsText = (runs) => (runs || []).map((r) => r.text).join('');
// 본문 글자 크기: 글자 수가 가장 많은 크기
function bodySize(pages) {
  const n = new Map();
  for (const pg of pages) for (const b of pg.blocks) {
    const all = b.type === 'table' ? b.rows.flat().filter(Boolean).flatMap((c) => c.runs) : b.runs || [];
    for (const r of all) n.set(r.size, (n.get(r.size) || 0) + r.text.length);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

// ── DOCX ──────────────────────────────────────────────────────────────────
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DRAW_NS = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
function docxRun(r) {
  const f = officeFont(r.font), sz = Math.max(2, Math.round((r.size || 10) * 2));
  const pr = `<w:rFonts w:ascii="${xml(f.latin)}" w:hAnsi="${xml(f.latin)}" w:eastAsia="${xml(f.eastAsia)}" w:cs="${xml(f.latin)}"/>`
    + (r.b ? '<w:b/><w:bCs/>' : '') + (r.i ? '<w:i/><w:iCs/>' : '') + (hexColor(r.color) !== '000000' ? `<w:color w:val="${hexColor(r.color)}"/>` : '') + `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
  const parts = String(r.text).split(/(\t|\n)/).map((t) => (t === '\t' ? '<w:tab/>' : t === '\n' ? '<w:br/>' : t ? `<w:t xml:space="preserve">${xml(t)}</w:t>` : '')).join('');
  return `<w:r><w:rPr>${pr}</w:rPr>${parts}</w:r>`;
}
function toDocx(pages, opts = {}) {
  const images = opts.images || new Map(), pageBreaks = opts.pageBreaks !== false;
  const first = pages[0] || { w: 595.28, h: 841.89 };
  const pw = Math.round(first.w * 20), ph = Math.round(first.h * 20), margin = 1134; // 20mm
  const contentW = Math.max(2000, pw - 2 * margin);
  const body = [], media = [];
  let breakNext = false, lastTable = false, numId = 1, orderedRun = null; // orderedRun: { numId } — 이어지는 번호 목록
  const nums = []; // [{ numId, start }]
  const para = (pPr, runs) => {
    const brk = breakNext ? '<w:pageBreakBefore/>' : '';
    breakNext = false; lastTable = false;
    body.push(`<w:p>${pPr || brk ? `<w:pPr>${pPr.replace('<!--BRK-->', brk)}</w:pPr>` : ''}${(runs || []).map(docxRun).join('')}</w:p>`);
  };
  pages.forEach((pg, pi) => {
    if (pi && pageBreaks) breakNext = true;
    for (const b of pg.blocks) {
      if (b.type !== 'list' || !b.ordered) orderedRun = null;
      if (b.type === 'heading') para(`<w:pStyle w:val="Heading${Math.min(3, b.level)}"/><!--BRK-->`, b.runs);
      else if (b.type === 'para') para('<!--BRK-->', b.runs);
      else if (b.type === 'list') {
        let id = 1;
        if (b.ordered) {
          if (!orderedRun || b.n === 1) { orderedRun = { numId: ++numId }; nums.push({ numId: orderedRun.numId, start: b.n || 1 }); }
          id = orderedRun.numId;
        }
        para(`<w:pStyle w:val="ListParagraph"/><!--BRK--><w:numPr><w:ilvl w:val="${Math.min(3, b.level || 0)}"/><w:numId w:val="${id}"/></w:numPr>`, b.runs);
      } else if (b.type === 'table') {
        if (breakNext) { body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); breakNext = false; }
        else if (lastTable) body.push('<w:p/>'); // 붙은 두 표가 하나로 합쳐지지 않게
        const cols = Math.max(1, ...b.rows.map((r) => r.length)), cw = Math.floor(contentW / cols);
        const rows = b.rows.map((r, ri) => `<w:tr>${ri === 0 ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, k) => {
          const c = r[k];
          return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr><w:p>${c ? c.runs.map(docxRun).join('') : ''}</w:p></w:tc>`;
        }).join('')}</w:tr>`);
        body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cw * cols}" w:type="dxa"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`
          + `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${cw}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`);
        lastTable = true;
      } else if (b.type === 'image') {
        const im = images.get(b.name);
        if (!im) continue;
        const k = media.length + 1, rid = `rIdImg${k}`, name = `image${k}.png`;
        media.push({ name, rid, data: im.data });
        let w = im.w * 12700, h = im.h * 12700; // pt → EMU
        const maxW = contentW * 635; // twip → EMU
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        w = Math.round(w); h = Math.round(h);
        const draw = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w}" cy="${h}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${k}" name="그림 ${k}"/>`
          + '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
          + `<pic:pic><pic:nvPicPr><pic:cNvPr id="${k}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
          + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
        const brk = breakNext ? '<w:pPr><w:pageBreakBefore/></w:pPr>' : '';
        breakNext = false; lastTable = false;
        body.push(`<w:p>${brk}<w:r>${draw}</w:r></w:p>`);
      }
    }
  });
  if (!body.length || lastTable) body.push('<w:p/>'); // 본문은 문단으로 끝나야 한다
  const land = first.w > first.h;
  const sect = `<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="567" w:footer="567" w:gutter="0"/><w:cols w:space="425"/></w:sectPr>`;
  const document = `${XML_HEAD}\n<w:document ${W_NS} ${DRAW_NS}><w:body>${body.join('')}${sect}</w:body></w:document>`;
  const base = bodySize(pages), hs = [Math.max(base + 6, 16), Math.max(base + 3, 13), Math.max(base + 1.5, 12)];
  const hStyle = (k) => `<w:style w:type="paragraph" w:styleId="Heading${k}"><w:name w:val="heading ${k}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/>`
    + `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${k === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${k - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${Math.round(hs[k - 1] * 2)}"/><w:szCs w:val="${Math.round(hs[k - 1] * 2)}"/></w:rPr></w:style>`;
  const styles = `${XML_HEAD}\n<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${DEFAULT_FONT}" w:eastAsia="${DEFAULT_FONT}" w:hAnsi="${DEFAULT_FONT}" w:cs="${DEFAULT_FONT}"/>`
    + `<w:sz w:val="${Math.round(base * 2)}"/><w:szCs w:val="${Math.round(base * 2)}"/><w:lang w:val="ko-KR" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + [1, 2, 3].map(hStyle).join('')
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('') + '</w:tblBorders></w:tblPr></w:style>'
    + '</w:styles>';
  const lvl = (k, fmt, text, font) => `<w:lvl w:ilvl="${k}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>`
    + `<w:pPr><w:ind w:left="${720 + 360 * k}" w:hanging="360"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:hint="default"/></w:rPr>` : ''}</w:lvl>`;
  const bullets = ['•', '◦', '▪', '•'], fmts = [['decimal', '%1.'], ['decimal', '%2)'], ['lowerLetter', '%3.'], ['lowerRoman', '%4.']];
  const numbering = `${XML_HEAD}\n<w:numbering ${W_NS}>`
    + `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${bullets.map((c, k) => lvl(k, 'bullet', c, DEFAULT_FONT)).join('')}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${fmts.map(([f, t], k) => lvl(k, f, t)).join('')}</w:abstractNum>`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + nums.map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride></w:num>`).join('')
    + '</w:numbering>';
  const ct = `${XML_HEAD}\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const rels = `${XML_HEAD}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>';
  const docRels = `${XML_HEAD}\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('') + '</Relationships>';
  const now = (opts.date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `${XML_HEAD}\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<dc:title>${xml(opts.title || '')}</dc:title><dc:creator>Retext PDF</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `${XML_HEAD}\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Retext PDF</Application><Pages>${pages.length}</Pages></Properties>`;
  return zip([
    { name: '[Content_Types].xml', data: ct }, { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document }, { name: 'word/styles.xml', data: styles }, { name: 'word/numbering.xml', data: numbering },
    { name: 'word/_rels/document.xml.rels', data: docRels }, ...media.map((m) => ({ name: `word/media/${m.name}`, data: m.data, store: true })),
    { name: 'docProps/core.xml', data: core }, { name: 'docProps/app.xml', data: app },
  ], opts.date);
}

// ── HWPX ──────────────────────────────────────────────────────────────────
const HWP_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const LANG_ATTR = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];
const all7 = (v) => LANG_ATTR.map((k) => `${k}="${typeof v === 'function' ? v(k) : v}"`).join(' ');
function toHwpx(pages, opts = {}) {
  const images = opts.images || new Map(), pageBreaks = opts.pageBreaks !== false;
  const first = pages[0] || { w: 595.28, h: 841.89 };
  const land = first.w > first.h;
  const pw = Math.round(Math.min(first.w, first.h) * 100), ph = Math.round(Math.max(first.w, first.h) * 100); // 한글은 용지를 세로로 적고 방향을 따로 둔다
  const mL = 5669, mR = 5669, mT = 4252, mB = 4252; // 20mm · 15mm
  const contentW = Math.max(5000, (land ? ph : pw) - mL - mR);
  // 글꼴 목록: 한글 글꼴(hangul·hanja·japanese 칸)과 라틴 글꼴(latin·other·symbol·user 칸)을 같은 목록에서 고른다
  const fonts = [DEFAULT_FONT], fontIdx = (name) => { let k = fonts.indexOf(name); if (k < 0) { fonts.push(name); k = fonts.length - 1; } return k; };
  // 글자 모양: (크기·굵게·기울임·색·라틴 글꼴·한글 글꼴) 마다 하나. 0번은 바탕
  const base = bodySize(pages);
  const charPrs = [], charKey = new Map();
  const charPr = (r) => {
    const f = officeFont(r?.font), key = [r ? Math.round((r.size || base) * 100) : Math.round(base * 100), r?.b ? 1 : 0, r?.i ? 1 : 0, hexColor(r?.color), f.latin, f.eastAsia].join('|');
    if (!charKey.has(key)) { const [h, b, i, c, lat, ea] = key.split('|'); charKey.set(key, charPrs.length); charPrs.push({ h: +h, b: b === '1', i: i === '1', c, lat: fontIdx(lat), ea: fontIdx(ea) }); }
    return charKey.get(key);
  };
  charPr(null);
  // 문단 모양: 0 본문 · 1~3 제목 · 4+ 목록(단계별 내어쓰기) · 표 칸
  const paraPrs = [{ kind: 'body' }, { kind: 'heading', level: 1 }, { kind: 'heading', level: 2 }, { kind: 'heading', level: 3 }];
  const listPr = (level) => { const k = paraPrs.findIndex((p) => p.kind === 'list' && p.level === level); if (k >= 0) return k; paraPrs.push({ kind: 'list', level }); return paraPrs.length - 1; };
  const CELL_PR = (() => { paraPrs.push({ kind: 'cell' }); return paraPrs.length - 1; })();
  let pid = 0, tblId = 1000, picId = 2000;
  const bin = [];
  const runXml = (r) => {
    const t = xml(String(r.text).replace(/[\t\n]/g, ' '));
    return `<hp:run charPrIDRef="${charPr(r)}"><hp:t>${t}</hp:t></hp:run>`;
  };
  const pXml = (paraPr, style, runs, brk, inner) => `<hp:p id="${pid++}" paraPrIDRef="${paraPr}" styleIDRef="${style}" pageBreak="${brk ? 1 : 0}" columnBreak="0" merged="0">${inner || ''}${(runs && runs.length ? runs.map(runXml).join('') : (inner ? '' : '<hp:run charPrIDRef="0"/>'))}</hp:p>`;
  const body = [];
  let breakNext = false, counter = 0;
  const secPr = `<hp:run charPrIDRef="0"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">`
    + '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>'
    + '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>'
    + '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>'
    + `<hp:pagePr landscape="${land ? 'NARROWLY' : 'WIDELY'}" width="${pw}" height="${ph}" gutterType="LEFT_ONLY"><hp:margin header="2835" footer="2835" gutter="0" left="${mL}" right="${mR}" top="${mT}" bottom="${mB}"/></hp:pagePr>`
    + '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>'
    + '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>'
    + ['BOTH', 'EVEN', 'ODD'].map((t) => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`).join('')
    + '</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>';
  const push = (paraPr, style, runs, inner) => { body.push(pXml(paraPr, style, runs, breakNext, inner)); breakNext = false; };
  pages.forEach((pg, pi) => {
    if (pi && pageBreaks) breakNext = true;
    for (const b of pg.blocks) {
      if (b.type !== 'list' || !b.ordered) counter = 0;
      if (b.type === 'heading') push(Math.min(3, b.level), Math.min(3, b.level), b.runs);
      else if (b.type === 'para') push(0, 0, b.runs);
      else if (b.type === 'list') {
        counter = b.ordered ? (b.n || counter + 1) : 0;
        const lead = { ...(b.runs[0] || { size: base }), text: b.ordered ? `${counter}. ` : ['• ', '◦ ', '▪ ', '• '][Math.min(3, b.level || 0)], b: false, i: false };
        push(listPr(Math.min(3, b.level || 0)), 0, [lead, ...b.runs]);
      } else if (b.type === 'table') {
        const cols = Math.max(1, ...b.rows.map((r) => r.length)), cw = Math.floor(contentW / cols), rh = Math.round(base * 100 * 1.8);
        const rows = b.rows.map((r, ri) => `<hp:tr>${Array.from({ length: cols }, (_, ci) => {
          const c = r[ci];
          return `<hp:tc name="" header="${ri === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3">`
            + '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
            + pXml(CELL_PR, 0, c ? c.runs : [], false) + '</hp:subList>'
            + `<hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cw}" height="${rh}"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
        }).join('')}</hp:tr>`);
        const tbl = `<hp:run charPrIDRef="0"><hp:tbl id="${tblId++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${b.rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">`
          + `<hp:sz width="${cw * cols}" widthRelTo="ABSOLUTE" height="${rh * b.rows.length}" heightRelTo="ABSOLUTE" protect="0"/>`
          + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
          + '<hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>'
          + rows.join('') + '</hp:tbl><hp:t/></hp:run>';
        push(0, 0, null, tbl);
      } else if (b.type === 'image') {
        const im = images.get(b.name);
        if (!im) continue;
        const k = bin.length + 1, id = `image${k}`;
        bin.push({ id, href: `BinData/${id}.png`, data: im.data });
        let w = Math.round(im.w * 100), h = Math.round(im.h * 100);
        if (w > contentW) { h = Math.round(h * contentW / w); w = contentW; }
        const pic = `<hp:run charPrIDRef="0"><hp:pic id="${picId++}" zOrder="${k}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${picId + 500000}" reverse="0">`
          + `<hp:offset x="0" y="0"/><hp:orgSz width="${w}" height="${h}"/><hp:curSz width="${w}" height="${h}"/><hp:flip horizontal="0" vertical="0"/>`
          + `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>`
          + '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>'
          + `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>`
          + `<hp:imgClip left="0" right="${w}" top="0" bottom="${h}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>`
          + `<hc:img binaryItemIDRef="${id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>`
          + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
          + '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
          + '<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic><hp:t/></hp:run>';
        push(0, 0, null, pic);
      }
    }
  });
  if (!body.length) body.push(pXml(0, 0, [], false));
  // 첫 문단 앞에 구역 정의(secPr)를 넣는다
  body[0] = body[0].replace(/^(<hp:p [^>]*>)/, `$1${secPr}`);
  const section = `${XML_HEAD}<hs:sec ${HWP_NS}>${body.join('')}</hs:sec>`;

  // ── header.xml ──
  const hs = [Math.max(base + 6, 16), Math.max(base + 3, 13), Math.max(base + 1.5, 12)];
  const headingChar = hs.map((s) => charPr({ size: s, b: true, font: 'MalgunGothic' })); // 제목 스타일의 기본 글자 모양
  const fontXml = (name, id) => `<hh:font id="${id}" face="${xml(name)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`;
  const fontfaces = `<hh:fontfaces itemCnt="7">${LANGS.map((l) => `<hh:fontface lang="${l}" fontCnt="${fonts.length}">${fonts.map(fontXml).join('')}</hh:fontface>`).join('')}</hh:fontfaces>`;
  const border = (id, type, fill) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`
    + ['left', 'right', 'top', 'bottom'].map((s) => `<hh:${s}Border type="${type}" width="${type === 'NONE' ? '0.1 mm' : '0.12 mm'}" color="#000000"/>`).join('')
    + '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' + (fill ? '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#FF000000" alpha="0"/></hc:fillBrush>' : '') + '</hh:borderFill>';
  const borderFills = `<hh:borderFills itemCnt="3">${border(1, 'NONE', false)}${border(2, 'NONE', true)}${border(3, 'SOLID', false)}</hh:borderFills>`;
  const charXml = (c, id) => `<hh:charPr id="${id}" height="${c.h}" textColor="#${c.c}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">`
    + `<hh:fontRef ${all7((k) => (['latin', 'other', 'symbol', 'user'].includes(k) ? c.lat : c.ea))}/><hh:ratio ${all7(100)}/><hh:spacing ${all7(0)}/><hh:relSz ${all7(100)}/><hh:offset ${all7(0)}/>`
    + (c.b ? '<hh:bold/>' : '') + (c.i ? '<hh:italic/>' : '') + '<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>';
  const charProps = `<hh:charProperties itemCnt="${charPrs.length}">${charPrs.map(charXml).join('')}</hh:charProperties>`;
  const paraXml = (p, id) => {
    const heading = p.kind === 'heading', list = p.kind === 'list';
    const left = list ? 2000 * (p.level + 1) : 0, intent = list ? -1500 : 0;
    const prev = heading ? (p.level === 1 ? 1600 : 1200) : 0, next = heading ? 600 : p.kind === 'cell' ? 0 : list ? 200 : 600;
    const line = p.kind === 'cell' ? 130 : 160;
    return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">`
      + `<hh:align horizontal="${p.kind === 'body' ? 'JUSTIFY' : 'LEFT'}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>`
      + `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="${heading ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>`
      + '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>'
      + `<hh:margin><hc:intent value="${intent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin>`
      + `<hh:lineSpacing type="PERCENT" value="${line}" unit="HWPUNIT"/><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
  };
  const paraProps = `<hh:paraProperties itemCnt="${paraPrs.length}">${paraPrs.map(paraXml).join('')}</hh:paraProperties>`;
  const styles = '<hh:styles itemCnt="4"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>'
    + [1, 2, 3].map((k) => `<hh:style id="${k}" type="PARA" name="제목 ${k}" engName="Heading ${k}" paraPrIDRef="${k}" charPrIDRef="${headingChar[k - 1]}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`).join('') + '</hh:styles>';
  const paraHead = (lv, fmt, text) => `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="0">${text}</hh:paraHead>`;
  const numberings = `<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">${paraHead(1, 'DIGIT', '^1.')}${paraHead(2, 'HANGUL_SYLLABLE', '^2.')}${paraHead(3, 'DIGIT', '^3)')}${paraHead(4, 'HANGUL_SYLLABLE', '^4)')}${paraHead(5, 'DIGIT', '(^5)')}${paraHead(6, 'HANGUL_SYLLABLE', '(^6)')}${paraHead(7, 'CIRCLED_DIGIT', '^7')}</hh:numbering></hh:numberings>`;
  const header = `${XML_HEAD}<hh:head ${HWP_NS} version="1.2" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>`
    + fontfaces + borderFills + charProps + '<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>' + numberings + paraProps + styles
    + '</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>';

  const now = (opts.date || new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  const hpf = `${XML_HEAD}<opf:package ${HWP_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${xml(opts.title || '')}</opf:title><opf:language>ko</opf:language>`
    + `<opf:meta name="creator" content="text">Retext PDF</opf:meta><opf:meta name="subject" content="text"/><opf:meta name="description" content="text"/>`
    + `<opf:meta name="CreatedDate" content="text">${now}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta><opf:meta name="date" content="text">${now.slice(0, 10)}</opf:meta><opf:meta name="keyword" content="text"/></opf:metadata>`
    + '<opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>'
    + bin.map((b) => `<opf:item id="${b.id}" href="${b.href}" media-type="image/png" isEmbeded="1"/>`).join('')
    + '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest>'
    + '<opf:spine><opf:itemref idref="header"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>';
  const version = `${XML_HEAD}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.2" application="Hancom Office Hangul" appVersion="11, 0, 0, 0"/>`;
  const container = `${XML_HEAD}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles>`
    + '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>'
    + '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>';
  const manifest = `${XML_HEAD}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`;
  const pkg = 'http://www.hancom.co.kr/hwpml/2016/meta/pkg#';
  const rdf = `${XML_HEAD}<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
    + `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${pkg}" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="${pkg}HeaderFile"/></rdf:Description>`
    + `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="${pkg}" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="${pkg}SectionFile"/></rdf:Description>`
    + `<rdf:Description rdf:about=""><rdf:type rdf:resource="${pkg}Document"/></rdf:Description></rdf:RDF>`;
  const settings = `${XML_HEAD}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`;
  // 미리 보기 글: 블록마다 한 줄(표는 칸을 탭으로), 앞 1,000자
  const prv = pages.flatMap((pg) => pg.blocks.map((b) => (b.type === 'table' ? b.rows.map((r) => r.map((c) => (c ? runsText(c.runs) : '')).join('\t')).join('\r\n') : b.type === 'image' ? '' : runsText(b.runs)))).filter(Boolean).join('\r\n').slice(0, 1000);
  return zip([
    { name: 'mimetype', data: 'application/hwp+zip', store: true },
    { name: 'version.xml', data: version, store: true },
    { name: 'Contents/header.xml', data: header },
    ...bin.map((b) => ({ name: b.href, data: b.data })),
    { name: 'Contents/section0.xml', data: section },
    { name: 'Preview/PrvText.txt', data: prv },
    { name: 'settings.xml', data: settings },
    { name: 'META-INF/container.rdf', data: rdf },
    { name: 'Contents/content.hpf', data: hpf },
    { name: 'META-INF/container.xml', data: container },
    { name: 'META-INF/manifest.xml', data: manifest },
  ], opts.date);
}

module.exports = { zip, unzip, crc32, toDocx, toHwpx, officeFont };
