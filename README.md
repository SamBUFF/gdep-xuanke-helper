# 正方教务 · 通用选课助手（gdep-xuanke-helper）

[![quality](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/quality.yml/badge.svg)](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/quality.yml)
[![codeql](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/codeql.yml/badge.svg)](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/codeql.yml)
[![security](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/security.yml/badge.svg)](https://github.com/SamBUFF/gdep-xuanke-helper/actions/workflows/security.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向**正方教务系统**（`zftal-ui-v5` / V-9.0）的自主选课助手 —— **不绑学校、不绑课程、不绑轮次**（最初基于广东工程职业技术学院教务系统逆向验证，现已通用化）。

[快速导航](#形态选择) · [使用前必读](#使用前必读) · [核心能力](#它解决什么) · [安装与快速上手](#安装与快速上手) · [退选铁律](#退选铁律) · [目录结构](#目录结构) · [开发与自测](#开发与自测) · [安全与质量](#安全与质量)

> 🤖 **本项目由 AI 编程助手制作**：**WorkBuddy** + **DeepSeek-V4.1-Flash**。
> 需求、取舍与验收由人负责；源码、测试、文档由 AI 生成。
> 安全评估与威胁模型请读 [SECURITY.md 里的说明](SECURITY.md#关于-ai-参与本项目的说明)。

---

## 形态选择

提供两种独立形态，按使用习惯**二选一**（两者不共享代码）：

| 形态 | 目录 | 特点与适用场景 |
|---|---|---|
| **Chrome 扩展（推荐・主线 v2.5.0）** | [`chrome-extension/`](chrome-extension/) | Manifest V3，隔离世界运行；功能最全，装好后登录教务即可使用 |
| **命令行版（零依赖 Node）** | [`gdep-grab/`](gdep-grab/) | 适合无人值守 / 多账号调度；目录内另附一份可贴进控制台的 UserScript 面板（v2.0.0） |

---

## 使用前必读

- 只用**你自己的**账号，在**你自己的**教务系统里操作。
- 部分院校把「用脚本抢课」认定为**违规**并会取消选课结果。**风险自负。**
- 默认轮询 `1200ms`、每轮只发 1~2 个列表查询，已经刻意克制 —— **别再调低，也别多开**。
- 部分课程**无法退课**。自动退课**默认关闭**，开启前请先读 [退选铁律](#退选铁律)。

---

## 它解决什么

| 痛点 | 做法 |
|---|---|
| 「查询」按钮点不到（被浮层压住 / 手机视口外 / 页面脚本没跑完） | **直接 POST 课程列表接口**，全程不依赖那个按钮 |
| 页面脚本没初始化 → 44 个参数缺了 29 个 → 服务端**静默返回 0 门课** | 三层补参 + 关键参数体检，明确区分「真没课」和「参数没就绪」 |
| 抢课途中登录态掉了 | **自动重登续抢**（失败不自动重试，10 分钟上限 3 次，防锁号） |
| 想避开某几天 / 某几节 / 某几周 | `sksj` 结构化解析 → 按**星期 / 节次 / 周次**精确筛选教学班 |
| 怕和已选的课撞车 | **本地预判冲突**（省一次服务端往返）；可选在冲突时自动退掉可退的选修课 |
| 想卡点开抢 / 选错了想换一门 | **定时开抢**（到点前零请求）、**换课**（先退后抢） |

---

## 安装与快速上手

### 方式一：Chrome 扩展（推荐）

#### 1. 安装（只需做一次）

Chrome 稳定版不允许直接安装非商店来源的 `.crx`（会报 `CRX_REQUIRED_PROOF_MISSING`），请使用「加载已解压的扩展程序」：

1. 从 [**Releases**](https://github.com/SamBUFF/gdep-xuanke-helper/releases) 下载 `zf-xk-helper-2.5.0.zip` 并解压，或 `git clone` 本仓库。
2. 地址栏打开 `chrome://extensions`，打开右上角 **开发者模式**。
3. 点击 **加载已解压的扩展程序**，选择 `chrome-extension/`（包含 `manifest.json` 的那一层目录）。
4. 建议把扩展固定到工具栏（拼图图标 → 图钉）。

> - **固定扩展 ID：`dbmnknondalhkjdciheojjdlkcaobfpf`**（由 `manifest.json` 的 `key` 固定，换机器加载配置也不会断）。
> - 更新代码后，回 `chrome://extensions` 点击扩展卡片上的 **↻ 重新加载** 并刷新页面即可，无需重新添加。
> - Releases 里的 `.crx` 仅作存档与校验用，Windows/macOS 稳定版 Chrome 请使用 `.zip` 解压加载。

#### 2. 快速上手步骤

1. **登录教务系统**：在浏览器正常登录你所在学校的正方教务系统；扩展会自动跳转到「自主选课」页面，并在右下角显示抢课面板。
2. **添加目标课程**：在面板里填写目标课程（支持按课程名、教师、以及**星期 / 节次 / 周次**筛选教学班）。
3. **先做只读自检**：先点击面板中的 **自检（只读）**，确认查询参数就绪且匹配到的教学班无误。
4. **按需配置策略**：可按需开启 **定时开抢**（到点前不发请求）、**掉线自动重登**、**换课**；若考虑开启冲突自动退课，务必先阅读下方 [退选铁律](#退选铁律)。
5. **开始抢课**：确认无误后启动抢课，面板实时输出每轮状态日志。

---

### 方式二：命令行版（Node 18+，零第三方依赖）

无需 `npm install`，直接运行：

```bash
cd gdep-grab
cp config.example.json config.json
```

编辑 `config.json`，填入你所在学校的教务地址 `baseUrl`、学号与目标课程 `targets`（推荐用环境变量 `passwordEnv` 传入密码，避免明文密码落盘）：

```bash
# 推荐用环境变量传密码（以 PowerShell 为例；Bash/macOS 用 export ZF_PWD_1="你的密码"）
$env:ZF_PWD_1="你的密码"

# 1. 先只读查看当前可选课程（最安全，不提交任何申请）
node grab.mjs --list

# 2. 全流程演练（查询 → 选教学班 → 冲突预检），但不真正提交
node grab.mjs --dry-run

# 3. 正式开抢
node grab.mjs
```

常用定向参数示例：

```bash
# 只跑指定账号 / 指定课程，并在真正提交前人工确认
node grab.mjs --account 张三 --course 篮球 --course 羽毛球 --confirm

# 一键提交已在教务网页配好的全部意向
node grab.mjs --quick
```

> 详细参数说明、面板排障与接口原理见子文档：
> - Chrome 扩展详解：[`chrome-extension/README.md`](chrome-extension/README.md)
> - 命令行与 `targets` 匹配规则：[`gdep-grab/README.md`](gdep-grab/README.md)

---

## 退选铁律

自动退课不可逆，因此规则写死且默认关闭：

> **只有同时满足 `kklxdm === '10'`（通识选修）且 `rwlx === '2'` 的课，才允许被自动退掉。**
> 其余一律只告警、不动作。

整套功能挂在 `OPTS.autoDrop` 下，**默认 `false`，必须手动开启**。
修改相关逻辑前，请先跑 `chrome-extension/tools/test-content.mjs` 第 25 节和 `chrome-extension/tools/verify-pack.py` 的 `[9]` 组守卫测试。

---

## 目录结构

```text
gdep-xuanke-helper/
├── chrome-extension/           # 【主线 v2.5.0】Chrome MV3 扩展源码、图标与测试/打包脚本
│   ├── manifest.json           # 最小权限声明（仅 storage，仅注入 */xsxk/* 与 */xtgl/*）
│   ├── content.js              # 核心选课面板、参数自补、时间筛选、冲突预判与自动重登
│   ├── background.js / popup.* # 扩展后台与弹窗配置
│   ├── rsa-pkcs1.js            # 零依赖纯 JS RSA 登录加密
│   ├── tools/                  # 单元测试、打包脚本（pack-crx.mjs）与校验脚本
│   └── README.md               # 扩展原理、参数坑与排障详情
├── gdep-grab/                  # 【独立实现】零依赖 Node CLI 抢课脚本 + v2.0.0 UserScript 面板
│   ├── grab.mjs                # 命令行入口（多账号调度、轮询与日志）
│   ├── lib/                    # 正方教务会话与接口封装（http.mjs / zf.mjs）
│   ├── config.example.json     # 配置文件模板与 targets 匹配字段说明
│   ├── zf-xk-helper.user.js    # 临时控制台面板（停留在 v2.0.0，全功能请用扩展）
│   └── README.md               # CLI 参数、环境变量与配置详解
├── tools/check-secrets.py      # 仓库级凭据 / 私钥 / 真实学号防泄漏守卫
├── SECURITY.md                 # 威胁模型、凭据存储策略与已知风险清单
└── THIRD-PARTY-NOTICES.md      # 参考项目许可声明
```

---

## 开发与自测

全部**不需要开浏览器**（直接提取 `content.js` 中的纯函数切片运行）：

```bash
cd chrome-extension/tools

python check-syntax.py                   # 语法体检（5 个文件）
python run-node.py test-content.mjs      # 判定 / 参数层 / 登录解析 / 时间解析 / 退选规则 —— 171 条
python run-node.py test-rsa.mjs          # 纯 JS RSA 往返正确性 —— 47 条
python run-node.py test-login-flow.mjs   # doLogin 端到端（假 fetch）—— 30 条
python run-node.py pack-crx.mjs          # 重新打包（内含验签自检）
python verify-pack.py                    # 独立复验 —— 117 项
```

当前全绿：**171 + 47 + 30 + 117，0 失败**。

仓库级安全守卫（同步运行在 CI 中）：

```bash
python tools/check-secrets.py                       # 仓库根：凭据 / 私钥 / 真实学号不得入库
python chrome-extension/tools/check-permissions.py  # 扩展权限面不得被扩大
```

> `run-node.py` 是一个薄封装，用于绕开 Windows PowerShell 5.1 的重定向编码乱码问题；直接运行 `node xxx.mjs` 同样可用。

---

## 自动化门禁

三个 GitHub Actions 工作流，每次 push / PR 自动执行：

| 工作流 | 做什么 |
|---|---|
| [`quality.yml`](.github/workflows/quality.yml) | 语法体检 → 171 条内容脚本单测 → 47 条 RSA 测试 → 30 条登录流程测试 → 打包 → 117 项独立复验 |
| [`codeql.yml`](.github/workflows/codeql.yml) | CodeQL 静态扫描，`security-and-quality` 查询套件（安全 + 代码质量） |
| [`security.yml`](.github/workflows/security.yml) | 凭据 / 私钥守卫 + 扩展权限面回归 |

Dependabot 每周跟进 Actions 版本（本项目**零第三方依赖**，无 npm 供应链风险）。

---

## 已知限制

- 只适配**正方教务（`zftal-ui-v5` / V-9.0）**；若学校升级至接口变更的新版本需重新适配。
- 抢课**不保证成功** —— 工具只是减少人工点击延迟与参数异常，最终取决于名额和并发。
- 扩展仅申请 `storage` 权限，不注入任何非教务页面。
- `gdep-grab/zf-xk-helper.user.js` 面板停留在 **v2.0.0**，不含 v2.2 ~ v2.5 的新特性（完整功能请使用 Chrome 扩展）。

---

## 安全与质量

完整威胁模型、凭据处理方式与已知风险清单见 **[`SECURITY.md`](SECURITY.md)**，建议先读一遍再使用。核心要点：

| 问题 | 答案 |
|---|---|
| 它会把数据发给谁？ | **谁都不发。** 扩展里没有硬编码外部 URL，4 处 `fetch` 全为相对路径 + `credentials: 'same-origin'`，流量只发往你自己的教务站点 |
| 需要什么权限？ | 仅 `storage`。无 `tabs` / `cookies` / `webRequest` / `<all_urls>`；注入范围限于 `*/xsxk/*` 与 `*/xtgl/*` |
| 密码存在哪？ | 默认 `chrome.storage.session`（**仅内存**，关浏览器即清）；勾选「记住密码」才存入 `chrome.storage.local`（明文），**不进任何日志** |
| 渲染服务端内容安全吗？ | 5 处 `innerHTML` 汇聚点**全部**经 `esc()` 转义；结构性渲染一律 `createElement` + `textContent` |
| 有没有不可逆操作？ | 只有退课，且**默认关闭** + [退选铁律](#退选铁律) 限制仅能退通识选修 |

仓库**不包含**（已由 `.gitignore` 排除，且已核对 git 全历史无命中）：`gdep-grab/config.json`（明文密码）、`logs/`、`dist/`、`*.pem`（决定扩展 ID 的 RSA 私钥）、`_ref/`、`.workbuddy/`。示例配置中的姓名与学号均为占位符。

**已知风险**（请自行评估）：勾选「记住密码」时的本地明文存储、自动重登可能触发学校账号锁定策略、退课不可逆、高频请求可能触发风控、以及**脚本抢课在部分院校属违规行为**。详见 [`SECURITY.md`](SECURITY.md)。

---

## 关于本项目的制作说明

**本项目由 AI 编程助手制作。**

| 项 | 值 |
|---|---|
| 编程助手 | **WorkBuddy** |
| 底层模型 | **DeepSeek-V4.1-Flash** |
| 参与范围 | 全部源码（Chrome 扩展、CLI 版、UserScript）、测试、打包脚本、文档、CI 配置 |
| 人类工作 | 需求定义、真机实测、逆向结论验证、安全取舍最终决定 |

请对这一点保持清醒：**AI 生成的代码可能存在未察觉的缺陷**，不要因为文档规范就默认零风险。本项目提供的验证方式是**可复现的本地自检**：

```bash
python tools/check-secrets.py
python chrome-extension/tools/check-permissions.py
cd chrome-extension/tools && python run-node.py test-content.mjs && python verify-pack.py
```

若打算在自己学校使用，建议先阅读 `chrome-extension/content.js` 里的 `submitQuick()` 与 `resolveConflict()` —— 这两个是唯一会向教务系统写数据的函数。

---

## 许可

本项目以 **MIT License** 发布，详见 [`LICENSE`](LICENSE)。

实现参考了以下两个 **MIT** 项目，版权归各自作者所有，完整声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)：

- [ThisIsLittleSky/grabber](https://github.com/ThisIsLittleSky/grabber) —— 选课四阶段流水线、`do_jxb_id`、上课时间解析
- [ceilf6/Auto_courseGrabber](https://github.com/ceilf6/Auto_courseGrabber) —— 页面运行时参数清单、校方页面 JS

> 使用本项目即表示你已阅读并接受开头的 [《使用前必读》](#使用前必读)，风险自负。
