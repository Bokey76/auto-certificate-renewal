import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAliyunClients } from "./aliyun.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

test("根配置无法解析时退出码为 1，并且不写 status.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const config = join(dir, "bad.yaml");
  writeFileSync(config, "jobs: [\n");
  const result = spawnSync(process.execPath, [cli, "run"], {
    cwd: dir,
    env: { ...process.env, CONFIG_PATH: config, CERT_RENEW_DATA_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(existsSync(join(dir, "status.json")), false);
});

test("指定了不存在的任务时退出码为 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  const config = join(dir, "config.yaml");
  writeFileSync(
    config,
    `serverName: origin-a
letsencrypt:
  email: ops@example.com
jobs:
  - id: www
    domains: [example.com]
    challenge: { type: http-01, webroot: /tmp/acme }
`,
  );
  const result = spawnSync(process.execPath, [cli, "run", "--job", "missing"], {
    cwd: dir,
    env: { ...process.env, CONFIG_PATH: config, CERT_RENEW_DATA_DIR: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { exitCode: number; jobs: Array<{ id: string; status: string }> };
  assert.equal(status.exitCode, 2);
  assert.equal(status.jobs[0].id, "missing");
  assert.equal(status.jobs[0].status, "failed");
});

test("阿里云客户端可以按区域构造", () => {
  const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "test-id";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "test-secret";
  try {
    const clients = createAliyunClients("cn-hangzhou");
    assert.equal(typeof clients.certificates.upload, "function");
    assert.equal(typeof clients.cdn.setCertificate, "function");
    assert.equal(typeof clients.dns.addTxt, "function");
  } finally {
    restore("ALIBABA_CLOUD_ACCESS_KEY_ID", previousId);
    restore("ALIBABA_CLOUD_ACCESS_KEY_SECRET", previousSecret);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
