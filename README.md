# 正方教务 · 通用选课助手

面向**正方教务系统**（`zftal-ui-v5` / V-9.0，服务器渲染 + jQuery）的自主选课工具。

在广东工程职业技术学院 `zf.gdep.edu.cn` 上逆向 + 实测开发，但**不绑学校、不绑课程、不绑轮次** —— 只要对方跑的是正方教务，同一套接口与参数逻辑就能直接用（见 [通用性](#通用性怎么保证)）。

仓库里有两套形态，**二选一即可**：

| 形态 | 目录 | 特点 |
|---|---|---|
| **Chrome 扩展**（推荐） | [`chrome-extension/`](chrome-extension/) | Manifest V3。跑在**隔离世界**里，天然免疫正方对 `Array.prototype` 的改写；装上就不用管了 |
| **命令行版** | [`gdep-grab/`](gdep-grab/) | **零依赖** Node 脚本，适合无人值守 / 多账号。同目录还有一份可贴进控制台的 UserScript 面板 |

> 扩展是主线（v2.5.0），功能最全。命令行版走的是完全独立的一条实现路径，两者不共享代码。

---

## ⚠️ 使用前必读

- 请只用**你自己的账号**，在你**自己的**教务系统里操作。
- 各校《学生手册》对「使用脚本/外挂抢课」的定性不同，部分院校认定为**违规**并会**取消选课结果**。**风险自负。**
- 教务系统会记录 IP 与请求频次。默认轮询间隔 1200ms、每轮只发 1~2 个列表查询，已经刻意克制 —— **请不要再调低，也不要无脑多开**。
- 抢课成功即占位，部分课程**无法退课**。**自动退课功能默认关闭**，开启前请先读懂[退选安全规则](#退选安全规则v250-的铁律)。
- 本项目仅供学习和自用，请勿用于代抢、倒卖等用途。

---

## 它解决了什么

这些坑都是实测踩出来的，不是设想出来的。

| 痛点 | 做法 |
|---|---|
| 页面上的「**查询**」按钮点不到（被浮层压住 / 在手机视口外 / 页面脚本压根没跑起来） | **直接 POST 课程列表接口**，全程不依赖那个按钮。按钮只在最后一层兜底 |
| 页面脚本没初始化 → 44 个查询参数里**有 29 个缺失** → 服务端**静默返回 0 门课**（HTTP 200、不报错） | 三层补参 + 查询前后**关键参数体检**，让「真的没课」和「参数没就绪」不再长得一模一样 |
| 抢课途中登录态掉了 | 检测到掉线后**自动用存好的账密重登**，跳回选课页接着抢（失败**不自动重试**，10 分钟上限 3 次，防锁号） |
| 想避开某几天 / 某几节 / 某几周 | 把 `sksj` 解析成**结构化课表**，支持按星期 / 节次 / 周次筛选与排除 |
| 怕和已选课撞车 | **本地预判冲突**（省一次服务端往返）；可选在冲突时自动退掉可退的课 |
| 想卡点开抢 | **定时开抢**：到点之前一个请求都不发 |
| 选错了想换一门 | **换课**：先退后抢，两步都做了失败回滚判断 |

---

## 目录结构

```
.
├── chrome-extension/          # ① Chrome MV3 扩展（主线，v2.5.0）
│   ├── manifest.json          #    permissions 只有 storage；key 固定了扩展 ID
│   ├── background.js          #    service worker —— 只做一件事：放开 session 存储给内容脚本
│   ├── rsa-pkcs1.js           #    手写 RSAES-PKCS1-v1_5（WebCrypto 只给了 OAEP，不够用）
│   ├── content.js             #    全部业务逻辑（~132 KB）
│   ├── popup.html / popup.js  #    工具栏弹窗
│   ├── icons/
│   ├── tools/                 #    自测 / 打包 / 语法体检，见「开发与自测」
│   └── README.md              #    扩展的详细文档（安装、参数坑、退选规则、排障）
│
└── gdep-grab/                 # ② 命令行版 + UserScript 面板
    ├── grab.mjs               #    主程序，零依赖，Node 18+
    ├── lib/zf.mjs             #    正方接口封装（登录 / 查询 / 提交）
    ├── lib/http.mjs           #    cookie jar + 重定向跟踪（没有任何三方库）
    ├── config.example.json    #    配置模板 —— 复制成 config.json 再填
    ├── zf-xk-helper.user.js   #    可贴进 DevTools 控制台的网页面板（v2.0.0）
    ├── panel-preview.png
    └── README.md              #    命令行的详细文档（CLI 参数、targets 匹配字段）
```

> `gdep-grab/README.md` 里的 UserScript 是 **v2.0.0**，落后于扩展的 v2.5.0：
> 它**没有**自动跳转、掉线自动重登、参数自补、星期/节次/周次筛选、定时开抢、换课。
> 要完整功能请用 Chrome 扩展。

---

## 快速开始 · Chrome 扩展

Chrome 出于安全**不允许安装非商店来源的 `.crx`**（稳定版会报 `CRX_REQUIRED_PROOF_MISSING`），只能「加载已解压的扩展程序」。**只需做一次**：

1. 地址栏打开 `chrome://extensions`
2. 打开右上角的 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择本仓库里的 `chrome-extension/`（有 `manifest.json` 的那一层）
5. 建议把它**固定到工具栏**（拼图图标 → 图钉）

装完去教务系统登录，你会被自动送到「自主选课」页面，右下角出现抢课面板。

**扩展 ID：`dbmnknondalhkjdciheojjdlkcaobfpf`**

ID 由 `manifest.json` 里的 `key` 决定，已写死 —— 同一份代码不管装在哪台机器，ID 都不变（`chrome.storage` 里的配置才不会断）。

> 改了代码之后：回 `chrome://extensions` 点扩展卡片上的 **↻ 重新加载**，再刷新页面即可，不用重新添加。

详细文档见 [`chrome-extension/README.md`](chrome-extension/README.md)。

---

## 快速开始 · 命令行

```bash
cd gdep-grab

# 1. 填账号
cp config.example.json config.json     # 然后把 password 填上
                                       # （或用 passwordEnv 从环境变量读，避免明文落盘）

# 2. 先看有什么课可选 —— 最安全，不提交任何东西
node grab.mjs --list

# 3. 演练完整流程，但不真正提交
node grab.mjs --dry-run

# 4. 正式抢
node grab.mjs
```

常用参数：

```bash
node grab.mjs --account 大号 --course 篮球 --course 羽毛球   # 只跑指定账号 / 指定课
node grab.mjs --confirm                                     # 每次真提交前人工确认
node grab.mjs --interval 2000 --max-attempts 100            # 调频率 / 限轮数
```

完整 CLI 参数与 `targets` 匹配字段见 [`gdep-grab/README.md`](gdep-grab/README.md)。

---

## 环境要求

| | 要求 |
|---|---|
| Chrome 扩展 | Chrome / Edge 等 Chromium 系浏览器，支持 Manifest V3（Chrome 88+） |
| 命令行版 | **Node 18+**（推荐 20 / 22）。**零三方依赖**，不需要 `npm install` |
| 开发自测 | Python 3.8+（仅 `tools/` 下的辅助脚本用，非运行必需） |

---

## 开发与自测

所有测试**都不需要开浏览器** —— 用切片把 `content.js` 里的纯函数抽出来跑。

```bash
cd chrome-extension/tools

# 语法体检：rsa-pkcs1.js / content.js / popup.js / background.js / manifest.json
python check-syntax.py

# 离线单测
python run-node.py test-content.mjs      # 判定 / 跳转 / 参数层 / 登录解析 / 时间解析 / 退选规则 —— 171 条
python run-node.py test-rsa.mjs          # 纯 JS RSA 往返正确性 —— 47 条
python run-node.py test-login-flow.mjs   # doLogin 端到端（假 fetch）—— 30 条

# 重新打包（内含魔数 / CRX 版本 / RSA 验签 / ZIP 偏移自检）
python run-node.py pack-crx.mjs

# 独立复验：用 Python 的 zipfile 交叉验证刚才打出来的包 —— 117 项
python verify-pack.py
```

当前状态：**171 + 47 + 30 + 117 全绿，0 失败**。

> **Windows / PowerShell 的坑**：`run-node.py` 是个薄封装，作用是绕开 PS 5.1 的重定向编码问题
> （`*>` 会写出 UTF-16LE，`| Out-File` 会先按 GBK 解码一次变成乱码）。
> 它把子进程输出按 UTF-8 收到 Python 里，再自己写成 UTF-8 文件（落在 `tools/_test.txt` / `_verify.txt` / `_syntax.txt`）。
> 直接 `node test-content.mjs` 也能跑，只是中文输出在 PS 里可能乱码。

---

## 内部实现要点

这一节是本项目真正的「资产」—— 都是踩过才知道的事。

### 通用性怎么保证

- 功能码 `gnmkdm=N253512`（自主选课），选课页 `/xsxk/zzxkyzb_cxZzxkYzbIndex.html` —— 各校正方一致。
- 列表接口 `POST /xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html`，提交接口 `xkBcZyZzxkYzb`，退选接口 `zzxkyzb_tuikBcZzxkYzb.html`。
- 匹配范围写成 `*://*/xsxk/*` **和** `*://*/xtgl/*`（后者是登录成功后落地的主菜单页，少了它「登录后自动送到选课页」就失效），不写死域名。
- 课程目标用「课程名 / 课程号 / 课程 ID / 教师 / 关键词」多种字段匹配，不预设任何具体课程。

### 参数为什么必须自己补齐

选课页的 44 个查询参数里，**29 个在服务器返回的 HTML 里根本不存在**，是页面 JS 运行时造出来的。缺失的后果各不相同：

| 缺的参数 | 服务端反应 |
|---|---|
| `kklxdm` | `{"flag":"1","tmpList":[]}` ← **HTTP 200、不报错、0 门课** |
| `bklx_id` | 同上 —— **静默 0 门课** |
| `xkkz_xh` | `{"flag":"0","msg":"加密串错误…"}` ← 至少会报错 |
| `rwlx` | 反而返回 63 门（超集，无害） |

所以参数读取顺序是 **DOM > 自补缓存 > `first*` 回落**（DOM 放最前，免得缓存挡住页面稍后写入的新值），
并且额外自己拉一次 Index 原始 HTML + `cxZzxkYzbDisplay` 片段来补 `bklx_id` / `rwlx` / `xklc`。
还能从选课规则串 `xkgz`（形如 `1~0~0~1~<xkkz_id>~0~0`）的**第 5 段**兜底拿 `xkkz_id`。

配套的「关键参数体检」保证：参数没就绪时**不说「没有匹配的课程」**，而是明说缺了哪个参数。

### 两个 jxb_id 别搞混

- `jxb_id` —— 32 位十六进制，可读、可缓存，用于展示与匹配。
- `do_jxb_id` —— 256 位加密串（128 字节）。**带随机 IV，既不能缓存也不能伪造，必须实时取。**

提交选课时要传的是**加密串** `do_jxb_id`，不是 `jxb_id`。

### 展开教学班详情的参数

要带**全套上下文**（`xkkz_id` / `kklxdm` / `njdm_id` / `zyh_id` / `bklx_id` / `rwlx` …），
并**剔掉分页字段**（`kspage` / `jspage` / `jxbzb` / `bhjzckb`），再补上 `xkxskcgskg=1` / `jxbzcxskg=0`。
参数不全时服务端会返回**字面量 `"0"`**，看起来特别像「该课程没有可用教学班」——其实只是少传了东西。

### 全站劫持 `Array.prototype`

正方全站改写了 `Array.prototype.filter` / `.some`，**回调参数顺序被反成 `(index, element)`**。
所以本项目**一次都不用**这两个方法，全部走自己实现的 `where(arr, fn)`。
（两个参考实现也各自写了 `safeFilter` / `safeMap` —— 同一个坑，同一种绕法。）

### 请求必须发在页面的上下文里

扩展的所有请求都在 **content script** 里发，**不放到 service worker**。
放到 SW 会变成跨站请求，`SameSite=Lax` 的 `JSESSIONID` 不会被带上 —— 必然失败。
这是 MV3 最容易犯的架构错误。

`background.js` 存在的唯一理由，是调 `chrome.storage.session.setAccessLevel` 把 session 存储放开给内容脚本；**它不发任何网络请求**。

### 掉线有两种露头方式

1. 302 被弹到登录页；
2. **响应体本身就是登录页 HTML（HTTP 200）** —— 用 `fetch` 打接口不会跳转，光看状态码看不出来，只能看内容。

识别靠 `<input id=yhm>` + `<input id=mm>`（或 `type=password`）+ `login_slogin` / `csrftoken` 同时出现。
最省的只读探针是 `GET /xtgl/index_initMenu.html`，落到 `/login` 或内容是登录页即掉线。

### 登录流程

```
GET  /xtgl/login_slogin.html                  抠隐藏域 csrftoken / mmsfjm / language / pkey
GET  /xtgl/login_getPublicKey.html?time=<ms>  拿 {modulus, exponent}（base64）
     密码 RSAES-PKCS1-v1_5 → base64           （仅当 mmsfjm !== '0' 时需要加密）
POST /xtgl/login_slogin.html                  成功 = 302 到 /xtgl/index_initMenu.html
                                              失败 = 200 回登录页，错误在 <p id="tips">
```

WebCrypto **只有 `RSA-OAEP`，没有 PKCS#1 v1.5** —— 而正方要的正是后者，所以才需要手写的 `rsa-pkcs1.js`（纯 `BigInt`，无依赖）。它的往返正确性由 `tools/test-rsa.mjs` 的 47 条断言覆盖。

---

## 退选安全规则（v2.5.0 的铁律）

自动退课是**不可逆**操作，所以规则定得很死：

> **只有同时满足 `kklxdm === '10'`（通识选修）且 `rwlx === '2'` 的课，才允许被自动退掉。**
> 其余一律只告警、不动作。

- 整套功能挂在 `OPTS.autoDrop` 下，**默认 `false`，必须手动开启**。
- 退选接口：`POST /xsxk/zzxkyzb_tuikBcZzxkYzb.html`，参数 `kch_id` + `jxb_ids`（= `do_jxb_id`）+ `xkxnm` + `xkxqm` + `txbsfrl=0`，返回 `'1'` 才算成功。
- 改这块之前，请先把 `tools/test-content.mjs` 的第 25 节（退选规则）和 `tools/verify-pack.py` 的 `[9]` 组跑一遍 —— 它们专门守着这条规则。

---

## 已知限制

- 只适配**正方教务**。别的教务系统（URP / 强智 / 青果）接口完全不同。
- 依赖「课程列表 + 教学班详情 + 提交」这套 `zzxkyzb` 接口族。学校若换成新版正方（`zftal-ui-v6`）且接口变更，需要重新逆向。
- 抢课本身**不保证成功** —— 它只是把「人手点」变成「机器高频试」，能不能抢到最终取决于名额和并发。
- 扩展只申请了 `storage` 权限，不注入任何非教务页面。
- UserScript 面板停留在 v2.0.0（见上方说明）。

---

## 隐私与安全

**仓库里不包含、并且已被 `.gitignore` 排除：**

| 排除项 | 原因 |
|---|---|
| `gdep-grab/config.json` | 内含账号、学号、明文密码。模板见 `config.example.json` |
| `dist/`、`*.pem` | RSA 私钥。它决定扩展 ID，泄露意味着别人能签出同 ID 的扩展 |
| `**/logs/`、`*.log` | 运行日志，含账号名 |
| `*.crx`、构建产物 | 二进制，可随时重新生成 |

**代码本身不上传任何数据**：没有埋点、没有遥测、不连第三方服务。
扩展存储的账号密码只放在你本机的 `chrome.storage.local` 里，只用于「掉线自动重登」。

本仓库的示例配置中出现的姓名与学号均为**占位符**。

---

## 参考与致谢

接口与流程的交叉验证，参考了这两个开源实现（均为各自作者所有）：

- [ThisIsLittleSky/grabber](https://github.com/ThisIsLittleSky/grabber) —— 选课四阶段流水线（列表 → 详情 → 探测 → 提交）与 `do_jxb_id` 的分析
- [ceilf6/Auto_courseGrabber](https://github.com/ceilf6/Auto_courseGrabber) —— 含校方页面脚本 `zzxkYzb.js`，用于核对页面运行时生成的参数

本仓库的实现是独立编写的，只借鉴了「接口是什么、有哪些坑」这类事实。

---

## 许可

仓库所有者保留所有权利。未附加开源许可证 —— 如需复用请先联系。
