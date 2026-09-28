#!/usr/bin/env node
/**
 * gdep-grab —— 广东工程职业技术学院 正方教务「自主选课」自动选课脚本
 *
 * 用法：
 *   node grab.mjs --list                     只登录并列出当前可选课程（最安全，先跑这个）
 *   node grab.mjs --dry-run                  走完整流程但不真正提交（演练）
 *   node grab.mjs                            按 config.json 正式抢课
 *   node grab.mjs --account 2026000001 --course 篮球 --course 羽毛球
 *   node grab.mjs --quick                    一键选课（提交该轮次已保存的全部意向）
 *
 * 说明：脚本只使用你自己的账号在你自己的教务系统里操作，请自行控制频率并遵守学校规定。
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { Session, sleep, jitterSleep } from './lib/http.mjs';
import * as zf from './lib/zf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------ 基础工具

const DEFAULTS = {
  baseUrl: 'https://zf.gdep.edu.cn',
  intervalMs: 1500,
  jitterMs: 500,
  maxAttempts: 0, // 0 = 不限次数，跑到抢到或手动停止
  timeoutMs: 20000,
  concurrency: 1,
  confirmBeforeSubmit: false,
  dateWindow: { start: null, end: null },
};

function parseArgs(argv) {
  const out = { _: [], course: [], account: [] };
  const multi = new Set(['course', 'account']);
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) {
      out._.push(t);
      continue;
    }
    const key = t.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      if (multi.has(key)) out[key].push(next);
      else out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);

function log(...args) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${args.join(' ')}`;
  process.stdout.write(line + '\n');
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {
    /* 日志写不进去就算了 */
  }
}

function readConfig(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到配置文件：${file}\n请先复制 config.example.json 为 config.json 并填写账号。`);
  }
  const raw = fs.readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置文件不是合法 JSON：${e.message}`);
  }
  cfg = { ...DEFAULTS, ...cfg };
  cfg.accounts = Array.isArray(cfg.accounts) ? cfg.accounts : [];
  if (!cfg.accounts.length) throw new Error('config.json 里没有配置任何账号');

  for (const a of cfg.accounts) {
    if (a.passwordEnv && process.env[a.passwordEnv]) a.password = process.env[a.passwordEnv];
    a.targets = Array.isArray(a.targets) ? a.targets : [];
  }
  return cfg;
}

function parseLocalTime(s) {
  if (!s) return null;
  const t = new Date(String(s).replace(/-/g, '/')).getTime();
  return Number.isNaN(t) ? null : t;
}

function fmtRemain(c) {
  const cap = Number(c.jxbrl) || 0;
  const used = Number(c.yxzrs) || 0;
  return `${used}/${cap}`;
}

// ------------------------------------------------------------------ 目标匹配

function matchCourse(course, target) {
  const name = String(course.kcmc ?? '').trim();
  const code = String(course.kch ?? '').trim();
  if (target.kchId && course.kch_id === target.kchId) return true;
  if (target.courseCode && code === String(target.courseCode).trim()) return true;
  if (target.courseCodeContains && code.includes(String(target.courseCodeContains))) return true;
  if (target.course && name === String(target.course).trim()) return true;
  if (target.courseContains && name.includes(String(target.courseContains))) return true;
  if (target.courseRegex && new RegExp(target.courseRegex).test(name)) return true;
  return false;
}

function pickClass(classes, target) {
  let list = classes.filter((c) => c.do_jxb_id && c.do_jxb_id !== 'undefined');
  if (!list.length) list = classes.slice();
  if (!list.length) return null;

  if (target.teacher) {
    const hit = list.filter((c) => String(c.jsxx ?? '').includes(String(target.teacher)));
    if (hit.length) list = hit;
  }
  if (target.classKeyword) {
    const hit = list.filter((c) => String(c.jsxx ?? '').includes(String(target.classKeyword)));
    if (hit.length) list = hit;
  }
  const remain = (c) => (Number(c.jxbrl) || 0) - (Number(c.yxzrs) || 0);
  if (target.preferMostRemain !== false) list.sort((a, b) => remain(b) - remain(a));
  return list[0];
}

// ------------------------------------------------------------------ 单账号流程

class AccountRunner {
  constructor(acct, cfg, opts) {
    this.acct = acct;
    this.cfg = cfg;
    this.opts = opts;
    this.tag = `[${acct.name || acct.username}]`;
    this.session = new Session(cfg.baseUrl, { timeoutMs: cfg.timeoutMs });
    this.ctx = null;
    this.ctxLoadedAt = 0;
    this.done = new Set();
    this.stats = { attempts: 0, submits: 0, success: 0, failures: 0 };
  }

  local(...a) {
    log(this.tag, ...a);
  }

  async login() {
    const r = await zf.login(this.session, this.acct);
    if (!r.ok) {
      this.local('❌ 登录失败：' + r.error);
      return false;
    }
    this.local('✅ 登录成功', this.acct.username);
    return true;
  }

  /** 拉取 / 刷新选课页上下文；会话失效时自动重新登录 */
  async refreshContext({ force = false } = {}) {
    const stale = Date.now() - this.ctxLoadedAt > 5 * 60 * 1000;
    if (this.ctx && !force && !stale) return this.ctx;

    let r = await zf.loadSelectContext(this.session);
    if (r.expired) {
      this.local('会话失效，重新登录…');
      if (!(await this.login())) throw new Error('重新登录失败');
      r = await zf.loadSelectContext(this.session);
    }
    if (!r.ctx) throw new Error(r.reason || '无法加载选课页上下文');
    this.ctx = r.ctx;
    this.ctxLoadedAt = Date.now();
    return this.ctx;
  }

  describeContext(ctx) {
    this.local(
      `轮次：${ctx.xkxnmc}-${ctx.xkxqmc} 第${ctx.xklc}轮 / 类别 ${ctx.kklxmc}(${ctx.kklxdm}) / 选课开放：${
        ctx.iskxk === '1' ? '是' : '否'
      }`,
    );
    if (ctx.xkkssj && ctx.xkjssj) this.local(`选课时间：${ctx.xkkssj} ~ ${ctx.xkjssj}`);
    this.local(`已选学分 ${ctx.zxfs ?? '?'}，选课门次上限 ${ctx.xkzgmc || ctx.zkcs || '?'}`);
  }

  /** --list 模式：列出当前可选课程 */
  async listCourses() {
    const ctx = await this.refreshContext();
    this.describeContext(ctx);
    const r = await zf.queryAllCourses(this.session, ctx);
    if (!r.ok) {
      this.local('❌ 查询失败：' + r.reason);
      return false;
    }
    if (!r.courses.length) {
      this.local('当前没有可选课程（可能未开放或已选满）');
      return true;
    }
    this.local(`共 ${r.courses.length} 门课程：`);
    for (const c of r.courses) {
      this.local(`  · ${c.kcmc} [${c.kch}] ${c.xf}学分  ${c.kklxmc ?? ''}`);
    }
    return true;
  }

  /** 返回 { submitted, reason } */
  async tryGrab(target, { dryRun, confirmFn }) {
    const ctx = await this.refreshContext();
    const q = await zf.queryAllCourses(this.session, ctx);
    this.stats.attempts++;
    if (!q.ok) {
      this.local('查询失败：' + q.reason);
      return { submitted: false, reason: 'query-failed' };
    }

    const course = q.courses.find((c) => matchCourse(c, target));
    if (!course) {
      return { submitted: false, reason: 'not-found' };
    }

    const kchId = course.kch_id;
    const cls = await zf.queryClasses(this.session, ctx, kchId);
    if (!cls.ok) {
      this.local(`${course.kcmc} 教学班查询失败：${cls.reason}`);
      return { submitted: false, reason: 'class-query-failed' };
    }
    const picked = pickClass(cls.classes, target);
    if (!picked) {
      this.local(`${course.kcmc} 暂无可选教学班`);
      return { submitted: false, reason: 'no-class' };
    }

    const info = `${course.kcmc} / 教学班 ${
      String(picked.jsxx ?? '').split('/')[1] || picked.jxb_id
    } / 已选 ${fmtRemain(picked)} / ${picked.sksj ?? ''}`;

    // 冲突预检（零副作用）
    const pre = await zf.checkConflict(this.session, ctx, kchId, picked.do_jxb_id);
    const preFlag = pre.data && pre.data.flag;
    if (preFlag !== '1') {
      this.local(`⚠️ ${info} 预检未通过 flag=${preFlag} ${pre.data?.msg ?? pre.raw.slice(0, 80)}`);
      return { submitted: false, reason: 'precheck-' + preFlag };
    }

    if (dryRun) {
      this.local(`🧪 [dry-run] 条件满足，本应提交：${info}`);
      return { submitted: true, dryRun: true, reason: 'dry-run' };
    }

    if (confirmFn) {
      const yes = await confirmFn(info);
      if (!yes) {
        this.local('已按你的选择跳过提交（本轮不再尝试该课程）');
        return { submitted: false, reason: 'declined' };
      }
    }

    const res = await zf.submitCourse(this.session, ctx, {
      kchId,
      kcmc: course.kcmc,
      doJxbId: picked.do_jxb_id,
    });
    this.stats.submits++;
    if (res.ok) {
      this.local(`🎉 选课成功：${info}`);
      return { submitted: true, success: true, reason: 'ok', info };
    }
    const why = res.data?.msg || res.raw.slice(0, 120);
    this.local(`❌ 提交失败：${info} → flag=${res.flag} ${why}`);
    return { submitted: true, success: false, reason: 'rejected', info };
  }

  /** 一键选课模式 */
  async runQuick({ dryRun }) {
    const ctx = await this.refreshContext();
    this.describeContext(ctx);
    if (dryRun) {
      this.local('🧪 [dry-run] 本应调用一键选课，xkkz_id=' + ctx.xkkz_id);
      return true;
    }
    const res = await zf.submitQuick(this.session, ctx);
    if (res.ok) {
      this.local('🎉 一键选课已提交成功');
      return true;
    }
    this.local(`❌ 一键选课失败：flag=${res.flag} ${res.data?.msg ?? res.raw.slice(0, 120)}`);
    return false;
  }

  async run({ dryRun, confirmFn }) {
    // 空密码直接拦掉，不要拿真账号去打一次必然失败的登录（避免触发失败次数锁定）
    if (!this.acct.password) {
      this.local(
        '❌ 未配置密码，已跳过（不发起登录，避免触发失败次数锁定）。' +
          '请填写 config.json 里的 password，或用环境变量 + passwordEnv。',
      );
      return { ok: false };
    }
    if (!(await this.login())) return { ok: false };

    if (this.opts.list) return { ok: await this.listCourses() };
    if (this.opts.quick) return { ok: await this.runQuick({ dryRun }) };

    const targets = this.acct.targets;
    if (!targets.length) {
      this.local('没有配置要抢的课程（targets 为空），用 --course 指定或改 config.json');
      return { ok: false };
    }

    const ctx0 = await this.refreshContext();
    this.describeContext(ctx0);
    this.local('目标：' + targets.map((t) => t.course || t.courseCode || t.kchId).join('、'));

    // 等选课窗口开启
    const openAt = parseLocalTime(ctx0.xkkssj);
    const closeAt = parseLocalTime(ctx0.xkjssj);
    if (openAt && Date.now() < openAt) {
      this.local(`选课还没开始，等待到 ${ctx0.xkkssj} …`);
      while (Date.now() < openAt) await sleep(Math.min(5000, openAt - Date.now()));
      this.local('选课窗口已开启，开始轮询');
    }
    if (ctx0.iskxk !== '1') this.local('⚠️ 页面显示选课状态未开启，仍然继续尝试');

    const pending = () => targets.filter((t) => !this.done.has(this.targetKey(t)));
    let attempt = 0;
    let lastReason = '';

    while (pending().length) {
      if (this.opts.maxAttempts && attempt >= this.opts.maxAttempts) {
        this.local(`已达到最大尝试次数 ${this.opts.maxAttempts}，停止`);
        break;
      }
      if (closeAt && Date.now() > closeAt) {
        this.local('选课时间已结束，停止');
        break;
      }
      attempt++;

      for (const target of pending()) {
        const label = target.course || target.courseCode || target.kchId;
        const r = await this.tryGrab(target, { dryRun, confirmFn });
        if (r.success) {
          this.done.add(this.targetKey(target));
          this.stats.success++;
        } else if (r.reason === 'declined' || (r.dryRun && r.submitted)) {
          this.done.add(this.targetKey(target));
        } else if (r.reason === 'not-found') {
          if (lastReason !== 'not-found') this.local(`⏳ 还没有可选名额，持续轮询中（课程：${label}）`);
          lastReason = 'not-found';
        } else if (r.submitted === false && r.reason !== lastReason) {
          this.local(`⏳ ${label} 状态：${r.reason}`);
          lastReason = r.reason;
        }
        if (pending().length === 0) break;
        await jitterSleep(300, 300); // 同一账号内多目标之间稍作间隔
      }

      if (!pending().length) break;
      await jitterSleep(this.cfg.intervalMs, this.cfg.jitterMs);
    }

    const left = pending().map((t) => t.course || t.courseCode || t.kchId);
    this.local(
      `结束：成功 ${this.stats.success} 个，提交 ${this.stats.submits} 次${left.length ? '，未完成：' + left.join('、') : ''}`,
    );
    return { ok: this.stats.success > 0 };
  }

  targetKey(t) {
    return t.course || t.courseCode || t.kchId || JSON.stringify(t);
  }
}

// ------------------------------------------------------------------ 入口

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfgFile = path.resolve(__dirname, args.config || 'config.json');

  if (args.help) {
    process.stdout.write(
      [
        '用法：node grab.mjs [选项]',
        '',
        '  --list                只登录并列出当前可选课程',
        '  --dry-run             完整演练，但不真正提交选课',
        '  --quick               一键选课（提交该轮次已保存的全部意向）',
        '  --confirm             提交前在终端里人工确认',
        '  --account <名字>      只跑指定账号（可重复，匹配 name 或 username）',
        '  --course <课程名>     只抢指定课程（可重复，覆盖 config 里的 targets）',
        '  --max-attempts <n>    最多轮询多少轮后放弃（默认不限）',
        '  --interval <ms>       轮询间隔毫秒（默认 1500）',
        '  --config <文件>       指定配置文件（默认 config.json）',
        '',
      ].join('\n'),
    );
    return;
  }

  let cfg;
  try {
    cfg = readConfig(cfgFile);
  } catch (e) {
    log('❌ ' + e.message);
    process.exitCode = 1;
    return;
  }
  if (args.interval) cfg.intervalMs = Number(args.interval);
  if (args['max-attempts']) cfg.maxAttempts = Number(args['max-attempts']);

  const accounts = cfg.accounts.filter((a) => a.enabled !== false);
  const selected = accounts.length ? accounts : cfg.accounts;

  let targets = cfg.accounts.flatMap((a) => a.targets || []).map((t) => ({ ...t }));
  const filterAccounts = args.account.length ? args.account : null;
  const overrideCourses = args.course.length ? args.course.map((c) => ({ course: c })) : null;

  const finalAccounts = selected.filter((a) => {
    if (!filterAccounts) return true;
    return filterAccounts.some((f) => f === a.name || f === a.username);
  });

  if (!finalAccounts.length) {
    log('❌ 没有匹配到账号。可用账号：' + cfg.accounts.map((a) => a.name || a.username).join('、'));
    process.exitCode = 1;
    return;
  }

  if (overrideCourses) {
    if (args.account.length === 1 && finalAccounts.length === 1) {
      finalAccounts[0].targets = overrideCourses;
    } else {
      for (const a of finalAccounts) a.targets = overrideCourses.map((t) => ({ ...t }));
    }
  } else if (!targets.length) {
    // 没配 targets 也没有 --course，提示但不直接退出（--list 仍然可用）
    if (!args.list && !args.quick) {
      log('⚠️ 未配置任何目标课程，只会执行登录检查。用 --course 指定，或编辑 config.json 的 targets。');
    }
  }

  const dryRun = Boolean(args['dry-run']);
  if (dryRun) log('🧪 dry-run 模式：不会真正提交任何选课');

  let confirmFn = null;
  if (args.confirm || cfg.confirmBeforeSubmit) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    confirmFn = async (info) => {
      const ans = await rl.question(`\n即将提交选课：${info}\n确认提交？(y/N) `);
      return /^y(es)?$/i.test(ans.trim());
    };
  }

  const opts = { list: Boolean(args.list), quick: Boolean(args.quick), maxAttempts: cfg.maxAttempts };
  const concurrency = Math.max(1, Math.min(Number(cfg.concurrency) || 1, finalAccounts.length));

  const runners = finalAccounts.map((a) => {
    const r = new AccountRunner(a, cfg, opts);
    r.opts = opts;
    return r;
  });

  log(`准备处理 ${runners.length} 个账号，并发 ${concurrency}`);

  // 简单并发调度：按批跑（同批内并发，批间串行），避免所有账号同时打同一台服务器
  let results = [];
  for (let i = 0; i < runners.length; i += concurrency) {
    const batch = runners.slice(i, i + concurrency);
    const batchRes = await Promise.all(
      batch.map(async (r) => {
        try {
          return await r.run({ dryRun, confirmFn });
        } catch (e) {
          log(r.tag, '❌ 异常：' + e.message);
          return { ok: false, error: e.message };
        }
      }),
    );
    results = results.concat(batchRes);
  }

  log('全部结束。总发出请求数（含登录/查询/提交）：' + runners.reduce((s, r) => s + r.session.requestCount, 0));
  process.exitCode = results.some((r) => r.ok) ? 0 : 1;
}

main().catch((e) => {
  log('❌ 未捕获异常：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
