/**
 * content.js 里「纯逻辑段」的离线单测（不用开浏览器）。
 *
 * 做法：用字符串切片把 IIFE 里的纯逻辑段抠出来，`new Function('document','location',...)`
 * 用参数名遮蔽全局，塞进假 DOM / 假 sessionStorage 跑断言。
 *
 * 两段被切出来测（都从 `var GNMKDM` 起，因为都要用到 SECTION 0.0 的参数层）：
 *   ① SECTION 0.0 + 0 —— 查询参数层（first* 回落 / 关键参数体检 / 隐藏域解析）+ 页面判定与跳转
 *   ② SECTION 5.4 —— 登录页解析 + 重登状态机（密码加密在 rsa-pkcs1.js，另有 test-rsa.mjs）
 *
 *   node tools/test-content.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'content.js'), 'utf8');

// ---------------------------------------------------------------- 切片工具

function sliceBetween(startMarker, endMarker) {
  const a = SRC.indexOf(startMarker);
  const b = SRC.indexOf(endMarker);
  if (a < 0 || b < 0 || b <= a) {
    console.error('切不出代码段：start=%d end=%d', a, b);
    process.exit(2);
  }
  return SRC.slice(a, b).replace(/^ {2}/gm, '');
}

/** 造一个「在假环境里跑指定代码段」的工厂函数 */
function makeFactory(source, exportNames) {
  const body = `${source}\nreturn { ${exportNames.map((n) => n + ': ' + n).join(', ')} };`;
  const inner = new Function(body);
  const outer = new Function('document', 'location', 'performance', 'sessionStorage', 'window', 'chrome',
    'return (' + inner.toString() + ')();');
  return outer;
}

const GATE_FACTORY = makeFactory(
  sliceBetween('var GNMKDM', 'function showGotoPrompt('),
  ['detectPageState', 'resolveSelectUrl', 'findSelectEntry', 'isSelectPage', 'looksLikeLogin',
    'looksLikeLoginHtml', 'looksLikeZf', 'gotoBlockReason', 'gotoSelect',
    'readGotoState', 'writeGotoState',
    // SECTION 0.0 查询参数层（注意：这一段在 showGotoPrompt 之前，所以切得到）
    'inputsFromHtml', 'decodeEntities', 'ctxH', 'ctxSrc', 'paramReport', 'CTX_OVERRIDE',
    'CRITICAL_PARAMS', 'HID_FALLBACK', 'xkkzFromXkgz'],
);

// 登录段：必须从 `var GNMKDM` 起 —— parseLoginInputs 现在委派给 SECTION 0.0 的 inputsFromHtml，
// 从 CRED_KEY 起切会把 inputsFromHtml 切掉，一跑就 ReferenceError。
const LOGIN_FACTORY = makeFactory(
  sliceBetween('var GNMKDM', '// 5.5 启动闸门'),
  ['parseLoginInputs', 'inputsFromHtml', 'extractLoginError', 'loginPageHasCaptcha', 'reloginIsFresh',
    'readReloginState', 'writeReloginState', 'readLoginFails', 'bumpLoginFails', 'clearLoginFails'],
);

// SECTION 3.9 上课时间解析（纯函数，不碰 DOM / 不发请求）
const SCHED_FACTORY = makeFactory(
  sliceBetween('// 3.9 上课时间解析', '// 4. 目标匹配'),
  ['DAY_NUM', 'parseWeeks', 'weeksIsEmpty', 'parseSchedule', 'schedulesOverlap',
    'scheduleHasDay', 'scheduleHasPeriod', 'parseDaySpec', 'parsePeriodSpec',
    'matchScheduleFilters', 'classConflictsWithChoosed', 'describeSksj'],
);

// SECTION 3.7 退选/换课的**纯判定**部分（isDroppable / xkkzFromXkgz / isConflictMsg）。
// 这一段里带副作用的函数（dropCourse 等）只定义不调用，所以切出来实例化是安全的。
const DROP_FACTORY = makeFactory(
  sliceBetween('// 3.7 退选', '// 4. 目标匹配'),
  ['isDroppable', 'chosenLabel', 'isConflictMsg'],
);

// ---------------------------------------------------------------- 假环境

function makeEnv(spec) {
  const fields = spec.fields || {};
  const anchors = (spec.anchors || []).map((x) => ({
    getAttribute: (k) => (x[k] == null ? null : x[k]),
    textContent: x.text || '',
  }));

  let pwEl = null;
  if (spec.passwordInPanel) pwEl = { closest: (s) => (s === '#zxh-panel' ? {} : null) };
  else if (spec.password) pwEl = { closest: () => null };

  const doc = {
    title: spec.title || '',
    documentElement: { innerHTML: spec.html || '' },
    body: spec.bodyText === undefined ? { innerText: '' } : { innerText: spec.bodyText },
    getElementById: (id) => (fields[id] == null ? null : { value: fields[id] }),
    querySelector: (sel) => (sel === 'input[type=password]' ? pwEl : null),
    querySelectorAll: (sel) => {
      if (sel === 'a[onclick],a[href]') return anchors;
      if (sel === 'form') return (spec.forms || []).map((f) => ({ getAttribute: (k) => (k === 'action' ? f.action : null) }));
      return [];
    },
  };

  const store = new Map();
  const jumped = { url: null };

  const env = {
    document: doc,
    location: {
      pathname: spec.pathname || '/',
      set href(u) { jumped.url = u; },
      get href() { return jumped.url; },
    },
    performance: { getEntriesByType: () => [{ type: spec.navType || 'navigate' }] },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    chrome: undefined,
  };
  return { env, jumped, store };
}

function run(factory, spec) {
  const { env, jumped, store } = makeEnv(spec);
  const api = factory(env.document, env.location, env.performance, env.sessionStorage, {}, env.chrome);
  return { api, jumped, store };
}

// ---------------------------------------------------------------- 断言

let pass = 0, fail = 0;
function ok(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w); }
}
function section(t) { console.log('\n' + t); }

const ZF_MENU = {
  pathname: '/xtgl/index_initMenu.html',
  title: '教学管理信息服务平台',
};

// ================================================================ 第一部分：页面判定与跳转

section('1. 已在自主选课页');
{
  const { api } = run(GATE_FACTORY, {
    pathname: '/xsxk/zzxkyzb_cxZzxkYzbIndex.html',
    title: '教学管理信息服务平台',
    fields: { xkkz_id: 'ABC', xklc: '1', kklxdm: '06' },
  });
  ok('detectPageState = select', api.detectPageState(), 'select');
}

section('2. 主菜单（菜单项可定位）');
{
  const { api } = run(GATE_FACTORY, {
    ...ZF_MENU,
    anchors: [
      { onclick: "clickMenu('N253508','/xsxk/zzxkyzb_cxXskbIndex.html','个人课表查询')", text: '个人课表查询' },
      { onclick: "clickMenu('N253512','/xsxk/zzxkyzb_cxZzxkYzbIndex.html','自主选课')", text: '自主选课' },
    ],
  });
  ok('detectPageState = other-zf', api.detectPageState(), 'other-zf');
  ok('resolveSelectUrl 正确',
    api.resolveSelectUrl(),
    '/xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default');
}

section('3. 菜单参数顺序颠倒');
{
  const { api } = run(GATE_FACTORY, {
    ...ZF_MENU,
    anchors: [{ onclick: "clickMenu('/xsxk/zzxkyzb_cxZzxkYzbIndex.html','N253512','自主选课')", text: '自主选课' }],
  });
  const e = api.findSelectEntry();
  ok('findSelectEntry 找到', !!e, true);
  ok('path 抠对', e && e.path, '/xsxk/zzxkyzb_cxZzxkYzbIndex.html');
  ok('code 抠对', e && e.code, 'N253512');
}

section('3.5 选课模块下别的页面（路径也含 zzxkyzb）');
{
  const { api } = run(GATE_FACTORY, {
    ...ZF_MENU,
    anchors: [{ onclick: "clickMenu('N253508','/xsxk/zzxkyzb_cxXskbIndex.html','个人课表查询')", text: '个人课表查询' }],
  });
  ok('个人课表查询不算自主选课', api.findSelectEntry(), null);
  ok('仍然识别为 other-zf（靠指纹）', api.detectPageState(), 'other-zf');

  const sib = run(GATE_FACTORY, { pathname: '/xsxk/zzxkyzb_cxXskbIndex.html', title: '' });
  ok('兄弟页面不被当成选课页', sib.api.isSelectPage(), false);
  ok('兄弟页面 → unknown', sib.api.detectPageState(), 'unknown');
}

section('4. 菜单项没有路径（只有文字）');
{
  const { api } = run(GATE_FACTORY, {
    ...ZF_MENU,
    anchors: [{ onclick: 'goMenu()', text: '自主选课' }],
  });
  ok('detectPageState = other-zf', api.detectPageState(), 'other-zf');
  ok('无路径时回落硬编码',
    api.resolveSelectUrl(),
    '/xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default');
}

section('5. 没有菜单项，但有正方指纹');
{
  const { api } = run(GATE_FACTORY, {
    pathname: '/xtgl/somePage.html',
    title: '某某页面',
    html: '<div>版权所有 © 正方软件 版本V-9.0</div>',
  });
  ok('detectPageState = other-zf', api.detectPageState(), 'other-zf');
}

section('6. 登录页');
{
  const { api } = run(GATE_FACTORY, {
    pathname: '/xtgl/login_slogin.html',
    title: '统一身份认证',
    password: true,
    forms: [{ action: '/xtgl/login_slogin.html' }],
    html: '<form action="login_slogin.html">教务系统登录</form>',
    fields: { yhm: '', mm: '' },
  });
  ok('detectPageState = unknown', api.detectPageState(), 'unknown');
  ok('looksLikeLogin = true', api.looksLikeLogin(), true);

  // 面板自己也有一个密码框（账号功能用的），不能因此把选课页判成登录页
  const onPanel = run(GATE_FACTORY, {
    pathname: '/xsxk/zzxkyzb_cxZzxkYzbIndex.html',
    title: '教学管理信息服务平台',
    passwordInPanel: true,
    fields: { xkkz_id: 'A', xklc: '1', kklxdm: '06' },
  });
  ok('面板内的密码框不算「登录页」', onPanel.api.looksLikeLogin(), false);
  ok('选课页仍判为 select', onPanel.api.detectPageState(), 'select');
}

section('7. 不相干页面');
{
  const { api } = run(GATE_FACTORY, { pathname: '/xtgl/other.html', title: 'Hello World' });
  ok('detectPageState = unknown', api.detectPageState(), 'unknown');
}

section('8. 跳转闸门');
{
  const { api } = run(GATE_FACTORY, { ...ZF_MENU, navType: 'back_forward' });
  ok('返回导航 → 拦截', api.gotoBlockReason(), 'back_forward');

  const r2 = run(GATE_FACTORY, ZF_MENU);
  r2.store.set('zxh-goto-state', JSON.stringify({ skipUntil: Date.now() + 60000 }));
  ok('点了取消 → 拦截', r2.api.gotoBlockReason(), 'user-declined');

  const r3 = run(GATE_FACTORY, ZF_MENU);
  r3.store.set('zxh-goto-state', JSON.stringify({ at: Date.now(), n: 2 }));
  ok('一分钟内跳了 2 次 → 拦截', r3.api.gotoBlockReason(), 'loop-guard');

  const r4 = run(GATE_FACTORY, ZF_MENU);
  ok('干净状态 → 放行', r4.api.gotoBlockReason(), null);
}

section('9. 识别「登录页 HTML」（会话失效时接口会把登录页当 200 返回）');
{
  const { api } = run(GATE_FACTORY, { pathname: '/' });

  const realLogin =
    '<html><body><form id="frmLogin" action="/xtgl/login_slogin.html">' +
    '<input type="hidden" id="csrftoken" value="a,b"><input type="text" id="yhm">' +
    '<input type="password" id="mm"></form></body></html>';
  ok('真登录页 → true', api.looksLikeLoginHtml(realLogin), true);
  ok('只有 login_slogin + csrftoken → true',
    api.looksLikeLoginHtml('<a href="login_slogin.html">登录</a><input id="csrftoken">'), true);

  ok('选课页 HTML → false',
    api.looksLikeLoginHtml('<div id="displayBox"></div><input id="xkkz_id" value="x">'), false);
  ok('JSON 响应 → false', api.looksLikeLoginHtml('{"flag":"1","tmpList":[]}'), false);
  ok('返回 0 → false', api.looksLikeLoginHtml('0'), false);
  ok('只有密码框没有账号框 → false', api.looksLikeLoginHtml('<input type="password">'), false);
  ok('空字符串 → false', api.looksLikeLoginHtml(''), false);
  ok('null → false', api.looksLikeLoginHtml(null), false);
}

// ================================================================ 第二部分：登录页解析与重登状态

section('10. 解析登录页隐藏域');
{
  const { api } = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  const html =
    '<html><body><form>' +
    '<input type="hidden" id="csrftoken" value="AAA,BBB">' +
    '<input type="hidden" id="mmsfjm" value="1">' +
    '<input type="hidden" id="language" value="zh_CN">' +
    '<input type="hidden" id="pkey" value="">' +
    '<input type="text" id="yhm" value="">' +
    '<input type="password" id="mm" value="">' +
    '<input type="hidden" id="esc" value="a&amp;b&quot;c&lt;d">' +
    '</form></body></html>';
  const ctx = api.parseLoginInputs(html);
  ok('抽到 csrftoken', ctx.csrftoken, 'AAA,BBB');
  ok('抽到 mmsfjm', ctx.mmsfjm, '1');
  ok('抽到 language', ctx.language, 'zh_CN');
  ok('空 value 抽成空串', ctx.pkey, '');
  ok('抽到 yhm/mm（虽然为空）', ctx.yhm === '' && ctx.mm === '', true);
  ok('HTML 实体被还原', ctx.esc, 'a&b"c<d');
  ok('没 id 的 input 被跳过', Object.keys(ctx).length, 7);
}

section('11. 从登录页 HTML 里抠错误文案');
{
  const { api } = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  ok('识别 #tips 里的文案',
    api.extractLoginError('<div><p id="tips" class="bg_danger sl_danger">用户名或密码不正确，请重新输入！</p></div>'),
    '用户名或密码不正确，请重新输入！');
  ok('tips 里有嵌套标签也能整段取出',
    api.extractLoginError('<p id="tips"><span>用户名或密码不正确</span>，请重新输入！</p>'),
    '用户名或密码不正确，请重新输入！');
  ok('没有 #tips 时回落到关键词扫描',
    api.extractLoginError('<div class="err">该用户不存在</div>').includes('该用户不存在'), true);
  ok('识别「已被锁定」',
    api.extractLoginError('<div>你的账号已被锁定，请联系管理员</div>').includes('已被锁定'), true);
  ok('正常页面返回空串', api.extractLoginError('<html><body>欢迎</body></html>'), '');
}

section('12. 验证码检测');
{
  const { api } = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  ok('有 yzm → true', api.loginPageHasCaptcha('<input id="yzm">'), true);
  ok('有 verifycode → true', api.loginPageHasCaptcha('<input id="verifycode">'), true);
  ok('有 checkcode → true', api.loginPageHasCaptcha('<input name="x" id="checkcode">'), true);
  ok('没有 → false', api.loginPageHasCaptcha('<input id="yhm"><input id="mm">'), false);
}

section('13. 续抢标记（sessionStorage）与 TTL');
{
  const { api, store } = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  ok('初始为空', api.readReloginState(), null);

  api.writeReloginState({ at: Date.now(), running: true, from: '/xsxk/x.html' });
  ok('写入后能读回 running', api.readReloginState().running, true);
  ok('标记新鲜', api.reloginIsFresh(api.readReloginState()), true);
  ok('存在 sessionStorage 里', store.has('zxh-relogin'), true);

  ok('过期标记不算新鲜', api.reloginIsFresh({ at: Date.now() - 6 * 60 * 1000, running: true }), false);
  ok('没有 at 字段也不算新鲜', api.reloginIsFresh({ running: true }), false);
  ok('null 不算新鲜', api.reloginIsFresh(null), false);

  api.writeReloginState(null);
  ok('清空后为 null', api.readReloginState(), null);
  ok('清空后 key 也删掉了', store.has('zxh-relogin'), false);

  // 被人塞了脏数据也不能炸
  store.set('zxh-relogin', '{不是JSON');
  ok('脏数据 → null（不抛异常）', api.readReloginState(), null);
}

section('14. 连续登录失败计数（防把账号试锁）');
{
  const { api } = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  ok('初始 0 次', api.readLoginFails().n, 0);
  ok('第 1 次失败 → n=1', api.bumpLoginFails(), 1);
  ok('第 2 次失败 → n=2', api.bumpLoginFails(), 2);
  ok('第 3 次失败 → n=3', api.bumpLoginFails(), 3);
  ok('读回 n=3', api.readLoginFails().n, 3);
  api.clearLoginFails();
  ok('清空后回到 0', api.readLoginFails().n, 0);

  // 超过 10 分钟自动作废（避免昨天失败一次今天就不让自动重登）
  const r2 = run(LOGIN_FACTORY, { pathname: '/xtgl/login_slogin.html' });
  r2.store.set('zxh-login-fails', JSON.stringify({ n: 5, at: Date.now() - 11 * 60 * 1000 }));
  ok('超 10 分钟的失败记录自动作废', r2.api.readLoginFails().n, 0);
}

section('15. ★ 查询参数层：first* 回落（「不点按钮也能查」的地基）');
{
  // 主字段有值 → 用主字段
  const a = run(GATE_FACTORY, { fields: { kklxdm: '06', firstKklxdm: '99' } });
  ok('主字段优先', a.api.ctxH('kklxdm'), '06');
  ok('来源标为 dom', a.api.ctxSrc('kklxdm'), 'dom');

  // 主字段空 → 回落 first*（页面 JS 没跑时就是这种状态）
  const b = run(GATE_FACTORY, { fields: { kklxdm: '', firstKklxdm: '06' } });
  ok('★ 主字段空 → 回落 firstKklxdm', b.api.ctxH('kklxdm'), '06');
  ok('来源标为 first 字段', b.api.ctxSrc('kklxdm'), 'firstKklxdm');
  ok('xkkz_xh 同样能回落', run(GATE_FACTORY, { fields: { firstXkkzXh: 'XH1' } }).api.ctxH('xkkz_xh'), 'XH1');
  ok('xkkz_id 同样能回落', run(GATE_FACTORY, { fields: { firstXkkzId: 'ID1' } }).api.ctxH('xkkz_id'), 'ID1');
  ok('zyh_id 同样能回落', run(GATE_FACTORY, { fields: { firstZyhId: '0620' } }).api.ctxH('zyh_id'), '0620');

  // 两边都没有 → 空
  const c = run(GATE_FACTORY, { fields: {} });
  ok('都没有 → 空串', c.api.ctxH('kklxdm'), '');
  ok('来源为空', c.api.ctxSrc('kklxdm'), '');
  ok('没登记回落的字段也是空', c.api.ctxH('rwlx'), '');

  // bklx_id 没有 first* 可回落 —— 它必须靠 Display 片段补（见第 18 节）
  ok('bklx_id 未登记回落', c.api.HID_FALLBACK.bklx_id, undefined);
}

section('16. ★ 自补层的优先级：DOM > 自补 > first*（顺序错了会拿到过期值）');
{
  // DOM 空 → 自补生效
  const a = run(GATE_FACTORY, { fields: { bklx_id: '' } });
  a.api.CTX_OVERRIDE.bklx_id = 'FROM_SERVER';
  ok('DOM 空 → 用自补值', a.api.ctxH('bklx_id'), 'FROM_SERVER');
  ok('来源标为 server', a.api.ctxSrc('bklx_id'), 'server');

  // ★ DOM 有值 → DOM 必须压过自补
  const b = run(GATE_FACTORY, { fields: { bklx_id: 'FROM_DOM' } });
  b.api.CTX_OVERRIDE.bklx_id = 'STALE_SERVER';
  ok('★ DOM 有值 → DOM 优先，自补不得挡住新值', b.api.ctxH('bklx_id'), 'FROM_DOM');
  ok('来源标为 dom', b.api.ctxSrc('bklx_id'), 'dom');

  // 三级同时存在：DOM 空、自补有、first* 也有 → 自补赢（自补是我们主动取的最新值）
  const c = run(GATE_FACTORY, { fields: { kklxdm: '', firstKklxdm: 'FROM_FIRST' } });
  c.api.CTX_OVERRIDE.kklxdm = 'FROM_SERVER';
  ok('DOM 空时自补压过 first*', c.api.ctxH('kklxdm'), 'FROM_SERVER');
  ok('来源标为 server', c.api.ctxSrc('kklxdm'), 'server');
}

section('17. ★ 关键参数体检：说出「缺哪个」而不是假装没课');
{
  // 只缺 bklx_id（kklxdm 有回落，xkkz_xh 有回落）
  const d = run(GATE_FACTORY, { fields: { kklxdm: '06', firstXkkzXh: 'XH' } });
  const rep = d.api.paramReport();
  ok('体检不通过', rep.ok, false);
  ok('缺的正是 bklx_id', rep.missing, ['bklx_id']);
  ok('两行有值一行没有', rep.rows.map((r) => r.id + '=' + r.ok), ['kklxdm=true', 'bklx_id=false', 'xkkz_xh=true']);
  ok('xkkz_xh 的值来自 first 字段', rep.rows[2].src, 'firstXkkzXh');

  // 三个都在 → 通过
  const e = run(GATE_FACTORY, { fields: { kklxdm: '06', bklx_id: 'BKLX', xkkz_xh: 'XH' } });
  const rep2 = e.api.paramReport();
  ok('体检通过', rep2.ok, true);
  ok('没缺的', rep2.missing, []);
  ok('三行来源都是 dom', rep2.rows.map((r) => r.src), ['dom', 'dom', 'dom']);
  ok('关键参数就是这三个（实测结论，改代码前先重测）',
    e.api.CRITICAL_PARAMS, ['kklxdm', 'bklx_id', 'xkkz_xh']);

  // 全缺
  const f = run(GATE_FACTORY, { fields: {} });
  ok('全缺时三个都报出来', f.api.paramReport().missing, ['kklxdm', 'bklx_id', 'xkkz_xh']);
}

section('18. inputsFromHtml：从服务器 HTML 抠隐藏域（bklx_id 就是这么补到的）');
{
  const { api } = run(LOGIN_FACTORY, { pathname: '/xsxk/zzxkyzb_cxZzxkYzbIndex.html' });
  const html = '<input type="hidden" name="bklx_id" id="bklx_id" value="16419E49AFB4EB9FE065000000000001"/>' +
    '<input type="hidden" id="rwlx" value="3">' +
    '<input type="hidden" id="empty" value="">' +
    '<input id="novalue">' +
    '<input name="noid" value="x">' +
    '<input id="ent" value="a&amp;b&quot;c">';
  const p = api.inputsFromHtml(html);
  ok('抠到 bklx_id', p.bklx_id, '16419E49AFB4EB9FE065000000000001');
  ok('抠到 rwlx', p.rwlx, '3');
  ok('空 value 抠成空串', p.empty, '');
  ok('无 value 属性也收成空串', p.novalue, '');
  ok('没有 id 的被跳过', p.noid, undefined);
  ok('HTML 实体被还原', p.ent, 'a&b"c');
  ok('null / undefined 不抛异常', JSON.stringify(api.inputsFromHtml(null)), '{}');
  ok('parseLoginInputs 与它等价（同一份实现）', api.parseLoginInputs(html).bklx_id, p.bklx_id);
}

// ================================================================
// ★ v2.5.0 新增：退选安全规则 + 上课时间解析
// ================================================================

const S = run(SCHED_FACTORY, {}).api;
const D = run(DROP_FACTORY, {}).api;

function weekCount(set) { let n = 0; for (const k in set) if (set[k]) n++; return n; }

console.log('\n19. ★ 周次规格解析（含单双周）');
{
  ok('1-16 → 16 周', weekCount(S.parseWeeks('1-16')), 16);
  ok('1-16(单) → 8 周', weekCount(S.parseWeeks('1-16(单)')), 8);
  ok('2-16(双) → 8 周', weekCount(S.parseWeeks('2-16(双)')), 8);
  ok('1-16(1-16) 这种嵌套写法也认', weekCount(S.parseWeeks('1-16(1-16)')), 16);
  ok('逗号分段：1-8,10 → 9 周', weekCount(S.parseWeeks('1-8,10')), 9);
  ok('带「周」字也认', weekCount(S.parseWeeks('3-5周')), 3);
  ok('空串 → 空集合', S.weeksIsEmpty(S.parseWeeks('')), true);
  ok('垃圾串 → 空集合（不抛异常）', S.weeksIsEmpty(S.parseWeeks('哈哈')), true);
}

console.log('\n20. ★ 上课时间串解析');
{
  const a = S.parseSchedule('星期一第1-2节{1-16周}');
  ok('解析出 1 段', a.length, 1);
  ok('星期 = 1（周一）', a[0].day, 1);
  ok('起节 = 1', a[0].start, 1);
  ok('止节 = 2', a[0].end, 2);
  ok('周次 16 周', weekCount(a[0].weeks), 16);

  const single = S.parseSchedule('星期三第3节{1-8周}');
  ok('单节：start = end = 3', [single[0].start, single[0].end], [3, 3]);

  const two = S.parseSchedule('星期一第1-2节{1-16周}<br>星期五第5-6节{1-16周}');
  ok('<br> 分隔的多段能全解析', two.length, 2);
  ok('第二段是周五', two[1].day, 5);

  ok('周日写法「日」→ 7', S.parseSchedule('星期日第1-2节{1周}')[0].day, 7);
  ok('周日写法「天」→ 7', S.parseSchedule('星期天第1-2节{1周}')[0].day, 7);
  ok('空串 → null', S.parseSchedule(''), null);
  ok('认不出的串 → null（不抛异常）', S.parseSchedule('待定'), null);
  ok('undefined → null', S.parseSchedule(undefined), null);
}

console.log('\n21. ★ 两段课表是否冲突（本地预判的地基）');
{
  const A = S.parseSchedule('星期一第1-2节{1-16周}');
  ok('同天 + 节次相交 → 冲突', S.schedulesOverlap(A, S.parseSchedule('星期一第2-3节{1-16周}')), true);
  ok('同天但节次不相交 → 不冲突', S.schedulesOverlap(A, S.parseSchedule('星期一第5-6节{1-16周}')), false);
  ok('不同天 → 不冲突', S.schedulesOverlap(A, S.parseSchedule('星期二第1-2节{1-16周}')), false);
  ok('节次同但周次无交集 → 不冲突', S.schedulesOverlap(A, S.parseSchedule('星期一第1-2节{20-24周}')), false);
  ok('周次有交集（部分重叠）→ 冲突', S.schedulesOverlap(A, S.parseSchedule('星期一第1-2节{8-20周}')), true);
  ok('null 参与比较 → 不冲突', S.schedulesOverlap(A, null), false);
}

console.log('\n22. ★ 星期 / 节次规格解析（给人写的那种）');
{
  ok('「一,三」→ [1,3]', S.parseDaySpec('一,三'), [1, 3]);
  ok('「星期一,周三」→ [1,3]', S.parseDaySpec('星期一,周三'), [1, 3]);
  ok('数字「1,7」→ [1,7]', S.parseDaySpec('1,7'), [1, 7]);
  ok('重复去重', S.parseDaySpec('一 周一 1'), [1]);
  ok('空 → []', S.parseDaySpec(''), []);
  ok('「第3-4节」→ [[3,4]]', S.parsePeriodSpec('第3-4节'), [[3, 4]]);
  ok('「3-4,5-6」→ 两段', S.parsePeriodSpec('3-4,5-6'), [[3, 4], [5, 6]]);
  ok('单个「第5节」→ [[5,5]]', S.parsePeriodSpec('第5节'), [[5, 5]]);
  ok('写反了 6-3 会自动纠正成 3-6', S.parsePeriodSpec('6-3'), [[3, 6]]);
}

console.log('\n23. ★ 结构化时间筛选（星期/节次/周次的包含与排除）');
{
  const cls = { sksj: '星期一第1-2节{1-16周}' };
  ok('没配任何筛选 → 放行', S.matchScheduleFilters(cls, {}).ok, true);
  ok('只选周一 → 放行', S.matchScheduleFilters(cls, { dayInc: '一' }).ok, true);
  ok('只选周三 → 拦下', S.matchScheduleFilters(cls, { dayInc: '三' }).ok, false);
  ok('排除周一 → 拦下', S.matchScheduleFilters(cls, { dayExc: '一' }).ok, false);
  ok('排除周三 → 放行', S.matchScheduleFilters(cls, { dayExc: '三' }).ok, true);
  ok('只要 1-2 节 → 放行', S.matchScheduleFilters(cls, { periodInc: '1-2' }).ok, true);
  ok('只要 5-6 节 → 拦下', S.matchScheduleFilters(cls, { periodInc: '5-6' }).ok, false);
  ok('排除 1-2 节 → 拦下', S.matchScheduleFilters(cls, { periodExc: '1-2' }).ok, false);
  ok('周次 1-8 有交集 → 放行', S.matchScheduleFilters(cls, { weekInc: '1-8' }).ok, true);
  ok('周次 20-24 无交集 → 拦下', S.matchScheduleFilters(cls, { weekInc: '20-24' }).ok, false);
  ok('排除周次 1-5 → 拦下', S.matchScheduleFilters(cls, { weekExc: '1-5' }).ok, false);
  ok('排除周次 20-24 → 放行', S.matchScheduleFilters(cls, { weekExc: '20-24' }).ok, true);
  ok('★ sksj 解析不出时不拦（免得格式不同就把课全挡光）',
    S.matchScheduleFilters({ sksj: '待定' }, { dayInc: '一', periodInc: '1-2' }).ok, true);
}

console.log('\n24. ★ 与已选课的本地冲突判定');
{
  const cls = { sksj: '星期一第1-2节{1-16周}' };
  ok('与已选的周一第2-3节冲突', S.classConflictsWithChoosed(cls, [{ sksj: '星期一第2-3节{1-16周}' }]), true);
  ok('与已选的周二课不冲突', S.classConflictsWithChoosed(cls, [{ sksj: '星期二第2-3节{1-16周}' }]), false);
  ok('已选为空 → 不冲突', S.classConflictsWithChoosed(cls, []), false);
  ok('已选里混着解析不了的也不炸', S.classConflictsWithChoosed(cls, [{ sksj: '待定' }]), false);
  ok('自己解析不出 → 不冲突', S.classConflictsWithChoosed({ sksj: '待定' }, [{ sksj: '星期一第1-2节{1周}' }]), false);
}

console.log('\n25. ★★ 退选安全铁律：只有 kklxdm=10 且 rwlx=2 才算「可退选修课」');
{
  ok('10 + 2 → 可退', D.isDroppable({ kklxdm: '10', rwlx: '2' }), true);
  ok('数字型 10 + 2 也认', D.isDroppable({ kklxdm: 10, rwlx: 2 }), true);
  ok('10 + 3 → 不可退', D.isDroppable({ kklxdm: '10', rwlx: '3' }), false);
  ok('01（必修类）+ 2 → 不可退', D.isDroppable({ kklxdm: '01', rwlx: '2' }), false);
  ok('10 + 空 → 不可退', D.isDroppable({ kklxdm: '10', rwlx: '' }), false);
  ok('字段全缺 → 不可退', D.isDroppable({}), false);
  ok('null → 不可退', D.isDroppable(null), false);
}

console.log('\n26. ★ xkgz 规则串 → xkkz_id（第 5 段兜底）');
{
  // xkkzFromXkgz 住在 SECTION 0.0（参数层），所以从 GATE_FACTORY 里取
  const X = run(GATE_FACTORY, {}).api;
  ok('标准串抠得出来',
    X.xkkzFromXkgz('1~0~0~1~5960666114DB1C17E0630B02FD0A8BCE~0~0'),
    '5960666114DB1C17E0630B02FD0A8BCE');
  ok('没有 ~ → 空串', X.xkkzFromXkgz('nope'), '');
  ok('段数不够 → 空串', X.xkkzFromXkgz('1~2~3~4'), '');
  ok('第 5 段太短 → 空串', X.xkkzFromXkgz('1~2~3~4~ABCD~0'), '');
  ok('第 5 段不是十六进制 → 空串', X.xkkzFromXkgz('1~2~3~4~ZZZZZZZZZZZZZZZZ~0'), '');
  ok('null → 空串', X.xkkzFromXkgz(null), '');
}

console.log('\n27. ★ 判定「服务端说冲突了」');
{
  ok('中文冲突文案 → true', D.isConflictMsg({ data: { msg: '上课时间与其他教学班有冲突' } }), true);
  ok('名额已满 → false', D.isConflictMsg({ data: { msg: '该教学班人数已满' } }), false);
  ok('flag=1 成功 → false', D.isConflictMsg({ data: { msg: '选课成功' }, flag: '1' }), false);
  ok('空响应 → false', D.isConflictMsg(null), false);
  ok('data 缺失不炸', D.isConflictMsg({ flag: '0' }), false);
}

console.log('\n28. ★ 时间串给日志看的样子');
{
  ok('多段用分号连起来',
    S.describeSksj('星期一第1-2节{1-16周}<br>星期三第5-6节{1-16周}'),
    '星期一第1-2节{1-16周}；星期三第5-6节{1-16周}');
  ok('空串 → 空串', S.describeSksj(''), '');
}

console.log('\n— ' + pass + ' 通过 / ' + fail + ' 失败 —');
process.exit(fail ? 1 : 0);
