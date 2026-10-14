// 도장 보관함: 여러 문서에서 다시 쓰는 도장·서명 이미지(PNG/JPEG)를 앱 데이터 폴더에 모아 둔다.
//   위치: $RETEXTPDF_DATA/stamps (Electron은 main.js가 userData로 지정, node 실행은 ~/.retext-pdf-data/stamps)
//   목록: stamps.json [{ id, name, width, height, type, addedAt }] — 앞쪽이 최근. 이미지 파일은 <id>.png|.jpg
//   id = 이미지 바이트 sha256 앞 16자리 → 같은 이미지를 다시 넣으면 새로 만들지 않고 맨 앞으로 올린다
// 폴더는 부를 때마다 환경 변수에서 읽는다(시험이 임시 폴더로 바꿀 수 있게)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sniff, imageSize } = require('./image-util');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_COUNT = 40;
const EXT = { png: '.png', jpeg: '.jpg' };
const dir = () => path.join(process.env.RETEXTPDF_DATA || path.join(os.homedir(), '.retext-pdf-data'), 'stamps');
const indexFile = () => path.join(dir(), 'stamps.json');
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
const httpError = (status, message) => Object.assign(new Error(message), { status });

// 임시 파일에 쓴 뒤 바꿔치기(server.js writeAtomic과 같은 방식): 쓰다 끊겨도 목록 파일이 반쯤 잘리지 않는다
function writeAtomic(p, data) {
  const tmp = p + '.tmp';
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw new Error(`도장 보관함에 쓰지 못했습니다: ${e.message}`); }
}
// 목록 읽기. 파일이 없거나 깨졌으면 빈 목록, 이미지 파일이 사라진 항목은 뺀다
function load() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch {}
  return (Array.isArray(list) ? list : []).filter((s) => s && validId(s.id) && EXT[s.type] && fs.existsSync(path.join(dir(), s.id + EXT[s.type])));
}
const save = (list) => { fs.mkdirSync(dir(), { recursive: true }); writeAtomic(indexFile(), JSON.stringify(list, null, 1)); };
const view = ({ id, name, width, height, type, addedAt }) => ({ id, name, width, height, type, addedAt });
const cleanName = (name, fallback) => String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || fallback;

function list() { return load().map(view); }

// data: Buffer(이미지 바이트). 같은 이미지면 { duplicate:true }로 기존 항목을 맨 앞에 올린다(이름은 그대로)
function add(name, data) {
  if (!Buffer.isBuffer(data) || !data.length) throw httpError(400, '도장 이미지가 비어 있습니다.');
  if (data.length > MAX_BYTES) throw httpError(413, '도장 이미지는 20MB 이하만 넣을 수 있습니다.');
  const type = sniff(data);
  if (!type) throw httpError(400, '도장은 PNG 또는 JPEG 이미지만 넣을 수 있습니다.');
  const size = imageSize(data);
  if (!size || !size.width || !size.height) throw httpError(400, '이미지 크기를 읽을 수 없습니다 (깨진 파일).');
  const id = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  const all = load(), k = all.findIndex((s) => s.id === id);
  if (k >= 0) {
    const [hit] = all.splice(k, 1);
    hit.addedAt = Date.now();
    save([hit, ...all]);
    return { ...view(hit), duplicate: true };
  }
  if (all.length >= MAX_COUNT) throw httpError(409, `도장은 ${MAX_COUNT}개까지 보관할 수 있습니다. 쓰지 않는 도장을 지운 뒤 다시 넣으세요.`);
  fs.mkdirSync(dir(), { recursive: true });
  writeAtomic(path.join(dir(), id + EXT[type]), data);
  const entry = { id, name: cleanName(name, '도장'), width: size.width, height: size.height, type, addedAt: Date.now() };
  save([entry, ...all]);
  return view(entry);
}

// { meta, data } — 없으면 404
function get(id) {
  if (!validId(id)) throw httpError(400, '도장 id가 잘못됐습니다.');
  const meta = load().find((s) => s.id === id);
  if (!meta) throw httpError(404, '도장을 찾을 수 없습니다.');
  return { meta: view(meta), data: fs.readFileSync(path.join(dir(), id + EXT[meta.type])) };
}

function remove(id) {
  if (!validId(id)) throw httpError(400, '도장 id가 잘못됐습니다.');
  const all = load(), k = all.findIndex((s) => s.id === id);
  if (k < 0) throw httpError(404, '도장을 찾을 수 없습니다.');
  const [gone] = all.splice(k, 1);
  save(all); // 목록에서 먼저 빼고 파일을 지운다 — 파일 삭제가 실패해도(다른 프로그램이 잡음) 목록은 깨끗하다
  try { fs.unlinkSync(path.join(dir(), gone.id + EXT[gone.type])); } catch {}
  return { ok: true };
}

function rename(id, name) {
  if (!validId(id)) throw httpError(400, '도장 id가 잘못됐습니다.');
  const all = load(), hit = all.find((s) => s.id === id);
  if (!hit) throw httpError(404, '도장을 찾을 수 없습니다.');
  hit.name = cleanName(name, hit.name);
  save(all);
  return view(hit);
}

module.exports = { list, add, get, remove, rename, dir, MAX_BYTES, MAX_COUNT };
