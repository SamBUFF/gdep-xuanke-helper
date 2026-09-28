#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
纯语法体检：用 node --check 逐个文件过一遍。
（PowerShell 吞 stdout、Bash 缺 coreutils，所以走 subprocess 落盘再读最稳。）
"""
import subprocess
import sys
import os

NODE = r"C:\Users\BUFF\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

FILES = ["rsa-pkcs1.js", "content.js", "popup.js", "background.js", "manifest.json"]

out = []
for f in FILES:
    p = os.path.join(ROOT, f)
    if not os.path.exists(p):
        out.append("SKIP  %-16s (not found)" % f)
        continue
    if f.endswith(".json"):
        r = subprocess.run([NODE, "-e",
                            "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));"
                            "console.log('json ok')", p],
                           capture_output=True, text=True)
    else:
        r = subprocess.run([NODE, "--check", p], capture_output=True, text=True)
    tag = "OK   " if r.returncode == 0 else "FAIL "
    out.append("%s %-16s rc=%s" % (tag, f, r.returncode))
    err = (r.stderr or "").strip()
    if err:
        out.append("      " + err.replace("\n", "\n      ")[:1500])

sys.stdout.write("\n".join(out) + "\n")

# 顺手落一份 UTF-8（PowerShell 重定向会写成 UTF-16LE，读起来是乱码/二进制）
with open(os.path.join(HERE, "_syntax.txt"), "w", encoding="utf-8") as fh:
    fh.write("\n".join(out) + "\n")
