// usage（额度面板钩子）不能被启动/探活拖住，也不能查不到就留空白。
import { Cn2ApiPlugin } from '../index.mjs';
import { ok, json, pathOf, sleep, summary } from './_harness.mjs';

const world = {
  status: 'closed',
  startDelayMs: 7000,
  chargeStatus: 200,
  starts: 0,
  alive: true,
};

globalThis.fetch = async (u0, init = {}) => {
  const p = pathOf(u0);
  const m = String(init?.method || 'GET').toUpperCase();
  if (p === '/health') {
    if (!world.alive) {
      // 模拟端口不通：一直挂着，直到 AbortSignal 掐断（真实 fetch 的行为）
      return new Promise((_, rej) => {
        const t = setTimeout(() => rej(new Error('ECONNREFUSED')), 30000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
      });
    }
    return json({ status: 'ok' });
  }
  if (p.startsWith('/user')) return json({ username: 'alice' });
  if (p.startsWith('/workspace/list')) {
    return json({ list: [{ slug: 'acme/gateway', sn: 'sn-1', status: world.status, create_time: '2026-11-18T10:00:00Z' }] });
  }
  if (m === 'POST' && p.includes('/-/workspace/start')) {
    world.starts++;
    await sleep(world.startDelayMs);
    world.status = 'building';
    return json({});
  }
  if (p.includes('/-/charge/')) {
    if (world.chargeStatus !== 200) return new Response('{"message":"no scope"}', { status: world.chargeStatus });
    if (p.includes('quota')) return json({ credit_in_milli: { total: 1166000 }, dev_in_sec: { total: 5760000 } });
    if (p.includes('volume')) return json({ credit_in_milli: 300000, dev_in_sec: 100 });
    return json({});
  }
  if (p.includes('/build/runner/download/log/')) return new Response('PROXY_URI=https://ab12-{{port}}.cnb.run');
  return json({});
};

async function boot() {
  const plugin = await Cn2ApiPlugin({
    client: { app: { log() {} }, auth: {} },
    options: { token: 'tok', repo: 'acme/gateway', checkSeconds: 86400 },
  });
  const auth = {
    type: 'api', key: 'sk',
    metadata: { token: 'tok', proxyKey: 'sk', username: 'alice', email: 'alice | acme/gateway@cnb.cool', repo: 'acme/gateway', org: 'acme' },
  };
  return { plugin, auth };
}

console.log('\n[1] 工作区已停止 + start 很慢：usage 不能等它');
{
  world.status = 'closed'; world.startDelayMs = 7000; world.starts = 0; world.chargeStatus = 200;
  const { plugin, auth } = await boot();
  const t0 = Date.now();
  const out = await plugin.auth.usage(async () => auth);
  const ms = Date.now() - t0;
  ok(ms < 2500, `usage 在 ${ms}ms 内返回（不再等 start）`);
  const credit = (out.windows || []).find((w) => w.name === 'AI credits');
  ok(!!credit, '额度卡片有 AI credits 行');
  ok(credit && credit.used != null, `额度带读数 used=${credit?.used}`);
  const ws = (out.windows || []).find((w) => w.name === 'workspace');
  ok(/工作区已停止/.test(ws?.display || ''), `workspace 行说明已停止，实际 ${ws?.display}`);
}

console.log('\n[2] 额度接口 403（缺 group-resource:r）：写明原因，不能空白');
{
  world.status = 'running'; world.chargeStatus = 403;
  const { plugin, auth } = await boot();
  const out = await plugin.auth.usage(async () => auth);
  const credit = (out.windows || []).find((w) => w.name === 'AI credits');
  ok(!!credit, '仍然有 AI credits 行（不再是空白）');
  ok(/查不到/.test(credit?.display || ''), `写明查不到，实际 ${credit?.display}`);
  ok(/quota/.test(credit?.display || ''), `带上接口名帮助排查，实际 ${credit?.display}`);
  ok(credit?.text === true, '纯文本窗口（不画进度条）');
}

console.log('\n[3] 额度正常时仍然照常显示');
{
  world.status = 'running'; world.chargeStatus = 200; world.alive = true;
  const { plugin, auth } = await boot();
  const out = await plugin.auth.usage(async () => auth);
  const credit = (out.windows || []).find((w) => w.name === 'AI credits');
  ok(credit?.amount === 300 && credit?.limit === 1166, `已用 300 / 1166，实际 ${credit?.amount}/${credit?.limit}`);
  ok(/可用 866/.test(credit?.display || ''), `可用 866，实际 ${credit?.display}`);
}

console.log('\n[4] 地址不通：探活限时，不让面板干等');
{
  world.status = 'running'; world.chargeStatus = 200; world.alive = false;
  const { plugin, auth } = await boot();
  const t0 = Date.now();
  const out = await plugin.auth.usage(async () => auth);
  const ms = Date.now() - t0;
  ok(ms < 3500, `usage 在 ${ms}ms 内返回（探活有超时）`);
  const credit = (out.windows || []).find((w) => w.name === 'AI credits');
  ok(!!credit && credit.amount === 300, '额度照样拿到，不被探活拖累');
}

console.log('\n[5] 仓库未确定：说清楚，不是静默');
{
  const plugin = await Cn2ApiPlugin({
    client: { app: { log() {} }, auth: {} },
    options: { token: 'tok', repo: '', checkSeconds: 86400 },
  });
  const auth = { type: 'api', key: 'sk', metadata: { token: 'tok', proxyKey: 'sk', username: 'alice' } };
  const out = await plugin.auth.usage(async () => auth);
  const credit = (out.windows || []).find((w) => w.name === 'AI credits');
  ok(/查不到/.test(credit?.display || ''), `说明查不到，实际 ${credit?.display}`);
}

summary();
