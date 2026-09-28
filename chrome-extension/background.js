/**
 * 后台脚本（MV3 service worker）。
 *
 * ⚠️ 这里**不发任何网络请求**。所有业务请求都在内容脚本里发 ——
 *    相对路径 → 页面源 → 同源 → 自动带上你已登录的 JSESSIONID。
 *    挪到后台来发就变成跨站请求，SameSite=Lax 的会话 Cookie 不会带上，必然失败。
 *
 * 它只做一件事：把 `chrome.storage.session` 的访问级别放开给内容脚本。
 * 为什么需要：
 *   · 账号密码默认存在 `chrome.storage.session` 里 —— 那是**内存**，浏览器一关就没，
 *     而且网页 JS 读不到（页面的 localStorage/sessionStorage 是能被站点读的，绝不能放那儿）。
 *   · 但 `storage.session` 默认只有扩展自身的页面/后台能访问，内容脚本会被拒绝。
 *     必须由后台调一次 `setAccessLevel` 才行 —— 这就是本文件存在的唯一理由。
 */
'use strict';

function openSessionStorage() {
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  } catch (e) {
    // 老版本 Chrome 没有 storage.session，内容脚本会自动退回 storage.local
  }
}

// service worker 每次被唤醒都要重新设置（访问级别不跨唤醒持久化）
openSessionStorage();
chrome.runtime.onStartup.addListener(openSessionStorage);
chrome.runtime.onInstalled.addListener(openSessionStorage);

// 内容脚本发现读不到 storage.session 时会发这条消息来「叫醒」后台，然后再重试一次
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;
  if (msg.cmd === 'enable-session-storage') {
    openSessionStorage();
    sendResponse({ ok: true });
  }
});
