// 이미지 바이트 도우미 (서버 · 도장 보관함 공용): 형식 판별 · 크기 읽기 · PNG → RGBA 풀기
// PNG 풀기는 node:zlib만 쓴다 — Electron nativeImage 없이(node app/server.js, 시험) 투명 PNG를 넣을 수 있게.
// 인터레이스 PNG는 풀지 않는다(throw) → 서버가 Electron이면 nativeImage로 한 번 더 시도한다
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const sniff = (buf) => (buf && buf.length > 8 && buf.subarray(0, 8).equals(PNG_SIG) ? 'png'
  : buf && buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpeg' : null);
const MIME = { png: 'image/png', jpeg: 'image/jpeg' };

// PNG 크기: IHDR는 언제나 첫 청크(시그니처 8 + 길이 4 + 'IHDR' 4 뒤에 폭·높이)
const pngSize = (buf) => (sniff(buf) === 'png' && buf.length >= 24 ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

// JPEG의 SOF0/SOF2(비-차등, 허프만) 마커에서 픽셀 크기를 읽는다(이미지 삽입 시 종횡비 유지용). 못 찾으면 null.
// 마커 포맷: 0xFF 0xC0~0xCF(단, C4/C8/CC 제외) 뒤에 length(2B) + precision(1B) + height(2B) + width(2B)
function jpegSize(buf) {
  if (!(buf[0] === 0xff && buf[1] === 0xd8)) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; } // 채움 바이트
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xd9) break; // EOI
    const len = buf.readUInt16BE(off + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

const imageSize = (buf) => (sniff(buf) === 'png' ? pngSize(buf) : sniff(buf) === 'jpeg' ? jpegSize(buf) : null);

// PNG → { width, height, data: 촘촘한 RGBA }. 색 형식 0·2·3·4·6, 비트 1·2·4·8·16, tRNS 투명색까지. 16비트는 위 바이트만 쓴다
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
function decodePng(buf) {
  if (sniff(buf) !== 'png') throw new Error('PNG 파일이 아닙니다.');
  let off = 8, ihdr = null, plte = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9], interlace: data[12] };
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr || !idat.length) throw new Error('PNG를 읽을 수 없습니다 (깨진 파일).');
  const { width, height, depth, color, interlace } = ihdr, ch = CHANNELS[color];
  if (!ch || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('지원하지 않는 PNG 형식입니다.');
  if (interlace) throw new Error('인터레이스 PNG는 지원하지 않습니다.');
  if (!(width > 0 && height > 0) || width * height > 40e6) throw new Error('PNG 크기가 너무 큽니다.');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = Math.ceil((width * ch * depth) / 8), bpp = Math.max(1, (ch * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('PNG를 읽을 수 없습니다 (데이터가 짧음).');
  // 필터 되돌리기(줄마다 앞 바이트 1개가 필터 종류)
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0, b = y ? px[prev + x] : 0, c = y && x >= bpp ? px[prev + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  // 표본 하나 읽기(k번째 채널 값, 0..2^depth−1) → 8비트로
  const max = (1 << Math.min(depth, 8)) - 1;
  const sample = (y, idx) => {
    if (depth === 8) return px[y * stride + idx];
    if (depth === 16) return px[y * stride + idx * 2];
    const bit = idx * depth, byte = px[y * stride + (bit >> 3)];
    return (byte >> (8 - depth - (bit & 7))) & max;
  };
  const out = Buffer.alloc(width * height * 4);
  const key16 = (k) => (trns && trns.length >= 2 * (k + 1) ? trns.readUInt16BE(2 * k) : -1); // 회색·RGB의 투명색(원래 비트 깊이 값)
  const rawSample = (y, idx) => (depth === 16 ? px.readUInt16BE(y * stride + idx * 2) : sample(y, idx));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const q = (y * width + x) * 4;
    if (color === 3) {
      const k = sample(y, x);
      if (!plte || k * 3 + 2 >= plte.length) throw new Error('PNG 팔레트가 잘못됐습니다.');
      out[q] = plte[k * 3]; out[q + 1] = plte[k * 3 + 1]; out[q + 2] = plte[k * 3 + 2];
      out[q + 3] = trns && k < trns.length ? trns[k] : 255;
    } else if (color === 0 || color === 4) {
      const g = depth >= 8 ? sample(y, x * ch) : Math.round(sample(y, x * ch) * 255 / max);
      out[q] = out[q + 1] = out[q + 2] = g;
      out[q + 3] = color === 4 ? sample(y, x * ch + 1) : rawSample(y, x) === key16(0) ? 0 : 255;
    } else {
      out[q] = sample(y, x * ch); out[q + 1] = sample(y, x * ch + 1); out[q + 2] = sample(y, x * ch + 2);
      out[q + 3] = color === 6 ? sample(y, x * ch + 3)
        : [0, 1, 2].every((k) => rawSample(y, x * ch + k) === key16(k)) ? 0 : 255;
    }
  }
  return { width, height, data: out };
}

// v6 Wave D: RGBA(촘촘한 줄) → PNG 바이트. 비교의 픽셀 차이 그림(투명 바탕 위 색)처럼 엔진 밖에서 만든 그림용(필터 0, 8비트 RGBA)
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function encodePng(rgba, width, height) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6; // 8비트 RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
module.exports = { sniff, MIME, pngSize, jpegSize, imageSize, decodePng, encodePng };
