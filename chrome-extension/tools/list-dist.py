#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""列出 dist/ 里的产物（名字 / 字节数 / 修改时间），UTF-8 落盘。

为什么不用 shell 重定向：本机 PowerShell 5.1 的 `>` 写 UTF-16LE（Read 工具当二进制拒读），
`| Out-File -Encoding utf8` 又会因 GBK 二次解码而乱码。让 Python 自己写最省事。
"""
import glob
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))          # tools/
EXT_DIR = os.path.dirname(HERE)                            # chrome-extension/
DIST = os.path.join(os.path.dirname(EXT_DIR), "dist")      # <工作区>/dist/

lines = []
for p in sorted(glob.glob(os.path.join(DIST, "*"))):
    if os.path.basename(p).startswith("_") or os.path.isdir(p):
        continue
    lines.append("%-36s %9d B   %s" % (
        os.path.basename(p),
        os.path.getsize(p),
        time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(os.path.getmtime(p))),
    ))

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_dist.txt"), "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print("\n".join(lines))
