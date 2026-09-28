# 第三方声明 · Third-Party Notices

本项目的部分实现参考了下面两个开源项目。它们均以 **MIT License** 发布，
版权归各自作者所有。按 MIT 的要求，其版权声明与许可全文照录于此。

**关于参考程度（如实说明）**：本项目为独立编写，**未整体拷贝**上述项目的代码，
数据结构和实现形式也不同（例如上课时间解析用普通对象而非 `Set`、用 `for` 循环而非 `forEach`）。
但选课接口流程、参数来源、以及上课时间解析的算法思路参考了它们，
且**部分正则表达式与判定条件与其一致** —— 已足以触发 MIT 的署名保留义务，故完整保留其声明。

---

## 1. ThisIsLittleSky/grabber

- 来源：<https://github.com/ThisIsLittleSky/grabber>
- 本项目参考的内容：
  - 选课四阶段流水线（列表 → 教学班详情 → 前置探针 → 提交）
  - `jxb_id` 与加密串 `do_jxb_id` 的区别与用法
  - 退选接口与「冲突时自动重选」的安全规则
  - `sksj` 上课时间的结构化解析（`lib/schedule.js`）
  - `xkgz` 规则串 → `xkkz_id` 的兜底提取
  - 展开教学班详情的参数要求（剔除分页字段、补 `xkxskcgskg` / `jxbzcxskg`）

```
MIT License

Copyright (c) 2026 ThisIsLittleSky

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. ceilf6/Auto_courseGrabber

- 来源：<https://github.com/ceilf6/Auto_courseGrabber>
- 本项目参考的内容：
  - 页面运行时生成的查询参数清单
  - 该校正方页面的原始 JS（`web结构/自主选课_files/zzxkYzb.js`），用于核对参数来源
  - 对站点改写 `Array.prototype.filter` / `.some` 的防御思路

```
MIT License

Copyright (c) 2026 ceilf6

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 关于正方教务系统本身

本项目未包含任何来自正方教务系统的源代码、图标或其它受版权保护的资源。
`chrome-extension/` 与 `gdep-grab/` 中的全部代码均为本仓库作者编写。

「正方」「zfsoft」等名称与商标归其各自权利人所有，本项目与其无隶属关系。

---

## 免责声明

本项目仅供**学习与个人研究**使用。使用它可能违反你所就读院校的学生管理规定，
并可能导致选课结果被取消等后果。**请自行评估风险，作者不承担任何责任。**
详见 [`LICENSE`](LICENSE) 中的免责条款。
