// 清理脚本的「同组织多账号」检测：只报告，不动活账号。
//
// 账号名格式换过一次（用户+组织 → 用户 | 组织/仓库），升级后重新登录会在
// plugin-auth.json 里留下两条指向同一组织的记录。这个测试固定住三件事：
// 能识别、不误伤不同用户、--apply 不碰账号表。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, summary } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, '..', 'tools', 'magpie-prune.mjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));

const acct = (email, org, repo) => ({
  type: 'api',
  key: 'sk-x',
  metadata: { token: 't', proxyKey: 'sk-x', username: 'alice', email, org, repo },
});

const AUTH = {
  // 当前格式
  cnb2api: acct('alice | acme/gateway@cnb.cool', 'acme', 'acme/gateway'),
  // 旧格式，同一用户同一组织 —— 应该被合并成一组
  'cnb2api#oldfmt': acct('alice+acme@cnb.cool', 'acme', 'acme/gateway'),
  // 同组织不同用户 —— 合法的多人协作，不该告警
  'cnb2api#bob': acct('bob | acme/gateway@cnb.cool', 'acme', 'acme/gateway'),
  // 只有用户名 —— 没有组织信息，无法归组，也不该和上面的混在一起
  'cnb2api#plain': acct('alice@cnb.cool', '', ''),
};

fs.writeFileSync(path.join(home, 'plugin-auth.json'), JSON.stringify(AUTH, null, 2));
fs.writeFileSync(
  path.join(home, 'quotas.json'),
  JSON.stringify({ 'cnb2api/gone@cnb.cool': { at: '2026-01-01T00:00:00Z' } }, null, 2),
);

const run = (args) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MAGPIE_HOME: home },
  });

// ---------- --json ----------
const asJson = run(['--json']);
const data = JSON.parse(asJson.stdout);

eq(data.siblings.length, 1, '同组织账号只报 1 组');
eq(data.siblings[0].length, 2, '该组含 2 条账号');
eq(data.siblings[0][0].org, 'acme', '组内组织');

const formats = data.siblings[0].map((a) => a.format).sort();
ok(formats.some((f) => f === '当前格式'), '识别出新格式');
ok(formats.some((f) => f.includes('加号')), '识别出旧格式');
ok(
  !data.siblings[0].some((a) => a.email.startsWith('bob')),
  '同组织的另一个用户没有被并进来',
);
eq(data.findings.length, 1, '孤儿额度快照同时被找出来');

// ---------- 文本输出 ----------
const asText = run([]);
ok(asText.stdout.includes('同一组织存在多个账号标识'), '文本输出带告警标题');
ok(asText.stdout.includes('alice+acme@cnb.cool'), '告警列出旧格式账号');
ok(asText.stdout.includes('--apply 不会动这些条目'), '说明 apply 的行为');

// ---------- --apply 不动账号表 ----------
const before = fs.readFileSync(path.join(home, 'plugin-auth.json'), 'utf8');
run(['--apply', '--force']);
const after = fs.readFileSync(path.join(home, 'plugin-auth.json'), 'utf8');
ok(after === before, 'apply 之后账号表逐字节不变');

const quotas = JSON.parse(fs.readFileSync(path.join(home, 'quotas.json'), 'utf8'));
ok(!('cnb2api/gone@cnb.cool' in quotas), 'apply 清掉了孤儿额度快照');

fs.rmSync(home, { recursive: true, force: true });
summary();
