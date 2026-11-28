// magpie-cnb2api — 把你 CNB 工作区里的 cnb2api 网关接成 magpie 的一个供应商。
//
// 真正的问题只有一个：**工作区地址会变，工作区还会被停掉**。平台每次重启工作区
// 都换一个随机子域（<random>-<port>.cnb.run），停掉后不再响应，也不会通知谁。
//
// 插件因此在后台盯住这两件事（provider 插件跑在 Bun 层，有 setInterval），
// 并让每一次请求都走当前地址——地址一变，下一个请求就自动走新的，不需要重装、
// 不需要重启 magpie，也不用用户在界面上点任何东西。
//
// 账号粒度是「用户 + 组织/仓库」：一个 CNB 账号可能同时在几个组织里，每个组织有
// 自己的 AI credits，所以一个组织一个账号。身份标识只用 accountId，不用邮箱。

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  PERMISSIONS,
  accountsFor,
  accountIdOf,
  bonusPart,
  creditNotice,
  fingerprint,
  hostOf,
  maskHost,
  missingScopes,
  modelIds,
  normalizeOptions,
  normalizeRepo,
  num1,
  orgOf,
  parseAccountId,
  pickUri,
  pickUriFromLog,
  round1,
  settleCharge,
} from './toolkit.mjs';


// CNB OpenAPI 基址。每次现读环境变量：插件加载后才设 CNB_API 的场合
// （测试、临时指向镜像）也该生效，不能在 import 时定死。
const cnbApi = () => String(process.env.CNB_API || 'https://api.cnb.cool').replace(/\/+$/, '');
const PLUGIN_ID = 'magpie-cnb2api';
const PROVIDER_ID = 'cnb2api';

// 首请求 / 恢复时等地址的上限。工作区从 start 到代理监听 9001 通常要 30–90 秒。
const READY_BUDGET_MS = 90_000;
const RECOVER_BUDGET_MS = 120_000;
// 提交启动后的一段时间内不重复 POST start：waitForReady 每 6 秒刷一轮，
// 工作区还没进 running 的那几十秒会把 start 打成连发。
const START_COOLDOWN_MS = 60_000;
// 探活超时。太长会把状态面板和请求一起拖住。
const HEALTH_MS = 1500;

const cnbHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
});

const scopeHint = () =>
  PERMISSIONS.filter((p) => p.need === 'required' || p.need === 'required-for-autostart')
    .map((p) => p.scope)
    .join(' + ');

// ---------------------------------------------------------------------------
// 纯函数：喂给 magpie 的模型清单
// ---------------------------------------------------------------------------

function modelTable(ids) {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        name: id,
        // cnb2api 透传原生工具调用；缺了这项 agent 不会下发 tools
        tool_call: true,
        // 不申报上下文，agent 可能按极小值截断历史
        limit: { context: 128000, output: 64000 },
        reasoning: false,
      },
    ]),
  );
}

/** OpenAI 格式的错误，agent 直接能看到 message。 */
const oaiError = (status, message, hint = '') =>
  new Response(
    JSON.stringify({
      error: { message: hint ? `${message}（${hint}）` : message, type: 'cnb2api_error', code: status },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

/** 给上游响应补一句提示：重写正文，并按文档去掉 content-length / encoding。 */
async function annotate(res, hint) {
  try {
    const text = await res.text();
    let body;
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

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

export const Cnb2ApiPlugin = async ({ client, options: pluginOptions }) => {
  const config = normalizeOptions(pluginOptions);

  // 账号状态按 accountId 隔离。插件函数只被调用一次，所有账号共用这份闭包，
  // 所以 state / cfg 不能放在闭包顶层，否则两个账号会互相覆盖。
  const ctxs = new Map(); // accountId → ctx
  const seen = new Map(); // fingerprint(token) → { uid, username }
  const chargeCache = new Map(); // fingerprint(token)|org → { at, charge }

  const say = (label, msg) => {
    const line = label ? `[${label}] ${msg}` : msg;
    try {
      client?.app?.log?.({ body: { service: 'cnb2api', level: 'info', message: line } });
    } catch {
      /* 宿主日志不可用不影响功能 */
    }
    console.log(`[cnb2api] ${line}`);
  };
  const warn = (label, msg) => {
    const line = label ? `[${label}] ${msg}` : msg;
    try {
      client?.app?.log?.({ body: { service: 'cnb2api', level: 'warn', message: line } });
    } catch {
      /* 同上 */
    }
    console.warn(`[cnb2api] ${line}`);
  };

  function newState() {
    return {
      uri: null,
      sn: null,
      status: null,
      lastError: null,
      lastCheck: 0,
      starting: false,
      startedAt: 0,
      recovering: false,
      recoveringPromise: null,
      autoStartBlocked: false,
      stopBlocked: false,
      fatal: false,
      failures: 0,
      timer: null,
      readyPromise: null,
      discovering: null,
      reported: false,
      ticking: false,
      permissionWarning: null,
      lastUsedAt: 0,
      readySince: 0,
      paused: false,
      stoppedReason: null,
      stopping: false,
      // 最近一次额度结论：{ at, charge, error }
      credit: null,
      quotaBlocked: false,
    };
  }

  function newCtx(key) {
    const parsed = parseAccountId(key);
    return {
      key,
      label: key,
      // 这个账号是谁、哪个组织、哪个仓库。凭据到达后由 applyAuth 补齐。
      identity: { username: parsed.username, org: parsed.org, repo: parsed.repo },
      // accountId 里带的组织/仓库是登录时明确选过的，优先于选项；
      // 选项里的 org/repo 作为兜底（手工配置、不经登录表单的账号）。
      cfg: { ...config, repo: parsed.repo || config.repo, org: parsed.org || config.org },
      state: newState(),
    };
  }

  const ctxFor = (key) => {
    let ctx = ctxs.get(key);
    if (!ctx) {
      ctx = newCtx(key);
      ctxs.set(key, ctx);
    }
    return ctx;
  };

  /**
   * 这个账号在 magpie 里叫什么。
   *
   * 每条登录信息的 identity 由 authorize 的 accountId 决定——magpie 的 runtime
   * 用同一口径（accountId 优先）判断两个登录是不是同一个账号，所以插件必须用
   * 同一个名字建上下文，否则一条登录会在表里长出两个 key。
   * 没有 accountId 的（例如只填了选项、没走登录表单）退回登录信息里的
   * 用户名 + 组织，而不是 key 或邮箱。
   */
  function accountKeyOf(auth) {
    const meta = auth?.metadata || {};
    const explicit = String(auth?.accountId || '').trim();
    if (explicit) return explicit;
    const who = String(meta.username || '').trim();
    const orgs = String(meta.org || '').split(',').map((s) => s.trim()).filter(Boolean);
    const repo = String(meta.repo || '').trim();
    if (who && orgs.length) {
      return accountIdOf({ username: who, org: orgs[0], repo: orgOf(repo) === orgs[0] ? repo : '' });
    }
    return who || providerKey();
  }

  const providerKey = () => PROVIDER_ID;

  // 当前在跑哪个账号的作用域。定时器回调、fetch 闭包、工具都靠它取配置，
  // 不用把 cfg/state 传遍每个函数。
  //
  // 用 AsyncLocalStorage 而不是「栈式变量」：任何一个 await 都可能切到别的
  // 账号的代码，栈式变量会被覆盖；ALS 跟随异步调用链传递，天然隔离。
  const als = new AsyncLocalStorage();

  function need() {
    const ctx = als.getStore();
    if (!ctx) throw new Error('内部错误：在账号作用域外访问账号数据');
    return ctx;
  }

  const cfg = new Proxy({}, {
    get: (_, p) => need().cfg[p],
    set: (_, p, v) => {
      need().cfg[p] = v;
      return true;
    },
  });
  const state = new Proxy({}, {
    get: (_, p) => need().state[p],
    set: (_, p, v) => {
      need().state[p] = v;
      return true;
    },
  });

  // 在某个账号的作用域里执行 fn。ALS 会把上下文带进所有 await 之后，
  // 并发调两个账号时互不干扰。
  //
  // cfg / state 是「当前账号」的 Proxy，必须处在某个 within 里才能读。
  // 定时器回调、工具循环、各钩子的入口都在作用域外，所以要显式 within。
  // 另外，凡是跨了「内部再开 within 的调用」（例如 waitForReady）之后还要
  // 读账号数据的地方，直接读 ctx.state / ctx.cfg（普通对象引用），既省一次
  // Proxy 查找，也不依赖异步上下文是否还在。
  const within = (ctx, fn) => (ctx ? als.run(ctx, fn) : fn());

  // -------------------------------------------------------------------------
  // CNB OpenAPI
  // -------------------------------------------------------------------------

  class ScopeError extends Error {
    constructor(message, scopes = []) {
      super(message);
      this.name = 'ScopeError';
      this.scopes = scopes;
      this.permission = true;
    }
  }

  async function api(path, init = {}) {
    const ctx = need();
    if (!ctx.cfg.token) throw new Error('尚未填写 CNB 访问令牌');
    const res = await fetch(`${cnbApi()}${path}`, {
      ...init,
      headers: {
        ...cnbHeaders(ctx.cfg.token),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(init.timeout || 20000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 403) {
        // 403 且带 scope 信息 → 翻成「该去勾哪一项」
        const scopes = missingScopes(body);
        if (scopes.length) {
          const lines = scopes.map((s) => {
            const p = PERMISSIONS.find((x) => x.scope === s);
            return p ? `缺 ${s}（${p.label}）：${p.missing}` : `缺 ${s}`;
          });
          throw new ScopeError(
            [`权限不足：${path}`, ...lines, '处理：CNB → 头像 → 访问令牌 → 编辑，勾上后重启工作区'].join('；'),
            scopes,
          );
        }
      }
      throw new Error(`${path} HTTP ${res.status} ${body.slice(0, 140)}`);
    }
    return res;
  }

  function humanize(e, repo = cfg.repo) {
    const m = String(e?.message || e || '');
    if (/HTTP 401/.test(m) || /not logged in/i.test(m)) return '令牌无效或已过期';
    if (/HTTP 404/.test(m) && /workspace/i.test(m)) return `仓库 ${repo} 下没有工作区`;
    return m;
  }

  // slug 显式传入时不读 cfg.repo（默认才用当前账号的仓库）。
  // 这样「列全部工作区」不必临时把 cfg.repo 置空，也就不怕中途异常把它丢掉。
  async function listWorkspaces(slug = cfg.repo) {
    const q = new URLSearchParams({ page: '1', page_size: '50' });
    // 不传 slug = 列出「我」名下所有工作区。用来自动发现仓库，因为别人的
    // 仓库不一定叫 cnb2api。
    if (slug) q.set('slug', slug);
    const res = await api(`/workspace/list?${q}`);
    const j = await res.json();
    const list = j.list || j.data || [];
    // 服务端未必真按 slug 过滤，本地再筛一遍：宁可多这一步，也不能误用
    // 别的仓库的工作区（会去读错日志、甚至拉起错仓库）
    if (!slug || !slug.includes('/')) return list;
    return list.filter((w) => (w.slug || w.repo_url) === slug);
  }

  const slugOf = (w) => w?.slug || w?.repo_url || '';

  async function pickWorkspace() {
    // 同一个仓库可能有多个实例，优先 running
    const list = await listWorkspaces();
    if (!list.length) return null;
    return list.find((w) => w.status === 'running') || list[0];
  }

  // 确认仓库是否存在。用于把「仓库名填错」和「仓库在但没工作区」区分开，
  // 避免填错时一直尝试 start（会得到一串 404 并反复重试）。
  // {repo} 对存在的私有仓库可能返回 403（缺 repo-basic-info:r），所以
  // **只有 404 才算不存在**，403 说明仓库在、只是详情看不了。
  async function repoExists(slug) {
    if (!slug || !slug.includes('/')) return false;
    try {
      const res = await api(`/${slug}`);
      return res.ok;
    } catch (e) {
      return !/HTTP 404/.test(String(e?.message || ''));
    }
  }

  // 取地址有两条路，谁先成功用谁：
  //   a) detail 的 webide 等字段 —— 实测返回的是 cnb.cool 控制台地址，基本用不上，
  //      但保留，因为 CNB 可能调整字段，能拿到就比拉整份日志快。
  //   b) 流水线日志里的 PROXY_URI= —— 唯一可靠来源。
  async function uriFromDetail(sn) {
    try {
      const res = await api(`/${cfg.repo}/-/workspace/detail/${encodeURIComponent(sn)}`);
      const j = await res.json();
      for (const k of ['webide', 'jumpUrl', 'codebuddyweb', 'remoteSsh']) {
        const u = pickUri(j?.[k], cfg.port);
        if (u) return u;
      }
    } catch {
      // 刚启动时 detail 可能 404，交给日志兜底
    }
    return null;
  }

  async function uriFromLog(sn) {
    try {
      const res = await api(`/${cfg.repo}/-/build/runner/download/log/${encodeURIComponent(sn)}-001`, {
        timeout: 30000,
      });
      return pickUriFromLog(await res.text(), cfg.port);
    } catch (e) {
      // 权限问题必须冒泡：这是唯一能取到地址的路子，吞掉就只剩「取不到地址」
      if (e?.permission) throw e;
      return null;
    }
  }

  async function health(base, ms = HEALTH_MS) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
      if (res.status !== 200) return false;
      return /"status"\s*:\s*"ok"/.test(await res.text());
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 额度
  // -------------------------------------------------------------------------

  /** 查一个组织的额度。成功进短缓存，失败返回 { error } 并写明原因。 */
  async function charge(org, { fresh = false, timeoutMs = 8000, ttlMs = 10_000 } = {}) {
    const key = `${fingerprint(cfg.token)}|${org}`;
    const hit = chargeCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.value;

    const get = (path) =>
      api(`/${org}/-/charge/${path}`, { timeout: timeoutMs })
        .then((r) => r.json())
        .catch((e) => ({ error: e?.message || String(e) }));

    const [quota, volume, special] = await Promise.all([
      get('quota'),
      get('volume'),
      get('special-amount'),
    ]);
    const errors = [quota, volume, special].filter((x) => x && x.error).map((x) => x.error);
    const value = errors.length === 3
      ? { error: errors[0] }
      : { charge: settleCharge(quota, volume, special), errors };

    chargeCache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * 启动前的额度闸门。
   *
   * cnb2api 是 AI 网关：组织的 AI credits 用尽后它对每个请求都回
   * 402 [EXCEEDING_LIMIT]，这时启动工作区只会白等 30–90 秒并消耗核时。
   *
   * 判定口径与「可不可用」一致：可达 && 可用 >= 保底线。
   * **查不到额度时不拦**——拿不到数字就断言「不够」，会把能用的账号挡在外面。
   */
  async function quotaGate({ fresh = false } = {}) {
    const org = cfg.org || orgOf(cfg.repo);
    if (!org || !cfg.token) return { ok: true, unknown: true };
    const r = await charge(org, { fresh, timeoutMs: 8000 }).catch((e) => ({ error: e?.message || String(e) }));
    if (r.error || !r.charge?.credit) {
      state.quotaBlocked = false;
      return { ok: true, unknown: true, why: r.error || '没有额度数据' };
    }
    const c = r.charge.credit;
    state.credit = { at: Date.now(), charge: r.charge };
    if (c.remain == null) {
      state.quotaBlocked = false;
      return { ok: true, unknown: true };
    }
    if (c.remain <= 0) {
      state.quotaBlocked = true;
      return { ok: false, why: 'AI credits 已用尽', credit: c };
    }
    const leftPct = c.total > 0 ? (c.remain / c.total) * 100 : 100;
    if (cfg.creditFloorPercent > 0 && leftPct < cfg.creditFloorPercent) {
      state.quotaBlocked = true;
      return {
        ok: false,
        why: `可用额度 ${num1(c.remain)} cr 低于保底线 ${cfg.creditFloorPercent}%`,
        credit: c,
      };
    }
    state.quotaBlocked = false;
    return { ok: true, credit: c };
  }

  // -------------------------------------------------------------------------
  // 工作区生命周期
  // -------------------------------------------------------------------------

  /**
   * 提交一次启动。返回 { ok, pending?, why? }：
   *   ok=true  已提交；ok=false 且 pending=true 表示已在提交中/冷却期内；
   *   ok=false 且无 pending 表示没拉起来（额度拦住、权限不足、接口报错）。
   *
   * 60 秒冷却期内不重复 POST：waitForReady 每几秒刷一轮，工作区还没进
   * running 的那几十秒会把 start 打成连发。
   */
  async function startWorkspace() {
    // 同理：异步之后不再经过 Proxy，先抓 ctx
    const c = need();
    const { cfg: c2, state: st } = c;

    // 已在提交中 / 刚提交过：不再 POST，但确实还没拉起。
    // 用「同步占位」而不是只在 finally 里清：两个调用并发进来时都得看见它。
    if (st.starting) return { ok: false, pending: true };
    if (st.startedAt && Date.now() - st.startedAt < START_COOLDOWN_MS) {
      st.recovering = true;
      return { ok: false, pending: true };
    }
    st.starting = true; // 同步占位：并发的第二个调用直接返回 pending

    try {
      const gate = await quotaGate().catch(() => ({ ok: true, unknown: true }));
      if (!gate.ok) {
        st.lastError = `${gate.why}：不会拉起工作区（补足额度后巡检会自动启动）`;
        if (!st.quotaBlocked) warn(c.label, st.lastError);
        st.quotaBlocked = true;
        return { ok: false, why: gate.why };
      }

      say(c.label, `工作区未运行（status=${st.status || 'unknown'}），正在拉起…`);
      await api(`/${c2.repo}/-/workspace/start`, {
        method: 'POST',
        body: JSON.stringify({ branch: c2.branch }),
        timeout: 60000,
      });
      st.startedAt = Date.now();
      st.lastUsedAt = Date.now();
      st.paused = false;
      st.stoppedReason = null;
      st.recovering = true;
      st.starting = true; // 从提交到平台翻成 running 之间，都算「正在启动」
      say(c.label, '已提交启动 · 网关通常 30–90 秒内就绪');
      return { ok: true };
    } catch (e) {
      if (e?.permission) {
        // 不是致命错误：地址还能跟随，只是不会自动重启
        st.autoStartBlocked = true;
        warn(c.label, `自动拉起不可用（不影响地址跟随）：${e.message}`);
      } else {
        warn(c.label, `拉起失败：${e.message}`);
      }
      return { ok: false, why: e.message };
    } finally {
      // 失败就清掉「提交中」；成功时保留到 refresh 看到 running 为止
      if (!st.recovering) st.starting = false;
    }
  }

  /** 停掉工作区：工作区一旦 running 就按时间扣核时，不发请求也在扣。 */
  async function stopWorkspace(reason = 'manual') {
    if (state.stopping) return { ok: false, message: '正在停止，请稍候' };
    if (!state.sn) return { ok: false, message: '还没拿到工作区编号（sn），无法停止' };
    state.stopping = true;
    try {
      // 接口要的是 sn（构建号），不是 slug
      await api('/workspace/stop', { method: 'POST', body: JSON.stringify({ sn: state.sn }), timeout: 60000 });
      const why = reason === 'idle' ? `空闲超过 ${cfg.idleStopMinutes} 分钟` : '手动停止';
      state.paused = true;
      state.stoppedReason = reason;
      state.uri = null;
      state.status = 'stopped';
      say(ctxLabel(), `工作区已停止（${why}），不再消耗核时。下次请求会自动拉起。`);
      return { ok: true, message: `已停止（${why}）` };
    } catch (e) {
      if (e?.permission) {
        state.stopBlocked = true;
        const msg = '停止工作区需要 account-engage:rw 权限：CNB → 头像 → 访问令牌 → 编辑，勾上后重试。';
        warn(ctxLabel(), msg);
        return { ok: false, message: msg };
      }
      warn(ctxLabel(), `停止失败：${e.message}`);
      return { ok: false, message: e.message };
    } finally {
      state.stopping = false;
    }
  }

  // 空闲检查：在定时巡检里跑。只在「确实开着 + 确实没人用」时才停。
  async function checkIdle() {
    if (!cfg.idleStopMinutes) return;
    if (state.status !== 'running') return;
    if (state.starting || state.recovering || state.paused) return;
    // 从「拿到地址那一刻」起算空闲：不能用 lastUsedAt 的 0 当「没记录过就不动」，
    // 那样只巡检额度、一直没发过请求的场景永远不会停下，而它正是在白烧核时。
    const since = state.lastUsedAt || state.readySince;
    if (!since) return;
    const limitMs = cfg.idleStopMinutes * 60_000;
    if (Date.now() - since < limitMs) return;
    // 停之前再确认一次确实没有新请求进来（并发场景下 lastUsedAt 可能刚被刷新）
    if (state.lastUsedAt > since) return;
    if (state.uri && !(await health(state.uri, 3000))) return; // 已经挂了，交给正常流程
    await stopWorkspace('idle');
  }

  const ctxLabel = () => als.getStore()?.label || '';

  // -------------------------------------------------------------------------
  // 巡检：仓库 → 工作区 → 地址 → 验活
  // -------------------------------------------------------------------------

  // 仓库留空时，用 token 拉「我的所有工作区」，找出哪个仓库跑着 cnb2api：
  // 优先看 running 的，再看日志里有没有 PROXY_URI=。不靠仓库名判断——
  // 别人的仓库不一定叫 cnb2api。
  async function discoverRepo() {
    let list;
    try {
      list = await listWorkspaces(''); // 列「我的全部工作区」
    } catch (e) {
      if (e?.permission || /HTTP 401/.test(e?.message || '')) throw e;
      return null;
    }
    if (!list.length) return null;

    const byRepo = new Map();
    for (const w of list) {
      const slug = slugOf(w);
      if (!slug) continue;
      const running = w.status === 'running';
      const cur = byRepo.get(slug);
      if (!cur || (running && !cur.running)) byRepo.set(slug, { slug, sn: w.sn, running });
    }
    // 账号绑定了组织时，只在「这个组织」的工作区里找：否则会拿到别的组织
    // 里某个也跑着 cnb2api 的仓库，地址和额度都会对错人。
    const inOrg = (slug) => !cfg.org || orgOf(slug) === cfg.org;
    // 名字只是排序偏好，**不是**判定依据：仓库叫什么都可以，
    // 唯一可靠的证据是启动日志里的 PROXY_URI=。
    const candidates = [...byRepo.values()].filter((c) => inOrg(c.slug)).sort(
      (a, b) => Number(b.running) - Number(a.running)
        || Number(/-?cnb2api\b/i.test(b.slug)) - Number(/-?cnb2api\b/i.test(a.slug)),
    );

    for (const c of candidates) {
      try {
        const res = await api(`/${c.slug}/-/build/runner/download/log/${encodeURIComponent(c.sn)}-001`, {
          timeout: 20000,
        });
        if (pickUriFromLog(await res.text(), cfg.port)) return c.slug;
      } catch {
        /* 没权限或日志里没地址，换下一个 */
      }
    }
    return null;
  }

  // 只填了仓库名（如 "my-gateway"）时，用 token 所属身份补出 org/repo。
  async function expandBareRepo() {
    if (!cfg.repo || cfg.repo.includes('/')) return true;
    const name = cfg.repo;
    const owners = [];
    const add = (o) => {
      const s = String(o || '').trim();
      if (s && !owners.includes(s)) owners.push(s);
    };

    try {
      const me = await (await api('/user')).json();
      add(me?.username);
    } catch {
      /* 没有 /user 权限不致命 */
    }
    try {
      const g = await (await api('/user/groups?page=1&page_size=50')).json();
      for (const x of Array.isArray(g) ? g : g?.list || []) add(x?.path || x?.name);
    } catch {
      /* 忽略 */
    }
    if (cfg.org) owners.unshift(cfg.org);
    if (!owners.length) {
      try {
        for (const w of await listWorkspaces('')) add(orgOf(slugOf(w)));
      } catch {
        /* 忽略 */
      }
    }

    let slugs = new Set();
    try {
      slugs = new Set((await listWorkspaces('')).map(slugOf).filter(Boolean));
    } catch {
      /* 忽略 */
    }

    for (const org of owners) {
      const full = `${org}/${name}`;
      if (!slugs.size || slugs.has(full)) {
        cfg.repo = full;
        say(ctxLabel(), `只说仓库名 "${name}"，已补全为 ${full}`);
        return true;
      }
    }
    if (owners.length) {
      cfg.repo = `${owners[0]}/${name}`;
      say(ctxLabel(), `仓库名 "${name}" 未在已知工作区里找到，先按 ${cfg.repo} 试`);
      return true;
    }
    return false;
  }

  function discoverOnce() {
    if (state.discovering) return state.discovering;
    const run = (async () => {
      await expandBareRepo();
      const found = cfg.repo && cfg.repo.includes('/') ? null : await discoverRepo();
      if (found && (!cfg.repo || !cfg.repo.includes('/'))) {
        cfg.repo = found;
        cfg.org = orgOf(found) || cfg.org;
        say(ctxLabel(), `未配置仓库，已自动识别为 ${found}`);
      }
      return cfg.repo && cfg.repo.includes('/') ? cfg.repo : null;
    })().finally(() => {
      // 失败时不要留下已 resolve 的 Promise：否则后面每次调用都拿到那个旧的
      // null，再也不会重试——工作区晚一点起来就永远认不出来。
      if (!state.discovering || !cfg.repo.includes('/')) state.discovering = null;
    });
    state.discovering = run;
    return run;
  }

  /** 解析并验活一次；成功则更新 state.uri。 */
  async function resolveUri(sn) {
    const uri = (await uriFromDetail(sn)) || (await uriFromLog(sn));
    if (!uri) {
      state.lastError = '取不到地址（工作区可能还在启动）';
      return false;
    }

    // 地址变了就立刻采用，哪怕这会儿还没通：新工作区刚起来时代理要几十秒才
    // 监听，如果因为「暂时不健康」就丢掉新地址，就会一直卡在已经失效的旧地址上。
    if (uri !== state.uri) {
      // 日志里也打码：日志常被贴出来求助，完整地址等于公开端点
      say(ctxLabel(), `${state.uri ? '地址已更新' : '已就绪'}：${maskHost(hostOf(uri))}`);
      state.uri = uri;
      state.readySince = Date.now(); // 拿到新地址 = 工作区刚起来，空闲从这一刻起算
      state.paused = false;
    }

    if (!(await health(uri))) {
      state.lastError = `地址尚未就绪：${maskHost(hostOf(uri))}`;
      return false;
    }
    state.lastError = null;
    state.failures = 0;
    state.recovering = false;
    return true;
  }

  async function refresh(reason = 'tick') {
    // 抓一次 ctx 放局部：refresh 内部会 await 若干次带作用域的调用，而
    // 「内层 als.run 返回后外层不再处于作用域里」（见 within 的说明），
    // 所以后面一律读写 ctx.state / ctx.cfg，不再经过 Proxy。
    const c = need();
    const { cfg: c2, state: st } = c;
    st.lastCheck = Date.now();
    if (!c2.token) {
      // 不能设 fatal：config 阶段 token 还读不到（只存在于登录信息里），
      // 那时设 fatal 会让之后凭据补齐了也永远不再尝试。
      st.lastError = '尚未填写 CNB 访问令牌';
      return st;
    }

    if (!c2.repo || !c2.repo.includes('/')) {
      try {
        const found = await discoverOnce();
        if (!found) {
          st.lastError = '没能确定仓库：repo 留空且工作区里认不出 cnb2api，请填成 org/repo';
          return st;
        }
      } catch (e) {
        st.lastError = `自动发现仓库失败：${humanize(e, c2.repo)}`;
        return st;
      }
    }
    if (!c2.org) c2.org = orgOf(c2.repo);

    try {
      const ws = await pickWorkspace();
      if (!ws) {
        st.status = 'none';
        // 先确认仓库到底存不存在：填错名字时不该反复尝试拉起
        if (!(await repoExists(c2.repo))) {
          st.lastError = `仓库 ${c2.repo} 不存在（或你的 token 无权访问）`;
          st.fatal = true;
          return st;
        }
        st.lastError = `仓库 ${c2.repo} 从未启动过工作区`;
        if (c2.autoStart && !st.paused) {
          const r = await startWorkspace();
          if (r.ok) {
            st.status = 'starting';
            st.recovering = true;
            st.lastError = null;
          }
        }
        return st;
      }

      st.sn = ws.sn;
      st.status = ws.status;

      if (ws.status !== 'running') {
        // 已经提交启动、等平台把状态翻成 running：别再报「已停止」，
        // 否则面板看起来像没拉动，还会诱导重复点启动。
        if (st.starting || st.recovering) {
          st.status = 'starting';
          st.lastError = '工作区正在启动（已提交，等待平台就绪）';
          return st;
        }
        st.lastError = st.paused
          ? `工作区已停止（${st.stoppedReason === 'idle' ? '空闲自动停止' : '手动停止'}），有请求时会自动拉起`
          : `工作区已停止（sn=${ws.sn}）`;
        // paused 时不自动拉起——用户刚为了省核时把工作区停了，
        // 巡检再拉开就等于白停一次。等真的有请求进来再说。
        if (c2.autoStart && !st.paused) {
          const r = await startWorkspace();
          // 平台要几十秒才把状态翻成 running。刚提交就记成「启动中」，
          // 否则下一轮巡检仍看到 stopped，会误报「已停止」并重复 POST start。
          if (r.ok) {
            st.status = 'starting';
            st.recovering = true;
            st.lastError = null;
          }
        }
        return st;
      }

      st.recovering = false;
      st.starting = false; // 平台已经翻成 running，提交期结束
      await resolveUri(ws.sn);
      // 放在 resolveUri 之后：checkIdle 要用 readySince 算空闲，
      // 而 readySince 是在 resolveUri 里拿到地址时才写的。
      await checkIdle();
    } catch (e) {
      st.failures += 1;
      st.lastError = humanize(e, c2.repo);
      // 401 = token 本身无效，403 = 权限不够：两者都不会因为等待而好转
      if (e?.permission || /HTTP 401/.test(e.message || '')) st.fatal = true;
      if (st.failures === 1 || st.failures % 10 === 0) warn(c.label, `检查失败：${st.lastError}`);
    }
    return st;
  }

  /**
   * 有界等待：轮询直到拿到可用地址。首请求和「检测到地址失效」之后用它，
   * 因为工作区从 start 到代理监听 9001 通常需要 30–90 秒。
   *
   * 不该等满预算的几种情况：令牌无效/权限不足（确定性失败）、额度用尽
   * （启动被闸门挡住）、以及连续两轮都没有「正在启动」的迹象（没有工作区、
   * 拿不到地址）。只有正在提交/等平台翻状态时才值得继续等。
   */
  async function waitForReady(budgetMs, ctx) {
    const deadline = Date.now() + budgetMs;
    let stuck = 0;
    for (;;) {
      // 每一轮都重新进作用域：跨 await 与定时器时显式重进，避免上下文丢在
      // 某个运行时边界上。
      const step = await within(ctx, async () => {
        await refresh('wait').catch(() => {});
        const st = ctx.state;
        if (st.fatal) return { done: 'fatal' };
        if (st.quotaBlocked) return { done: 'blocked' };
        if (st.uri) return { done: 'ready' };
        // 只有「正在提交 / 已提交、等平台翻状态」是自己会好转的状态，值得等。
        // 「工作区 running 但拿不到地址」不算：日志里没有 PROXY_URI 时，
        // status 一直是 running，等满 90 秒也变不出地址，只会把请求吊死。
        return {
          done: 'wait',
          progressing: !!st.starting || !!st.recovering,
          why: st.lastError || '',
        };
      });
      if (step.done !== 'wait') return step.done === 'ready';
      if (step.progressing) {
        stuck = 0;
      } else if (++stuck >= 2) {
        // 连着两轮都没有「正在好转」的迹象：别把用户吊在预算上
        warn(ctx.label, `放弃等待：${step.why || '工作区没有在启动'}`);
        return false;
      }
      const left = deadline - Date.now();
      if (left <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(stuck ? 2000 : 6000, left)));
    }
    // 收尾也包一层：循环结束后当前作用域未必还在（见 within 的说明）
    return within(ctx, () => {
      if (!ctx.state.uri) {
        warn(ctx.label, `等待 ${Math.round(budgetMs / 1000)}s 仍无可用地址：${ctx.state.lastError || 'unknown'}`);
      }
      return !!ctx.state.uri;
    });
  }

  // 定时器回调在「账号作用域外」跑，所以 tick 必须自己带上 ctx。
  async function tick(ctx) {
    if (ctx.state.ticking) return;
    ctx.state.ticking = true;
    try {
      await within(ctx, () => refresh('interval'));
    } catch {
      /* 原因已经记在 state.lastError 里 */
    } finally {
      ctx.state.ticking = false;
    }
  }

  // 定时器按账号各起一个：巡检周期、工作区、地址都独立。
  function ensureTimer(ctx) {
    const st = ctx.state;
    if (!st.timer) {
      st.timer = setInterval(() => {
        tick(ctx).catch(() => {});
      }, ctx.cfg.checkSeconds * 1000);
      st.timer?.unref?.();
    }
    // 第一次调用时立刻跑一轮，不等到下一个周期（登录后不发消息也能拿到状态）
    if (!st.readyPromise) st.readyPromise = tick(ctx);
    return st.readyPromise;
  }

  // -------------------------------------------------------------------------
  // 凭据：登录信息 → 这个账号的配置
  // -------------------------------------------------------------------------

  /**
   * 把 magpie 保存的登录信息读进 cfg。
   *
   * 凭据变化时必须作废这个账号的状态，否则换了新 token 插件仍用旧的地址。
   * 首次填充（cfg 里还是空的）不算变更——否则第一次 usage 就把刚拿到的
   * state.uri 清成 null，后面的空闲检测永远看不到 uri。
   */
  function applyAuth(ctx, auth) {
    const meta = auth?.metadata || {};
    // 这里必须显式进入这个账号的作用域：cfg / state 是「当前账号」的视图，
    // 而 applyAuth 可能被 loader、usage、工具从任何地方调到。
    return within(ctx, () => {
      const nextToken = String(meta.token || cfg.token || '').trim();
      const rawKey = String(meta.proxyKey || auth?.key || '').trim();
      const nextKey = rawKey && rawKey !== 'unset' ? rawKey : cfg.proxyKey;

      const tokenChanged = !!cfg.token && !!nextToken && nextToken !== cfg.token;
      const keyChanged = !!cfg.proxyKey && !!nextKey && nextKey !== cfg.proxyKey;

      // 身份里补上用户名：accountId 已经带着「用户名 | org/repo」，
      // 单独填选项、没走登录表单的账号则靠 meta 或选项补。
      if (meta.username) ctx.identity.username = String(meta.username);

      if (!cfg.token) cfg.token = nextToken;
      if (!cfg.proxyKey) cfg.proxyKey = nextKey;

      // 组织/仓库：登录时选过的（accountId 里带着）就是明确意图，不要再猜。
      const org = cfg.org || String(meta.org || '').split(',')[0].trim() || orgOf(cfg.repo);
      const repo = cfg.repo || normalizeRepo(meta.repo || '');
      if (org) cfg.org = org;
      if (repo && repo.includes('/')) {
        cfg.repo = repo;
        if (!cfg.org) cfg.org = orgOf(repo);
      }

      // 标签始终是 accountId：日志前缀、工具分块、额度告警都用它，
      // 与 magpie 里的账号名一字不差。
      const id = accountIdOf({ username: ctx.identity.username, org: cfg.org, repo: cfg.repo });
      if (id) ctx.label = id;

      if (tokenChanged || keyChanged) {
        say(ctx.label, tokenChanged ? '令牌已更新，重置该账号状态并重新识别工作区' : 'PROXY_KEY 已更新');
        cfg.token = nextToken || cfg.token;
        cfg.proxyKey = nextKey || cfg.proxyKey;
        chargeCache.clear();
        state.uri = null;
        state.sn = null;
        state.status = null;
        state.lastError = null;
        state.fatal = false; // 之前永不重置，改好配置也得重启
        state.failures = 0;
        state.lastCheck = 0;
        state.reported = false;
        state.discovering = null;
        state.quotaBlocked = false;
        if (state.timer) state.readyPromise = tick(ctx);
      }
      return ctx;
    });
  }

  // -------------------------------------------------------------------------
  // 一次性的权限自检：把 scope 要求写进日志，免得用户对着 403 猜
  // -------------------------------------------------------------------------

  async function reportPermissions(ctx) {
    if (state.reported) return;
    state.reported = true;
    if (!cfg.token) {
      state.lastError = '尚未填写 CNB 访问令牌';
      warn(
        ctx.label,
        `尚未填写 token。执行 magpie plugin options ${PLUGIN_ID} '{"token":"你的 CNB 访问令牌"}'，`
          + '或在 magpie → 插件 → CNB2API → 选项里填。'
          + `所需权限：${scopeHint()}`,
      );
      return;
    }

    const lacking = [];
    let verifyFailed = '';
    try {
      await api('/workspace/list?page=1&page_size=1');
    } catch (e) {
      if (e?.permission) lacking.push(...e.scopes);
      else if (/HTTP 401/.test(e?.message || '')) {
        state.fatal = true;
        state.lastError = '令牌无效或已过期（401）——请到 CNB 重新生成访问令牌';
        warn(ctx.label, state.lastError);
        return;
      } else {
        verifyFailed = humanize(e, ctx.cfg.repo); // 网络错误等：不能断言「权限通过」
      }
    }
    if (cfg.org) {
      try {
        await api(`/${cfg.org}/-/charge/quota`);
      } catch (e) {
        if (e?.permission) lacking.push(...e.scopes);
      }
    }
    if (state.sn && cfg.repo) {
      try {
        await api(`/${cfg.repo}/-/build/runner/download/log/${encodeURIComponent(state.sn)}-001`);
      } catch (e) {
        if (e?.permission) lacking.push(...e.scopes);
      }
    }

    const req = PERMISSIONS.filter((p) => p.need === 'required').map((p) => p.scope);
    const missingReq = req.filter((s) => lacking.includes(s));
    if (missingReq.length) {
      state.permissionWarning = `缺少必需权限 ${missingReq.join('、')}：插件取不到地址`;
      warn(ctx.label, `${state.permissionWarning}。CNB → 头像 → 访问令牌 → 编辑，勾上后重启工作区。`);
    } else if (lacking.length) {
      const lines = lacking.map((s) => {
        const p = PERMISSIONS.find((x) => x.scope === s);
        return p ? `${s}=${p.label}（${p.missing}）` : s;
      });
      state.permissionWarning = `缺少可选权限：${lines.join('；')}`;
      warn(ctx.label, `${state.permissionWarning}。对应功能会降级，核心功能不受影响。`);
    } else if (verifyFailed) {
      state.permissionWarning = `权限自检未完成：${verifyFailed}`;
      warn(ctx.label, `权限自检未完成（${verifyFailed}）。稍后巡检会自动重试；若持续失败请检查网络。`);
    } else {
      state.permissionWarning = null;
      say(ctx.label, `权限自检通过：${req.join('、')} 齐全`);
    }
  }

  // -------------------------------------------------------------------------
  // 登录：organization → repo 的联动下拉，全部用真实数据
  // -------------------------------------------------------------------------

  const repoCache = new Map(); // fingerprint(token) → { at, repos }
  const orgCache = new Map(); // fingerprint(token) → { at, orgs }

  async function listReposForLogin(token) {
    const key = fingerprint(token);
    const hit = repoCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.repos;
    const res = await fetch(`${cnbApi()}/user/repos?page=1&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const items = Array.isArray(j) ? j : j?.list || [];
    const repos = items
      .map((r) => normalizeRepo(r.path || (r.owner && r.name ? `${r.owner}/${r.name}` : r.name)))
      .filter(Boolean);
    repoCache.set(key, { at: Date.now(), repos });
    return repos;
  }

  /**
   * 组织列表：合并「仓库路径前缀」与「/user/groups」两处来源，单看任一处都会漏。
   * 另外读 /user 只为拿到用户名，把它从组织里剔除（用户名是人，不是组织）。
   */
  async function listOrgsForLogin(token) {
    const key = fingerprint(token);
    const hit = orgCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.orgs;

    const head = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // 先确定这是谁的令牌：用户名是「人」，不是「组织」，不该出现在组织列表里。
    let username = '';
    try {
      const me = await fetch(`${cnbApi()}/user`, { headers: head, signal: AbortSignal.timeout(12000) });
      if (me.ok) {
        const u = await me.json();
        username = String(u?.username || '').trim();
      }
    } catch {
      /* 忽略：拿不到用户名就照常列组织 */
    }

    const orgs = new Set();
    const repos = await listReposForLogin(token).catch(() => null);
    for (const p of repos || []) {
      const o = orgOf(p);
      if (o) orgs.add(o);
    }
    try {
      const g = await fetch(`${cnbApi()}/user/groups?page=1&page_size=50`, {
        headers: head,
        signal: AbortSignal.timeout(12000),
      });
      if (g.ok) {
        const j = await g.json();
        for (const x of Array.isArray(j) ? j : j?.list || []) {
          const p = x?.path || x?.name;
          if (p) orgs.add(p);
        }
      }
    } catch {
      /* 忽略 */
    }

    // 排除本人命名空间：组织列表只放组织。
    if (username) orgs.delete(username);
    const list = [...orgs];
    orgCache.set(key, { at: Date.now(), orgs: list });
    return list;
  }

  /**
   * 某组织下所有有工作区的仓库，标注是否识别到 cnb2api 网关地址。
   * 识别依据只有启动日志里的 PROXY_URI=（仓库名不算数）；识别不到的也返回，
   * 供用户手动选择。
   *
   * workspace/list 的 slug 只认完整的 org/repo，传单个组织名会返回 0 条，
   * 所以这里拉全量再本地过滤。
   */
  async function listCnbReposForLogin(token, org) {
    const res = await fetch(`${cnbApi()}/workspace/list?page=1&page_size=100`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    }).catch(() => null);

    let list = [];
    if (res?.ok) {
      const j = await res.json().catch(() => null);
      list = (j?.list || j?.data || []).filter((w) => orgOf(slugOf(w)) === org);
    }

    const byRepo = new Map();
    for (const w of list) {
      const slug = slugOf(w);
      if (!slug) continue;
      const running = w.status === 'running';
      const cur = byRepo.get(slug);
      if (!cur || (running && !cur.running)) byRepo.set(slug, { slug, sn: w.sn, running });
    }

    const out = [];
    for (const w of byRepo.values()) {
      // 名字带 cnb2api 只是提示，仍要读日志确认——选错仓库的代价是一次次
      // 拿不到地址，宁可多读一份日志。
      let verified = false;
      try {
        const r = await fetch(
          `${cnbApi()}/${w.slug}/-/build/runner/download/log/${encodeURIComponent(w.sn)}-001`,
          { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
        );
        verified = r.ok && !!pickUriFromLog(await r.text(), config.port);
      } catch {
        /* 读不到日志就跳过 */
      }
      out.push({ repo: w.slug, running: w.running, verified });
    }
    // 识别到的排前面；同组内 running 优先
    return out.sort(
      (a, b) => Number(b.verified) - Number(a.verified) || Number(b.running) - Number(a.running),
    );
  }

  // token → CNB 身份。凭据的身份必须唯一，否则 magpie 会把两个登录当成同一个。
  async function identityOf(token) {
    const key = fingerprint(token);
    if (seen.has(key)) return seen.get(key);
    const head = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    const res = await fetch(`${cnbApi()}/user`, { headers: head, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const scopes = missingScopes(body);
      throw new Error(
        res.status === 401
          ? 'CNB 访问令牌无效或已过期（401）——请到 CNB → 头像 → 访问令牌 重新生成'
          : `无法从令牌读出 CNB 身份（/user HTTP ${res.status}${scopes.length ? `，缺 ${scopes.join('、')}` : ''}）`,
      );
    }
    const me = await res.json();
    if (!me?.username) throw new Error('CNB 的 /user 没有返回 username，无法确定这是谁的账号');
    const id = { uid: me.id != null ? String(me.id) : '', username: String(me.username) };
    seen.set(key, id);
    return id;
  }

  // 登录表单里的额度提示：额度按组织算，与具体仓库无关。
  // 走独立的 fetch（此时还没有账号 ctx），查不到就返回空串，不打扰选仓库。
  const loginQuotaCache = new Map(); // fingerprint(token)|org → { at, text }
  async function loginQuotaHint(token, org) {
    if (!org) return '';
    const key = `${fingerprint(token)}|${org}`;
    const hit = loginQuotaCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.text;

    const get = (what) => fetch(`${cnbApi()}/${org}/-/charge/${what}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

    let text = '';
    try {
      const [quota, volume, special] = await Promise.all([get('quota'), get('volume'), get('special-amount')]);
      const c = settleCharge(quota, volume, special)?.credit;
      if (c && c.total != null) {
        const used = round1((c.used ?? 0) + c.frozen);
        text = `AI credits 已用 ${num1(used)}/${num1(c.total)} cr`;
      }
    } catch {
      /* 没权限或超时：不显示，不拦流程 */
    }
    loginQuotaCache.set(key, { at: Date.now(), text });
    return text;
  }

  const RESELECT_ORG = '__reselect_org__';

  // 「重新选组织」不能依赖内存状态，也不能删掉宿主 inputs 里已答的 repo
  // （宿主的 inputs 只增不减，repo 会一直停在重选哨兵）。否则每轮都判定
  // 「又要重选」，形成循环；重绘、并发重入也会把内存状态搞乱。
  //
  // 改用「轮次」编码在 inputs 里，完全不靠内存：
  //   组织题每问一次就用一个新的 key：org、org2、org3……
  //   repo 的「重新选组织」值带上当时是第几轮：`__reselect_org__#<轮次>`。
  // 于是「是否需要再问组织」= 当前组织轮次 <= 哨兵里的轮次。
  // 组织答完后轮次必然 +1，条件自然为假，走向仓库题；再选一次重选又会带
  // 新的轮次，因此可以反复重选，且界面重绘不会改变轮次，天然幂等。
  const orgKeyFor = (round) => (round <= 0 ? 'org' : `org${round + 1}`);
  const orgRoundOf = (k) => (k === 'org' ? 0 : Number(k.slice(3)) - 1);
  function readOrg(inputs) {
    let best = { round: -1, value: '' };
    for (const k of Object.keys(inputs)) {
      if (k !== 'org' && !/^org\d+$/.test(k)) continue;
      const r = orgRoundOf(k);
      if (r >= best.round) best = { round: r, value: String(inputs[k] ?? '').trim() };
    }
    return best;
  }
  function reselectRound(inputs) {
    const v = String(inputs.repo ?? '');
    if (v === RESELECT_ORG) return readOrg(inputs).round; // 兼容无轮次后缀
    const m = /^__reselect_org__#(\d+)$/.exec(v);
    return m ? Number(m[1]) : -1;
  }

  /** 登陆时按已答内容给出下一个问题；全部答完返回 null。 */
  async function askNext(inputs = {}) {
    const token = String(inputs.token || '').trim();
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
        message: '这看起来是 PROXY_KEY（sk- 开头），不是 CNB 访问令牌。请重新输入访问令牌：',
        placeholder: 'CNB → 头像 → 访问令牌',
      };
    }

    const orgs = await listOrgsForLogin(token).catch(() => null);

    const org = readOrg(inputs);
    const selRound = reselectRound(inputs);
    // 还没选过组织，或刚点了「重新选组织」且组织轮次还没前进 → 问组织。
    const needOrg = org.round < 0 || (selRound >= 0 && org.round <= selRound);

    // 组织单选：magpie 一次登录只产生一个账号。同一 CNB 用户在几个组织里，
    // 就登录几次，每次选一个组织——每个组织有自己的额度，必须分开成账号。
    if (needOrg) {
      const nextOrgKey = orgKeyFor(org.round + 1);
      if (!orgs || !orgs.length) {
        return {
          type: 'text',
          key: nextOrgKey,
          message: '组织（请填你的 CNB 组织名；个人命名空间不作为组织列出）',
          placeholder: '例如 alice',
        };
      }
      // 额度按组织算：只放在选项名称里（label），鼠标悬停不再重复一遍。
      const shown = orgs.slice(0, 40);
      const hints = await Promise.all(shown.map((o) => loginQuotaHint(token, o)));
      const orgOption = (o, hint) => ({
        label: hint ? `${o}  ·  ${hint}` : o,
        value: o,
      });
      if (orgs.length === 1) {
        return {
          type: 'select',
          key: nextOrgKey,
          message: `组织（只查到 ${orgs[0]}，选中继续；额度见选项名）`,
          options: [orgOption(shown[0], hints[0])],
        };
      }
      return {
        type: 'select',
        key: nextOrgKey,
        message: `选择组织（共 ${orgs.length} 个；一个组织登录一次，额度分开）`,
        options: shown.map((o, i) => orgOption(o, hints[i])),
      };
    }

    const first = org.value;
    // 仓库：只列该组织下跑着 cnb2api 的。
    //
    // 判断是否问过，只能看 inputs 里有没有 repo 这个 key。宿主每轮只把
    // 「题目 key → 用户答案」回传给我们，自定义标记（例如 isRepoQuestion）
    // 不会被带回来，拿它当标记就会导致这一题永远问下去。
    // 用户留空表示交给插件自动识别，此时答案是空串 ''，依然是「已答」。
    const repoAnswered = Object.prototype.hasOwnProperty.call(inputs, 'repo')
      && selRound < 0;
    if (!repoAnswered) {
      const found = await listCnbReposForLogin(token, first).catch(() => null);
      if (!found) {
        return {
          type: 'text',
          key: 'repo',
          message: '仓库名（自动查询失败，可留空让插件稍后自己识别）',
          placeholder: '例如 my-gateway（留空即可）',
        };
      }
      // 仓库列表只看运行状态与是否识别到网关；额度按组织算，已在上一题显示，
      // 这里不再重复（否则每个仓库都挂一样的额度，反而干扰选择）。
      const back = {
        label: '↩ 重新选组织',
        value: `${RESELECT_ORG}#${org.round}`, // 带上当前组织轮次，重选后轮次会 +1
        hint: '选错了从这里返回',
      };
      const skip = {
        label: '（留空，稍后自动识别）',
        value: '',
        hint: found.some((r) => r.verified) ? '推荐' : '没识别到时先这样，再手工填 repo',
      };
      const verified = found.filter((r) => r.verified);
      const unverified = found.filter((r) => !r.verified);
      const hintFor = (r, ok) => [
        r.running ? '运行中' : '已停止',
        ok ? '✓ 识别到网关' : '⚠ 没识别到，可手动选',
      ].filter(Boolean).join(' · ');

      // 自动识别不到时把仓库全列出来让用户选，而不是只给一个空选项。
      // 用户可能比插件更清楚哪个仓库在跑，不能因为日志权限不足就锁死。
      const options = [
        ...verified.map((r) => ({ label: r.repo, value: r.repo, hint: hintFor(r, true) })),
        ...unverified.slice(0, 30).map((r) => ({ label: r.repo, value: r.repo, hint: hintFor(r, false) })),
        skip,
        back,
      ];
      const title = verified.length
        ? `选择仓库（${first} 下识别到 ${verified.length} 个能跑 cnb2api；`
          + `另有 ${unverified.length} 个未能确认，也可手动选）`
        : `组织 ${first} 下没自动识别到网关仓库（日志里没有 PROXY_URI）；`
          + `下面是该组织有工作区的仓库，可手动选，也可留空后手工填 repo`;
      // 只有一个选项也照样问：宿主只把用户选中的值放进 inputs.repo，
      // authorize 才拿得到仓库名。
      return { type: 'select', key: 'repo', message: title, options };
    }

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

  // -------------------------------------------------------------------------
  // 工具：四个账号并行跑，结果按账号分块
  // -------------------------------------------------------------------------

  async function forEachAccount(label, fn) {
    const all = [...ctxs.values()];
    if (!all.length) return '还没有登录任何 CNB 账号。执行 magpie plugin login cnb2api 添加。';
    const multi = all.length > 1;
    const blocks = await Promise.all(
      all.map(async (ctx) => {
        const lines = await within(ctx, async () => {
          // 巡检定时器可能还没启动过，保证至少识别一次
          if (!ctx.state.uri && !ctx.state.fatal) await refresh('tool').catch(() => {});
          return fn(ctx);
        }).catch((e) => [`执行失败：${e.message}`]);
        const head = multi ? `【${ctx.label}】` : '';
        const body = (Array.isArray(lines) ? lines : [String(lines)]).filter(Boolean);
        return head ? [head, ...body.map((l) => `  ${l}`)].join('\n') : body.join('\n');
      }),
    );
    return blocks.join(multi ? '\n\n' : '\n');
  }

  // -------------------------------------------------------------------------
  // 导出给 magpie
  // -------------------------------------------------------------------------

  return {
    config: async (c) => {
      // 插件加载时还没有「当前账号」，这里不启动轮询：等 loader/usage 首次被
      // 调用、拿到登录信息后自然启动。
      c.provider ??= {};
      c.provider[PROVIDER_ID] ??= {
        name: 'CNB2API',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://placeholder-9001.cnb.run/v1',
        models: modelTable(modelIds(config.models)),
      };
    },

    auth: {
      provider: PROVIDER_ID,
      icon: 'https://cnb.cool/favicon.ico',

      // 两类完全不同的凭据，分两个输入框，很容易填反：
      //   CNB 访问令牌 → 调 CNB OpenAPI（列工作区、读日志、拉起工作区）
      //   PROXY_KEY    → 调你自己工作区里的 cnb2api 网关
      // 用 ask() 按已答内容动态生成下拉，用户不用背 org/repo 的写法。
      methods: [
        {
          type: 'api',
          label: 'CNB2API 凭据',
          prompts: [
            { type: 'password', key: 'token', message: 'CNB 访问令牌（CNB → 头像 → 访问令牌）' },
            { type: 'password', key: 'proxyKey', message: 'PROXY_KEY（.cnb.yml 里设的那个）' },
          ],
          ask: (inputs) => askNext(inputs),

          async authorize(inputs) {
            const token = String(inputs?.token || '').trim();
            const proxyKey = String(inputs?.proxyKey || '').trim();
            if (!token) return { type: 'failed', error: '请填写 CNB 访问令牌' };
            if (!proxyKey) return { type: 'failed', error: '请填写 PROXY_KEY' };
            if (token === proxyKey) {
              return {
                type: 'failed',
                error: '两栏填的是同一个值。CNB 访问令牌和 PROXY_KEY 是两个不同的东西：'
                  + '前者在 CNB 头像 → 访问令牌里生成，后者是你 .cnb.yml 里的 PROXY_KEY。',
              };
            }

            let me;
            try {
              me = await identityOf(token);
            } catch (e) {
              return { type: 'failed', error: e.message };
            }

            // 「重新选组织」是下拉里的导航选项，不该当成仓库名落到账号上
            if (reselectRound(inputs) >= 0) {
              return { type: 'failed', error: '请重新执行登录，从组织那一步再选一次' };
            }
            const repo = normalizeRepo(inputs?.repo) || '';
            // 一次登录只建一个账号。magpie 的 save() 只保留一个 accountId，
            // 多组织请登录多次：每次选一个组织，额度才分得开。
            // 组织可能被重选过，取轮次最高的那个（org / org2 / org3…）。
            const org = readOrg(inputs).value || orgOf(repo);
            const orgClean = String(org || '').trim();
            if (!orgClean) return { type: 'failed', error: '请选择组织（每个组织登录一次）' };

            const repoForOrg = repo && orgOf(repo) === orgClean ? repo : '';
            const target = accountsFor(me.username, [orgClean], { [orgClean]: repoForOrg })[0];
            if (!target) return { type: 'failed', error: '没能建立账号标识' };
            const accountId = target.label;

            // magpie 的 save() 对 api 类型只存 {type,key,metadata}，顶层 accountId
            // 会被丢掉；settle() 于是退化成按 key（也就是 PROXY_KEY）判重，
            // 同一个 CNB 用户在多个组织下常共用同一个 PROXY_KEY，就会被合并替换。
            //
            // 带 refresh 字段走 OAuth 保存分支，那一条路会保留顶层 accountId / uid。
            // refresh 是空串：账号不会被 renew（renewAt 只认函数），也不会过期。
            say(accountId, `登录成功：账号 ${accountId}（uid ${me.uid || 'unknown'}）`);
            return {
              type: 'success',
              // 兼容走 OpenCode 原生 api 登录的宿主
              key: proxyKey,
              // magpie 的 OAuth 分支保留这两个顶层字段
              refresh: '',
              access: proxyKey,
              accountId,
              uid: me.uid || undefined,
              name: accountId,
              metadata: {
                token,
                proxyKey,
                uid: me.uid || undefined,
                username: me.username,
                org: orgClean,
                repo: repoForOrg || undefined,
              },
            };
          },
        },
      ],

      async loader(getAuth) {
        const auth = await getAuth?.();
        const ctx = ctxFor(accountKeyOf(auth));
        applyAuth(ctx, auth);

        return within(ctx, async () => {
          const st = ctx.state;
          const c2 = ctx.cfg;
          ensureTimer(ctx);
          reportPermissions(ctx).catch(() => {});

          if (!c2.token) {
            st.fatal = true;
            st.lastError = '尚未填写 CNB 访问令牌';
          } else if (!st.uri) {
            // 首请求：还没有地址，等一个有界预算（工作区冷启 ~30–90s）
            await waitForReady(READY_BUDGET_MS, ctx);
          }

          /**
           * loader 给出的 apiKey / headers 由宿主负责加到请求上，但调用方
           * 自己拼 headers 时可能漏掉。上游只认 PROXY_KEY，所以这里兜底补一次：
           * 缺 Authorization 就补上，避免请求到了 cnb2api 才被 401 拒掉。
           */
          const withUpstreamKey = (init) => {
            const key = c2.proxyKey;
            if (!key) return init;
            const headers = new Headers(init?.headers || {});
            if (!headers.has('authorization')) headers.set('Authorization', `Bearer ${key}`);
            return { ...(init || {}), headers };
          };

          const doFetch = async (input, rawInit) => {
            const init = withUpstreamKey(rawInit);
            st.lastUsedAt = Date.now();
            // 用户为了省核时把工作区停了，现在又来请求了 —— 该拉起来了
            if (st.paused) {
              st.paused = false;
              st.stoppedReason = null;
              say(ctx.label, '收到请求，重新拉起工作区');
            }

            if (!st.uri) {
              await refresh('no-uri');
              if (!st.uri && !st.fatal) await waitForReady(READY_BUDGET_MS, ctx);
              if (!st.uri) {
                const why = st.lastError || 'cnb2api 不可用';
                let hint;
                if (!c2.token) {
                  hint = `还没填 token。执行 magpie plugin options ${PLUGIN_ID} '{"token":"你的 CNB 访问令牌"}'`;
                } else if (st.quotaBlocked) {
                  hint = '组织 AI credits 已用尽，补足后会自动恢复';
                } else if (/仓库 .* 不存在/.test(why)) {
                  hint = '检查插件选项里的 repo，可填 org/repo、仓库名、或仓库页面地址';
                } else if (/令牌无效|401/.test(why)) {
                  hint = 'CNB → 头像 → 访问令牌，重新生成一个（勾上必需权限）后填回插件选项';
                } else {
                  hint = `检查必需权限 ${scopeHint()}`;
                }
                return oaiError(503, why, hint);
              }
            }

            // input 是完整 URL（magpie 已用 baseURL + 路径拼好）。不管 magpie
            // 存下的是哪个 baseURL，都改写成当前真实地址。
            const urlOf = (x) => String(x instanceof Request ? x.url : x);
            const target = () => (st.uri ? urlOf(input).replace(/^https?:\/\/[^/?#]+/, st.uri) : null);
            const send = (url) => (url === urlOf(input) ? fetch(input, init) : fetch(url, init));

            const first = target();
            try {
              const res = await send(first);
              if (res.status === 401) {
                return annotate(
                  res,
                  'cnb2api 拒绝了密钥：检查插件选项里的 proxyKey 是否等于 .cnb.yml 的 PROXY_KEY',
                );
              }
              // 402 = 组织额度用尽：不改写内容，只补一句承诺
              if (res.status === 402) {
                return annotate(res, '额度用尽期间不会自动拉起工作区 · 补足后会自动再试');
              }
              return res;
            } catch (e) {
              warn(ctx.label, `请求失败，先刷新地址：${e.message}`);
              // 并发请求共用一次恢复动作：否则 5 个请求会各自 refresh 并各自
              // 等 120 秒，把 CNB 接口打成筛子。
              if (!st.recoveringPromise) {
                st.recoveringPromise = refresh('request-failed')
                  .catch(() => {})
                  .then(() => {
                    if (!st.uri || st.recovering) return waitForReady(RECOVER_BUDGET_MS, ctx);
                    return true;
                  })
                  .finally(() => {
                    st.recoveringPromise = null;
                  });
              }
              await st.recoveringPromise;
              const again = target();
              if (!again) return oaiError(503, `cnb2api 请求失败：${e.message}`, st.lastError || '');
              if (again !== first) say(ctx.label, `改用新地址重试：${maskHost(hostOf(st.uri))}`);
              return await send(again);
            }
          };

          const proxyKey = c2.proxyKey || '';

          return {
            // baseURL 每次都现读：地址一变，下一次请求就自动走新地址。
            get baseURL() {
              const uri = ctx.state.uri;
              return uri ? `${uri}/v1` : 'https://placeholder-9001.cnb.run/v1';
            },
            apiKey: proxyKey,
            headers: proxyKey ? { Authorization: `Bearer ${proxyKey}` } : {},
            // 闭包捕获这个账号：magpie 可能并发调两个账号的 fetch，
            // 不能依赖「当前」是谁。
            fetch: (input, init) => within(ctx, () => doFetch(input, init)),
          };
        });
      },

      // 用量钩子：工作区状态 + 该组织的 CNB 真实额度。
      // 文档要求「没给 used 就不要传，不要用 0 表示不知道」，所以拿不到数字
      // 就只报 error 或纯文字窗口。
      async usage(getAuth) {
        const auth = await getAuth?.();
        const ctx = ctxFor(accountKeyOf(auth));
        applyAuth(ctx, auth);

        return within(ctx, async () => {
          const st = ctx.state;
          const c2 = ctx.cfg;
          ensureTimer(ctx);
          // usage 是登录/打开界面时最早被调的钩子，顺势推进一次；但**不**走会
          // 触发 start 的路径——面板不该为了一行额度等一场冷启动。
          if (!st.uri && st.status !== 'running' && Date.now() - st.lastCheck > 15_000) {
            refresh('usage').catch(() => {});
          }

          const accountName = String(ctx.identity.username || '').trim();
          const out = { plan: st.status === 'running' ? 'running' : st.status || 'unknown' };
          // magpie 用 user 当账号在界面上的名字；返回它，别让宿主退回 key 尾缀。
          // 同一个人在不同组织下是两个账号，所以名字带上组织。
          if (accountName) {
            out.user = ctx.label && ctx.label !== accountName ? ctx.label : accountName;
          }

          // 这一行回答「这个账号现在能不能用」。地址是 API 端点，默认打码，
          // 因为额度面板常被截图分享。
          const host = st.uri ? hostOf(st.uri) : '';
          const alive = st.uri ? await health(st.uri, HEALTH_MS) : false;
          const showFull = process.env.CNB2API_SHOW_FULL_HOST === '1';
          out.windows = [
            {
              name: 'workspace',
              aside: true,
              display: alive
                ? `ok · ${showFull ? host : maskHost(host)}`
                : `不可用 · ${st.lastError || '未就绪'}`,
            },
          ];

          if (c2.autoStart && st.status !== 'running' && st.autoStartBlocked) {
            out.windows.push({ name: 'auto-restart', aside: true, display: '已禁用 · 缺 repo-cnb-trigger:rw' });
          }

          const org = c2.org || orgOf(c2.repo);
          if (!org || !c2.token) return out;

          const q = await charge(org, { timeoutMs: 4000 }).catch((e) => ({ error: e.message }));
          if (q.error || !q.charge) {
            out.error = `查不到额度 · ${q.error || '仓库未确定'}`;
            return out;
          }
          const c = q.charge.credit;
          let creditsWindow = null;
          if (c && c.used != null) {
            creditsWindow = {
              name: `AI credits · ${org} ${num1((c.used ?? 0) + c.frozen)}/${num1(c.total)} cr`,
              // used 是**百分比 0–100**，不是已用量：它是进度条的开关
              used: Math.min(100, Math.max(0, round1((c.used ?? 0) + c.frozen) / (c.total || 1) * 100)),
              amount: round1((c.used ?? 0) + c.frozen),
              limit: round1(c.total),
              unit: 'cr',
              display: [
                bonusPart(c.bonus, c.bonusDesc, c.bonusExpire, c.bonusExpired),
                `预扣 ${num1(c.frozen)}`,
                `可用 ${num1(c.remain)}`,
              ].filter(Boolean).join(' · '),
            };
            out.windows.push(creditsWindow);
          }
          const d = q.charge.devHours;
          if (d && d.used != null) {
            out.windows.push({
              name: `dev core-hours · ${org} ${num1((d.used ?? 0) + d.frozen)}/${num1(d.total)} h`,
              used: Math.min(100, Math.max(0, round1((d.used ?? 0) + d.frozen) / (d.total || 1) * 100)),
              amount: round1((d.used ?? 0) + d.frozen),
              limit: round1(d.total),
              unit: 'h',
              display: [`预扣 ${num1(d.frozen)}`, `可用 ${num1(d.remain)}`].join(' · '),
            });
          }
          // 余额告警只是提示，不是账号故障：写进额度窗口的文字，
          // 不占用 out.error（那会被宿主当成账号出错）。
          const notice = creditNotice(q.charge, c2.creditFloorPercent, ctx.label);
          if (notice) {
            if (creditsWindow) creditsWindow.display = [creditsWindow.display, notice].filter(Boolean).join(' · ');
            else out.windows.push({ name: 'balance', aside: true, display: notice });
          }
          return out;
        });
      },
    },

    tool: {
      cnb2api_workspace_status: {
        description:
          '查看 CNB2API 工作区状态：是否在运行、地址、空闲多久、是否已暂停、是不是被额度拦住。'
          + '决定要不要停止（省核时）之前先调这个。',
        args: {},
        execute: () =>
          forEachAccount('status', async () => {
            const idleMin = state.lastUsedAt ? Math.floor((Date.now() - state.lastUsedAt) / 60_000) : null;
            const lines = [
              `状态：${state.status || 'unknown'}${state.paused ? '（已暂停，不再自动拉起）' : ''}`,
              `组织：${cfg.org || '（未确定）'}`,
              `仓库：${cfg.repo || '（未确定）'}`,
              `地址：${state.uri ? maskHost(hostOf(state.uri)) : '（无）'}`,
            ];
            if (state.sn) lines.push(`工作区编号：${state.sn}`);
            if (idleMin != null) lines.push(`空闲：${idleMin} 分钟`);
            lines.push(
              cfg.idleStopMinutes ? `空闲自动停止：${cfg.idleStopMinutes} 分钟` : '空闲自动停止：未开启（idleStopMinutes=0）',
            );
            if (state.quotaBlocked) lines.push('额度：已触及保底线，不会自动拉起');
            if (state.permissionWarning) lines.push(`权限：${state.permissionWarning}`);
            if (state.lastError) lines.push(`最近错误：${state.lastError}`);
            return lines;
          }),
      },

      cnb2api_workspace_start: {
        description: '拉起 CNB2API 工作区。工作区已停止时调用。注意：运行中的工作区会持续消耗核时。',
        args: {},
        execute: () =>
          forEachAccount('start', async (ctx) => {
            if (state.status === 'running' && state.uri) return [`已经在运行：${maskHost(hostOf(state.uri))}`];
            // 显式调用：额度现查一次（刚充完额度不该被一分钟前的旧结论挡住）
            const gate = await quotaGate({ fresh: true });
            if (!gate.ok) return [`没有拉起：${gate.why}。补足额度后再试，或直接发请求让巡检自动拉起。`];
            const r = await startWorkspace();
            if (!r.ok) return [`没能拉起工作区：${r.pending ? '启动正在提交中' : state.lastError || r.why || '启动请求失败'}`];
            const ok = await waitForReady(READY_BUDGET_MS, ctx);
            return [
              ok
                ? `已拉起并可用：${maskHost(hostOf(state.uri))}`
                : `已提交拉起，但还没就绪（${state.lastError || '等待中'}），稍后再查或直接发请求`,
            ];
          }),
      },

      cnb2api_workspace_stop: {
        description:
          '停止 CNB2API 工作区以节省核时。工作区一旦 running 就按时间计费，即使没有请求也在扣。'
          + '用完就可以停，下次请求会自动拉起。需要令牌含 account-engage:rw 权限。',
        args: {},
        execute: () =>
          forEachAccount('stop', async () => {
            const r = await stopWorkspace('manual');
            return [
              r.ok
                ? `${r.message}。核时已停止累积，下次请求会自动拉起（冷启动约 30–90 秒）。`
                : `没能停止：${r.message}`,
            ];
          }),
      },

      cnb2api_quota: {
        description: '查询该账号所属组织的 AI credits 与核时余量，用来判断还剩多少可用。',
        args: {},
        execute: () =>
          forEachAccount('quota', async () => {
            const org = cfg.org || orgOf(cfg.repo);
            if (!org || !cfg.token) return ['还没配置 token 或组织，无法查询额度'];
            const r = await charge(org, { fresh: true }).catch((e) => ({ error: e.message }));
            if (r.error) return [`查询失败：${r.error}`];
            if (!r.charge) return ['（没拿到额度数据，可能缺 group-resource:r 权限）'];
            const lines = [];
            const c = r.charge.credit;
            if (c) {
              const used = c.used != null
                ? `已用 ${num1(c.used)} + 预扣 ${num1(c.frozen)} / ${num1(c.total)} cr，可用 ${num1(c.remain)} cr`
                : `总额 ${num1(c.total)} cr，可用 ${num1(c.remain)} cr（已用量未取到）`;
              lines.push(`AI Credits：${used}`);
              const bonus = bonusPart(c.bonus, c.bonusDesc, c.bonusExpire, c.bonusExpired);
              if (bonus) lines.push(`加成：${bonus}`);
            }
            const d = r.charge.devHours;
            if (d) {
              lines.push(d.used != null
                ? `核时：已用 ${num1(d.used)} + 预扣 ${num1(d.frozen)} / ${num1(d.total)} h，可用 ${num1(d.remain)} h`
                : `核时：总额 ${num1(d.total)} h，可用 ${num1(d.remain)} h（已用量未取到）`);
            }
            return lines.length ? lines : ['（没拿到额度数据）'];
          }),
      },
    },

    provider: {
      id: PROVIDER_ID,
      // models(provider, {auth}) 返回「以 id 为键」的对象，不是数组。
      async models(provider) {
        const out = {};
        for (const id of modelIds(config.models)) {
          out[id] = { ...(provider?.models?.[id] || {}), id, name: id };
        }
        return out;
      },
    },
  };
};
