// toolkit — magpie-cnb2api 的纯函数层：没有 IO、没有定时器、不认识 magpie。
//
// 这里放四件事，每件都能单独测：
//
//   地址    从 webide 字段、日志里的 PROXY_URI= 抠出 <subdomain>-<port>.cnb.run
//   额度    三个 CNB charge 接口 → 一笔账（含冻结）
//   身份    CNB uid + 用户名 + 组织/仓库 → magpie 的账号标识与显示名
//   配置    用户填的一堆写法 → 一组确定的选项
//
// 上层（index.mjs）只做编排：什么时候刷新、什么时候拉起、什么流量转发给谁。

// ---------------------------------------------------------------------------
// 地址
// ---------------------------------------------------------------------------

// CNB 工作区的子域形如 <随机串>-<端口>.cnb.run。子域允许连字符，所以用
// [a-z0-9][a-z0-9-]* 而不是 \w+；末尾锚定端口与域名，避免把 cnb.cool 的
// 控制台地址误当成上游；开头不锚定，因为日志里的值可能带引号或前缀。
const HOST_RE = /([a-z0-9][a-z0-9-]*)-(?:\{\{\s*port\s*\}\}|[0-9]+)\.cnb\.run(?![\w.-])/i;
const ANY_HOST = new RegExp(HOST_RE.source, 'gi');

// PROXY_URI 的几种写法都见过：`=`、`:`、` = `，值可能带引号。
const LOG_URI = /PROXY_URI\s*[:=]\s*["']?(https?:\/\/\S+)/gi;

// 日志是彩色的（set -x 会带转义序列），地址可能被 ANSI 码夹住。
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// 模板端口 {{port}} 直接当域名会得到非法主机名，必须换成真实端口。
export const materialize = (u, port = 9001) =>
  u == null ? null : String(u).trim().replace(/\{\{\s*port\s*\}\}/gi, String(port));

const plain = (s) => String(s ?? '').replace(ANSI, '');
const strip = (u) => String(u || '').trim().replace(/\/+$/, '');

/** 从任意一段文本里抠出 cnb.run 地址，补成 https://<host>；认不出返回 null。 */
export function pickUri(text, port = 9001) {
  if (!text) return null;
  const m = plain(text).match(HOST_RE);
  return m ? `https://${materialize(m[0], port)}` : null;
}

/**
 * 从流水线日志里取网关地址。与 DSH 插件的识别口径一致：
 *
 *   1. 先剥掉 ANSI 颜色码（日志常带 \x1b[...m）；
 *   2. 认 PROXY_URI= / PROXY_URI: / PROXY_URI = 几种写法与引号，
 *      取**最后**一条（热重启会再打印一次，前面那条已失效）；
 *   3. 只保留正则命中的主机名，丢掉值里可能带的 /v1 路径或尾部杂字符——
 *      整串返回会得到 .../v1/v1/models 这种错误基址；
 *   4. 兜底：仓库 .cnb.yml 被改成直接 echo 地址（没有 PROXY_URI 前缀、
 *      甚至没有协议），就取日志里最后出现的那个 cnb.run 主机。
 */
export function pickUriFromLog(text, port = 9001) {
  if (!text) return null;
  const clean = plain(text);

  const hits = [...clean.matchAll(LOG_URI)];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const raw = hits[i][1]
      .replace(/["'<>)]/g, '')
      .replace(/[.,;]+$/, '')
      .replace(/\/+$/, '');
    const filled = materialize(raw, port);
    const hit = String(filled || '').match(HOST_RE);
    if (hit) return `https://${hit[0]}`;
  }

  // 兜底：直接打印在日志里的裸主机
  const any = [...clean.matchAll(ANY_HOST)];
  if (any.length) return `https://${materialize(any[any.length - 1][0], port)}`;
  return null;
}

/** 把地址的域名取出来，地址非法时原样返回（日志里只写域名更安全）。 */
export function hostOf(u) {
  try {
    return new URL(String(u)).host;
  } catch {
    return String(u || '');
  }
}

/**
 * 域名打码：860lo2zlkf-9001.cnb.run → 860l****-9001.cnb.run
 *
 * 状态面板常被截图分享，完整子域等于公开端点；保留前 4 位是为了自己认得出
 * 是哪一个，保留端口和域名是为了看得出是否正常。
 */
export function maskHost(host) {
  const h = String(host || '');
  if (!h) return '';
  const m = h.match(/^([a-z0-9][a-z0-9-]*)-(\d+\..+)$/i);
  if (m) {
    const [, sub, rest] = m;
    return `${sub.slice(0, 4)}****-${rest}`;
  }
  if (h.length <= 10) return h;
  return `${h.slice(0, 4)}****${h.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// 仓库写法
// ---------------------------------------------------------------------------

/**
 * 把用户能填的各种写法归一成 `org/repo`：
 *
 *   https://cnb.cool/<org>/<repo>            https://cnb.cool/<org>/<repo>/-/tree/main
 *   cnb.cool/<org>/<repo>                    git@cnb.cool:<org>/<repo>.git
 *   <org>/<repo>.git                         /<org>/<repo>
 *   <org>/<repo>                             <repo>（组织留给调用方补）
 */
export function normalizeRepo(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // https://
  s = s.replace(/^git@[^:]+:/i, ''); //            git@host:
  s = s.replace(/^[^/]+\.[a-z]{2,}\//i, ''); //    cnb.cool/
  s = s.replace(/^\/+/, '');
  const m = s.match(/^([^/]+)\/([^/?#]+)/);
  if (!m) {
    const only = s.replace(/\.git$/i, '').replace(/[/?#].*$/, '');
    return /^[\w.-]+$/.test(only) ? only : '';
  }
  const org = m[1].replace(/\.git$/i, '');
  const repo = m[2].replace(/\.git$/i, '');
  return org && repo ? `${org}/${repo}` : '';
}

/** `org/repo` 的组织部分；不完整时给空串。 */
export const orgOf = (repo) => {
  const s = String(repo || '');
  if (!s.includes('/')) return '';
  return s.split('/')[0] || '';
};

// ---------------------------------------------------------------------------
// 身份
//
// 一个 CNB 账号可能同时属于几个组织，而每个组织有自己的 AI credits，所以
// 「账号」的粒度是「谁 + 哪个组织下的哪个仓库」，不是「谁」。
//
// magpie 判断两个登录是不是同一个账号，靠 auth.authorize 结果里的 accountId
// （见宿主 runtime：whoOf(a) = a.accountId ?? a.metadata.email ?? a.email）。
// 这里只用 accountId，且永不用邮箱。
// ---------------------------------------------------------------------------

const SEP = ' | ';

/** 账号标识：`<用户名> | <org/repo>`。缺仓库时退回 `@<组织>`（仍按组织分开）。 */
export function accountIdOf({ username = '', org = '', repo = '' } = {}) {
  const who = String(username || '').trim();
  const slug = String(repo || '').includes('/') ? String(repo).trim() : '';
  const o = slug ? orgOf(slug) : String(org || '').trim();
  if (!who) return o ? `@${o}` : '';
  if (slug) return `${who}${SEP}${slug}`;
  return o ? `${who}${SEP}@${o}` : who;
}

/**
 * 从 accountId 里反解出组织与仓库，给日志前缀和工具输出用。
 * 认不出来时返回空值，调用方自己从选项里补。
 */
export function parseAccountId(id) {
  const s = String(id || '');
  const at = s.indexOf(SEP);
  if (at < 0) return { username: s, org: '', repo: '' };
  const username = s.slice(0, at).trim();
  const rest = s.slice(at + SEP.length).trim();
  if (rest.startsWith('@')) return { username, org: rest.slice(1), repo: '' };
  const org = orgOf(rest);
  return { username, org, repo: org ? rest : '' };
}

/**
 * 一个 CNB 身份在若干组织下各自对应的账号标识：每个组织一条。
 *
 * 组织列表由调用方给出（见 index.mjs 的 listOrgsForLogin）；这里只按组织
 * 拼出 `用户名 | org/repo`（无仓库时 `用户名 | @org`），并去重。
 */
export function accountsFor(username, orgs, repoByOrg = {}) {
  const out = [];
  const seen = new Set();
  for (const org of orgs || []) {
    const o = String(org || '').trim();
    if (!o) continue;
    const repo = repoByOrg[o] || '';
    const id = accountIdOf({ username, org: o, repo });
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ org: o, repo, label: id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 额度
//
//   GET /{org}/-/charge/quota          → { credit_in_milli: {total, free}, dev_in_sec: {total, free} }
//   GET /{org}/-/charge/volume         → { credit_in_milli: <已用>, freeze_credit_in_milli, dev_in_sec, freeze_dev_in_sec }
//   GET /{org}/-/charge/special-amount → { credit, credit_desc, credit_expire, compute_develop_corehour, … }
//
// 三件事必须记住：
//   1. *_in_milli ÷ 1000 = credits；*_in_sec ÷ 3600 = 核时。
//   2. volume 是扁平数字（已用量），quota 才是 {total, free} 对象。
//   3. quota.total **已包含** special-amount 的加成，所以「基础额度」要减掉它，
//      否则同一笔赠送被算两遍。
//
// 冻结不是押金，是预扣：工作区运行期间按周期占用额度，那一刻就已经不可用了。
// 所以进度条用 used + frozen，只用 used 会严重低估消耗；remain 才回答「还能用多少」。
// ---------------------------------------------------------------------------

const num = (v) => {
  if (v == null) return null;
  const n = typeof v === 'object' ? Number(v.total ?? NaN) : Number(v);
  return Number.isFinite(n) ? n : null;
};

const positive = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export const round1 = (n) => Math.round(Number(n) * 10) / 10;

/** 整数不拖 .0，小数留一位：各账号格式统一，面板才对得齐。 */
export const num1 = (n) => {
  const v = round1(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
};

const pct = (part, whole) =>
  whole != null && whole > 0 && part != null ? (part / whole) * 100 : null;

const clamp100 = (v) => (v == null ? null : Math.min(100, Math.max(0, round1(v))));

/**
 * 从 {credit, credit_desc, credit_expire} 这类三元组里取有效项。
 *
 * 接口会返回**已过期**的加成（quota 里可能也已经扣掉了），所以要带出 expired
 * 标记，显示层才能说「已过期」而不是继续吹「+666」。
 *
 * 注意字段名：值叫 compute_develop_corehour，说明和过期时间却叫
 * compute_develop_desc / compute_develop_expire（没有 _corehour）。
 */
export function specialOf(special, key, unitScale, baseKey = null, now = Date.now()) {
  if (!special) return null;
  const amount = positive(special[key]);
  if (amount == null) return null;
  const stem = baseKey || key;
  const desc = String(special[`${stem}_desc`] ?? '').trim();
  const raw = String(special[`${stem}_expire`] ?? '').trim();
  const expire = raw && !/^9999/.test(raw) ? raw : null;
  const at = expire ? Date.parse(expire) : null;
  return {
    amount: amount / unitScale,
    desc: desc || null,
    expire,
    expired: at != null && Number.isFinite(at) && at < now,
  };
}

/** 加成那一段文案。三种情况分开写，否则会误导：没有加成时不出现噪音。 */
export function bonusPart(amount, desc, expire, expired) {
  if (amount == null) return '';
  const label = desc || '加成';
  if (expired) return `${label} +${num1(amount)} 已过期`;
  return expire ? `${label} +${num1(amount)}（${String(expire).slice(0, 10)} 到期）` : `${label} +${num1(amount)}`;
}

/** 一组「总额/已用/冻结/加成」→ 两个口径（milli 算、显示单位算）的一笔账。 */
function book(totalBase, usedBase, frozenBase, bonus, scale) {
  if (totalBase == null) return null;
  const frozen = frozenBase || 0;
  const special = bonus?.amount != null ? bonus.amount * scale : null;
  const base = special != null ? totalBase - special : totalBase;
  const remain = Math.max(0, totalBase - (usedBase || 0) - frozen);
  return {
    totalBase,
    usedBase,
    frozenBase: frozen,
    specialBase: special,
    baseBase: base,
    remainBase: remain,
    usedPct: pct(usedBase, totalBase),
    usedFrozenPct: pct((usedBase || 0) + frozen, totalBase),
    total: totalBase / scale,
    used: usedBase != null ? usedBase / scale : null,
    frozen: frozen / scale,
    base: base / scale,
    remain: remain / scale,
    bonus: bonus?.amount ?? null,
    bonusDesc: bonus?.desc ?? null,
    bonusExpire: bonus?.expire ?? null,
    bonusExpired: bonus?.expired ?? false,
  };
}

/**
 * 三个接口的原始 JSON → 一笔账：
 *
 *   { credit: {...}, devHours: {...} }
 *
 * credits 在 milli 口径上算，核时在秒口径上算，最后才换算显示单位，
 * 避免中间反复换算丢精度。接口都没数据时返回 null。
 */
export function settleCharge(quota, volume, special, now = Date.now()) {
  if (!quota && !volume) return null;
  const out = {};

  const credit = book(
    num(quota?.credit_in_milli),
    num(volume?.credit_in_milli),
    num(volume?.freeze_credit_in_milli) || 0,
    specialOf(special, 'credit', 1, null, now), // credit 单位是 credit，不是 milli
    1000,
  );
  if (credit) {
    credit.free = num(quota?.credit_in_milli?.free);
    out.credit = credit;
  }

  // compute_develop_corehour 的说明字段是 compute_develop_desc（没有 _corehour）
  const dev = book(
    num(quota?.dev_in_sec),
    num(volume?.dev_in_sec),
    num(volume?.freeze_dev_in_sec) || 0,
    specialOf(special, 'compute_develop_corehour', 1, 'compute_develop', now),
    3600,
  );
  if (dev) out.devHours = dev;

  return out.credit || out.devHours ? out : null;
}

/**
 * 余额告警：已耗比例达到阈值就出句子。阈值 0 = 关闭。
 *
 * 判定口径与「可不可用」一致：只提示，不改路由；是否停用由 creditFloorPercent 决定。
 */
export function creditNotice(charge, floorPercent, label = '') {
  const c = charge?.credit;
  // 已用量未知时不提示：否则只能拿 0 冒充，反而误导。
  if (!c || c.total == null || c.used == null || !floorPercent) return null;
  const leftPct = 100 - (c.usedFrozenPct ?? c.usedPct ?? 0);
  if (leftPct > floorPercent) return null;
  const who = label ? `${label} ` : '';
  return `${who}额度告急：已用 ${num1((c.used ?? 0) + c.frozen)}/${num1(c.total)} cr`
    + `（${leftPct.toFixed(2)}% 剩余），仅剩 ${num1(c.remain)} cr`;
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

const DEFAULTS = {
  repo: '',
  org: '',
  token: '',
  proxyKey: '',
  models: 'deepseek-v4.1-flash',
  branch: 'main',
  checkSeconds: 120,
  autoStart: true,
  port: 9001,
  idleStopMinutes: 0,
  creditFloorPercent: 1,
};

/** 把一堆字符串/数字/布尔的混填收敛成一组确定的选项。 */
export function normalizeOptions(given = {}) {
  const o = { ...DEFAULTS, ...(given || {}) };
  o.checkSeconds = Math.max(30, Number(o.checkSeconds) || DEFAULTS.checkSeconds);
  o.port = Number(o.port) || DEFAULTS.port;
  o.autoStart = o.autoStart !== false && o.autoStart !== 'false';
  const idle = Number(o.idleStopMinutes) || 0;
  // 0 或负数 = 不自动停；更短的空闲阈值比一个计费周期还短，没有意义
  o.idleStopMinutes = idle > 0 ? Math.max(5, Math.round(idle)) : 0;
  const floor = Number(o.creditFloorPercent);
  o.creditFloorPercent = Number.isFinite(floor) ? Math.min(100, Math.max(0, floor)) : DEFAULTS.creditFloorPercent;
  o.repo = normalizeRepo(o.repo);
  o.org = String(o.org || '').trim();
  o.branch = String(o.branch || DEFAULTS.branch).trim() || DEFAULTS.branch;
  o.token = String(o.token || '').trim();
  o.proxyKey = String(o.proxyKey || '').trim();
  return o;
}

/** 模型清单：逗号（或空白）分隔，去重保序。 */
export function modelIds(models) {
  const seen = new Set();
  const out = [];
  for (const raw of String(models || '').split(/[,\s]+/)) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 不带日志的令牌指纹：只用于缓存键，永不写进日志或配置。 */
export function fingerprint(secret) {
  const s = String(secret || '').trim();
  if (!s) return 'anonymous';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `f${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * 从 CNB 的 403 报文里读出缺了哪些 scope。
 * 形如 `Missing required scopes: a, b`，用来把 403 翻成「去勾哪一项」。
 */
export function missingScopes(text) {
  const m = String(text || '').match(/Missing required scopes?:\s*([a-z0-9:,\s_-]+)/i);
  if (!m) return [];
  return m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 权限清单：每项写明 scope、必需性、对应哪个接口、缺了会怎样。
 * 插件启动后主动探测一遍，把缺少的权限用人话报出来，免得用户对着 403 猜。
 */
export const PERMISSIONS = [
  {
    scope: 'repo-cnb-trigger:r',
    need: 'required',
    label: '读流水线日志',
    why: '上游地址只能从工作区启动日志里的 PROXY_URI= 拿到。',
    endpoint: 'GET /{repo}/-/build/runner/download/log/{sn}-001',
    missing: '取不到地址，插件不可用',
  },
  {
    scope: 'account-engage:r',
    need: 'required',
    label: '列自己的工作区',
    why: '先要知道有哪些工作区、哪个在 running，才能去读它的日志。',
    endpoint: 'GET /workspace/list',
    missing: '找不到工作区，插件不可用',
  },
  {
    scope: 'repo-cnb-trigger:rw',
    need: 'required-for-autostart',
    label: '拉起工作区',
    why: '工作区被平台回收后自动重新启动。',
    endpoint: 'POST /{repo}/-/workspace/start',
    missing: '工作区停了要手动去 CNB 点启动',
  },
  {
    scope: 'group-resource:r',
    need: 'optional',
    label: '组织额度',
    why: '显示真实的 AI credits 与核时，并在启动前判断额度是否已用尽。',
    endpoint: 'GET /{org}/-/charge/quota',
    missing: '面板不显示额度，启动前也不再拦截',
  },
  {
    scope: 'account-engage:rw',
    need: 'optional',
    label: '停止工作区（省核时）',
    why: '工作区 running 就按时间扣核时，不发请求也在扣；有了这项才能主动停。',
    endpoint: 'POST /workspace/stop',
    missing: 'idleStopMinutes 与停止工具用不了，只能等平台回收',
  },
];

