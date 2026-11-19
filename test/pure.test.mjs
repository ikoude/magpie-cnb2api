// 纯函数层：额度配平、特权解析、地址打码。不需要 mock 网络，也不起插件。
import { _internal as I } from '../index.mjs';
import { ok, eq, summary } from './_harness.mjs';

// 1) 常规：1000 cr 总额、用掉 250
const a = I.bucket(1000, 250, 0, null, 1000);
eq([a.total, a.used, a.remain, a.base, a.bonus], [1, 0.25, 0.75, 1, null], '无特权的配平');
eq(Math.round(a.usedPct), 25, '已用率');

// 2) 特权：总额 1666 里含 666 赠送 → 基础额度 1000，余额不重复扣
const bonus = I.specialOf({ credit: 666, credit_desc: '赠送', credit_expire: '2099-01-01' }, 'credit', 1);
const b = I.bucket(1666000, 0, 0, bonus, 1000);
eq([b.total, b.bonus, b.base, b.remain], [1666, 666, 1000, 1666], '含特权的配平');

// 3) 冻结也算占用；超支时余额夹到 0，不出现负数
const c = I.bucket(1000, 900, 200, null, 1000);
eq([c.frozen, c.remain, Math.round(c.usedFrozenPct)], [0.2, 0, 110], '冻结与超支');

// 4) 已用量没拿到：used / usedPct 为 null，但总额和余额照给
const d = I.bucket(1000, null, 0, null, 1000);
eq([d.used, d.usedPct, d.remain], [null, null, 1], '已用量缺失');

// 5) 总额没拿到 → null，面板不显示这一项
ok(I.bucket(null, 1, 0, null, 1000) === null, '总额缺失返回 null');

// 6) 核时用 3600 换算
const e = I.bucket(7200, 3600, 0, null, 3600);
eq([e.total, e.used, e.remain], [2, 1, 1], '核时换算');

// 7) 特权过期要标出来，不能还写 +666
const old = I.specialOf({ credit: 666, credit_expire: '2020-01-01' }, 'credit', 1, null, Date.parse('2026-01-01'));
ok(old.expired === true, '过期特权被识别');
ok(/已过期/.test(I.bonusPart(old.amount, old.desc, old.expire, old.expired)), '过期文案');
ok(/有效期至/.test(I.bonusPart(6, null, '2099-01-01', false)), '未过期文案');
eq(I.bonusPart(null, null, null, false), '', '没有特权就不显示');

// 8) 9999 年当作永不过期
const forever = I.specialOf({ credit: 6, credit_expire: '9999-12-31' }, 'credit', 1);
ok(forever.expire === null && forever.expired === false, '9999 视为无期限');

// 9) 地址打码：保留前 4 位与端口域名
eq(I.maskHost('860lo2zlkf-9001.cnb.run'), '860l****-9001.cnb.run', 'cnb.run 打码');
eq(I.maskHost('example.com'), 'exam****.com', '普通域名打码');
eq(I.maskHost(''), '', '空地址');

// 10) 从日志里取地址：{{port}} 要换成真实端口，带引号也要认
eq(I.pickUriFromLog('PROXY_URI=https://ab12-{{port}}.cnb.run'), 'https://ab12-9001.cnb.run', '日志取地址');
eq(I.pickUriFromLog('noise\nPROXY_URI="https://cd34-{{port}}.cnb.run"\nmore'), 'https://cd34-9001.cnb.run', '日志取地址（带引号）');
// 热重启会打印多条，最后一条才有效
eq(
  I.pickUriFromLog('PROXY_URI=https://old1-{{port}}.cnb.run\nPROXY_URI=https://new2-{{port}}.cnb.run'),
  'https://new2-9001.cnb.run',
  '多条时取最后一条',
);
ok(I.pickUriFromLog('') === null, '日志没有 PROXY_URI 时返回 null');
ok(I.pickUriFromLog('PROXY_URI=not-a-url') === null, '非法地址不返回');

// 11) 仓库名归一：各种粘贴形态都要收敛到 org/repo
eq(I.normalizeRepo('acme/gateway'), 'acme/gateway', '完整仓库名原样');
eq(I.normalizeRepo('https://cnb.cool/acme/gateway/-/tree/main'), 'acme/gateway', '仓库页面地址');
eq(I.normalizeRepo('git@cnb.cool:acme/gateway.git'), 'acme/gateway', 'ssh 地址');
eq(I.normalizeRepo('/acme/gateway'), 'acme/gateway', '前导斜杠');
eq(I.normalizeRepo('gateway'), 'gateway', '只写名字时原样返回');
eq(I.normalizeRepo(''), '', '空值仍为空');

summary();
