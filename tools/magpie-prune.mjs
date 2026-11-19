#!/usr/bin/env node
// 清理 magpie 里属于 cnb2api、但账号已经不存在的缓存条目。
//
// 背景：magpie 把这些东西按「账号名」当键存在 ~/.config/magpie 下，
// 账号被移除（或账号名变过）之后，旧键不会被回收：
//
//   quotas.json         cnb2api/<账号>        最后一次额度快照
//   quota-history.json  cnb2api|<账号>        额度历史曲线
//   served.json         plugin@<账号>         这个账号上次服务过谁（分派用）
//   affinity.json       who = cnb2api@<账号>  会话与账号的亲和关系
//   logins.json         agent = plugin:cnb2api 登录卡片
//
// 这些残留会让面板上出现已经不存在的账号、或者已删账号还在显示旧额度。
// 本脚本只删「确定属于 cnb2api 且账号已不存在」的条目，别的 provider 一律不碰。
//
// 用法：
//   node tools/magpie-prune.mjs            # 只列出会删什么（默认）
//   node tools/magpie-prune.mjs --apply    # 真删（先备份，magpie 必须没在跑）
//   node tools/magpie-prune.mjs --json     # 机器可读
//
// 改的是 magpie 自己的数据目录，magpie 运行时会在内存里持有同一份数据并
// 随时回写，所以运行中改会被覆盖 —— 脚本会先检查进程，运行中直接拒绝。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const FORCE = argv.includes('--force');
const JSON_OUT = argv.includes('--json');
const PROVIDER = (() => {
  const i = argv.indexOf('--provider');
  return i >= 0 && argv[i + 1] ? argv[i + 1] : 'cnb2api';
})();

// ---------- 找 magpie 的数据目录 ----------
function findMagpieDir() {
  if (process.env.MAGPIE_HOME) return process.env.MAGPIE_HOME;
  const home = os.homedir();
  const cands = [
    path.join(home, '.config', 'magpie'),
    path.join(home, 'Library', 'Application Support', 'magpie'),
    path.join(home, '.magpie'),
  ];
  for (const d of cands) {
    if (fs.existsSync(path.join(d, 'plugin-auth.json')) || fs.existsSync(path.join(d, 'plugins.json'))) return d;
  }
  return cands[0];
}

const DIR = findMagpieDir();

function readJson(name) {
  const p = path.join(DIR, name);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`${name} 读不了（${e.message}），先手动看下这个文件`);
  }
}

// ---------- 现在还有哪些账号 ----------
// 账号的唯一身份是 plugin-auth.json 里的 metadata.email：
// 形如 "用户 | 组织/仓库@cnb.cool"。额度、登录卡片、分派缓存全都以它为键。
const auth = readJson('plugin-auth.json') || {};
const live = new Map();            // email(小写) → 可读名
for (const [k, v] of Object.entries(auth)) {
  if (!k.startsWith(PROVIDER)) continue;          // cnb2api 或 cnb2api#hash
  const meta = v?.metadata || {};
  const email = String(meta.email || '').trim();
  if (!email) continue;
  const name = email.replace(/@cnb\.cool$/i, '');
  live.set(email.toLowerCase(), name);
}

const isLive = (s) => live.has(String(s || '').trim().toLowerCase());

// cnb.cool 域只可能是这个插件的账号；用它当判据，避免误删别的 provider
const looksOurs = (s) => /@cnb\.cool$/i.test(String(s || '').trim());

// ---------- 逐文件找孤儿 ----------
const findings = [];   // { file, key, label, last, why }

function note(file, key, label, last, why) {
  findings.push({ file, key, label, last: last || '', why });
}

// 1. quotas.json —— 键 "cnb2api/<账号>"
{
  const d = readJson('quotas.json');
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith(`${PROVIDER}/`)) continue;
      const label = k.slice(PROVIDER.length + 1);
      if (isLive(label)) continue;
      note('quotas.json', k, label, v?.at, label.includes('api key') ? '账号没有名字，只剩键尾' : '账号已不存在');
    }
  }
}

// 2. quota-history.json —— 键 "cnb2api|<账号>"
{
  const d = readJson('quota-history.json');
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith(`${PROVIDER}|`)) continue;
      const label = k.slice(PROVIDER.length + 1);
      if (isLive(label)) continue;
      const times = Object.values(v || {}).flat().map((x) => x?.at).filter(Boolean).sort();
      note('quota-history.json', k, label, times.at(-1), '额度历史，账号已不存在');
    }
  }
}

// 3. served.json —— 键 "plugin@<账号>"
{
  const d = readJson('served.json');
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (!k.startsWith('plugin@')) continue;
      const label = k.slice('plugin@'.length);
      if (!looksOurs(label) || isLive(label)) continue;
      note('served.json', k, label, typeof v === 'string' ? v : v?.at, '账号已不存在');
    }
  }
}

// 4. affinity.json —— 值里的 who 是 "cnb2api@<账号>"
{
  const d = readJson('affinity.json');
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      const who = String(v?.who || '').trim();
      if (!who.startsWith(`${PROVIDER}@`)) continue;
      const label = who.slice(PROVIDER.length + 1);
      if (isLive(label)) continue;
      note('affinity.json', k, label, v?.at, '会话亲和指向已删账号');
    }
  }
}

// 5. logins.json —— 数组，agent 是 "plugin:cnb2api"
{
  const d = readJson('logins.json');
  if (Array.isArray(d)) {
    for (const it of d) {
      if (it?.agent !== `plugin:${PROVIDER}`) continue;
      const label = String(it?.user || '');
      if (isLive(label)) continue;
      note('logins.json', `${it?.id || ''} ${label}`.trim(), label, it?.seen, '登录卡片，账号已不存在');
    }
  }
}

// 6. providers.json —— 每个账号一份「名字 / 模型勾选」，卸载插件时会整块
//    挪进 pluginLeft，重装再原样搬回来，所以旧账号名会跟着回来。
{
  const d = readJson('providers.json');
  const squeeze = (prov, where) => {
    for (const field of ['accountNames', 'accountModels']) {
      const m = prov?.[field];
      if (!m || typeof m !== 'object') continue;
      for (const k of Object.keys(m)) {
        if (isLive(k)) continue;
        note('providers.json', `${where}${field}.${k}`, k, '', '账号已不存在，名字/模型勾选残留');
      }
    }
  };
  for (const p of (Array.isArray(d?.providers) ? d.providers : [])) {
    if (p?.id === PROVIDER) squeeze(p, 'providers.');
  }
  for (const it of (Array.isArray(d?.pluginLeft) ? d.pluginLeft : [])) {
    if (it?.provider?.id === PROVIDER) squeeze(it.provider, 'pluginLeft.');
  }
}

// 7. plugin-providers.json —— 面板用的 provider 快照，里面也带着账号列表
{
  const d = readJson('plugin-providers.json');
  if (Array.isArray(d)) {
    for (const prov of d) {
      if (prov?.id !== PROVIDER) continue;
      for (const a of (Array.isArray(prov.accounts) ? prov.accounts : [])) {
        const key = String(a?.accountId || a?.email || '').trim();
        if (!key || isLive(key)) continue;
        note('plugin-providers.json', `accounts.${key}`, key, '', 'provider 快照里的账号已不存在');
      }
    }
  }
}

// ---------- 同一组织的多个账号标识 ----------
// 账号名格式改过两次：早期「用户@cnb.cool」，后来「用户+组织@cnb.cool」，
// 现在是「用户 | 组织/仓库@cnb.cool」。格式一变，同一个组织就会在
// plugin-auth.json 里多留一条：两条都是活账号、额度各算一份。
// 它们不是孤儿（删掉要重登），所以只报告，不进 findings、--apply 不碰。
const shapeOf = (email) => {
  const s = String(email || '').trim();
  const cur = /^(.+?)\s\|\s*([^/|]+)\/([^@|]+)@cnb\.cool$/i.exec(s);
  if (cur) return { user: cur[1].trim(), org: cur[2].trim(), format: '当前格式' };
  const plus = /^([^+|]+)\+([^@|]+)@cnb\.cool$/i.exec(s);
  if (plus) return { user: plus[1].trim(), org: plus[2].trim(), format: '旧格式（加号拼组织）' };
  const plain = /^([^@|+]+)@cnb\.cool$/i.exec(s);
  if (plain) return { user: plain[1].trim(), org: '', format: '旧格式（只有用户）' };
  return { user: s.toLowerCase(), org: '', format: '无法识别' };
};

const byOrg = new Map();          // "用户|组织"（小写） → [{ key, email, org, format }]
for (const [k, v] of Object.entries(auth)) {
  if (!k.startsWith(PROVIDER)) continue;
  const email = String(v?.metadata?.email || '').trim();
  if (!email) continue;
  const s = shapeOf(email);
  const id = `${s.user.toLowerCase()}|${s.org.toLowerCase()}`;
  if (!byOrg.has(id)) byOrg.set(id, []);
  byOrg.get(id).push({ key: k, email, org: s.org, format: s.format });
}
const siblings = [...byOrg.values()].filter((g) => g.length > 1);

// ---------- 输出 ----------
if (JSON_OUT) {
  console.log(JSON.stringify({ dir: DIR, apply: APPLY, live: [...live.values()], findings, siblings }, null, 2));
} else {
  console.log(`magpie 数据目录：${DIR}`);
  console.log(`仍在的 ${PROVIDER} 账号 ${live.size} 个：${[...live.values()].join('、') || '（无）'}`);
  console.log('');
  if (!findings.length) {
    console.log('没有需要清理的条目。');
  } else {
    const byFile = new Map();
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, []);
      byFile.get(f.file).push(f);
    }
    for (const [file, list] of byFile) {
      console.log(`${file}  ${list.length} 条`);
      for (const f of list) {
        const last = f.last ? `  最后活跃 ${String(f.last).replace('T', ' ').slice(0, 19)}` : '';
        console.log(`  · ${f.label || f.key}${last}   — ${f.why}`);
      }
      console.log('');
    }
    console.log(`共 ${findings.length} 条孤儿缓存。`);
  }

  if (siblings.length) {
    console.log('');
    console.log(`⚠ 同一组织存在多个账号标识：${siblings.length} 组`);
    for (const g of siblings) {
      console.log(`  组织 ${g[0].org || '（未识别）'}`);
      for (const a of g) {
        console.log(`    · ${a.email}   [${a.format}]   ${a.key}`);
      }
    }
    console.log('');
    console.log('  都属于同一组织，额度会被算成两份、面板上出现两个同名账号。');
    console.log('  处理办法：在面板里删掉旧格式那个账号，再登录一次（旧额度历史可用本脚本清理）。');
    console.log('  注意 --apply 不会动这些条目：它们是活账号，删了需要重新登录。');
  }
}

if (!APPLY) {
  if (!JSON_OUT) {
    if (findings.length) {
      console.log('');
      console.log('这只是预览。确认无误后加 --apply 执行（会先备份，且 magpie 必须在退出状态）。');
    }
    if (siblings.length && !findings.length) {
      console.log('');
      console.log('没有可自动清理的条目：上面的账号都还在用，需要你在面板里手动处理。');
    }
  }
  process.exit(0);
}

// ---------- 执行 ----------
if (!findings.length) process.exit(0);

function magpieRunning() {
  try {
    const out = execSync('pgrep -fl magpie 2>/dev/null || true', { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).some((l) => {
      if (/magpie-prune/.test(l)) return false;
      return /magpie\.app\/Contents\/MacOS\/magpie/.test(l) || /(^|\/)magpie-bun\b/.test(l) || /(^|\/)magpie-tui\b/.test(l);
    });
  } catch {
    return false;
  }
}

if (magpieRunning() && !FORCE) {
  console.error('');
  console.error('magpie 正在运行：它内存里拿着同一份数据，现在改会被它回写覆盖。');
  console.error('先退出 magpie（菜单栏图标 → 退出），再跑一次；确实要硬来加 --force。');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const touched = new Set(findings.map((f) => f.file));

function backup(file) {
  const src = path.join(DIR, file);
  const dst = path.join(DIR, `${file}.prune-${stamp}.bak`);
  fs.copyFileSync(src, dst);
  return dst;
}

for (const file of touched) {
  const p = path.join(DIR, file);
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  backup(file);
  const mine = findings.filter((f) => f.file === file);

  if (file === 'logins.json') {
    const dead = new Set(mine.map((f) => f.label));
    const kept = d.filter((it) => !(it?.agent === `plugin:${PROVIDER}` && dead.has(String(it?.user || ''))));
    fs.writeFileSync(p, JSON.stringify(kept, null, 2));
  } else if (file === 'providers.json') {
    const dead = new Set(mine.map((f) => f.label));
    const squeeze = (prov) => {
      for (const field of ['accountNames', 'accountModels']) {
        if (!prov?.[field] || typeof prov[field] !== 'object') continue;
        for (const k of Object.keys(prov[field])) if (dead.has(k)) delete prov[field][k];
      }
    };
    for (const prov of (Array.isArray(d.providers) ? d.providers : [])) {
      if (prov?.id === PROVIDER) squeeze(prov);
    }
    for (const it of (Array.isArray(d.pluginLeft) ? d.pluginLeft : [])) {
      if (it?.provider?.id === PROVIDER) squeeze(it.provider);
    }
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  } else if (file === 'plugin-providers.json') {
    const dead = new Set(mine.map((f) => f.label));
    for (const prov of d) {
      if (prov?.id !== PROVIDER || !Array.isArray(prov.accounts)) continue;
      prov.accounts = prov.accounts.filter((a) => !dead.has(String(a?.accountId || a?.email || '').trim()));
    }
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  } else {
    // quotas / quota-history / served / affinity：键就是条目本身
    const deadKeys = new Set(mine.map((f) => f.key));
    for (const k of deadKeys) delete d[k];
    fs.writeFileSync(p, JSON.stringify(d, null, 2));
  }
  console.log(`已清理 ${file}（${mine.length} 条，备份 ${file}.prune-${stamp}.bak）`);
}

console.log(`完成：删掉 ${findings.length} 条，涉及 ${touched.size} 个文件。重启 magpie 生效。`);
