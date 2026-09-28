// lib/zf.mjs —— 正方教务 v5 (zf.gdep.edu.cn) 登录 + 自主选课接口封装
//
// 逆向结论（2026-09-20 实测）：
//   · 登录：POST /xtgl/login_slogin.html，字段 yhm / mm( RSA 加密) / csrftoken / 及页面隐藏域
//     RSA 公钥来自 GET /xtgl/login_getPublicKey.html?time=<ms>，返回 {modulus, exponent} (base64)
//     页面 mmsfjm=1 时才加密；加密方式 = RSAES-PKCS1-v1_5，结果 base64（与 jsbn 的 hex2b64(encrypt()) 等价）
//   · 选课页：GET /xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default
//     所有接口参数几乎都来自该页面的隐藏域，因此脚本先抓页面 → 解析隐藏域 → 再调接口
//   · 选课提交用的 jxb_ids 必须是加密后的 do_jxb_id（传 jxb_id 会返回「出现未知异常」）

import crypto from 'node:crypto';

export const GNMKDM = 'N253512';

// ---------------------------------------------------------------- HTML 解析

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = tag.match(re);
  if (!m) return undefined;
  return decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/** 把页面里所有 <input> 的 id → value 抽成字典（正方把上下文全塞在隐藏域里） */
export function parseHiddenInputs(html) {
  const out = {};
  const re = /<input\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = attr(m[0], 'id');
    if (!id) continue;
    out[id] = attr(m[0], 'value') ?? '';
  }
  return out;
}

function stripTags(s) {
  return String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------- RSA 加密

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function trimLeadingZeros(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  return buf.subarray(i);
}

/**
 * 复刻页面里的：rsaKey.setPublic(b64tohex(modulus), b64tohex(exponent));
 *              hex2b64(rsaKey.encrypt(password))
 * 即 RSAES-PKCS1-v1_5 + base64。
 */
export function rsaEncryptPassword(plain, modulusB64, exponentB64) {
  const n = trimLeadingZeros(Buffer.from(modulusB64, 'base64'));
  const e = trimLeadingZeros(Buffer.from(exponentB64, 'base64'));
  const key = crypto.createPublicKey({
    key: { kty: 'RSA', n: b64url(n), e: b64url(e) },
    format: 'jwk',
  });
  return crypto
    .publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(plain, 'utf8'))
    .toString('base64');
}

// ---------------------------------------------------------------- 登录

const LOGIN_ERR_KEYWORDS = [
  '用户名或密码不正确',
  '用户名或密码错误',
  '密码不正确',
  '密码错误',
  '该用户不存在',
  '用户不存在',
  '已被锁定',
  '被锁定',
  '验证码错误',
  '验证码已失效',
  '验证码不正确',
  '登录失败',
  '不能为空',
];

/**
 * 取某个 id 元素的纯文本。
 * 用反向引用匹配同名闭合标签，否则会被内部嵌套的 </span> 提前截断。
 */
function textById(html, id) {
  const m = html.match(new RegExp('<(\\w+)[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)<\\/\\1>', 'i'));
  return m ? stripTags(m[2]) : '';
}

export function extractLoginError(html) {
  // 正方登录页把错误放在 <p id="tips" class="bg_danger sl_danger"> 里
  for (const id of ['tips', 'err-hint', 'errorMsg', 'msg']) {
    const t = textById(html, id);
    if (t) return t;
  }
  const plain = stripTags(html);
  for (const kw of LOGIN_ERR_KEYWORDS) {
    const i = plain.indexOf(kw);
    if (i >= 0) return plain.slice(Math.max(0, i - 30), i + 60).trim();
  }
  return '';
}

/**
 * 登录并返回同一个 Session（Cookie 已写入）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function login(session, { username, password }) {
  const page = await session.get('/xtgl/login_slogin.html');
  const ctx = parseHiddenInputs(page.text);
  if (!ctx.yhm && !/login_slogin/i.test(session.pathname(page.url))) {
    // 已登录状态下访问登录页会被重定向到主菜单，视为直接可用
    return { ok: true, alreadyLoggedIn: true };
  }

  const pkRes = await session.get('/xtgl/login_getPublicKey.html?time=' + Date.now());
  let pk;
  try {
    pk = JSON.parse(pkRes.text);
  } catch {
    throw new Error('获取登录公钥失败，返回内容：' + pkRes.text.slice(0, 120));
  }
  if (!pk.modulus || !pk.exponent) throw new Error('登录公钥字段缺失');

  const needEncrypt = ctx.mmsfjm !== '0';
  const mm = needEncrypt ? rsaEncryptPassword(password, pk.modulus, pk.exponent) : password;

  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(ctx)) form.set(k, v ?? '');
  form.set('yhm', username);
  form.set('mm', mm);
  form.set('language', ctx.language || 'zh_CN');

  const res = await session.post('/xtgl/login_slogin.html', form);
  const pathname = session.pathname(res.url);
  const arrived = !/login_slogin\.html/i.test(pathname);
  if (arrived) return { ok: true };

  const err = extractLoginError(res.text);
  return { ok: false, error: err || '登录被拒（用户名/密码错误，或触发了验证码/锁定策略）' };
}

// ---------------------------------------------------------------- 选课页上下文

/**
 * 拉取选课页并解析出全部上下文隐藏域。
 * 返回 { expired } 表示会话已失效；返回 { ctx:null } 表示页面拿到了但没有选课轮次。
 */
export async function loadSelectContext(session) {
  const path = `/xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=${GNMKDM}&layout=default`;
  const { url, text } = await session.get(path);
  if (/login_slogin/i.test(session.pathname(url))) return { expired: true, ctx: null };
  const ctx = parseHiddenInputs(text);
  if (!ctx.xkkz_id) {
    return {
      expired: false,
      ctx: null,
      reason: '页面里没有 xkkz_id，可能当前不在选课开放期，或该账号无选课权限',
    };
  }
  return { expired: false, ctx };
}

// ---------------------------------------------------------------- 课程列表

// 主列表查询需要的字段（顺序与页面实际发出的请求一致）
const PART_KEYS = [
  'rwlx', 'xklc', 'xkly', 'bklx_id', 'sfkkjyxdxnxq', 'kzkcgs', 'xqh_id', 'njdm_id_1', 'zyh_id_1',
  'gnjkxdnj', 'zyh_id', 'zyfx_id', 'njdm_id', 'bh_id', 'bjgkczxbbjwcx', 'xbm', 'xslbdm', 'mzm',
  'xz', 'ccdm', 'xsbj', 'sfkknj', 'sfkkzy', 'kzybkxy', 'sfznkx', 'zdkxms', 'sfkxq', 'bhbcyxkjxb',
  'sfkcfx', 'kkbk', 'kkbkdj', 'bklbkcj', 'sfkgbcx', 'sfrxtgkcxd', 'xkkz_xh', 'tykczgxdcs', 'xkxnm',
  'xkxqm', 'kklxdm', 'bbhzxjxb', 'zxgbxkkg', 'xkkz_id', 'rlkz', 'xkzgbj',
];

export const PAGE_STEP = 10;

export function buildQueryForm(ctx, page = 1) {
  const form = new URLSearchParams();
  for (const k of PART_KEYS) form.set(k, ctx[k] ?? '');
  form.set('jg_id', ctx.jg_id_1 ?? ctx.jg_id ?? '');
  form.set('kspage', String((page - 1) * PAGE_STEP + 1));
  form.set('jspage', String(page * PAGE_STEP));
  form.set('jxbzb', '');
  return form;
}

/** 查询一页课程。返回 { ok, courses:[], raw }；被拒时 ok=false 并带 reason */
export async function queryCourses(session, ctx, page = 1) {
  const { data, raw } = await session.postJson(
    `/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=${GNMKDM}`,
    buildQueryForm(ctx, page),
  );
  if (raw === '0') return { ok: false, reason: '返回 0（缺 gnmkdm 或会话失效）', courses: [], raw };
  if (!data) return { ok: false, reason: '响应不是 JSON: ' + raw.slice(0, 120), courses: [], raw };
  if (data.flag === '0') return { ok: false, reason: data.msg || '被服务端拒绝', courses: [], raw };
  const courses = Array.isArray(data.tmpList) ? data.tmpList : [];
  return { ok: true, courses, raw, sfxsjc: data.sfxsjc };
}

/** 翻页查完全部课程 */
export async function queryAllCourses(session, ctx, { maxPages = 20 } = {}) {
  const all = [];
  for (let p = 1; p <= maxPages; p++) {
    const r = await queryCourses(session, ctx, p);
    if (!r.ok) return { ok: false, reason: r.reason, courses: all };
    all.push(...r.courses);
    if (r.courses.length < PAGE_STEP) break;
  }
  return { ok: true, courses: all };
}

// ---------------------------------------------------------------- 教学班

const CLASS_KEYS = [
  'rwlx', 'xkly', 'bklx_id', 'sfkkjyxdxnxq', 'kzkcgs', 'xqh_id', 'zyh_id', 'zyfx_id', 'txbsfrl',
  'njdm_id', 'bh_id', 'xbm', 'xslbdm', 'mzm', 'xz', 'ccdm', 'xsbj', 'sfkknj', 'gnjkxdnj', 'sfkkzy',
  'kzybkxy', 'sfznkx', 'zdkxms', 'sfkxq', 'bhbcyxkjxb', 'sfkcfx', 'bbhzxjxb', 'kkbk', 'kkbkdj',
  'bklbkcj', 'xkxnm', 'xkxqm', 'xkxskcgskg', 'rlkz', 'cdrlkz', 'cxcykclxxskg', 'rlzlkz', 'kklxdm',
  'jxbzcxskg', 'zxgbxkkg', 'xklc', 'xkkz_id',
];

/** 展开某门课程下的教学班，返回数组（含 do_jxb_id / jsxx / jxbrl / yxzrs / sksj） */
export async function queryClasses(session, ctx, kchId) {
  const form = new URLSearchParams();
  for (const k of CLASS_KEYS) form.set(k, ctx[k] ?? '');
  form.set('jg_id', ctx.jg_id_1 ?? ctx.jg_id ?? '');
  form.set('kch_id', kchId);
  form.set('cxbj', ctx['cxbj_' + kchId] ?? '0');
  form.set('fxbj', ctx['fxbj_' + kchId] ?? '0');

  const { data, raw } = await session.postJson(
    `/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html?gnmkdm=${GNMKDM}`,
    form,
  );
  if (raw === '0') return { ok: false, reason: '返回 0（非法访问）', classes: [] };
  if (!data) return { ok: false, reason: '响应不是 JSON: ' + raw.slice(0, 120), classes: [] };
  const classes = Array.isArray(data) ? data : Array.isArray(data.rows) ? data.rows : [];
  return { ok: true, classes };
}

// ---------------------------------------------------------------- 冲突预检 / 提交 / 退课

/** 零副作用的选课预检：只做冲突校验，不占位。flag=1 表示可以选 */
export async function checkConflict(session, ctx, kchId, doJxbId) {
  const form = new URLSearchParams({
    jxb_ids: doJxbId,
    xkxnm: ctx.xkxnm ?? '',
    xkxqm: ctx.xkxqm ?? '',
    kch_id: kchId,
    sfyxsksjct: ctx.sfyxsksjct ?? '0',
  });
  const { data, raw } = await session.postJson('/xsxk/zzxkyzb_cxCtKcZyZzxkYzb.html', form);
  return { data, raw };
}

/**
 * 正式选课（会真实占位）。
 * flag=1/3 视为成功。
 */
export async function submitCourse(session, ctx, { kchId, kcmc, doJxbId }) {
  const rlkz = ctx.rlkz ?? '0';
  const cdrlkz = ctx.cdrlkz ?? '0';
  const rlzlkz = ctx.rlzlkz ?? '0';
  const sxbj = rlkz === '1' || cdrlkz === '1' || rlzlkz === '1' ? '1' : '0';

  const form = new URLSearchParams();
  form.set('kcmc', kcmc);
  form.set('kch_id', kchId);
  form.set('jxb_ids', doJxbId);
  form.set('rwlx', ctx.rwlx ?? '');
  form.set('rlkz', rlkz);
  form.set('cdrlkz', cdrlkz);
  form.set('rlzlkz', rlzlkz);
  form.set('sxbj', sxbj);
  form.set('xxkbj', ctx['xxkbj_' + kchId] ?? '0');
  form.set('cxbj', ctx['cxbj_' + kchId] ?? '0');
  form.set('xkkz_id', ctx.xkkz_id ?? '');
  form.set('kklxdm', ctx.kklxdm ?? '');
  form.set('njdm_id', ctx.njdm_id ?? '');
  form.set('zyh_id', ctx.zyh_id ?? '');
  form.set('xklc', ctx.xklc ?? '');
  form.set('xkxnm', ctx.xkxnm ?? '');
  form.set('xkxqm', ctx.xkxqm ?? '');
  form.set('jcxx_id', '');

  const { data, raw } = await session.postJson('/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html', form);
  const flag = data && data.flag;
  return { ok: flag === '1' || flag === '3', flag, data, raw };
}

/**
 * 一键选课：只传 xkkz_id，服务端把该轮次下学生已保存的意向一次性全部提交。
 * 适合先把意向在页面里配好、再让脚本抢时间点。
 */
export async function submitQuick(session, ctx) {
  const { data, raw } = await session.postJson(
    `/xsxk/zzxkyzb_xkZzxkyzbQuickly.html`,
    new URLSearchParams({ xkkz_id: ctx.xkkz_id ?? '' }),
  );
  const flag = data && data.flag;
  return { ok: flag === '1' || flag === '3', flag, data, raw };
}

/** 退课（会真实释放床位） */
export async function dropCourse(session, ctx, { kchId, doJxbIds }) {
  const form = new URLSearchParams({
    kch_id: kchId,
    jxb_ids: Array.isArray(doJxbIds) ? doJxbIds.join(',') : String(doJxbIds),
    xkxnm: ctx.xkxnm ?? '',
    xkxqm: ctx.xkxqm ?? '',
    txbsfrl: ctx.txbsfrl ?? '0',
  });
  const { data, raw } = await session.postJson('/xsxk/zzxkyzb_tuikBcZzxkYzb.html', form);
  const val = data === null ? raw.trim() : data;
  return { ok: val === '1', value: val, raw };
}

/** 已选课程列表（用于确认选课结果） */
export async function queryChoosed(session, ctx) {
  const form = new URLSearchParams();
  for (const k of ['xkxnm', 'xkxqm', 'xkkz_id', 'kklxdm', 'xh_id', 'gnmkdmKey']) {
    form.set(k, ctx[k] ?? '');
  }
  const { data, raw } = await session.postJson(
    `/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html?gnmkdm=${GNMKDM}`,
    form,
  );
  return { data, raw };
}
