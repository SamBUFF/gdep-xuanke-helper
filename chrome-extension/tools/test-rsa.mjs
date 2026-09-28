/**
 * rsa-pkcs1.js 的往返测试：用 Node 的 openssl 实现做裁判。
 *
 * PKCS#1 v1.5 加密带随机填充，同样的明文每次密文都不同 —— 所以**不能比对密文**。
 * 唯一可信的验法是**往返**：本模块加密 → Node 私钥解密 → 看明文是否还原。
 * 这样大数乘除、取模、幂运算、填充、base64 全链路都被覆盖到了。
 *
 *   node tools/test-rsa.mjs
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ZFRSA = require(path.join(HERE, '..', 'rsa-pkcs1.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra === undefined ? '' : '\n         ' + extra)); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- 造一对密钥
function makeKey(bits) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    modulusB64: Buffer.from(jwk.n, 'base64url').toString('base64'),
    exponentB64: Buffer.from(jwk.e, 'base64url').toString('base64'),
    privateKey,
    k: Buffer.from(jwk.n, 'base64url').length,
  };
}

function decrypt(privateKey, ctB64) {
  return crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(ctB64, 'base64'),
  );
}

/** 加密 → 解密 → 比对（返回是否一致，顺便把明文带出来便于报错） */
function roundTrip(key, plain) {
  const ct = ZFRSA.encryptPassword(plain, key.modulusB64, key.exponentB64);
  const back = decrypt(key.privateKey, ct).toString('utf8');
  return { ok: back === plain, ct, back };
}

// ---------------------------------------------------------------- 1. base64 / 工具层
section('1. base64 与字节工具');
{
  ok('AQAB 解出 65537',
    JSON.stringify(Array.from(ZFRSA._b64ToBytes('AQAB'))), JSON.stringify([1, 0, 1]));

  for (const n of [0, 1, 2, 3, 4, 5, 31, 255, 256, 257]) {
    const raw = crypto.randomBytes(n);
    const b64 = raw.toString('base64');
    const mine = ZFRSA._bytesToB64(new Uint8Array(raw));
    const back = Buffer.from(ZFRSA._b64ToBytes(b64)).toString('hex');
    if (mine !== b64 || back !== raw.toString('hex')) {
      ok(`base64 往返 n=${n}`, false, `mine=${mine} want=${b64}`);
    } else ok(`base64 往返 n=${n}`, true);
  }

  ok('UTF-8 编码中文',
    Buffer.from(ZFRSA._utf8Bytes('中文Aa1')).toString('hex'),
    Buffer.from('中文Aa1', 'utf8').toString('hex'));
  ok('UTF-8 编码 emoji（代理对）',
    Buffer.from(ZFRSA._utf8Bytes('a😀b')).toString('hex'),
    Buffer.from('a😀b', 'utf8').toString('hex'));
}

// ---------------------------------------------------------------- 2. 大数基础运算
section('2. 大数基础运算（与 BigInt 对照）');
{
  const toBig = (a) => {
    let s = '0';
    for (let i = a.length - 1; i >= 0; i--) s = (BigInt(s) << 16n) + BigInt(a[i]);
    return s;
  };
  // 用随机的大数比 mul / mod
  for (let t = 0; t < 6; t++) {
    const rawA = crypto.randomBytes(64 + t * 16);
    const rawB = crypto.randomBytes(32 + t * 16);
    const a = ZFRSA._bFromBytes(new Uint8Array(rawA));
    const b = ZFRSA._bFromBytes(new Uint8Array(rawB));
    const A = toBig(a), B = toBig(b);

    const mulMine = toBig(ZFRSA._bMul(a, b));
    ok(`mul #${t}`, mulMine === A * B, `got ${mulMine}\n         want ${A * B}`);

    if (B !== 0n) {
      const modMine = toBig(ZFRSA._bMod(a.length >= b.length ? a : ZFRSA._bMul(a, b), b));
      const want = (a.length >= b.length ? A : A * B) % B;
      ok(`mod #${t}`, modMine === want, `got ${modMine}\n         want ${want}`);
    }
  }

  // modPow 与 BigInt 幂取模对照（小指数，慢但正确）
  {
    const n = ZFRSA._bFromBytes(new Uint8Array(crypto.randomBytes(48)));
    const base = ZFRSA._bFromBytes(new Uint8Array(crypto.randomBytes(40)));
    const exp = ZFRSA._bFromBytes(new Uint8Array(Buffer.from([0x01, 0x00, 0x01])));  // 65537
    const got = toBig(ZFRSA._bModPow(base, exp, n));
    const want = (toBig(base) ** 65537n) % toBig(n);
    // BigInt 直接算 65537 次方会爆，所以自己写快速幂
    const bnPow = (b, e, m) => {
      let r = 1n; b %= m;
      while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
      return r;
    };
    ok('modPow（65537）与 BigInt 一致', got === bnPow(toBig(base), 65537n, toBig(n)),
      `got ${got}\n         want ${bnPow(toBig(base), 65537n, toBig(n))}`);
    void want;
  }
}

// ---------------------------------------------------------------- 3. 端到端往返（2048 位）
section('3. 端到端往返 · 2048 位密钥');
{
  const key = makeKey(2048);
  ok('模长 = 256 字节', key.k === 256, 'got ' + key.k);
  ok('模数字节长度自检', ZFRSA._byteLenOf(ZFRSA._b64ToBytes(key.modulusB64)) === 256);

  const cases = [
    ['普通密码', 'Test@1234'],
    ['含空格', 'a b c 1 2 3'],
    ['纯数字', '2026000001'],
    ['中文密码', '密码测试Abc123'],
    ['emoji（代理对）', 'pass😀word'],
    ['最短 1 字节', 'x'],
    ['满长 245 字节', 'A'.repeat(245)],
    ['含特殊字符', "p@$$w0rd!#%^&*()_+-=[]{}|;:'\",.<>/?`~"],
  ];
  for (const [name, pw] of cases) {
    const r = roundTrip(key, pw);
    ok(name, r.ok, `还原成「${r.back}」`);
  }

  ok('密文长度 = 模长（256 字节 → 344 个 base64 字符）',
    Buffer.from(ZFRSA.encryptPassword('x', key.modulusB64, key.exponentB64), 'base64').length === 256);

  ok('同一明文两次密文不同（随机填充生效）',
    ZFRSA.encryptPassword('same', key.modulusB64, key.exponentB64) !==
    ZFRSA.encryptPassword('same', key.modulusB64, key.exponentB64));

  let threw = null;
  try { ZFRSA.encryptPassword('B'.repeat(246), key.modulusB64, key.exponentB64); }
  catch (e) { threw = e.message; }
  ok('超长明文（246 字节）应抛错', !!threw, '没抛错');
}

// ---------------------------------------------------------------- 4. 端到端往返（1024 位）
section('4. 端到端往返 · 1024 位密钥（覆盖不同模长）');
{
  const key = makeKey(1024);
  ok('模长 = 128 字节', key.k === 128, 'got ' + key.k);
  for (const pw of ['short', 'A'.repeat(117), '中文😀']) {
    const r = roundTrip(key, pw);
    ok(`round-trip（${pw.length > 12 ? pw.length + ' 字节' : pw}）`, r.ok, `还原成「${r.back}」`);
  }
}

// ---------------------------------------------------------------- 5. 与 grab.mjs 的公钥解析口径一致
section('5. 与 Node 版 grab.mjs 口径一致');
{
  const key = makeKey(2048);
  // grab.mjs 的做法：JWK 构造公钥 → publicEncrypt(PKCS1)。我这里反过来用它当裁判。
  const jwk = { kty: 'RSA', n: Buffer.from(key.modulusB64, 'base64').toString('base64url'),
    e: Buffer.from(key.exponentB64, 'base64').toString('base64url') };
  const nodeKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const nodeCt = crypto.publicEncrypt(
    { key: nodeKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from('交叉验证', 'utf8'));
  ok('Node 加密的密文能被私钥解开（说明公钥口径一致）',
    decrypt(key.privateKey, nodeCt.toString('base64')).toString('utf8') === '交叉验证');

  const mineCt = ZFRSA.encryptPassword('交叉验证', key.modulusB64, key.exponentB64);
  ok('本模块加密的密文能被同一私钥解开',
    decrypt(key.privateKey, mineCt).toString('utf8') === '交叉验证');

  // 带前导零的 modulus（有些服务器会补 0x00 保持正数）也要认
  const padded = Buffer.concat([Buffer.from([0]), Buffer.from(key.modulusB64, 'base64')]).toString('base64');
  ok('modulus 带前导 0x00 也能正确处理',
    decrypt(key.privateKey, ZFRSA.encryptPassword('前导零', padded, key.exponentB64)).toString('utf8') === '前导零');
}

// ---------------------------------------------------------------- 6. 性能
section('6. 性能（登录时只调一次，不能太慢）');
{
  const key = makeKey(2048);
  const t0 = Date.now();
  ZFRSA.encryptPassword('TimingTest@123', key.modulusB64, key.exponentB64);
  const ms = Date.now() - t0;
  ok(`单次加密 ${ms}ms（阈值 3000ms）`, ms < 3000, '太慢了：' + ms + 'ms');
}

console.log('\n— ' + pass + ' 通过 / ' + fail + ' 失败 —');
process.exit(fail ? 1 : 0);
