// 插件行为测试：本地 mock 的 CNB OpenAPI + mock 的 cnb2api 网关，把钩子当真调用。
//
// 不连真实 CNB、不拉起真实工作区：这里验证的是插件的判断，不是 CNB 的行为。
// 每个用例用独立的插件实例与独立的 mock，避免账号上下文互相影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { Cnb2ApiPlugin } from '../index.mjs';

const TOKEN = 'nk-test-token-0123456789';
const PROXY_KEY = 'sk-proxy-key-test-0001';

// ---------------------------------------------------------------------------
// mock 世界
// ---------------------------------------------------------------------------

function makeWorld() {
  return {
    user: { id: 2120487622468358144, username: 'alice' },
    groups: [{ path: 'acme' }, { path: 'beta' }],
    repos: [{ path: 'alice/gateway' }, { path: 'acme/my-gateway' }],
    workspaces: [{ slug: 'acme/my-gateway', sn: 'cnb-1bbb-001', status: 'running' }],
    // 日志里打印的地址模板。测试可以把主机换成 mock 网关的地址。
    logUri: 'https://aaaa1111-{{port}}.cnb.run',
    quota: { credit_in_milli: { total: 1166000 }, dev_in_sec: { total: 360000 } },
    volume: { credit_in_milli: 4760, freeze_credit_in_milli: 2000, dev_in_sec: 18000 },
    special: { credit: 666, credit_desc: '赠送', credit_expire: '2030-12-31T00:00:00Z' },
    startCalls: 0,
    stopCalls: 0,
    lastBranch: '',
    chargeFails: false,
    // 网关是否在监听（模拟「刚启动、代理还没起来」）
    gatewayUp: true,
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startCnb(world) {
  return listen(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (o, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    const text = (s, code = 200) => {
      res.writeHead(code, { 'content-type': 'text/plain' });
      res.end(s);
    };

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json({ message: 'not logged in' }, 401);
    }
    if (world.chargeFails && p.includes('/-/charge/')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Missing required scopes: group-resource:r' }));
    }

    if (p === '/user') return json(world.user);
    if (p === '/user/groups') return json(world.groups);
    if (p === '/user/repos') return json(world.repos);

    if (p === '/workspace/list') {
      if (world.pendingStart) {
        world.pendingStart = false;
        for (const w of world.workspaces) w.status = 'running';
      }
      const slug = url.searchParams.get('slug');
      const list = slug ? world.workspaces.filter((w) => w.slug === slug) : world.workspaces;
      return json({ list });
    }
    if (p === '/workspace/stop') {
      world.stopCalls += 1;
      const body = JSON.parse((await readBody(req)) || '{}');
      for (const w of world.workspaces) if (w.sn === body.sn) w.status = 'stopped';
      return json({ ok: true });
    }
    if (p.endsWith('/-/workspace/start')) {
      world.startCalls += 1;
      world.lastBranch = JSON.parse((await readBody(req)) || '{}').branch;
      // 真实平台是异步的：提交后要几十秒才翻成 running。这里模拟成「提交后
      // 的下一分钟（第一次再查列表时）才看到 running」——由 pendingStart 控制，
      // 但状态确实会变，不会永远停在 stopped。
      world.pendingStart = true;
      return json({ ok: true });
    }

    const detail = p.match(/^\/([^/]+\/[^/]+)\/-\/workspace\/detail\/(.+)$/);
    if (detail) {
      // 控制台地址，不含 cnb.run —— 插件应当回退去读日志
      return json({ webide: `https://cnb.cool/${detail[1]}/-/workspace/vscode-web/${detail[2]}` });
    }
    const log = p.match(/^\/([^/]+\/[^/]+)\/-\/build\/runner\/download\/log\/(.+)$/);
    if (log) return text(`booting\nPROXY_URI=${world.logUri}\nready\n`);

    const charge = p.match(/^\/([^/]+)\/-\/charge\/(quota|volume|special-amount)$/);
    if (charge) return json(world[charge[2] === 'special-amount' ? 'special' : charge[2]]);

    if (/^\/[^/]+\/[^/]+$/.test(p)) return json({ path: p.slice(1) });
    return json({ message: 'no route ' + p }, 404);
  });
}

/** mock cnb2api 网关：/health + /v1/chat/completions。 */
async function startGateway(world) {
  const seen = [];
  const gw = await listen(async (req, res) => {
    if (!world.gatewayUp) {
      res.writeHead(503);
      return res.end('down for now');
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"status":"ok"}');
    }
    const body = JSON.parse((await readBody(req)) || '{}');
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${PROXY_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'bad key' } }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }));
  });
  return { ...gw, seen };
}

/**
 * 把 cnb.run 子域解析到 mock 网关：mock 环境的 .cnb.run 不可达，
 * 这里只是替换主机名，路径、鉴权、方法都不动。
 */
function routeCnbRunTo(gwUrl, t) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url;
    if (typeof url === 'string' && url.includes('.cnb.run')) {
      return realFetch(url.replace(/^https?:\/\/[^/]+/, gwUrl), init);
    }
    return realFetch(input, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

const account = (id, extra = {}) => ({
  type: 'api',
  key: PROXY_KEY,
  accountId: id,
  metadata: {
    token: TOKEN,
    proxyKey: PROXY_KEY,
    username: 'alice',
    org: 'acme',
    repo: 'acme/my-gateway',
    ...extra,
  },
});

const host = () => ({ app: { log: async () => {} } });

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

test('登录：逐步提问，身份是「用户名 | org/repo」，不含邮箱', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  const q1 = await method.ask({});
  assert.equal(q1.key, 'token');

  // sk- 开头会被点明是 PROXY_KEY，不等 CNB 回 401
  const q1b = await method.ask({ token: 'sk-wrong' });
  assert.equal(q1b.key, 'token');
  assert.match(q1b.message, /PROXY_KEY/);

  const q2 = await method.ask({ token: TOKEN });
  assert.equal(q2.key, 'org');
  assert.deepEqual(q2.options.map((o) => o.value).sort(), ['acme', 'beta'], '组织列表不含用户名');

  // 该组织下只有一个候选时用 select，让用户真的选一次（authorize 才拿得到 repo）
  const q3 = await method.ask({ token: TOKEN, org: 'acme' });
  assert.equal(q3.key, 'repo');
  assert.equal(q3.options[0].value, 'acme/my-gateway');

  const q4 = await method.ask({ token: TOKEN, org: 'acme', repo: 'acme/my-gateway' });
  assert.equal(q4.key, 'proxyKey');

  const res = await method.authorize({
    token: TOKEN,
    org: 'acme',
    repo: 'acme/my-gateway',
    proxyKey: PROXY_KEY,
  });
  assert.equal(res.type, 'success');
  assert.equal(res.accountId, 'alice | acme/my-gateway');
  assert.equal(res.key, PROXY_KEY);
  assert.equal(res.uid, String(world.user.id));
  // 身份不得使用邮箱
  assert.ok(!('email' in res.metadata));
  assert.ok(!JSON.stringify(res).includes('@cnb.cool'));
  assert.equal(res.metadata.username, 'alice');
});

test('添加多个账号不会被替换：身份存活于 magpie 的 save() 之后', async (t) => {
  const world = makeWorld();
  world.workspaces.push({ slug: 'beta/gateway', sn: 'cnb-2ccc-001', status: 'running' });
  world.repos.push({ path: 'beta/gateway' });
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const authorize = plugin.auth.methods[0].authorize;

  // 同一个人、同一个 PROXY_KEY、两个组织：最容易被引擎合并的情形
  const a = await authorize({ token: TOKEN, org: 'acme', repo: 'acme/my-gateway', proxyKey: PROXY_KEY });
  const b = await authorize({ token: TOKEN, org: 'beta', repo: 'beta/gateway', proxyKey: PROXY_KEY });
  assert.equal(a.type, 'success');
  assert.equal(b.type, 'success');
  assert.notEqual(a.accountId, b.accountId);
  assert.deepEqual([a.accountId, b.accountId], ['alice | acme/my-gateway', 'alice | beta/gateway']);

  // 忠实复刻 magpie runtime 的 save()：带 refresh 走 OAuth 分支，顶层字段保留；
  // api 分支会把 accountId 丢掉。再复刻 whoOf / settle 判断是不是同一个账号。
  const save = (r) => {
    let stored;
    if ('refresh' in r) {
      const { type: _t, provider: _p, refresh, access, expires, ...extra } = r;
      stored = { type: 'oauth', refresh, access, expires, ...extra };
    } else {
      stored = { type: 'api', key: r.key, metadata: r.metadata ?? {} };
    }
    return stored;
  };
  const whoOf = (x) => x?.accountId ?? x?.metadata?.email ?? x?.email ?? '';
  const secretOf = (x) => (x?.type === 'oauth' ? x.refresh ?? x.access ?? '' : x?.key ?? '');
  const wouldMerge = (now, was) => {
    const who = whoOf(now);
    const other = now.uid && was.uid && now.uid !== was.uid;
    return (who && whoOf(was) === who && !other)
      || (!who && !whoOf(was) && secretOf(now) && secretOf(now) === secretOf(was));
  };

  const sa = save(a);
  const sb = save(b);
  assert.equal(whoOf(sa), 'alice | acme/my-gateway', 'save 之后顶层 accountId 必须还在');
  assert.equal(whoOf(sb), 'alice | beta/gateway');
  assert.equal(wouldMerge(sb, sa), false, '两个组织必须共存，不能被 settle 替换');

  // 反证：如果走 api 分支（没有 refresh），身份丢失且会被按 PROXY_KEY 合并
  const apiA = save({ type: 'success', key: PROXY_KEY, accountId: a.accountId, metadata: a.metadata });
  const apiB = save({ type: 'success', key: PROXY_KEY, accountId: b.accountId, metadata: b.metadata });
  assert.equal(whoOf(apiB), '', 'api 分支确实会丢掉 accountId');
  assert.equal(wouldMerge(apiB, apiA), true, '这正是「被替换」的根因');
});

test('登录问答不会卡在仓库题：宿主只回传题目 key 的答案', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  // 完整模拟 magpie 的问答循环：每轮只把「题目 key → 用户答案」放进 inputs。
  // 仓库题用户留空（''），表示交给插件自动识别——这也是最容易死循环的情形。
  const inputs = {};
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const q = await method.ask(inputs);
    if (!q) break;
    seen.push(q.key);
    // 自定义标记绝不会被宿主带回来，这里也绝不塞进去
    inputs[q.key] = q.key === 'token' ? TOKEN
      : q.key === 'org' ? 'acme'
        : q.key === 'proxyKey' ? PROXY_KEY
          : ''; // repo 故意留空
  }
  assert.deepEqual(seen, ['token', 'org', 'repo', 'proxyKey']);
  assert.equal(Object.hasOwn(inputs, 'repo'), true);
  assert.equal(inputs.repo, '', '留空是合法答案，不该被当成没答');

  // 空仓库照样能登录：authorize 会把它留空，交给插件后面自动发现
  const res = await method.authorize(inputs);
  assert.equal(res.type, 'success');
  assert.equal(res.metadata.repo, undefined);
});

test('用量窗口名称带「已用/额度 cr」', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const u = await plugin.auth.usage(async () => account('alice | acme/my-gateway'));
  const credits = u.windows.find((w) => w.name.startsWith('AI credits'));
  assert.match(credits.name, /6\.8\/1166 cr/, JSON.stringify(credits.name));
});

test('自动识别不到时可手动选未确认仓库', async (t) => {
  const world = makeWorld();
  world.logUri = ''; // 日志里没有 PROXY_URI
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const q = await plugin.auth.methods[0].ask({ token: TOKEN, org: 'acme' });
  assert.equal(q.key, 'repo');
  const manual = q.options.find((o) => o.value === 'acme/my-gateway');
  assert.ok(manual, '未识别到的仓库仍可手动选');
  assert.match(manual.hint, /没识别到/);

  // 选它就能登录；地址仍由插件按 DSH 兼容口径继续尝试识别
  const res = await plugin.auth.methods[0].authorize({
    token: TOKEN, org: 'acme', repo: 'acme/my-gateway', proxyKey: PROXY_KEY,
  });
  assert.equal(res.type, 'success');
});

test('仓库名不叫 cnb2api 也能识别：以日志为准，不靠名字', async (t) => {
  const world = makeWorld();
  // 仓库名完全不带 cnb2api，但日志里有 PROXY_URI
  world.workspaces = [{ slug: 'alice/gateway', sn: 'cnb-3ddd-001', status: 'running' }];
  world.repos = [{ path: 'alice/gateway' }];
  world.groups = [];
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  // 组织只有一个时，选中它
  const orgQ = await method.ask({ token: TOKEN });
  assert.equal(orgQ.key, 'org');
  const repoQ = await method.ask({ token: TOKEN, org: 'alice' });
  assert.equal(repoQ.key, 'repo');
  assert.ok(repoQ.options.some((o) => o.value === 'alice/gateway'), JSON.stringify(repoQ.options));

  const res = await method.authorize({ token: TOKEN, org: 'alice', repo: 'alice/gateway', proxyKey: PROXY_KEY });
  assert.equal(res.type, 'success');
  assert.equal(res.accountId, 'alice | alice/gateway');
});

test('名字带 cnb2api 但日志没地址：标为未识别，让用户手动选', async (t) => {
  const world = makeWorld();
  world.workspaces = [{ slug: 'acme/cnb2api-fake', sn: 'cnb-4eee-001', status: 'running' }];
  world.repos = [{ path: 'acme/cnb2api-fake' }];
  world.logUri = ''; // 日志里没有地址
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const repoQ = await plugin.auth.methods[0].ask({ token: TOKEN, org: 'acme' });
  assert.equal(repoQ.key, 'repo');
  const fake = repoQ.options.find((o) => o.value === 'acme/cnb2api-fake');
  assert.ok(fake, '未识别到的仓库也要列出来供手动选择');
  assert.match(fake.hint, /没识别到/);
  assert.ok(repoQ.options.some((o) => o.value === ''), '留空选项仍在');
  assert.ok(repoQ.options.some((o) => String(o.value).startsWith('__reselect_org__')), '重选入口仍在');
});

test('只有一个组织时也显示额度', async (t) => {
  const world = makeWorld();
  world.groups = []; // 没有加入任何组织
  world.repos = [{ path: 'acme/my-gateway' }]; // 只有 acme 一个组织
  const cnb = await startCnb(world);
  t.after(() => cb_close());
  function cb_close(){ return cnb.close(); }
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const q = await plugin.auth.methods[0].ask({ token: TOKEN });
  assert.equal(q.key, 'org');
  assert.equal(q.options.length, 1);
  assert.match(q.options[0].label, /AI credits 已用 .*\/.* cr/, '单组织也要把额度显示出来');
});

test('「重新选组织」不会循环：换组织后正常进入仓库与密钥', async (t) => {
  const world = makeWorld();
  world.workspaces.push({ slug: 'beta/gateway', sn: 'cnb-2ccc-001', status: 'running' });
  world.repos.push({ path: 'beta/gateway' });
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  // 完整模拟宿主：inputs 只增不减，哨兵值一直留在 repo 里。
  const inputs = { token: TOKEN };

  let q = await method.ask(inputs);
  assert.equal(q.key, 'org');
  inputs.org = 'acme';

  q = await method.ask(inputs);
  assert.equal(q.key, 'repo');
  const back = q.options.find((o) => String(o.value).startsWith('__reselect_org__'));
  assert.ok(back, '仓库题要有重选入口');

  // 选「重新选组织」：必须回到组织题，而且用新的 key（org2）
  inputs.repo = back.value;
  q = await method.ask(inputs);
  assert.equal(q.key, 'org2', '选重选后应回到组织题');
  inputs.org2 = 'beta';

  // 组织已换：应进入仓库题，而不是又回到组织题
  q = await method.ask(inputs);
  assert.equal(q.key, 'repo', '重选组织后应进入仓库题');
  inputs.repo = 'beta/gateway';

  q = await method.ask(inputs);
  assert.equal(q.key, 'proxyKey');
  inputs.proxyKey = PROXY_KEY;
  q = await method.ask(inputs);
  assert.equal(q, null);

  const res = await method.authorize(inputs);
  assert.equal(res.type, 'success');
  assert.equal(res.accountId, 'alice | beta/gateway');
});

test('可以连续重选多次也不循环', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  const inputs = { token: TOKEN };
  let q = await method.ask(inputs);
  inputs.org = 'acme';              // org
  q = await method.ask(inputs);     // repo
  assert.equal(q.key, 'repo');

  // 第一次重选
  inputs.repo = q.options.find((o) => String(o.value).startsWith('__reselect_org__')).value;
  q = await method.ask(inputs);
  assert.equal(q.key, 'org2');
  inputs.org2 = 'beta';

  q = await method.ask(inputs);     // 又回到仓库
  assert.equal(q.key, 'repo');

  // 第二次重选
  inputs.repo = q.options.find((o) => String(o.value).startsWith('__reselect_org__')).value;
  q = await method.ask(inputs);
  assert.equal(q.key, 'org3', '第二次重选应问 org3，而不是循环回 org2');
  inputs.org3 = 'acme';
});

test('界面用同一份输入重绘时，不误跳过组织题', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];
  const inputs = { token: TOKEN, org: 'acme', repo: '__reselect_org__#0' };

  const a = await method.ask(inputs);
  const b = await method.ask(inputs); // 同输入再来一次（重绘）
  assert.equal(a.key, 'org2');
  assert.equal(b.key, 'org2', '重绘不该推进状态');
});

test('登录下拉显示组织额度，并可「重新选组织」', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const method = plugin.auth.methods[0];

  const orgQ = await method.ask({ token: TOKEN });
  assert.equal(orgQ.key, 'org');
  const acme = orgQ.options.find((o) => o.value === 'acme');
  assert.match(acme.label, /AI credits 已用 .*\/.* cr/, '额度写进组织选项名称');
  assert.ok(!acme.hint || !/AI credits/.test(acme.hint), '组织选项悬停不再重复额度');

  const repoQ = await method.ask({ token: TOKEN, org: 'acme' });
  const back = repoQ.options.find((o) => String(o.value).startsWith('__reselect_org__'));
  assert.ok(back, '仓库题要有「重新选组织」出口');
  assert.ok(!repoQ.options.some((o) => /AI credits/.test(o.hint || '')), '仓库列表不显示额度');

  // 选了「重新选组织」：下一轮回到组织题（新的组织 key），旧组织不再算已答
  const again = await method.ask({ token: TOKEN, org: 'acme', repo: '__reselect_org__#0' });
  assert.equal(again.key, 'org2');

  // 该导航值不能被当成仓库名落进账号
  const failed = await method.authorize({ token: TOKEN, org: 'acme', repo: '__reselect_org__', proxyKey: PROXY_KEY });
  assert.equal(failed.type, 'failed');
});

test('令牌无效时登录失败并给出人话，不留半个账号', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const res = await plugin.auth.methods[0].authorize({
    token: 'nk-expired',
    org: 'acme',
    repo: 'acme/my-gateway',
    proxyKey: PROXY_KEY,
  });
  assert.equal(res.type, 'failed');
  assert.match(res.error, /401|无效|过期/);
});

test('两栏填同一个值要当场拦下', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const res = await plugin.auth.methods[0].authorize({
    token: TOKEN,
    org: 'acme',
    repo: 'acme/my-gateway',
    proxyKey: TOKEN,
  });
  assert.equal(res.type, 'failed');
  assert.match(res.error, /同一个值/);
});

test('同一用户两个组织 → 两次登录得到两个不同账号', async (t) => {
  const world = makeWorld();
  world.workspaces.push({ slug: 'beta/gateway', sn: 'cnb-2ccc-001', status: 'running' });
  world.repos.push({ path: 'beta/gateway' });
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const authorize = plugin.auth.methods[0].authorize;

  const a = await authorize({ token: TOKEN, org: 'acme', repo: 'acme/my-gateway', proxyKey: PROXY_KEY });
  const b = await authorize({ token: TOKEN, org: 'beta', repo: 'beta/gateway', proxyKey: PROXY_KEY });
  assert.equal(a.type, 'success');
  assert.equal(b.type, 'success');
  assert.equal(a.accountId, 'alice | acme/my-gateway');
  assert.equal(b.accountId, 'alice | beta/gateway');
  // 仓库只属于它所在的那个组织
  assert.equal(a.metadata.org, 'acme');
  assert.equal(b.metadata.org, 'beta');
  assert.notEqual(a.metadata.repo, b.metadata.repo);
});


// ---------------------------------------------------------------------------
// 地址跟随
// ---------------------------------------------------------------------------

test('地址漂移：下次请求自动走新地址，不用重启 magpie', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  const gw = await startGateway(world);
  t.after(async () => {
    await cnb.close();
    await gw.close();
  });
  process.env.CNB_API = cnb.base;
  routeCnbRunTo(gw.base, t);

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const loaded = await plugin.auth.loader(async () => account('alice | acme/my-gateway'));
  assert.equal(loaded.baseURL, 'http://aaaa1111-9001.cnb.run/v1'.replace('http', 'https'));

  const call = () =>
    loaded.fetch(`${loaded.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'ping' }] }),
    });

  const first = await call();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices[0].message.content, 'pong');
  // 上游拿到的是 PROXY_KEY，不是 CNB 访问令牌
  assert.equal(gw.seen.at(-1).auth, `Bearer ${PROXY_KEY}`);

  // 平台重启了工作区：子域换了
  world.logUri = 'https://bbbb2222-{{port}}.cnb.run';
  const second = await call();
  assert.equal(second.status, 200);
  assert.equal(gw.seen.at(-1).auth, `Bearer ${PROXY_KEY}`);
});

test('工作区停了：自动拉起，并能等到新地址', { timeout: 60_000 }, async (t) => {
  const world = makeWorld();
  world.workspaces[0].status = 'stopped';
  const cnb = await startCnb(world);
  const gw = await startGateway(world);
  t.after(async () => {
    await cnb.close();
    await gw.close();
  });
  process.env.CNB_API = cnb.base;
  routeCnbRunTo(gw.base, t);

  const plugin = await Cnb2ApiPlugin({ client: host(), options: { branch: 'release' } });
  const loaded = await plugin.auth.loader(async () => account('alice | acme/my-gateway'));
  assert.equal(world.startCalls, 1, '停了就提交一次启动');
  assert.equal(world.lastBranch, 'release', '用配置里的分支启动');

  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 200);
});

test('地址还没起来时先返回可读原因，不往假域名上发', { timeout: 60_000 }, async (t) => {
  const world = makeWorld();
  world.gatewayUp = false;
  // 日志里没有 PROXY_URI：取不到地址
  world.logUri = '';
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: { autoStart: false } });
  const loaded = await plugin.auth.loader(async () => account('alice | acme/my-gateway'));
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /地址/);
});

test('上游 401 补一句人话，状态码保持 401', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  const gw = await startGateway(world);
  t.after(async () => {
    await cnb.close();
    await gw.close();
  });
  process.env.CNB_API = cnb.base;
  routeCnbRunTo(gw.base, t);

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const loaded = await plugin.auth.loader(async () =>
    account('alice | acme/my-gateway', { proxyKey: 'wrong-key' }),
  );
  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error.message, /PROXY_KEY/);
});

// ---------------------------------------------------------------------------
// 额度闸门
// ---------------------------------------------------------------------------

test('额度用尽：不提交启动，也不把请求挂满预算', { timeout: 60_000 }, async (t) => {
  const world = makeWorld();
  world.workspaces[0].status = 'stopped';
  world.quota = { credit_in_milli: { total: 0 }, dev_in_sec: { total: 0 } };
  world.volume = { credit_in_milli: 0 };
  world.special = {};
  const cnb = await startCnb(world);
  const gw = await startGateway(world);
  t.after(async () => {
    await cnb.close();
    await gw.close();
  });
  process.env.CNB_API = cnb.base;
  // 这条路径也要把 cnb.run 指到 mock 网关：否则会去连真实的 cnb.run
  routeCnbRunTo(gw.base, t);

  const plugin = await Cnb2ApiPlugin({ client: host(), options: { autoStart: true } });
  const started = Date.now();
  const loaded = await plugin.auth.loader(async () => account('alice | acme/my-gateway'));
  const took = Date.now() - started;

  assert.equal(world.startCalls, 0, '额度用尽时不该提交启动');
  assert.ok(took < 20_000, `不该把加载挂满 90 秒预算，实际 ${took}ms`);

  const res = await loaded.fetch(`${loaded.baseURL}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error.message, /额度|credits/i);
});

test('额度查不到时照常拉起：拦住能用的比放过注定失败更糟', { timeout: 60_000 }, async (t) => {
  const world = makeWorld();
  world.workspaces[0].status = 'stopped';
  world.chargeFails = true; // 缺 group-resource:r
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: { autoStart: true } });
  await plugin.auth.loader(async () => account('alice | acme/my-gateway'));
  assert.ok(world.startCalls >= 1, '查不到额度时应当照常提交启动');
});

// ---------------------------------------------------------------------------
// 用量与工具
// ---------------------------------------------------------------------------

test('用量面板：进度条用 已用 + 预扣，额度按组织分开', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const u = await plugin.auth.usage(async () => account('alice | acme/my-gateway'));

  // 账号名带上组织：同一个人在不同组织下是两个账号
  assert.equal(u.user, 'alice | acme/my-gateway');
  const credits = u.windows.find((w) => w.name.startsWith('AI credits'));
  assert.ok(credits, JSON.stringify(u.windows));
  assert.match(credits.name, /acme/, '窗口名写明是哪个组织的额度');
  // 4.76 + 2.0 cr，总额 1166
  assert.equal(credits.amount, 6.8);
  assert.equal(credits.limit, 1166);
  assert.equal(credits.unit, 'cr');
  assert.ok(credits.used > 0 && credits.used < 1);
});

test('额度查不到时写明原因，不拿 0 冒充', async (t) => {
  const world = makeWorld();
  world.chargeFails = true;
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const u = await plugin.auth.usage(async () => account('alice | acme/my-gateway'));
  assert.ok(u.error, '查不到时必须有原因');
  assert.match(u.error, /group-resource:r|额度/);
  assert.ok(!u.windows.some((w) => w.name.startsWith('AI credits')), '查不到就别画进度条');
});

test('工具：查额度、停工作区都按账号回答', async (t) => {
  const world = makeWorld();
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  await plugin.auth.usage(async () => account('alice | acme/my-gateway'));

  const quota = await plugin.tool.cnb2api_quota.execute({});
  assert.match(quota, /AI Credits/);
  assert.match(quota, /预扣/);

  const status = await plugin.tool.cnb2api_workspace_status.execute({});
  assert.match(status, /仓库：acme\/my-gateway/);

  const stop = await plugin.tool.cnb2api_workspace_stop.execute({});
  assert.match(stop, /已停止/);
  assert.equal(world.stopCalls, 1);
});

test('自动发现仓库只在账号所属组织内找', async (t) => {
  const world = makeWorld();
  // 两个组织各有一个跑着 cnb2api 的仓库
  world.workspaces = [
    { slug: 'beta/gateway', sn: 'cnb-b1', status: 'running' },
    { slug: 'acme/my-gateway', sn: 'cnb-a1', status: 'running' },
  ];
  const cnb = await startCnb(world);
  t.after(() => cnb.close());
  process.env.CNB_API = cnb.base;

  // 账号只带组织、不带仓库 → 触发自动发现
  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const loaded = await plugin.auth.loader(async () =>
    account('alice | @acme', { org: 'acme', repo: undefined }),
  );
  const status = await plugin.tool.cnb2api_workspace_status.execute({});
  assert.match(status, /仓库：acme\/my-gateway/, `应只发现 acme 的仓库，实际：${status}`);
  assert.ok(!/beta\//.test(status), '不能串到别的组织');
});

test('start 工具可用（不再引用未定义的 ctx）', { timeout: 60_000 }, async (t) => {
  const world = makeWorld();
  world.workspaces[0].status = 'stopped';
  const cnb = await startCnb(world);
  const gw = await startGateway(world);
  t.after(async () => { await cnb.close(); await gw.close(); });
  process.env.CNB_API = cnb.base;
  routeCnbRunTo(gw.base, t);

  const plugin = await Cnb2ApiPlugin({ client: host(), options: { autoStart: false } });
  await plugin.auth.usage(async () => account('alice | acme/my-gateway'));
  const out = await plugin.tool.cnb2api_workspace_start.execute({});
  assert.match(out, /已拉起|已提交拉起|已经在运行/);
  assert.equal(world.startCalls >= 1, true);
});

test('模型清单来自配置，带工具调用与上下文', async () => {
  const plugin = await Cnb2ApiPlugin({
    client: host(),
    options: { models: 'deepseek-v4.1-flash, another-model' },
  });
  const cfg = { provider: {} };
  await plugin.config(cfg);
  const p = cfg.provider.cnb2api;
  assert.deepEqual(Object.keys(p.models), ['deepseek-v4.1-flash', 'another-model']);
  assert.equal(p.models['deepseek-v4.1-flash'].tool_call, true);
  assert.equal(p.models['deepseek-v4.1-flash'].limit.context, 128000);

  const listed = await plugin.provider.models(p);
  assert.deepEqual(Object.keys(listed), ['deepseek-v4.1-flash', 'another-model']);
  assert.equal(listed['deepseek-v4.1-flash'].id, 'deepseek-v4.1-flash');
});

test('config 不覆盖用户在 plugins.json 里写的供应商', async () => {
  const plugin = await Cnb2ApiPlugin({ client: host(), options: {} });
  const mine = { name: 'Mine', npm: '@ai-sdk/openai', api: 'https://x/v1', models: {} };
  const cfg = { provider: { cnb2api: mine } };
  await plugin.config(cfg);
  assert.equal(cfg.provider.cnb2api, mine);
});
