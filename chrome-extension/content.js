/**
 * 正方教务 · 通用选课助手 —— 内容脚本（content script）
 *
 * 运行环境：**扩展的隔离世界（isolated world）**，不是页面的主世界。
 *   ✔ 与页面共享 DOM，所以能直接读隐藏域、往页面里插面板
 *   ✔ `fetch` 用的是页面源，所以同源请求自动带上你已登录的 Cookie（无需账号密码）
 *   ✔ 原型是干净的 —— 站点那套被改写的 Array.prototype 影响不到这里
 *     （正方教务全站覆盖了 Array.prototype.filter / .some，回调参数顺序是 (index, element)，
 *       会让任何 .filter(x => x.xxx) 静默返回空数组。下面仍保留自实现的 where() 作为防御，
 *       万一将来改用「主世界注入」，代码也不会因此烂掉。）
 *
 * 网络说明：只打**同源**请求（/xsxk/...）。不要把这些请求挪到 service worker 里去做 ——
 * 那会变成跨站请求，JSESSIONID 这种 SameSite=Lax 的 Cookie 不会被带上，必然失败。
 */

(function () {
  'use strict';

  var VERSION = '2.5.0';
  var STORE_KEY = 'zf-xk-helper';
  var GNMKDM = 'N253512'; // 自主选课功能码
  // 自主选课页本身的文件名。选课模块下别的页面（个人课表查询等）路径里也带 zzxkyzb，
  // 所以只认这个精确名，别用 /zzxkyzb/ 这种宽匹配。
  var SELECT_PATH_RE = /zzxkyzb_cxZzxkYzbIndex\.html/i;
  var STEP = 10;          // 列表分页步长（服务端固定 10）

  function $(id) { return document.getElementById(id); }
  function H(id) { var e = $(id); return e ? String(e.value == null ? '' : e.value) : ''; }

  // ============================================================
  // 0.0 ★ 查询参数怎么拿 —— 「不点按钮也能查」的关键
  // ============================================================
  //
  //  这一节的存在理由来自一次实测（2026-09-20，学号 2026000001）：
  //
  //  自主选课页的 44 个查询参数里，**有 29 个在服务器返回的 HTML 里根本不存在**。
  //  它们分两批被「造」出来：
  //    · `kklxdm` / `xkkz_id` / `xkkz_xh` / `njdm_id` / `zyh_id`
  //        → 服务器渲染在 `firstKklxdm` / `firstXkkzId` / … 这组「默认值」隐藏域里，
  //          再由**页面 JS** 在 ready 时拷进正式字段
  //          （zzxkYzb.js: `$("#kklxdm").val($("#firstKklxdm").val())`）
  //    · `bklx_id` / `rwlx` / `xklc` / `xkly` / 一大堆 `sf*` 开关
  //        → 来自 `zzxkyzb_cxZzxkYzbDisplay.html` 返回的 HTML 片段
  //          （页面 JS 把它塞进 `#displayBox`，隐藏域跟着片段一起进来）
  //
  //  所以**页面 JS 一旦没跑完**（移动端浏览器禁用同步 XHR 会让整段 JS 直接抛错），
  //  脚本就会拿一堆空参数去查询，而服务端的反应非常不利于排查：
  //
  //      `kklxdm`  空 → {"flag":"1","tmpList":[]}          ← HTTP 200、无报错、**0 门课**
  //      `bklx_id` 空 → 同上，**0 门课**
  //      `xkkz_xh` 空 → {"flag":"0","msg":"加密串错误…"}    ← 这个至少会报错
  //      `rwlx`    空 → 63 门（超集，反而无害）
  //      `xkkz_id` 空 → 4 门（不参与过滤）
  //
  //  「静默返回 0 门课」是最恶心的失败模式：面板会说「本轮列表里没有匹配的课程」，
  //  用户完全看不出是参数没就绪，只会以为学校没放课 —— 这就是「抢不到课」的真相。
  //
  //  对策三层，按代价从低到高（**全程不需要人去点任何东西**）：
  //    ① `first*` 回落 —— 服务器给的值与 JS 拷过去的值实测完全等价
  //    ② 自己拉 Display 片段补全 —— 拿到 `bklx_id` 等只有页面 JS 才有的值
  //    ③ 兜底：程序化触发页面自己的「查询」（DOM 是共享的，事件能让页面处理器跑起来）

  /** 服务端 HTML 实体的最小还原（只处理值里真会出现的几个） */
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&');
  }

  /**
   * 从一段 HTML 里把所有 `<input id=.. value=..>` 抽成字典。
   * 纯正则、不建 DOM —— 因为在选课页上 `document` 里并没有这些片段。
   */
  function inputsFromHtml(html) {
    var s = String(html == null ? '' : html);
    var out = {};
    var re = /<input\b[^>]*>/gi;
    var m;
    while ((m = re.exec(s))) {
      var tag = m[0];
      var idm = /(?:^|\s)id\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
      if (!idm) continue;
      var vm = /(?:^|\s)value\s*=\s*["']([^"']*)["']/i.exec(tag);
      out[idm[1]] = vm ? decodeEntities(vm[1]) : '';
    }
    return out;
  }

  /** 主字段空时，回落到服务器渲染的「默认值」字段 */
  var HID_FALLBACK = {
    kklxdm: 'firstKklxdm',
    kklxmc: 'firstKklxmc',
    xkkz_id: 'firstXkkzId',
    xkkz_xh: 'firstXkkzXh',
    njdm_id: 'firstNjdmId',
    zyh_id: 'firstZyhId',
  };

  /** 自补来的参数（只在 DOM 里读不到时才填，见 harvestServerCtx） */
  var CTX_OVERRIDE = {};

  /**
   * 读上下文参数。顺序：**DOM 正式字段 > 自补 > first* 回落**。
   *
   * 为什么 DOM 优先而不是自补优先：自补只填「DOM 读不到」的那些键，
   * 而页面 JS 有可能**晚一步**才初始化完 —— 那时 DOM 里的才是页面自己要发的值，
   * 应当压过我们先前的猜测。反过来（自补优先）会让缓存住的值挡住新鲜值，是个隐患。
   */
  function ctxH(id) {
    var v = H(id);
    if (v) return v;
    if (CTX_OVERRIDE[id] !== undefined && CTX_OVERRIDE[id] !== '') return CTX_OVERRIDE[id];
    var alt = HID_FALLBACK[id];
    return alt ? H(alt) : '';
  }

  /** 同 ctxH，但把「这个值从哪来的」也带出来，便于诊断 */
  function ctxSrc(id) {
    if (H(id)) return 'dom';
    if (CTX_OVERRIDE[id]) return 'server';
    if (HID_FALLBACK[id] && H(HID_FALLBACK[id])) return HID_FALLBACK[id];
    return '';
  }

  // 实测结论：少哪个会「静默查不到课」。别删。
  var CRITICAL_PARAMS = ['kklxdm', 'bklx_id', 'xkkz_xh'];

  /** 关键参数体检：ok / 每个参数的值与来源 / 缺了哪些 */
  function paramReport() {
    var rows = [], missing = [];
    for (var i = 0; i < CRITICAL_PARAMS.length; i++) {
      var id = CRITICAL_PARAMS[i];
      var val = ctxH(id);
      rows.push({ id: id, ok: !!val, src: ctxSrc(id), len: val.length, head: val.slice(0, 12) });
      if (!val) missing.push(id);
    }
    return { ok: missing.length === 0, rows: rows, missing: missing };
  }

  /**
   * 自己从服务器把参数补全 —— 不依赖页面 JS，也不依赖人能点到按钮。
   *
   *   ① 重新取一次当前页的**服务器原始 HTML** → 抠 `first*` 默认值。
   *      用 `fetch(location.href)` 拿到的是**未执行 JS 的** HTML，
   *      正好就是「页面 JS 没跑」时我们想要的那份真相。
   *   ② POST `zzxkyzb_cxZzxkYzbDisplay.html` → 抠片段里的 `bklx_id` / `rwlx` / `xklc` / `xkly`…
   *      （实测只需 `xkkz_id`，甚至可以全空；返回的是一整页 HTML，正则抠即可）
   *
   * @returns {Promise<string[]>} 补到的参数名
   */
  async function harvestServerCtx() {
    var filled = [];

    // ① 服务器原始 HTML（first* 默认值）
    try {
      var page = await httpGet(location.pathname + (location.search || ''));
      var a = inputsFromHtml(page.text);
      for (var k in HID_FALLBACK) {
        if (!CTX_OVERRIDE[k] && !H(k) && a[HID_FALLBACK[k]]) {
          CTX_OVERRIDE[k] = a[HID_FALLBACK[k]];
          filled.push(k);
        }
      }
    } catch (e0) { /* 忽略，② 还有机会 */ }

    // ② Display 片段（bklx_id 等只有这里才有）
    try {
      var frag = await postForm('/xsxk/zzxkyzb_cxZzxkYzbDisplay.html?gnmkdm=' + GNMKDM,
        { xkkz_id: ctxH('xkkz_id') }, false);
      var b = inputsFromHtml(frag);
      for (var k2 in b) {
        if (!CTX_OVERRIDE[k2] && !H(k2) && b[k2]) {
          CTX_OVERRIDE[k2] = b[k2];
          filled.push(k2);
        }
      }
    } catch (e1) { /* 忽略 */ }

    // ③ 选课规则串 xkgz：形如 '1~0~0~1~5960666114DB1C17E0630B02FD0A8BCE~0~0'，
    //    第 5 段就是 xkkz_id（参考实现 grabber/lib/params.js 的 pickXkkzFromObj）。
    //    它是个**额外**的兜底来源：xkkz_id 读不到时，页面里往往还留着这条串。
    try {
      if (!H('xkkz_id') && !CTX_OVERRIDE.xkkz_id) {
        var got = xkkzFromXkgz(scanPageForXkgz());
        if (got) { CTX_OVERRIDE.xkkz_id = got; filled.push('xkkz_id'); }
      }
    } catch (e2) { /* 忽略 */ }

    return filled;
  }

  /**
   * 从规则串里抠 xkkz_id：按 '~' 切开，第 5 段（下标 4）。
   * 只认「够长且全十六进制」的值，避免把随便一条带 ~ 的串误当 ID。
   */
  function xkkzFromXkgz(str) {
    var v = String(str || '');
    if (v.indexOf('~') < 0) return '';
    var seg = v.split('~');
    if (seg.length < 5) return '';
    var cand = String(seg[4] || '').trim();
    return /^[0-9A-Fa-f]{16,}$/.test(cand) ? cand : '';
  }

  /** 在页面所有隐藏域里找一条像 xkgz 的规则串 */
  function scanPageForXkgz() {
    try {
      var ins = document.querySelectorAll('input[type=hidden], input[name^=xkgz]');
      for (var i = 0; i < ins.length; i++) {
        var s = String(ins[i].value || '');
        if (xkkzFromXkgz(s)) return s;
      }
    } catch (e) { /* 忽略 */ }
    return '';
  }

  /**
   * 保证查询参数就绪。这是「不点按钮也能查」的保险丝。
   * 顺序：现状体检 → 自己从服务器补 → 兜底程序化点一次页面「查询」。
   */
  async function ensureParamsReady(verbose) {
    var rep = paramReport();
    if (rep.ok) return rep;

    var wasMissing = rep.missing.join('、');
    var healed = [];
    try { healed = await harvestServerCtx(); } catch (e) { healed = []; }
    rep = paramReport();
    if (rep.ok) {
      if (verbose) log('参数原本缺 ' + wasMissing + '，已自动从服务器补全 ' + healed.length + ' 项。', 's');
      return rep;
    }

    // ③ 兜底：程序化触发页面自己的「查询」按钮。
    //    内容脚本在隔离世界读不到页面的 jQuery，但 **DOM 是共享的** ——
    //    原生 click() 派发的事件，页面用 addEventListener 绑的处理器收得到。
    //    这一步存在的意义：按钮可能被浮层遮住 / 在移动端视口外，人点不到，但脚本点得到。
    var btn = document.querySelector('#searchBox button[name=query]')
      || document.querySelector('button[name=query]');
    if (btn) {
      try { btn.click(); } catch (e2) { /* 忽略 */ }
      await sleep(1000);
      rep = paramReport();
      if (rep.ok) {
        if (verbose) log('参数已通过「程序化点一次查询」补全（无需人工点击）。', 's');
        return rep;
      }
    }

    if (verbose) {
      log('✘ 查询参数仍缺：' + rep.missing.join('、') + '。', 'e');
      log('  原因：本页脚本没有正常初始化（移动端浏览器禁用同步 XHR 时会这样）。', 'w');
      log('  → 处置：用电脑版 Chrome 打开选课页并刷新；或先在手机上手动点一次「查询」再让脚本接上。', 'w');
    }
    return rep;
  }


  // ============================================================
  // 0. 我在哪个页面？—— 决定「装面板」还是「自动跳过去」
  // ============================================================
  //
  //  三种结果：
  //    'select'   已经在自主选课页  → 装面板
  //    'other-zf' 是正方教务的页面但不是选课页（主菜单、首页…）→ 可以自动跳过去
  //    'unknown'  不相干的页面      → 什么都不做（其实 matches 已经挡掉大部分）
  //
  //  注入范围只声明了 /xsxk/* 和 /xtgl/*，所以「成绩查询 /cjcx/*」这类
  //  别的模块根本不会注入 —— 不存在「在别的模块里被硬拽走」的问题。

  function normPath() { return String(location.pathname || '').toLowerCase(); }

  /**
   * 从页面上找「自主选课」菜单项，顺便把它的真实路径抠出来。
   * 用 DOM 而不是 window.clickMenu —— 内容脚本跑在隔离世界，读不到页面的 JS 函数。
   *
   * 不假设参数顺序：把 onclick 里所有字符串字面量都抠出来，谁长得像路径就当路径，
   * 谁长得像功能码（字母+数字）就当功能码。判定依据是 功能码 / 路径含 zzxkyzb /
   * 菜单文字含「自主选课」三者任一，所以换学校换版本也不至于失效。
   */
  function findSelectEntry() {
    var as = document.querySelectorAll('a[onclick],a[href]');
    for (var i = 0; i < as.length; i++) {
      var oc = (as[i].getAttribute('onclick') || '') + ' ' + (as[i].getAttribute('href') || '');
      if (!oc) continue;
      var label = String(as[i].textContent || '').replace(/\s+/g, '');

      var code = '';
      var path = '';
      var lits = oc.match(/['"][^'"]*['"]/g) || [];
      for (var j = 0; j < lits.length; j++) {
        var v = lits[j].slice(1, -1).trim();
        if (!v) continue;
        if (!path && (/\.html(\?|$|\/)/i.test(v) || v.charAt(0) === '/')) path = v;
        else if (!code && /^[A-Za-z]{1,3}\d{4,}$/.test(v)) code = v;
      }
      // href 里直接就是路径的情况
      if (!path && SELECT_PATH_RE.test(oc)) {
        var m = /(https?:\/\/[^\s'"]+|\/[^\s'"]+)/.exec(oc);
        if (m) path = m[1];
      }

      // ⚠️ 不能只判 /zzxkyzb/ —— 选课模块下「个人课表查询」等页面路径里也有这个词，
      // 会误判。所以路径这一路必须精确到选课页本身的文件名。
      var hit = (code === GNMKDM) || SELECT_PATH_RE.test(path) ||
        SELECT_PATH_RE.test(oc) || (label.indexOf('自主选课') >= 0);
      if (!hit) continue;
      if (!path && label.indexOf('自主选课') < 0 && code !== GNMKDM) continue;

      return { code: code || GNMKDM, path: path, label: label || '自主选课' };
    }
    return null;
  }

  /**
   * 已经在自主选课页？
   * 两路：① URL 精确命中选课页文件名；② 选课页特有的隐藏域三者齐全（兜底，
   * 覆盖换版本改了文件名的情况）。**不要**用 /xsxk/zzxkyzb/ 这种宽匹配 ——
   * 个人课表查询等兄弟页面也在 /xsxk/zzxkyzb* 下，会被误判成选课页而挂错面板。
   */
  function isSelectPage() {
    if (SELECT_PATH_RE.test(normPath())) return true;
    return !!(H('xkkz_id') && H('xklc') && H('kklxdm'));
  }

  function looksLikeLogin() {
    // 排除我们自己面板里的密码框 —— 面板本身就有一个（账号功能用的），
    // 不排除的话，只要面板一挂上，这个页面就会被判成登录页
    var pw = document.querySelector('input[type=password]');
    if (pw && !(pw.closest && pw.closest('#zxh-panel'))) return true;
    var fs = document.querySelectorAll('form');
    for (var i = 0; i < fs.length; i++) {
      if (/login/i.test(fs[i].getAttribute('action') || '')) return true;
    }
    return !!(H('yhm') && H('mm'));
  }

  /**
   * 一段 HTML 是不是正方登录页？
   * 用来识别「会话失效时接口把登录页当 200 返回」这种情况 —— 光看状态码是看不出来的。
   * 判据要求有真实的登录表单结构，避免把普通页面误判。
   */
  function looksLikeLoginHtml(html) {
    if (!html) return false;
    var s = String(html);
    if (s.length > 400000) s = s.slice(0, 400000);
    var hasUser = /<input\b[^>]*\bid\s*=\s*["']?yhm["']?/i.test(s);
    var hasPass = /<input\b[^>]*\bid\s*=\s*["']?mm["']?/i.test(s) || /type\s*=\s*["']?password["']?/i.test(s);
    if (hasUser && hasPass) return true;
    return /login_slogin\.html/i.test(s) && /csrftoken/i.test(s);
  }

  function looksLikeZf() {
    if (/教学管理信息服务平台|教务管理|教务系统|正方/.test(document.title || '')) return true;
    // 页脚版本号 / 平台的固定容器 / 登录后的菜单页地址，都是很硬的指纹
    var head = (document.documentElement ? document.documentElement.innerHTML : '').slice(0, 20000);
    if (/版本V-\d/.test(head)) return true;
    if (/index_initMenu\.html/.test(head)) return true;
    if (/zftal-ui|正方软件/.test(head)) return true;
    if (/版权所有[\s\S]{0,40}教务/.test(head)) return true;
    if (document.getElementById('displayBox')) return true;
    var txt = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
    return /教务/.test(txt);
  }

  function detectPageState() {
    if (isSelectPage()) return 'select';
    if (findSelectEntry()) return 'other-zf';
    // 先排登录页再判指纹：looksLikeZf 要扫 innerHTML，别在登录页白跑一趟
    if (!looksLikeLogin() && looksLikeZf()) return 'other-zf';
    return 'unknown';
  }

  /** 拼出自主选课页的完整 URL（菜单里的路径常常不带 gnmkdm / layout） */
  function resolveSelectUrl() {
    var e = findSelectEntry();
    var url = (e && e.path) ? e.path : '/xsxk/zzxkyzb_cxZzxkYzbIndex.html';
    if (!/^https?:\/\//i.test(url) && url.charAt(0) !== '/') url = '/' + url;
    if (!/[?&]gnmkdm=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'gnmkdm=' + ((e && e.code) || GNMKDM);
    if (!/[?&]layout=/.test(url)) url += '&layout=default';
    return url;
  }

  // ---- 跳转状态：防死循环 + 记住用户拒绝过 ----
  //
  //  登录页也在 /xtgl/* 下。如果没登录就跳，会被弹回登录页 → 又满足跳转条件 → 无限循环。
  //  三道闸：① 返回导航不跳；② 一分钟内最多跳 2 次；③ 用户点过「取消」就 5 分钟别再烦。

  var GOTO_KEY = 'zxh-goto-state';

  function readGotoState() {
    try { return JSON.parse(sessionStorage.getItem(GOTO_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function writeGotoState(s) {
    try { sessionStorage.setItem(GOTO_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }

  function gotoBlockReason() {
    var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || {};
    if (nav.type === 'back_forward') return 'back_forward';   // 用户按返回回来的，别弹回去
    var s = readGotoState();
    var now = Date.now();
    if (now < (s.skipUntil || 0)) return 'user-declined';     // 刚被拒绝过
    if (s.at && now - s.at < 60000 && (s.n || 0) >= 2) return 'loop-guard';
    return null;
  }

  /** 真正跳。计数写进 sessionStorage，用于防循环 */
  function gotoSelect(url) {
    var s = readGotoState();
    var now = Date.now();
    writeGotoState({
      at: now,
      n: (s.at && now - s.at < 60000) ? (s.n || 0) + 1 : 1,
      skipUntil: s.skipUntil || 0,
    });
    location.href = url;
  }

  /**
   * 「询问后跳转」模式下用的极简提示条。
   * 用内联样式而不是往页面注入我们的 CSS —— 此刻主面板的样式还没注入，
   * 而且内联样式不会被站点那套全局选择器影响。
   */
  function showGotoPrompt(url) {
    if (document.getElementById('zxh-goto')) return;

    var box = document.createElement('div');
    box.id = 'zxh-goto';
    box.setAttribute('style', [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
      'width:296px', 'padding:14px 16px',
      'background:#fff', 'color:#1f2328', 'border:1px solid #d0d7de',
      'border-radius:10px', 'box-shadow:0 8px 28px rgba(27,31,36,.22)',
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    ].join(';'));

    var h = document.createElement('div');
    h.textContent = '当前不在「自主选课」页面';
    h.setAttribute('style', 'font-weight:600;font-size:14px;margin-bottom:6px;');
    box.appendChild(h);

    var p = document.createElement('div');
    p.textContent = '选课助手已就绪，要跳转到自主选课页吗？';
    p.setAttribute('style', 'color:#57606a;margin-bottom:11px;');
    box.appendChild(p);

    var row = document.createElement('div');
    row.setAttribute('style', 'display:flex;gap:8px;');

    var go = document.createElement('button');
    go.textContent = '前往选课';
    go.setAttribute('style',
      'flex:1;padding:7px 0;border:0;border-radius:6px;background:#0969da;color:#fff;' +
      'font-size:13px;font-weight:600;cursor:pointer;');
    go.addEventListener('click', function () { gotoSelect(url); });

    var no = document.createElement('button');
    no.textContent = '取消';
    no.setAttribute('style',
      'flex:1;padding:7px 0;border:1px solid #d0d7de;border-radius:6px;background:#f6f8fa;' +
      'color:#1f2328;font-size:13px;cursor:pointer;');
    no.addEventListener('click', function () {
      // 记下「别烦我」，5 分钟内不再提示（含自动跳转）
      var s = readGotoState();
      s.skipUntil = Date.now() + 5 * 60 * 1000;
      writeGotoState(s);
      box.remove();
    });

    row.appendChild(go);
    row.appendChild(no);
    box.appendChild(row);

    var tip = document.createElement('div');
    tip.textContent = '可在面板里把跳转方式改为「自动跳转」或「关闭」。';
    tip.setAttribute('style', 'color:#8b949e;font-size:11px;margin-top:9px;');
    box.appendChild(tip);

    (document.body || document.documentElement).appendChild(box);
  }

  // ============================================================
  // 1. 工具
  // ============================================================

  /** 见文件头注释：站点可能改写 Array.prototype.filter / .some，所以自己实现一个 */
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
   * 教师名。正方把「工号/姓名/职称」塞在一个字段里（实测字段名 jsmc，
   * 不同版本可能叫 jsxm / jsxx / jshzc），统一拆出来并把工号、职称、"无" 剔掉。
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

  function classLabel(c) { return c.jxbmc || ((c.kcmc || '') + ' ' + (teacherOf(c) || '')); }

  // ============================================================
  // 3. HTTP 层（同源 fetch，自动带 Cookie）
  // ============================================================

  /**
   * 「登录态没了」专用错误。带 code 是为了让 runLoop 能一眼分辨：
   * 是普通的接口异常（继续重试），还是要走重新登录流程。
   */
  function sessionLost(detail) {
    var e = new Error('登录态已失效' + (detail ? '：' + detail : ''));
    e.code = 'SESSION_LOST';
    e.detail = detail || '';
    return e;
  }

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
      // 扩展内容脚本里，相对 URL 按页面源解析，same-origin 即等同于页面自身发请求
      credentials: 'same-origin',
    });

    // 会话失效有两种露头方式，都要认：
    //   ① 被 302 到登录页（看自动跟完跳转后的最终 URL）
    //   ② 服务端直接把登录页 HTML 当 200 返回（状态码看不出来，只能看内容）
    var finalPath = '';
    try { finalPath = new URL(res.url, location.href).pathname; } catch (e0) { /* 忽略 */ }
    var text = await res.text();
    if (/login_slogin/i.test(finalPath) || looksLikeLoginHtml(text)) {
      throw sessionLost('请求被弹回登录页');
    }

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
    for (var i = 0; i < PART_KEYS.length; i++) f.set(PART_KEYS[i], ctxH(PART_KEYS[i]));
    f.set('jg_id', ctxH('jg_id_1') || ctxH('jg_id'));
    f.set('kspage', String((page - 1) * STEP + 1));
    f.set('jspage', String(page * STEP));
    f.set('jxbzb', '');
    return f;
  }

  function buildClassForm(kchId) {
    var f = new URLSearchParams();
    for (var i = 0; i < CLASS_KEYS.length; i++) f.set(CLASS_KEYS[i], ctxH(CLASS_KEYS[i]));
    f.set('jg_id', ctxH('jg_id_1') || ctxH('jg_id'));
    f.set('kch_id', kchId);
    f.set('cxbj', H('cxbj_' + kchId) || '0');
    f.set('fxbj', H('fxbj_' + kchId) || '0');
    // 参考实现（grabber/lib/params.js）实测：这两个开关不带，部分学校会直接回
    // "0"（字面量），看起来就像「这门课没有可选教学班」。取不到页面值时补上默认值；
    // 页面给了值就尊重页面的（只填空，不覆盖）。
    if (!f.get('xkxskcgskg')) f.set('xkxskcgskg', '1');
    if (!f.get('jxbzcxskg')) f.set('jxbzcxskg', '0');
    // 分页字段绝不能带进来：服务端拿它当查询上下文，带了会被判成"查列表"而不是"查教学班"
    f.delete('kspage');
    f.delete('jspage');
    f.delete('jxbzb');
    f.delete('bhjzckb');
    return f;
  }

  // ---- 接口 ----

  var DBG = {};

  /** 课程列表（只读）。这是「查询」按钮真正打的那个接口 —— 我们直接打，不点按钮。 */
  async function queryCourses(page, opts) {
    // 先确保参数就绪：页面 JS 没跑完时自动从服务器补齐（详见 SECTION 0.0）
    try {
      var ready = await ensureParamsReady(opts && opts.verbose);
      if (!ready.ok) {
        DBG.lastParamReport = ready;
        return {
          ok: false, courses: [],
          reason: '查询参数缺失（' + ready.missing.join('、') + '）：本页脚本没正常初始化，已尝试自动补齐仍未成功',
        };
      }
    } catch (e0) { /* 自补本身出错不阻塞，照常查一次 */ }

    var data = await postForm('/xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=' + GNMKDM, buildQueryForm(page || 1), true);
    DBG.lastPartAt = Date.now();
    if (data && data.__raw !== undefined) {
      var raw = String(data.__raw).trim();
      DBG.lastPartRaw = raw.slice(0, 200);
      if (raw === '0') {
        // 返回 0 是「你正在非法访问！」，多数情况是会话没了。确认一下再决定要不要走重登。
        if (await checkSession() === false) throw sessionLost('列表接口返回 0');
        return { ok: false, reason: '返回 0（非法访问：多缺 gnmkdm 或会话失效）', courses: [] };
      }
      return { ok: false, reason: '响应异常：' + raw.slice(0, 120), courses: [] };
    }
    if (!data) return { ok: false, reason: '空响应', courses: [] };
    if (data.flag === '0') {
      var msg = String(data.msg || '');
      if (/登录|会话|失效|超时|非法/.test(msg) && await checkSession() === false) {
        throw sessionLost('服务端拒绝：' + msg);
      }
      return { ok: false, reason: msg || '服务端拒绝', courses: [] };
    }
    var list = Array.isArray(data.tmpList) ? data.tmpList : [];
    // 列表里每门课都带着 xkgz 规则串，第 5 段就是 xkkz_id —— 顺手兜底补一次。
    // （这是最后一个 xkkz_id 来源：DOM 没有、自补也没有时，列表里一定有。）
    if (!ctxH('xkkz_id') && list.length) {
      for (var xi = 0; xi < list.length; xi++) {
        var xk = xkkzFromXkgz(list[xi] && list[xi].xkgz);
        if (xk) { CTX_OVERRIDE.xkkz_id = xk; DBG.xkkzFromList = xk; break; }
      }
    }
    if (!list.length) {
      // 「0 门课」有两种可能：真的没有课，或者参数值不对导致服务端静默过滤光了。
      // 后者是 flag=1 + 空列表，界面上看不出来，所以这里主动体检一次并说清楚。
      var rep2 = paramReport();
      DBG.lastParamReport = rep2;
      if (!rep2.ok) {
        return {
          ok: false, courses: [],
          reason: '服务端返回 0 门，且关键参数缺 ' + rep2.missing.join('、') + '（页面脚本未就绪）',
        };
      }
    }
    return { ok: true, courses: list };
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
   * do_jxb_id 是服务端每次调用新生成的动态加密串（实测 256 字符），提交时必须用它；
   * 传 jxb_id 会被拒（「出现未知异常」）。但它偶尔下发字面量 "undefined"，
   * 所以：① 滤掉无效令牌；② 一条都没有就重试一次；③ 仍没有则回退 jxb_id 并标记降级。
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
      f.set(k, ctxH(k === 'jg_id' ? 'jg_id_1' : k));
    }
    var data = await postForm('/xsxk/zzxkyzb_cxZzxkYzbChoosedDisplay.html', f, true);
    if (Array.isArray(data)) return { ok: true, rows: data };
    if (data && data.__raw !== undefined) return { ok: false, reason: String(data.__raw).slice(0, 120), rows: [] };
    return { ok: false, reason: '已选列表格式不认识', rows: [] };
  }

  /** 正式选课 ← 有真实副作用，一次成功即占位 */
  async function submitCourse(kchId, kcmc, doJxbId) {
    var rlkz = ctxH('rlkz') || '0';
    var cdrlkz = ctxH('cdrlkz') || '0';
    var rlzlkz = ctxH('rlzlkz') || '0';
    var f = new URLSearchParams();
    f.set('kcmc', kcmc);
    f.set('kch_id', kchId);
    f.set('jxb_ids', doJxbId);
    f.set('rwlx', ctxH('rwlx'));
    f.set('rlkz', rlkz);
    f.set('cdrlkz', cdrlkz);
    f.set('rlzlkz', rlzlkz);
    f.set('sxbj', (rlkz === '1' || cdrlkz === '1' || rlzlkz === '1') ? '1' : '0');
    f.set('xxkbj', H('xxkbj_' + kchId) || '0');
    f.set('cxbj', H('cxbj_' + kchId) || '0');
    f.set('xkkz_id', ctxH('xkkz_id'));
    f.set('kklxdm', ctxH('kklxdm'));
    f.set('njdm_id', ctxH('njdm_id'));
    f.set('zyh_id', ctxH('zyh_id'));
    f.set('xklc', ctxH('xklc'));
    f.set('xkxnm', ctxH('xkxnm'));
    f.set('xkxqm', ctxH('xkxqm'));
    f.set('jcxx_id', '');
    var data = await postForm('/xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html', f, true);
    var flag = data && data.flag;
    return { ok: flag === '1' || flag === '3', flag: flag, data: data };
  }

  /** 一键选课：把该轮次下你已保存的「选课意向/志愿」一次性全部提交（有真实副作用） */
  async function submitQuick() {
    var data = await postForm('/xsxk/zzxkyzb_xkZzxkyzbQuickly.html',
      new URLSearchParams({ xkkz_id: ctxH('xkkz_id') }), true);
    var flag = data && data.flag;
    return { ok: flag === '1' || flag === '3', flag: flag, data: data };
  }

  // ============================================================
  // 3.7 退选 · 换课 · 冲突重选（有真实副作用，默认关闭）
  // ============================================================
  //
  //  这一块参考的是 ThisIsLittleSky/grabber 的 lib/conflict.js。
  //  安全铁律只有一条，别改：
  //
  //      **只退「可退的选修课」（kklxdm=10 且 rwlx=2），其余一律只告警不动手。**
  //
  //  退选不可逆。所以整套逻辑挂在 OPTS.autoDrop 上，**默认 false** ——
  //  你不显式打开，它就永远不会自己退掉任何一门课。

  /** 这门已选课能不能退：只有通识选修（kklxdm=10）且任选（rwlx=2）才动手 */
  function isDroppable(row) {
    if (!row) return false;
    return String(row.kklxdm || '') === '10' && String(row.rwlx || '') === '2';
  }

  /** 描述一门已选课，给日志/告警用 */
  function chosenLabel(row) {
    if (!row) return '?';
    return '[' + (row.kch || row.kch_id || '?') + '] ' + (row.kcmc || '');
  }

  /**
   * 退选。参数按接口分析文档来：kch_id + jxb_ids(加密串) + 学年学期 + txbsfrl。
   * 成功标志：服务端返回字符串 '1'。
   */
  async function dropCourse(kchId, doJxbId, kcmc) {
    if (!kchId) return { ok: false, reason: '缺少课程号' };
    if (!doJxbId) return { ok: false, reason: '这门已选课没带 do_jxb_id，退不了' };
    var f = new URLSearchParams();
    f.set('kch_id', kchId);
    f.set('jxb_ids', doJxbId);
    f.set('xkxnm', ctxH('xkxnm'));
    f.set('xkxqm', ctxH('xkxqm'));
    f.set('txbsfrl', '0');
    var raw = await postForm('/xsxk/zzxkyzb_tuikBcZzxkYzb.html', f, false);
    var t = String(raw == null ? '' : raw).trim();
    return { ok: t === '1', reason: t || '空响应', raw: t };
  }

  /**
   * 从已选列表里找「与目标教学班时间重叠」的可退选修课。
   * 返回 { victim } 或 { reason }。**只返回可退的那门**，必修绝不出现在返回值里。
   */
  async function findConflictVictim(cls, course) {
    var tgtSegs = parseSchedule(cls && cls.sksj);
    if (!tgtSegs) return { reason: '读不出目标课的上课时间（sksj 格式不认识），安全放弃' };

    if (!lastChoosed.ok || Date.now() - lastChoosed.at > 8000) await refreshChoosed();
    if (!lastChoosed.ok) return { reason: '查不到已选列表：' + (lastChoosed.reason || '未知') };

    var overlapped = [];
    for (var i = 0; i < lastChoosed.rows.length; i++) {
      var r = lastChoosed.rows[i];
      if (!r) continue;
      if (String(r.kch || r.kch_id) === String(course.kch || course.kch_id)) continue;
      if (schedulesOverlap(tgtSegs, parseSchedule(r.sksj))) overlapped.push(r);
    }
    if (!overlapped.length) return { reason: '没定位到时间重叠的已选课（可能是服务端的其它规则导致的冲突）' };

    var droppable = where(overlapped, isDroppable);
    if (!droppable.length) {
      var names = [];
      for (var k = 0; k < overlapped.length; k++) names.push(chosenLabel(overlapped[k]));
      return { reason: '重叠的是必修/不可退课（' + names.join('、') + '），需要你手动处理' };
    }
    return { victim: droppable[0], overlapped: overlapped.length };
  }

  /**
   * 冲突后自动重选：定位重叠的可退选修课 → 退掉 → 让调用方重提。
   * 任一步不确定就放弃并告警 —— 宁可抢不到，也不能把必修退没了。
   * @returns {Promise<boolean>} true = 已成功退掉一门，可以重试提交
   */
  async function resolveConflict(cls, course) {
    log('冲突处理：尝试定位冲突源——' + describeSksj(cls.sksj), 'w');
    var got = await findConflictVictim(cls, course);
    if (!got.victim) {
      log('冲突处理：' + got.reason + '。放弃自动处理（不会退任何课）。', 'w');
      return false;
    }
    var v = got.victim;
    log('冲突处理：准备退掉可退选修课 ' + chosenLabel(v) + '（共 ' + got.overlapped + ' 门重叠）', 'w');
    var d = await dropCourse(v.kch_id || v.kch, v.do_jxb_id, v.kcmc);
    if (!d.ok) {
      log('冲突处理：退选失败（服务端返回 ' + d.reason + '），放弃。', 'e');
      return false;
    }
    log('冲突处理：已退掉 ' + chosenLabel(v) + '，准备重提目标课。', 's');
    lastChoosed.at = 0;   // 强制下次重查已选
    await sleep(500);
    return true;
  }

  /**
   * 换课（骑驴找马）：目标配了「替换课程」时，把保底课退掉，给目标课腾位置。
   * 只在**已经确认目标课有名额**之后才调用，把「退了保底却没抢到」的窗口压到最小。
   * @returns {Promise<boolean>} true = 保底课已不在已选里（可以提交目标课）
   */
  async function dropReplaceCourse(t) {
    var want = String(t.replaceKch || '').trim();
    if (!want) return true;
    if (!lastChoosed.ok || Date.now() - lastChoosed.at > 8000) await refreshChoosed();
    if (!lastChoosed.ok) {
      log('换课：查不到已选列表，暂不动手（' + (lastChoosed.reason || '未知') + '）', 'w');
      return false;
    }
    var found = null;
    for (var i = 0; i < lastChoosed.rows.length; i++) {
      var r = lastChoosed.rows[i];
      if (r && String(r.kch || r.kch_id || '').toLowerCase() === want.toLowerCase()) { found = r; break; }
    }
    if (!found) return true;   // 保底课本来就不在已选里，直接放行

    if (!isDroppable(found)) {
      log('换课：保底课 ' + chosenLabel(found) + ' 不是「可退选修课」（需 kklxdm=10 且 rwlx=2），' +
        '按安全规则不动手，请手动处理。', 'e');
      return false;
    }
    log('换课：目标课已有名额，先退掉保底课 ' + chosenLabel(found), 'w');
    var d = await dropCourse(found.kch_id || found.kch, found.do_jxb_id, found.kcmc);
    if (!d.ok) {
      log('换课：退保底课失败（服务端返回 ' + d.reason + '），本轮不提交目标课。', 'e');
      return false;
    }
    lastChoosed.at = 0;
    await sleep(500);
    return true;
  }

  /** 服务端说「冲突」了吗 */
  function isConflictMsg(res) {
    if (!res) return false;
    var msg = String((res.data && res.data.msg) || '') + ' ' + String(res.flag == null ? '' : res.flag);
    return /冲突/.test(msg);
  }

  // ============================================================
  // 3.9 上课时间解析 —— 把「星期一第1-2节{1-16周}」拆成能算的结构
  // ============================================================
  //
  //  为什么值得单独做一层：正方把上课时间压成一个字符串塞在 sksj 里，
  //  用 indexOf 只能做「包含」这种粗筛，判不了「A 和 B 到底冲不冲突」。
  //  拆成 {星期, 起节, 止节, 周次集合} 之后：
  //    · 「只要单周」「不要第3-4节」这类精细筛选才做得出来；
  //    · 两门课是否冲突能在**本地**算出来，省掉一次服务端往返
  //      （抢课拼的就是往返次数）。
  //
  //  实测串形如：'星期一第1-2节{1-16周}<br>星期三第5-6节{3-8周}'
  //  周次还可能是：'1-16周' / '1-16(单)周' / '2-16(双)周' / '1-16(1-16)周'
  //
  //  ⚠ 站点全站劫持了 filter/some，这里一律用最朴素的 for 循环，不用数组高阶方法。

  var DAY_NUM = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  var DAY_NAME = ['', '一', '二', '三', '四', '五', '六', '日'];

  /** 周次规格串 → { 周数: true }。支持 1-16 / 1-16(单) / 2-16(双) / 1-16(1-16) */
  function parseWeeks(spec) {
    var set = {};
    var tokens = String(spec || '').split(/[,，]/);
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i].replace(/周/g, '').replace(/\s+/g, '');
      if (!t) continue;
      var m = /^(\d+)(?:-(\d+))?$/.exec(t);
      if (m) {
        var a = parseInt(m[1], 10);
        var b = m[2] ? parseInt(m[2], 10) : a;
        for (var w = a; w <= b; w++) set[w] = true;
        continue;
      }
      m = /^(\d+)-(\d+)\(单\)$/.exec(t);
      if (m) {
        for (var s = parseInt(m[1], 10); s <= parseInt(m[2], 10); s += 2) set[s] = true;
        continue;
      }
      m = /^(\d+)-(\d+)\(双\)$/.exec(t);
      if (m) {
        for (var d = parseInt(m[1], 10); d <= parseInt(m[2], 10); d += 2) set[d] = true;
        continue;
      }
      m = /^(\d+)-(\d+)\((\d+)-(\d+)\)$/.exec(t);
      if (m) {
        for (var e = parseInt(m[3], 10); e <= parseInt(m[4], 10); e++) set[e] = true;
      }
    }
    return set;
  }

  /** 周次集合是否为空 */
  function weeksIsEmpty(set) {
    if (!set) return true;
    for (var k in set) { if (set[k]) return false; }
    return true;
  }

  /** 教学班时间串 → [{day,start,end,weeks}]；解析不出来返回 null（**不抛异常**） */
  function parseSchedule(str) {
    if (!str) return null;
    var parts = String(str).split(/<br\s*\/?>/i);
    var segs = [];
    for (var i = 0; i < parts.length; i++) {
      var m = /星期([一二三四五六日天])第(\d+)(?:-(\d+))?节\{([^}]*)\}/.exec(parts[i]);
      if (!m) continue;
      segs.push({
        day: DAY_NUM[m[1]],
        start: parseInt(m[2], 10),
        end: m[3] ? parseInt(m[3], 10) : parseInt(m[2], 10),
        weeks: parseWeeks(m[4]),
      });
    }
    return segs.length ? segs : null;
  }

  /** 两段课表是否重叠：同一天 + 节次区间相交 + 周次有交集 */
  function schedulesOverlap(a, b) {
    if (!a || !b) return false;
    for (var i = 0; i < a.length; i++) {
      for (var j = 0; j < b.length; j++) {
        var x = a[i], y = b[j];
        if (x.day !== y.day) continue;
        if (!(x.start <= y.end && y.start <= x.end)) continue;
        for (var k in x.weeks) { if (y.weeks[k]) return true; }
      }
    }
    return false;
  }

  /** 课表里是否有某一天（1=周一 … 7=周日） */
  function scheduleHasDay(segs, dayNum) {
    if (!segs) return false;
    for (var i = 0; i < segs.length; i++) { if (segs[i].day === dayNum) return true; }
    return false;
  }

  /** 课表里是否有与 [from,to] 节次区间相交的段 */
  function scheduleHasPeriod(segs, from, to) {
    if (!segs) return false;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.start <= to && from <= s.end) return true;
    }
    return false;
  }

  /** 课表与某个周次集合是否有共同周 */
  function scheduleSharesWeek(segs, weekSet) {
    if (!segs || weeksIsEmpty(weekSet)) return false;
    for (var i = 0; i < segs.length; i++) {
      for (var k in segs[i].weeks) { if (weekSet[k]) return true; }
    }
    return false;
  }

  /**
   * 解析用户写的星期规格："星期一" / "一,三" / "1,3" / "周三" → [3, ...]，去重
   * 数字按 1=周一 … 7=周日 理解。
   */
  function parseDaySpec(spec) {
    var out = [];
    var toks = String(spec || '').split(/[,，\s、]+/);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/星期|周|礼拜/g, '').trim();
      if (!t) continue;
      var n = 0;
      if (/^[1-7]$/.test(t)) n = parseInt(t, 10);
      else if (/^[一二三四五六日天]$/.test(t)) n = DAY_NUM[t];
      if (n && indexOfNum(out, n) < 0) out.push(n);
    }
    return out;
  }

  function indexOfNum(arr, n) {
    for (var i = 0; i < arr.length; i++) { if (arr[i] === n) return i; }
    return -1;
  }

  /**
   * 解析用户写的节次规格："第3-4节" / "3-4" / "5" / "第1-2节,第5-6节" → [[3,4],[5,6]]
   * 单个数按「该节所在的一段」（n → [n,n]）理解。
   */
  function parsePeriodSpec(spec) {
    var out = [];
    var toks = String(spec || '').split(/[,，\s、]+/);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/第|节/g, '').trim();
      if (!t) continue;
      var m = /^(\d+)(?:-(\d+))?$/.exec(t);
      if (!m) continue;
      var a = parseInt(m[1], 10);
      var b = m[2] ? parseInt(m[2], 10) : a;
      if (a > b) { var tmp = a; a = b; b = tmp; }
      out.push([a, b]);
    }
    return out;
  }

  /**
   * 结构化时间筛选。返回 {ok:true} 或 {ok:false, reason}。
   *
   * 重要约定：**解析不出结构化时间时不拦**（直接放行）。不同学校 sksj 格式有差异，
   * 认不出来就把整批课挡光，比不筛更糟。
   */
  function matchScheduleFilters(cls, t) {
    var dayInc = parseDaySpec(t.dayInc), dayExc = parseDaySpec(t.dayExc);
    var perInc = parsePeriodSpec(t.periodInc), perExc = parsePeriodSpec(t.periodExc);
    var wkInc = t.weekInc ? parseWeeks(t.weekInc) : null;
    var wkExc = t.weekExc ? parseWeeks(t.weekExc) : null;
    var wkIncUsed = wkInc && !weeksIsEmpty(wkInc);
    var wkExcUsed = wkExc && !weeksIsEmpty(wkExc);
    if (!dayInc.length && !dayExc.length && !perInc.length && !perExc.length && !wkIncUsed && !wkExcUsed) {
      return { ok: true };
    }

    var segs = parseSchedule(cls && cls.sksj);
    if (!segs) return { ok: true };

    var i;
    if (dayInc.length) {
      var hitDay = false;
      for (i = 0; i < dayInc.length; i++) { if (scheduleHasDay(segs, dayInc[i])) hitDay = true; }
      if (!hitDay) return { ok: false, reason: '星期不符合要求' };
    }
    if (dayExc.length) {
      for (i = 0; i < dayExc.length; i++) {
        if (scheduleHasDay(segs, dayExc[i])) return { ok: false, reason: '命中排除的星期' + DAY_NAME[dayExc[i]] };
      }
    }
    if (perInc.length) {
      var hitP = false;
      for (i = 0; i < perInc.length; i++) {
        if (scheduleHasPeriod(segs, perInc[i][0], perInc[i][1])) hitP = true;
      }
      if (!hitP) return { ok: false, reason: '节次不符合要求' };
    }
    if (perExc.length) {
      for (i = 0; i < perExc.length; i++) {
        if (scheduleHasPeriod(segs, perExc[i][0], perExc[i][1])) {
          return { ok: false, reason: '命中排除的节次（第' + perExc[i][0] + '-' + perExc[i][1] + '节）' };
        }
      }
    }
    if (wkIncUsed && !scheduleSharesWeek(segs, wkInc)) return { ok: false, reason: '周次不在要求范围内' };
    if (wkExcUsed && scheduleSharesWeek(segs, wkExc)) return { ok: false, reason: '周次命中排除范围' };

    return { ok: true };
  }

  /**
   * 这个教学班是否与「已选课程」时间冲突（纯本地计算，不发请求）。
   * 已选列表的行也带 sksj，格式与教学班一致。
   */
  function classConflictsWithChoosed(cls, rows) {
    var mine = parseSchedule(cls && cls.sksj);
    if (!mine) return false;
    if (!rows || !rows.length) return false;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r) continue;
      if (schedulesOverlap(mine, parseSchedule(r.sksj))) return true;
    }
    return false;
  }

  /** 描述一句时间，给日志用 */
  function describeSksj(sksj) {
    return String(sksj || '').replace(/<br\s*\/?>/gi, '；').replace(/\s+/g, ' ').trim();
  }

  // ============================================================
  // 4. 目标匹配 —— 通用版的核心
  // ============================================================
  //
  //  目标（target）字段：
  //    name       课程名关键词，空格分隔 = 全部命中（AND）。模糊、忽略大小写
  //    kch        课程号，填了就按课程号匹配（课程名可以不填）
  //    teacherInc 只选这些教师，逗号/空格分隔，任一命中即可
  //    teacherExc 排除这些教师
  //    timeInc    上课时间必须包含这些关键词，如 "星期一" / "第5-6节"
  //    minRemain  最少剩余容量（1 = 必须有余量；抽签类轮次可设 0）
  //
  //  匹配范围含 kcmc(课程名) / kch(课程号) / kzmc(课程组名)，
  //  所以写 "体育" 也能命中 "体育I-z120100012" 这种组名。

  function targetIsValid(t) { return !!(t.name || t.kch); }

  function matchCourse(course, t) {
    if (!course || !t) return false;
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

    // 结构化时间筛选（星期 / 节次 / 周次的包含与排除）
    var sv = matchScheduleFilters(cls, t);
    if (!sv.ok) return false;

    return true;
  }

  /**
   * 给一个目标挑教学班：先按筛选条件过滤，再按剩余容量降序。
   *
   * @param {Array} choosedRows 已选课程行（可选）。给了、且目标勾了「本地避开冲突」，
   *        就优先挑与已选课不冲的；**如果全都冲，仍然照旧挑一个**
   *        —— 让服务端给最终判定，别自己先把路堵死。
   */
  function pickClassForTarget(classes, t, choosedRows) {
    var hits = where(classes, function (c) { return matchClass(c, t); });
    if (!hits.length) return { ok: false, reason: '没有符合筛选条件的教学班（共 ' + classes.length + ' 个）' };

    if (t.avoidConflict && choosedRows && choosedRows.length) {
      var free = where(hits, function (c) { return !classConflictsWithChoosed(c, choosedRows); });
      if (free.length) hits = free;
    }

    hits.sort(function (a, b) { return remainOf(b) - remainOf(a); });
    return { ok: true, cls: hits[0], count: hits.length };
  }

  // ============================================================
  // 5. 配置持久化（优先 chrome.storage.local，退回 localStorage）
  // ============================================================

  var OPTS = {
    interval: 1200,   // 轮询基础间隔 ms
    jitter: 400,      // 随机抖动上限 ms
    dryRun: true,     // 仅演练
    precheck: false,  // 提交前做冲突预检（更稳但多一次往返，抢速度时别开）
    skipChoosed: true,// 已选过的课程自动跳过
    maxRounds: 0,     // 0 = 不限轮次
    autoGoto: 'auto',  // 不在选课页时：'auto' 直接跳 | 'ask' 弹条询问 | 'off' 不处理
    // —— 以下为参考社区实现新增 ——
    cooldownMs: 6000,     // 某个目标提交失败后，单独冷这么久再试（别的目标不受影响）
    maxFailStreak: 0,     // 连续失败多少轮就自动暂停（0 = 不熔断）
    autoDrop: false,      // ★危险：冲突时自动退「可退选修课」。默认关闭
    beep: true,           // 抢到/失败时响一声（WebAudio，不需要任何权限）
    startAt: '',          // 定时开抢时刻，如 '2026-09-22T12:30'。空 = 立即开始
  };

  var targets = [];
  var saveTimer = null;

  var hasExtStore = (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);

  async function storeGet() {
    if (hasExtStore) {
      try {
        var r = await chrome.storage.local.get(STORE_KEY);
        return r && r[STORE_KEY] ? r[STORE_KEY] : null;
      } catch (e) { /* 落到 localStorage */ }
    }
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { return null; }
  }

  async function storeSet(val) {
    if (hasExtStore) {
      try { var o = {}; o[STORE_KEY] = val; await chrome.storage.local.set(o); return; } catch (e) { /* 落到 localStorage */ }
    }
    try { localStorage.setItem(STORE_KEY, JSON.stringify(val)); } catch (e) { /* 隐私模式等，忽略 */ }
  }

  function saveCfg() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      storeSet({ v: VERSION, opts: OPTS, targets: targets });
    }, 250);
  }

  function applyCfg(o) {
    var got = false;
    if (o && o.opts) {
      for (var k in OPTS) { if (o.opts[k] !== undefined) OPTS[k] = o.opts[k]; }
    }
    if (o && Array.isArray(o.targets) && o.targets.length) {
      targets.length = 0;
      for (var i = 0; i < o.targets.length; i++) targets.push(o.targets[i]);
      got = true;
    }
    return got;
  }

  function newTarget(name) {
    return {
      id: uid(), enabled: true, name: name || '', kch: '',
      teacherInc: '', teacherExc: '', timeInc: '', minRemain: 1,
      // 结构化时间筛选（星期 1-7 / 节次 / 周次）
      dayInc: '', dayExc: '', periodInc: '', periodExc: '', weekInc: '', weekExc: '',
      avoidConflict: false,   // 本地避开与已选课时间冲突的教学班
      replaceKch: '',         // 换课：目标抢到时，先退掉这门保底课
      done: false, status: '',
      // 运行时状态（不持久化也无需用户看见）
      failStreak: 0, cooldownUntil: 0,
    };
  }

  // ============================================================
  // 5.4 账号与登录 —— 抢课途中掉登录态就自动重登，然后接着抢
  // ============================================================
  //
  //  密码存哪，是这段代码唯一需要斟酌的地方：
  //    · 默认只放 `chrome.storage.session` —— 那是**内存**，浏览器一关就没了；
  //      而且**网页 JS 读不到**（页面自己的 localStorage/sessionStorage 站点是能读的，绝不能放那儿）。
  //      storage.session 默认连内容脚本都读不到，所以 background.js 会调一次 setAccessLevel 放开。
  //    · 勾了「记住密码」才额外写进 `chrome.storage.local`（持久化，明文落盘 —— 自己权衡）。
  //    · 无论放哪，都**不会**进「导出配置」的 JSON 里。

  var CRED_KEY = 'zf-xk-cred';                 // 持久（可选）
  var CRED_SESSION_KEY = 'zf-xk-cred-session'; // 仅本次浏览器会话
  var LOGIN_FAIL_KEY = 'zxh-login-fails';      // 连续登录失败计数（防把账号试锁）

  var CRED = { user: '', pass: '', remember: false, autoRelogin: true, loaded: false };

  var sessionAreaOk = false;

  function hasExtStorage() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
  }

  function hasSessionArea() {
    return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session);
  }

  /**
   * 确认 storage.session 能被我们读写。
   * 读不到就通过发消息把后台 service worker 叫醒（它会调 setAccessLevel），再试一次。
   */
  async function ensureSessionArea() {
    if (sessionAreaOk) return true;
    if (!hasSessionArea()) return false;
    try {
      await chrome.storage.session.get(CRED_SESSION_KEY);
      sessionAreaOk = true;
      return true;
    } catch (e) {
      try {
        if (chrome.runtime && chrome.runtime.sendMessage) {
          await chrome.runtime.sendMessage({ cmd: 'enable-session-storage' });
        }
        await chrome.storage.session.get(CRED_SESSION_KEY);
        sessionAreaOk = true;
        return true;
      } catch (e2) { return false; }
    }
  }

  async function loadCred() {
    var got = null;
    if (hasExtStorage()) {
      if (await ensureSessionArea()) {
        try {
          var r = await chrome.storage.session.get(CRED_SESSION_KEY);
          if (r && r[CRED_SESSION_KEY]) got = r[CRED_SESSION_KEY];
        } catch (e) { /* 落到下面 */ }
      }
      if (!got) {
        try {
          var r2 = await chrome.storage.local.get(CRED_KEY);
          if (r2 && r2[CRED_KEY]) got = r2[CRED_KEY];
        } catch (e2) { /* 忽略 */ }
      }
    }
    if (got) {
      if (typeof got.user === 'string') CRED.user = got.user;
      if (typeof got.pass === 'string') CRED.pass = got.pass;
      if (typeof got.remember === 'boolean') CRED.remember = got.remember;
      if (typeof got.autoRelogin === 'boolean') CRED.autoRelogin = got.autoRelogin;
    }
    CRED.loaded = true;
    return CRED;
  }

  async function saveCred() {
    if (!hasExtStorage()) return;
    var payload = {
      user: CRED.user, pass: CRED.pass,
      remember: !!CRED.remember, autoRelogin: CRED.autoRelogin !== false,
    };
    var o = {};
    o[CRED_SESSION_KEY] = payload;
    try {
      if (await ensureSessionArea()) await chrome.storage.session.set(o);
      else await chrome.storage.local.set(o);
    } catch (e) { /* 忽略：至少内存里还有 */ }

    if (payload.remember) {
      try { var o2 = {}; o2[CRED_KEY] = payload; await chrome.storage.local.set(o2); } catch (e3) { /* 忽略 */ }
    } else {
      try { await chrome.storage.local.remove(CRED_KEY); } catch (e4) { /* 忽略 */ }
    }
  }

  async function clearCred() {
    CRED.user = ''; CRED.pass = ''; CRED.remember = false;
    if (!hasExtStorage()) return;
    try { await chrome.storage.session.remove(CRED_SESSION_KEY); } catch (e) { /* 忽略 */ }
    try { await chrome.storage.local.remove(CRED_KEY); } catch (e2) { /* 忽略 */ }
  }

  var credTimer = null;
  function saveCredDebounced() {
    if (credTimer) clearTimeout(credTimer);
    credTimer = setTimeout(saveCred, 350);
  }

  // ---- 续抢标记：同源跳转间靠 sessionStorage 传递（它会被站点读到，但这里没有敏感信息）----

  var RELOGIN_KEY = 'zxh-relogin';
  var RELOGIN_TTL = 5 * 60 * 1000;

  function readReloginState() {
    try { return JSON.parse(sessionStorage.getItem(RELOGIN_KEY) || 'null'); } catch (e) { return null; }
  }

  function writeReloginState(s) {
    try {
      if (s) sessionStorage.setItem(RELOGIN_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(RELOGIN_KEY);
    } catch (e) { /* 忽略 */ }
  }

  function reloginIsFresh(s) { return !!(s && s.at && Date.now() - s.at < RELOGIN_TTL); }

  function readLoginFails() {
    try {
      var s = JSON.parse(sessionStorage.getItem(LOGIN_FAIL_KEY) || 'null');
      if (!s || !s.at || Date.now() - s.at > 10 * 60 * 1000) return { n: 0, at: 0 };
      return s;
    } catch (e) { return { n: 0, at: 0 }; }
  }

  function bumpLoginFails() {
    var s = readLoginFails();
    s = { n: (s.n || 0) + 1, at: Date.now() };
    try { sessionStorage.setItem(LOGIN_FAIL_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
    return s.n;
  }

  function clearLoginFails() {
    try { sessionStorage.removeItem(LOGIN_FAIL_KEY); } catch (e) { /* 忽略 */ }
  }

  // ---- HTTP ----

  async function httpGet(path) {
    var res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' });
    var text = await res.text();
    var p = '';
    try { p = new URL(res.url, location.href).pathname; } catch (e) { /* 忽略 */ }
    return { text: text, path: p, status: res.status };
  }

  /** 现在有没有登录态？true / false；网络异常返回 null（别把断网当成掉线） */
  async function checkSession() {
    try {
      var r = await httpGet('/xtgl/index_initMenu.html');
      if (/login/i.test(r.path) || looksLikeLoginHtml(r.text)) return false;
      return true;
    } catch (e) { return null; }
  }

  /** 把登录页里所有 `<input id=.. value=..>` 抽成字典（正方把上下文全塞隐藏域）
   *  实现已提到 SECTION 0.0 的 inputsFromHtml（那边也要用它解析服务器页面），这里只留名字。 */
  function parseLoginInputs(html) {
    return inputsFromHtml(html);
  }

  /**
   * 把抠出来的错误文案收拾干净。
   * 剥标签时会把 `<span>` 之类的内联标签换成空格，于是「不正确</span>，请」会多出一个
   * 空格 —— 中文标点前后不该有空格，这里统一抹掉。
   */
  function tidyMsg(s) {
    return String(s == null ? '' : s)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([，。！？：；、）】》」』·,.!?:;)])/g, '$1')
      .replace(/([（【《「『(])\s+/g, '$1')
      .replace(/^\s+|\s+$/g, '');
  }

  function extractLoginError(html) {
    var m = /<p[^>]*\bid\s*=\s*["']tips["'][^>]*>([\s\S]*?)<\/p>/i.exec(html);
    if (!m) m = /<(\w+)[^>]*\bid\s*=\s*["'](?:err-hint|errorMsg|errmsg|msg)["'][^>]*>([\s\S]*?)<\/\1>/i.exec(html);
    var t = m ? tidyMsg(m[1] || m[2] || '') : '';
    if (t) return t;

    var plain = tidyMsg(html);
    var kws = ['用户名或密码不正确', '用户名或密码错误', '密码不正确', '密码错误', '该用户不存在',
      '用户不存在', '已被锁定', '被锁定', '验证码错误', '验证码已失效', '验证码不正确', '登录失败'];
    for (var i = 0; i < kws.length; i++) {
      var k = plain.indexOf(kws[i]);
      if (k >= 0) return plain.slice(Math.max(0, k - 20), k + 50).trim();
    }
    return '';
  }

  /** 登录页启用了验证码？启用了就别指望自动登录 */
  function loginPageHasCaptcha(html) {
    return /id\s*=\s*["']?(yzm|verifycode|checkcode|jym|authcode|validatecode)["']?/i.test(html);
  }

  /**
   * 直接用接口登录（不依赖登录页自己的 JS —— 内容脚本读不到主世界的加密函数）。
   * 走的正是 grab.mjs 里已经实测过的那条路：
   *   GET 登录页拿隐藏域 → GET login_getPublicKey 拿公钥
   *   → RSA(PKCS#1 v1.5) 加密密码 → POST 全部隐藏域 + yhm + mm
   * 成功时服务端 302 到主菜单，跟随跳转后最终 URL 不再是登录页。
   */
  async function doLogin(user, pass) {
    if (!user || !pass) return { ok: false, error: '账号或密码为空' };

    var pg = await httpGet('/xtgl/login_slogin.html');
    if (!/<input\b[^>]*\bid\s*=\s*["']?yhm["']?/i.test(pg.text)) {
      // 拿不到登录表单：多半是「已登录时访问登录页会被弹回主菜单」
      var alive = await checkSession();
      if (alive === true) return { ok: true, already: true };
      return { ok: false, error: '拿不到登录表单（站点改版或网络异常）' };
    }
    if (loginPageHasCaptcha(pg.text)) {
      return { ok: false, error: '该校登录启用了验证码，无法自动登录，请手动登录一次' };
    }

    var ctx = parseLoginInputs(pg.text);
    var needEnc = String(ctx.mmsfjm == null ? '1' : ctx.mmsfjm) !== '0';
    var mm = pass;

    if (needEnc) {
      var pkRes = await httpGet('/xtgl/login_getPublicKey.html?time=' + Date.now());
      var pk = null;
      try { pk = JSON.parse(pkRes.text); } catch (e) { pk = null; }
      if (!pk || !pk.modulus || !pk.exponent) {
        return { ok: false, error: '取登录公钥失败：' + String(pkRes.text).slice(0, 80) };
      }
      var rsa = (typeof window !== 'undefined') ? window.ZFRSA : null;
      if (!rsa || !rsa.encryptPassword) {
        return { ok: false, error: 'RSA 模块没加载（rsa-pkcs1.js 缺失）' };
      }
      try { mm = rsa.encryptPassword(pass, pk.modulus, pk.exponent); }
      catch (e2) { return { ok: false, error: '密码加密失败：' + e2.message }; }
    }

    var form = new URLSearchParams();
    for (var k in ctx) {
      if (Object.prototype.hasOwnProperty.call(ctx, k)) form.set(k, ctx[k] == null ? '' : ctx[k]);
    }
    form.set('yhm', user);
    form.set('mm', mm);
    form.set('language', ctx.language || 'zh_CN');

    var res = await fetch('/xtgl/login_slogin.html', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: form.toString(),
      redirect: 'follow',
    });
    var html = await res.text();
    var path = '';
    try { path = new URL(res.url, location.href).pathname; } catch (e3) { /* 忽略 */ }
    if (!/login_slogin\.html/i.test(path)) return { ok: true };
    return { ok: false, error: extractLoginError(html) || '登录被拒（账号密码错、被锁定，或需要验证码）' };
  }

  // ---- 提示条（登录页上主面板不会注入，所以这里用独立的内联样式小条）----

  function showLoginTip(msg, kind, sticky) {
    var box = document.getElementById('zxh-login-tip');
    if (!box) {
      box = document.createElement('div');
      box.id = 'zxh-login-tip';
      box.setAttribute('style', [
        'position:fixed', 'z-index:2147483647', 'left:50%', 'top:18px',
        'transform:translateX(-50%)', 'max-width:520px', 'padding:10px 16px',
        'border:1px solid #d0d7de', 'border-radius:8px',
        'box-shadow:0 8px 28px rgba(27,31,36,.22)',
        'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
        'white-space:pre-wrap', 'text-align:center',
      ].join(';'));
      (document.body || document.documentElement).appendChild(box);
    }
    var bg = { ok: '#dafbe1', err: '#fff8f8', warn: '#fff8f0' }[kind] || '#f6f8fa';
    var fg = { ok: '#1a7f37', err: '#cf222e', warn: '#9a6700' }[kind] || '#1f2328';
    box.style.background = bg;
    box.style.color = fg;
    box.style.borderColor = fg;
    box.textContent = msg;
    if (!sticky) setTimeout(function () { if (box.parentNode) box.remove(); }, 2600);
    return box;
  }

  // ---- 两个入口：掉线时触发 / 在登录页上执行 ----

  /**
   * 抢课途中发现登录态没了。
   * 记下「要续抢」再去登录页；没配账号就老实停下并说清楚原因。
   */
  async function onSessionLost(detail) {
    log('⚠ 登录态失效' + (detail ? '（' + detail + '）' : '') + '。', 'e');

    if (!CRED.loaded) await loadCred();

    if (CRED.autoRelogin === false) {
      log('「掉线自动重登」没勾选，已停止。手动登录后重新开始即可。', 'w');
      return;
    }
    if (!CRED.user || !CRED.pass) {
      log('没有保存账号密码，已停止。请在面板「账号」里填好并勾上「掉线自动重登」。', 'w');
      return;
    }

    var fails = readLoginFails();
    if (fails.n >= 3) {
      log('最近 10 分钟内已连续登录失败 ' + fails.n + ' 次，不再自动尝试（避免账号被锁）。' +
        '请核对面板里的密码，改好后手动登录一次。', 'e');
      return;
    }

    writeReloginState({ at: Date.now(), running: true, from: location.href, detail: detail || '' });
    log('正在自动重新登录…', 'w');
    await sleep(400);
    location.href = '/xtgl/login_slogin.html';
  }

  /**
   * 在登录页上执行自动登录。
   * 只有「我们自己刚标记过要重登」时才动手 —— 不会替用户擅自登录。
   * @returns {Promise<boolean>} 是否已经发起并成功（成功时会自行跳走）
   */
  async function autoLoginOnLoginPage() {
    var st = readReloginState();
    if (!st || !st.running || !reloginIsFresh(st)) {
      if (st) writeReloginState(null);
      return false;
    }

    await loadCred();
    if (CRED.autoRelogin === false || !CRED.user || !CRED.pass) {
      writeReloginState(null);
      showLoginTip('抢课途中掉线了，但没有可用的账号密码。\n请在面板「账号」里填好再继续。', 'warn', true);
      return false;
    }

    var fails = readLoginFails();
    if (fails.n >= 3) {
      writeReloginState(null);
      showLoginTip('已连续登录失败 ' + fails.n + ' 次，停止自动重登（避免账号被锁）。\n请核对密码后手动登录。', 'err', true);
      return false;
    }

    showLoginTip('抢课途中掉线，正在自动重新登录…', 'warn', true);

    var r;
    try { r = await doLogin(CRED.user, CRED.pass); }
    catch (e) { r = { ok: false, error: e.message }; }

    if (r.ok) {
      clearLoginFails();
      showLoginTip('重新登录成功，正在回到选课页接着抢…', 'ok', true);
      await sleep(500);
      location.href = resolveSelectUrl();
      return true;
    }

    // 失败绝不自动重试 —— 密码错了再试还是错，连续试只会把账号试锁
    var n = bumpLoginFails();
    writeReloginState(null);
    showLoginTip('自动登录失败（第 ' + n + ' 次）：' + r.error +
      '\n\n已停止自动重登。请在本页手动登录，然后回到选课页重新开始。', 'err', true);
    return false;
  }

  // ---- 回到选课页之后：接着抢 ----

  function maybeResumeAfterRelogin() {
    var st = readReloginState();
    if (!st || !st.running) return false;
    writeReloginState(null);
    if (!reloginIsFresh(st)) return false;
    log('已重新登录，' + (OPTS.dryRun ? '接着演练（不会提交）' : '接着抢课') + '…', 's');
    setTimeout(function () { if (!state.running) runLoop(); }, 1200);
    return true;
  }

  // ============================================================
  // 5.5 启动闸门 —— 先判断「我在不在选课页」，不在就把人送过去
  // ============================================================
  //
  //  位置很讲究：必须在 OPTS / storeGet 就位之后、任何 DOM 操作之前。
  //  不在选课页时直接 return，整个 IIFE 到此结束 —— 主面板压根不会注入，
  //  所以不会出现「人在主菜单，右下角却杵着一个抢课面板」的尴尬。
  //
  //  三种跳转模式：'auto' 直接跳（默认，登录后落地主菜单即被送到选课页）
  //                'ask'  右下角弹一条提示，用户点「前往选课」才跳
  //                'off'  完全不干预
  //
  //  三种「不跳」的情况由 gotoBlockReason() 兜住：从上一页按返回回来 / 刚点过取消 /
  //  一分钟内已经跳了 2 次（防死循环）。

  var PAGE_STATE = (function () {
    try { return detectPageState(); } catch (e) { return 'unknown'; }
  })();

  if (PAGE_STATE !== 'select') {
    // 非选课页也要留一条消息通道 —— 否则扩展弹窗在这里「喊不应」，
    // 用户就没法从弹窗里手动把自己送过去（尤其是把跳转设成「不处理」之后）。
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg) return;
        if (msg.cmd === 'ping') {
          sendResponse({
            ok: false, version: VERSION, pageState: PAGE_STATE,
            canGoto: PAGE_STATE === 'other-zf', onLoginPage: looksLikeLogin(),
          });
        } else if (msg.cmd === 'goto') {
          if (PAGE_STATE === 'other-zf') { gotoSelect(resolveSelectUrl()); sendResponse({ ok: true }); }
          else sendResponse({ ok: false, reason: 'not-zf' });
        }
      });
    }

    // ① 登录页：只有「刚才抢课掉线」的标记存在时才自动登录。
    //    绝不主动替用户登录 —— 用户自己打开登录页时不应该被我们填表提交。
    if (looksLikeLogin()) {
      autoLoginOnLoginPage();
      return;
    }

    // ② 正方教务的其它页面（主菜单等）→ 按设置把用户送到选课页
    if (PAGE_STATE === 'other-zf' && !gotoBlockReason()) {
      // 设置是异步读的，这里也跟着异步（非选课页本来就没有别的初始化在等）
      var gotoUrl = resolveSelectUrl();
      storeGet().then(function (o) {
        var mode = (o && o.opts && typeof o.opts.autoGoto !== 'undefined')
          ? o.opts.autoGoto : OPTS.autoGoto;
        if (mode === true) mode = 'auto';     // 兼容万一是旧版布尔值
        if (mode === false) mode = 'off';
        if (mode === 'off') return;
        if (gotoBlockReason()) return;        // 读设置的这段时间里状态可能变了
        if (mode === 'ask') { showGotoPrompt(gotoUrl); return; }
        gotoSelect(gotoUrl);                  // 'auto'
      }).catch(function () {
        // 读设置失败就按默认值来，别把功能整个吞掉
        if (OPTS.autoGoto === 'auto') gotoSelect(gotoUrl);
        else if (OPTS.autoGoto === 'ask') showGotoPrompt(gotoUrl);
      });
    }
    return;
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
    '#zxh-panel input[type=text],#zxh-panel input[type=number],#zxh-panel input[type=password]{width:100%;padding:4px 6px;border:1px solid #d0d7de;border-radius:6px;font-size:12px;background:#fff;color:#1f2328;}',
    '#zxh-panel select{width:100%;padding:4px 6px;border:1px solid #d0d7de;border-radius:6px;font-size:12px;background:#fff;color:#1f2328;height:26px;}',
    '#zxh-panel .withbtn{display:flex;gap:6px;}',
    '#zxh-panel .withbtn>*:first-child{flex:1;}',
    '#zxh-panel .withbtn>button{flex:0 0 56px;}',
    '#zxh-panel .cred-hint{font-size:10.5px;color:#8b949e;margin-top:3px;}',
    '#zxh-panel .cred-bad{color:#cf222e;}',
    '#zxh-panel .cred-ok{color:#1a7f37;}',
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
    '<div class="row" style="margin-bottom:5px">',
    '<button id="zxh-selftest">自检（只读）</button>',
    '</div>',
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
    '<div class="row" style="margin-top:4px">',
    '<div><label>失败冷却 ms</label><input type="number" id="zxh-cd" value="6000" min="0" step="1000"></div>',
    '<div><label>连败暂停(0=关)</label><input type="number" id="zxh-mf" value="0" min="0" step="1"></div>',
    '</div>',
    '<div class="row" style="margin-top:4px">',
    '<div><label>定时开抢（留空 = 立即开始）</label><input type="datetime-local" id="zxh-startat"></div>',
    '</div>',

    '<label class="chk"><input type="checkbox" id="zxh-dry" checked>仅演练，不真正提交<b style="color:#cf222e">（第一次务必保持勾选）</b></label>',
    '<label class="chk"><input type="checkbox" id="zxh-pre">提交前做时间冲突预检</label>',
    '<label class="chk"><input type="checkbox" id="zxh-skip" checked>已选过的课程自动跳过</label>',
    '<label class="chk"><input type="checkbox" id="zxh-beep" checked>抢到 / 被拒时响一声（不需要任何权限）</label>',
    '<label class="chk"><input type="checkbox" id="zxh-drop">冲突时自动退「可退选修课」<b style="color:#cf222e">（危险·默认关）</b></label>',

    '<div class="sect">账号 · 掉线自动重登<i></i></div>',
    '<div class="row">',
    '<div><label>学号 / 账号</label><input type="text" id="zxh-user" autocomplete="off" spellcheck="false"></div>',
    '</div>',
    '<div class="row withbtn" style="margin-top:4px">',
    '<div><label>密码</label><input type="password" id="zxh-pass" autocomplete="new-password"></div>',
    '<button id="zxh-pwshow">显示</button>',
    '</div>',
    '<label class="chk"><input type="checkbox" id="zxh-remember">记住密码（明文存进扩展存储，浏览器关了也在）</label>',
    '<label class="chk"><input type="checkbox" id="zxh-relogin" checked>掉线自动重登，并接着抢课</label>',
    '<div class="row" style="margin-top:5px">',
    '<button id="zxh-login" class="pri">保存并登录</button>',
    '<button id="zxh-logout">清除账号</button>',
    '</div>',
    '<div class="cred-hint" id="zxh-cred-hint"></div>',

    '<div class="row" style="margin-top:6px">',
    '<div><label>不在选课页时</label><select id="zxh-gotomode">',
    '<option value="auto">自动跳转过去</option>',
    '<option value="ask">弹提示询问</option>',
    '<option value="off">不处理</option>',
    '</select></div>',
    '</div>',

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
    '<div class="hint">查询是<b>直接打接口</b>取课程列表的，<b>不需要点页面上的「查询」按钮</b> —— ' +
    '按钮点不到 / 在手机视口外 / 页面脚本没跑起来都不影响。参数缺了会自动从服务器补齐。</div>',
    '<div class="hint">目标卡片的 <b>⚙</b> 里可以按 <b>星期 / 节次 / 周次</b> 精确筛选教学班（支持单双周），' +
    '勾上「本地避开冲突」还会用本地课表算一遍，省掉一次往返。</div>',
    '<div class="hint">「冲突时自动退可退选修课」<b>默认关闭</b>。开了也只退 <b>kklxdm=10 且 rwlx=2</b> 的通识选修，' +
    '必修/不可退课一律只告警不动手。退选不可逆，开之前请先演练。</div>',
    '<div class="hint">参数全部取自本页隐藏域，用的是你浏览器里已有的登录态。改动会自动存进扩展自己的存储里。</div>',
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
      cd: p.querySelector('#zxh-cd'),
      mf: p.querySelector('#zxh-mf'),
      startAt: p.querySelector('#zxh-startat'),
      dry: p.querySelector('#zxh-dry'),
      pre: p.querySelector('#zxh-pre'),
      skip: p.querySelector('#zxh-skip'),
      beep: p.querySelector('#zxh-beep'),
      drop: p.querySelector('#zxh-drop'),
      gotoMode: p.querySelector('#zxh-gotomode'),
      user: p.querySelector('#zxh-user'),
      pass: p.querySelector('#zxh-pass'),
      pwshow: p.querySelector('#zxh-pwshow'),
      remember: p.querySelector('#zxh-remember'),
      relogin: p.querySelector('#zxh-relogin'),
      login: p.querySelector('#zxh-login'),
      logout: p.querySelector('#zxh-logout'),
      credHint: p.querySelector('#zxh-cred-hint'),
      add: p.querySelector('#zxh-add'),
      cfgbtn: p.querySelector('#zxh-cfgbtn'),
      cfg: p.querySelector('#zxh-cfg'),
      cfgtext: p.querySelector('#zxh-cfgtext'),
      selftest: p.querySelector('#zxh-selftest'),
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

    var th = document.createElement('div');
    th.className = 'th';

    var en = document.createElement('input');
    en.type = 'checkbox';
    en.checked = !!t.enabled;
    en.title = '启用/停用这个目标';
    en.addEventListener('change', function () {
      t.enabled = en.checked;
      card.className = 'tgt' + (t.enabled ? '' : ' off') + (t.done ? ' ok' : '');
      saveCfg();
    });

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
      // 必须就地修改 targets，不能写 targets = ...，
      // 否则 window.__XK_HELPER__.targets 会指向旧数组
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].id === t.id) { targets.splice(i, 1); break; }
      }
      saveCfg();
      renderTargets();
    });

    th.appendChild(en); th.appendChild(ix); th.appendChild(nm); th.appendChild(advBtn); th.appendChild(del);
    card.appendChild(th);

    var st = document.createElement('div');
    st.className = 'tst';
    st.innerHTML = t.done
      ? '<span class="g">✔ ' + esc(t.status || '已完成') + '</span>'
      : (t.status ? esc(t.status) : '<span class="d">待抢</span>');
    card.appendChild(st);

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
    var tw = field('时间要求（模糊匹配原文）', 'f-time', t.timeInc, '如 星期一 或 第5-6节', function (v) { t.timeInc = v; });
    tw.className = 'full';
    adv.appendChild(tw);
    // ↓ 结构化时间筛选：直接把 sksj 解析成 星期/节次/周次 再比，比模糊匹配准
    adv.appendChild(field('只选星期', 'f-day', t.dayInc, '一,三　或 1,3', function (v) { t.dayInc = v; }));
    adv.appendChild(field('排除星期', 'f-dayx', t.dayExc, '如 五', function (v) { t.dayExc = v; }));
    adv.appendChild(field('只选节次', 'f-per', t.periodInc, '如 3-4,5-6', function (v) { t.periodInc = v; }));
    adv.appendChild(field('排除节次', 'f-perx', t.periodExc, '如 11-12', function (v) { t.periodExc = v; }));
    adv.appendChild(field('只选周次', 'f-wk', t.weekInc, '如 1-8 / 1-16(单)', function (v) { t.weekInc = v; }));
    adv.appendChild(field('排除周次', 'f-wkx', t.weekExc, '如 1-2', function (v) { t.weekExc = v; }));
    adv.appendChild(field('替换课程号（换课）', 'f-rep', t.replaceKch, '抢到本课时先退掉这门保底课', function (v) { t.replaceKch = v; }));

    var av = document.createElement('label');
    av.className = 'chk full';
    var avc = document.createElement('input');
    avc.type = 'checkbox';
    avc.checked = !!t.avoidConflict;
    avc.addEventListener('change', function () { t.avoidConflict = avc.checked; saveCfg(); });
    var avt = document.createElement('span');
    avt.textContent = '本地避开与已选课时间冲突的教学班（不发请求，纯本地算）';
    av.appendChild(avc);
    av.appendChild(avt);
    adv.appendChild(av);

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
      xkkz_id: ctxH('xkkz_id'), xklc: ctxH('xklc'),
      kklxdm: ctxH('kklxdm'), kklxmc: ctxH('kklxmc'),
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
    el.cd.value = OPTS.cooldownMs;
    el.mf.value = OPTS.maxFailStreak;
    el.drop.checked = !!OPTS.autoDrop;
    el.beep.checked = OPTS.beep !== false;
    el.startAt.value = OPTS.startAt || '';
    el.gotoMode.value = (OPTS.autoGoto === true) ? 'auto'
      : (OPTS.autoGoto === false) ? 'off'
        : (OPTS.autoGoto || 'auto');
  }

  function syncUIToOpts() {
    OPTS.interval = Math.max(400, Number(el.iv.value) || 1200);
    OPTS.jitter = Math.max(0, Number(el.jt.value) || 0);
    OPTS.maxRounds = Math.max(0, Number(el.mr.value) || 0);
    OPTS.dryRun = el.dry.checked;
    OPTS.precheck = el.pre.checked;
    OPTS.skipChoosed = el.skip.checked;
    OPTS.cooldownMs = Math.max(0, Number(el.cd.value) || 0);
    OPTS.maxFailStreak = Math.max(0, Number(el.mf.value) || 0);
    OPTS.autoDrop = el.drop.checked;
    OPTS.beep = el.beep.checked;
    OPTS.startAt = String(el.startAt.value || '').trim();
    OPTS.autoGoto = el.gotoMode.value || 'auto';
    saveCfg();
  }

  // ---- 账号区（不进 OPTS / 不进导出配置，单独一份存储）----

  function syncCredToUI() {
    el.user.value = CRED.user || '';
    el.pass.value = CRED.pass || '';
    el.remember.checked = !!CRED.remember;
    el.relogin.checked = CRED.autoRelogin !== false;
    updateCredHint();
  }

  function updateCredHint() {
    var armed = CRED.autoRelogin !== false && !!CRED.user && !!CRED.pass;
    var text = CRED.remember
      ? '密码已明文持久保存（扩展存储），换浏览器标签也在。'
      : '密码默认只存内存（浏览器关闭即清空），网页 JS 读不到。';
    text += armed ? '　掉线防重登：已就绪。' : '　掉线防重登：未就绪（要填账号密码）。';
    el.credHint.textContent = text;
    el.credHint.className = 'cred-hint' + (armed ? ' cred-ok' : '');
  }

  // ============================================================
  // 7. 执行逻辑
  // ============================================================

  var state = { running: false, busy: false, querying: false, rounds: 0 };

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
      if (!missing) break;
      if (r.courses.length < STEP) break;
    }
    return { ok: true, courses: all };
  }

  var lastChoosed = { ok: false, rows: [], at: 0 };

  async function refreshChoosed() {
    var r = await queryChoosed();
    lastChoosed = { ok: r.ok, rows: r.rows || [], at: Date.now(), reason: r.reason };
    return lastChoosed;
  }

  /** 这个目标现在能不能试（冷却期过没过） */
  function targetReady(t) {
    return !t.cooldownUntil || Date.now() >= t.cooldownUntil;
  }

  /** 给某个目标上一次冷却 —— 只影响它自己，别的目标照跑 */
  function cooldownTarget(t, ms) {
    if (ms > 0) t.cooldownUntil = Date.now() + ms;
  }

  /** 记一次连续失败（连续失败会触发熔断） */
  function bumpFail(t) {
    t.failStreak = (Number(t.failStreak) || 0) + 1;
  }

  /**
   * 执行一轮。外面套了一层互斥，避免「轮询」和「预览/执行一轮」同时打同一个接口。
   */
  async function tick(doSubmit) {
    if (state.querying) return { results: [], note: '上一轮还在跑，本轮跳过。' };
    state.querying = true;
    try {
      return await tickInner(doSubmit);
    } finally {
      state.querying = false;
    }
  }

  /**
   * 执行一轮。
   * @param {boolean} doSubmit true=真提交；false=演练（只匹配不提交）
   */
  async function tickInner(doSubmit) {
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
    var choosedRows = lastChoosed.ok ? lastChoosed.rows : [];

    var results = [];
    for (var n = 0; n < list.length; n++) {
      var t = list[n];

      // 刚被拒过的目标先歇一会儿，别硬打把账号搞异常（别的目标不受影响）
      if (!targetReady(t)) {
        t.status = '冷却中，' + Math.ceil((t.cooldownUntil - Date.now()) / 1000) + 's 后重试';
        results.push({ target: t, status: 'cooling' });
        continue;
      }

      var course = first(got.courses, function (c) { return matchCourse(c, t); });

      if (!course) {
        t.failStreak = 0;
        t.status = '本轮列表里没有匹配的课程（共 ' + got.courses.length + ' 门）';
        results.push({ target: t, status: 'nomatch' });
        continue;
      }

      if (choosedKch[String(course.kch)]) {
        t.done = true;
        t.failStreak = 0;
        t.status = '已经选过了：' + course.kcmc;
        results.push({ target: t, status: 'already' });
        continue;
      }

      var u = await queryUsableClasses(course.kch_id);
      if (u.error) {
        bumpFail(t);
        t.status = '教学班查询失败：' + u.error;
        results.push({ target: t, status: 'error' });
        continue;
      }
      if (!u.classes.length) {
        // 名额满 / 批次没开 —— 这是正常等待，不算失败
        t.status = '服务端没下发可用令牌，下轮重试';
        results.push({ target: t, status: 'pending' });
        continue;
      }
      if (u.degraded) {
        t.status = '服务端未下发有效 do_jxb_id，已降级用 jxb_id（可能被拒）';
      }

      var pick = pickClassForTarget(u.classes, t, choosedRows);
      if (!pick.ok) {
        // 筛选条件不满足 / 都被你排除了 —— 也不算失败
        t.status = course.kcmc + '：' + pick.reason;
        results.push({ target: t, status: 'nofit' });
        continue;
      }

      var cls = pick.cls;
      var desc = course.kcmc + ' / ' + (teacherOf(cls) || '?') +
        ' / 剩余' + remainOf(cls) + '/' + (cls.jxbrl || '?') +
        ' / ' + describeSksj(cls.sksj);

      if (!doSubmit) {
        t.status = '演练：' + desc;
        results.push({ target: t, status: 'dry', desc: desc });
        continue;
      }

      // 换课：已经确认目标课有名额了，才去动保底课（把「退了保底却没抢到」的窗口压到最小）
      if (t.replaceKch && OPTS.autoDrop) {
        var okGo = await dropReplaceCourse(t);
        if (!okGo) {
          t.status = '换课中断：保底课没能退掉，本轮不提交目标课';
          results.push({ target: t, status: 'blocked' });
          cooldownTarget(t, OPTS.cooldownMs);
          continue;
        }
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

      // 服务端说冲突 → 自动退掉「可退选修课」再重提一次（默认关闭，开了才走）
      if (!res.ok && isConflictMsg(res) && OPTS.autoDrop) {
        var healed = await resolveConflict(cls, course);
        if (healed) {
          var u2 = await queryUsableClasses(course.kch_id);
          var pick2 = (u2.classes && u2.classes.length)
            ? pickClassForTarget(u2.classes, t, choosedRows)
            : { ok: false };
          if (pick2.ok) {
            log('冲突已清空，重提目标课…', 'd');
            res = await submitCourse(course.kch_id, course.kcmc, pick2.cls.do_jxb_id);
          }
        }
      }

      if (res.ok) {
        t.done = true;
        t.failStreak = 0;
        t.status = '抢到：' + desc;
        results.push({ target: t, status: 'success', desc: desc });
        lastChoosed.at = 0; // 强制下次重查已选
        beep(true);
        log('✔ 抢到了：' + desc, 's');
      } else {
        bumpFail(t);
        t.status = '提交被拒 flag=' + res.flag + ' ' +
          ((res.data && res.data.msg) || JSON.stringify(res.data || {}).slice(0, 120)) + '　' + desc;
        results.push({ target: t, status: 'rejected' });
        cooldownTarget(t, OPTS.cooldownMs);
        if (isConflictMsg(res)) beep(false);
      }
    }
    return { results: results, note: null };
  }

  /** 抢到/被拒时响一声。用 WebAudio 现场合成，不依赖任何文件，也不需要额外权限。 */
  var audioCtx = null;
  function beep(good) {
    if (OPTS.beep === false) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      var o = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = good ? 880 : 330;
      g.gain.value = 0.05;
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start();
      setTimeout(function () { try { o.stop(); } catch (e) { /* 忽略 */ } }, good ? 170 : 300);
    } catch (e) { /* 静音环境/无音频设备，忽略 */ }
  }

  /** 预览匹配：只跑匹配，不提交 */
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

  /**
   * 自检：只读，确认扩展能读到页面隐藏域、且同源请求携带登录态。
   * 里面那一步「查询参数体检」是给「按钮点不到 / 页面脚本没跑」这种情况准备的 ——
   * 它会说清楚缺哪个参数、能不能自动补，而不是含糊地报「没有课程」。
   */
  async function doSelfTest() {
    log('—— 自检（全部只读，不会提交任何东西）——', 'd');

    // ① 参数体检（这是「不点按钮也能查」的前提）
    var rep = await ensureParamsReady(true);
    if (rep.ok) {
      var brief = [];
      for (var r = 0; r < rep.rows.length; r++) {
        brief.push(rep.rows[r].id + '(' + (rep.rows[r].src || '?') + ')');
      }
      log('✔ 查询参数就绪：' + brief.join('  '), 's');
      log('  来源 dom=页面字段 / server=扩展自补 / first* =服务器默认值字段', 'd');
    } else {
      log('✘ 查询参数缺：' + rep.missing.join('、') + ' —— **不点页面「查询」按钮也可能查不到课**。', 'e');
    }

    var c = readCtx();
    if (!c.xkkz_id) {
      log('✘ 读不到 xkkz_id：当前可能不在选课开放期，或不是选课页。', 'e');
    } else {
      log('✔ 页面上下文可读：xkkz_id=' + c.xkkz_id.slice(0, 12) + '… 类别=' + (c.kklxmc || c.kklxdm) + ' 轮次=' + c.xklc, 's');
    }

    try {
      // 这一步就是「查询」按钮背后的那个接口。我们是直接打它，**不模拟点击、不需要按钮** ——
      // 所以按钮被遮住、在移动端视口外、或者页面脚本挂了，都不影响抢课。
      var q = await queryCourses(1, { verbose: true });
      if (!q.ok) {
        log('✘ 课程列表查询失败：' + q.reason, 'e');
        if (/返回 0|非法访问/.test(String(q.reason))) {
          log('  → 这通常是登录态没带上。请确认是在教务系统里已登录的选课页操作；仍失败请刷新页面。', 'w');
        } else if (/参数/.test(String(q.reason))) {
          log('  → 参数没就绪，多半是本页脚本没跑完。刷新一次选课页通常即可。', 'w');
        }
      } else {
        var names = [];
        var arr = q.courses || [];
        for (var i = 0; i < Math.min(arr.length, 6); i++) names.push(arr[i].kcmc);
        log('✔ 课程列表可读（直连接口，未使用页面按钮）：本页 ' + arr.length + ' 门' +
          (names.length ? '（' + names.join('、') + (arr.length > names.length ? '…' : '') + '）' : ''), 's');
      }
    } catch (e) {
      log('✘ 课程列表请求异常：' + e.message, 'e');
    }

    try {
      var ch = await queryChoosed();
      if (ch.ok) {
        lastChoosed = { ok: true, rows: ch.rows || [], at: Date.now() };
        log('✔ 已选列表可读：共 ' + ch.rows.length + ' 门', 's');
        // 顺带标出哪些是「可退选修课」——自动退选只会动这一类
        var dropList = [], keepN = 0;
        for (var z = 0; z < ch.rows.length; z++) {
          if (isDroppable(ch.rows[z])) dropList.push(ch.rows[z].kcmc || '?');
          else keepN++;
        }
        if (ch.rows.length) {
          log('  可自动退选的选修课 ' + dropList.length + ' 门' +
            (dropList.length ? '（' + dropList.join('、') + '）' : '') +
            '；必修/不可退 ' + keepN + ' 门（这类永远不会被自动退）。', 'd');
        }
      } else log('✘ 已选列表查询失败：' + ch.reason, 'e');
    } catch (e) {
      log('✘ 已选列表请求异常：' + e.message, 'e');
    }

    log('自检结束。上面都是 ✔ 就说明扩展工作正常（含「不点按钮也能查课」）。', 's');
  }

  var START_LABEL = '开始抢课';

  function setRunning(on) {
    state.running = on;
    el.start.disabled = on;
    el.once.disabled = on;
    el.preview.disabled = on;
    el.quick.disabled = on;
    el.stop.disabled = !on;
    if (!on) el.start.textContent = START_LABEL;
  }

  function waitMs() {
    var base = Math.max(400, Number(el.iv.value) || OPTS.interval);
    var jit = Math.max(0, Number(el.jt.value) || 0);
    return base + (jit ? Math.floor(Math.random() * jit) : 0);
  }

  /** 把「定时开抢」的输入解析成时间戳。空 / 解析不出 → 0（= 立即开始） */
  function parseStartAt() {
    var s = String(OPTS.startAt || '').trim();
    if (!s) return 0;
    // datetime-local 给的是 'YYYY-MM-DDTHH:MM'；手写 'YYYY-MM-DD HH:MM:SS' 也认
    var ms = Date.parse(s.replace(' ', 'T'));
    return isNaN(ms) ? 0 : ms;
  }

  /** 毫秒 → '1小时23分45秒' 这种给人看的形式 */
  function fmtCountdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + '小时' : '') + (m || h ? m + '分' : '') + sec + '秒';
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
    for (var i = 0; i < targets.length; i++) {
      targets[i].status = '';
      targets[i].failStreak = 0;
      targets[i].cooldownUntil = 0;
    }
    refreshTargetStatus();

    log('开始抢课：' + activeTargets().length + ' 个目标，间隔约 ' + waitMs() + 'ms，' +
      (OPTS.dryRun ? '【仅演练·不会提交】' : '【正式模式·会真实占位】'), OPTS.dryRun ? 's' : 'w');
    if (OPTS.autoDrop) {
      log('⚠ 已开启「冲突时自动退可退选修课」：只会退 kklxdm=10 且 rwlx=2 的课，必修绝不动。', 'w');
    }

    // 定时开抢：没到点就只倒数，**一个请求都不发**（早发请求只是在替别人热身）
    var startAt = parseStartAt();
    if (startAt && Date.now() < startAt) {
      log('已设定时开抢：' + new Date(startAt).toLocaleString() + '。等待中，期间不发任何请求。', 's');
      var lastLog = 0;
      while (state.running && Date.now() < startAt) {
        var left = startAt - Date.now();
        el.start.textContent = '⏳ ' + fmtCountdown(left);
        if (Date.now() - lastLog > 10000) {
          log('距开抢还有 ' + fmtCountdown(left), 'd');
          lastLog = Date.now();
        }
        await sleep(Math.max(200, Math.min(1000, left)));
      }
      el.start.textContent = START_LABEL;
      if (!state.running) { setRunning(false); return; }
      log('⏰ 时间到，开始抢课。', 's');
    }

    while (state.running) {
      state.rounds++;
      var r;
      try { r = await tick(!OPTS.dryRun); }
      catch (e) {
        if (e && e.code === 'SESSION_LOST') {
          // 掉登录态了：交给重登流程（它可能会跳走，也可能只是记一条日志）
          state.running = false;
          await onSessionLost(e.detail);
          break;
        }
        r = { results: [], note: '异常：' + e.message };
      }

      if (r.note) log('第' + state.rounds + '轮 ' + r.note, 'e');
      else {
        var parts = [];
        for (var k = 0; k < r.results.length; k++) {
          var x = r.results[k];
          parts.push((x.target.name || x.target.kch) + '=' + x.status);
        }
        var sad = false, done = false;
        for (var m = 0; m < r.results.length; m++) {
          var stt = r.results[m].status;
          if (stt === 'success' || stt === 'dry' || stt === 'already') done = true;
          if (stt === 'error' || stt === 'rejected' || stt === 'conflict' || stt === 'blocked') sad = true;
        }
        var slow = state.rounds === 1 || state.rounds % 10 === 0;
        if (done || sad || slow) {
          log('第' + state.rounds + '轮 ' + parts.join('　|　'), done ? 's' : sad ? 'e' : 'd');
        }
      }
      refreshTargetStatus();

      // 连续失败熔断：所有还活着的目标都连续失败 N 轮 → 停下来，别硬打把账号搞异常
      if (OPTS.maxFailStreak > 0) {
        var act = activeTargets();
        var allBad = act.length > 0;
        for (var z = 0; z < act.length; z++) {
          if ((Number(act[z].failStreak) || 0) < OPTS.maxFailStreak) allBad = false;
        }
        if (allBad) {
          log('✘ 所有目标已连续失败 ' + OPTS.maxFailStreak + ' 轮，自动暂停（防把账号打异常）。', 'e');
          log('  → 先点「自检」看接口通不通、选课是否已开放，处理完再重新开始。', 'w');
          beep(false);
          break;
        }
      }

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

  el.selftest.addEventListener('click', function () { doSelfTest(); });

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

  ['iv', 'jt', 'mr', 'dry', 'pre', 'skip', 'gotoMode'].forEach(function (k) {
    el[k].addEventListener('change', syncUIToOpts);
  });

  // ---- 账号区 ----

  el.user.addEventListener('input', function () { CRED.user = el.user.value.trim(); CRED.loaded = true; saveCredDebounced(); updateCredHint(); });
  el.pass.addEventListener('input', function () { CRED.pass = el.pass.value; CRED.loaded = true; saveCredDebounced(); updateCredHint(); });
  el.remember.addEventListener('change', function () { CRED.remember = el.remember.checked; saveCred(); updateCredHint(); });
  el.relogin.addEventListener('change', function () { CRED.autoRelogin = el.relogin.checked; saveCred(); updateCredHint(); });

  el.pwshow.addEventListener('click', function () {
    var showing = el.pass.type === 'text';
    el.pass.type = showing ? 'password' : 'text';
    el.pwshow.textContent = showing ? '显示' : '隐藏';
  });

  el.logout.addEventListener('click', async function () {
    await clearCred();
    syncCredToUI();
    clearLoginFails();
    log('已清除保存的账号密码（含持久保存的那份）。', 'w');
  });

  /**
   * 「保存并登录」。
   * 已经登录着就只保存、不重复登录 —— 正方一个账号一般只允许一个会话，
   * 无谓地再登一次可能把当前页的会话顶掉，反而添乱。
   */
  el.login.addEventListener('click', async function () {
    if (state.busy || state.running) { log('先停止抢课再操作登录。', 'w'); return; }

    CRED.user = el.user.value.trim();
    CRED.pass = el.pass.value;
    CRED.remember = el.remember.checked;
    CRED.autoRelogin = el.relogin.checked;
    await saveCred();
    updateCredHint();

    if (!CRED.user || !CRED.pass) { log('账号和密码都要填。', 'e'); return; }

    el.login.disabled = true;
    try {
      var alive = await checkSession();
      if (alive === true) {
        log('当前登录态正常，账号密码已保存。掉线时会自动重登。', 's');
        return;
      }
      if (alive === null) { log('探测登录态失败（网络问题？），先不登录了。', 'e'); return; }

      log('登录态已失效，正在登录…', 'w');
      var r = await doLogin(CRED.user, CRED.pass);
      if (r.ok) {
        clearLoginFails();
        log('登录成功，账号密码已保存。正在进入选课页…', 's');
        await sleep(400);
        location.href = resolveSelectUrl();
        return;
      }
      bumpLoginFails();
      log('登录失败：' + r.error, 'e');
    } catch (e) {
      log('登录异常：' + e.message, 'e');
    } finally {
      el.login.disabled = false;
    }
  });

  // 扩展弹窗（popup）通过这个通道和面板通信
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg) return;
      if (msg.cmd === 'ping') {
        sendResponse({
          ok: true, version: VERSION, running: state.running,
          targets: targets.length, dryRun: !!OPTS.dryRun,
          reloginArmed: CRED.autoRelogin !== false && !!CRED.user && !!CRED.pass,
          user: CRED.user || '',
        });
      } else if (msg.cmd === 'toggle') {
        el.panel.classList.toggle('min');
        sendResponse({ ok: true, minimized: el.panel.classList.contains('min') });
      }
    });
  }

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
    pageState: PAGE_STATE,
    // 手动跳一次：__XK_HELPER__.gotoSelectPage()
    gotoSelectPage: function () { gotoSelect(resolveSelectUrl()); },
    // 登录相关：__XK_HELPER__.cred() / .login() / .checkSession()
    cred: function () {
      // 不给控制台直接看密码，只回报有没有
      return { user: CRED.user, hasPass: !!CRED.pass, remember: !!CRED.remember, autoRelogin: CRED.autoRelogin !== false };
    },
    login: function (u, p) {
      // 显式传参时只用于临时测试，不落盘
      return doLogin(u || CRED.user, p || CRED.pass);
    },
    checkSession: checkSession,
    clearCred: clearCred,
    // 查询参数层（「不点按钮也能查」）：__XK_HELPER__.params() / .harvest()
    params: function () { return paramReport(); },
    paramsSource: function () { return CTX_OVERRIDE; },
    harvest: harvestServerCtx,
    ensureParams: ensureParamsReady,
    queryCourses: queryCourses,
    queryClasses: queryClasses,
    queryUsableClasses: queryUsableClasses,
    queryChoosed: queryChoosed,
    checkConflict: checkConflict,
    submitCourse: submitCourse,
    submitQuick: submitQuick,
    // 退选 / 换课（危险操作，控制台里手动用）：
    //   __XK_HELPER__.dropCourse('<kch_id>', '<do_jxb_id>')
    //   __XK_HELPER__.isDroppable({kklxdm:'10', rwlx:'2'})  → true
    dropCourse: dropCourse,
    isDroppable: isDroppable,
    // 上课时间解析（纯函数，随便试）：
    //   __XK_HELPER__.parseSchedule('星期一第1-2节{1-16周}')
    parseSchedule: parseSchedule,
    parseWeeks: parseWeeks,
    schedulesOverlap: schedulesOverlap,
    // 预览：某门课的时间与已选课是否冲突
    //   await __XK_HELPER__.conflictOf({sksj:'星期一第1-2节{1-16周}'})
    conflictOf: async function (cls) {
      await refreshChoosed();
      var segs = parseSchedule(cls && cls.sksj);
      var out = [];
      if (lastChoosed.ok) {
        for (var i = 0; i < lastChoosed.rows.length; i++) {
          var r = lastChoosed.rows[i];
          if (r && schedulesOverlap(segs, parseSchedule(r.sksj))) out.push(r.kcmc + '(可退:' + (isDroppable(r) ? '是' : '否') + ')');
        }
      }
      return { parsed: segs, overlaps: out, choosedReadable: lastChoosed.ok };
    },
    beep: beep,
    tick: tick,
    preview: doPreview,
    selfTest: doSelfTest,
    render: renderTargets,
    // 快捷：__XK_HELPER__.setTargets(['篮球','羽毛球'])
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

  // 先用默认值渲染一次（保证即使存储读失败，面板也是可用的），再异步套用已存配置
  targets.length = 0;
  targets.push(newTarget(''));
  syncOptsToUI();
  syncCredToUI();
  renderTargets();
  describeContext();
  log('助手已就绪（v' + VERSION + '）。', 's');
  log('流程：填课程名 → 预览匹配 → 确认教学班对了 → 取消「仅演练」→ 开始抢课。', 'd');

  storeGet().then(function (o) {
    if (applyCfg(o)) {
      syncOptsToUI();
      renderTargets();
      log('已读取本机保存的配置：' + targets.length + ' 个目标。', 's');
    }
  }).catch(function () { /* 读不到就用默认 */ });

  loadCred().then(function () {
    syncCredToUI();
    if (CRED.user && CRED.pass) {
      log('已读取账号（' + CRED.user + '）：掉线自动重登' +
        (CRED.autoRelogin === false ? '已关闭。' : '已就绪。'), 'd');
    }
  }).catch(function () { /* 读不到就不显示 */ });

  // 面板一出现就做一次只读连通性探测 —— 让「扩展能不能读到这个站的数据」
  // 在用户点任何按钮之前就暴露出来，而不是等点了「预览匹配」才发现不对。
  // 顺带：如果是「掉线 → 重登 → 被送回来」这条路径，探测完就自动接着抢。
  setTimeout(function () {
    queryCourses(1, { verbose: true }).then(function (q) {
      if (q.ok) log('接口连通正常（本页可选 ' + q.courses.length + ' 门课）。', 'd');
      else {
        log('接口探测失败：' + q.reason, 'e');
        if (/参数/.test(String(q.reason))) {
          log('→ 页面脚本没把查询参数准备好。已尝试自动从服务器补齐；仍失败请刷新本页。', 'w');
        } else {
          log('→ 若提示「非法访问 / 返回 0」，一般是登录态问题：刷新页面或重新登录后再试。', 'w');
        }
      }
    }).catch(function (e) {
      if (e && e.code === 'SESSION_LOST') {
        log('接口探测发现登录态已失效。', 'e');
        onSessionLost('页面初始化探测');
        return;
      }
      log('接口探测异常：' + e.message, 'e');
    }).then(function () {
      // 无论是刚重登回来，都看一下要不要续抢
      setTimeout(maybeResumeAfterRelogin, 400);
    });
  }, 900);

  // 隐藏域是随页面动态生成的，稍后再读一次上下文
  setTimeout(describeContext, 2500);
  setInterval(function () {
    if (state.running) return;
    if (readCtx().iskxk !== H('iskxk')) describeContext();
  }, 10000);
})();
