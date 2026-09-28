/**
 * doLogin() 的端到端模拟测试。
 *
 * 不开浏览器、不碰真服务器：用假的 `fetch` 扮演正方教务的四个端点，
 * 把 content.js 里的 doLogin 抠出来跑一遍完整登录。
 *
 * 最关键的一条断言：**脚本真正 POST 出去的 `mm`，用 Node 的私钥能解回原密码**。
 * 这才算证明了「服务端收到的是一份能解开的密文」，而不只是「我们调了个加密函数」。
 *
 *   node tools/test-login-flow.mjs
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ZFRSA = require(path.join(HERE, '..', 'rsa-pkcs1.js'));

const SRC = fs.readFileSync(path.join(HERE, '..', 'content.js'), 'utf8');
const BASE = 'https://zf.gdep.edu.cn';

let pass = 0, fail = 0;
/** ok(name, 实际, 期望) —— 用 JSON 比较，避免把「值」当「条件」用错 */
function ok(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
/** okRe(name, 实际值, 正则) —— 断言「值里含某个特征」，失败时把原值打出来 */
function okRe(name, value, re) {
  if (re.test(String(value))) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + JSON.stringify(value) + '\n         want 匹配 ' + re); }
}
function section(t) { console.log('\n' + t); }

// ---------------------------------------------------------------- 抠出需要的那段
//
// 从 `var GNMKDM` 起（要把 SECTION 0 的 looksLikeLoginHtml 一起带上 ——
// checkSession 靠它判断「响应是不是登录页」），到启动闸门之前（含整个 5.4 登录段）。

const a = SRC.indexOf('var GNMKDM');
const b = SRC.indexOf('// 5.5 启动闸门');
if (a < 0 || b <= a) { console.error('切不出登录段'); process.exit(2); }
const LOGIN_SRC = SRC.slice(a, b).replace(/^ {2}/gm, '');

const FACTORY = new Function('document', 'location', 'fetch', 'window', 'chrome', 'sessionStorage', `
  ${LOGIN_SRC}
  return { doLogin: doLogin, checkSession: checkSession, parseLoginInputs: parseLoginInputs,
           extractLoginError: extractLoginError, loginPageHasCaptcha: loginPageHasCaptcha };
`);

// ---------------------------------------------------------------- 造密钥与假服务器

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    modulus: Buffer.from(jwk.n, 'base64url').toString('base64'),
    exponent: Buffer.from(jwk.e, 'base64url').toString('base64'),
    privateKey,
  };
}
const KEY = makeKey();

const MENU_HTML = '<html><head><title>教学管理信息服务平台</title></head>' +
  '<body><div id="yhxx">欢迎</div><a onclick="clickMenu(\'N253512\',\'/xsxk/zzxkyzb_cxZzxkYzbIndex.html\',\'自主选课\')">自主选课</a>' +
  '<div>版权所有 正方软件 版本V-9.0</div></body></html>';

function loginPageHtml(extra) {
  return '<html><head><title>统一身份认证</title></head><body>' +
    '<form id="frmLogin" action="/xtgl/login_slogin.html" method="post">' +
    '<input type="hidden" id="csrftoken" value="AAA,BBB">' +
    '<input type="hidden" id="mmsfjm" value="' + (extra.mmsfjm === undefined ? '1' : extra.mmsfjm) + '">' +
    '<input type="hidden" id="language" value="zh_CN">' +
    '<input type="hidden" id="pkey" value="">' +
    (extra.captcha ? '<input type="text" id="yzm" name="yzm">' : '') +
    '<input type="text" id="yhm" name="yhm" value="">' +
    '<input type="password" id="mm" name="mm" value="">' +
    '</form></body></html>';
}

/** 造一个假 fetch，按 scenario 应答；顺便把收到的请求记录下来 */
function makeFetch(scn) {
  const calls = [];
  const resp = (text, url) => ({ text: async () => text, url, status: 200 });

  const f = async function (url, opts) {
    const u = new URL(url, BASE);
    const method = (opts && opts.method) || 'GET';
    calls.push({ method, path: u.pathname, search: u.search, body: (opts && opts.body) || null });

    if (u.pathname === '/xtgl/login_getPublicKey.html') {
      if (scn.noPublicKey) return resp('', BASE + u.pathname);
      return resp(JSON.stringify({ modulus: KEY.modulus, exponent: KEY.exponent }), BASE + u.pathname + u.search);
    }
    if (u.pathname === '/xtgl/login_slogin.html' && method === 'GET') {
      if (scn.alreadyLoggedIn) return resp(MENU_HTML, BASE + '/xtgl/index_initMenu.html');
      return resp(scn.loginHtml || loginPageHtml({}), BASE + '/xtgl/login_slogin.html');
    }
    if (u.pathname === '/xtgl/login_slogin.html' && method === 'POST') {
      // 成功 = 服务端 302 到主菜单（fetch 自动跟跳，最终 URL 变了）
      if (scn.postFails) {
        return resp('<p id="tips" class="bg_danger sl_danger">用户名或密码不正确，请重新输入！</p>',
          BASE + '/xtgl/login_slogin.html');
      }
      return resp(MENU_HTML, BASE + '/xtgl/index_initMenu.html');
    }
    if (u.pathname === '/xtgl/index_initMenu.html') {
      if (scn.sessionDead) return resp(loginPageHtml({}), BASE + '/xtgl/login_slogin.html');
      return resp(MENU_HTML, BASE + '/xtgl/index_initMenu.html');
    }
    return resp('', BASE + u.pathname);
  };
  return { fetch: f, calls };
}

function runDoLogin(scn) {
  const { fetch, calls } = makeFetch(scn);
  const api = FACTORY(
    { body: { innerText: '' }, documentElement: { innerHTML: '' }, title: '' },   // document（这些用例用不到）
    { href: BASE + '/xtgl/login_slogin.html', pathname: '/xtgl/login_slogin.html' },
    fetch,
    { ZFRSA: ZFRSA },
    undefined,
    { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  );
  return { api, calls };
}

function postCall(calls) { return calls.filter((c) => c.method === 'POST'); }
function pkCall(calls) { return calls.filter((c) => c.path === '/xtgl/login_getPublicKey.html'); }
function decryptMm(body, privateKey) {
  const p = new URLSearchParams(body);
  return crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(p.get('mm'), 'base64'),
  ).toString('utf8');
}

// ---------------------------------------------------------------- 用例

async function main() {
  section('1. 正常登录：POST 出去的密文必须能被私钥解开');
  {
    const { api, calls } = runDoLogin({});
    const r = await api.doLogin('2026000001', 'MyPass@123!');
    ok('返回 ok', r.ok || r, true);

    const posts = postCall(calls);
    ok('只发了 1 次 POST', posts.length, 1);
    const p = new URLSearchParams(posts[0].body);
    ok('yhm 正确', p.get('yhm'), '2026000001');
    ok('csrftoken 原样带上（含逗号）', p.get('csrftoken'), 'AAA,BBB');
    ok('mmsfjm 原样带上', p.get('mmsfjm'), '1');
    ok('language 原样带上', p.get('language'), 'zh_CN');
    ok('pkey 空值也带上', p.has('pkey') && p.get('pkey') === '', true);

    let plain = null, err = null;
    try { plain = decryptMm(posts[0].body, KEY.privateKey); } catch (e) { err = '解不开：' + e.message; }
    ok('★ 私钥能解开 mm 并还原密码', err || plain, 'MyPass@123!');
    ok('mm 不是明文', p.get('mm') !== 'MyPass@123!', true);

    okRe('取公钥时带了 time 参数', pkCall(calls)[0].search, /time=\d+/);
  }

  section('2. 密码错：要把登录页提示抠出来');
  {
    const { api } = runDoLogin({ postFails: true });
    const r = await api.doLogin('2026000001', 'wrongpass');
    ok('返回失败', r.ok, false);
    ok('错误文案被提取', r.error, '用户名或密码不正确，请重新输入！');
  }

  section('3. 启用了验证码：不发登录请求，直接说清楚');
  {
    const { api, calls } = runDoLogin({ loginHtml: loginPageHtml({ captcha: true }) });
    const r = await api.doLogin('2026000001', 'whatever');
    ok('返回失败', r.ok, false);
    okRe('文案提到验证码', r.error, /验证码/);
    ok('没发 POST（不白试一次）', postCall(calls).length, 0);
  }

  section('4. mmsfjm=0：密码不加密，原样发');
  {
    const { api, calls } = runDoLogin({ loginHtml: loginPageHtml({ mmsfjm: '0' }) });
    const r = await api.doLogin('2026000001', 'PlainPass');
    ok('返回 ok', r.ok || r, true);
    const p = new URLSearchParams(postCall(calls)[0].body);
    ok('mm 就是明文', p.get('mm'), 'PlainPass');
    ok('没去取公钥', pkCall(calls).length, 0);
  }

  section('5. 已经是登录态：登录页被弹回主菜单 → 视作可用');
  {
    const { api, calls } = runDoLogin({ alreadyLoggedIn: true });
    const r = await api.doLogin('2026000001', 'whatever');
    ok('返回 ok 且标记 already', { ok: r.ok, already: r.already }, { ok: true, already: true });
    ok('没发 POST', postCall(calls).length, 0);
  }

  section('6. 公钥接口异常：明确报错而不是发一份坏密文');
  {
    const { api, calls } = runDoLogin({ noPublicKey: true });
    const r = await api.doLogin('2026000001', 'whatever');
    ok('返回失败', r.ok, false);
    okRe('文案提到公钥', r.error, /公钥/);
    ok('没发 POST', postCall(calls).length, 0);
  }

  section('7. 账号或密码为空：连请求都不发');
  {
    const { api, calls } = runDoLogin({});
    const r = await api.doLogin('', 'x');
    ok('返回失败', r.ok, false);
    okRe('文案提到为空', r.error, /为空/);
    ok('一个请求都没发', calls.length, 0);
  }

  section('8. checkSession：用主菜单页判断登录态');
  {
    const alive = runDoLogin({});
    const dead = runDoLogin({ sessionDead: true });
    ok('活着 → true', await alive.api.checkSession(), true);
    ok('掉线（被弹到登录页）→ false', await dead.api.checkSession(), false);
  }

  section('9. 空密码不该触发加密（避免无谓地取公钥 + 提交）');
  {
    const { api, calls } = runDoLogin({});
    const r = await api.doLogin('2026000001', '');
    ok('返回失败', r.ok, false);
    ok('请求数为 0', calls.length, 0);
  }

  console.log('\n— ' + pass + ' 通过 / ' + fail + ' 失败 —');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试自身异常：', e);
  process.exit(3);
});
