// 测试公用断言与假响应。
//
// 每个 *.test.mjs 都是独立进程（它们都会改写 globalThis.fetch），
// 所以计数放在模块实例里就够了，不需要跨进程汇总。

let pass = 0;
let fail = 0;

export const ok = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  PASS ${msg}`);
  } else {
    fail++;
    console.log(`  FAIL ${msg}`);
  }
};

export const eq = (actual, expected, msg) =>
  ok(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg} = ${JSON.stringify(actual)}`,
  );

export const json = (o, status = 200) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export const text = (t) => new Response(t, { status: 200 });

export const http = (status, body = '') => new Response(body, { status });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 取请求的 pathname，抹掉 host：假 CNB 只关心路径。
export const pathOf = (u0) => String(u0 instanceof Request ? u0.url : u0).replace(/^https?:\/\/[^/]+/, '');

// 打印结果并设置退出码。
//
// 插件会留后台巡检与启动等待的定时器（真实环境里是正常行为），
// 进程自然退出要等它们跑完；测试到这里已经有结论，直接收尾。
// 留 250ms 让 stdout 刷完，避免管道下输出被截断。
export const summary = () => {
  console.log(`\n结果：PASS ${pass} / FAIL ${fail}`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 250).unref();
};
