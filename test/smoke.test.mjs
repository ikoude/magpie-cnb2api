// 冒烟：登录问答顺序、usage 面板形状、两个工具的输出。
import { Cn2ApiPlugin } from '../index.mjs';
import { ok, json, pathOf, summary } from './_harness.mjs';

globalThis.fetch = async (u0) => {
  const p = pathOf(u0);
  if (p === '/health') return json({ status: 'ok' });
  if (p.startsWith('/user/groups')) return json([{ path: 'acme' }, { path: 'beta' }]);
  if (p.startsWith('/user/repos')) return json([{ path: 'acme/gateway' }]);
  if (p.startsWith('/user')) return json({ id: 1, username: 'alice' });
  if (p.startsWith('/workspace/list')) {
    return json({ list: [{ slug: 'acme/gateway', sn: 'sn-1', status: 'running', create_time: '2026-11-18T10:00:00Z' }] });
  }
  if (p.includes('/-/charge/quota')) return json({ credit_in_milli: { total: 1200000 }, dev_in_sec: { total: 3600000 } });
  if (p.includes('/-/charge/volume')) return json({ credit_in_milli: 800000, dev_in_sec: 100 });
  if (p.includes('/-/charge/special-amount')) return json({ credit: 600, credit_desc: '赠送额度', credit_expire: '9999-12-31' });
  if (p.includes('/build/runner/download/log/')) return new Response('PROXY_URI=https://ab12-{{port}}.cnb.run\n');
  return json({});
};

const plugin = await Cn2ApiPlugin({
  client: { app: { log() {} }, auth: {} },
  options: { token: 'tok', repo: 'acme/gateway', checkSeconds: 86400 },
});
const auth = {
  type: 'api',
  key: 'sk',
  metadata: {
    token: 'tok', proxyKey: 'sk', username: 'alice',
    email: 'alice | acme/gateway@cnb.cool', repo: 'acme/gateway', org: 'acme',
  },
};

console.log('\n[登录问答]');
const m = plugin.auth.methods[0];
const seq = [];
const inputs = {};
for (let i = 0; i < 6; i++) {
  const q = await m.ask(inputs);
  if (!q) break;
  seq.push(q.key);
  if (q.key === 'token') inputs.token = 'tok';
  else if (q.key === 'orgs') inputs.orgs = 'acme,__done__';
  else if (q.key.startsWith('repo@')) inputs[q.key] = 'acme/gateway';
  else if (q.key === 'proxyKey') inputs.proxyKey = 'sk-x';
}
ok(seq.join('>') === 'token>orgs>repo@acme>proxyKey', `问答顺序 ${seq.join('>')}`);

console.log('\n[usage]');
const rows = await plugin.auth.usage(async () => auth);
ok(rows && (Array.isArray(rows) || typeof rows === 'object'), `usage 返回值类型 ${Array.isArray(rows) ? 'array' : typeof rows}：${JSON.stringify(rows)?.slice(0, 160)}`);
const flat = JSON.stringify(rows);
ok(/alice \| acme\/gateway/.test(flat), '账号名带仓库');
ok(/AI credits/.test(flat), '有 AI credits 行');

console.log('\n[工具]');
const st = await plugin.tool.cnb2api_workspace_status.execute({});
ok(/地址 ab12\*\*\*\*-9001/.test(st), `status 输出 ${st}`);
const q = await plugin.tool.cnb2api_quota.execute({});
ok(/AI credits 已用 800 \/ 1200/.test(q), `quota 输出 ${q}`);

summary();
