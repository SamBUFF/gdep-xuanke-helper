# 正方教务 · 通用抢课工具

面向**正方教务系统**（V-9.0 / `zftal-ui-v5`，服务器渲染 + jQuery）的自主选课助手。
原先只针对广东工程职业技术学院 `zf.gdep.edu.cn` 逆向，现已做成**不绑课程、不绑轮次、不绑学校**的通用版。

三种形态：

| 形态 | 位置 | 适合 |
|------|------|------|
| **Chrome 扩展** | `../chrome-extension/` | 装上就不用管了。隔离世界运行，不受站点原型污染。**功能最全，是主线** |
| **网页面板**（UserScript） | `zf-xk-helper.user.js` | 临时用/迭代快。贴进控制台即可，无需安装 |
| 命令行脚本 | `grab.mjs` | 无人值守 / 多账号并发。零依赖，需 Node 18+（推荐 20/22），要自己填账号密码 |

> ⚠️ **网页面板是 v2.0.0，落后于扩展的 v2.5.0。** 两者已不再功能对等 ——
> 面板**没有**：自动跳转到选课页、掉线自动重登、查询参数自补、按星期/节次/周次筛选教学班、
> 定时开抢、换课、冲突时自动退可退选修课。
> 想要完整功能请用 `../chrome-extension/` 里的 Chrome 扩展。

扩展与命令行是两条**各自独立**的实现（不共享代码），按场景二选一。

---

## ⚠️ 使用前必读

- 请只用**你自己的账号**，在你**自己的**教务系统里操作。
- 各校《学生手册》对「使用脚本/外挂抢课」的定性不同，部分院校认定为**违规**并会取消选课结果。**风险自负**。
- 教务系统会记录 IP 与请求频次。面板默认轮询间隔 1200ms 且每轮只发 1~2 个列表查询，已经尽量克制；**请不要再调低**，也不要无脑多开。
- 抢课成功即占位，部分课程**无法退课**，请确认后再关掉「仅演练」。

---

## 快速上手（网页面板）

```
1. 装 Tampermonkey，新建脚本，把 zf-xk-helper.user.js 整份贴进去
   （或直接在选课页按 F12 → Console，整份粘贴回车）
2. 打开教务系统 → 选课 → 自主选课
3. 面板自动出现在右下角：添加目标 → 填课程名
4. 点「预览匹配」确认教学班对不对  ← 只读，不会提交
5. 取消勾选「仅演练」→ 点「开始抢课」
```

详见下面的《通用版网页面板》一节。

---

## 快速上手（命令行）

```bash
# 1. 填账号
#    编辑 config.json，把 password 填上（或留空改用环境变量，见下）

# 2. 先看有什么课可选（最安全，不会提交任何东西）
node grab.mjs --list

# 3. 演练一遍完整流程，但不真正提交
node grab.mjs --dry-run

# 4. 正式抢课
node grab.mjs
```

只想抢某几门、只登某个账号：

```bash
node grab.mjs --account 张三 --course 篮球 --course 羽毛球
```

---

## 命令行参数

| 参数 | 说明 |
|---|---|
| `--list` | 只登录并列出当前可选课程，不提交任何申请 |
| `--dry-run` | 走完查询 → 选教学班 → 冲突预检，但**不真正提交** |
| `--quick` | 一键选课：提交该轮次下你已保存的**全部意向**（需先在网页里配好意向） |
| `--confirm` | 每次真正提交前，在终端里人工确认 |
| `--account <名字>` | 只跑指定账号，可重复；匹配 `name` 或 `username` |
| `--course <课程名>` | 只抢指定课程，可重复；会覆盖 config 里的 `targets` |
| `--max-attempts <n>` | 最多轮询 n 轮后放弃（默认不限，跑到抢到为止） |
| `--interval <ms>` | 轮询间隔毫秒，默认 1500 |
| `--config <文件>` | 指定配置文件，默认 `config.json` |

---

## 配置文件

复制 `config.example.json` 为 `config.json`。

```jsonc
{
  "baseUrl": "https://zf.gdep.edu.cn",
  "intervalMs": 1500,          // 轮询间隔
  "jitterMs": 500,             // 间隔随机抖动上限，避免固定频率
  "maxAttempts": 0,            // 0 = 不限
  "concurrency": 1,            // 多账号并发数，建议 1~2
  "confirmBeforeSubmit": false,

  "accounts": [
    {
      "name": "张三",            // 显示名
      "username": "2026000001",   // 学号
      "password": "……",           // 明文密码
      "passwordEnv": "ZF_PWD_1",  // 可选：从环境变量读密码，优先级高于上面
      "enabled": true,
      "targets": [
        { "course": "篮球" },
        { "course": "羽毛球", "teacher": "李老师" }
      ]
    }
  ]
}
```

### targets 支持的匹配字段

| 字段 | 含义 |
|---|---|
| `course` | 课程名**全等**匹配（最常用） |
| `courseContains` | 课程名**包含**匹配 |
| `courseRegex` | 课程名**正则**匹配 |
| `courseCode` / `courseCodeContains` | 用课程号（页面上的 `kch`，如 `z290100101`）匹配 |
| `kchId` | 内部课程 ID，最精确 |
| `teacher` | 优先选该老师的教学班；没命中会回退到全部教学班 |
| `classKeyword` | 教学班信息里的任意关键词（如上课地点） |
| `preferMostRemain` | 默认 `true`，按剩余容量从多到少挑教学班 |

多个 target 按**数组顺序**依次尝试，抢到一个就跳到下一个。

用环境变量放密码，避免明文写在文件里：

```bash
# Windows PowerShell
$env:ZF_PWD_1="你的密码"; node grab.mjs
# Git Bash / macOS / Linux
export ZF_PWD_1="你的密码" && node grab.mjs
```

---

## 目录结构

```
gdep-grab/
├── grab.mjs              # 主程序：参数解析 / 账号调度 / 轮询 / 提交 / 日志
├── config.json           # 你的账号与目标课程  ← 不在仓库里，需自己建（见下）
├── config.example.json   # 配置模板与字段说明
├── lib/
│   ├── http.mjs          # 带 Cookie 会话的 HTTP 客户端（手动处理重定向以捕获 Set-Cookie）
│   └── zf.mjs            # 正方教务：登录(RSA) / 选课页上下文 / 课程 / 教学班 / 预检 / 提交 / 退课
├── zf-xk-helper.user.js  # 【通用版·推荐】注入式浮层面板：多目标优先级队列，跨学校通用
└── logs/                 # 每天一个 .log  ← 不在仓库里
```

> ⚠️ **`config.json` 不在本仓库中**，因为它装着账号、学号和明文密码（已被 `.gitignore` 排除）。
> 首次使用请自己建一份：
>
> ```bash
> cp config.example.json config.json    # 然后编辑 config.json 填账号密码
> ```
>
> 提交前请再确认一次 `git status` 里没有 `config.json`。

---

## 通用版网页面板 `zf-xk-helper.user.js`

**这是主力工具。** 跑在你自己已登录的选课页里，直接复用浏览器 Cookie，不需要输账号密码。
兼容 Tampermonkey（`@match *://*/xsxk/*`，跨学校通用），也可以直接把整份文件贴进 F12 控制台。

### 它"通用"在哪

| 通用点 | 说明 |
|--------|------|
| 不绑课程 | 目标由你在面板里填，课程名关键词 / 课程号 / 教师 / 时间都行 |
| 不绑轮次 | `xkkz_id`、`kklxdm`、`xklc` 等每次从页面隐藏域**现读**，换轮次换学期不用改代码 |
| 不绑学校 | 匹配模式是 `*://*/xsxk/*`，只要对方是正方教务的自主选课页就能用 |
| 不绑场景 | 体育课、公选课、专业选修、重修……都是同一个流程 |

### 多目标优先级队列

面板里可以加任意多个目标，**从上往下依次尝试**：第一个抢不到就自动试第二个，抢到一个就把这个目标标记完成、继续下一个。

每个目标支持：

- **课程名**（空格分词 = 全部命中，如 `篮球`、`体育 I`）
- **课程号**：填了就走精确匹配（可以不填课程名）
- **只选教师 / 排除教师**：任一命中即算；排除优先于包含
- **时间要求**：如 `星期一` 或 `第5-6节`，多关键词按 AND
- **最少剩余**：默认 1（必须有余量）；走抽签/志愿分配的轮次可以设 0

### 推荐流程

```
1. 添加目标 → 填课程名
2. 点「预览匹配」  ← 只读，不提交。确认匹配到的教学班和教师是对的
3. 保持「仅演练」勾选，点「执行一轮」再确认一遍
4. 取消勾选「仅演练」→ 点「开始抢课」
```

- **「仅演练」默认勾着**，演练模式下轮询一旦匹配到目标就会自动停下并提示，不会误提交。
- 「已选过的课程自动跳过」默认开启：每次提交前会拉一次已选列表，已经在名单里的课程直接跳过（避免重复占位）。
- 抢到 / 目标全部完成后**自动停止**，也可以随时手动「停止」。
- 配置存在浏览器 `localStorage`，还可「导出 / 导入 JSON」，换设备换学期直接搬。

### 控制台 API

面板暴露了 `window.__XK_HELPER__`，方便脚本化操作：

```js
__XK_HELPER__.setTargets(['篮球','羽毛球','武术'])   // 直接设定目标队列
await __XK_HELPER__.tick(false)                      // 跑一轮（false = 演练不提交）
await __XK_HELPER__.tick(true)                       // 跑一轮（true = 真提交，有副作用！）
await __XK_HELPER__.queryChoosed()                   // 查已选列表
await __XK_HELPER__.queryCourses(1)                  // 查课程列表（只读）
__XK_HELPER__.preview()                              // 等同点「预览匹配」
```

### ⚠️ 全站陷阱：`.filter` / `.some` 被改写了

**这不是选课页独有的，正方教务全站都中招**（2026-09-20 实测：主菜单页和选课页都命中）。

页面覆盖了 `Array.prototype.filter` 和 `.some`，实现的回调参数顺序是 `(index, element)`，**和标准反的**：

```js
// 页面里的实际实现（非原生）
function (f, g) { ... if (!f.call(e, d, this[d], this)) continue; ... }
//                              ↑ 穿过来的第 1 个参数是 index，不是元素
```

后果：在页面上下文里写 `list.filter(x => x.xxx)` 会**静默返回空数组** —— 不报错、不抛异常，只是永远筛不出东西。
典型症状是「课程查得到，但查教学班永远是空」「明明有 4 个教学班却提示没有符合条件」。

**自检**：`Array.prototype.filter.toString()` 如果不含 `[native code]`，就是被换了。

**千万别去"修复"它** —— 正方自己的前端代码就是按这个反的顺序写的，换成原生实现会把教务系统本身搞坏。
正确做法是：自己的代码里一次都别用 `.filter` / `.some`，统一走自实现的 `where(arr, fn)`（for 循环）。
`.map / .forEach / .sort / .slice / .join / .indexOf / .reduce` 仍是原生的，可以放心用。

`zf-xk-helper.user.js` 全文只用 `where()`，零处 `.filter` / `.some`。


---

## 原理（2026-09-20 实测）

平台是**正方教务**（页脚 `版本V-9.0`，前端包 `zftal-ui-v5-1.0.2`，服务器渲染 + jQuery）。与同校「微后勤」不同，这里**没有请求签名、没有报文加密、没有 CSRF 头**，登录态就是 `JSESSIONID` Cookie。

### 登录

```
GET  /xtgl/login_slogin.html                     → 拿 csrftoken 等隐藏域 + JSESSIONID
GET  /xtgl/login_getPublicKey.html?time=<ms>     → {modulus, exponent}（base64）
POST /xtgl/login_slogin.html
     yhm=<学号>
     mm=<RSA 加密后的密码>                          ← mmsfjm=1 时必填
     csrftoken=<页面隐藏域原值>
     + 页面其余隐藏域
```

密码加密方式等价于页面里的 `hex2b64(rsaKey.encrypt(pwd))`，即 **RSAES-PKCS1-v1_5 + base64**，公钥由 `modulus`/`exponent` 直接构造。`lib/zf.mjs` 用 Node `crypto` 原生实现，无需 jsencrypt。

### 选课

```
GET  /xsxk/zzxkyzb_cxZzxkYzbIndex.html?gnmkdm=N253512&layout=default
     ← 全部上下文（xkkz_id / xklc / kklxdm / xkxnm / xkxqm / jg_id_1 / xkkz_xh …）都在隐藏域里
POST /xsxk/zzxkyzb_cxZzxkYzbPartDisplay.html?gnmkdm=N253512   课程列表分页查询（只读）
POST /xsxk/zzxkyzbjk_cxJxbWithKchZzxkYzb.html?gnmkdm=N253512  展开教学班（拿 do_jxb_id）
POST /xsxk/zzxkyzb_cxCtKcZyZzxkYzb.html                       时间冲突预检（无副作用）
POST /xsxk/zzxkyzbjk_xkBcZyZzxkYzb.html                       正式选课 ← 会真实占位
POST /xsxk/zzxkyzb_xkZzxkyzbQuickly.html                      一键选课（只传 xkkz_id）
POST /xsxk/zzxkyzb_tuikBcZzxkYzb.html                         退课
```

**关键坑**：提交时 `jxb_ids` 必须是**加密后的 `do_jxb_id`**，传 `jxb_id` 服务端返回「出现未知异常，请与管理员联系！」。脚本用冲突预检接口做了零副作用验证。

### 轮询策略

每一轮只发 **1 个**课程列表查询；只有当目标课程出现在列表里，才会继续发「教学班查询 → 冲突预检 → 提交」。目标没出现时不会产生任何额外请求。

---

## 常见问题

**`--list` 报「页面里没有 xkkz_id」**
当前不在选课开放期，或该账号无选课权限。可先在浏览器里打开选课页确认能选。

**提交返回 `flag=0` 且提示「出现未知异常」**
`jxb_ids` 格式不对，或该轮次已关闭。用 `--dry-run` 看预检是否通过。

**提示「缴费入住通道未开启」之类**
说明该功能当前未开放，和脚本无关。

**多账号**
在 `accounts` 里加条目即可。`concurrency` 控制并发数，建议保持 1~2，避免所有账号同时打服务器。

**中途想停**
`Ctrl+C` 即可，已提交的选课不会回滚；需要撤销就用网页或脚本的退课接口。

---

## 日志

每次运行会同时输出到终端和 `logs/YYYY-MM-DD.log`，包含时间戳、账号、每一次查询/预检/提交的结果，便于事后复盘。
