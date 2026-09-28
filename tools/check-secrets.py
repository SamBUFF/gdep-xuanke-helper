#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
提交前守卫：确保没有敏感文件或真实凭据进入版本库。

背景：本仓库托管在**个人账号的私有仓库**下，拿不到 GitHub 的
Secret Protection / push protection（那需要 GitHub Advanced Security，
而 GHAS 对个人账号的私有仓库不开放）。所以用这个脚本自己兜住这道防线。

它检查**已纳入版本控制的文件**（也就是一旦 push 就会公开出去的那些），三类问题：

  A. 不该入库的路径   —— config.json（明文密码）、*.pem（扩展私钥）、*.crx、*.log、dist/
  B. 凭据特征串       —— 私钥头、GitHub token、AWS key、非空的 password 赋值
  C. 真实学号         —— 10 位、以 26 开头的数字（本仓库的已知泄漏向量）
                          占位符 2026000001 / 2026000002 不会命中（它们以 20 开头）

用法：
    python tools/check-secrets.py          # 有问题 -> 退出码 1
    python tools/check-secrets.py -v       # 同时列出扫描了哪些文件

在 GitHub Actions 里会自动输出 ::error:: 注解，直接标在 PR 上。
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"

# ---- A. 不该入库的路径 ----------------------------------------------------
DENY_BASENAME = {"config.json"}
DENY_SUFFIX = (".pem", ".key", ".p12", ".pfx", ".crx", ".log")
DENY_PREFIX = ("dist/",)

# ---- B. 凭据特征串 --------------------------------------------------------
# 注意：这里只写"能匹配到"的模式，别在注释里写真实样本，否则脚本会举报自己。
SECRET_PATTERNS = [
    ("私钥文件头", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b")),
    ("GitHub PAT(细粒度)", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("AWS Access Key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b")),
]

# password 赋值单独用函数判断，比堆一个巨型正则可靠得多
PW_ASSIGN = re.compile(r'["\']?password["\']?\s*[:=]\s*["\']([^"\']*)["\']', re.I)
PW_PLACEHOLDERS = {"", "...", "……", "password", "changeme", "your_password", "todo"}
PW_MASK_CHARS = set("*xX.·—- ")


def looks_like_real_password(v):
    """判断 password 字段里的是不是真密码（用于跳过模板/掩码/说明文字）。

    跳过规则：太短、含中文（说明文字）、是占位词、整串都是掩码字符。
    """
    s = (v or "").strip()
    if len(s) < 6:
        return False
    if any("\u4e00" <= ch <= "\u9fff" for ch in s):
        return False
    if s.lower() in PW_PLACEHOLDERS:
        return False
    if s and set(s) <= PW_MASK_CHARS:
        return False
    return True


# ---- C. 真实学号 ----------------------------------------------------------
# 本校学号形如 26xxxxxx xx（10 位、26 开头）。占位符一律 20260000xx，不会命中。
STUDENT_ID = re.compile(r"(?<!\d)26\d{8}(?!\d)")

TEXT_SUFFIX = {".js", ".mjs", ".cjs", ".ts", ".py", ".md", ".json", ".jsonc",
               ".html", ".htm", ".css", ".yml", ".yaml", ".sh", ".txt", ".example"}
MAX_BYTES = 4 * 1024 * 1024


def err(msg):
    if IN_CI:
        # 在 Actions 里输出注解，直接标在 PR / commit 上
        print("::error::" + msg)
    print("✘ " + msg)


def tracked_files():
    """已纳入版本控制的文件（相对仓库根的 POSIX 路径）。"""
    try:
        r = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT,
                           capture_output=True, timeout=60)
        if r.returncode == 0:
            out = r.stdout.decode("utf-8", "replace")
            return [p for p in out.split("\0") if p]
    except (OSError, subprocess.SubprocessError):
        pass
    # 退路：没有 git 就走目录（此时没有 .gitignore 过滤，只会更严格）
    files = []
    for dp, dns, fns in os.walk(ROOT):
        dns[:] = [d for d in dns if d != ".git"]
        for f in fns:
            full = os.path.join(dp, f)
            files.append(os.path.relpath(full, ROOT).replace(os.sep, "/"))
    return files


def main():
    verbose = "-v" in sys.argv
    files = tracked_files()
    problems = []

    if verbose:
        print("扫描 %d 个受版本控制的文件\n" % len(files))

    for rel in files:
        base = os.path.basename(rel)

        # --- A. 路径 ---
        if base in DENY_BASENAME:
            problems.append((rel, None, "不该入库的文件（含账号/明文密码），应写进 .gitignore"))
            continue
        if rel.lower().endswith(DENY_SUFFIX) or rel.startswith(DENY_PREFIX):
            problems.append((rel, None, "不该入库的文件类型（私钥 / 构建产物 / 日志）"))
            continue

        # --- B / C. 内容 ---
        ext = os.path.splitext(base)[1].lower()
        if ext not in TEXT_SUFFIX:
            continue
        full = os.path.join(ROOT, rel.replace("/", os.sep))
        try:
            if os.path.getsize(full) > MAX_BYTES:
                continue
            with open(full, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except (OSError, UnicodeDecodeError):
            continue

        for i, line in enumerate(lines, 1):
            for label, pat in SECRET_PATTERNS:
                if pat.search(line):
                    problems.append((rel, i, "疑似凭据：%s" % label))
            for m in PW_ASSIGN.finditer(line):
                if looks_like_real_password(m.group(1)):
                    problems.append((rel, i, "疑似真实密码赋值（模板请留空或用占位符）"))
                    break
            if STUDENT_ID.search(line):
                problems.append((rel, i, "疑似真实学号（应改为 20260000xx 占位符）"))

    for rel, line, why in problems:
        loc = "%s:%s" % (rel, line) if line else rel
        err("%s —— %s" % (loc, why))

    if problems:
        print("\n共 %d 处问题。确认是误报的话，调整 tools/check-secrets.py 里的规则。" % len(problems))
        return 1

    print("✔ 敏感文件与凭据检查通过（%d 个文件）" % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
