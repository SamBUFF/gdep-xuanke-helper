// ==UserScript==
// @name         正方教务 · 通用选课助手
// @namespace    zf-xk-helper
// @version      2.0.0
// @description  正方教务「自主选课」通用助手：多目标优先级队列、教师/时间筛选、仅演练、定时抢课、已选检测。默认演练模式不会误提交。目标配置本地持久化，换轮次换学期不用重填。
// @author       WorkBuddy
// @match        *://*/xsxk/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ─────────────────────────────────────────────────────────────
 *  用法（三选一）
 *   1) 装 Tampermonkey，把本文件整个加进去（选课页自动出现面板）
 *   2) 选课页按 F12 → Console，把本文件全部内容粘进去回车
 *   3) 已登录的选课页里用任意方式注入
 *
 *  跑在浏览器里，直接复用你的登录态，不需要输账号密码。
 *  「仅演练」默认勾着，第一次试保持勾选，确认匹配到的是你想要的教学班，
 *  再取消勾选开始真抢。
 *
 *  ⚠️ 只在选课开放期（页面 #iskxk = 1）才有用。
 * ─────────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  var VERSION = '2.0.0';
  var STORE_KEY = 'zf-xk-helper:v2';
  var GNMKDM = 'N253512'; // 自主选课功能码，各校一致
  var STEP = 10;          // 列表分页步长（服务端固定 10）

  // ============================================================
  // 0. 环境守卫：不是选课页就直接退出，别污染别的页面
  // ============================================================

  function $(id) { return document.getElementById(id); }
  function H(id) { var e = $(id); return e ? String(e.value == null ? '' : e.value) : ''; }

  // 选课页一定带学号隐藏域；xkkz_id 是轮次，只有开放期才下发
  if (!H('xh') && !H('xkkz_id') && !H('xkkz_xh')) return;

  var ALREADY = window.__XK_HELPER__;
  if (ALREADY && ALREADY.version === VERSION) { ALREADY.toggle(); return; }

  // 拆掉旧版本/残留，避免两个面板互相打架
  (function purge() {
    var ids = ['zxh-panel', 'zxh-style', 'gd-grab-panel', 'gd-grab-style'];
    for (var i = 0; i < ids.length; i++) {
      var ns = document.querySelectorAll('#' + ids[i]);
      for (var j = 0; j < ns.length; j++) ns[j].remove();
    }
    if (window.__XK_HELPER__) delete window.__XK_HELPER__;
    if (window.__GDEP_GRAB__) delete window.__GDEP_GRAB__;
  })();

  // ============================================================
  // 1. 工具
  // ============================================================

  /**
   * ★★ 全站级的坑：正方教务覆盖了 Array.prototype.filter 和 Array.prototype.some。
   * 它的 polyfill 是 function(f,g){...f.call(e,d,this[d],this)...}，
   * 也就是回调拿到的是 (index, element) —— 参数顺序和标准反了。
   * 结果：页面上下文里任何 `arr.filter(x => x.usable)` 都会静默返回空数组，
   * 不报错、不抛异常，只是永远筛不出东西。实测 2026-09-20，主菜单页和选课页都中招。
   *
   * ⚠️ 千万不要「修复」它 —— 正方自己的前端代码就是按反的顺序写的，
   *    换成原生实现反而会把教务系统本身搞坏。
   *    正确做法：自己的代码里一次都别用 .filter / .some，统一走下面的 where()。
   * （.map / .forEach / .sort / .slice / .join / .indexOf / .reduce 仍是原生的，可以放心用。）
   */
  function where(arr, fn) {
    var out = [];
    if (!arr) return out;
    for (var i = 0; i < arr.length; i++) {
      if (fn(arr[i], i, arr)) out.push(arr[i]);
    }
    return out;
  }

  function first(arr, fn) { var r = where(arr, fn); return r.length ? r[0] : null; }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function timeNow() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function tokens(s) {
    var raw = String(s == null ? '' : s).split(/[\s,，、;；]+/);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i].trim().toLowerCase();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  function uid() { return 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

  // ============================================================
  // 2. 教学班字段解析
  // ============================================================

  /** 剩余容量 = 容量 - 已选 */
  function remainOf(c) { return (Number(c.jxbrl) || 0) - (Number(c.yxzrs) || 0); }

  /**
   * 教师名。正方把「工号/姓名/职称」塞在一个字段里（实测字段名是 jsmc，
   * 不同版本可能叫 jsxm / jsxx / jshzc），这里统一拆出来并把工号、职称、"无" 剔掉。
   */
  var TITLE_RE = /^(教授|副教授|讲师|助教|高级|副高|中级|初级|无职称|未定级|其他|无|null|undefined)$/i;

  function teacherNamesOf(c) {
    var raw = [c.jsmc, c.jsxm, c.jsxx, c.jshzc, c.jsmc2].join('/');
    var parts = raw.split(/[/,，、;；\s]+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      if (/^\d+$/.test(p)) continue;         // 工号
      if (TITLE_RE.test(p)) continue;        // 职称
      if (out.indexOf(p) < 0) out.push(p);
    }
    return out;
  }

  function teacherOf(c) {
    var n = teacherNamesOf(c);
    return n.length ? n.join('/') : '';
  }

  /** 教学班显示名：优先 jxbmc，退而求其次拼一个 */
  function classLabel(c) {
    return c.jxbmc || ((c.kcmc || '') + ' ' + (teacherOf(c) || ''));
  }

  // ============================================================
  // 3. HTTP 层（同源 fetch，自动带 Cookie）
  // ============================================================

  async function postForm(path, form, wantJson) {
    var body = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    var res = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body,
      credentials: 'same-origin',
    });
    var text = await res.text();
    if (!wantJson) return text;
    try { return JSON.parse(text); } catch (e) { return { __raw: text }; }
  }

  // ---- 参数集（全部从页面隐藏域现读，所以天然适配任何轮次/任何类别）----

  var PART_KEYS = [
    'rwlx', 'xklc', 'xkly', 'bklx_id', 'sfkkjyxdxnxq', 'kzkcgs', 'xqh_id', 'njdm_id_1', 'zyh_id_1',
    'gnjkxdnj', 'zyh_id', 'zyfx_id', 'njdm_id', 'bh_id', 'bjgkczxbbjwcx', 'xbm', 'xslbdm', 'mzm',
    'xz', 'ccdm', 'xsbj', 'sfkknj', 'sfkkzy', 'kzybkxy', 'sfznkx', 'zdkxms', 'sfkxq', 'bhbcyxkjxb',
    'sfkcfx', 'kkbk', 'kkbkdj', 'bklbkcj', 'sfkgbcx', 'sfrxtgkcxd', 'xkkz_xh', 'tykczgxdcs', 'xkxnm',
    'xkxqm', 'kklxdm', 'bbhzxjxb', 'zxgbxkkg', 'xkkz_id', 'rlkz', 'xkzgbj',
  ];

  var CLASS_KEYS = [
    'rwlx', 'xkly', 'bklx_id', 'sfkkjyxdxnxq', 'kzkcgs', 'xqh_id', 'zyh_id', 'zyfx_id', 'txbsfrl',
    'njdm_id', 'bh_id', 'xbm', 'xslbdm', 'mzm', 'xz', 'ccdm', 'xsbj', 'sfkknj', 'gnjkxdnj', 'sfkkzy',
    'kzybkxy', 'sfznkx', 'zdkxms', 'sfkxq', 'bhbcyxkjxb', 'sfkcfx', 'bbhzxjxb', 'kkbk', 'kkbkdj',
    'bklbkcj', 'xkxnm', 'xkxqm', 'xkxskcgskg', 'rlkz', 'cdrlkz', 'cxcykclxxskg', 'rlzlkz', 'kklxdm',
    'jxbzcxskg', 'zxgbxkkg', 'xklc', 'xkkz_id',
  ];

  var CHOOSED_KEYS = ['jg_id', 'zyh_id', 'njdm_id', 'zyfx_id', 'bh_id', 'xz', 'ccdm', 'xqh_id', 'xkxnm', 'xkxqm', 'xkly'];

  function buildQueryForm(page) {
    var f = new URLSearchParams();
    for (var i = 0; i < PART_KEYS.length; i++) f.set(PART_KEYS[i], H(PART_KEYS[i]));
    f.set('jg_id', H('jg_id_1') || H('jg_id'));
    f.set('kspage', String((page - 1) * STEP + 1));
    f.set('jspage', String(page * STEP));
    f.set('jxbzb', '');
    return f;
  }

  function buildClassForm(kchId) {
    var f = new URLSearchParams();
    for (var i = 0; i < CLASS_KEYS.length; i++) f.set(CLASS_KEYS[i], H(CLASS_KEYS[i]));
    f.set('jg_id', H('jg_id_1') || H('jg_id'));
    f.set('kch_id', kchId);
    f.set('cxbj', H('cxbj_' + kchId) || '0');
    f.set('fxbj', H('fxbj_' + kchId) || '0');
    return f;
  }

  // ---- 接口 ----

  var DBG = {};

  /** 课程列表（只读） */
  async function queryCourses(page) {
    var data = await postForm('/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=' + GNMKDM, buildQueryForm(page || 1), true);
    DBG.lastPartAt = Date.now();
    if (data && data.__raw !== undefined) {
      var raw = String(data.__raw).trim();
      DBG.lastPartRaw = raw.slice(0, 200);
      if (raw === '0') return { ok: false, reason: '返回 0（非法访问或会话失效，刷新页面试试）', courses: [] };
      return { ok: false, reason: '响应异常：' + raw.slice(0, 120), courses: [] };
    }
    if (!data) return { ok: false, reason: '空响应', courses: [] };
    if (data.flag === '0') return { ok: false, reason: data.msg || '服务端拒绝', courses: [] };
    return { ok: true, courses: Array.isArray(data.tmpList) ? data.tmpList : [] };
  }

  /** 展开某课程的教学班（只读） */
  async function queryClasses(kchId) {
    var data = await postForm('/xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html?gnmkdm=' + GNMKDM, buildClassForm(kchId), true);
    DBG.lastClsAt = Date.now();
    if (data && data.__raw !== undefined) {
      DBG.lastClsRaw = String(data.__raw).slice(0, 300);
      return { ok: false, reason: '响应异常：' + String(data.__raw).slice(0, 120), classes: [] };
    }
    if (Array.isArray(data)) return { ok: true, classes: data };
    if (data && Array.isArray(data.rows)) return { ok: true, classes: data.rows };
    return { ok: false, reason: '教学班数据格式不认识', classes: [] };
  }

  /**
   * 只返回「令牌有效」的教学班。
   * do_jxb_id 是服务端每次调用新生成的动态加密串（实测 256 字符），提交时必须用它，
   * 传 jxb_id 会被拒（「出现未知异常」）。但它偶尔会下发字面量 "undefined"，
   * 所以这里：① 滤掉无效令牌；② 一条都没有就重试一次；③ 仍没有则回退 jxb_id 并标记降级。
   */
  async function queryUsableClasses(kchId) {
    var last = { classes: [] };
    for (var attempt = 1; attempt <= 2; attempt++) {
      var r = await queryClasses(kchId);
      if (!r.ok) return { error: r.reason, classes: [] };
      var all = r.classes || [];
      var good = where(all, function (c) {
        return c.do_jxb_id && c.do_jxb_id !== 'undefined' && String(c.do_jxb_id).length > 20;
      });
      if (good.length) return { classes: good, degraded: false };
      last = { classes: all };
      if (attempt < 2) await sleep(350);
    }
    return { classes: where(last.classes, function (c) { return !!c.jxb_id; }), degraded: true };
  }

  /** 时间冲突预检（零副作用） */
  async function checkConflict(kchId, doJxbId) {
    return postForm('/xsxk/zzxkyzb_cxCtKcZyZzxkYzb.html', new URLSearchParams({
      jxb_ids: doJxbId,
      xkxnm: H('xkxnm'),
      xkxqm: H('xkxqm'),
      kch_id: kchId,
      sfyxsksjct: H('sfyxsksjct') || '0',
    }), true);
  }

  /** 已选列表（只读） */
  async function queryChoosed() {
    var f = new URLSearchParams();
    for (var i = 0; i < CHOOSED_KEYS.length; i++) {
      var k = CHOOSED_KEYS[i];
      f.set(k, H(k === 'jg_id' ? 'jg_id_1' : k));
    }
    var data = await postForm('/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html', f, true);
    if (Array.isArray(data)) return { ok: true, rows: data };
    if (data && data.__raw !== undefined) return { ok: false, reason: String(data.__raw).slice(0, 120), rows: [] };
    return { ok: false, reason: '已选列表格式不认识', rows: [] };
  }

  /** 正式选课 ← 有真实副作用，一次成功即占位 */
  async function submitCourse(kchId, kcmc, doJxbId) {
    var rlkz = H('rlkz') || '0';
    var cdrlkz = H('cdrlkz') || '0';
    var rlzlkz = H('rlzlkz') || '0';
    var f = new URLSearchParams();
    f.set('kcmc', kcmc);
    f.set('kch_id', kchId);
    f.set('jxb_ids', doJxbId);
    f.set('rwlx', H('rwlx'));
    f.set('rlkz', rlkz);
    f.set('cdrlkz', cdrlkz);
    f.set('rlzlkz', rlzlkz);
    f.set('sxbj', (rlkz === '1' || cdrlkz === '1' || rlzlkz === '1') ? '1' : '0');
    f.set('xxkbj', H('xxkbj_' + kchId) || '0');
    f.set('cxbj', H('cxbj_' + kchId) || '0');
    f.set('xkkz_id', H('xkkz_id'));
    f.set('kklxdm', H('kklxdm'));
    f.set('njdm_id', H('njdm_id'));
    f.set('zyh_id', H('zyh_id'));
    f.set('xklc', H('xklc'));
    f.set('xkxnm', H('xkxnm'));
    f.set('xkxqm', H('xkxqm'));
    f.set('jcxx_id', '');
    var data = await postForm('/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html', f, true);
    var flag = data && data.flag;
    return { ok: flag === '1' || flag === '3', flag: flag, data: data };
  }

  /** 一键选课：把该轮次下你已保存的「选课意向/志愿」一次性全部提交（有真实副作用） */
  async function submitQuick() {
    var data = await postForm('/xsxk/zzxkyzb_xkZzxkyzbQuickly.html',
      new URLSearchParams({ xkkz_id: H('xkkz_id') }), true);
    var flag = data && data.flag;
    return { ok: flag === '1' || flag === '3', flag: flag, data: data };
  }

  // ============================================================
  // 4. 目标匹配 —— 通用版的核心
  // ============================================================
  //
  //  目标（target）字段：
  //    name       课程名关键词，空格分隔 = 全部命中（AND）。模糊、忽略大小写
  //    kch        课程号，填了就按课程号精确匹配（课程名可以不填）
  //    teacherInc 只选这些教师，逗号/空格分隔，任一命中即可
  //    teacherExc 排除这些教师
  //    timeInc    上课时间必须包含这些关键词，如 "星期一" / "第5-6节"
  //    minRemain  最少剩余容量（1 = 必须有余量；抽签类轮次可设 0）
  //
  //  匹配范围包含 kcmc(课程名) / kch(课程号) / kzmc(课程组名)，
  //  所以写 "体育" 也能命中 "体育I-z120100012" 这种组名。

  function targetIsValid(t) { return !!(t.name || t.kch); }

  function matchCourse(course, t) {
    if (!targetIsValid(course ? t : null)) return false;
    if (t.kch) {
      var want = String(t.kch).toLowerCase();
      if (String(course.kch || '').toLowerCase().indexOf(want) < 0) return false;
    }
    var nameTokens = tokens(t.name);
    if (nameTokens.length) {
      var hay = [course.kcmc, course.kch, course.kzmc, course.kclxmc].join(' ').toLowerCase();
      for (var i = 0; i < nameTokens.length; i++) {
        if (hay.indexOf(nameTokens[i]) < 0) return false;
      }
    }
    return true;
  }

  function matchClass(cls, t) {
    var names = teacherNamesOf(cls);
    var lowerNames = [];
    for (var i = 0; i < names.length; i++) lowerNames.push(names[i].toLowerCase());

    var inc = tokens(t.teacherInc);
    if (inc.length) {
      var hit = false;
      for (var a = 0; a < inc.length; a++) {
        for (var b = 0; b < lowerNames.length; b++) {
          if (lowerNames[b].indexOf(inc[a]) >= 0) { hit = true; break; }
        }
        if (hit) break;
      }
      if (!hit) return false;
    }

    var exc = tokens(t.teacherExc);
    for (var c = 0; c < exc.length; c++) {
      for (var d = 0; d < lowerNames.length; d++) {
        if (lowerNames[d].indexOf(exc[c]) >= 0) return false;
      }
    }

    var timeInc = tokens(t.timeInc);
    if (timeInc.length) {
      var sksj = String(cls.sksj || '').toLowerCase().replace(/\s+/g, '');
      for (var e = 0; e < timeInc.length; e++) {
        if (sksj.indexOf(timeInc[e].replace(/\s+/g, '')) < 0) return false;
      }
    }

    var minR = Number(t.minRemain);
    if (!isNaN(minR) && minR > 0 && remainOf(cls) < minR) return false;

    return true;
  }

  /** 给一个目标挑教学班：先按筛选条件过滤，再按剩余容量降序 */
  function pickClassForTarget(classes, t) {
    var hits = where(classes, function (c) { return matchClass(c, t); });
    if (!hits.length) return { ok: false, reason: '没有符合筛选条件的教学班（共 ' + classes.length + ' 个）' };
    hits.sort(function (a, b) { return remainOf(b) - remainOf(a); });
    return { ok: true, cls: hits[0], count: hits.length };
  }

  // ============================================================
  // 5. 配置持久化
  // ============================================================

  var OPTS = {
    interval: 1200,   // 轮询基础间隔 ms
    jitter: 400,      // 随机抖动上限 ms
    dryRun: true,     // 仅演练
    precheck: false,  // 提交前做冲突预检（更稳但多一次往返，抢速度时别开）
    skipChoosed: true,// 已选过的课程自动跳过
    maxRounds: 0,     // 0 = 不限轮次
  };

  var targets = [];
  var saveTimer = null;

  function saveCfg() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ v: VERSION, opts: OPTS, targets: targets }));
      } catch (e) { /* 隐私模式等，忽略 */ }
    }, 250);
  }

  function loadCfg() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      var o = JSON.parse(raw);
      if (o && o.opts) {
        for (var k in OPTS) { if (o.opts[k] !== undefined) OPTS[k] = o.opts[k]; }
      }
      if (o && Array.isArray(o.targets) && o.targets.length) {
        targets.length = 0;
        for (var i = 0; i < o.targets.length; i++) targets.push(o.targets[i]);
        return true;
      }
    } catch (e) { /* 损坏就当没有 */ }
    return false;
  }

  function newTarget(name) {
    return {
      id: uid(), enabled: true, name: name || '', kch: '',
      teacherInc: '', teacherExc: '', timeInc: '', minRemain: 1,
      done: false, status: '',
    };
  }

  // ============================================================
  // 6. UI
  // ============================================================

  var CSS = [
    '#zxh-panel{position:fixed;right:14px;bottom:14px;width:392px;max-height:84vh;display:flex;flex-direction:column;',
    'background:#fff;color:#1f2328;border:1px solid #d0d7de;border-radius:10px;',
    'box-shadow:0 8px 28px rgba(27,31,36,.22);font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;z-index:2147483000;}',
    '#zxh-panel *{box-sizing:border-box;}',
    '#zxh-panel .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #e6e9ee;background:#f6f8fa;border-radius:10px 10px 0 0;}',
    '#zxh-panel .hd b{font-size:13px;flex:1;font-weight:600;}',
    '#zxh-panel .hd .ver{font-size:10px;color:#8b949e;font-weight:400;}',
    '#zxh-panel .bd{padding:8px 10px;overflow:auto;}',
    '#zxh-panel label{display:block;font-size:11px;color:#57606a;margin-bottom:2px;}',
    '#zxh-panel input[type=text],#zxh-panel input[type=number]{width:100%;padding:4px 6px;border:1px solid #d0d7de;border-radius:6px;font-size:12px;background:#fff;color:#1f2328;}',
    '#zxh-panel input:focus{outline:none;border-color:#0969da;box-shadow:0 0 0 2px rgba(9,105,218,.15);}',
    '#zxh-panel button{padding:5px 8px;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;color:#1f2328;font-size:12px;cursor:pointer;white-space:nowrap;}',
    '#zxh-panel button:hover{background:#eef1f4;}',
    '#zxh-panel button:disabled{opacity:.45;cursor:not-allowed;}',
    '#zxh-panel button.pri{background:#0969da;border-color:#0969da;color:#fff;font-weight:600;}',
    '#zxh-panel button.pri:hover{background:#0860c4;}',
    '#zxh-panel button.dgr{background:#cf222e;border-color:#cf222e;color:#fff;font-weight:600;}',
    '#zxh-panel button.dgr:hover{background:#b81c26;}',
    '#zxh-panel .meta{font-size:11px;color:#57606a;background:#f6f8fa;border:1px solid #e6e9ee;border-radius:6px;padding:5px 7px;margin-bottom:7px;white-space:pre-wrap;word-break:break-all;}',
    '#zxh-panel .sect{display:flex;align-items:center;gap:6px;margin:8px 0 5px;font-size:11px;font-weight:600;color:#57606a;}',
    '#zxh-panel .sect i{flex:1;height:1px;background:#e6e9ee;display:block;font-style:normal;}',
    '#zxh-panel .tgts{max-height:30vh;overflow:auto;border:1px solid #e6e9ee;border-radius:7px;background:#fbfcfd;padding:5px;}',
    '#zxh-panel .tgt{border:1px solid #e6e9ee;border-radius:6px;background:#fff;padding:5px 6px;margin-bottom:5px;}',
    '#zxh-panel .tgt:last-child{margin-bottom:0;}',
    '#zxh-panel .tgt.off{opacity:.5;}',
    '#zxh-panel .tgt.ok{border-color:#2da44e;background:#f0fbf3;}',
    '#zxh-panel .tgt.bad{border-color:#e8a0a5;background:#fff8f8;}',
    '#zxh-panel .th{display:flex;align-items:center;gap:5px;}',
    '#zxh-panel .th .idx{font-size:10px;color:#8b949e;min-width:12px;}',
    '#zxh-panel .th input[type=checkbox]{margin:0;cursor:pointer;flex:0 0 auto;}',
    '#zxh-panel .th input.t-name{flex:1;font-weight:600;}',
    '#zxh-panel .th button{padding:2px 6px;font-size:11px;line-height:1.3;}',
    '#zxh-panel .tst{font-size:10.5px;color:#57606a;margin-top:3px;padding-left:17px;word-break:break-all;}',
    '#zxh-panel .tst .g{color:#1a7f37;font-weight:600;}',
    '#zxh-panel .tst .r{color:#cf222e;}',
    '#zxh-panel .adv{margin-top:5px;padding-left:17px;display:grid;grid-template-columns:1fr 1fr;gap:4px 6px;}',
    '#zxh-panel .adv .full{grid-column:1/3;}',
    '#zxh-panel .adv input{font-size:11px;padding:3px 5px;}',
    '#zxh-panel .adv label{font-size:10px;margin-bottom:1px;color:#8b949e;}',
    '#zxh-panel .adv .ord{grid-column:1/3;display:flex;gap:5px;}',
    '#zxh-panel .adv .ord button{flex:1;padding:3px;font-size:11px;}',
    '#zxh-panel .chk{display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;margin:4px 0;}',
    '#zxh-panel .chk input{margin:0;cursor:pointer;}',
    '#zxh-panel .row{display:flex;gap:6px;}',
    '#zxh-panel .row>*{flex:1;}',
    '#zxh-panel .log{margin-top:6px;height:132px;overflow:auto;background:#0d1117;color:#c9d1d9;border-radius:6px;padding:6px 7px;',
    'font:11px/1.6 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-all;}',
    '#zxh-panel .log .w{color:#e3b341;}',
    '#zxh-panel .log .e{color:#ff7b72;}',
    '#zxh-panel .log .s{color:#7ee787;}',
    '#zxh-panel .log .d{color:#8b949e;}',
    '#zxh-panel .cfg{display:none;margin-top:6px;}',
    '#zxh-panel .cfg textarea{width:100%;height:110px;font:10.5px/1.5 Consolas,Menlo,monospace;border:1px solid #d0d7de;border-radius:6px;padding:5px;resize:vertical;color:#1f2328;background:#fff;}',
    '#zxh-panel .hint{font-size:10.5px;color:#8b949e;margin-top:5px;}',
    '#zxh-panel.min .bd{display:none;}',
  ].join('');

  var HTML = [
    '<div class="hd"><b>选课助手 <span class="ver">v' + VERSION + '</span></b>',
    '<button id="zxh-min" title="折叠/展开">—</button></div>',
    '<div class="bd">',
    '<div class="meta" id="zxh-meta">读取页面上下文…</div>',

    '<div class="sect">目标队列（从上往下依次尝试）<i></i></div>',
    '<div class="tgts" id="zxh-tgts"></div>',
    '<div class="row" style="margin-top:6px">',
    '<button id="zxh-add">＋ 添加目标</button>',
    '<button id="zxh-cfgbtn">配置</button>',
    '</div>',

    '<div class="cfg" id="zxh-cfg">',
    '<label>配置 JSON（导出后自行保存，换轮次/换设备直接粘贴回来）</label>',
    '<textarea id="zxh-cfgtext" placeholder="点「导出」把当前目标填进来；或粘贴一份配置再点「导入」"></textarea>',
    '<div class="row" style="margin-top:5px">',
    '<button id="zxh-export">导出</button>',
    '<button id="zxh-import">导入</button>',
    '<button id="zxh-copy">复制</button>',
    '</div></div>',

    '<div class="sect">运行参数<i></i></div>',
    '<div class="row">',
    '<div><label>间隔 ms</label><input type="number" id="zxh-iv" value="1200" min="400" step="100"></div>',
    '<div><label>抖动 ms</label><input type="number" id="zxh-jt" value="400" min="0" step="100"></div>',
    '<div><label>最多轮次(0不限)</label><input type="number" id="zxh-mr" value="0" min="0" step="10"></div>',
    '</div>',

    '<label class="chk"><input type="checkbox" id="zxh-dry" checked>仅演练，不真正提交<b style="color:#cf222e">（第一次务必保持勾选）</b></label>',
    '<label class="chk"><input type="checkbox" id="zxh-pre">提交前做时间冲突预检</label>',
    '<label class="chk"><input type="checkbox" id="zxh-skip" checked>已选过的课程自动跳过</label>',

    '<div class="row" style="margin-top:5px">',
    '<button id="zxh-preview">预览匹配</button>',
    '<button id="zxh-once">执行一轮</button>',
    '<button id="zxh-quick" title="把本轮你已保存的选课意向一次性全部提交">一键选课</button>',
    '</div>',
    '<div class="row" style="margin-top:5px">',
    '<button id="zxh-start" class="pri">开始抢课</button>',
    '<button id="zxh-stop" class="dgr" disabled>停止</button>',
    '</div>',

    '<div class="log" id="zxh-log"></div>',
    '<div class="hint">参数全部取自本页隐藏域，用的是你浏览器里已有的登录态。改动会自动存在本机浏览器里。</div>',
    '</div>',
  ].join('');

  var el = (function mount() {
    if (!document.getElementById('zxh-style')) {
      var st = document.createElement('style');
      st.id = 'zxh-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    var p = document.createElement('div');
    p.id = 'zxh-panel';
    p.innerHTML = HTML;
    document.body.appendChild(p);

    return {
      panel: p,
      meta: p.querySelector('#zxh-meta'),
      tgts: p.querySelector('#zxh-tgts'),
      log: p.querySelector('#zxh-log'),
      iv: p.querySelector('#zxh-iv'),
      jt: p.querySelector('#zxh-jt'),
      mr: p.querySelector('#zxh-mr'),
      dry: p.querySelector('#zxh-dry'),
      pre: p.querySelector('#zxh-pre'),
      skip: p.querySelector('#zxh-skip'),
      add: p.querySelector('#zxh-add'),
      cfgbtn: p.querySelector('#zxh-cfgbtn'),
      cfg: p.querySelector('#zxh-cfg'),
      cfgtext: p.querySelector('#zxh-cfgtext'),
      exportBtn: p.querySelector('#zxh-export'),
      importBtn: p.querySelector('#zxh-import'),
      copyBtn: p.querySelector('#zxh-copy'),
      preview: p.querySelector('#zxh-preview'),
      once: p.querySelector('#zxh-once'),
      quick: p.querySelector('#zxh-quick'),
      start: p.querySelector('#zxh-start'),
      stop: p.querySelector('#zxh-stop'),
      min: p.querySelector('#zxh-min'),
    };
  })();

  // ---- 日志 ----

  function log(msg, kind) {
    var sp = kind ? '<span class="' + kind + '">' : '<span>';
    el.log.insertAdjacentHTML('beforeend', '<span class="d">' + timeNow() + '</span> ' + sp + esc(msg) + '</span><br>');
    el.log.scrollTop = el.log.scrollHeight;
    if (el.log.childNodes.length > 400) el.log.removeChild(el.log.firstChild);
    if (kind === 'e') console.warn('[选课助手]', msg); else console.log('[选课助手]', msg);
  }

  // ---- 目标卡片渲染 ----

  function renderTargets() {
    el.tgts.innerHTML = '';
    if (!targets.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px;color:#8b949e;padding:6px;text-align:center;';
      empty.textContent = '还没有目标。点下面「添加目标」，填课程名关键词即可（如 篮球）。';
      el.tgts.appendChild(empty);
      return;
    }
    for (var i = 0; i < targets.length; i++) {
      el.tgts.appendChild(buildTargetCard(targets[i], i));
    }
  }

  function buildTargetCard(t, idx) {
    var card = document.createElement('div');
    card.className = 'tgt' + (t.enabled ? '' : ' off') + (t.done ? ' ok' : '');
    card.dataset.id = t.id;

    // 头行：启用 / 序号 / 名称 / 高级 / 删除
    var th = document.createElement('div');
    th.className = 'th';

    var en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = !!t.enabled;
    en.title = '启用/停用这个目标';
    en.addEventListener('change', function () { t.enabled = en.checked; card.className = 'tgt' + (t.enabled ? '' : ' off') + (t.done ? ' ok' : ''); saveCfg(); });

    var ix = document.createElement('span');
    ix.className = 'idx';
    ix.textContent = String(idx + 1);

    var nm = document.createElement('input');
    nm.type = 'text';
    nm.className = 't-name';
    nm.placeholder = '课程名关键词（如 篮球）';
    nm.value = t.name || '';
    nm.addEventListener('input', function () { t.name = nm.value; saveCfg(); });

    var advBtn = document.createElement('button');
    advBtn.textContent = '⚙';
    advBtn.title = '高级：课程号 / 教师 / 时间 / 剩余';

    var del = document.createElement('button');
    del.textContent = '×';
    del.title = '删除';
    del.addEventListener('click', function () {
      // 注意：必须就地修改 targets，不能写 targets = ...，
      // 否则 window.__XK_HELPER__.targets 会指向旧数组，控制台里就看不到变化了
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].id === t.id) { targets.splice(i, 1); break; }
      }
      saveCfg();
      renderTargets();
    });

    th.appendChild(en); th.appendChild(ix); th.appendChild(nm); th.appendChild(advBtn); th.appendChild(del);
    card.appendChild(th);

    // 状态行
    var st = document.createElement('div');
    st.className = 'tst';
    st.innerHTML = t.done
      ? '<span class="g">✔ ' + esc(t.status || '已完成') + '</span>'
      : (t.status ? esc(t.status) : '<span class="d">待抢</span>');
    card.appendChild(st);

    // 高级区
    var adv = document.createElement('div');
    adv.className = 'adv';
    adv.style.display = 'none';

    function field(labelText, cls, value, placeholder, onInput) {
      var w = document.createElement('div');
      var lb = document.createElement('label');
      lb.textContent = labelText;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = cls;
      inp.value = value == null ? '' : value;
      if (placeholder) inp.placeholder = placeholder;
      inp.addEventListener('input', function () { onInput(inp.value); saveCfg(); });
      w.appendChild(lb); w.appendChild(inp);
      return w;
    }

    adv.appendChild(field('课程号（可选）', 'f-kch', t.kch, '如 z290100101', function (v) { t.kch = v; }));
    adv.appendChild(field('最少剩余', 'f-min', t.minRemain, '1', function (v) { t.minRemain = Number(v) || 0; }));
    adv.appendChild(field('只选教师', 'f-tinc', t.teacherInc, '逗号分隔，任一命中', function (v) { t.teacherInc = v; }));
    adv.appendChild(field('排除教师', 'f-texc', t.teacherExc, '', function (v) { t.teacherExc = v; }));
    var tw = field('时间要求', 'f-time', t.timeInc, '如 星期一 或 第5-6节', function (v) { t.timeInc = v; });
    tw.className = 'full';
    adv.appendChild(tw);

    var ord = document.createElement('div');
    ord.className = 'ord';
    var up = document.createElement('button');
    up.textContent = '↑ 上移（提高优先级）';
    up.addEventListener('click', function () { moveTarget(t.id, -1); });
    var dn = document.createElement('button');
    dn.textContent = '↓ 下移';
    dn.addEventListener('click', function () { moveTarget(t.id, 1); });
    ord.appendChild(up); ord.appendChild(dn);
    adv.appendChild(ord);

    card.appendChild(adv);

    advBtn.addEventListener('click', function () {
      adv.style.display = adv.style.display === 'none' ? 'grid' : 'none';
    });

    return card;
  }

  function moveTarget(id, delta) {
    for (var i = 0; i < targets.length; i++) {
      if (targets[i].id !== id) continue;
      var j = i + delta;
      if (j < 0 || j >= targets.length) return;
      var tmp = targets[i]; targets[i] = targets[j]; targets[j] = tmp;
      break;
    }
    saveCfg();
    renderTargets();
  }

  function refreshTargetStatus() {
    // 只更新状态行和卡片配色，避免重建 DOM 打断输入
    var cards = el.tgts.querySelectorAll('.tgt');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var t = first(targets, function (x) { return x.id === card.dataset.id; });
      if (!t) continue;
      card.className = 'tgt' + (t.enabled ? '' : ' off') + (t.done ? ' ok' : '');
      var st = card.querySelector('.tst');
      if (st) {
        st.innerHTML = t.done
          ? '<span class="g">✔ ' + esc(t.status || '已完成') + '</span>'
          : (t.status ? esc(t.status) : '<span class="d">待抢</span>');
      }
    }
  }

  // ---- 上下文 ----

  function readCtx() {
    return {
      xm: H('xm'), xh: H('xh'),
      xkkz_id: H('xkkz_id'), xklc: H('xklc'),
      kklxdm: H('kklxdm'), kklxmc: H('kklxmc'),
      xkxnm: H('xkxnm'), xkxqm: H('xkxqm'),
      iskxk: H('iskxk'),
      kkks: H('xkkssj'), kkjs: H('xkjssj'),
    };
  }

  function describeContext() {
    var c = readCtx();
    var term = H('xkxnmc') && H('xkxqmc') ? H('xkxnmc') + '-' + H('xkxqmc') : (c.xkxnm || '?');
    el.meta.textContent =
      '账号 ' + (c.xm || '?') + '（' + (c.xh || '?') + '）\n' +
      '学期 ' + term + '　第' + (c.xklc || '?') + '轮　类别 ' + (c.kklxmc || c.kklxdm || '?') + '\n' +
      '选课状态：' + (c.iskxk === '1' ? '已开放' : '未开放（' + (c.iskxk || '空') + '）') + '\n' +
      '窗口 ' + (c.kkks || '?') + ' ~ ' + (c.kkjs || '?');
    return c;
  }

  // ---- 运行参数读写 ----

  function syncOptsToUI() {
    el.iv.value = OPTS.interval;
    el.jt.value = OPTS.jitter;
    el.mr.value = OPTS.maxRounds;
    el.dry.checked = !!OPTS.dryRun;
    el.pre.checked = !!OPTS.precheck;
    el.skip.checked = !!OPTS.skipChoosed;
  }

  function syncUIToOpts() {
    OPTS.interval = Math.max(400, Number(el.iv.value) || 1200);
    OPTS.jitter = Math.max(0, Number(el.jt.value) || 0);
    OPTS.maxRounds = Math.max(0, Number(el.mr.value) || 0);
    OPTS.dryRun = el.dry.checked;
    OPTS.precheck = el.pre.checked;
    OPTS.skipChoosed = el.skip.checked;
    saveCfg();
  }

  // ============================================================
  // 7. 执行逻辑
  // ============================================================

  var state = { running: false, busy: false, rounds: 0 };

  function activeTargets() {
    return where(targets, function (t) { return t.enabled && !t.done && targetIsValid(t); });
  }

  /**
   * 拉课程列表：先拉第 1 页，如果还有目标没匹配上且还有下一页，再继续拉。
   * 抢课场景下课很少（十几门以内），通常 1 页就够 —— 一次请求最省时间。
   */
  async function gatherCourses(need) {
    var all = [];
    var MAXP = 5;
    for (var page = 1; page <= MAXP; page++) {
      var r = await queryCourses(page);
      if (!r.ok) return { ok: false, reason: r.reason, courses: all };
      all = all.concat(r.courses);
      var missing = false;
      for (var i = 0; i < need.length; i++) {
        if (!first(all, function (c) { return matchCourse(c, need[i]); })) { missing = true; break; }
      }
      if (!missing) break;                 // 都找到了
      if (r.courses.length < STEP) break;  // 没有下一页
    }
    return { ok: true, courses: all };
  }

  var lastChoosed = { ok: false, rows: [], at: 0 };

  async function refreshChoosed() {
    var r = await queryChoosed();
    lastChoosed = { ok: r.ok, rows: r.rows || [], at: Date.now(), reason: r.reason };
    return lastChoosed;
  }

  /**
   * 执行一轮。
   * @param {boolean} doSubmit true=真提交；false=演练（只匹配不提交）
   * @returns {Array} 每个目标的结果 { target, status, submitted }
   */
  async function tick(doSubmit) {
    var list = activeTargets();
    if (!list.length) return { results: [], note: '没有启用的目标' };

    var got = await gatherCourses(list);
    if (!got.ok) return { results: [], note: '列表查询失败：' + got.reason };

    var choosedKch = {};
    if (doSubmit && OPTS.skipChoosed) {
      if (!lastChoosed.ok || Date.now() - lastChoosed.at > 15000) await refreshChoosed();
      if (lastChoosed.ok) {
        for (var i = 0; i < lastChoosed.rows.length; i++) {
          var row = lastChoosed.rows[i];
          if (row && row.kch) choosedKch[String(row.kch)] = true;
        }
      }
    }

    var results = [];
    for (var n = 0; n < list.length; n++) {
      var t = list[n];
      var course = first(got.courses, function (c) { return matchCourse(c, t); });

      if (!course) {
        t.status = '本轮列表里没有匹配的课程（共 ' + got.courses.length + ' 门）';
        results.push({ target: t, status: 'nomatch' });
        continue;
      }

      if (choosedKch[String(course.kch)]) {
        t.done = true;
        t.status = '已经选过了：' + course.kcmc;
        results.push({ target: t, status: 'already' });
        continue;
      }

      var u = await queryUsableClasses(course.kch_id);
      if (u.error) {
        t.status = '教学班查询失败：' + u.error;
        results.push({ target: t, status: 'error' });
        continue;
      }
      if (!u.classes.length) {
        t.status = '服务端没下发可用令牌，下轮重试';
        results.push({ target: t, status: 'pending' });
        continue;
      }
      if (u.degraded) {
        t.status = '服务端未下发有效 do_jxb_id，已降级用 jxb_id（可能被拒）';
      }

      var pick = pickClassForTarget(u.classes, t);
      if (!pick.ok) {
        t.status = course.kcmc + '：' + pick.reason;
        results.push({ target: t, status: 'nofit' });
        continue;
      }

      var cls = pick.cls;
      var desc = course.kcmc + ' / ' + (teacherOf(cls) || '?') +
        ' / 剩余' + remainOf(cls) + '/' + (cls.jxbrl || '?') +
        ' / ' + String(cls.sksj || '').replace(/<br\s*\/?>/gi, '；');

      if (!doSubmit) {
        t.status = '演练：' + desc;
        results.push({ target: t, status: 'dry', desc: desc });
        continue;
      }

      if (OPTS.precheck) {
        var pre = await checkConflict(course.kch_id, cls.do_jxb_id);
        var pf = pre && pre.flag;
        if (pf !== '1') {
          t.status = '预检未通过 flag=' + pf + ' ' + ((pre && pre.msg) || '') + '　' + desc;
          results.push({ target: t, status: 'conflict' });
          continue;
        }
      }

      var res = await submitCourse(course.kch_id, course.kcmc, cls.do_jxb_id);
      if (res.ok) {
        t.done = true;
        t.status = '抢到：' + desc;
        results.push({ target: t, status: 'success', desc: desc });
        lastChoosed.at = 0; // 强制下次重查已选
      } else {
        t.status = '提交被拒 flag=' + res.flag + ' ' +
          ((res.data && res.data.msg) || JSON.stringify(res.data || {}).slice(0, 120)) + '　' + desc;
        results.push({ target: t, status: 'rejected' });
      }
    }
    return { results: results, note: null };
  }

  /** 预览匹配：只跑匹配，不提交，把每个目标的结果写进日志和状态行 */
  async function doPreview() {
    if (state.busy) return;
    if (!targets.length) { log('先添加一个目标。', 'w'); return; }
    state.busy = true;
    el.preview.disabled = true;
    try {
      log('—— 预览匹配（不提交）——', 'd');
      var r = await tick(false);
      if (r.note) { log(r.note, 'e'); return; }
      for (var i = 0; i < r.results.length; i++) {
        var x = r.results[i];
        var kind = x.status === 'dry' ? 's' : x.status === 'nomatch' || x.status === 'nofit' ? 'w' : 'd';
        log('· ' + (x.target.name || x.target.kch) + ' → ' + x.target.status, kind);
      }
      refreshTargetStatus();
      var okCount = 0;
      for (var j = 0; j < r.results.length; j++) if (r.results[j].status === 'dry') okCount++;
      log('预览完成：' + okCount + '/' + r.results.length + ' 个目标可抢。', okCount ? 's' : 'w');
    } catch (e) {
      log('预览异常：' + e.message, 'e');
    } finally {
      state.busy = false;
      el.preview.disabled = false;
    }
  }

  function setRunning(on) {
    state.running = on;
    el.start.disabled = on;
    el.once.disabled = on;
    el.preview.disabled = on;
    el.quick.disabled = on;
    el.stop.disabled = !on;
  }

  function waitMs() {
    var base = Math.max(400, Number(el.iv.value) || OPTS.interval);
    var jit = Math.max(0, Number(el.jt.value) || 0);
    return base + (jit ? Math.floor(Math.random() * jit) : 0);
  }

  async function runLoop() {
    if (state.running) return;
    if (!activeTargets().length) {
      log(targets.length ? '所有目标都已完成，或都被停用了。' : '先添加一个目标。', 'w');
      return;
    }
    syncUIToOpts();
    setRunning(true);
    state.rounds = 0;
    for (var i = 0; i < targets.length; i++) { targets[i].status = ''; }
    refreshTargetStatus();

    log('开始抢课：' + activeTargets().length + ' 个目标，间隔约 ' + waitMs() + 'ms，' +
      (OPTS.dryRun ? '【仅演练·不会提交】' : '【正式模式·会真实占位】'), OPTS.dryRun ? 's' : 'w');

    while (state.running) {
      state.rounds++;
      var r;
      try { r = await tick(!OPTS.dryRun); }
      catch (e) { r = { results: [], note: '异常：' + e.message }; }

      if (r.note) log('第' + state.rounds + '轮 ' + r.note, 'e');
      else {
        var parts = [];
        for (var k = 0; k < r.results.length; k++) {
          var x = r.results[k];
          parts.push((x.target.name || x.target.kch) + '=' + x.status);
        }
        var sad = false, done = false;
        for (var m = 0; m < r.results.length; m++) {
          if (r.results[m].status === 'success' || r.results[m].status === 'dry' || r.results[m].status === 'already') done = true;
          if (r.results[m].status === 'error' || r.results[m].status === 'rejected' || r.results[m].status === 'conflict') sad = true;
        }
        var slow = state.rounds === 1 || state.rounds % 10 === 0;
        if (done || sad || slow) {
          log('第' + state.rounds + '轮 ' + parts.join('　|　'), done ? 's' : sad ? 'e' : 'd');
        }
      }
      refreshTargetStatus();

      if (OPTS.dryRun && r.results && r.results.length) {
        var anyDry = false;
        for (var q = 0; q < r.results.length; q++) if (r.results[q].status === 'dry') anyDry = true;
        if (anyDry) { log('演练模式不提交，自动停止。取消勾选「仅演练」后重新开始即可真抢。', 'w'); break; }
      }
      if (!activeTargets().length) { log('所有目标都已完成，自动停止。', 's'); break; }
      if (OPTS.maxRounds && state.rounds >= OPTS.maxRounds) { log('已达设定轮次上限（' + OPTS.maxRounds + '），停止。', 'w'); break; }
      if (!state.running) break;

      await sleep(waitMs());
    }
    setRunning(false);
  }

  function stopLoop() {
    if (!state.running) return;
    state.running = false;
    log('已停止。', 'w');
  }

  // ============================================================
  // 8. 事件绑定
  // ============================================================

  el.add.addEventListener('click', function () {
    targets.push(newTarget(''));
    saveCfg();
    renderTargets();
    var inputs = el.tgts.querySelectorAll('input.t-name');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  el.cfgbtn.addEventListener('click', function () {
    el.cfg.style.display = el.cfg.style.display === 'block' ? 'none' : 'block';
  });

  el.exportBtn.addEventListener('click', function () {
    el.cfgtext.value = JSON.stringify({ v: VERSION, opts: OPTS, targets: targets }, null, 2);
    log('已导出到下面的文本框，复制走保存即可。', 's');
  });

  el.importBtn.addEventListener('click', function () {
    var raw = el.cfgtext.value.trim();
    if (!raw) { log('文本框是空的，先粘贴配置。', 'w'); return; }
    try {
      var o = JSON.parse(raw);
      if (o.opts) for (var k in OPTS) { if (o.opts[k] !== undefined) OPTS[k] = o.opts[k]; }
      if (Array.isArray(o.targets)) {
        targets.length = 0;
        for (var i = 0; i < o.targets.length; i++) {
          var s = o.targets[i] || {};
          targets.push({
            id: uid(), enabled: s.enabled !== false, name: s.name || '', kch: s.kch || '',
            teacherInc: s.teacherInc || '', teacherExc: s.teacherExc || '',
            timeInc: s.timeInc || '', minRemain: s.minRemain === undefined ? 1 : Number(s.minRemain) || 0,
            done: false, status: '',
          });
        }
      }
      saveCfg();
      syncOptsToUI();
      renderTargets();
      log('导入成功：' + targets.length + ' 个目标。', 's');
    } catch (e) {
      log('导入失败，JSON 解析错误：' + e.message, 'e');
    }
  });

  el.copyBtn.addEventListener('click', function () {
    var txt = el.cfgtext.value || JSON.stringify({ v: VERSION, opts: OPTS, targets: targets }, null, 2);
    el.cfgtext.value = txt;
    el.cfgtext.select();
    var done = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt);
        done = true;
      }
    } catch (e) { /* 降级 */ }
    if (!done) { try { done = document.execCommand('copy'); } catch (e) { done = false; } }
    log(done ? '已复制到剪贴板。' : '复制失败，请手动全选文本框内容复制。', done ? 's' : 'w');
  });

  el.preview.addEventListener('click', doPreview);

  el.once.addEventListener('click', async function () {
    if (state.busy) return;
    syncUIToOpts();
    state.busy = true;
    el.once.disabled = true;
    try {
      log('—— 执行一轮' + (OPTS.dryRun ? '（演练）' : '（正式提交）') + ' ——', 'd');
      var r = await tick(!OPTS.dryRun);
      if (r.note) { log(r.note, 'e'); return; }
      for (var i = 0; i < r.results.length; i++) {
        var x = r.results[i];
        var kind = x.status === 'success' ? 's' : x.status === 'dry' ? 'w' : x.status === 'nomatch' ? 'd' : 'e';
        log('· ' + (x.target.name || x.target.kch) + ' → ' + x.target.status, kind);
      }
      refreshTargetStatus();
    } catch (e) {
      log('执行异常：' + e.message, 'e');
    } finally {
      state.busy = false;
      el.once.disabled = false;
    }
  });

  el.start.addEventListener('click', function () { runLoop(); });
  el.stop.addEventListener('click', stopLoop);

  el.quick.addEventListener('click', async function () {
    if (state.busy) return;
    if (!confirm('一键选课会把该轮次下你已保存的「选课意向」全部一次性提交，通常无法撤销。\n\n确定继续？')) return;
    state.busy = true;
    el.quick.disabled = true;
    try {
      log('调用一键选课…');
      var r = await submitQuick();
      log(r.ok ? '一键选课已提交成功。'
        : '一键选课失败：flag=' + r.flag + ' ' + JSON.stringify(r.data || {}).slice(0, 160),
        r.ok ? 's' : 'e');
      lastChoosed.at = 0;
    } catch (e) {
      log('一键选课异常：' + e.message, 'e');
    } finally {
      state.busy = false;
      el.quick.disabled = false;
    }
  });
  el.min.addEventListener('click', function () { el.panel.classList.toggle('min'); });

  ['iv', 'jt', 'mr', 'dry', 'pre', 'skip'].forEach(function (k) {
    el[k].addEventListener('change', syncUIToOpts);
  });

  // ============================================================
  // 9. 暴露给控制台 + 启动
  // ============================================================

  window.__XK_HELPER__ = {
    version: VERSION,
    panel: el.panel,
    targets: targets,
    opts: OPTS,
    state: state,
    dbg: DBG,
    // 接口（只读的可以随便玩；submitCourse 有副作用，小心）
    queryCourses: queryCourses,
    queryClasses: queryClasses,
    queryUsableClasses: queryUsableClasses,
    queryChoosed: queryChoosed,
    checkConflict: checkConflict,
    submitCourse: submitCourse,
    submitQuick: submitQuick,
    tick: tick,
    preview: doPreview,
    render: renderTargets,
    // 快捷：直接设定目标，例：__XK_HELPER__.setTargets(['篮球','羽毛球'])
    setTargets: function (names) {
      targets.length = 0;
      for (var i = 0; i < names.length; i++) {
        targets.push(typeof names[i] === 'string' ? newTarget(names[i]) : newTarget(names[i].name));
      }
      saveCfg();
      renderTargets();
      return targets.length;
    },
    toggle: function () { el.panel.classList.toggle('min'); },
    destroy: function () {
      el.panel.remove();
      var s = document.getElementById('zxh-style');
      if (s) s.remove();
      delete window.__XK_HELPER__;
    },
  };

  var loaded = loadCfg();
  if (!loaded) {
    // 同样必须就地改，否则上面暴露出去的 targets 引用会失效
    targets.length = 0;
    targets.push(newTarget(''));
  }
  syncOptsToUI();
  renderTargets();
  describeContext();
  log('助手已就绪（v' + VERSION + '，配置' + (loaded ? '已从本机读取' : '为默认') + '）。', 's');
  log('流程：填课程名 → 预览匹配 → 确认教学班对了 → 取消「仅演练」→ 开始抢课。', 'd');

  // 隐藏域是随页面动态生成的，稍后再读一次上下文
  setTimeout(describeContext, 2500);
  setInterval(function () {
    if (state.running) return;
    var c = readCtx();
    if (c.iskxk !== H('iskxk')) describeContext();
  }, 10000);
})();
