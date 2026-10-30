import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPaused, isRunRequested, writeScheduler } from "./control.js";
import { startWeb, type WebServer } from "./web.js";

const password = "correct-password";
const now = new Date("2026-10-30T03:00:00.000Z");

test("错误口令不能进入，连续失败会暂时拦住", async () => {
  const started = await boot(sampleDir());
  try {
    const wrong = await postLogin(started, "wrong-password-xx");
    assert.equal(wrong.status, 401);
    assert.match(wrong.text, /口令不对/);
    assert.equal(wrong.cookie, "");
    for (let i = 0; i < 7; i += 1) {
      const again = await postLogin(started, "wrong-password-xx");
      assert.equal(again.status, 401);
    }
    const blocked = await postLogin(started, password);
    assert.equal(blocked.status, 429);
    assert.match(blocked.text, /尝试过多/);
  } finally {
    await started.close();
  }
});

test("登录后可以看概览，三个按钮写到控制文件", async () => {
  const data = sampleDir();
  mkdirSync(join(data, "logs"));
  const logPath = join(data, "logs", "round.log");
  writeFileSync(logPath, "2026-10-30T03:00:00.000Z [-] 汇总：总数 1，跳过 1，成功 0，失败 0\n", "utf8");
  writeFileSync(join(data, "secret.txt"), "SECRETPEM\n", "utf8");
  writeFileSync(
    join(data, "status.json"),
    JSON.stringify({
      serverName: "origin-a",
      startedAt: "2026-10-30T02:00:00.000Z",
      finishedAt: "2026-10-30T02:01:00.000Z",
      exitCode: 0,
      logPath,
      jobs: [
        {
          id: "www-example",
          status: "skipped",
          notAfter: "2027-01-08T00:00:00.000Z",
          nginx: [{ path: "/www/server/panel/vhost/cert/example.com/fullchain.pem", nginxTest: "passed", nginxReload: "passed", ok: true }],
        },
      ],
    }),
    "utf8",
  );
  const started = await boot(data);
  try {
    const anon = await fetch(`${started.base}/api/overview`);
    assert.equal(anon.status, 401);
    const anonPause = await fetch(`${started.base}/api/pause`, { method: "POST" });
    assert.equal(anonPause.status, 401);

    const loggedIn = await postLogin(started, password);
    assert.equal(loggedIn.status, 303);
    assert.match(loggedIn.cookie, /^acme_web=/);
    const page = await fetch(`${started.base}/`, { headers: { cookie: loggedIn.cookie } });
    const html = await page.text();
    assert.match(html, /立即检查/);
    assert.match(html, /暂停定时检查/);
    assert.match(html, /最近日志/);
    assert.equal(html.includes("SECRETPEM"), false);
    const csrf = /name="csrf-token" content="([a-f0-9]+)"/.exec(html)?.[1] ?? "";
    assert.equal(csrf.length > 0, true);

    const missing = await fetch(`${started.base}/api/pause`, { method: "POST", headers: { cookie: loggedIn.cookie } });
    assert.equal(missing.status, 403);

    const overview = await fetch(`${started.base}/api/overview`, { headers: { cookie: loggedIn.cookie } });
    const view = await overview.json() as { server: { serverName: string; jobs: Array<{ id: string; status: string }> }; log: { lines: string[] } };
    assert.equal(view.server.serverName, "origin-a");
    assert.equal(view.server.jobs[0].id, "www-example");
    assert.equal(view.server.jobs[0].status, "skipped");
    assert.equal(view.log.lines.length, 1);
    assert.equal(JSON.stringify(view).includes("SECRETPEM"), false);

    const headers = { cookie: loggedIn.cookie, "x-csrf-token": csrf };
    const paused = await postJson(started, "/api/pause", headers);
    assert.equal(paused.message, "已暂停定时检查");
    assert.equal(isPaused(data), true);
    const pausedAgain = await postJson(started, "/api/pause", headers);
    assert.equal(pausedAgain.message, "已暂停定时检查");

    const run = await postJson(started, "/api/run", headers);
    assert.equal(run.message, "已请求。调度进程起来后才会执行");
    assert.equal(isRunRequested(data), true);
    const runAgain = await postJson(started, "/api/run", headers);
    assert.equal(runAgain.message, "已经记下");

    writeScheduler(data, {
      updatedAt: now.toISOString(),
      state: "running",
      paused: true,
      nextRunAt: null,
      runPending: true,
    });
    const resume = await postJson(started, "/api/resume", headers);
    assert.equal(resume.message, "已恢复定时检查");
    assert.equal(isPaused(data), false);
  } finally {
    await started.close();
  }
});

test("调度正在检查时，暂停和再跑一轮用另一句提示", async () => {
  const data = sampleDir();
  writeScheduler(data, {
    updatedAt: now.toISOString(),
    state: "running",
    paused: false,
    nextRunAt: "2026-10-30T07:00:00.000Z",
    runPending: false,
  });
  const started = await boot(data);
  try {
    const loggedIn = await postLogin(started, password);
    const page = await fetch(`${started.base}/`, { headers: { cookie: loggedIn.cookie } });
    const csrf = /name="csrf-token" content="([a-f0-9]+)"/.exec(await page.text())?.[1] ?? "";
    const headers = { cookie: loggedIn.cookie, "x-csrf-token": csrf };
    const paused = await postJson(started, "/api/pause", headers);
    assert.equal(paused.message, "暂停已记下，当前这轮会跑完");
    const run = await postJson(started, "/api/run", headers);
    assert.equal(run.message, "已记下，这一轮结束后再跑一轮");
  } finally {
    await started.close();
  }
});

function sampleDir(): string {
  const data = mkdtempSync(join(tmpdir(), "web-"));
  writeFileSync(
    join(data, "config.yaml"),
    `serverName: origin-a
letsencrypt:
  email: ops@example.com
jobs:
  - id: www-example
    domains: [example.com, www.example.com]
    challenge:
      type: dns-01
      zone: example.com
    apply:
      - type: nginx
        kind: baota
        certDir: /www/server/panel/vhost/cert/example.com
      - type: aliyun-cdn
        domainNames: [www.example.com]
`,
    "utf8",
  );
  return data;
}

async function boot(dataDir: string): Promise<WebServer & { base: string }> {
  const started = await startWeb({
    dataDir,
    configPath: join(dataDir, "config.yaml"),
    password,
    host: "127.0.0.1",
    port: 0,
    secureCookie: false,
    timeZone: "Asia/Shanghai",
    now: () => now,
  });
  return { ...started, base: `http://127.0.0.1:${started.port}` };
}

async function postLogin(started: { base: string }, value: string): Promise<{ status: number; cookie: string; text: string }> {
  const res = await fetch(`${started.base}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(value)}`,
    redirect: "manual",
  });
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const cookie = list.map((item) => item.split(";")[0]).join("; ");
  return { status: res.status, cookie, text: await res.text() };
}

async function postJson(started: { base: string }, path: string, headers: Record<string, string>): Promise<{ message: string }> {
  const res = await fetch(`${started.base}${path}`, { method: "POST", headers });
  assert.equal(res.status, 200);
  return await res.json() as { message: string };
}
