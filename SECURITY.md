# 安全策略

## 报告漏洞

**请不要开公开 issue。** 用 GitHub 的私密漏洞报告：

> **Security 页 → Report a vulnerability**
> <https://github.com/SamBUFF/gdep-xuanke-helper/security/advisories/new>

请附上：受影响的版本、复现步骤、影响面，以及你想到的修复方向。
这是个人项目，不承诺响应时限，但会尽快看。

## 支持范围

只维护 `main` 分支上的最新代码。当前扩展版本 **v2.5.0**。

---

## 威胁模型

这个工具跑在你**已登录的教务系统页面**里，所以只需要回答三个问题：

1. **它会把我账号里的东西发给谁？** —— 谁都不发。见下。
2. **别人能不能通过它拿到我的凭据？** —— 涉及到它把密码存在哪。
3. **它会不会做不可逆的操作？** —— 只有「退课」，且默认关闭。

### 它会联系哪些服务器

**不连任何第三方。** 已核对：`chrome-extension/` 里**没有一条硬编码的外部 URL**，
只有 4 处 `fetch` 和 1 处 `XMLHttpRequest`，目标全是**相对路径**，例如：

```js
// 扩展内容脚本里，相对 URL 按页面源解析，same-origin 即等同于页面自身发请求
var res = await fetch(path, { credentials: 'same-origin', ... });
```

也就是说所有流量都发往你自己的教务站点，且复用浏览器已有的会话 Cookie。
没有埋点、没有遥测、没有更新检查、没有 CDN。

> CLI 版（`gdep-grab/`）的 `https://zf.gdep.edu.cn` 只是 `config.json` 里可改的默认 `baseUrl`。

### 权限面

`manifest.json` 只声明了：

| 项 | 值 | 为什么够用 |
|---|---|---|
| `permissions` | `["storage"]` | 存目标列表；勾了「记住密码」才存凭据 |
| `content_scripts.matches` | `*://*/xsxk/*`、`*://*/xtgl/*` | 选课页 + 登录落地的主菜单页，缺后者「登录后自动跳转」就失效 |
| `all_frames` | `false` | 只注入顶层文档 |
| `run_at` | `document_idle` | 等页面自己的脚本先跑 |

**没有** `host_permissions`、`tabs`、`cookies`、`webRequest`、`scripting`、`<all_urls>`。
主机名用 `*` 是设计意图（不绑学校），但路径被限制在上述两个前缀内。

这一条由 [`check-permissions.py`](chrome-extension/tools/check-permissions.py) 守着，
CI 里每次提交都会跑；权限一旦被放宽就会红。

### 凭据怎么存

`content.js` 的 `saveCred()` 逻辑：

| 情况 | 落到哪 | 生命周期 |
|---|---|---|
| 默认（未勾「记住密码」） | `chrome.storage.session` | **仅内存**，关掉浏览器就没了 |
| 勾了「记住密码」 | `chrome.storage.local` | 持久化，**明文** |
| 取消勾选时 | 主动 `chrome.storage.local.remove()` | 立即删除 |

- 密码**不会进入任何日志**。已核对：全部 `log()` / `console.*` 调用点没有一个引用密码值
  （唯一的命中是一句「账号和密码都要填」的提示文案）。
- 密码框是 `autocomplete="new-password"`，避免被浏览器密码管理器接管。
- **本项目不会把凭据发到任何地方** —— 它只在检测到掉线时，用这份凭据往你自己的教务站点重新登录。

### 注入与 XSS

面板里的课程名、教学班信息、上课时间都来自**服务端返回**，所以渲染路径值得看一眼。已核对：

- 全站有 5 处 `innerHTML` / `insertAdjacentHTML` 汇聚点，**每一处都套了 `esc()`**
  （`esc()` 转义 `& < > " '`）；
- 结构性渲染一律 `document.createElement()` + `textContent`，不走字符串拼 HTML；
- 站点本身改写了 `Array.prototype.filter` / `.some` 的回调参数顺序，
  所以本项目用自实现的 `where()`，一次都不调用被改写的方法。

### 不可逆操作

只有一个：**退课**。规则写死在 `isDroppable()` 里：

> 只有同时满足 `kklxdm === '10'`（通识选修）且 `rwlx === '2'` 的课才允许被自动退掉，其余只告警。

并且整套功能挂在 `OPTS.autoDrop` 下，**默认 `false`**。
CI 里有一条静态断言专门守这两个事实（`verify-pack.py` 的 `[9]` 组）。

---

## 已知风险

这些是**已知且当前不打算"修"掉**的，写出来是为了让你自己判断要不要用：

| 风险 | 实际情况 | 缓解 |
|---|---|---|
| 密码明文落盘 | 勾了「记住密码」后是 `chrome.storage.local` 里的明文，没有加密 | 不勾就只在内存里；公用电脑务必别勾 |
| 自动重登可能触发账号锁定 | 部分教务有失败次数锁定策略 | 只在检测到掉线时触发，且**失败不自动重试**；10 分钟内上限 3 次 |
| 自动退课不可逆 | 退错了没法撤销 | 默认关闭 + 上面的铁律；建议先开「仅演练」跑一遍 |
| 请求频率被风控 | 教务会记录 IP 与请求频次 | 默认轮询 1200ms、每轮 1~2 个列表查询，已刻意克制。**请不要调低** |
| 用脚本抢课可能违反校规 | 各校定性不同，部分院校会取消选课结果 | 自己评估，**风险自负** |
| AI 参与的代码 | 见下节 | 关键安全逻辑都有静态断言与单测守着；欢迎自行审计 |

---

## 关于 AI 参与本项目的说明

本项目的代码**由 AI 编程助手生成**，作者负责提出需求、做取舍与验收：

| 项 | 值 |
|---|---|
| 编程助手 | **WorkBuddy** |
| 底层模型 | **DeepSeek-V4.1-Flash** |
| 参与范围 | 全部源码（扩展、CLI、UserScript）、测试、打包脚本、文档、CI 配置 |
| 人类参与 | 需求定义、真机实测、参数逆向的验证、安全取舍的最终决定 |

**这对安全意味着什么（请认真对待）**：

- AI 生成的代码**可能存在作者也没意识到的缺陷**。不要因为它"看起来专业"就默认它安全。
- 真正兜底的是**可复现的检查**，而不是"AI 说它没问题"。所以本项目的关键安全性质
  都尽量落成可执行的断言，而不是文档里的承诺：

  ```bash
  python tools/check-secrets.py                              # 没有凭据入库
  cd chrome-extension/tools
  python check-permissions.py                                # 权限面没被扩大
  python run-node.py test-content.mjs                        # 171 条，含退选铁律
  python verify-pack.py                                      # 117 项，含 autoDrop 默认 false
  ```

- CI（[`quality.yml`](.github/workflows/quality.yml) / [`security.yml`](.github/workflows/security.yml)）
  每次提交都会跑上面这些。绿灯不等于安全，但至少这些性质**被机器守着**。
- 如果你要把它用在自己学校，**请先读一遍 `content.js`**，特别是 `submitQuick()` 和
  `resolveConflict()` 这两个会写数据的函数。

---

## GitHub 侧的安全能力

本仓库是**公开仓库**，因此 GitHub 的 Advanced Security 功能都是免费的，已经接上：

| 能力 | 状态 | 位置 |
|---|---|---|
| Code scanning（CodeQL） | ✅ 已启用 | [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml)，用 `security-and-quality` 查询套件 |
| Code quality 查询 | ✅ 同上 | CodeQL 的 quality 查询与安全查询一起跑 |
| Secret scanning + Push protection | ✅ 已启用 | 仓库 Settings → Code security |
| Dependabot alerts | ✅ 已启用 | 本项目零依赖，仅用于跟进 Actions 版本 |
| Security policy | ✅ 本文件 | Security 页 → Reporting |
| 私密漏洞报告 | ✅ 已启用 | 见本文开头 |

> 补充说明：仓库最初是私有的，那时 Security 页显示
> *「Advanced Security is only available for Organizations」*——
> 即 CodeQL / Secret Protection 对个人账号的**私有**仓库不开放。转为 Public 后才可用。

### 自建的两道防线

即便有了 CodeQL，下面两件事仍然由仓库自己的脚本守着（因为它们是**本项目的具体约定**，
通用扫描器不知道）：

| 守什么 | 脚本 |
|---|---|
| 私钥 / 凭据 / 真实学号不得入库 | [`tools/check-secrets.py`](tools/check-secrets.py) |
| 扩展权限面不得扩大、注入路径不得放宽 | [`chrome-extension/tools/check-permissions.py`](chrome-extension/tools/check-permissions.py) |
| 自动退课默认关闭、只退通识选修 | [`chrome-extension/tools/verify-pack.py`](chrome-extension/tools/verify-pack.py) 的 `[9]` 组 |
