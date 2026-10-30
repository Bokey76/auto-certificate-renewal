import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeScheduler } from "./control.js";
import { loadOverview, readLogTail } from "./overview.js";

const now = new Date("2026-10-30T03:00:00.000Z");
const zone = "Asia/Shanghai";

test("配置、状态和 CDN 目标拼在一起", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-"));
  const configPath = join(data, "config.yaml");
  writeFileSync(
    configPath,
    `serverName: origin-a
letsencrypt:
  email: ops@example.com
  renewBeforeDays: 30
jobs:
  - id: www-example
    domains: [example.com, www.example.com]
    credential: prod
    challenge:
      type: dns-01
      zone: example.com
    apply:
      - type: nginx
        kind: baota
        certDir: /www/server/panel/vhost/cert/example.com
      - type: aliyun-cdn
        domainNames: [www.example.com]
    hook:
      command: /hooks/after.sh
      timeoutSeconds: 60
  - id: bad
    domains: []
`,
  );
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
        { id: "old-name", status: "success", notAfter: "2026-12-01T00:00:00.000Z", nginx: [] },
      ],
    }),
    "utf8",
  );
  mkdirSync(join(data, "state"), { recursive: true });
  writeFileSync(
    join(data, "state", "www-example.json"),
    JSON.stringify({
      jobId: "www-example",
      certName: "www-example",
      fingerprint: "abcdef1234567890ffff",
      notAfter: "2027-01-08T00:00:00.000Z",
      cas: { fingerprint: "abcdef1234567890ffff", certId: 9, name: "acme-www-example-20261001" },
      targets: { "cdn:www.example.com": { ok: true, at: "2026-10-01T00:00:00.000Z" } },
      pem: "SECRETPEM",
    }),
    "utf8",
  );
  writeScheduler(data, {
    updatedAt: now.toISOString(),
    state: "sleeping",
    paused: false,
    nextRunAt: "2026-10-30T07:00:00.000Z",
    runPending: false,
  });

  const view = loadOverview({ dataDir: data, configPath, now, timeZone: zone });
  assert.equal(view.server.serverName, "origin-a");
  assert.equal(view.server.scheduler.online, true);
  assert.equal(view.server.scheduler.activityText, "等待下次检查");
  assert.equal(view.server.lastRun?.exitCode, 0);
  assert.equal(view.server.lastRun?.counts.skipped, 1);
  assert.equal(view.server.jobs[0].id, "www-example");
  assert.deepEqual(view.server.jobs[0].domains, ["example.com", "www.example.com"]);
  assert.equal(view.server.jobs[0].status, "skipped");
  assert.equal(view.server.jobs[0].fingerprintPrefix, "abcdef123456");
  assert.equal(view.server.jobs[0].cas?.certId, 9);
  assert.equal(view.server.jobs[0].cdn[0].text, "已绑定");
  assert.equal(view.server.jobs[0].nginx[0].nginxReload, "passed");
  assert.equal(view.server.jobs[0].hook, "有");
  assert.match(view.server.jobs[0].expiryText ?? "", /剩余 \d+ 天，续签窗口 30 天/);
  assert.equal(view.server.jobs[1].status, "invalid");
  assert.match(view.server.jobs[1].error ?? "", /domains/);
  assert.equal(view.server.jobs[2].inConfig, false);
  assert.match(view.server.jobs[2].statusText, /配置里已没有/);
  assert.equal(view.log.lines.length, 1);
  const dumped = JSON.stringify(view);
  assert.equal(dumped.includes("SECRETPEM"), false);
  assert.equal(dumped.includes("prod"), false);
  assert.equal(dumped.includes("/hooks/after.sh"), false);
  assert.equal(dumped.includes("BEGIN "), false);
});

test("没有 status.json 时任务还没有跑过", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-"));
  const configPath = join(data, "config.yaml");
  writeFileSync(
    configPath,
    `serverName: origin-a
letsencrypt:
  email: ops@example.com
jobs:
  - id: www-example
    domains: [example.com]
    challenge: { type: http-01, webroot: /var/www/acme }
    apply:
      - type: aliyun-cdn
        domainNames: [example.com]
`,
  );
  const view = loadOverview({ dataDir: data, configPath, now, timeZone: zone });
  assert.equal(view.server.serverName, "origin-a");
  assert.equal(view.server.lastRun, null);
  assert.equal(view.server.scheduler.online, false);
  assert.equal(view.server.jobs[0].status, "absent");
  assert.equal(view.server.jobs[0].cdn[0].text, "尚未绑定");
  assert.equal(view.log.message, "还没有日志");
});

test("配置读不了时任务表为空", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-"));
  const configPath = join(data, "missing.yaml");
  const view = loadOverview({ dataDir: data, configPath, now, timeZone: zone });
  assert.equal(view.server.jobs.length, 0);
  assert.match(view.server.configError ?? "", /无法读取配置/);
  assert.equal(view.server.serverName, "未命名");
});

test("日志路径逃出 logs 目录时不读取", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-"));
  mkdirSync(join(data, "logs"));
  const secret = join(data, "secret.txt");
  writeFileSync(secret, "SECRETLOG\n", "utf8");
  const tail = readLogTail(data, secret);
  assert.equal(tail.message, "日志路径不合法");
  assert.equal(tail.lines.length, 0);
  assert.equal(JSON.stringify(tail).includes("SECRETLOG"), false);

  const missing = readLogTail(data, join(data, "logs", "gone.log"));
  assert.equal(missing.message, "日志文件不在");
});
