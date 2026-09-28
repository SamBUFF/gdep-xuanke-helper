#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
跑测试脚本并把 stdout/stderr 以 UTF-8 落盘。
（PowerShell 5.1 的 *> 重定向会写成 UTF-16LE，读起来是「二进制」；所以统一走 Python。）
"""
import subprocess
import sys
import os

NODE = r"C:\Users\BUFF\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
HERE = os.path.dirname(os.path.abspath(__file__))
outfile = os.path.join(HERE, "_test.txt")

target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "test-content.mjs")
r = subprocess.run([NODE, target], capture_output=True, text=True, encoding="utf-8", errors="replace")

with open(outfile, "w", encoding="utf-8") as f:
    f.write("target: %s\n" % target)
    f.write("returncode: %s\n" % r.returncode)
    f.write("---- stdout ----\n")
    f.write(r.stdout or "(empty)")
    f.write("\n---- stderr ----\n")
    f.write(r.stderr or "(empty)")
    f.write("\n")

print("rc=%s -> %s" % (r.returncode, outfile))
