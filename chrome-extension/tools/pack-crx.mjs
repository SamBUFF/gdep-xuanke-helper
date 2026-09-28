/**
 * 把 chrome-extension/ 打包成 CRX3。
 *
 * 不依赖任何三方库：ZIP 用 zlib 手写，CRX3 头用 protobuf 手写，签名用 node:crypto。
 *
 * 做三件事：
 *   1. 生成（或复用）RSA 私钥 → 顺手把公钥写回 manifest.json 的 "key"，让扩展 ID 固定下来
 *   2. 打一个标准 ZIP
 *   3. 包成 CRX3（"Cr24" + version + header + zip），并自检签名
 *
 * 用法：node pack-crx.mjs
 * 输出：<工作区>/dist/zf-xk-helper-<version>.crx
 *       <工作区>/dist/zf-xk-helper-<version>.zip   （同上内容，方便别人解压后「加载已解压」）
 *       <工作区>/dist/zf-xk-helper.pem             （私钥，务必留着 —— 丢了就换 ID）
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(SCRIPT_DIR, '..');
const WORKSPACE = path.resolve(EXT_DIR, '..');
const OUT_DIR = path.join(WORKSPACE, 'dist');
const KEY_PATH = path.join(OUT_DIR, 'zf-xk-helper.pem');

const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');
// tools/ 只是开发工具（图标生成、打包脚本本身），不该混进发给 Chrome 的产物里
const SKIP_DIRS = new Set(['node_modules', 'dist', '_dist', '.git', 'tools']);
// .md 也不进包：README 是给人看的，Chrome 不读它。排除掉还有个好处 ——
// 改文档不需要重新打包（否则每次编辑 README 都得重跑一遍签名）。
const SKIP_EXT = new Set(['.pem', '.crx', '.zip', '.md']);

// DOS 时间戳（固定值，让构建可复现）
const DOS_TIME = 23072; // 11:17:00
const DOS_DATE = 23860; // 2026-09-20

// ============================================================ ZIP

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir, base, out) {
  const items = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const it of items) {
    if (it.name.startsWith('.')) continue;
    const abs = path.join(dir, it.name);
    const rel = base ? base + '/' + it.name : it.name;
    if (it.isDirectory()) {
      if (SKIP_DIRS.has(it.name)) continue;
      walk(abs, rel, out);
    } else if (it.isFile()) {
      if (SKIP_EXT.has(path.extname(it.name).toLowerCase())) continue;
      out.push({ rel, abs });
    }
  }
}

function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const raw = fs.readFileSync(f.abs);
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // local file header
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0x0800, 6);       // flags: UTF-8 文件名
    local.writeUInt16LE(8, 8);            // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra len

    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central dir header
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk start
    central.writeUInt16LE(0, 36);         // internal attr
    central.writeUInt32LE(0, 38);         // external attr
    central.writeUInt32LE(offset, 42);    // rel offset of local header
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

// ============================================================ protobuf 小工具

function varint(n) {
  const out = [];
  while (n > 0x7f) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}

/** length-delimited 字段：tag(varint) + len(varint) + payload */
function pbBytes(fieldNo, payload) {
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(payload.length), payload]);
}

// ============================================================ CRX3

function buildCrx(zipBuf, privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // crx_id = SHA256(SPKI DER) 前 16 字节
  const crxId = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);

  // SignedData { bytes crx_id = 1; }
  const signedHeaderData = pbBytes(1, crxId);

  // 待签名内容 = "CRX3 SignedData\0" + uint32le(len(signedHeaderData)) + signedHeaderData + zip
  const magic = Buffer.from('CRX3 SignedData\x00', 'latin1');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(signedHeaderData.length, 0);
  const toSign = Buffer.concat([magic, lenBuf, signedHeaderData, zipBuf]);

  const signature = crypto.sign('sha256', toSign, privateKey);

  // AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
  const proof = Buffer.concat([pbBytes(1, spki), pbBytes(2, signature)]);

  // CrxFileHeader { repeated sha256_with_rsa = 2; bytes signed_header_data = 10000; }
  const header = Buffer.concat([pbBytes(2, proof), pbBytes(10000, signedHeaderData)]);

  const out = Buffer.alloc(12);
  out.write('Cr24', 0, 'latin1');
  out.writeUInt32LE(3, 4);            // CRX3
  out.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([out, header, zipBuf]), crxId, spki };
}

/** crx_id → Chrome 扩展 ID（0-f 映射到 a-p） */
function extensionId(crxId) {
  return crxId.toString('hex').replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
}

/** 拿一份 crx 自己验一遍：魔数、版本、头长、签名、zip 可解 */
function verifyCrx(crxBuf) {
  const r = {};
  r.magic = crxBuf.subarray(0, 4).toString('latin1');
  r.version = crxBuf.readUInt32LE(4);
  const headerLen = crxBuf.readUInt32LE(8);
  r.headerLen = headerLen;
  const header = crxBuf.subarray(12, 12 + headerLen);
  r.zipOffset = 12 + headerLen;
  r.zipLen = crxBuf.length - r.zipOffset;
  r.zipSig = crxBuf.readUInt32LE(r.zipOffset); // 0x04034b50

  // 从 header 里把 proof 和 signed_header_data 抠出来（够用即可的极简解析）
  let i = 0;
  let proof = null;
  let signed = null;
  while (i < header.length) {
    // 读 varint tag
    let shift = 0, tag = 0;
    while (true) {
      const b = header[i++];
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const field = tag >>> 3, wire = tag & 7;
    if (wire !== 2) break;
    let l = 0, s = 0;
    while (true) {
      const b = header[i++];
      l |= (b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7;
    }
    const payload = header.subarray(i, i + l);
    i += l;
    if (field === 2) proof = payload;
    else if (field === 10000) signed = payload;
  }
  r.hasProof = !!proof;
  r.hasSignedHeaderData = !!signed;

  // 从 proof 里取 public_key / signature
  let pub = null, sig = null;
  if (proof) {
    let j = 0;
    while (j < proof.length) {
      let shift = 0, tag = 0;
      while (true) { const b = proof[j++]; tag |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
      const field = tag >>> 3;
      let l = 0, s = 0;
      while (true) { const b = proof[j++]; l |= (b & 0x7f) << s; if (!(b & 0x80)) break; s += 7; }
      const payload = proof.subarray(j, j + l);
      j += l;
      if (field === 1) pub = payload;
      else if (field === 2) sig = payload;
    }
  }
  r.pubLen = pub ? pub.length : 0;
  r.sigLen = sig ? sig.length : 0;

  if (pub && sig && signed) {
    const zipBuf = crxBuf.subarray(r.zipOffset);
    const toSign = Buffer.concat([
      Buffer.from('CRX3 SignedData\x00', 'latin1'),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(signed.length, 0); return b; })(),
      signed, zipBuf,
    ]);
    const keyObj = crypto.createPublicKey({ key: pub, type: 'spki', format: 'der' });
    r.signatureValid = crypto.verify('sha256', toSign, keyObj, sig);
    r.crxId = crypto.createHash('sha256').update(pub).digest().subarray(0, 16).toString('hex');
    r.extensionId = extensionId(Buffer.from(r.crxId, 'hex'));
  }
  return r;
}

// ============================================================ 主流程

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1) 密钥
  let privateKey;
  if (fs.existsSync(KEY_PATH)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
    console.log('复用已有私钥：' + KEY_PATH);
  } else {
    const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    privateKey = pair.privateKey;
    fs.writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log('已生成新私钥：' + KEY_PATH);
  }
  const spki = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const crxId = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
  const extId = extensionId(crxId);

  // 2) 把公钥写回 manifest，固定扩展 ID
  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(manifestRaw);
  const keyB64 = spki.toString('base64');
  if (manifest.key !== keyB64) {
    const next = { ...manifest, key: keyB64 };
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
    console.log('已把 "key" 写入 manifest.json（扩展 ID 从此固定）');
  } else {
    console.log('manifest.json 的 "key" 已是最新');
  }

  const version = manifest.version;

  // 3) 打包
  const files = [];
  walk(EXT_DIR, '', files);
  console.log('待打包 ' + files.length + ' 个文件：' + files.map((f) => f.rel).join(', '));

  const zipBuf = makeZip(files);
  const { crx } = buildCrx(zipBuf, privateKey);

  const crxPath = path.join(OUT_DIR, 'zf-xk-helper-' + version + '.crx');
  const zipPath = path.join(OUT_DIR, 'zf-xk-helper-' + version + '.zip');
  fs.writeFileSync(crxPath, crx);
  fs.writeFileSync(zipPath, zipBuf);

  // 4) 自检
  const v = verifyCrx(crx);

  console.log('');
  console.log('扩展 ID     : ' + extId);
  console.log('crx 路径    : ' + crxPath + '  (' + crx.length + ' 字节)');
  console.log('zip 路径    : ' + zipPath + '  (' + zipBuf.length + ' 字节)');
  console.log('私钥        : ' + KEY_PATH);
  console.log('');
  console.log('— 自检 —');
  console.log('魔数        : ' + v.magic + (v.magic === 'Cr24' ? '  ✔' : '  ✘'));
  console.log('CRX 版本    : ' + v.version + (v.version === 3 ? '  ✔' : '  ✘'));
  console.log('头长度      : ' + v.headerLen);
  console.log('公钥/签名长 : ' + v.pubLen + ' / ' + v.sigLen);
  console.log('签名校验    : ' + (v.signatureValid ? '通过 ✔' : '失败 ✘'));
  console.log('zip 起始签名: 0x' + v.zipSig.toString(16) + (v.zipSig === 0x04034b50 ? '  ✔' : '  ✘'));
  console.log('内嵌 zip 长 : ' + v.zipLen);
  console.log('自检结论    : ' + (v.magic === 'Cr24' && v.version === 3 && v.signatureValid && v.zipSig === 0x04034b50 ? '全部通过 ✔' : '有问题 ✘'));

  if (!(v.magic === 'Cr24' && v.version === 3 && v.signatureValid && v.zipSig === 0x04034b50)) {
    process.exit(1);
  }
}

main();
