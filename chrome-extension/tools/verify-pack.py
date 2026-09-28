"""
独立校验打包产物。

存在的意义：pack-crx.mjs 的 ZIP 和 CRX 头都是手写的，**用它自己的校验器验自己没有意义**。
这里换 Python 标准库 zipfile / struct 再验一遍 —— 两套独立实现都通过，才算真的对。

用法：python verify-pack.py
退出码 0 = 全部通过。

校验项：
  1. .zip 能否被标准 zipfile 打开，逐条 CRC 是否一致
  2. .crx 的外壳（魔数 Cr24 / 版本 3 / 头长度）是否正确
  3. 从 .crx 里切出的内嵌 zip 是否与 .zip 完全一致
  4. manifest.json 是否合法、关键字段是否齐全、是否带 key
  5. content.js 里有没有误用 .filter / .some（本项目要求为 0）
  6. 自动跳转到选课页的符号是否都在产物里
  7. 账号 · 掉线自动重登（纯 JS RSA、session 存储、续抢）
  8. 直接调接口查询 · 参数自愈（不依赖页面「查询」按钮）
  9. 退选安全规则 · 时间筛选 · 定时开抢 · 冷却熔断
"""

import io
import json
import os
import re
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_DIR = os.path.dirname(HERE)
DIST = os.path.join(os.path.dirname(EXT_DIR), "dist")


class _Tee(object):
    """同时写控制台和 UTF-8 报告文件。

    Windows 控制台是 GBK，PowerShell 把输出重定向走会二次解码成乱码 ——
    所以报告由 Python 自己写，别指望 shell 的重定向。
    """

    def __init__(self, path):
        self.f = open(path, "w", encoding="utf-8", buffering=1)

    def write(self, s):
        try:
            sys.__stdout__.write(s)
        except Exception:
            pass
        self.f.write(s)
        return len(s)

    def flush(self):
        try:
            sys.__stdout__.flush()
        except Exception:
            pass
        self.f.flush()


if os.environ.get("VERIFY_NO_TEE") != "1":
    sys.stdout = _Tee(os.path.join(HERE, "_verify.txt"))

failures = []


def ok(cond, label, detail=""):
    tag = "✔" if cond else "✘"
    print("  %s %s%s" % (tag, label, ("  " + detail) if detail else ""))
    if not cond:
        failures.append(label)
    return cond


def strip_comments(src):
    """粗剥注释，用来区分「真的调用了 .filter」和「只是在注释里提到它」。

    够用即可，不是完整 JS 词法分析：
      - 先去掉 /* ... */（非贪婪、跨行）
      - 再去掉 // 行注释，但要求 // 前面不是 ':'，以免砍掉字符串里的 http://
    """
    import re
    src = re.sub(r"/\*[\s\S]*?\*/", "", src)
    lines = []
    for line in src.split("\n"):
        lines.append(re.sub(r"(^|[^:])//.*$", r"\1", line))
    return "\n".join(lines)


def main():
    with open(os.path.join(EXT_DIR, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest["version"]

    crx_path = os.path.join(DIST, "zf-xk-helper-%s.crx" % version)
    zip_path = os.path.join(DIST, "zf-xk-helper-%s.zip" % version)

    print("校验 zf-xk-helper-%s" % version)
    ok(os.path.isfile(crx_path), "crx 存在", crx_path)
    ok(os.path.isfile(zip_path), "zip 存在", zip_path)
    if failures:
        return 1

    # 1. zip
    print("\n[1] 独立打开 .zip")
    with zipfile.ZipFile(zip_path) as zf:
        names = sorted(zf.namelist())
        print("     条目 %d 个：%s" % (len(names), ", ".join(names)))
        ok(zf.testzip() is None, "所有条目 CRC 一致")
        zip_manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        content = zf.read("content.js").decode("utf-8")
        rsa = zf.read("rsa-pkcs1.js").decode("utf-8")
        bg = zf.read("background.js").decode("utf-8")
        has_manifest = "manifest.json" in names
        ok(has_manifest, "manifest.json 在包里")
        for name in ("background.js", "rsa-pkcs1.js", "content.js", "popup.html", "popup.js"):
            ok(name in names, "%s 在包里" % name)
        ok(bool(manifest.get("key")), "manifest 带 key（扩展 ID 固定）", "len=%d" % len(manifest.get("key", "")))

    # 2. crx 外壳
    print("\n[2] .crx 外壳")
    with open(crx_path, "rb") as f:
        blob = f.read()
    magic = blob[0:4]
    crx_version = struct.unpack("<I", blob[4:8])[0]
    header_len = struct.unpack("<I", blob[8:12])[0]
    zip_off = 12 + header_len
    ok(magic == b"Cr24", "魔数 = Cr24", repr(magic))
    ok(crx_version == 3, "CRX 版本 = 3", str(crx_version))
    ok(0 < header_len < 65536, "头长度合理", str(header_len))
    ok(len(blob) > zip_off, "zip 偏移在文件内", "offset=%d" % zip_off)

    # 3. 内嵌 zip 一致性
    print("\n[3] 内嵌 zip")
    embedded = blob[zip_off:]
    with zipfile.ZipFile(io.BytesIO(embedded)) as zf:
        enames = sorted(zf.namelist())
        ok(zf.testzip() is None, "内嵌 zip 所有条目 CRC 一致")
        ok(enames == names, "文件列表与 .zip 完全一致")
        ok(json.loads(zf.read("manifest.json").decode("utf-8")) == zip_manifest, "内嵌 manifest 内容一致")
    with open(zip_path, "rb") as f:
        ok(f.read() == embedded, "内嵌 zip 字节级等于 .zip")

    # 4. manifest 字段
    print("\n[4] manifest 关键字段")
    ok(manifest.get("manifest_version") == 3, "manifest_version = 3")
    ok(manifest.get("permissions") == ["storage"], "权限只有 storage",
       json.dumps(manifest.get("permissions")))
    cs = manifest.get("content_scripts") or [{}]
    # 注入范围必须同时覆盖选课模块和主菜单 —— 缺了 /xtgl/* 自动跳转就不会在登录落地页生效
    want_matches = ["*://*/xsxk/*", "*://*/xtgl/*"]
    ok(cs[0].get("matches") == want_matches, "注入范围正确", json.dumps(cs[0].get("matches")))
    # rsa-pkcs1.js 必须排在 content.js 前面：content.js 执行时就调用 window.ZFRSA
    ok(cs[0].get("js") == ["rsa-pkcs1.js", "content.js"], "注入顺序：先 RSA 再 content",
       json.dumps(cs[0].get("js")))
    # 后台 SW 只干一件事：放开 session 存储给内容脚本
    ok((manifest.get("background") or {}).get("service_worker") == "background.js",
       "有 background.service_worker", json.dumps(manifest.get("background")))
    for p in ("icons", "action"):
        ok(bool(manifest.get(p)), "有 %s" % p)
    for name in ("icons/icon16.png", "icons/icon48.png", "icons/icon128.png"):
        ok(name in names, "图标在包里：%s" % name)

    # 5. content.js 卫生
    print("\n[5] content.js 卫生检查")
    code = strip_comments(content)
    ok(code.count(".filter(") == 0, ".filter( 调用为 0", "实际 %d" % code.count(".filter("))
    ok(code.count(".some(") == 0, ".some( 调用为 0", "实际 %d" % code.count(".some("))
    ok(content.count(".filter(") - code.count(".filter(") <= 2, "对 .filter 的提及只出现在注释里")
    ok(code.count("where(") > 0, "使用了自实现的 where()", "%d 处" % code.count("where("))
    ok(version in content, "版本号已同步到 content.js")

    # ---- 自动跳转功能必须在产物里（v2.2.0 的核心）----
    print("\n[6] 自动跳转到选课页")
    ok("detectPageState" in code, "有页面判定函数 detectPageState")
    ok("resolveSelectUrl" in code, "有跳转地址解析 resolveSelectUrl")
    ok("gotoBlockReason" in code, "有防死循环闸 gotoBlockReason")
    ok("autoGoto" in code, "有 autoGoto 设置项")
    ok("zzxkyzb_cxZzxkYzbIndex" in code, "有选课页地址的回落值")
    # 判定必须放在挂面板之前，否则非选课页也会杵一个面板出来
    i_state = code.find("var PAGE_STATE")
    i_mount = code.find("function mount()")
    ok(0 < i_state < i_mount, "启动闸门排在挂面板之前",
       "PAGE_STATE@%d mount@%d" % (i_state, i_mount))

    popup = ""
    with zipfile.ZipFile(zip_path) as zf:
        popup = zf.read("popup.html").decode("utf-8")
    ok('id="goto"' in popup, "弹窗里有「带我去选课页」按钮")

    # ---- 账号 · 掉线自动重登（v2.3.0 的核心）----
    print("\n[7] 账号与掉线自动重登")
    ok("function doLogin" in code, "有登录实现 doLogin")
    ok("function checkSession" in code, "有登录态探测 checkSession")
    ok("function autoLoginOnLoginPage" in code, "有登录页自愈 autoLoginOnLoginPage")
    ok("function onSessionLost" in code, "有掉线处理 onSessionLost")
    ok("function looksLikeLoginHtml" in code, "有「响应即登录页」识别 looksLikeLoginHtml")
    ok("ZFRSA" in code, "走纯 JS RSA（window.ZFRSA）")
    ok("encryptPassword" in rsa, "rsa-pkcs1.js 暴露 encryptPassword")
    ok("PKCS1" in rsa or "0x02" in rsa, "是 PKCS#1 v1.5 填充（块头 0x00 0x02）")
    ok("setAccessLevel" in bg, "background 放开 session 存储权限")
    ok("storage.session" in code, "密码默认存 memory-only 的 storage.session")
    ok("SESSION_LOST" in code, "掉线用 SESSION_LOST 标记向上抛")
    # 密码绝不能进导出配置：导出语句本身只许带 opts / targets
    i_exp = code.find("JSON.stringify({ v: VERSION, opts: OPTS, targets: targets }")
    ok(i_exp > 0, "找到导出配置的语句")
    ok(i_exp > 0 and "CRED" not in code[i_exp:i_exp + 200], "导出配置不含账号字段")
    # 登录页提示的 toast 要在 panel 不存在时也能显示
    ok("zxh-login-tip" in code, "登录页提示用独立 toast（未挂面板时也能提示）")
    # 重登后必须回到抢课循环
    ok("maybeResumeAfterRelogin" in code, "重登成功后会续抢")

    # ---- 无按钮查询 / 参数自愈（v2.4.0 的核心）----
    print("\n[8] 直接调接口查询（不依赖页面「查询」按钮）")
    ok("zzxkyzb_cxZzxkYzbPartDisplay.html" in code, "直接 POST 课程列表接口（课程查询的真正端点）")
    ok("zzxkyzb_cxZzxkYzbDisplay.html" in code, "用 Display 片段补参数（bklx_id 只有它里面有）")
    ok("function inputsFromHtml" in code, "有隐藏域解析 inputsFromHtml")
    ok("function decodeEntities" in code, "有 HTML 实体还原")
    ok("var HID_FALLBACK" in code, "有 first* 回落表 HID_FALLBACK")
    for name in ("firstKklxdm", "firstKklxmc", "firstXkkzId", "firstXkkzXh", "firstNjdmId", "firstZyhId"):
        ok(name in code, "回落目标存在：%s" % name)
    ok("var CRITICAL_PARAMS" in code, "有关键参数清单 CRITICAL_PARAMS")
    for p in ("'kklxdm'", "'bklx_id'", "'xkkz_xh'"):
        ok(p in code, "关键参数含 %s" % p.strip("'"))
    ok("function ctxH" in code, "有参数读取 ctxH（DOM > 自补 > first*）")
    ok("function ctxSrc" in code, "有来源标注 ctxSrc")
    ok("function paramReport" in code, "有参数体检 paramReport")
    ok("function harvestServerCtx" in code, "有服务器自补 harvestServerCtx")
    ok("async function ensureParamsReady" in code, "有就绪保证 ensureParamsReady")
    ok("var CTX_OVERRIDE" in code, "有自补参数覆盖层")
    # 查询必须先过参数体检 —— 否则页面脚本没跑时会静默返回 0 门课
    i_q = code.find("async function queryCourses")
    i_q_end = code.find("async function queryClasses")
    seg_q = code[i_q:i_q_end if i_q_end > i_q else i_q + 3000]
    ok("ensureParamsReady" in seg_q, "queryCourses 开头先做参数就绪检查")
    ok(seg_q.count("paramReport()") >= 1, "对「0 门课」做了额外参数体检", "%d 处" % seg_q.count("paramReport()"))
    # 「点按钮」只能出现在兜底里，不能是主路径
    i_click = code.find("btn.click()")
    i_ens = code.find("async function ensureParamsReady")
    ok(i_click > i_ens > 0, "click() 只作为 ensureParamsReady 里的兜底")

    # ---- 退选 / 换课 / 定时 / 筛选（v2.5.0 的核心）----
    print("\n[9] 退选安全规则 · 时间筛选 · 定时开抢 · 冷却熔断")
    # 退选接口本身
    ok("zzxkyzb_tuikBcZzxkYzb.html" in code, "有退选接口 tuikBcZzxkYzb")
    ok("function dropCourse" in code, "有退选实现 dropCourse")
    ok("txbsfrl" in code, "退选带上 txbsfrl")
    # ★ 安全铁律：只退 kklxdm=10 且 rwlx=2
    ok("function isDroppable" in code, "有可退性判定 isDroppable")
    i_drop = code.find("function isDroppable")
    seg_drop = code[i_drop:i_drop + 400]
    ok("'10'" in seg_drop and "'2'" in seg_drop, "可退判定写死 kklxdm=10 且 rwlx=2")
    ok("kklxdm" in seg_drop and "rwlx" in seg_drop, "可退判定同时看两个字段")
    # 自动退选必须默认关闭
    m_ad = re.search(r"autoDrop:\s*(true|false)", code)
    ok(m_ad is not None, "OPTS 里有 autoDrop 开关")
    ok(m_ad is not None and m_ad.group(1) == "false", "★ autoDrop 默认 false（不显式打开就绝不自己退课）")
    # 冲突处理链路
    ok("function resolveConflict" in code, "有冲突自动重选 resolveConflict")
    ok("function findConflictVictim" in code, "有冲突源定位 findConflictVictim")
    ok("function isConflictMsg" in code, "有冲突判定 isConflictMsg")
    ok("function dropReplaceCourse" in code, "有换课 dropReplaceCourse")
    ok("replaceKch" in code, "目标支持「替换课程号」")
    # 换课只允许在 autoDrop 打开时动手
    i_rep = code.find("var okGo = await dropReplaceCourse(t)")
    seg_rep = code[i_rep - 200:i_rep + 60]
    ok(i_rep > 0 and "OPTS.autoDrop" in seg_rep, "换课受 autoDrop 开关管制")

    # 上课时间结构化解析
    ok("function parseWeeks" in code, "有周次解析 parseWeeks")
    ok("function parseSchedule" in code, "有课表解析 parseSchedule")
    ok("function schedulesOverlap" in code, "有冲突判定 schedulesOverlap")
    ok("function matchScheduleFilters" in code, "有结构化时间筛选 matchScheduleFilters")
    ok("function classConflictsWithChoosed" in code, "有本地冲突预判 classConflictsWithChoosed")
    ok("单" in code and "双" in code, "周次支持单双周")
    # 解析不出时不拦（防误挡）
    i_msf = code.find("function matchScheduleFilters")
    seg_msf = code[i_msf:i_msf + 1600]
    ok("if (!segs) return { ok: true }" in seg_msf, "★ sksj 解析不出时不拦（免得格式不同就把课全挡光）")

    # 定时开抢
    ok("function parseStartAt" in code, "有定时解析 parseStartAt")
    ok("function fmtCountdown" in code, "有倒计时格式化 fmtCountdown")
    i_rl = code.find("async function runLoop")
    seg_rl = code[i_rl:i_rl + 2500]
    ok("startAt" in seg_rl, "runLoop 里做了定时开抢")
    ok("await sleep(" in seg_rl and "Date.now() < startAt" in seg_rl, "未到点只倒数、不发请求")

    # 冷却 + 熔断 + 互斥
    ok("function targetReady" in code, "有冷却判定 targetReady")
    ok("function cooldownTarget" in code, "有冷却设置 cooldownTarget")
    ok("OPTS.cooldownMs" in code, "提交失败后按 cooldownMs 冷却")
    ok("maxFailStreak" in code, "有连续失败熔断阈值")
    ok("state.querying" in code, "tick 有重入互斥锁 state.querying")
    ok("function bumpFail" in code, "有失败计数 bumpFail")

    # 提示音 + xkgz 兜底 + 教学班参数修正
    ok("function beep" in code, "有提示音 beep（WebAudio，无权限依赖）")
    ok("AudioContext" in code or "webkitAudioContext" in code, "用 WebAudio 合成提示音")
    ok("function xkkzFromXkgz" in code, "有 xkgz → xkkz_id 兜底")
    i_bcf = code.find("function buildClassForm")
    seg_bcf = code[i_bcf:i_bcf + 1200]
    ok("xkxskcgskg" in seg_bcf, "教学班参数补齐 xkxskcgskg")
    ok("jxbzcxskg" in seg_bcf, "教学班参数补齐 jxbzcxskg")
    ok("f.delete('kspage')" in seg_bcf, "教学班参数里剔掉分页字段")

    print("")
    if failures:
        print("结论：%d 项未通过 —— %s" % (len(failures), "；".join(failures)))
        return 1
    print("结论：全部通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main())
