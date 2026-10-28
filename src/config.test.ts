import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";

function writeConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cert-renew-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, text);
  return path;
}

const header = `
serverName: origin-a
letsencrypt:
  email: ops@example.com
alibaba:
  regionId: cn-shenzhen
`;

test("根配置无法解析时整份失败", () => {
  const loaded = loadConfig(writeConfig("jobs: [\n"));
  assert.equal(loaded.ok, false);
});

test("单条任务不合法时保留其他任务", () => {
  const loaded = loadConfig(
    writeConfig(`
${header}
jobs:
  - id: ok-a
    domains: [a.example.com]
    challenge: { type: http-01 }
  - id: bad
    domains: ["*.example.com"]
    challenge: { type: http-01 }
  - id: ok-b
    domains: [b.example.com]
    challenge:
      type: dns-01
      zone: example.com
`),
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.config.jobs.map((job) => job.id), ["ok-a", "ok-b"]);
  assert.equal(loaded.invalidJobs.length, 1);
  assert.equal(loaded.invalidJobs[0].id, "bad");
  assert.match(loaded.invalidJobs[0].error, /dns-01/);
  assert.equal(loaded.config.letsencrypt.renewBeforeDays, 30);
  assert.equal(loaded.config.letsencrypt.keyType, "ecdsa");
  assert.deepEqual(loaded.config.schedule.hours, [3, 15]);
  assert.equal(loaded.config.jobs[0].challenge.type, "http-01");
  if (loaded.config.jobs[0].challenge.type === "http-01") {
    assert.equal(loaded.config.jobs[0].challenge.webroot, "/var/www/acme");
  }
});

test("重复 id 只拒绝后一条", () => {
  const loaded = loadConfig(
    writeConfig(`
${header}
jobs:
  - id: same
    domains: [a.example.com]
    challenge: { type: http-01 }
  - id: same
    domains: [b.example.com]
    challenge: { type: http-01 }
`),
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.config.jobs.length, 1);
  assert.equal(loaded.invalidJobs[0].error.includes("重复"), true);
});

test("示例配置可以被接受", () => {
  const loaded = loadConfig(fileURLToPath(new URL("../config/config.example.yaml", import.meta.url)));
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.equal(loaded.invalidJobs.length, 0);
  assert.deepEqual(
    loaded.config.jobs.map((job) => job.id),
    ["www-example", "origin-api"],
  );
  assert.deepEqual(loaded.config.schedule.hours, [3, 15]);
});

test("可以自定义检查小时并去重排序", () => {
  const loaded = loadConfig(
    writeConfig(`
${header}
schedule:
  hours: [12, 1, 1]
jobs:
  - id: www
    domains: [example.com]
    challenge: { type: http-01 }
`),
  );
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.config.schedule.hours, [1, 12]);
});

test("检查小时不合法时整份失败", () => {
  const loaded = loadConfig(
    writeConfig(`
${header}
schedule:
  hours: [24]
jobs:
  - id: www
    domains: [example.com]
    challenge: { type: http-01 }
`),
  );
  assert.equal(loaded.ok, false);
  if (loaded.ok) return;
  assert.match(loaded.error, /schedule\.hours/);
});
