// lib/http.mjs —— 极简带 Cookie 会话的 HTTP 客户端（零依赖，基于 Node 内置 fetch）
//
// 为什么不用 redirect:'follow'：教务系统登录成功后是 302 跳转，而跳转响应里带的
// 新 JSESSIONID 只有在手动处理重定向时才能读到（follow 模式下中间响应头拿不到）。

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export class Session {
  constructor(baseUrl, opts = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.cookies = new Map();
    this.ua = opts.userAgent || DEFAULT_UA;
    this.timeoutMs = opts.timeoutMs || 20000;
    this.requestCount = 0;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') {
      list = res.headers.getSetCookie();
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    for (const line of list) {
      const seg = String(line).split(';')[0];
      const eq = seg.indexOf('=');
      if (eq < 0) continue;
      const name = seg.slice(0, eq).trim();
      let value = seg.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line);
      if (!value || expired) {
        this.cookies.delete(name);
        continue;
      }
      if (/^".*"$/.test(value)) value = value.slice(1, -1);
      this.cookies.set(name, value);
    }
  }

  async fetch(pathOrUrl, { method = 'GET', form, headers = {}, follow = true, maxRedirects = 6 } = {}) {
    let url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : this.baseUrl + pathOrUrl;
    let m = method;
    let body =
      form === undefined
        ? undefined
        : form instanceof URLSearchParams
          ? form.toString()
          : new URLSearchParams(form).toString();

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const h = { 'User-Agent': this.ua, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers };
      if (body !== undefined) {
        h['Content-Type'] = h['Content-Type'] || 'application/x-www-form-urlencoded;charset=utf-8';
      }
      const ck = this.cookieHeader();
      if (ck) h['Cookie'] = ck;

      this.requestCount++;
      const res = await fetch(url, {
        method: m,
        headers: h,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      this.absorb(res);

      const loc = res.headers.get('location');
      if (follow && loc && res.status >= 300 && res.status < 400) {
        try {
          await res.body?.cancel();
        } catch {
          /* ignore */
        }
        url = new URL(loc, url).toString();
        m = 'GET';
        body = undefined;
        continue;
      }
      return res;
    }
    throw new Error('重定向次数过多: ' + pathOrUrl);
  }

  async get(path, opts = {}) {
    const res = await this.fetch(path, { ...opts, method: 'GET' });
    return { res, status: res.status, url: res.url, text: await res.text() };
  }

  async post(path, form, opts = {}) {
    const res = await this.fetch(path, { ...opts, method: 'POST', form });
    return { res, status: res.status, url: res.url, text: await res.text() };
  }

  /** POST 并解析 JSON；解析失败时 data=null、raw 保留原文，方便排查 */
  async postJson(path, form, opts = {}) {
    const out = await this.post(path, form, {
      ...opts,
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        ...(opts.headers || {}),
      },
    });
    const raw = (out.text || '').trim();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* 非 JSON，保持 null */
    }
    return { ...out, data, raw };
  }

  pathname(url) {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 带抖动的等待，避免固定频率被风控识别 */
export function jitterSleep(baseMs, jitterMs) {
  const extra = jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0;
  return sleep(baseMs + extra);
}
