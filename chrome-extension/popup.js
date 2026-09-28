/**
 * 弹窗逻辑。
 *
 * 刻意只依赖 chrome.tabs 的「消息通道」，不读 tab.url、不申请 tabs / activeTab 权限，
 * 这样安装时除了 "storage" 不会有任何权限提示。
 *
 * 判断「当前是不是选课页」的方式很朴素：给当前标签发一条 ping。
 * 内容脚本在非选课页也会应答（pageState 会告诉我们是哪种情况），所以三种结果都能分辨：
 *   ok:true                  → 已经在选课页，面板可用
 *   ok:false + pageState    → 在正方其它页（可一键过去）/ 别的页面
 *   连不上（抛错）           → 内容脚本没注入，基本就是没打开教务系统
 */

'use strict';

var statusEl, toggleBtn, gotoBtn;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function activeTabId() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0].id : null;
}

async function detect() {
  toggleBtn.disabled = true;
  gotoBtn.hidden = true;
  setStatus('检测中…');

  var id = await activeTabId();
  if (id == null) { setStatus('拿不到当前标签页。', 'err'); return; }

  var r;
  try {
    r = await chrome.tabs.sendMessage(id, { cmd: 'ping' });
  } catch (e) {
    setStatus('当前标签页里没有内容脚本。\n\n请先打开教务系统（zf.gdep.edu.cn）。', 'warn');
    return;
  }

  if (r && r.ok) {
    var lines = [
      '面板已注入　v' + r.version,
      '状态：' + (r.running ? '正在轮询' : '空闲') + '　　目标 ' + r.targets + ' 个',
      '演练模式：' + (r.dryRun ? '开（匹配到也不会提交）' : '关（会真实占位）'),
      '掉线重登：' + (r.reloginArmed ? '已就绪' + (r.user ? '（' + r.user + '）' : '') : '未就绪'),
    ];
    var warn = !r.dryRun || !r.reloginArmed;
    setStatus(lines.join('\n'), warn ? 'warn' : 'ok');
    toggleBtn.disabled = false;
    return;
  }

  if (r && r.onLoginPage) {
    setStatus('这是教务系统的登录页。\n在页面里登录后，会自动被送到「自主选课」。', 'warn');
    return;
  }

  if (r && r.canGoto) {
    setStatus('你正在教务系统里，但不在「自主选课」页面。\n点下面的按钮过去，面板就会出现。', 'warn');
    gotoBtn.hidden = false;
    return;
  }

  if (r && r.pageState) {
    setStatus('这个页面不是正方教务的页面，没有可以跳转的选课入口。', 'warn');
    return;
  }

  setStatus('面板没有响应，刷新页面后再试。', 'err');
}

function bind() {
  statusEl = document.getElementById('status');
  toggleBtn = document.getElementById('toggle');
  gotoBtn = document.getElementById('goto');

  document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;

  toggleBtn.addEventListener('click', async function () {
    var id = await activeTabId();
    if (id == null) return;
    try {
      await chrome.tabs.sendMessage(id, { cmd: 'toggle' });
      window.close();
    } catch (e) {
      setStatus('操作失败：' + e.message, 'err');
    }
  });

  gotoBtn.addEventListener('click', async function () {
    var id = await activeTabId();
    if (id == null) return;
    try {
      await chrome.tabs.sendMessage(id, { cmd: 'goto' });
      window.close();
    } catch (e) {
      setStatus('跳转失败：' + e.message, 'err');
    }
  });

  document.getElementById('redetect').addEventListener('click', detect);

  detect();
}

// popup.js 在 </body> 前同步加载，DOM 已经就绪，直接跑
bind();
