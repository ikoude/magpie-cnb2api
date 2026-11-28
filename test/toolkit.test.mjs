// toolkit 的纯函数测试：地址、仓库写法、身份、额度。全部不碰网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERMISSIONS,
  accountIdOf,
  accountsFor,
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
  settleCharge,
  specialOf,
} from '../toolkit.mjs';

// --- 地址 -------------------------------------------------------------------

test('PROXY_URI 里的 {{port}} 模板必须换成真实端口', () => {
  const log = 'deploy: PROXY_URI=https://tm5fw16v80-{{port}}.cnb.run\nlistening on 9001\n';
  assert.equal(pickUriFromLog(log, 9001), 'https://tm5fw16v80-9001.cnb.run');
});

test('热重启打印多条时取最后一条', () => {
  const log = [
    'started',
    'PROXY_URI=https://aaaa1111-{{port}}.cnb.run',
    'restart',
    'PROXY_URI=https://bbbb2222-{{port}}.cnb.run',
    'done',
  ].join('\n');
  assert.equal(pickUriFromLog(log, 9001), 'https://bbbb2222-9001.cnb.run');
});

test('PROXY_URI 缺失时，裸主机兜底（仓库直接 echo 地址）', () => {
  assert.equal(
    pickUriFromLog('cloning from https://cccc3333-9001.cnb.run now', 9001),
    'https://cccc3333-9001.cnb.run',
  );
});

test('兼容 PROXY_URI: 与 ANSI 颜色码，并剥掉 /v1 路径', () => {
  const line = '\x1b[32mPROXY_URI: "https://tm5fw16v80-{{port}}.cnb.run/v1"\x1b[0m';
  assert.equal(pickUriFromLog(line, 9001), 'https://tm5fw16v80-9001.cnb.run');
});

test('cnb.cool 的控制台地址不是上游', () => {
  const webide = 'https://cnb.cool/alice/gateway/-/workspace/vscode-web/cnb-1abc-001';
  assert.equal(pickUri(webide), null);
});

test('子域允许连字符', () => {
  assert.equal(pickUri('https://my-gateway-9001.cnb.run/'), 'https://my-gateway-9001.cnb.run');
});

test('hostOf 非法地址时原样返回', () => {
  assert.equal(hostOf('https://aa-9001.cnb.run'), 'aa-9001.cnb.run');
  assert.equal(hostOf('not a url'), 'not a url');
  assert.equal(hostOf(undefined), '');
});

test('域名打码保留前 4 位与端口', () => {
  assert.equal(maskHost('860lo2zlkf-9001.cnb.run'), '860l****-9001.cnb.run');
  assert.equal(maskHost('short'), 'short');
  assert.equal(maskHost(''), '');
});

// --- 仓库写法 ---------------------------------------------------------------

test('仓库写法的各种形态都归一成 org/repo', () => {
  const want = 'alice/gateway';
  for (const input of [
    'https://cnb.cool/alice/gateway',
    'https://cnb.cool/alice/gateway/-/tree/main',
    'cnb.cool/alice/gateway',
    'git@cnb.cool:alice/gateway.git',
    '/alice/gateway',
    'alice/gateway.git',
    'alice/gateway',
  ]) {
    assert.equal(normalizeRepo(input), want, input);
  }
});

test('只给仓库名时保留名字，交给调用方补组织', () => {
  assert.equal(normalizeRepo('my-gateway'), 'my-gateway');
  assert.equal(orgOf('my-gateway'), '');
  assert.equal(orgOf('alice/gateway'), 'alice');
  assert.equal(orgOf(''), '');
});

test('空输入与怪输入返回空串', () => {
  assert.equal(normalizeRepo(''), '');
  assert.equal(normalizeRepo(null), '');
  assert.equal(normalizeRepo('   '), '');
});

// --- 身份 -------------------------------------------------------------------

test('账号标识是「用户名 | org/repo」', () => {
  assert.equal(accountIdOf({ username: 'alice', repo: 'acme/gateway' }), 'alice | acme/gateway');
});

test('同一用户在不同组织下是不同账号', () => {
  const a = accountIdOf({ username: 'alice', repo: 'acme/gateway' });
  const b = accountIdOf({ username: 'alice', repo: 'beta/gateway' });
  assert.notEqual(a, b);
});

test('没有仓库时按组织分开，仍不退回邮箱', () => {
  assert.equal(accountIdOf({ username: 'alice', org: 'acme' }), 'alice | @acme');
  // 同一个用户名、不同组织 → 不同标识（额度各算各的）
  assert.notEqual(
    accountIdOf({ username: 'alice', org: 'acme' }),
    accountIdOf({ username: 'alice', org: 'beta' }),
  );
});

test('标识里不出现 @ 形式的邮箱', () => {
  const id = accountIdOf({ username: 'alice', repo: 'acme/gateway' });
  assert.ok(!id.includes('@cnb.cool'), id);
  assert.ok(!/^[^@\s]+@[^@\s]+\.[a-z]+$/i.test(id), id);
});

test('一个身份按组织展开成多个账号，去重保序', () => {
  const list = accountsFor('alice', ['acme', 'beta', 'acme'], { acme: 'acme/gateway' });
  assert.deepEqual(list.map((x) => x.label), ['alice | acme/gateway', 'alice | @beta']);
});

test('accountId 能反解出用户名、组织、仓库', () => {
  assert.deepEqual(parseAccountId('alice | acme/gateway'), {
    username: 'alice',
    org: 'acme',
    repo: 'acme/gateway',
  });
  assert.deepEqual(parseAccountId('alice | @beta'), { username: 'alice', org: 'beta', repo: '' });
  assert.deepEqual(parseAccountId('plainname'), { username: 'plainname', org: '', repo: '' });
});

test('指纹稳定、短、不含原文', () => {
  const a = fingerprint('nk-secret-token');
  assert.equal(a, fingerprint('nk-secret-token'));
  assert.notEqual(a, fingerprint('nk-secret-token2'));
  assert.ok(!a.includes('secret'));
  assert.equal(fingerprint(''), 'anonymous');
});

// --- 额度 -------------------------------------------------------------------

const QUOTA = { credit_in_milli: { total: 1166000, free: 200000 }, dev_in_sec: { total: 360000 } };
const VOLUME = { credit_in_milli: 477940, freeze_credit_in_milli: 642710, dev_in_sec: 18000, freeze_dev_in_sec: 3600 };
const SPECIAL = { credit: 666, credit_desc: '天才程序员专属特权', credit_expire: '2030-12-31T00:00:00Z' };

test('一笔账：总额/已用/冻结/可用/加成', () => {
  const c = settleCharge(QUOTA, VOLUME, SPECIAL, Date.parse('2026-01-01T00:00:00Z')).credit;
  assert.equal(c.total, 1166);
  assert.equal(c.used, 477.94);
  assert.equal(c.frozen, 642.71);
  assert.equal(c.bonus, 666);
  assert.equal(c.base, 500); // total 已含赠送，基础额度要减掉
  // 可用 = 总额 − 已用 − 冻结，且不为负
  assert.ok(Math.abs(c.remain - 45.35) < 1e-9);
});

test('进度条口径用 已用 + 预扣，而不是只用已用', () => {
  const c = settleCharge(QUOTA, VOLUME, SPECIAL).credit;
  const consumedPct = ((477.94 + 642.71) / 1166) * 100;
  assert.ok(Math.abs(c.usedFrozenPct - consumedPct) < 1e-9);
  assert.ok(c.usedFrozenPct > c.usedPct);
});

test('可用为负时归零', () => {
  const c = settleCharge(
    { credit_in_milli: { total: 100000 } },
    { credit_in_milli: 90000, freeze_credit_in_milli: 50000 },
  ).credit;
  assert.equal(c.remain, 0);
});

test('已过期的加成要标出来，不能继续吹 +666', () => {
  const b = specialOf(SPECIAL, 'credit', 1, null, Date.parse('2031-01-01T00:00:00Z'));
  assert.equal(b.expired, true);
  assert.match(bonusPart(b.amount, b.desc, b.expire, b.expired), /已过期/);
});

test('没有加成时不出现噪音', () => {
  assert.equal(bonusPart(null, null, null, false), '');
});

test('核时字段名没有 _corehour 后缀', () => {
  const special = {
    compute_develop_corehour: 10,
    compute_develop_desc: '核时加成',
    compute_develop_expire: '2030-01-01T00:00:00Z',
  };
  const d = settleCharge(QUOTA, VOLUME, special, Date.parse('2026-01-01T00:00:00Z')).devHours;
  assert.equal(d.bonus, 10);
  assert.equal(d.bonusDesc, '核时加成');
  assert.equal(d.total, 100);
});

test('接口全空时返回 null，不拿 0 冒充', () => {
  assert.equal(settleCharge(null, null, null), null);
  assert.equal(settleCharge({}, {}, {}, Date.now()), null);
});

test('保底线以下才提示，提示里带得出真实数字', () => {
  const c = settleCharge(
    { credit_in_milli: { total: 1000000 } },
    { credit_in_milli: 999000 },
  );
  // 还剩 0.1%：阈值 0.05% 时不提示，阈值 1% 时提示
  assert.equal(creditNotice(c, 0.05, 'alice | acme/gateway'), null);
  const notice = creditNotice(c, 1, 'alice | acme/gateway');
  assert.ok(notice);
  assert.match(notice, /alice \| acme\/gateway/);
  assert.match(notice, /仅剩 1 cr/); // 0.1% × 1000 cr = 1 cr
  assert.match(notice, /0\.10% 剩余/);
});

test('阈值 0 表示关闭提示', () => {
  const c = settleCharge({ credit_in_milli: { total: 1000 } }, { credit_in_milli: 1000 });
  assert.equal(creditNotice(c, 0), null);
});

test('数字显示：整数不拖 .0，小数留一位', () => {
  assert.equal(num1(0), '0');
  assert.equal(num1(1166), '1166');
  assert.equal(num1(364.94), '364.9');
});

// --- 选项 -------------------------------------------------------------------

test('巡检间隔不少于 30 秒，非法值回落默认', () => {
  assert.equal(normalizeOptions({ checkSeconds: 5 }).checkSeconds, 30);
  assert.equal(normalizeOptions({ checkSeconds: 'abc' }).checkSeconds, 120);
});

test('空闲停止：0 关掉，非 0 最少 5 分钟', () => {
  assert.equal(normalizeOptions({ idleStopMinutes: 0 }).idleStopMinutes, 0);
  assert.equal(normalizeOptions({ idleStopMinutes: 1 }).idleStopMinutes, 5);
  assert.equal(normalizeOptions({ idleStopMinutes: 30 }).idleStopMinutes, 30);
});

test('保底线夹在 0–100', () => {
  assert.equal(normalizeOptions({ creditFloorPercent: -5 }).creditFloorPercent, 0);
  assert.equal(normalizeOptions({ creditFloorPercent: 500 }).creditFloorPercent, 100);
  assert.equal(normalizeOptions({}).creditFloorPercent, 1);
});

test('autoStart 接受字符串 false', () => {
  assert.equal(normalizeOptions({ autoStart: 'false' }).autoStart, false);
  assert.equal(normalizeOptions({}).autoStart, true);
});

test('模型清单去重保序', () => {
  assert.deepEqual(modelIds('a, b,a ,c'), ['a', 'b', 'c']);
  assert.deepEqual(modelIds(''), []);
});

// --- 权限 -------------------------------------------------------------------

test('每个必需 scope 都写明了缺了会怎样', () => {
  for (const p of PERMISSIONS) {
    assert.ok(p.scope && p.label && p.missing, p.scope);
  }
});

test('能从 403 报文里读出缺的 scope', () => {
  assert.deepEqual(
    missingScopes('{"message":"Missing required scopes: repo-cnb-trigger:r, account-engage:r"}'),
    ['repo-cnb-trigger:r', 'account-engage:r'],
  );
  assert.deepEqual(missingScopes('nope'), []);
});

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}
