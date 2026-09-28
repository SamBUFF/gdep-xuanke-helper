# 正方教务 · 通用选课助手

面向**正方教务系统**（`zftal-ui-v5` / V-9.0）的自主选课工具 —— **不绑学校、不绑课程、不绑轮次**。

两种形态，**二选一**：

| 形态 | 目录 | 说明 |
|---|---|---|
| **Chrome 扩展**（推荐） | [`chrome-extension/`](chrome-extension/) | MV3，跑在隔离世界；装上就不用管了 |
| **命令行版** | [`gdep-grab/`](gdep-grab/) | 零依赖 Node，适合无人值守 / 多账号；另含一份可贴进控制台的 UserScript 面板 |

> 扩展是主线（**v2.5.0**，功能最全）。命令行版是**独立实现**，两者不共享代码。

---

## ⚠️ 使用前必读

- 只用**你自己的**账号，在**你自己的**教务系统里操作。
- 部分院校把「用脚本抢课」认定为**违规**并会取消选课结果。**风险自负。**
- 默认轮询 1200ms、每轮只发 1~2 个列表查询，已经刻意克制 —— **别再调低，也别多开**。
- 部分课程**无法退课**。自动退课**默认关闭**，开启前先读[退选铁律](#退选铁律)。

---

## 它解决什么

| 痛点 | 做法 |
|---|---|
| 「查询」按钮点不到（被浮层压住 / 手机视口外 / 页面脚本没跑完） | **直接 POST 课程列表接口**，全程不依赖那个按钮 |
| 页面脚本没初始化 → 44 个参数缺了 29 个 → 服务端**静默返回 0 门课** | 三层补参 + 关键参数体检，明确区分「真没课」和「参数没就绪」 |
| 抢课途中登录态掉了 | **自动重登续抢**（失败不自动重试，10 分钟上限 3 次，防锁号） |
| 想避开某几天 / 某几节 / 某几周 | `sksj` 结构化解析 → 按**星期 / 节次 / 周次**筛选教学班 |
| 怕和已选的课撞车 | **本地预判冲突**（省一次服务端往返）；可选在冲突时自动退掉可退的课 |
| 想卡点开抢 / 选错了想换一门 | **定时开抢**（到点前零请求）、**换课**（先退后抢） |

---

## 安装

### Chrome 扩展

Chrome 不允许安装非商店来源的 `.crx`（报 `CRX_REQUIRED_PROOF_MISSING`），只能加载已解压目录。**只需做一次**：

1. 打开 `chrome://extensions`
2. 右上角开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择 `chrome-extension/`（有 `manifest.json` 的那一层）
5. 建议固定到工具栏

**扩展 ID：`dbmnknondalhkjdciheojjdlkcaobfpf`** —— 由 `manifest.json` 的 `key` 写死，装在哪台机器都不变（`chrome.storage` 里的配置才不会断）。

装完去教务系统登录，你会被自动送到「自主选课」页，右下角出现抢课面板。

> 改了代码就回 `chrome://extensions` 点扩展卡片上的 **↻**，再刷新页面，不用重新添加。

### 命令行

```bash
cd gdep-grab
cp config.example.json config.json   # 然后填账号密码
node grab.mjs --list                 # 先看有什么课可选，不提交任何东西
node grab.mjs --dry-run              # 走完流程，但不真正提交
node grab.mjs                        # 正式抢
```

需要 **Node 18+**（推荐 20 / 22），**零三方依赖**，不用 `npm install`。

---

## 退选铁律

自动退课不可逆，所以规则定得很死：

> **只有同时满足 `kklxdm === '10'`（通识选修）且 `rwlx === '2'` 的课，才允许被自动退掉。**
> 其余一律只告警、不动作。

整套功能挂在 `OPTS.autoDrop` 下，**默认 `false`，必须手动开启**。
改这块之前，先跑 `tools/test-content.mjs` 第 25 节和 `tools/verify-pack.py` 的 `[9]` 组 —— 它们专门守着这条规则。

---

## 开发与自测

全部**不需要开浏览器**（把 `content.js` 里的纯函数切片抽出来跑）：

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

> `run-node.py` 只是个薄封装，用来绕开 Windows PowerShell 5.1 的重定向编码问题
> （`*>` 会写出 UTF-16LE，`| Out-File` 会先按 GBK 解码一次变成乱码）。
> 直接 `node xxx.mjs` 也能跑，只是中文输出可能乱码。

**更细的内容在子 README 里**（接口参数坑、掉线识别、登录 RSA、排障小抄）：
[`chrome-extension/README.md`](chrome-extension/README.md) ·
CLI 参数与 `targets` 匹配字段：[`gdep-grab/README.md`](gdep-grab/README.md)

---

## 已知限制

- 只适配**正方教务**；换新版（`zftal-ui-v6`）且接口变更的话需要重新逆向。
- 抢课**不保证成功** —— 它只是把「人手点」变成「机器高频试」，最终取决于名额和并发。
- 扩展只申请 `storage` 权限，不注入任何非教务页面。
- `gdep-grab/zf-xk-helper.user.js` 面板停在 **v2.0.0**，缺 v2.2 ~ v2.5 的全部新能力（要全功能请用扩展）。

---

## 隐私与安全

代码**不上传任何数据**：没有埋点、没有遥测、不连任何第三方服务。
账号密码只存在你本机（扩展存在 `chrome.storage.local`），**仅**用于掉线自动重登。

仓库**不包含**（已由 `.gitignore` 排除）：`gdep-grab/config.json`（明文密码）、`logs/`、
`dist/` 与 `*.pem`（决定扩展 ID 的 RSA 私钥）、`_ref/`、`.workbuddy/`。
示例配置中出现的姓名与学号均为**占位符**。

---

## 许可

本项目以 **MIT License** 发布 —— 见 [`LICENSE`](LICENSE)。

实现参考了以下两个 **MIT** 项目，版权归各自作者所有，完整声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)：

- [ThisIsLittleSky/grabber](https://github.com/ThisIsLittleSky/grabber) —— 选课四阶段流水线、`do_jxb_id`、上课时间解析
- [ceilf6/Auto_courseGrabber](https://github.com/ceilf6/Auto_courseGrabber) —— 页面运行时参数清单、校方页面 JS

> 使用本项目即表示你已阅读并接受开头的[《使用前必读》](#️-使用前必读)，风险自负。
