// 额度闸门：额度用尽时不提交启动，额度还有时只提交一次。
import { Cn2ApiPlugin } from '../index.mjs';
import { ok, json, text, http, pathOf, summary } from './_harness.mjs';

const closed = () => [{ slug: 'acme/gateway', sn: 'sn-1', status: 'closed', create_time: '2026-11-18T10:00:00Z' }];

// 可调的假 CNB：credits 剩余、工作区状态、接口是否挂掉
const world = {
  creditTotalMilli: 800000,
  creditUsedMilli: 800000,
  workspaces: closed(),
  starts: [],
  chargeCalls: 0,
  chargeFails: false,
};

const reset = (usedMilli, totalMilli = 800000) => {
  world.creditUsedMilli = usedMilli;
  world.creditTotalMilli = totalMilli;
  world.starts = [];
  world.chargeCalls = 0;
  world.chargeFails = false;
  world.workspaces = closed();
};

globalThis.fetch = async (u0, init = {}) => {
  const p = pathOf(u0);
  const method = String(init?.method || 'GET').toUpperCase();

  if (p === '/health') return json({ status: 'ok' });
  if (p.startsWith('/user')) return json({ id: 1, username: 'alice' });
  if (p.startsWith('/workspace/list')) return json({ list: world.workspaces });
  if (method === 'POST' && p.includes('/-/workspace/start')) {
    world.starts.push(p);
    // 真实行为：提交后工作区变成 running，日志里才有新地址
    world.workspaces = [{ slug: 'acme/gateway', sn: 'sn-2', status: 'running', create_time: new Date().toISOString() }];
    return json({});
  }

  if (p.includes('/-/charge/quota')) {
    world.chargeCalls++;
    if (world.chargeFails) return http(403, '{"message":"no scope"}');
    return json({ credit_in_milli: { total: world.creditTotalMilli, free: 0 }, dev_in_sec: { total: 3600000, free: 0 } });
  }
  if (p.includes('/-/charge/volume')) {
    if (world.chargeFails) return http(403, '');
    return json({ credit_in_milli: world.creditUsedMilli, dev_in_sec: 100 });
  }
  if (p.includes('/-/charge/special-amount')) {
    if (world.chargeFails) return http(403, '');
    return json({});
  }
  if (p.includes('/build/runner/download/log/')) return text('PROXY_URI=https://ab12-{{port}}.cnb.run\n');
  return json({});
};

async function boot(opts = {}) {
  const client = { app: { log() {} }, auth: { async set() {} } };
  const plugin = await Cn2ApiPlugin({
    client,
    options: { token: 'tok', repo: 'acme/gateway', checkSeconds: 86400, ...opts },
  });
  const auth = {
    type: 'api', key: 'sk-x',
    metadata: { token: 'tok', proxyKey: 'sk-x', username: 'alice', email: 'alice | acme/gateway@cnb.cool', repo: 'acme/gateway', org: 'acme' },
  };
  const loader = await plugin.auth.loader(async () => auth);
  return { plugin, loader };
}

console.log('\n[1] 额度用尽：不提交启动');
{
  reset(800000);
  const t0 = Date.now();
  const { loader } = await boot();
  const bootMs = Date.now() - t0;
  const st = await loader.fetch('https://placeholder-9001.cnb.run/v1/models');
  ok(bootMs < 3000, `首轮 ${bootMs}ms 内给出结论（不空等一轮轮询间隔）`);
  ok(world.starts.length === 0, `没有 POST /workspace/start，实际 ${world.starts.length} 次`);
  ok(st.status === 503, `返回 503，实际 ${st.status}`);
  const body = await st.json();
  ok(/AI credits 已用尽/.test(body.error.message), '说明额度用尽');
  ok(/已用 800 \/ 800 cr/.test(body.error.message), `带上已用/总额，实际 ${body.error.message}`);
}

console.log('\n[2] 额度还有：正常启动，且只提交一次');
{
  reset(500000);   // 剩 300 cr
  const { loader } = await boot();
  const st = await loader.fetch('https://placeholder-9001.cnb.run/v1/models');
  ok(world.starts.length === 1, `只提交一次启动，实际 ${world.starts.length}`);
  ok(/\/acme\/gateway\/-\/workspace\/start/.test(world.starts[0] || ''), `启动的是这个仓库，实际 ${world.starts[0]}`);
  ok(st.status === 200, `请求正常返回，实际 ${st.status}`);
}

console.log('\n[3] 额度接口查不到：放行（不能把人卡死）');
{
  reset(800000);
  world.chargeFails = true;
  const { loader } = await boot();
  await loader.fetch('https://placeholder-9001.cnb.run/v1/models');
  ok(world.starts.length === 1, `缺 group-resource:r 时照样启动，实际 ${world.starts.length}`);
}

console.log('\n[4] 工具 start：被拦下并说明原因');
{
  reset(800000);
  const { plugin, loader } = await boot();
  await loader.fetch('https://placeholder-9001.cnb.run/v1/models');   // 先把 ctx 建起来
  const before = world.starts.length;
  const out = await plugin.tool.cnb2api_workspace_start.execute({});
  ok(world.starts.length === before, `工具也没启动，实际多了 ${world.starts.length - before} 次`);
  ok(/AI credits 已用尽/.test(out), `工具输出说明额度，实际 ${out}`);
  ok(!/已提交启动/.test(out), `不会谎称已提交，实际 ${out}`);
}

console.log('\n[5] 额度查询有缓存：同一次巡检只查一轮');
{
  reset(800000);
  const { plugin, loader } = await boot();
  await loader.fetch('https://placeholder-9001.cnb.run/v1/models');
  const first = world.chargeCalls;
  // status 工具走的是巡检那条路（不强制现查），应当复用缓存
  await plugin.tool.cnb2api_workspace_status.execute({});
  ok(first >= 2, `首轮查了 charge（含权限自检那次），实际 ${first} 次`);
  ok(world.chargeCalls === first, `60 秒内复用结论、不重复查，实际 ${world.chargeCalls}`);
  // 显式「启动」则会现查一次：用户刚充完额度，不该被旧结论挡住
  await plugin.tool.cnb2api_workspace_start.execute({});
  ok(world.chargeCalls > first, `显式启动会现查额度，实际 ${world.chargeCalls}`);
}

console.log('\n[6] 总额为 0 也算用尽');
{
  reset(0, 0);
  const { plugin, loader } = await boot();
  await loader.fetch('https://placeholder-9001.cnb.run/v1/models');
  ok(world.starts.length === 0, `总额 0 不启动，实际 ${world.starts.length}`);
  const out = await plugin.tool.cnb2api_workspace_start.execute({});
  ok(/AI credits 已用尽/.test(out), `工具也拦，实际 ${out}`);
}

console.log('\n[7] 402 EXCEEDING_LIMIT 被翻成人话');
{
  reset(0);
  const { loader } = await boot();
  // 工作区还在跑，但请求被 cnb2api 拒了
  world.workspaces = [{ slug: 'acme/gateway', sn: 'sn-1', status: 'running', create_time: '2026-11-18T10:00:00Z' }];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u0, init) => {
    const u = String(u0 instanceof Request ? u0.url : u0);
    if (u.startsWith('https://ab12-9001.cnb.run/v1/chat')) {
      return http(402, JSON.stringify({
        error: { message: '[EXCEEDING_LIMIT]AI 积分已用尽，请联系根组织管理员提升配额。', type: 'cnb2api' },
      }));
    }
    return realFetch(u0, init);
  };
  const st = await loader.fetch('https://ab12-9001.cnb.run/v1/chat', { method: 'POST' });
  const body = await st.json();
  globalThis.fetch = realFetch;
  ok(st.status === 402, `保留 402，实际 ${st.status}`);
  ok(/EXCEEDING_LIMIT/.test(body.error.message), `原报文保留，实际 ${body.error.message}`);
  ok(/不会自动启动工作区/.test(body.error.message), `补了插件行为说明，实际 ${body.error.message}`);
}

console.log('\n[8] 额度恢复：过了缓存期就自动补启动');
{
  reset(800000);
  const { plugin } = await boot();
  const out1 = await plugin.tool.cnb2api_workspace_start.execute({});
  ok(/AI credits 已用尽/.test(out1), '先被拦下');
  ok(world.starts.length === 0, '拦下时没提交');
  // 额度补足 + 跳过 60 秒缓存期（直接拨表，避免真等）
  world.creditUsedMilli = 100000;
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await plugin.tool.cnb2api_workspace_start.execute({});
  } finally {
    Date.now = realNow;
  }
  ok(world.starts.length === 1, `恢复后补了一次启动，实际 ${world.starts.length}`);
}

summary();
