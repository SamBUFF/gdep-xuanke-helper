#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
纯语法体检：用 node --check 逐个文件过一遍。
（PowerShell 吞 stdout、Bash 缺 coreutils，所以走 subprocess 落盘再读最稳。）
"""
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from node_path import find_node          # noqa: E402  （同目录工具，见 node_path.py）

NODE = find_node()
ROOT = os.path.dirname(HERE)

FILES = ["rsa-pkcs1.js", "content.js", "popup.js", "background.js", "manifest.json"]

out = []
failed = 0
for f in FILES:
    p = os.path.join(ROOT, f)
    if not os.path.exists(p):
        # 该在的文件不在 = 有问题（少了 content.js 也返回 0 的话，这个检查就没意义了）
        out.append("SKIP  %-16s (not found)" % f)
        failed += 1
        continue
    if f.endswith(".json"):
        r = subprocess.run([NODE, "-e",
                            "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
                            "console.log('json ok')", p],
                           capture_output=True, text=True)
    else:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
    tag = "OK   " if r.returncode == 0 else "FAIL "
    if r.returncode != 0:
        failed += 1
    out.append("%s %-16s rc=%s" % (tag, f, r.returncode))
    err = (r.stderr or "").strip()
    if err:
        out.append("      " + err.replace("\n", "\n      ")[:1500])

sys.stdout.write("\n".join(out) + "\n")

# 顺手落一份 UTF-8（PowerShell 重定向会写成 UTF-16LE，读起来是乱码/二进制）
with open(os.path.join(HERE, "_syntax.txt"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")

# 有任何一个文件没过 -> 非 0 退出，让 CI 和 shell 能判定失败
sys.exit(1 if failed else 0)
