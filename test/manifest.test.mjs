// 清单与图标的一致性：宿主只读 package.json 里的 base64 图标，icon.svg 不会被加载。
// 两者是同一张图的两份拷贝，改图标时容易只改一处，所以在 CI 里盯着。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ok, eq, summary } from './_harness.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const svg = readFileSync(path.join(root, 'icon.svg'), 'utf8');

console.log('\n[1] package.json 与宿主要求的字段');
{
  ok(pkg.type === 'module', `ESM 模块，实际 ${pkg.type}`);
  eq(pkg.main, './index.mjs', '入口就是插件本体');
  ok(!!pkg.magpie?.name, '宿主用 magpie.name 显示供应商名');
  ok(!!pkg.magpie?.summary?.zh && !!pkg.magpie?.summary?.en, '中英摘要都在');
  ok(pkg.engines?.node === '>=20', 'Node 版本下限写清楚');
}

console.log('\n[2] 图标：内嵌 base64 必须与 icon.svg 同图');
{
  const icon = pkg.magpie?.icon || '';
  ok(icon.startsWith('data:image/svg+xml;base64,'), '图标是内嵌 data URI');
  const inline = Buffer.from(icon.split(',')[1] || '', 'base64').toString('utf8');
  ok(inline.trim() === svg.trim(), 'icon.svg 与 magpie.icon 一致（改图标要两处同步）');
}

console.log('\n[3] 发布范围：测试不进包，运行时要进');
{
  const files = pkg.files || [];
  ok(files.includes('index.mjs'), '本体在发布列表里');
  ok(files.includes('tools/'), '清理脚本随包发布（bin 指向它）');
  ok(!files.some((f) => f.startsWith('test')), 'test/ 不进 npm 包');
  ok(!files.some((f) => f.startsWith('.github')), '.github/ 不进包');
}

console.log('\n[4] bin 指向的文件存在');
{
  const bin = pkg.bin?.['magpie-cnb2api-prune'];
  ok(!!bin, 'bin 里暴露了清理脚本');
  ok(readFileSync(path.join(root, bin), 'utf8').startsWith('#!'), `${bin} 有 shebang，能直接执行`);
}

summary();
