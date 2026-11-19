// 账号作用域的两条硬约束，都是踩过的坑（2026-11-20 那次 host 每 30 秒崩一次）。
//
// 1) refresh 不能 `return state`。state 是 Proxy，async 函数返回它之后，
//    await 那一侧会读 .then 判断"是不是 thenable"，而这次解包发生在账号
//    作用域之外 —— need() 抛错、未捕获异常、host 重启、再崩，循环。
// 2) 就算有人误 await，Proxy 也必须把 then 当"不存在"（非 Promise 对象如实回答）。
//
// 这两条只能靠源码形态来守：崩的是 Bun 的运行时行为，在 node 上复现不出来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, summary } from './_harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'index.mjs'), 'utf8');

eq((src.match(/return\s+state\s*;/g) || []).length, 0, '没有 return state（Proxy 不能当 thenable 返回）');

ok(/NOT_PROMISE\s*=\s*new Set\(\['then'/.test(src), 'Proxy 把 then 列为"不存在"');
eq(
  (src.match(/if \(NOT_PROMISE\.has\(p\)\) return undefined;/g) || []).length,
  2,
  'cfg 与 state 的 get trap 各有一处守卫',
);

// need() 的报错要带上读的是哪个字段，否则日志里只有一行"内部错误"，无法定位
ok(/function need\(where\)/.test(src), 'need 接受字段名用于报错');
ok(
  (src.match(/need\(`(?:cfg|state)\.\$\{String\(p\)\}`\)/g) || []).length >= 4,
  'Proxy 的 get/set 都把字段名传给 need',
);

summary();
