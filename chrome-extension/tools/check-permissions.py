#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
扩展权限面守卫：权限一旦扩大就失败。

本项目的攻击面应该**只有这么多**：
  · permissions: ["storage"]        —— 存目标列表和（可选）账号密码
  · content_scripts: 只注入选课页/主菜单页，且 all_frames: false
  · 不发跨站请求、不读其它标签页、不碰 cookie API、不注入任意页面

它**不需要** tabs / cookies / webRequest / scripting / <all_urls>——
所有网络请求都在内容脚本里用页面自身的会话发出去（这也是为什么它能带上 SameSite=Lax 的 Cookie）。

主机名用 `*` 是**设计意图**（不绑学校），所以这里不拦主机通配，
只拦「路径范围超出选课/主菜单」以及上面那些高权限项。

用法：
    python check-permissions.py      # 有问题 -> 退出码 1
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(os.path.dirname(HERE), "manifest.json")
IN_CI = os.environ.get("GITHUB_ACTIONS") == "true"

ALLOWED_PERMS = {"storage"}
# 内容脚本允许注入的路径前缀：自主选课 与 主菜单/首页
ALLOWED_PATH_PREFIXES = ("/xsxk/", "/xtgl/")


def fail(msg, fails):
    """记录一处问题。CI 里额外发一条 ::error:: 注解，本地则直接打出来。"""
    if IN_CI:
        print("::error::" + msg)
    print("✘ " + msg)
    fails.append(msg)


def path_of(pattern):
    """从匹配模式里取出路径部分。'*://*/xsxk/*' -> '/xsxk/*'"""
    if "://" not in pattern:
        return None
    after = pattern.split("://", 1)[1]
    slash = after.find("/")
    return after[slash:] if slash >= 0 else "/"


def main():
    with open(MANIFEST, encoding="utf-8") as fh:
        m = json.load(fh)

    fails = []

    # ① permissions 只允许 storage
    perms = m.get("permissions", [])
    for p in perms:
        if p not in ALLOWED_PERMS:
            fail("出现了 storage 以外的权限：%s" % p, fails)

    # ② 不应声明的高权限字段
    if m.get("host_permissions"):
        fail("不应声明 host_permissions：%s" % m["host_permissions"], fails)
    if m.get("optional_permissions"):
        fail("不应声明 optional_permissions：%s" % m["optional_permissions"], fails)
    if m.get("externally_connectable"):
        fail("不应允许外部页面连接：%s" % m["externally_connectable"], fails)
    if m.get("web_accessible_resources"):
        fail("不应暴露 web_accessible_resources：%s" % m["web_accessible_resources"], fails)
    if m.get("background", {}).get("type") == "module" and m.get("background", {}).get("service_worker", "").startswith("http"):
        fail("background 不应加载远程脚本", fails)

    # ③ content_scripts：注入范围与路径
    scripts = m.get("content_scripts", [])
    if not scripts:
        fail("没有声明 content_scripts —— 扩展将不会做任何事", fails)
    for c in scripts:
        if c.get("all_frames"):
            fail("content_scripts 不应为 all_frames: true（会注入到每个 iframe）", fails)
        if c.get("match_about_blank"):
            fail("content_scripts 不应设置 match_about_blank", fails)
        if c.get("match_origin_as_fallback"):
            fail("content_scripts 不应设置 match_origin_as_fallback", fails)
        for pat in c.get("matches", []):
            if pat.startswith("<all_urls>"):
                fail("匹配范围过宽（<all_urls>）：%s" % pat, fails)
                continue
            p = path_of(pat)
            if p is None:
                fail("无法解析的匹配模式：%s" % pat, fails)
            elif not p.startswith(ALLOWED_PATH_PREFIXES):
                fail("注入路径超出选课/主菜单范围：%s" % pat, fails)

    if fails:
        print("\n共 %d 处问题。确实需要放宽的话，改的是这个脚本，而不是绕过它。" % len(fails))
        return 1

    print("✔ 权限面正常：permissions=%s" % perms)
    for c in scripts:
        print("  · 注入 %s  all_frames=%s" % (c.get("matches"), c.get("all_frames")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
