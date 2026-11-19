// 一次登录写多个账号：宿主只 settle 一条，其余由插件用 client.auth.set 补写。
//
// 这条路径真实跑在 CNB 上验过（2026-11-20）：两个组织的 authorize 返回第一个
// 仓库的 key，并补写第二个账号，键形如 cnb2api#<指纹>，magpie 会把它落进
// plugin-auth.json 的账号表。断言的 id 用同一套指纹算，格式一变就会挂。
import { Cn2ApiPlugin, _internal as I } from '../index.mjs';
import { ok, eq, json, pathOf, summary } from './_harness.mjs';

const logs = [];
const written = [];

const mkClient = (withSet = true) => ({
  app: { log: (o) => logs.push(o?.body?.message || String(o)) },
  auth: withSet ? { async set(arg) { written.push(arg); } } : {},
});

globalThis.fetch = async (u0) => {
  const p = pathOf(u0);
  if (p.startsWith('/workspace/list')) return json({ list: [] });
  if (p.startsWith('/user/repos')) return json([{ path: 'acme/gateway' }, { path: 'beta/other' }]);
  if (p === '/user') return json({ id: 1, username: 'alice' });
  return json({});
};

const TOKEN = 'tok-secret';
const twoOrgs = {
  token: TOKEN,
  orgs: 'acme,beta,__done__',
  'repo@acme': 'acme/gateway',
  'repo@beta': 'beta/other',
  'proxyKey@acme/gateway': 'sk-alpha',
  'proxyKey@beta/other': 'sk-beta',
};

async function authorize(inputs, withSet = true) {
  written.length = 0;
  const plugin = await Cn2ApiPlugin({ client: mkClient(withSet), options: {} });
  return plugin.auth.methods[0].authorize(inputs);
}

console.log('\n[1] 两个组织：返回第一个，补写第二个');
{
  const res = await authorize(twoOrgs);
  ok(res.type === 'success', `结果成功，实际 ${res.type} ${res.error || ''}`);
  eq(res.key, 'sk-alpha', '返回的 key 是第一个仓库的');
  eq(res.metadata.email, 'alice | acme/gateway@cnb.cool', '主账号身份');
  eq(res.metadata.proxyKey, 'sk-alpha', '主账号的 metadata.proxyKey');
  eq(written.length, 1, '补写了 1 个账号');
  const w = written[0] || {};
  eq(w.path?.id, `cnb2api#${I.fp('acct:alice | beta/other@cnb.cool')}`, '补写用的账号 id');
  eq(w.body?.key, 'sk-beta', '补写账号的 key 用自己仓库的值');
  eq(w.body?.metadata?.repo, 'beta/other', '补写账号的仓库');
  eq(w.body?.type, 'api', '补写账号的类型');
}

console.log('\n[2] 再登一次同样的组合：id 不变，等于覆盖自己');
{
  const first = await authorize(twoOrgs);
  const firstId = written[0]?.path?.id;
  ok(first.type === 'success', '第一次成功');
  const again = await authorize(twoOrgs);
  ok(again.type === 'success', '第二次成功');
  eq(written[0]?.path?.id, firstId, '两次 id 相同');
  ok(!`${written[0]?.body?.metadata?.email}${written[0]?.body?.key}`
    .includes(TOKEN), 'id/key/身份串里不含访问令牌原文');
}

console.log('\n[3] 宿主没有 auth.set：仍然成功，但要说明其余账号需分别登录');
{
  logs.length = 0;
  const res = await authorize(twoOrgs, false);
  ok(res.type === 'success', `主账号照样加上了，实际 ${res.type}`);
  const joined = logs.join('\n');
  ok(/不支持一次写入多个账号/.test(joined), `日志说明不支持，实际 ${joined.slice(0, 120)}`);
  ok(/beta\/other/.test(joined), '点出没写进去的是哪个仓库');
}

console.log('\n[4] PROXY_KEY 填成令牌：拒绝，且一个都不写');
{
  const res = await authorize({ ...twoOrgs, 'proxyKey@beta/other': TOKEN });
  ok(res.type === 'failed', `拒绝登录，实际 ${res.type}`);
  ok(/与 CNB 访问令牌相同/.test(res.error || ''), `说明填反了，实际 ${res.error}`);
  eq(written.length, 0, '没有写入任何账号');
}

console.log('\n[5] 只加一个组织：不走多账号写入');
{
  const res = await authorize({
    token: TOKEN,
    orgs: 'acme,__done__',
    'repo@acme': 'acme/gateway',
    'proxyKey@acme/gateway': 'sk-alpha',
  });
  ok(res.type === 'success', `成功，实际 ${res.type}`);
  eq(written.length, 0, 'auth.set 一次都没调');
}

summary();
