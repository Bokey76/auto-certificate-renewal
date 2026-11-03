import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeScheduler } from "../schedule/control.js";
import { listLogFiles, loadOverview, parseLogTail, readLogByName, readLogDownload, readLogTail } from "./overview.js";

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
  assert.equal(view.log.name, "round.log");
  assert.equal(view.logs.current, "round.log");
  assert.equal(view.logs.files[0].name, "round.log");
  assert.equal(view.logs.files[0].current, true);
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
  assert.equal(view.logs.current, null);
  assert.equal(view.logs.files.length, 0);
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

test("日志列表按文件名新到旧，按名字读历史文件，不能逃出 logs", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-logs-"));
  mkdirSync(join(data, "logs"));
  mkdirSync(join(data, "logs", "subdir.log"));
  writeFileSync(join(data, "logs", "2026-10-30T02-00-00.000Z.log"), "older-round\n", "utf8");
  writeFileSync(join(data, "logs", "2026-10-30T03-00-00.000Z.log"), "current-round\n", "utf8");
  writeFileSync(join(data, "logs", "notes.txt"), "not-a-log\n", "utf8");
  writeFileSync(join(data, "secret.txt"), "SECRETLOG\n", "utf8");

  const files = listLogFiles(data, "2026-10-30T03-00-00.000Z.log", zone);
  assert.deepEqual(files.map((file) => file.name), [
    "2026-10-30T03-00-00.000Z.log",
    "2026-10-30T02-00-00.000Z.log",
  ]);
  assert.equal(files[0].current, true);
  assert.equal(files[1].current, false);
  assert.match(files[0].label, /2026/);

  const older = readLogByName(data, "2026-10-30T02-00-00.000Z.log");
  assert.equal(older.name, "2026-10-30T02-00-00.000Z.log");
  assert.deepEqual(older.lines, ["older-round"]);

  const escaped = readLogByName(data, "../secret.txt");
  assert.equal(escaped.message, "日志路径不合法");
  assert.equal(escaped.lines.length, 0);
  assert.equal(JSON.stringify(escaped).includes("SECRETLOG"), false);

  const nested = readLogByName(data, "foo/bar.log");
  assert.equal(nested.message, "日志路径不合法");

  const dir = readLogByName(data, "subdir.log");
  assert.equal(dir.message, "日志路径不合法");
  assert.equal(dir.hasMore, false);
});

test("日志末尾按行数截取，加载更多能往前取，下载是全文", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-tail-"));
  mkdirSync(join(data, "logs"));
  const lines = Array.from({ length: 250 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`);
  writeFileSync(join(data, "logs", "round.log"), `${lines.join("\n")}\n`, "utf8");

  const first = readLogByName(data, "round.log");
  assert.equal(first.hasMore, true);
  assert.equal(first.lines.length, 200);
  assert.equal(first.lines[0], "line-051");
  assert.equal(first.lines[199], "line-250");

  const more = readLogByName(data, "round.log", 700);
  assert.equal(more.hasMore, false);
  assert.equal(more.lines.length, 250);
  assert.deepEqual(more.lines, lines);

  const file = readLogDownload(data, "round.log");
  assert.equal(file.ok, true);
  if (file.ok) {
    assert.equal(file.name, "round.log");
    assert.equal(file.text, `${lines.join("\n")}\n`);
  }

  const escaped = readLogDownload(data, "../secret.txt");
  assert.equal(escaped.ok, false);
  if (!escaped.ok) {
    assert.equal(escaped.status, 400);
    assert.equal(escaped.error, "日志路径不合法");
  }

  const missing = readLogDownload(data, "gone.log");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.status, 404);

  assert.equal(parseLogTail(null), 200);
  assert.equal(parseLogTail("700"), 700);
  assert.equal(parseLogTail("9999999"), 20000);
  assert.equal((parseLogTail("0") as { error: string }).error, "tail 必须是正整数");
  assert.equal((parseLogTail("-1") as { error: string }).error, "tail 必须是正整数");
});

test("status.json 里的日志路径不在本机时仍按文件名读 logs", () => {
  const data = mkdtempSync(join(tmpdir(), "overview-logpath-"));
  const configPath = join(data, "config.yaml");
  writeFileSync(
    configPath,
    `serverName: origin-a
letsencrypt:
  email: ops@example.com
jobs: []
`,
    "utf8",
  );
  mkdirSync(join(data, "logs"));
  writeFileSync(join(data, "logs", "round.log"), "from-mount\n", "utf8");
  writeFileSync(
    join(data, "status.json"),
    JSON.stringify({
      serverName: "origin-a",
      startedAt: "2026-10-30T02:00:00.000Z",
      finishedAt: "2026-10-30T02:01:00.000Z",
      exitCode: 0,
      logPath: "/var/lib/acme/logs/round.log",
      jobs: [],
    }),
    "utf8",
  );
  const view = loadOverview({ dataDir: data, configPath, now, timeZone: zone });
  assert.equal(view.logs.current, "round.log");
  assert.deepEqual(view.log.lines, ["from-mount"]);
  assert.equal(view.log.name, "round.log");
});
