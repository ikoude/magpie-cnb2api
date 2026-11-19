// 依次跑完 test/*.test.mjs，每个文件一个独立进程。
//
// 为什么要分进程：每个测试都会替换 globalThis.fetch 并起插件实例，
// 同进程里跑会互相污染 mock，也会让「额度缓存」之类的状态串场。
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

if (!files.length) {
  console.log('没有找到 *.test.mjs');
  process.exit(1);
}

const results = [];
for (const file of files) {
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [path.join(dir, file)], {
    stdio: 'inherit',
    timeout: 180_000,
  });
  const okRun = r.status === 0;
  results.push({ file, okRun, status: r.status, signal: r.signal });
}

const failed = results.filter((r) => !r.okRun);
console.log(`\n${'='.repeat(60)}`);
for (const r of results) {
  const why = r.okRun
    ? 'PASS'
    : r.signal
      ? `FAIL (${r.signal})`
      : `FAIL (exit ${r.status})`;
  console.log(`  ${why.padEnd(14)} ${r.file}`);
}
console.log(`${'='.repeat(60)}`);
console.log(`${results.length - failed.length} / ${results.length} 个测试文件通过`);
process.exit(failed.length ? 1 : 0);
