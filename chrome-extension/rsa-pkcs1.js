/**
 * rsa-pkcs1.js —— 纯 JS 的 RSAES-PKCS1-v1_5 加密（只做加密，不做解密/签名）。
 *
 * 为什么需要自己写：
 *   正方教务登录页要求密码用 `RSAES-PKCS1-v1_5 + base64` 加密后再 POST（页面 mmsfjm=1 时）。
 *   而浏览器的 WebCrypto 只支持 `RSA-OAEP`，**不支持 PKCS#1 v1.5 加密** —— 这条路走不通。
 *   页面的 jsbn 加密函数跑在主世界，内容脚本读不到。所以只能自带一套大数运算。
 *
 * 与页面行为的等价性（对齐 grab.mjs 里 node:crypto 的复刻结论）：
 *   rsaKey.setPublic(b64tohex(modulus), b64tohex(exponent));
 *   hex2b64(rsaKey.encrypt(password))
 *   ↑ 就是 PKCS#1 v1.5 加密后 base64。填充随机数，所以每次密文都不同，但都能被同一私钥解开。
 *
 * 实现要点：
 *   · 大数用 **16 位肢**（base 65536）小端数组表示 —— 乘积不会超 2^53，不需要 BigInt，
 *     也不需要担心 Number 精度；而且 Chrome 102+ 未必能放心用 BigInt 的性能。
 *   · 幂指数的公开指数通常是 65537（二进制只有 2 个 1），所以 modPow 只要 16 次平方 + 1 次乘法。
 *   · 取模用逐位长除法（够慢但绝对正确），只跑三十来次，登录时几百毫秒无感。
 *   · 不依赖 `atob/btoa/crypto` 之外的任何东西，base64 自己实现，所以 Node 里也能直接 require 做测试。
 *
 * 用法：
 *   ZFRSA.encryptPassword('明文', modulusB64, exponentB64) → 'base64密文'
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.ZFRSA = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  // ============================================================ base64

  var B64C = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function bytesToB64(b) {
    var out = '';
    var i = 0;
    for (; i + 2 < b.length; i += 3) {
      var n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
      out += B64C[(n >>> 18) & 63] + B64C[(n >>> 12) & 63] + B64C[(n >>> 6) & 63] + B64C[n & 63];
    }
    var rem = b.length - i;
    if (rem === 1) {
      var n1 = b[i] << 16;
      out += B64C[(n1 >>> 18) & 63] + B64C[(n1 >>> 12) & 63] + '==';
    } else if (rem === 2) {
      var n2 = (b[i] << 16) | (b[i + 1] << 8);
      out += B64C[(n2 >>> 18) & 63] + B64C[(n2 >>> 12) & 63] + B64C[(n2 >>> 6) & 63] + '=';
    }
    return out;
  }

  var B64REV = null;
  function b64ToBytes(s) {
    if (!B64REV) {
      B64REV = {};
      for (var k = 0; k < 64; k++) B64REV[B64C.charAt(k)] = k;
    }
    s = String(s).replace(/[\s]/g, '').replace(/=+$/, '');
    var out = [];
    var acc = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64REV[s.charAt(i)];
      if (v === undefined) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push((acc >>> bits) & 0xff);
        acc &= bits ? (1 << bits) - 1 : 0;   // 只留低位，别让高位脏数据混进下一个字节
      }
    }
    return new Uint8Array(out);
  }

  /** UTF-8 编码（自己写，不依赖 TextEncoder，方便 Node/浏览器一致） */
  function utf8Bytes(s) {
    var out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  // ============================================================ 大数（16 位肢，小端）

  function bLen(a) { var n = a.length; while (n > 0 && a[n - 1] === 0) n--; return n; }

  function bCmp(a, b) {
    var la = bLen(a), lb = bLen(b);
    if (la !== lb) return la < lb ? -1 : 1;
    for (var i = la - 1; i >= 0; i--) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  }

  /** a - b，要求 a >= b；返回与原数组等长的新数组 */
  function bSub(a, b) {
    var out = new Uint16Array(a.length);
    var borrow = 0;
    for (var i = 0; i < a.length; i++) {
      var t = a[i] - (i < b.length ? b[i] : 0) - borrow;
      if (t < 0) { t += 0x10000; borrow = 1; } else borrow = 0;
      out[i] = t;
    }
    return out;
  }

  function bMul(a, b) {
    var out = new Uint16Array(a.length + b.length + 1);
    for (var i = 0; i < a.length; i++) {
      var ai = a[i];
      if (!ai) continue;
      var carry = 0;
      for (var j = 0; j < b.length; j++) {
        var t = out[i + j] + ai * b[j] + carry;   // ≤ 65535*65535 + 65535 + 65535 < 2^32，精度安全
        out[i + j] = t & 0xffff;
        carry = (t - (t & 0xffff)) / 65536;
      }
      var k = i + b.length;
      while (carry > 0 && k < out.length) {
        var t2 = out[k] + carry;
        out[k] = t2 & 0xffff;
        carry = (t2 - (t2 & 0xffff)) / 65536;
        k++;
      }
    }
    return out;
  }

  function bBitLen(a) {
    var l = bLen(a);
    if (!l) return 0;
    var t = a[l - 1], bits = (l - 1) * 16;
    while (t > 0) { bits++; t >>>= 1; }
    return bits;
  }

  function bGetBit(a, i) {
    var li = i >> 4;
    return li < a.length ? (a[li] >>> (i & 15)) & 1 : 0;
  }

  /** a mod m —— 逐位长除法。正确性优先，速度够用（只跑几十次） */
  function bMod(a, m) {
    if (bLen(m) === 0) throw new Error('mod by zero');
    var r = new Uint16Array(m.length + 1);
    var bits = bBitLen(a);
    for (var i = bits - 1; i >= 0; i--) {
      var carry = 0;
      for (var j = 0; j < r.length; j++) {
        var t = (r[j] << 1) | carry;
        r[j] = t & 0xffff;
        carry = t >>> 16;
      }
      r[0] |= bGetBit(a, i);
      if (bCmp(r, m) >= 0) r = bSub(r, m);
    }
    return r;
  }

  function bModPow(base, exp, mod) {
    var r = new Uint16Array([1]);
    var b = bMod(base, mod);
    var bits = bBitLen(exp);
    for (var i = 0; i < bits; i++) {
      if (bGetBit(exp, i)) r = bMod(bMul(r, b), mod);
      if (i + 1 < bits) b = bMod(bMul(b, b), mod);
    }
    return r;
  }

  function bFromBytes(bytes) {
    var start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;   // 去前导零
    var n = bytes.length - start;
    var limbs = new Uint16Array((n + 1) >> 1);
    for (var i = 0; i < n; i++) {
      var byteFromEnd = bytes[bytes.length - 1 - i];
      var li = i >> 1;
      if (i & 1) limbs[li] |= (byteFromEnd & 0xff) << 8;
      else limbs[li] |= byteFromEnd & 0xff;
    }
    return limbs;
  }

  /** 输出**固定长度**的大端字节串（RSA 密文必须补齐到模长 k） */
  function bToBytes(a, len) {
    var out = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
      var li = i >> 1;
      var limb = li < a.length ? a[li] : 0;
      out[len - 1 - i] = (i & 1) ? ((limb >>> 8) & 0xff) : (limb & 0xff);
    }
    return out;
  }

  /** 去前导零后的字节长度（= 模长 k） */
  function byteLenOf(bytes) {
    var i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    return bytes.length - i;
  }

  // ============================================================ 随机

  function randomNonZero(len) {
    var out = new Uint8Array(len);
    var c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
    if (c && c.getRandomValues) {
      c.getRandomValues(out);
    } else if (typeof require === 'function') {
      try { out.set(require('crypto').randomBytes(len)); } catch (e) { /* 落到下面 */ }
    }
    // 兜底 + PKCS#1 要求填充串里不能有 0x00
    for (var i = 0; i < len; i++) {
      var v = out[i];
      if (!v) v = 1 + Math.floor(Math.random() * 255);
      out[i] = v;
    }
    return out;
  }

  // ============================================================ 对外接口

  /**
   * RSAES-PKCS1-v1_5 加密。
   * @param {string} plain       明文（UTF-8）
   * @param {string} modulusB64  公钥模数（base64，服务端 login_getPublicKey 的 modulus）
   * @param {string} exponentB64 公钥指数（base64，一般 AQAB = 65537）
   * @returns {string} base64 密文
   */
  function encryptPassword(plain, modulusB64, exponentB64) {
    if (!modulusB64 || !exponentB64) throw new Error('公钥为空');
    var nBytes = b64ToBytes(modulusB64);
    var n = bFromBytes(nBytes);
    var e = bFromBytes(b64ToBytes(exponentB64));
    var k = byteLenOf(nBytes);

    var m = utf8Bytes(String(plain));
    if (m.length > k - 11) throw new Error('密码过长（超过 ' + (k - 11) + ' 字节）');

    // EM = 0x00 || 0x02 || PS(随机非零, 长度 k-3-mLen) || 0x00 || M
    var psLen = k - 3 - m.length;
    var em = new Uint8Array(k);
    em[0] = 0x00;
    em[1] = 0x02;
    em.set(randomNonZero(psLen), 2);
    em[2 + psLen] = 0x00;
    em.set(m, 3 + psLen);

    var c = bModPow(bFromBytes(em), e, n);
    return bytesToB64(bToBytes(c, k));
  }

  return {
    encryptPassword: encryptPassword,
    // 下面这些导出只是为了单测能逐层验证
    _b64ToBytes: b64ToBytes,
    _bytesToB64: bytesToB64,
    _utf8Bytes: utf8Bytes,
    _bFromBytes: bFromBytes,
    _bToBytes: bToBytes,
    _bMod: bMod,
    _bModPow: bModPow,
    _bMul: bMul,
    _bCmp: bCmp,
    _byteLenOf: byteLenOf,
  };
});
