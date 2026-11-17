// magpie-cnb2api — 让 CNB 工作区里的 cnb2api 成为 magpie 的一个供应商。
//
// 解决两件事，都由插件自己的 setInterval 在 Bun 层完成：
//   1. 地址漂移：工作区每次重启，<subdomain>-<port>.cnb.run 都会变；
//   2. 工作区停止：平台会杀掉工作区，这里自动调 OpenAPI 重新拉起。
//
// 两条取地址的路子都试，谁先成功用谁：
//   a) GET /{repo}/-/workspace/detail/{sn} 的 webide 字段（快，不用拉日志）
//   b) GET /{repo}/-/build/runner/download/log/{sn}-001 日志里的 PROXY_URI=（兜底）
//
// loader 返回的 baseURL 是动态读的，所以地址一变，下一次请求就自动走新地址，
// 不需要重装、不需要重启 magpie，也不需要用户在界面上点任何东西。

import { AsyncLocalStorage } from 'node:async_hooks';

const CNB_API = process.env.CNB_API || 'https://api.cnb.cool';

// 统一的 CNB OpenAPI 请求头
const cnbHeaders = (token, extra) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  ...(extra || {}),
});

// 插件在 plugins.json / `magpie plugin options` 里用的标识
const PLUGIN_ID = 'magpie-cnb2api';

// 匹配 <子域名>-<端口>.cnb.run。子域名允许连字符；末尾锚定端口和域名，
// 避免把 cnb.cool 的跳转地址误当上游；不锚定开头，因为 webide 可能带路径或查询串。
const URI_RE = /([a-z0-9][a-z0-9-]*)-(?:\{\{port\}\}|[0-9]+)\.cnb\.run(?![\w.-])/;

const DEFAULTS = {
  repo: '',
  token: '',
  proxyKey: '',
  models: 'deepseek-v4.1-flash',
  branch: 'main',
  checkSeconds: 120,
  autoStart: true,
  port: 9001,
  // 省核时：工作区 running 就按时间计费（每 5 分钟冻结一次）。
  // 空闲超过这个分钟数自动停掉。0 = 不自动停。
  idleStopMinutes: 0,
};

// 把用户填的各种写法归一成 org/repo。容忍：
//   https://cnb.cool/<org>/<repo>
//   https://cnb.cool/<org>/<repo>/-/tree/main
//   cnb.cool/<org>/<repo>
//   git@cnb.cool:<org>/<repo>.git
//   <org>/<repo>.git
//   <org>/<repo>
//   /<org>/<repo>
//   <repo>                （只有仓库名，组织留给调用方补）
function normalizeRepo(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  // 去掉协议与主机
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');       // https://
  s = s.replace(/^git@([^:]+):/i, '');                   // git@host:
  s = s.replace(/^[^/]+\.[a-z]{2,}\//i, '');             // cnb.cool/
  s = s.replace(/^\/+/, '');
  // 只取前两段（org/repo），丢掉 /-/... 之类的尾巴
  const m = s.match(/^([^/]+)\/([^/?#]+)/);
  if (!m) {
    // 只填了仓库名（没有组织）：原样返回，由调用方用 token 所属组织补全
    const only = s.replace(/\.git$/i, '').replace(/[/?#].*$/, '');
    return /^[\w.-]+$/.test(only) ? only : '';
  }
  const org = m[1].replace(/\.git$/i, '');
  const repo = m[2].replace(/\.git$/i, '');
  if (!org || !repo) return '';
  return `${org}/${repo}`;
}

function opts(given) {
  const o = { ...DEFAULTS, ...(given || {}) };
  o.checkSeconds = Math.max(30, Number(o.checkSeconds) || DEFAULTS.checkSeconds);
  o.port = Number(o.port) || 9001;
  o.autoStart = o.autoStart !== false && o.autoStart !== 'false';
  // 0 或负数 = 不自动停；否则最小 5 分钟（比一个计费周期短就没意义）
  const idle = Number(o.idleStopMinutes) || 0;
  o.idleStopMinutes = idle > 0 ? Math.max(5, Math.round(idle)) : 0;
  o.repo = normalizeRepo(o.repo);
  return o;
}

const strip = (u) => String(u || '').trim().replace(/\/+$/, '');

// 把 {{port}} 模板（或任何缺失的端口）补成真实端口。
// CNB 注入的 CNB_VSCODE_PROXY_URI 形如
//   https://tm5fw16v80-{{port}}.cnb.run
// 直接当域名用会得到一个字面量 {{port}} 的非法主机名，必须替换掉。
function materialize(u, port) {
  if (!u) return null;
  return String(u).replace(/\{\{\s*port\s*\}\}/gi, String(port));
}

// 从任意字符串里抠出 cnb.run 地址。注意 detail.webide 返回的是
//   https://cnb.cool/<org>/<repo>/-/workspace/vscode-web/<sn>-001
// 这种 WebIDE 控制台地址，不含 cnb.run，所以这里匹配不到是正常的。
function pickUri(text, port = 9001) {
  if (!text) return null;
  const m = String(text).match(URI_RE);
  return m ? `https://${materialize(m[0], port)}` : null;
}

// 日志里可能打印多次（热重启），最后一条才有效；{{port}} 要替换成真实端口
function pickUriFromLog(text, port = 9001) {
  if (!text) return null;
  const all = [...text.matchAll(/PROXY_URI=(https?:\/\/\S+)/g)];
  for (let i = all.length - 1; i >= 0; i--) {
    const u = materialize(strip(all[i][1]).replace(/["'<>]/g, ''), port);
    if (URI_RE.test(u)) return u;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 令牌权限清单
//
// 每项写明：scope、必需性、对应哪个接口、缺了会怎样。
// 插件启动后主动探测一遍，把缺少的权限用人话报出来。
// ---------------------------------------------------------------------------
const PERMISSIONS = [
  {
    scope: 'repo-cnb-trigger:r',
    need: 'required',
    label: '读流水线日志',
    why: '上游地址只能从工作区启动日志里的 PROXY_URI= 拿到，这是唯一的地址来源。',
    endpoint: 'GET /{repo}/-/build/runner/download/log/{pipelineId}',
    missing: '拿不到地址，插件完全不可用',
  },
  {
    scope: 'account-engage:r',
    need: 'required',
    label: '列自己的工作区',
    why: '先要知道有哪些工作区、哪个在 running，才能去读它的日志。',
    endpoint: 'GET /workspace/list',
    missing: '不知道工作区存在，插件完全不可用',
  },
  {
    scope: 'repo-cnb-trigger:rw',
    need: 'required-for-autostart',
    label: '拉起工作区',
    why: '工作区被平台回收后自动重新启动。不勾这项只能跟随地址，不能自动重启。',
    endpoint: 'POST /{repo}/-/workspace/start',
    missing: '工作区停了要手动去 CNB 点启动',
  },
  {
    scope: 'repo-cnb-detail:r',
    need: 'optional',
    label: '工作区详情',
    why: '比拉整份日志快，作为取地址的备用路径（目前 CNB 返回的字段不含 cnb.run，基本用不上）。',
    endpoint: 'GET /{repo}/-/workspace/detail/{sn}',
    missing: '无影响，自动回退到读日志',
  },
  {
    scope: 'group-resource:r',
    need: 'optional',
    label: '组织额度',
    why: '让 magpie quota 显示真实 AI credits 与核时消耗。',
    endpoint: 'GET /{slug}/-/charge/quota、/volume',
    missing: 'quota 里不显示额度，其他功能正常',
  },
  {
    scope: 'repo-cnb-history:r',
    need: 'optional',
    label: 'AI 用量明细',
    why: '按模型统计 token 与 credit，排查异常消耗时有用。',
    endpoint: 'GET /{repo}/-/build/logs/ai-request/...',
    missing: '无影响',
  },
  {
    scope: 'account-engage:rw',
    need: 'optional',
    label: '停止工作区（省核时）',
    why: '工作区 running 就按时间扣核时（每 5 分钟冻结一次），'
      + '不发请求也在扣。有了这项才能主动停掉，用完就停最省。',
    endpoint: 'POST /workspace/stop',
    missing: '不能主动省核时（stop 工具和 idleStopMinutes 都用不了），只能等平台回收',
  },
  {
    scope: 'repo-code:r',
    need: 'not-needed',
    label: '读仓库代码（插件不用）',
    why: '这是直连 /{repo}/-/ai/chat/completions 的条件。但上游有客户端指纹校验，'
      + '直连会被 11128 拦截，cnb2api 内部的 neutralize 才处理得了它。',
    endpoint: 'POST /{repo}/-/ai/chat/completions',
    missing: '无影响。不建议为它开权限',
  },
];

const NEED_CN = {
  required: '必需',
  'required-for-autostart': '要自动重启才必需',
  optional: '可选',
  'not-needed': '插件用不到',
};

// 带 scope 信息的错误：上层可以据此决定"是降级继续"还是"彻底失败"
class ScopeError extends Error {
  constructor(message, scopes = []) {
    super(message);
    this.name = 'ScopeError';
    this.scopes = scopes;
    this.permission = true;
  }
}

// 把 "Missing required scopes: a, b" 翻译成人话
function explainScope(errText) {
  const raw = String(errText || '');
  const m = raw.match(/Missing required scopes?:\s*([a-z0-9:,\s_-]+)/i);
  if (!m) return null;
  const missing = m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  const known = missing.map((s) => PERMISSIONS.find((p) => p.scope === s)).filter(Boolean);
  if (!known.length) return { missing, lines: [] };
  return {
    missing,
    lines: known.map((p) => `缺 ${p.scope}（${p.label}，${NEED_CN[p.need]}）：${p.missing}`),
    action: 'CNB → 头像 → 访问令牌 → 编辑，勾上上述权限后重启工作区',
  };
}

// 生成一份权限报告，供日志和 README 输出
function scopeReport() {
  return PERMISSIONS.map((p) => ({
    scope: p.scope,
    need: p.need,
    needCN: NEED_CN[p.need],
    label: p.label,
    why: p.why,
    missing: p.missing,
  }));
}

export const Cn2ApiPlugin = async ({ client, options: pluginOptions }) => {
  // ---------------------------------------------------------------------------
  // 多账号：状态按账号隔离
  //
  // 插件函数只被调用一次，所有账号共用同一份闭包，所以 state/cfg 不能放在
  // 闭包顶层，否则第二个账号会覆盖第一个的 token/repo/地址。
  // 每个账号一份 ctx，用 token 的指纹（不是 token 本身，避免日志泄漏）做键。
  // ---------------------------------------------------------------------------
  const ctxs = new Map();          // key → ctx

  // 用 AsyncLocalStorage 而不是"栈式 current"：
  // 定时器回调会在任意 await 点插入执行，栈式变量会被别的账号覆盖。
  // ALS 跟随异步调用链传递，天然隔离。
  const als = new AsyncLocalStorage();
  const cur = () => als.getStore() || null;

  function newState() {
    return {
      uri: null,
      sn: null,
      status: null,
      lastError: null,
      lastCheck: 0,
      starting: false,
      recovering: false,
      // 地址失效后的恢复动作共享同一个 Promise，
      // 避免并发请求各自跑一遍 refresh + waitForReady。
      recoveringPromise: null,
      autoStartBlocked: false,
      fatal: false,
      repoTried: false,
      repoTriedAt: 0,
      ticking: false,
      failures: 0,
      timer: null,
      readyPromise: null,
      discovering: null,
      reported: false,
      warnedLegacyAccount: false,
      // ---- 省核时相关 ----
      // 最后一次"真的用了它"的时间（有请求进来 / 手动拉起）
      lastUsedAt: 0,
      // 拿到可用地址的时刻，空闲计时从这里起算
      readySince: 0,
      // 手动停掉之后置 true：这时 autoStart 不再自动拉起，
      // 否则用户刚停、巡检又拉起来，白花钱
      paused: false,
      stoppedReason: null,
      stopping: false,
      stopBlocked: false,
    };
  }

  function newCtx(key) {
    return {
      key,
      cfg: opts(pluginOptions),   // 每个账号一份，后续由 applyCredentials 填
      state: newState(),
      label: '',                  // 写日志时区分账号
    };
  }

  // 用 token 派生一个稳定的短键（指纹）。不要直接用 token，避免它出现在
  // Map key、日志或调试输出里；也不用加密哈希，滚动哈希对"不暴露原文"够用。
  const fp = (token) => {
    const s = String(token || '').trim();
    if (!s) return 'anonymous';
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
    }
    return `a${h1.toString(36)}${h2.toString(36)}`;
  };

  // ctx 的键 = (token 指纹, 组织)。
  //
  // 同一个 CNB 令牌可能能访问多个组织，而**额度是按组织计的**
  // （GET /{org}/-/charge/quota 里的 org 就是计费主体）。
  // 只按 token 分的话，同一账号下的两个组织会共用一份 ctx，
  // 后填的组织把先填的覆盖掉，两个组织的额度显示成同一份。
  //
  // 组织可能还没确定（repo 留空 → 自动发现），这时先按 token 归组，
  // 等 applyCredentials 拿到 org 后再迁移到带 org 的键上。
  // 账号在界面/日志/工具输出里的名字。
  // 必须带上组织：同一用户的多个组织是两个独立账号，
  // 都显示成「ikoude」就分不清谁是谁了。
  //
  // runtimeOrg 传运行时识别出的组织（旧账号没存 metadata.org，靠它补）。
  function labelOf(auth, ctx, runtimeOrg) {
    const meta = auth?.metadata || {};
    const name = String(
      meta.username || meta.email || meta.repo || auth?.label || ctx?.key || '',
    ).trim();
    const org = String(meta.org || runtimeOrg || '').trim();
    const label = org && name ? `${name}@${org}` : (name || ctx?.key || '');
    return label.slice(0, 32);
  }

  function orgOf(auth) {
    const meta = auth?.metadata || {};
    const fromRepo = String(meta.repo || '').includes('/')
      ? String(meta.repo).split('/')[0]
      : '';
    return String(meta.org || fromRepo || '').trim();
  }

  function keyOf(auth) {
    const meta = auth?.metadata || {};
    const token = String(meta.token || auth?.key || auth?.access || '').trim();
    const org = orgOf(auth);
    return org ? `${fp(token)}@${org}` : fp(token);
  }

  function ctxFor(auth) {
    const key = keyOf(auth);
    let ctx = ctxs.get(key);
    if (!ctx) {
      ctx = newCtx(key);
      ctxs.set(key, ctx);
    }
    return ctx;
  }

  // 在某个账号的作用域里执行 fn。ALS 会自动把上下文带进所有 await 之后，
  // 并发调用多个账号时互不干扰。
  function within(ctx, fn) {
    return als.run(ctx, fn);
  }

  // ---- 给 tool 用：遍历所有已知账号执行 ----
  //
  // 宿主的 runTool 不注入账号作用域（ctx 里只有 sessionID 等），
  // tool 是 provider 级别的，所以得自己把每个账号跑一遍，
  // 结果按账号分块拼接。只有一个账号时不加标题，读起来更干净。
  // 账号之间并行跑：每个都要查一次 CNB，串行会让多账号时工具响应变慢。
  async function forEachAccount(fn) {
    const all = [...ctxs.values()];
    if (!all.length) {
      return '还没有登录任何 CNB 账号。执行 magpie plugin login cnb2api 添加。';
    }
    const multi = all.length > 1;
    const blocks = await Promise.all(all.map(async (ctx) => {
      const lines = await within(ctx, async () => {
        // 巡检定时器可能还没启动过，保证至少识别一次仓库/工作区
        if (!ctx.state.uri && !ctx.state.fatal) {
          await refresh('tool').catch(() => {});
        }
        return fn(ctx);
      }).catch((e) => [`执行失败：${e.message}`]);
      // refresh 之后 cfg.repo 才可能识别出来，这时才补得上组织后缀
      if (!String(ctx.label || '').includes('@')) {
        const org = (ctx.cfg?.repo || '').split('/')[0];
        if (org && ctx.label) ctx.label = `${ctx.label}@${org}`.slice(0, 32);
      }
      const head = multi ? `【${ctx.label || ctx.key}】` : '';
      const body = Array.isArray(lines) ? lines : [String(lines)];
      return head ? [head, ...body.map((l) => `  ${l}`)].join('\n') : body.join('\n');
    }));
    return blocks.join(multi ? '\n\n' : '\n');
  }

  // 取当前 ctx，没有就报错（说明有代码在账号作用域外碰了账号数据）
  function need() {
    const c = cur();
    if (!c) throw new Error('内部错误：在账号作用域外访问账号数据');
    return c;
  }

  // cfg / state 现在是"当前账号"的动态视图。
  // 这样几十处 cfg.xxx / state.xxx 的既有代码全都不用改，
  // 但语义已经变成按账号隔离。
  const cfg = new Proxy({}, {
    get(_, p) { return need().cfg[p]; },
    set(_, p, v) { need().cfg[p] = v; return true; },
    has(_, p) { return p in need().cfg; },
  });

  const state = new Proxy({}, {
    get(_, p) { return need().state[p]; },
    set(_, p, v) { need().state[p] = v; return true; },
    has(_, p) { return p in need().state; },
  });

  const say = (msg) => {
    // 多账号时带上账号标记，否则日志分不清是哪个账号的
    const label = cur()?.label;
    const line = label ? `[${label}] ${msg}` : msg;
    try { client?.app?.log?.({ body: { service: 'cnb2api', level: 'info', message: line } }); } catch {}
    console.log(`[cnb2api] ${line}`);
  };
  const warn = (msg) => {
    const label = cur()?.label;
    const line = label ? `[${label}] ${msg}` : msg;
    try { client?.app?.log?.({ body: { service: 'cnb2api', level: 'warn', message: line } }); } catch {}
    console.warn(`[cnb2api] ${line}`);
  };

  // ---------- OpenAPI ----------
  async function api(path, init = {}) {
    if (!cfg.token) throw new Error('尚未填写 CNB 访问令牌');
    const res = await fetch(`${CNB_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(init.timeout || 20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 403 且带 scope 信息 -> 翻译成"该去勾哪个权限"
      if (res.status === 403) {
        const ex = explainScope(body);
        if (ex) {
          const msg = [`权限不足：${path}`, ...ex.lines, ex.action ? `处理：${ex.action}` : '']
            .filter(Boolean).join('；');
          throw new ScopeError(msg, ex.missing);
        }
      }
      throw new Error(`${path} HTTP ${res.status} ${body.slice(0, 140)}`);
    }
    return res;
  }

  // 把 401 的原始报文换成一句人话（agent 和用户都不用去读 errcode）
  function humanize(e) {
    const m = String(e?.message || e || '');
    if (/HTTP 401/.test(m) || /not logged in/i.test(m)) {
      return '令牌无效或已过期';
    }
    if (/HTTP 404/.test(m) && /workspace/i.test(m)) {
      return `仓库 ${cfg.repo} 下没有工作区`;
    }
    return m;
  }

  async function listWorkspaces() {
    const q = new URLSearchParams({ page: '1', page_size: '50' });
    // 不传 slug = 列出「我」名下所有工作区。用来自动发现仓库，
    // 因为别人的仓库不一定叫 cnb2api。
    if (cfg.repo) q.set('slug', cfg.repo);
    const res = await api(`/workspace/list?${q}`);
    const j = await res.json();
    const list = j.list || j.data || [];
    // 服务端理论上按 slug 过滤了，但本地再筛一遍：
    // 宁可多这一步，也不能误用别的仓库的工作区（会去读错日志、甚至拉起错仓库）
    if (!cfg.repo) return list;
    return list.filter((w) => (w.slug || w.repo_url) === cfg.repo);
  }

  // ---------- 自动发现仓库 ----------
  // repo 留空时，用 token 拉「我的所有工作区」，找出哪个仓库跑着 cnb2api：
  // 优先看 running 的，再看日志里有没有 PROXY_URI=。
  async function discoverRepo() {
    let list;
    try {
      list = await listWorkspaces();   // 不带 slug
    } catch (e) {
      if (e?.permission || /HTTP 401/.test(e?.message || '')) throw e;
      return null;
    }
    if (!list.length) return null;

    // 去重出仓库列表，running 的排前面
    const byRepo = new Map();
    for (const w of list) {
      const slug = w.slug || w.repo_url;
      if (!slug) continue;
      const cur = byRepo.get(slug);
      const running = w.status === 'running';
      if (!cur || (running && !cur.running)) byRepo.set(slug, { slug, sn: w.sn, running });
    }
    const candidates = [...byRepo.values()].sort((a, b) => Number(b.running) - Number(a.running));

    // 名字里带 cnb2api 的直接优先（最常见情况），省一轮日志
    candidates.sort((a, b) => Number(/-?cnb2api\b/i.test(b.slug)) - Number(/-?cnb2api\b/i.test(a.slug)));

    for (const c of candidates) {
      // 名字命中就先用它，不再逐条扒日志
      if (/-?cnb2api\b/i.test(c.slug)) {
        return c.slug;
      }
      try {
        const res = await api(
          `/${c.slug}/-/build/runner/download/log/${encodeURIComponent(c.sn)}-001`,
          { timeout: 20000 },
        );
        const logText = await res.text();
        const picked = pickUriFromLog(logText, cfg.port);
        if (picked) {
          return c.slug;
        }
      } catch { /* 没有权限或日志里没地址，换下一个 */ }
    }
    return null;
  }

  // 工作区的时间字段是 create_time（不是 created_at），
  // 兼容几种可能的写法，取不到就退回 0（保持原序）。
  const tsOf = (w) => {
    for (const k of ['create_time', 'createTime', 'created_at', 'updated_at']) {
      const t = Date.parse(w?.[k] || '');
      if (Number.isFinite(t)) return t;
    }
    return 0;
  };

  // 同一仓库可能有多个工作区实例（每次启动/关闭都留一条）。
  // 实测一个仓库能攒到 9 条（1 running + 8 closed）。挑选顺序：
  //   1. 正在运行的 —— 直接能用，不用等冷启动
  //   2. 最新的 —— 全关了的话重启它最快，环境也最接近上次
  // 不能随便取 list[0]：那可能是很久以前的老实例，重建慢且可能缺改动。
  async function pickWorkspace() {
    const list = await listWorkspaces();
    if (!list.length) return null;
    const running = list.filter((w) => w.status === 'running');
    if (running.length) {
      // 多个都在跑时取最新的，避免拿到一个即将被回收的
      return running.sort((a, b) => tsOf(b) - tsOf(a))[0];
    }
    return list.sort((a, b) => tsOf(b) - tsOf(a))[0];
  }

  // 确认仓库是否存在。用于把"仓库名填错"和"仓库在但没工作区"区分开，
  // 避免填错时一直尝试 start（会得到一串 404 且反复重试）。
  // 注意：/ {repo} 对存在的私有仓库可能返回 403（缺 repo-basic-info:r），
  // 所以**只有 404 才算不存在**，403 说明仓库在、只是详情看不了。
  async function repoExists(slug) {
    if (!slug || !slug.includes('/')) return false;
    try {
      const res = await api(`/${slug}`);
      return res.ok;
    } catch (e) {
      if (/HTTP 404/.test(e?.message || '')) return false;
      return true;
    }
  }

  // detail 的 webide / jumpUrl / codebuddyweb 返回的是
  // https://cnb.cool/... 控制台地址，不含 cnb.run 子域名，所以这里基本拿不到东西。
  // 保留这段是因为 CNB 可能调整字段，能拿到就用（比拉整份日志快）。
  async function uriFromDetail(sn) {
    try {
      const res = await api(`/${cfg.repo}/-/workspace/detail/${encodeURIComponent(sn)}`);
      const j = await res.json();
      for (const k of ['webide', 'jumpUrl', 'codebuddyweb', 'remoteSsh']) {
        const u = pickUri(j?.[k], cfg.port);
        if (u) return u;
      }
    } catch (e) {
      // detail 刚启动时可能 404，交给日志兜底
    }
    return null;
  }

  async function uriFromLog(sn) {
    try {
      const res = await api(
        `/${cfg.repo}/-/build/runner/download/log/${encodeURIComponent(sn)}-001`,
        { timeout: 30000 },
      );
      return pickUriFromLog(await res.text(), cfg.port);
    } catch (e) {
      // 权限问题必须冒泡：这是唯一能取到地址的路子，吞掉就只剩"取不到地址"
      if (e?.permission) throw e;
      return null;
    }
  }

  async function startWorkspace() {
    if (state.starting) return;
    state.starting = true;
    try {
      say(`工作区未运行（status=${state.status || 'unknown'}），正在拉起…`);
      await api(`/${cfg.repo}/-/workspace/start`, {
        method: 'POST',
        body: JSON.stringify({ branch: cfg.branch }),
        timeout: 60000,
      });
      // 拉起即视为"开始使用"，把空闲计时归零
      state.lastUsedAt = Date.now();
      state.paused = false;
      state.stoppedReason = null;
      say('启动已提交，等待地址出现');
    } catch (e) {
      if (e?.permission) {
        // 不是致命错误：地址还能跟随，只是不会自动重启
        state.autoStartBlocked = true;
        warn(`自动拉起不可用（不影响地址跟随）：${e.message}`);
      } else {
        warn(`拉起失败：${e.message}`);
      }
    } finally {
      state.starting = false;
    }
  }

  // 停掉工作区。这是唯一能真正止住核时的动作：
  // 工作区一旦 running 就按时间扣费（每 5 分钟冻结一次），不发请求也照常扣。
  // 需要 account-engage:rw 权限。
  async function stopWorkspace(reason = 'manual') {
    if (state.stopping) return { ok: false, message: '正在停止，请稍候' };
    if (!state.sn) return { ok: false, message: '还没拿到工作区编号（sn），无法停止' };
    state.stopping = true;
    try {
      // 接口要的是 sn（构建号），不是 slug
      await api('/workspace/stop', {
        method: 'POST',
        body: JSON.stringify({ sn: state.sn }),
        timeout: 60000,
      });
      state.paused = true;
      state.stoppedReason = reason;
      state.uri = null;
      state.status = 'stopped';
      const why = reason === 'idle'
        ? `空闲超过 ${cfg.idleStopMinutes} 分钟`
        : '手动停止';
      say(`工作区已停止（${why}），不再消耗核时。下次请求会自动拉起。`);
      return { ok: true, message: `已停止（${why}）` };
    } catch (e) {
      if (e?.permission) {
        state.stopBlocked = true;
        const msg = '停止工作区需要 account-engage:rw 权限。'
          + '到 CNB → 头像 → 访问令牌 → 编辑，勾上后重试。';
        warn(msg);
        return { ok: false, message: msg };
      }
      warn(`停止失败：${e.message}`);
      return { ok: false, message: e.message };
    } finally {
      state.stopping = false;
    }
  }

  // 空闲检查：在定时巡检里跑。
  // 只在"确实开着 + 确实没人用"时才停，避免刚拉起就被停掉。
  async function checkIdle() {
    if (!cfg.idleStopMinutes) return;
    if (state.status !== 'running') return;
    if (state.starting || state.recovering) return;
    if (state.paused) return;                      // 已经停过了

    // 从"拿到地址那一刻"起算空闲。
    // 不能用 lastUsedAt 的 0 当"没记录过就不动" —— 那样只巡检查额度、
    // 一直没发过请求的场景永远不会停下，而它正是在白烧核时。
    const since = state.lastUsedAt || state.readySince;
    if (!since) return;

    const idleMs = Date.now() - since;
    // 阈值按分钟算。测试时可用环境变量改成秒，方便验证这条路径。
    const limitMs = process.env.CNB2API_IDLE_TEST_SECS
      ? Number(process.env.CNB2API_IDLE_TEST_SECS) * 1000
      : cfg.idleStopMinutes * 60_000;
    if (idleMs < limitMs) return;

    // 停之前再确认一次确实没有新请求进来（并发场景下 lastUsedAt 可能刚被刷新）
    if (state.lastUsedAt > since) return;

    // 探活：不通说明已经挂了，交给正常流程处理，不在这里停
    // （测试可用 CNB2API_SKIP_HEALTH=1 跳过，因为 mock 环境的 cnb.run 地址不可达）
    if (state.uri && process.env.CNB2API_SKIP_HEALTH !== '1') {
      const alive = await health(state.uri, 3000);
      if (!alive) return;
    }
    await stopWorkspace('idle');
  }

  async function health(base, ms = 12000) {
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(ms),
        redirect: 'manual',
      });
      if (res.status !== 200) return false;
      const t = await res.text();
      return /"status"\s*:\s*"ok"/.test(t);
    } catch {
      return false;
    }
  }

  // 一次完整检查：列表 -> 停止则拉起 -> 取地址 -> 验活
  // 自动发现仓库，带互斥：自检和 refresh 可能同时想发现，只让一个跑
  function discoverOnce() {
    if (state.discovering) return state.discovering;
    state.discovering = (async () => {
      await expandBareRepo();
      const found = cfg.repo ? null : await discoverRepo();
      if (found && !cfg.repo) {
        cfg.repo = found;
        say(`未配置 repo，已自动识别为 ${found}`);
      }
      return cfg.repo || null;
    })().finally(() => {
      // 失败时不要留下已 resolve 的 Promise：否则后面每次调用都拿到
      // 那个旧的 null，再也不会重试 —— 工作区晚一点起来就永远认不出来。
      // 成功（cfg.repo 已定）时留着无所谓，反正下次会直接返回它。
      if (!cfg.repo) state.discovering = null;
    });
    return state.discovering;
  }

  // 用户只填了仓库名（如 "ai-proxy"）时，用 token 所属身份补出 org/repo。
  // 依次试：token 本人 → 他加入的组织。命中就定下来。
  async function expandBareRepo() {
    if (!cfg.repo || cfg.repo.includes('/')) return true;
    const name = cfg.repo;
    const owners = [];

    try {
      const me = await (await api('/user')).json();
      if (me?.username) owners.push(me.username);
    } catch { /* 没有 /user 权限也不致命 */ }

    try {
      const g = await (await api('/user/groups?page=1&page_size=50')).json();
      for (const x of (Array.isArray(g) ? g : (g?.list || []))) {
        const p = x?.path || x?.name;
        if (p && !owners.includes(p)) owners.push(p);
      }
    } catch { /* 忽略 */ }

    // 都不行时，退化为扫工作区列表里出现过的组织
    if (!owners.length) {
      try {
        for (const w of await listWorkspaces()) {
          const slug = w.slug || w.repo_url || '';
          const org = slug.split('/')[0];
          if (org && !owners.includes(org)) owners.push(org);
        }
      } catch { /* 忽略 */ }
    }

    // 用工作区列表验证哪个 org 下真有这个仓库
    let known = null;
    try { known = await listWorkspaces(); } catch { /* 忽略 */ }
    const slugs = new Set((known || []).map((w) => w.slug || w.repo_url).filter(Boolean));

    for (const org of owners) {
      const full = `${org}/${name}`;
      if (!slugs.size || slugs.has(full)) {
        cfg.repo = full;
        say(`只说仓库名 "${name}"，已补全为 ${full}`);
        return true;
      }
    }

    // 实在判断不出来：用第一个组织兜底，让后面的检查给出明确报错
    if (owners.length) {
      cfg.repo = `${owners[0]}/${name}`;
      say(`仓库名 "${name}" 未在已知工作区里找到，先按 ${cfg.repo} 试`);
      return true;
    }
    return false;
  }

  async function refresh(reason = 'tick') {
    state.lastCheck = Date.now();
    if (!cfg.token) {
      // 注意：不能设 fatal。config 阶段 token 还读不到（只存在于 loader 的 auth 里），
      // 这时设 fatal 会导致之后凭据补齐了也永远不再尝试。
      state.lastError = '尚未填写 CNB 访问令牌';
      return state;
    }

    // repo 没填（或只填了仓库名）就先归一/发现，只试一次。
    // 别人的仓库不一定叫 cnb2api，也可能只记得自己起的名字。
    if (!cfg.repo || !cfg.repo.includes('/')) {
      // 仓库发现失败后每 5 分钟重试一次。
      // 工作区刚启动时日志里可能还没有 PROXY_URI，过一会儿才出现，
      // 所以失败不能当作永久结论。
      const retryGapMs = 5 * 60_000;
      if (state.repoTried && Date.now() - (state.repoTriedAt || 0) < retryGapMs) {
        state.lastError = cfg.repo
          ? `无法补全仓库 "${cfg.repo}"`
          : '未配置 repo，且自动发现失败（稍后重试）';
        return state;
      }
      state.repoTried = true;
      state.repoTriedAt = Date.now();
      try {
        const found = await discoverOnce();
        if (!found) {
          state.lastError = '没能确定仓库：repo 留空且工作区里认不出 cnb2api，'
            + '或只填了名字但补不出组织。请填成 org/repo';
          // 不设 fatal：等一会儿可能就好了
          return state;
        }
        state.repoTried = false;
      } catch (e) {
        state.lastError = `自动发现仓库失败：${humanize(e)}`;
        return state;
      }
    }

    try {
      const ws = await pickWorkspace();
      if (!ws) {
        state.status = 'none';
        // 先确认这个仓库到底存不存在：填错名字时不该反复尝试拉起
        if (!(await repoExists(cfg.repo))) {
          state.lastError = `仓库 ${cfg.repo} 不存在（或你的 token 无权访问）`;
          state.fatal = true;
          return state;
        }
        state.lastError = `仓库 ${cfg.repo} 从未启动过工作区`;
        if (cfg.autoStart && !state.paused) await startWorkspace();
        return state;
      }
      state.sn = ws.sn;
      state.status = ws.status;

      if (ws.status !== 'running') {
        state.lastError = state.paused
          ? `工作区已停止（${state.stoppedReason === 'idle' ? '空闲自动停止' : '手动停止'}），有请求时会自动拉起`
          : `工作区已停止（sn=${ws.sn}）`;
        // paused 时不自动拉起 —— 用户刚为了省核时把工作区停了，
        // 巡检再拉开就等于白停一次。等真的有请求进来再说。
        if (cfg.autoStart && !state.paused) {
          await startWorkspace();
          // 拉起后工作区要几十秒才真正就绪，同一次调用里先不等，
          // 但标记"正在等启动"，让 waitForReady 去轮询
          state.recovering = true;
        }
        return state;
      }

      // 开着的时候顺便看一眼是不是闲置太久，该停就停（省核时）
      const ok = await resolveUri(ws.sn);
      if (ok) state.recovering = false;

      // 放在 resolveUri 之后：checkIdle 要用 readySince 算空闲，
      // 而 readySince 是在 resolveUri 里拿到地址时才写的。
      await checkIdle();
    } catch (e) {
      state.failures += 1;
      state.lastError = humanize(e);
      // 401 = token 本身无效，403 = 权限不够：两者都不会因为等待而好转
      if (e?.permission || /HTTP 401/.test(e.message || '')) state.fatal = true;
      if (state.failures === 1 || state.failures % 10 === 0) warn(`检查失败：${state.lastError}`);
    }
    return state;
  }

  // 解析并验活一次；成功则更新 state.uri
  async function resolveUri(sn) {
    const uri = (await uriFromDetail(sn)) || (await uriFromLog(sn));
    if (!uri) {
      state.lastError = '取不到地址（工作区可能还在启动）';
      return false;
    }

    // 地址变了就立刻采用，哪怕这会儿还没通：新工作区刚起来时代理要几十秒才监听，
    // 如果因为"暂时不健康"就丢掉新地址，就会一直卡在已经失效的旧地址上。
    const changed = uri !== state.uri;
    if (changed) {
      // 日志里也打码：日志常被贴出来求助，完整地址等于公开端点
      say(`${state.uri ? '地址已更新' : '已就绪'}：${maskHost(hostOf(uri))}`);
      state.uri = uri;
      // 拿到新地址 = 工作区刚起来，从这一刻开始算空闲
      state.readySince = Date.now();
      state.paused = false;
    }

    if (!(await health(uri))) {
      state.lastError = `地址尚未就绪：${uri}`;
      state.failures += 1;
      return false;
    }
    state.lastError = null;
    state.failures = 0;
    return true;
  }

  // 有界等待：轮询直到拿到可用地址。用于首请求和"检测到停止"之后，
  // 因为工作区从 start 到代理监听 9001 通常需要 30~90 秒。
  async function waitForReady(budgetMs) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      await refresh('wait');
      if (state.uri) return true;
      // token 无效 / 权限不足是确定性的，再等也不会好，立即放弃
      if (state.fatal) return false;
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(6000, left)));
    }
    if (!state.uri) warn(`等待 ${Math.round(budgetMs / 1000)}s 仍无可用地址：${state.lastError || 'unknown'}`);
    return false;
  }

  // ---------- 组织额度（真实数据，用于 usage 钩子） ----------
  //   GET /{org}/-/charge/quota          → { credit_in_milli:{total,free}, dev_in_sec:{total,free}, ... }
  //   GET /{org}/-/charge/volume         → { credit_in_milli: 496130, dev_in_sec: 440648, freeze_*: ... }
  //   GET /{org}/-/charge/special-amount → { credit: 666, credit_desc: "...", credit_expire: ... }
  //
  // 注意三点：
  //  1. 单位：*_in_milli ÷ 1000 = credits；*_in_sec ÷ 3600 = 核时
  //  2. volume 是扁平数字（已用量），quota 才是 {total,free} 对象
  //  3. quota.total **已包含** special-amount 的加成，不能当"基础套餐额度"，
  //     否则用户看到 1166 却不知道其中 666 是赠送的、何时过期。
  const num = (v) => {
    if (v == null) return null;
    const n = typeof v === 'object' ? Number(v.total ?? NaN) : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const round1 = (n) => Math.round(Number(n) * 10) / 10;

  // 数值显示：整数不拖 .0，小数留一位，保证各账号格式统一
  const num1 = (n) => {
    const v = round1(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  // 2026-10-31T15:59:59Z → 2026-10-31
  const fmtDate = (s) => String(s || '').slice(0, 10);

  // 加成那一段的文案。三种情况必须分开，否则会误导用户：
  //   有加成未过期 → 「天才程序员专属特权 +666（2026-12-31 到期）」
  //   有加成已过期 → 「天才程序员专属特权 +666 已过期」   ← 不能还写 "+666" 让人以为可用
  //   没有加成     → 空字符串（不显示，别出现 "加成 +0" 这种噪音）
  function bonusPart(amount, desc, expire, expired) {
    if (amount == null) return '';
    const label = desc || '加成';
    if (expired) return `${label} +${num1(amount)} 已过期`;
    return expire ? `${label} +${num1(amount)}（${fmtDate(expire)} 到期）` : `${label} +${num1(amount)}`;
  }

  // 加成本身可为 null / 0（没有特权的账号就是这样），要能区分「没有」和「不知道」
  const positive = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  // 从 {credit, credit_desc, credit_expire} 这类三元组里取出有效的那项。
  // 注意：接口会返回**已过期**的加成（quota 里可能也已经扣掉了），
  // 所以要带出 expired 标记，让显示层能说"已过期"而不是继续吹 "+666"。
  //
  // 注意字段名：值叫 compute_develop_corehour，
  // 但说明和过期时间叫 compute_develop_desc / compute_develop_expire（**没有 _corehour**）。
  // 不传 baseKey 时按 `${key}_desc` 拼，传了就优先用它。
  function specialOf(special, key, unitScale, baseKey = null, now = Date.now()) {
    if (!special) return null;
    const amount = positive(special[key]);
    if (amount == null) return null;
    const stem = baseKey || key;
    const desc = String(special[`${stem}_desc`] ?? '').trim();
    const expireRaw = String(special[`${stem}_expire`] ?? '').trim();
    // 9999 年那种「永不过期」当成没有期限
    const expire = expireRaw && !/^9999/.test(expireRaw) ? expireRaw : null;
    const expiresAt = expire ? Date.parse(expire) : null;
    const expired = expiresAt != null && Number.isFinite(expiresAt) && expiresAt < now;
    return {
      amount: amount / unitScale,
      desc: desc || null,
      expire,
      expired,
    };
  }

  async function charge(org) {
    const [quota, volume, special] = await Promise.all([
      api(`/${org}/-/charge/quota`).then((r) => r.json()).catch(() => null),
      api(`/${org}/-/charge/volume`).then((r) => r.json()).catch(() => null),
      api(`/${org}/-/charge/special-amount`).then((r) => r.json()).catch(() => null),
    ]);
    if (!quota && !volume) return null;

    const res = {};

    // ---- credits ----
    // 统一在 milli 口径上算，最后再 /1000 显示，避免中间反复换算丢精度。
    const totalMilli = num(quota?.credit_in_milli);          // 总额（已含特权）
    const usedMilli = num(volume?.credit_in_milli);          // 已用
    const frozenMilli = num(volume?.freeze_credit_in_milli) || 0;   // 冻结
    // special.credit 单位是 credit，不是 milli —— 要 ×1000 统一口径
    const bonus = specialOf(special, 'credit', 1);
    const specialMilli = bonus?.amount != null ? bonus.amount * 1000 : null;

    if (totalMilli != null) {
      // 关键：total 已经包含特权，所以基础额度必须减去特权，
      // 否则会把 666 重复计算一次。
      const baseMilli = specialMilli != null ? totalMilli - specialMilli : totalMilli;
      // 可用 = 总额 - 已用 - 冻结，下限 0
      const remainMilli = Math.max(0, totalMilli - (usedMilli || 0) - frozenMilli);
      // 已用率 / 已用+冻结率，基于总额（不是基础额度）算
      const usedPct = usedMilli != null ? (usedMilli / totalMilli) * 100 : null;
      const usedFrozenPct = totalMilli > 0
        ? ((usedMilli || 0) + frozenMilli) / totalMilli * 100
        : null;

      res.credit = {
        totalMilli,
        usedMilli,
        frozenMilli,
        specialMilli,
        baseMilli,
        remainMilli,
        usedPct,
        usedFrozenPct,
        total: totalMilli / 1000,
        used: usedMilli != null ? usedMilli / 1000 : null,
        frozen: frozenMilli / 1000,
        bonus: bonus?.amount ?? null,
        base: baseMilli / 1000,
        remain: remainMilli / 1000,
        bonusDesc: bonus?.desc ?? null,
        bonusExpire: bonus?.expire ?? null,
        bonusExpired: bonus?.expired ?? false,
        // 接口自己的"免费额度"，用于交叉验证 base 口径
        freeMilli: num(quota?.credit_in_milli?.free),
      };
    }

    // ---- 核时（同口径）----
    const devTotalSec = num(quota?.dev_in_sec);
    const devUsedSec = num(volume?.dev_in_sec);
    const devFrozenSec = num(volume?.freeze_dev_in_sec) || 0;
    // compute_develop_corehour 的说明字段是 compute_develop_desc（没有 _corehour）
    const devBonus = specialOf(special, 'compute_develop_corehour', 1, 'compute_develop');
    const devSpecialSec = devBonus?.amount != null ? devBonus.amount * 3600 : null;

    if (devTotalSec != null) {
      const baseSec = devSpecialSec != null ? devTotalSec - devSpecialSec : devTotalSec;
      const remainSec = Math.max(0, devTotalSec - (devUsedSec || 0) - devFrozenSec);
      res.devHours = {
        totalSec: devTotalSec,
        usedSec: devUsedSec,
        frozenSec: devFrozenSec,
        specialSec: devSpecialSec,
        baseSec,
        remainSec,
        usedPct: devUsedSec != null ? (devUsedSec / devTotalSec) * 100 : null,
        usedFrozenPct: devTotalSec > 0
          ? ((devUsedSec || 0) + devFrozenSec) / devTotalSec * 100
          : null,
        total: devTotalSec / 3600,
        used: devUsedSec != null ? devUsedSec / 3600 : null,
        frozen: devFrozenSec / 3600,
        bonus: devBonus?.amount ?? null,
        base: baseSec / 3600,
        remain: remainSec / 3600,
        bonusDesc: devBonus?.desc ?? null,
        bonusExpire: devBonus?.expire ?? null,
        bonusExpired: devBonus?.expired ?? false,
      };
    }
    return res;
  }

  const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };

  // 把工作区域名打码：860lo2zlkf-9001.cnb.run → 860l****-9001.cnb.run
  // 保留前 4 位是为了"自己认得出是哪个"，保留端口和域名是为了"看得出是否正常"。
  const maskHost = (host) => {
    const h = String(host || '');
    if (!h) return '';
    // cnb.run 的子域形如 <12位随机>-<端口>.<域名>
    const m = h.match(/^([^-]+)-(\d+\..+)$/);
    if (m) {
      const [, sub, rest] = m;
      const head = sub.slice(0, 4);
      const tail = rest;                       // 端口 + 域名原样保留
      return sub.length <= 6 ? `${head}****-${tail}` : `${head}****-${tail}`;
    }
    // 其他形态：保留前 4 后 4，中间打码
    if (h.length <= 10) return h;
    return `${h.slice(0, 4)}****${h.slice(-4)}`;
  };
  // config 阶段还没有"当前账号"，所以取不到 cfg 时要退回插件级的默认值，
  // 否则 config 会直接抛错导致整个插件加载失败。
  const defaultCfg = opts(pluginOptions);
  const modelIds = () => String((cur() ? cfg.models : defaultCfg.models) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // OpenAI 格式的错误响应，agent 直接能看到 message
  const oaiError = (status, message, hint = '') => new Response(
    JSON.stringify({ error: { message: hint ? `${message}（${hint}）` : message, type: 'cnb2api_error', code: status } }),
    { status, headers: { 'content-type': 'application/json' } },
  );

  // 给已有响应补一句提示：重写正文，去掉 content-length/encoding（文档要求）
  async function annotate(res, hint) {
    try {
      const text = await res.text();
      let body = text;
      try {
        const j = JSON.parse(text);
        const msg = j?.error?.message ?? j?.message ?? text;
        body = JSON.stringify({ error: { ...(j?.error || {}), message: `${msg}（${hint}）` } });
      } catch {
        body = JSON.stringify({ error: { message: `${text.slice(0, 200)}（${hint}）` } });
      }
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      headers.set('content-type', 'application/json');
      return new Response(body, { status: res.status, headers });
    } catch {
      return res;
    }
  }

  // ---------- 登录用：拉可选仓库列表 ----------
  // ask() 里按步骤拉真实数据做成下拉，所以不需要用户背 org/repo 的写法。
  // 缓存按 token 分开（多账号各自一份），60 秒内复用。
  const repoCacheByToken = new Map();   // token → { at, repos }
  async function listReposForLogin(token) {
    const now = Date.now();
    const hit = repoCacheByToken.get(fp(token));
    if (hit && now - hit.at < 60_000) return hit.repos;
    const res = await fetch(`${CNB_API}/user/repos?page=1&page_size=100`, {
      headers: cnbHeaders(token),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const items = Array.isArray(j) ? j : (j?.list || []);
    const repos = items
      .map((r) => normalizeRepo(r.path || (r.name && r.owner ? `${r.owner}/${r.name}` : r.name)))
      .filter(Boolean);
    repoCacheByToken.set(fp(token), { at: now, repos });
    return repos;
  }

  // 组织列表：合并三处来源，单独任何一个都可能漏。
  //   /user         → 个人账户（有时不在 groups 里）
  //   /user/groups  → 加入的组织
  //   仓库 path 前缀 → 已经确认能访问的
  const orgCacheByToken = new Map();
  async function listOrgsForLogin(token) {
    const now = Date.now();
    const hit = orgCacheByToken.get(fp(token));
    if (hit && now - hit.at < 60_000) return hit.orgs;

    const orgs = new Set();
    const head = cnbHeaders(token);

    const repos = await listReposForLogin(token).catch(() => null);
    for (const p of (repos || [])) {
      const o = p.split('/')[0];
      if (o) orgs.add(o);
    }

    try {
      const me = await fetch(`${CNB_API}/user`, { headers: head, signal: AbortSignal.timeout(12000) });
      if (me.ok) {
        const u = await me.json();
        if (u?.username) orgs.add(u.username);
      }
    } catch { /* 忽略 */ }

    try {
      const g = await fetch(`${CNB_API}/user/groups?page=1&page_size=50`, {
        headers: head, signal: AbortSignal.timeout(12000),
      });
      if (g.ok) {
        const j = await g.json();
        for (const x of (Array.isArray(j) ? j : (j?.list || []))) {
          const p = x?.path || x?.name;
          if (p) orgs.add(p);
        }
      }
    } catch { /* 忽略 */ }

    const list = [...orgs];
    orgCacheByToken.set(fp(token), { at: now, orgs: list });
    return list;
  }

  // 某组织下「跑着 cnb2api」的仓库：有工作区、且日志里有 PROXY_URI。
  // 仓库名不必叫 cnb2api —— 靠日志内容判断，这才是可靠依据。
  //
  // 注意：workspace/list 的 slug 参数只认完整的 org/repo，
  // 传单个组织名（slug=alice）会返回 0 条。所以这里拉全量再本地过滤。
  async function listCnbReposForLogin(token, org) {
    const res = await fetch(`${CNB_API}/workspace/list?page=1&page_size=100`, {
      headers: cnbHeaders(token),
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);

    let list = [];
    if (res?.ok) {
      const j = await res.json().catch(() => null);
      list = (j?.list || j?.data || []).filter((w) => {
        const slug = w.slug || w.repo_url;
        return slug && slug.split('/')[0] === org;
      });
    }

    // 每个仓库留最新、优先 running 的那个工作区
    const byRepo = new Map();
    for (const w of list) {
      const slug = w.slug || w.repo_url;
      const cur = byRepo.get(slug);
      const running = w.status === 'running';
      if (!cur || (running && !cur.running)) byRepo.set(slug, { slug, sn: w.sn, running });
    }

    const out = [];
    for (const w of byRepo.values()) {
      // 名字带 cnb2api 的直接收录，省一次日志请求
      if (/-?cnb2api\b/i.test(w.slug)) {
        out.push({ repo: w.slug, running: w.running });
        continue;
      }
      try {
        const r = await fetch(
          `${CNB_API}/${w.slug}/-/build/runner/download/log/${encodeURIComponent(w.sn)}-001`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
        );
        if (r.ok && pickUriFromLog(await r.text(), defaultCfg.port)) {
          out.push({ repo: w.slug, running: w.running });
        }
      } catch { /* 读不到日志就跳过 */ }
    }
    // 运行中的排前面
    return out.sort((a, b) => Number(b.running) - Number(a.running));
  }

  // ---------- 启动自检：把权限状况一次性说清楚 ----------
  // 只跑一次。目的不是"测试"，而是把 scope 要求写进日志和界面，
  // 免得用户对着 403 猜该勾什么。
  async function reportPermissions() {
    if (state.reported) return;
    state.reported = true;
    if (!cfg.token) {
      // 这是「还没填」，不是「填错了」——指引必须是去填，而不是去改令牌
      state.fatal = true;
      state.lastError = '尚未填写 CNB 访问令牌';
      warn('尚未填写 token。请执行：\n'
        + `  magpie plugin options ${PLUGIN_ID} '{"token":"你的 CNB 访问令牌"}'\n`
        + '或在 magpie 界面 → Plugins → CNB2API → Options 里填。'
        + `所需权限：${PERMISSIONS.filter((p) => p.need === 'required').map((p) => p.scope).join('、')}`);
      return;
    }

    // 先确认 token 本身有效，否则下面所有 401 都会被误读成"权限通过"
    const tv = await checkToken();
    if (!tv.ok) {
      state.fatal = true;
      state.lastError = tv.reason;
      warn(tv.reason);
      return;
    }

    // repo 留空或只填了名字时先归一/发现，否则额度那项查不了
    if (!cfg.repo || !cfg.repo.includes('/')) {
      state.repoTried = true;
      try { await discoverOnce(); } catch { /* 留给 refresh 报错 */ }
    }

    const checks = [
      ['account-engage:r', () => api('/workspace/list?page=1&page_size=1')],
    ];
    // repo 还没认出来时跳过组织额度这项，否则 split('/')[0] 是空串
    if (cfg.repo) {
      checks.push(['group-resource:r', () => api(`/${cfg.repo.split('/')[0]}/-/charge/quota`)]);
    }

    const lacking = [];
    for (const [scope, fn] of checks) {
      try { await fn(); } catch (e) {
        if (e?.permission) lacking.push(...e.scopes);
      }
    }

    // 工作区已就绪时顺带验证日志权限（这是最关键的一项）
    if (state.sn && cfg.repo) {
      try { await api(`/${cfg.repo}/-/build/runner/download/log/${encodeURIComponent(state.sn)}-001`); }
      catch (e) { if (e?.permission) lacking.push(...e.scopes); }
    }

    const req = PERMISSIONS.filter((p) => p.need === 'required').map((p) => p.scope);
    const missingReq = req.filter((s) => lacking.includes(s));

    if (missingReq.length) {
      warn(`缺少必需权限 ${missingReq.join('、')}：插件无法取到地址。`
        + '请到 CNB → 头像 → 访问令牌 → 编辑，勾上后重启工作区。');
    } else if (lacking.length) {
      const optional = lacking.filter((s) => !req.includes(s));
      warn(`缺少可选权限 ${optional.join('、')}：对应功能会降级，核心功能不受影响。`
        + optional.map((s) => {
          const p = PERMISSIONS.find((x) => x.scope === s);
          return p ? `${s}=${p.label}（${p.missing}）` : s;
        }).join('；'));
    } else {
      say(`权限自检通过：${req.join('、')} 齐全`);
    }
  }

  // token 本身无效（401）和"权限不够"（403）要分开报，别混成一句"权限通过"
  async function checkToken() {
    try {
      await api('/workspace/list?page=1&page_size=1');
      return { ok: true };
    } catch (e) {
      if (e?.permission) return { ok: true };              // 403：token 有效，只是权限不够
      if (/HTTP 401/.test(e?.message || '')) {
        return { ok: false, reason: '令牌无效或已过期（401）——请到 CNB 重新生成访问令牌' };
      }
      return { ok: false, reason: `无法验证令牌：${e?.message || e}` };
    }
  }

  // 从 magpie 保存的登录信息里取出凭据，写进 cfg。
  //
  // 凭据变化时必须重置这个账号的状态，否则换新 token 后插件仍用旧的。
  function applyCredentials(auth) {
    const meta = auth?.metadata || {};

    const nextToken = String(meta.token || '').trim();
    const nextProxy = String(
      meta.proxyKey || (auth?.type === 'oauth' ? auth.access : auth?.key) || '',
    ).trim();

    // options 里显式配的优先（用户可以只填 options 不登录）
    const token = nextToken || cfg.token;
    const proxyKey = (nextProxy && nextProxy !== 'unset') ? nextProxy : cfg.proxyKey;

    // 只有"原本有值、现在换成另一个值"才算变更。
    // 首次填充（cfg 里还是空的）不算 —— 否则第一次 usage 就把刚拿到的
    // state.uri 清成 null，后面的空闲检测永远看不到 uri。
    const tokenChanged = !!cfg.token && !!token && token !== cfg.token;
    const proxyChanged = !!cfg.proxyKey && !!proxyKey && proxyKey !== cfg.proxyKey;
    const changed = tokenChanged || proxyChanged;
    if (changed) {
      if (tokenChanged) {
        say('令牌已更新，重置该账号状态并重新识别工作区');
      }
      cfg.token = token || cfg.token;
      cfg.proxyKey = proxyKey || cfg.proxyKey;

      // 地址、工作区、失败计数都可能属于旧凭据，全部作废
      state.uri = null;
      state.sn = null;
      state.status = null;
      state.lastError = null;
      state.fatal = false;        // ← 之前永不重置，改好配置也得重启
      state.repoTried = false;    // 允许重新自动发现仓库
      state.failures = 0;
      state.lastCheck = 0;
      state.readyPromise = null;
      state.discovering = null;
      // 定时器保留（周期没变），但立刻触发一轮
      if (state.timer) state.readyPromise = tick(cur()).catch(() => {});
    } else {
      if (!cfg.token) cfg.token = token;
      if (!cfg.proxyKey) cfg.proxyKey = proxyKey;
    }

    // 旧版本登录的账号没有 metadata.email，多账号无法区分。
    // 插件改不了宿主存储，只能提示用户重登一次。
    if (meta.token && !meta.email && !state.warnedLegacyAccount) {
      state.warnedLegacyAccount = true;
      warn('这个账号是旧版本登录的（缺 metadata.email），会导致多账号被合并。'
        + `请重新执行一次 magpie plugin login ${PLUGIN_ID} 以启用多账号区分。`);
    }

    // repo：下拉里选过就用它（明确意图，别再去猜）；
    // 没选就让 refresh 里的 discoverRepo() 自动识别。
    if (!cfg.repo && meta.repo) {
      const picked = normalizeRepo(meta.repo);
      if (picked) {
        cfg.repo = picked.includes('/') || !meta.org ? picked : `${meta.org}/${picked}`;
      }
    }

    // 组织此刻已确定（metadata.org 或仓库前缀），补上名字里的组织后缀。
    // 旧账号标签只有用户名，不补的话多组织会显示成同一个人。
    const c = cur();
    if (c && !String(c.label || '').includes('@')) {
      c.label = labelOf(auth, c, (cfg.repo || '').split('/')[0]);
    }
  }

  // ---------- 后台轮询 ----------
  // 任何钩子都可以启动轮询，并支持"立即踢一脚"，这样登录后不发消息
  // 也能拿到工作区状态。
  //
  // 注意：定时器回调是在"账号作用域外"跑的，所以 tick 必须自己带上 ctx。
  async function tick(ctx = cur()) {
    if (!ctx) return;
    return within(ctx, async () => {
      if (ctx.state.ticking) return;
      ctx.state.ticking = true;
      try { await refresh('interval'); } catch { /* 已经在 state 里记了 */ }
      finally { ctx.state.ticking = false; }
    });
  }

  // 定时器同样按账号各起一个：每个账号的巡检周期、工作区、地址都独立
  function ensureTimer() {
    const self = cur();
    if (!state.timer) {
      state.timer = setInterval(() => { tick(self).catch(() => {}); }, cfg.checkSeconds * 1000);
      state.timer?.unref?.();
    }
    // 第一次调用时立刻跑一轮，不等到下一个周期
    if (!state.readyPromise) {
      state.readyPromise = tick(self).catch(() => {});
    }
    return state.readyPromise;
  }

  // 外部触发：马上刷新一次并等到结果（登录后、usage 被读时用）
  async function kick(reason = 'kick') {
    ensureTimer();
    if (state.ticking) return state.readyPromise;   // 正在跑，跟着等同一个结果
    return tick(cur());
  }

  // 动态提问：先选组织、再选仓库，全部用真实数据做成下拉。
  // 宿主调用时 this 不一定指向 methods 对象，所以抽成独立函数。
  async function askNext(inputs = {}) {
  const token = String(inputs.token || '').trim();

  // 1) 令牌
  if (!inputs.token) {
    return {
      type: 'password',
      key: 'token',
      message: 'CNB 访问令牌（CNB → 头像 → 访问令牌，不是 sk- 开头）',
      placeholder: '一串字母数字',
    };
  }
  if (/^sk-/.test(token)) {
    return {
      type: 'text',
      key: 'token',
      message: '这看起来是 PROXY_KEY（sk- 开头），不是 CNB 访问令牌。'
        + '请重新输入 CNB 访问令牌：',
      placeholder: 'CNB → 头像 → 访问令牌',
    };
  }

  // 2) 组织（用令牌查出真实的组织列表）
  if (!inputs.org) {
    const orgs = await listOrgsForLogin(token).catch(() => null);
    if (!orgs || !orgs.length) {
      // 查不到就退回手填，不让流程卡死
      return {
        type: 'text',
        key: 'org',
        message: '组织（自动查询失败，请手动填写你的 CNB 组织名）',
        placeholder: '例如 alice',
      };
    }
    const opts = orgs.slice(0, 40).map((o) => ({
      label: o,
      value: o,
      hint: '',
    }));
    // 只有一个组织就不打扰用户了：直接返回仓库那一步（递归跳过组织）
    if (opts.length === 1) {
      return askNext({ ...inputs, org: opts[0].value });
    }
    return {
      type: 'select',
      key: 'org',
      message: `选择组织（共 ${opts.length} 个）`,
      options: opts,
    };
  }

  // 3) 仓库（只列该组织下、跑着 cnb2api 的）
  // 用 repoAsked 标记"问过了"，否则用户留空时会一直重复问同一个问题（死循环）
  if (!inputs.repo && !inputs.repoAsked) {
    const found = await listCnbReposForLogin(token, inputs.org).catch(() => null);
    if (!found) {
      return {
        type: 'text',
        key: 'repo',
        message: '仓库名（自动查询失败，可留空让插件稍后自己识别）',
        placeholder: '例如 my-gateway（留空即可）',
      };
    }
    if (!found.length) {
      // 一个都没找到时，加个"跳过"选项，让用户能明确表示"让插件自己认"
      return {
        type: 'select',
        key: 'repo',
        message: `组织 ${inputs.org} 下暂时没查到跑着 cnb2api 的仓库`,
        options: [
          { label: '（留空，稍后自动识别）', value: '', hint: '推荐' },
        ],
      };
    }
    if (found.length === 1) {
      // 只有一个，直接用它，不打扰用户
      return askNext({ ...inputs, repo: found[0].repo, repoAsked: true });
    }
    return {
      type: 'select',
      key: 'repo',
      message: `选择仓库（${inputs.org} 下有 ${found.length} 个在跑 cnb2api）`,
      options: found.map((r) => ({
        label: r.repo,
        value: r.repo,
        hint: r.running ? '运行中' : '已停止',
      })),
    };
  }

  // 4) PROXY_KEY
  if (!inputs.proxyKey) {
    return {
      type: 'password',
      key: 'proxyKey',
      message: 'PROXY_KEY（你自己 .cnb.yml 里设的那个，通常 sk- 开头）',
      placeholder: 'sk-…',
    };
  }
  return null;

  }

  return {
    config: async (c) => {
      // 插件加载时还没有"当前账号"（config 不在账号作用域里），
      // 所以这里不启动轮询 —— 等 loader/usage 首次被调用、拿到 auth 后自然启动。
      c.provider ??= {};
      // 用 ??= 避免覆盖用户在 plugins.json 里配的供应商
      c.provider['cnb2api'] ??= {
        name: 'CNB2API',
        // chat completions 协议（cnb2api 只实现了这个）
        npm: '@ai-sdk/openai-compatible',
        api: 'https://placeholder-9001.cnb.run/v1',
        models: Object.fromEntries(
          modelIds().map((m) => [m, {
            name: m,
            // cnb2api 透传原生工具调用；缺了 tool_call 时 agent 不会下发 tools
            tool_call: true,
            // 上下文按 128k 申报：不填的话 agent 可能按极小值截断历史
            limit: { context: 128000, output: 64000 },
            reasoning: false,
          }]),
        ),
      };
    },

    auth: {
      provider: 'cnb2api',
      icon: 'https://cnb.cool/favicon.ico',

      // 两类完全不同的凭据，分两个输入框，很容易填反：
      //
      //   CNB 访问令牌  → 调 CNB OpenAPI（查工作区、读日志、拉起工作区）
      //                   由 CNB 校验，形如 nkXXXXXXXX
      //   PROXY_KEY     → 调你自己工作区里的 cnb2api 网关
      //                   由 `.cnb.yml` 里的环境变量校验，通常形如 sk-xxx
      //
      // authorize 里当场校验 CNB 令牌，填错立刻报错，不等请求时才失败。
      methods: [
        {
          type: 'api',
          label: 'CNB2API 凭据',
          // prompts 是给不支持动态提问的宿主用的静态兜底（OpenCode 只认这个）。
          // magpie 走下面的 ask()，能按已答内容动态生成下拉选项。
          prompts: [
            { type: 'password', key: 'token', message: 'CNB 访问令牌（CNB → 头像 → 访问令牌）' },
            { type: 'password', key: 'proxyKey', message: 'PROXY_KEY（.cnb.yml 里设的那个）' },
          ],

          // ---- 动态提问：一步一步来，每步都拉真实数据做成下拉 ----
          //
          // ask(inputs) 是异步的，inputs 是已答内容，返回下一个问题或 null。
          // 用它实现「先选组织 → 再选仓库」的联动下拉，而不是让用户手打。
          ask: (inputs) => askNext(inputs),

          async authorize(inputs) {
            const token = (inputs?.token || '').trim();
            const proxyKey = (inputs?.proxyKey || '').trim();
            // ask() 里选了组织/仓库就存下来；用户没选（自动跳过）就留给自动识别
            const org = (inputs?.org || '').trim();
            const repo = normalizeRepo(inputs?.repo) || '';
            if (!token) return { type: 'failed', error: '请填写 CNB 访问令牌' };
            if (!proxyKey) return { type: 'failed', error: '请填写 PROXY_KEY' };

            // ---- 1. 校验令牌，同时拿到这个账号的稳定身份 ----
            // 身份标识必须唯一，否则 magpie 会把两个账号当成同一个：
            // 「新的登录和已有账号标识相同时会替换那个账号；没有标识时比较密钥」。
            // 多个账号常共用同一个 proxyKey，所以要给出独立的标识。
            let me = null;
            try {
              const res = await fetch(`${CNB_API}/workspace/list?page=1&page_size=1`, {
                headers: cnbHeaders(token),
                signal: AbortSignal.timeout(15000),
              });
              if (res.status === 401) {
                return {
                  type: 'failed',
                  error: 'CNB 访问令牌无效或已过期（401）。请到 CNB → 头像 → 访问令牌 重新生成。',
                };
              }
              if (res.status === 403) {
                const body = await res.text().catch(() => '');
                const ex = explainScope(body);
                return {
                  type: 'failed',
                  error: `CNB 访问令牌缺少必需权限：${(ex?.missing || []).join('、') || 'account-engage:r'}`,
                };
              }
            } catch (e) {
              return { type: 'failed', error: `无法验证 CNB 访问令牌：${e.message}` };
            }

            // /user 拿不到也不致命，但拿不到就没法保证账号唯一性
            try {
              const u = await fetch(`${CNB_API}/user`, {
                headers: cnbHeaders(token),
                signal: AbortSignal.timeout(12000),
              });
              if (u.ok) me = await u.json();
            } catch { /* 忽略 */ }

            const uid = me?.id ? String(me.id) : '';
            const username = me?.username || '';
            if (!uid) {
              return {
                type: 'failed',
                error: '无法从令牌读出 CNB 账号信息（/user 不可用），'
                  + '这样无法区分多个账号。请确认令牌包含 account-engage:r 权限。',
              };
            }

            if (token === proxyKey) {
              return {
                type: 'failed',
                error: '两栏填的是同一个值。CNB 访问令牌和 PROXY_KEY 是两个不同的东西：'
                  + '前者在 CNB 个人设置里生成，后者是 .cnb.yml 里的 PROXY_KEY。',
              };
            }

            // ---- 2. 顺手把这个账号名下的仓库列出来，方便用户确认 ----
            const repos = await listReposForLogin(token).catch(() => null);
            const notes = [`账号：${username || uid}`];
            if (repos && repos.length) {
              notes.push(`名下有 ${repos.length} 个仓库：${repos.slice(0, 8).join('、')}`
                + `${repos.length > 8 ? ' 等' : ''}（插件会自动识别哪个跑着 cnb2api）`);
            }
            say(`登录成功：\n  ${notes.join('\n  ')}`);

            return {
              type: 'success',
              // key 存 proxyKey：magpie 会把它当 apiKey 发给 cnb2api
              key: proxyKey,
              // api 类型的登录只保留 type/key/metadata，顶层字段会被丢弃。
              // 账号身份标识必须放在 metadata.email：多个账号常共用同一个
              // proxyKey，仅凭 key 无法区分，会被合并成一个账号。
              accountId: `cnb:${uid}`,
              uid: `cnb:${uid}`,
              name: username || uid,
              metadata: {
                token,
                proxyKey,
                uid,
                username: username || undefined,
                // 账号身份标识。额度按组织计，所以同一用户的不同组织
                // 必须是两个独立账号 —— 把组织拼进 email 即可。
                // 没选组织时保持原格式，避免已登录的账号被当成新的。
                email: username
                  ? (org ? `${username}+${org}@cnb.cool` : `${username}@cnb.cool`)
                  : undefined,
                // 下拉里选定的组织/仓库。没选（自动跳过）时不写，交给自动识别。
                org: org || undefined,
                repo: repo || undefined,
              },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth?.();
        // 关键：先切到"这个账号"的作用域，后面所有 cfg/state 都只影响它。
        // magpie 会为每个账号各调一次 loader，闭包是共用的。
        const ctx = ctxFor(auth);
        // 先给个初值（此刻还读不到 cfg.repo），拿不到组织就只是用户名
        if (!ctx.label) ctx.label = labelOf(auth, ctx);
        return within(ctx, async () => {
          applyCredentials(auth);   // 先读凭据，再启动轮询（顺序很关键）
          // cfg.repo 可能已经识别出来了，用它补齐组织后缀
          if (!ctx.label.includes('@')) {
            ctx.label = labelOf(auth, ctx, (cfg.repo || '').split('/')[0]);
          }
          ensureTimer();

          // 首次调用时把权限状况说清楚（只跑一次）
          reportPermissions().catch(() => {});

          // 只缺 token 才没法救；repo 留空会尝试自动发现（别人的仓库不叫 cnb2api 很正常）
          if (!cfg.token) {
            state.fatal = true;
            state.lastError = '尚未填写 CNB 访问令牌';
          } else if (!state.uri) {
            // 首请求：还没有地址，等一个有界预算（工作区冷启 ~30-90s）
            await waitForReady(90_000);
          }

          // 地址最终还是没拿到：不在 loader 里抛错（那会让整个请求失败且原因不明），
          // 而是在下面的 fetch 里返回一个 OpenAI 格式的错误，agent 能看到人话。

          const key = cfg.proxyKey || '';

          // 这个 fetch 属于"这个账号"：用 within 绑定，ALS 会把它带进所有 await
          const fetchFor = (input, init, boundCtx) => within(boundCtx, () => doFetch(input, init));

          const doFetch = async (input, init = {}) => {
            // 每来一个请求就记一次"在用"，空闲自动停止靠它判断
            state.lastUsedAt = Date.now();
            // 用户为了省核时把工作区停了，现在又来请求了 —— 该拉起来了
            if (state.paused) {
              state.paused = false;
              state.stoppedReason = null;
              say('收到请求，重新拉起工作区');
            }
            // 地址没拿到就别发到一个假域名上，直接给出可读原因
            if (!state.uri) {
              await refresh('no-uri');
              if (!state.uri && !state.fatal && !(await waitForReady(60_000))) {
                // 走到这里说明不是 token/权限问题，而是工作区没起来
                return oaiError(503,
                  `cnb2api 地址不可用：${state.lastError || '工作区未就绪'}`,
                  '检查工作区是否已启动；需要权限 account-engage:r + repo-cnb-trigger:r');
              }
              if (!state.uri) {
                // 三种原因分别给不同指引，别一律让人去改令牌
                const why = state.lastError || 'cnb2api 不可用';
                let hint;
                if (!cfg.token) {
                  hint = `还没填 token。执行 magpie plugin options ${PLUGIN_ID} `
                    + '\'{"token":"你的 CNB 访问令牌"}\'，或在 Plugins → CNB2API → Options 里填';
                } else if (/仓库 .* 不存在/.test(why)) {
                  hint = '检查插件选项里的 repo，可填 org/repo、仓库名、或仓库页面地址';
                } else if (/令牌无效|401/.test(why)) {
                  hint = 'CNB → 头像 → 访问令牌，重新生成一个（勾上必需权限）后填回插件选项';
                } else {
                  hint = `检查必需权限 ${PERMISSIONS.filter((p) => p.need === 'required').map((p) => p.scope).join(' + ')}`;
                }
                return oaiError(503, why, hint);
              }
            }

            // input 是完整 URL（magpie 已用 baseURL + 路径拼好）。
            // 不管 magpie 存下的是哪个 baseURL，都改写成当前真实地址。
            const target = () => {
              const s = String(input instanceof Request ? input.url : input);
              if (!state.uri) return null;
              return s.replace(/^https?:\/\/[^/?#]+/, state.uri);
            };
            const send = (url) => (url === String(input instanceof Request ? input.url : input))
              ? fetch(input, init)                       // 没变就原样发，保留 Request 语义
              : fetch(url, init);

            const first = target();
            try {
              const res = await send(first);
              // 401 说明 proxyKey 不对：补一句人话，并保留 401 让 magpie 标记账号
              if (res.status === 401) {
                return annotate(res, 'cnb2api 拒绝了密钥：检查插件选项里的 proxyKey 是否等于 .cnb.yml 的 PROXY_KEY');
              }
              return res;
            } catch (e) {
              warn(`请求失败，先刷新地址：${e.message}`);
              // 并发请求共用一次恢复动作：否则 5 个请求会各自 refresh
              // 并各自等 120 秒，把 CNB 接口打成筛子。
              if (!state.recoveringPromise) {
                state.recoveringPromise = (async () => {
                  await refresh('request-failed').catch(() => {});
                  // 检测到停止或被拉起过 -> 值得等一会儿；否则只试一次
                  if (!state.uri || state.recovering) await waitForReady(120_000);
                })().finally(() => { state.recoveringPromise = null; });
              }
              await state.recoveringPromise;
              const again = target();
              if (!again) return oaiError(503, `cnb2api 请求失败：${e.message}`, state.lastError || '');
              if (again !== first) say(`改用新地址重试：${maskHost(hostOf(state.uri))}`);
              return await send(again);
            }
          };

          return {
            // 文档没有承诺 baseURL 支持 getter：magpie 完全可能在 loader 返回时
            // 就读走这个值（解构或 spread 都会把 getter 变成字符串快照）。
            // 所以这里保留 getter 只是为了"每次现读"的场景能拿到最新值，
            // 真正的地址跟随由下面的 fetch 强制重写 URL 完成，不依赖 getter。
            get baseURL() {
              return ctx.state.uri ? `${ctx.state.uri}/v1` : 'https://placeholder-9001.cnb.run/v1';
            },
            apiKey: key,
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            // 绑定本账号的 ctx：magpie 可能并发调两个账号的 fetch，
            // 不能依赖"当前"是谁，必须闭包捕获。
            fetch: (input, init) => fetchFor(input, init, ctx),
          };
        });
      },

      // 用量钩子：把工作区状态和 CNB 真实额度显示在 magpie 的 quota 里。
      // 文档要求「厂商没给 used 就不要传，不要用 0 表示不知道」，所以这里
      // 能用真实数字（CNB charge 接口）就给 amount/limit，拿不到就只报 error。
      async usage(getAuth) {
        // usage 是按账号跑的，必须在对应账号作用域里算，否则会读到别人的额度
        const auth = await getAuth?.();
        const ctx = ctxFor(auth);
        if (!ctx.label) ctx.label = labelOf(auth, ctx);
        return within(ctx, async () => {
        // 必须先把凭据读进 cfg —— usage 可能先于 loader 被调用（比如刚登录、
        // 或只在界面上看额度而不发消息），缺少这步 cfg.token 就是空的。
        applyCredentials(auth);
        if (!ctx.label.includes('@')) {
          ctx.label = labelOf(auth, ctx, (cfg.repo || '').split('/')[0]);
        }

        // 账号在界面上的名字。必须带组织：同一用户的多个组织是两个账号，
        // 都显示成「ikoude」就分不开了。
        // 不返回 user 的话宿主要拿 key 尾缀当名字（"API key …-key"）。
        const userName = String(
          auth?.metadata?.username || auth?.metadata?.email || auth?.name || '',
        ).trim();
        // 旧账号没有 metadata.org，用运行时识别出的仓库前缀补
        const authOrg = String(
          auth?.metadata?.org || (cfg.repo || '').split('/')[0] || '',
        ).trim();
        const accountName = userName
          ? (authOrg ? `${userName}@${authOrg}` : userName)
          : '';
        // usage 是登录/打开插件界面时最早被调的钩子，顺势主动拉一次。
        if (!state.uri) {
          await kick('usage-first').catch(() => {});
        } else {
          ensureTimer();   // 已经有地址了，保证定时器在跑
          // 有地址时也要刷新一次：空闲自动停止依赖这次巡检，
          // 只在后台等定时器的话，用户打开界面看额度时永远不会触发。
          // 用节流避免频繁调用 usage 时反复打 CNB 接口。
          if (Date.now() - state.lastCheck > 15_000) {
            await refresh('usage').catch((e) => console.error('[usage] refresh err', e.message));
          }
        }

        const out = {
          plan: state.status === 'running' ? 'running' : (state.status || 'unknown'),
          // 账号名用 CNB 用户名，多账号才能分清谁是谁
          ...(accountName ? { user: accountName } : {}),
        };

        // 1) 工作区/地址状态
        // 这一行回答"这个账号现在能不能用"。地址是 API 端点，默认打码，
        // 因为额度面板常被截图分享。
        const alive = state.uri ? await health(state.uri, 4000) : false;
        const host = state.uri ? hostOf(state.uri) : '';
        out.windows = [{
          name: 'workspace',
          // aside：用掉它不影响账号本身可用（文档语义）
          aside: true,
          display: alive
            ? `ok · ${maskHost(host)}`
            : `不可用 · ${state.lastError || '未就绪'}`,
        }];

        // 想看完整地址时设这个环境变量（分享截图前记得关掉）
        if (process.env.CNB2API_SHOW_FULL_HOST === '1' && alive) {
          out.windows[0].display = `ok · ${host}`;
        }

        // 1b) 自动重启状态：权限不够时明确告诉用户"能跟随但不会重启"
        if (cfg.autoStart && state.status !== 'running' && state.autoStartBlocked) {
          out.windows.push({
            name: 'auto-restart',
            aside: true,
            display: '已禁用 · 缺 repo-cnb-trigger:rw',
          });
        }

        // 2) CNB 真实额度（需要 account-engage:r / group-resource:r）
        const org = cfg.repo.split('/')[0];
        if (org && cfg.token) {
          try {
            const q = await charge(org);
            if (q?.credit && q.credit.used != null) {
              const c = q.credit;
              out.windows.push({
                name: 'AI credits',
                // used 是**百分比 0-100**，不是已用量。
                // 它是进度条的开关：不给这个字段，宿主认为窗口"没有读数"，
                // 只渲染文字而不画进度条。
                used: c.usedPct != null ? Math.min(100, Math.max(0, round1(c.usedPct))) : 0,
                // amount/limit/unit：进度条上的数字（已用/总额 + 单位）
                amount: round1(c.used ?? 0),
                limit: round1(c.total),
                unit: 'cr',
                // 文字只补进度条看不出来的：特权 · 冻结 · 可用
                display: [
                  bonusPart(c.bonus, c.bonusDesc, c.bonusExpire, c.bonusExpired),
                  `冻结 ${num1(c.frozen)}`,
                  `可用 ${num1(c.remain)}`,
                ].filter(Boolean).join(' · '),
              });
            }
            if (q?.devHours && q.devHours.used != null) {
              const d = q.devHours;
              out.windows.push({
                name: 'dev core-hours',
                used: d.usedPct != null ? Math.min(100, Math.max(0, round1(d.usedPct))) : 0,
                amount: round1(d.used ?? 0),
                limit: round1(d.total),
                unit: 'h',
                display: [
                  bonusPart(d.bonus, d.bonusDesc, d.bonusExpire, d.bonusExpired),
                  `冻结 ${num1(d.frozen)}`,
                  `可用 ${num1(d.remain)}`,
                ].filter(Boolean).join(' · '),
              });
            }
          } catch (e) {
            out.error = `额度查询失败：${e.message}`;
          }
        }
        return out;
        });
      },
    },

    // ---- 工具：让 agent 自己管理核时 ----
    // tool 会暴露到 magpie 的 plugin-tools MCP server 上，agent 可直接调用。
    // 工作区 running 就按时间扣费，所以"用完就停"是唯一有效的省钱动作。
    //
    // 宿主的 runTool 不注入账号作用域，所以要自己遍历 ctxs 跑每个账号。
    tool: {
      cnb2api_workspace_status: {
        description:
          '查看 CNB2API 工作区当前状态：是否在运行、地址、空闲多久、是否已被暂停。'
          + '在决定要不要停止（省核时）之前先调这个。',
        args: {},
        async execute() {
          return forEachAccount(async (ctx) => {
            if (!state.sn) await refresh('tool-status').catch(() => {});
            const idleMin = state.lastUsedAt
              ? Math.floor((Date.now() - state.lastUsedAt) / 60_000)
              : null;
            const lines = [
              `状态：${state.status || 'unknown'}${state.paused ? '（已暂停，不再自动拉起）' : ''}`,
              `仓库：${cfg.repo || '（未确定）'}`,
              `地址：${state.uri ? maskHost(hostOf(state.uri)) : '（无）'}`,
            ];
            if (state.sn) lines.push(`工作区编号：${state.sn}`);
            if (idleMin != null) lines.push(`空闲：${idleMin} 分钟`);
            lines.push(cfg.idleStopMinutes
              ? `空闲自动停止：${cfg.idleStopMinutes} 分钟`
              : '空闲自动停止：未开启（idleStopMinutes=0）');
            if (state.lastError) lines.push(`最近错误：${state.lastError}`);
            return lines;
          });
        },
      },

      cnb2api_workspace_start: {
        description:
          '拉起 CNB2API 工作区。工作区已停止时调用它。注意：运行中的工作区会持续消耗核时。',
        args: {},
        async execute() {
          return forEachAccount(async () => {
            if (state.status === 'running' && state.uri) {
              return [`已经在运行：${maskHost(hostOf(state.uri))}`];
            }
            await startWorkspace();
            const ok = await waitForReady(90_000).catch(() => false);
            return [ok
              ? `已拉起并可用：${maskHost(hostOf(state.uri))}`
              : `已提交拉起，但还没就绪（${state.lastError || '等待中'}），稍后再查或直接发请求`];
          });
        },
      },

      cnb2api_workspace_stop: {
        description:
          '停止 CNB2API 工作区以节省核时。工作区一旦 running 就按时间计费，'
          + '即使没有请求也在扣。用完就可以停，下次请求会自动拉起。'
          + '需要令牌含 account-engage:rw 权限。',
        args: {},
        async execute() {
          return forEachAccount(async () => {
            const r = await stopWorkspace('manual');
            return [r.ok
              ? `${r.message}。核时已停止累积，下次请求会自动拉起（冷启动约 30–90 秒）。`
              : `没能停止：${r.message}`];
          });
        },
      },

      cnb2api_quota: {
        description:
          '查询 CNB 账号的核时和 AI Credits 余量，用来判断还剩多少可用。',
        args: {},
        async execute() {
          return forEachAccount(async () => {
            const org = (cfg.repo || '').split('/')[0];
            if (!org || !cfg.token) return ['还没配置 token 或仓库，无法查询额度'];
            const q = await charge(org).catch((e) => ({ error: e.message }));
            if (q?.error) return [`查询失败：${q.error}`];
            const lines = [];
            if (q?.devHours) {
              const d = q.devHours;
              lines.push(`核时：已用 ${num1(d.used)} / ${num1(d.total)} h，`
                + `剩余 ${num1(d.remain)} h${d.frozen ? `，冻结 ${num1(d.frozen)}` : ''}`);
            }
            if (q?.credit) {
              const c = q.credit;
              lines.push(`AI Credits：已用 ${num1(c.used)} / ${num1(c.total)} cr，`
                + `剩余 ${num1(c.remain)} cr`);
            }
            if (!lines.length) lines.push('（没拿到额度数据，可能缺 group-resource:r 权限）');
            return lines;
          });
        },
      },
    },

    provider: {
      id: 'cnb2api',
      // 文档：models(provider, {auth}) 返回「以 id 为键」的对象，不是数组。
      // 展开 provider.models 再改名是最省事的做法（这样能继承 config 里写的字段）。
      async models(provider) {
        const out = {};
        for (const id of modelIds()) {
          out[id] = { ...(provider?.models?.[id] || {}), id, name: id };
        }
        return out;
      },
    },
  };
};

// 测试入口：辅助函数放这里，避免被 magpie 当成插件调用（文档要求）
export const _internal = {
  pickUri, pickUriFromLog, strip, materialize, opts, normalizeRepo,
  PERMISSIONS, explainScope, scopeReport,
};
