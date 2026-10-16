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
// ── v6.1 그림을 PDF로 열기: 형식 판별(BMP·GIF·WebP까지) · BMP 풀기 · JPEG 방향(EXIF) · 방향 바로잡기 · 줄이기 ──────────────
// sniff는 도장·그림 넣기가 쓰는 PNG/JPEG 판별 그대로 두고, 그림 열기용은 따로 둔다(도장에 BMP가 들어가지 않게)
function sniffImage(buf) {
  const t = sniff(buf);
  if (t) return t;
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'; // 'BM'
  const head = buf.toString('latin1', 0, 6);
  if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// BMP → { width, height, data: 촘촘한 RGBA }. 무압축(BI_RGB) 1·4·8·16·24·32비트, BI_BITFIELDS(16·32비트, 알파 마스크 포함),
// 아래→위(기본)·위→아래(높이 음수) 줄 순서. RLE 압축·JPEG/PNG를 품은 BMP는 풀지 않는다(throw) — 화면이 브라우저 디코더로 다시 시도한다
function decodeBmp(buf) {
  if (sniffImage(buf) !== 'bmp' || buf.length < 26) throw new Error('BMP 파일이 아닙니다.');
  const dataOff = buf.readUInt32LE(10), hsize = buf.readUInt32LE(14);
  let width, height, bpp, comp = 0, used = 0;
  if (hsize === 12) { width = buf.readUInt16LE(18); height = buf.readInt16LE(20); bpp = buf.readUInt16LE(24); }
  else if (hsize >= 40 && buf.length >= 14 + 40) {
    width = buf.readInt32LE(18); height = buf.readInt32LE(22); bpp = buf.readUInt16LE(28); comp = buf.readUInt32LE(30); used = buf.readUInt32LE(46);
  } else throw new Error('지원하지 않는 BMP 형식입니다.');
  const topDown = height < 0; height = Math.abs(height);
  if (!(width > 0 && height > 0) || width * height > 40e6) throw new Error('BMP 크기가 잘못됐거나 너무 큽니다.');
  if (![0, 3, 6].includes(comp)) throw new Error('압축된 BMP(RLE 등)는 직접 풀지 않습니다.');
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new Error('지원하지 않는 BMP 색 깊이입니다.');
  // 색 마스크: BITFIELDS면 헤더 뒤(40바이트 헤더) 또는 헤더 안(V4·V5), 아니면 기본값
  let masks = null;
  if (comp === 3 || comp === 6) {
    const at = 14 + 40, n = comp === 6 || hsize >= 56 ? 4 : 3;
    if (buf.length < at + n * 4) throw new Error('BMP 색 마스크가 잘렸습니다.');
    masks = Array.from({ length: n }, (_, k) => buf.readUInt32LE(at + k * 4));
    if (n === 3) masks.push(0);
  } else if (bpp === 16) masks = [0x7c00, 0x03e0, 0x001f, 0];
  else if (bpp === 32) masks = [0x00ff0000, 0x0000ff00, 0x000000ff, 0];
  // 팔레트(1·4·8비트): OS/2 머리(12바이트)는 3바이트 BGR, 그 밖에는 4바이트 BGRX
  let pal = null;
  if (bpp <= 8) {
    const entry = hsize === 12 ? 3 : 4, start = 14 + hsize + (comp === 3 ? 12 : comp === 6 ? 16 : 0), n = used || (1 << bpp);
    pal = [];
    for (let k = 0; k < n && start + k * entry + 2 < buf.length; k++) pal.push([buf[start + k * entry + 2], buf[start + k * entry + 1], buf[start + k * entry]]);
    if (!pal.length) throw new Error('BMP 팔레트가 없습니다.');
  }
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOff + stride * height > buf.length) throw new Error('BMP를 읽을 수 없습니다 (데이터가 짧음).');
  // 마스크 하나로 값 꺼내 0..255로 늘리기
  const field = (mask) => {
    if (!mask) return null;
    let shift = 0; while (!((mask >>> shift) & 1)) shift++;
    let bits = 0; while (((mask >>> (shift + bits)) & 1) && bits < 32) bits++;
    const max = 2 ** bits - 1;
    return (v) => Math.round((((v & mask) >>> shift) * 255) / max);
  };
  const fr = masks && masks.map(field);
  const out = Buffer.alloc(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = dataOff + (topDown ? y : height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const q = (y * width + x) * 4;
      if (pal) {
        const bit = x * bpp, byte = buf[row + (bit >> 3)], k = bpp === 8 ? byte : (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        const c = pal[k] || [0, 0, 0];
        out[q] = c[0]; out[q + 1] = c[1]; out[q + 2] = c[2]; out[q + 3] = 255;
      } else if (bpp === 24) {
        const p = row + x * 3;
        out[q] = buf[p + 2]; out[q + 1] = buf[p + 1]; out[q + 2] = buf[p]; out[q + 3] = 255;
      } else {
        const v = bpp === 16 ? buf.readUInt16LE(row + x * 2) : buf.readUInt32LE(row + x * 4);
        out[q] = fr[0](v); out[q + 1] = fr[1](v); out[q + 2] = fr[2](v);
        out[q + 3] = fr[3] ? fr[3](v) : 255;
        // 무압축 32비트의 넷째 바이트: 윈도는 쓰지 않는 바이트로 보지만 알파를 담는 프로그램이 많다 — 하나라도 0이 아니면 알파로 본다
        if (bpp === 32 && comp === 0) { out[q + 3] = buf[row + x * 4 + 3]; if (out[q + 3]) anyAlpha = true; }
      }
    }
  }
  if (bpp === 32 && comp === 0 && !anyAlpha) for (let k = 3; k < out.length; k += 4) out[k] = 255; // 넷째 바이트가 모두 0 = 알파 없음
  return { width, height, data: out };
}

// JPEG EXIF 방향(1~8). 휴대폰 사진은 픽셀을 눕혀 저장하고 방향 값(6 = 시계 방향 90°)만 적는 경우가 많다. 없으면 1
function jpegOrientation(buf) {
  if (!(buf && buf[0] === 0xff && buf[1] === 0xd8)) return 1;
  let off = 2;
  while (off + 4 < buf.length && buf[off] === 0xff) {
    const marker = buf[off + 1], len = buf.readUInt16BE(off + 2);
    if (marker === 0xda || marker === 0xd9) break; // 그림 데이터 시작 — EXIF는 그 앞에만 있다
    if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const t = off + 10;
      if (t + 8 > buf.length) return 1;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p)), u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > buf.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > buf.length) break;
        if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 1; }
      }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

// 방향 값대로 픽셀을 돌리거나 뒤집는다(RGBA). 5~8은 가로·세로가 바뀐다
function orientRgba(img, o) {
  if (!o || o === 1) return img;
  const { width: w, height: h, data } = img, swap = o >= 5, W = swap ? h : w, H = swap ? w : h;
  const out = Buffer.alloc(W * H * 4);
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let x, y;
    switch (o) {
      case 2: x = w - 1 - X; y = Y; break;
      case 3: x = w - 1 - X; y = h - 1 - Y; break;
      case 4: x = X; y = h - 1 - Y; break;
      case 5: x = Y; y = X; break;
      case 6: x = Y; y = h - 1 - X; break;
      case 7: x = w - 1 - Y; y = h - 1 - X; break;
      default: x = w - 1 - Y; y = X; // 8
    }
    data.copy(out, (Y * W + X) * 4, (y * w + x) * 4, (y * w + x) * 4 + 4);
  }
  return { width: W, height: H, data: out };
}

// 넓이 평균으로 줄이기(RGBA). 큰 그림을 쪽 하나에 넣을 크기로 — 늘리지는 않는다
function resizeRgba(img, nw, nh) {
  const { width: w, height: h, data } = img;
  if (nw >= w && nh >= h) return img;
  const out = Buffer.alloc(nw * nh * 4), sx = w / nw, sy = h / nh;
  for (let Y = 0; Y < nh; Y++) {
    const y0 = Math.floor(Y * sy), y1 = Math.max(y0 + 1, Math.min(h, Math.floor((Y + 1) * sy)));
    for (let X = 0; X < nw; X++) {
      const x0 = Math.floor(X * sx), x1 = Math.max(x0 + 1, Math.min(w, Math.floor((X + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) for (let x = x0, p = (y * w + x0) * 4; x < x1; x++, p += 4) { r += data[p]; g += data[p + 1]; b += data[p + 2]; a += data[p + 3]; }
      const n = (y1 - y0) * (x1 - x0), q = (Y * nw + X) * 4;
      out[q] = Math.round(r / n); out[q + 1] = Math.round(g / n); out[q + 2] = Math.round(b / n); out[q + 3] = Math.round(a / n);
    }
  }
  return { width: nw, height: nh, data: out };
}

module.exports = { sniff, MIME, pngSize, jpegSize, imageSize, decodePng, encodePng, sniffImage, decodeBmp, jpegOrientation, orientRgba, resizeRgba };
