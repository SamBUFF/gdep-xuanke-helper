#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
跑测试脚本并把 stdout/stderr 以 UTF-8 落盘。
（PowerShell 5.1 的 *> 重定向会写成 UTF-16LE，读起来是「二进制」；所以统一走 Python。）

用法：python run-node.py <script.mjs> [给脚本的参数...]
      第一个参数是要跑哪个 .mjs；**后面的参数原样透传给子进程**
      （例如 pack-crx.mjs --ephemeral）。

历史坑：这里以前写的是 subprocess.run([NODE, target])，把 argv[2:] 丢了 ——
于是 CI 里的 `python run-node.py pack-crx.mjs --ephemeral` 实际执行的是不带任何
flag 的 pack-crx.mjs，走到了「拒绝改写扩展 ID」分支退出 2。本地因为习惯直接用
`node pack-crx.mjs --ephemeral` 测试，一直没暴露。参数透传不是可选项。
"""
import subprocess
import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from node_path import find_node          # noqa: E402  （同目录工具，见 node_path.py）

NODE = find_node()
outfile = os.path.join(HERE, "_test.txt")

target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "test-content.mjs")
extra = sys.argv[2:]                     # 原样透传给子进程，别丢
cmd = [NODE, target] + extra
r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")

with open(outfile, "w", encoding="utf-8") as f:
    f.write("cmd: %s\n" % " ".join(cmd))
    f.write("target: %s\n" % target)
    f.write("returncode: %s\n" % r.returncode)
    f.write("---- stdout ----\n")
    f.write(r.stdout or "(empty)")
    f.write("\n---- stderr ----\n")
    f.write(r.stderr or "(empty)")
    f.write("\n")

print("rc=%s -> %s" % (r.returncode, outfile))

# 关键：把子进程退出码传出去。三个 .mjs 都是 process.exit(fail ? 1 : 0)，
# 这里不传播的话，单测失败在 CI 里也是绿的。
sys.exit(r.returncode)
