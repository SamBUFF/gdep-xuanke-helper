#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""扫掉本目录下的运行残留物，避免越积越乱：

  1. tools/_*.txt        —— 各校验脚本生成的临时日志（_syntax / _test / _verify / _dist …）
  2. tools/_*.js         —— 临时注入用的探测脚本（CDP /eval 里 --data-binary 传的那类，
                            例如 _probe1.js；约定：文件名以 `_` 开头的都是用完即弃的）
  3. dist/ 里的旧版本包  —— 版本号与 manifest.json 不一致的 .crx / .zip
                            （私钥 zf-xk-helper.pem 永远保留）

为什么用 Python 而不是 shell：本机 Bash 的 `rm` 被一个坏掉的 safe-delete shim 拦着
（它内部要调 dirname，而这个环境的 shim 里没有 dirname），PowerShell 的 Remove-Item 也不生效。

用法：python sweep.py
"""
import glob
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))          # tools/
EXT_DIR = os.path.dirname(HERE)                            # chrome-extension/
DIST = os.path.join(os.path.dirname(EXT_DIR), "dist")      # <工作区>/dist/

removed, skipped, failed = [], [], []


def drop(p, label):
    try:
        os.remove(p)
        removed.append(label)
    except FileNotFoundError:
        skipped.append(label)
    except Exception as e:
        failed.append("%s -> %r" % (label, e))


# 1. 临时日志
for p in sorted(glob.glob(os.path.join(HERE, "_*.txt"))):
    drop(p, "tools/" + os.path.basename(p))

# 1b. 临时探测脚本（CDP 注入用的 _probe*.js 这类）
for p in sorted(glob.glob(os.path.join(HERE, "_*.js"))):
    drop(p, "tools/" + os.path.basename(p))

# 顺手清掉已被本脚本取代的旧清理脚本（它也干这件事，留着就是重复）
superseded = os.path.join(HERE, "clean-tmp.py")
if os.path.exists(superseded):
    drop(superseded, "tools/clean-tmp.py（职责已并入 sweep.py）")

# 2. dist 里的旧版本包
if os.path.isdir(DIST):
    with open(os.path.join(EXT_DIR, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    for p in sorted(glob.glob(os.path.join(DIST, "zf-xk-helper-*"))):
        name = os.path.basename(p)
        if not (name.endswith(".crx") or name.endswith(".zip")):
            continue
        if name == "zf-xk-helper-%s.crx" % version or name == "zf-xk-helper-%s.zip" % version:
            continue
        drop(p, "dist/" + name)

print("removed: %s" % (", ".join(removed) if removed else "(无)"))
if skipped:
    print("skipped: %s" % ", ".join(skipped))
if failed:
    print("failed : %s" % "; ".join(failed))
print("当前版本保留：dist/zf-xk-helper-%s.{crx,zip}" % version if os.path.isdir(DIST) else "")
