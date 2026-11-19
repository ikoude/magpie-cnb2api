// 工作区被停掉后：请求失败 -> 重启 -> 等到新地址再重试。
//
// 旧实现里 state.uri 还留着上一次的地址，waitForReady 一进循环就返回 true，
// 重试打回死地址，等于没等。这条测试就是盯着那个回归。
import { Cn2ApiPlugin } from '../index.mjs';
import { ok, json, summary } from './_harness.mjs';

const world = {
  status: 'running',
  logHost: 'ab12',
  dead: new Set(),          // 这些地址的请求直接抛连接错误
  startedAt: 0,
  hits: [],
};

globalThis.fetch = async (u0, init = {}) => {
  const url = String(u0 instanceof Request ? u0.url : u0);
  const host = new URL(url).host;
  const path = new URL(url).pathname;
  world.hits.push(`${init.method || 'GET'} ${host}${path}`);

  // 网关（*.cnb.run）
  if (host.endsWith('cnb.run')) {
    const name = host.split('-')[0];
    if (world.dead.has(name)) throw new TypeError('fetch failed');
    if (path === '/health') return json({ status: 'ok' });
    return json({ ok: 1, host });
  }

  // CNB OpenAPI
  if (path === '/workspace/list') {
    return json({ list: [{ slug: 'acme/gateway', sn: 'sn-1', status: world.status, create_time: '2026-11-18T10:00:00Z' }] });
  }
  if (path === '/acme/gateway/-/workspace/start') {
    world.startedAt = Date.now();
    setTimeout(() => { world.status = 'running'; world.logHost = 'ab34'; }, 1500);
    return json({});
  }
  if (path.includes('/build/runner/download/log/')) {
    return new Response(`PROXY_URI=https://${world.logHost}-{{port}}.cnb.run\n`);
  }
  if (path.endsWith('/charge/quota')) return json({ credit_in_milli: { total: 1000000 }, dev_in_sec: { total: 3600 } });
  if (path.endsWith('/charge/volume')) return json({ credit_in_milli: 0, dev_in_sec: 0 });
  if (path.endsWith('/charge/special-amount')) return json({ credit: 0 });
  return json({});
};

const plugin = await Cn2ApiPlugin({
  client: { app: { log() {} }, auth: {} },
  options: { token: 'tok', repo: 'acme/gateway', checkSeconds: 86400 },
});
const auth = {
  type: 'api', key: 'sk',
  metadata: { token: 'tok', proxyKey: 'sk', username: 'alice', repo: 'acme/gateway', org: 'acme' },
};
const loader = await plugin.auth.loader(async () => auth);
ok(loader.baseURL.includes('ab12'), `首轮拿到地址 ${loader.baseURL}`);

// 平台把工作区停了：地址作废，列表显示 closed，1.5 秒后重启成功、换新域名
world.status = 'closed';
world.dead.add('ab12');
const t0 = Date.now();
const res = await loader.fetch('https://ab12-9001.cnb.run/v1/chat/completions', { method: 'POST', body: '{}' });
const body = await res.json();
const cost = Date.now() - t0;

ok(res.status === 200, `重试成功，HTTP ${res.status}（耗时 ${cost}ms）`);
ok(body.host.startsWith('ab34'), `重试用的是新地址，实际 ${body.host}`);
ok(cost >= 1400, `确实等到工作区重新 running（${cost}ms ≥ 1500ms 的启动延迟）`);
const oldHits = world.hits.filter((h) => h.includes('ab12') && h.includes('/v1/')).length;
ok(oldHits <= 1, `没有反复打旧地址：${oldHits} 次`);

summary();
