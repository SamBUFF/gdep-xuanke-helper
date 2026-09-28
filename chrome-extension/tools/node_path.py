#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
定位 node 可执行文件（跨平台）。

优先级：
  1. `NODE` 环境变量
  2. WorkBuddy 托管的 node（Windows 开发机上的固定路径）
  3. PATH 里的 `node`（CI / macOS / Linux）

历史：这段逻辑原来把 Windows 绝对路径硬编码在 check-syntax.py 和 run-node.py 里，
导致这两个脚本在任何非该机器的环境（比如 GitHub Actions 的 ubuntu runner）直接跑不起来。
统一收到这里，只此一份。
"""
import os
import shutil

MANAGED = r"C:\Users\BUFF\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"


def find_node():
    """返回 node 可执行文件的路径；都找不到就报错退出。"""
    env = os.environ.get("NODE")
    if env and os.path.exists(env):
        return env
    if os.path.exists(MANAGED):
        return MANAGED
    found = shutil.which("node")
    if found:
        return found
    raise SystemExit(
        "找不到 node。请设置 NODE 环境变量指向 node 可执行文件，或把 node 加进 PATH。"
    )


if __name__ == "__main__":
    print(find_node())
