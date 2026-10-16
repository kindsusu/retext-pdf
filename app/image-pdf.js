// v6.1 그림을 PDF로 열기: 그림 한 장 = 쪽 한 장. 쪽 크기는 그림 크기 그대로(96dpi 기준 — 1픽셀 = 0.75pt).
// · JPEG는 다시 압축하지 않고 DCT 그대로 넣는다. 단 EXIF 방향이 있거나(휴대폰 사진) 너무 크면 풀어서 돌리거나 줄인 뒤 다시 JPEG(품질 90)
// · PNG·BMP·(화면이 풀어 보낸) GIF·투명 그림은 무손실(투명은 /SMask)로 넣는다
// · 긴 변이 IMAGE_MAX_SIDE(7000px)를 넘으면 그 길이로 줄이고 scaled로 알린다(WASM 힙·저장 크기를 지키려고)
// · GIF·WebP와 여기서 못 푸는 PNG(인터레이스)·BMP(RLE)는 needDecode 오류 → 화면이 브라우저 디코더로 풀어 PNG/JPEG로 다시 보낸다
const jpeg = require('jpeg-js');
const pdfEngine = require('./pdf-engine');
const { sniffImage, jpegSize, decodePng, decodeBmp, jpegOrientation, orientRgba, resizeRgba } = require('./image-util');

const IMAGE_MAX_SIDE = 7000;
const PX_TO_PT = 0.75; // 96dpi
const needDecode = (why) => Object.assign(new Error(why), { needDecode: true });

// 큰 변을 IMAGE_MAX_SIDE 안으로 — 줄였으면 원래 크기를 함께 돌려준다
function fit(img) {
  const long = Math.max(img.width, img.height);
  if (long <= IMAGE_MAX_SIDE) return { img, scaled: null };
  const k = IMAGE_MAX_SIDE / long;
  return { img: resizeRgba(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))), scaled: { from: [img.width, img.height] } };
}

// 그림 바이트 → { image(엔진 insertImage 모양), width, height(넣은 픽셀 크기), type, scaled }
function prepareImage(buf, opts = {}) {
  const type = sniffImage(buf);
  if (type === 'jpeg') {
    const size = jpegSize(buf);
    if (!size || !size.width || !size.height) throw new Error('JPEG 크기를 읽을 수 없습니다 (깨진 파일).');
    const o = opts.ignoreOrientation ? 1 : jpegOrientation(buf);
    if (o === 1 && Math.max(size.width, size.height) <= IMAGE_MAX_SIDE) return { image: { kind: 'jpeg', data: buf }, width: size.width, height: size.height, type, scaled: null };
    let raw;
    try { raw = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 250, maxMemoryUsageInMB: 2048 }); }
    catch (e) { throw needDecode(`JPEG를 풀지 못했습니다: ${e.message}`); }
    const { img, scaled } = fit(orientRgba({ width: raw.width, height: raw.height, data: Buffer.from(raw.data.buffer, raw.data.byteOffset, raw.data.length) }, o));
    return { image: { kind: 'rgba', data: img.data, width: img.width, height: img.height, quality: 90 }, width: img.width, height: img.height, type, scaled };
  }
  let img;
  if (type === 'png') { try { img = decodePng(buf); } catch (e) { throw needDecode(e.message); } }
  else if (type === 'bmp') { try { img = decodeBmp(buf); } catch (e) { throw needDecode(e.message); } }
  else if (type === 'gif' || type === 'webp') throw needDecode(`${type.toUpperCase()}는 화면에서 풀어 보냅니다`);
  else throw new Error('그림 파일이 아닙니다 (PNG·JPEG·WebP·GIF·BMP만 열 수 있습니다).');
  const { img: out, scaled } = fit(img);
  // 무손실: 투명이 있으면 엔진이 /SMask를 붙이고, 없으면 알파를 버린 BGRx(FlateDecode)로 넣는다
  return { image: { kind: 'rgba', data: out.data, width: out.width, height: out.height, lossless: true }, width: out.width, height: out.height, type, scaled };
}

// 빈 쪽 하나짜리 최소 PDF(쪽 크기 w×h pt). 엔진에 "새 문서"가 없어 이것을 열고 그림을 얹는다
function blankPdf(w, h) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${+w.toFixed(3)} ${+h.toFixed(3)}] /Resources << >> >>`];
  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
  const offs = objs.map((o, k) => { const at = Buffer.byteLength(out, 'latin1'); out += `${k + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const pageSizeOf = (p) => ({ w: Math.max(1, p.width * PX_TO_PT), h: Math.max(1, p.height * PX_TO_PT) });

// 준비한 그림들 → PDF 바이트(쪽마다 그림 하나를 쪽 전체에)
async function imagesToPdf(prepared) {
  if (!prepared.length) throw new Error('넣을 그림이 없습니다.');
  const first = pageSizeOf(prepared[0]);
  const doc = await pdfEngine.open(blankPdf(first.w, first.h));
  try {
    prepared.forEach((p, k) => {
      const { w, h } = pageSizeOf(p);
      if (k > 0) doc.insertBlankPage(k, w, h);
      doc.insertImage(k, p.image, { x: 0, y: 0, w, h });
    });
    return doc.save();
  } finally { doc.close(); }
}

module.exports = { IMAGE_MAX_SIDE, PX_TO_PT, prepareImage, blankPdf, imagesToPdf };
