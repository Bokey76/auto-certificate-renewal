import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { runAll, type RunnerDeps } from "./runner.js";
import type { AppConfig, Exec } from "./types.js";

const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIQK11bPqIrwY5G5mILhiBKXTANBgkqhkiG9w0BAQsFADAWMRQwEgYDVQQD
DAtleGFtcGxlLmNvbTAeFw0yNTEyMzExNjAwMDBaFw0zNDEyMzExNjAwMDBaMBYxFDASBgNVBAMM
C2V4YW1wbGUuY29tMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvCMKBeFx1L6NF3xJ
i2WMSc5bqSt7vWdUuMkn7AbaZbwDlz7lLZcICcakdknpIUatP/eetGHGboK0kftqulPs5ZzoGR/4
0uJWYRK/srFyEMTXR01hfeTvqh9j2NjVEzWtzx6uxSSrcKPATU5nw+wJyFzGk60OFLEVCFA0dcUv
Aw17EjvOtvNOHgMZ7PnJkzC8EcyvCHI/lYiwDIiiH2S1wDG3ckbrLaz1LpO3a0N53cfl71kDeDZ6
tY9TxkzsQPGiZB+r4UoeB+aKUWftMTK+BEyw3ttM35zHUaUOHxMGQu8oE3RvkRzzrLvFsvQHpBCX
I0Wt0VPenVm4RGbxhq2U6QIDAQABo3kwdzAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYB
BQUHAwIGCCsGAQUFBwMBMCcGA1UdEQQgMB6CC2V4YW1wbGUuY29tgg93d3cuZXhhbXBsZS5jb20w
HQYDVR0OBBYEFNrqp34xelJgSbS3AEkgigMJV8yDMA0GCSqGSIb3DQEBCwUAA4IBAQCAttdoW2Rm
b1+kZb+3IQI404g3AqMyu+xZv5HCecwCD+nT6TKiCLgWMZ+og4st2TMh+qHk9pEwaC0rzi1/wWfe
igFULbGiSbRIMpwMJFx3W3/2iUQ6fSJNjlSlihIpIe40rx3yG8J1mtNC8oBdDgoZ3pk5l2pxf9uY
Dwp5OHnx6rme1xI5uWbygIEPKQc1IdffLPlgy8C5zUZ1vlVTyKvmhx12ilMIO3K+iWghoM3s5nyF
nJT95El30bGw9txplEDmLSt+y9eWG7JgpixduZFHop8mAQDemLAIm98mqVXvdbfmIZV7xYPpXPZv
HKgSZGy+pWhpkX4lGSojY/FhsEp/
-----END CERTIFICATE-----
`;

const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC8IwoF4XHUvo0X
fEmLZYxJzlupK3u9Z1S4ySfsBtplvAOXPuUtlwgJxqR2SekhRq0/9560YcZugrSR
+2q6U+zlnOgZH/jS4lZhEr+ysXIQxNdHTWF95O+qH2PY2NUTNa3PHq7FJKtwo8BN
TmfD7AnIXMaTrQ4UsRUIUDR1xS8DDXsSO862804eAxns+cmTMLwRzK8Icj+ViLAM
iKIfZLXAMbdyRustrPUuk7drQ3ndx+XvWQN4Nnq1j1PGTOxA8aJkH6vhSh4H5opR
Z+0xMr4ETLDe20zfnMdRpQ4fEwZC7ygTdG+RHPOsu8Wy9AekEJcjRa3RU96dWbhE
ZvGGrZTpAgMBAAECggEAVw//+2iwvLrRoCSsBA4iNaWBVXAB+0xuMHUmPFuPhbTU
FJHOjKJv3dZHFVZuxC9ozUlR8DevFET4OvYWFdPwtPE/lyDsjOqg/psmixMCri/p
T93HV/Mx1ZBhLGBrelBE9qxERIcLrzyYKS43Zrs8a7RDUOOsuHaaPRagsD9n2gj/
PqpuueoZCMUqb7LIwPKP7m76eNTnG+inUQ0EtvTGP5FWlgxkobWZC7MFy3WoNELr
MudveNy1WCR7fuyclKK469CQTCXdvQBA6c83Sww29L014pj8w1jnebH3OEL9zqA9
KGhLOAi6iyh55z40lCCCBl74MPlUpFXXtfa34Lr7YQKBgQDttT0POt20CycoUfHW
FFVaT1GU3VySROWV78kHx6gUaR/8JErwwkVJJbAhjvdZdyyMIg3X8IiqkIqV0Q+e
yQguIC9erKhnViwm4HSzk6BJk7MS2f9lklQbPP5a82t5y4q2xB1rANAbhqXC3TX1
7Gj0Fl8VR2I6Yb7or5hlgxsXtwKBgQDKnUSYJYGOB4eS48hV6539veXsp+HiHYUo
4vmg7UyxGuetVNjXQNfhgZhp6ZJB8jqnnOvMyQLYrgSkzwR7T0QHwnlqvkUdyS1o
JpmsU7vmfLhSDRtitQbxelYyx8Lp+sBiYXWCkZ4PJs2lPjU5eM9+huqGToGQiMTH
g2XUI454XwKBgC487t+jh7SZ5sgFCJGn6uJiQ3A9juA03qPHvMbyo1M1D6+wL5Od
dnTAC/67HIoekF/B0AeNFkh3TT3PKMauPBUc1ZoI48kWDgiR6KF1udwWCuND3FYZ
nJqfxqpSZzmNyjG6/C3wPorcKio5dWGc1t2D7ILrG8RXdxcz8OTuF7sJAoGALypd
BW31srJeBPuxbw7iQGcsVuLd2l002ke8BJI5ACFbPSY7NCCMIJqieEU/HsrcjJgi
7BD+8KHRwuvOB0Z0d7n1ubuBK2XhhBU4QL1dSFJQNgmHDntFmoD3/+ownXcZwc0e
Jb7wJGbMCGNq0G4nHzUY8xrjXln4NNmJotCEIdECgYEAn8gYS7r/G5Y3evUkVk5X
W84QxQXY7TDRRjSiSoMXlRS1iv5iATT+8v7YHrFtqvdsP0Hw7e36J0zH/nUDHqC8
IkGaOXzefPciXXE53B3Qnn7n0F6We0+d+HfHvDdgJ7VCvxGaDhNLMmLEh8aUpTM9
5YX17R0Eq5ztxiBxSfAZWkI=
-----END PRIVATE KEY-----
`;

function writeFixture(dir: string, name: string): { fullchain: string; key: string } {
  const fullchain = join(dir, `${name}.fullchain.pem`);
  const key = join(dir, `${name}.key`);
  writeFileSync(fullchain, FIXTURE_CERT);
  writeFileSync(key, FIXTURE_KEY);
  return { fullchain, key };
}

function baseConfig(): AppConfig {
  return {
    serverName: "origin-a",
    letsencrypt: { email: "ops@example.com", staging: true, renewBeforeDays: 30, keyType: "ecdsa" },
    alibaba: { regionId: "cn-hangzhou" },
    schedule: { hours: [3, 15] },
    jobs: [],
  };
}

test("不合法任务不影响另外两条签发", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const issued: string[] = [];
  const loaded = loadConfigText(`
serverName: origin-a
letsencrypt:
  email: ops@example.com
  staging: true
jobs:
  - id: ok-a
    domains: [a.example.com]
    challenge: { type: http-01, webroot: /var/www/acme }
  - id: bad
    domains: ["*.example.com"]
    challenge: { type: http-01 }
  - id: ok-b
    domains: [b.example.com]
    challenge: { type: dns-01, zone: example.com }
`);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  const code = await runAll({
    config: loaded.config,
    invalidJobs: loaded.invalidJobs,
    dataDir: dir,
    dryRun: true,
    logger: createLogger(join(dir, "logs", "run.log")),
    deps: fakeDeps(async (argv) => {
      if (argv[0] === "certbot") issued.push(argv[argv.indexOf("--cert-name") + 1]);
      return { code: 0, stdout: "", stderr: "" };
    }),
  });
  assert.equal(code, 2);
  assert.deepEqual(issued, ["ok-a", "ok-b"]);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { serverName: string; jobs: Array<{ id: string; status: string }> };
  assert.equal(status.serverName, "origin-a");
  assert.equal(status.jobs.filter((job) => job.status === "failed").length, 1);
});

test("未到期时不调用 Certbot，也不跑钩子", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const certDir = join(dir, "src-cert");
  const { fullchain, key } = writeFixture(mkdir(certDir), "live");
  const liveDir = join(dir, "letsencrypt", "live", "www");
  mkdir(liveDir);
  writeFileSync(join(liveDir, "fullchain.pem"), readFileSync(fullchain));
  writeFileSync(join(liveDir, "privkey.pem"), readFileSync(key));
  writeFileSync(
    join(mkdir(join(dir, "state")), "www.json"),
    JSON.stringify({
      jobId: "www",
      certName: "www",
      targets: { [join(dir, "dest", "fullchain.pem")]: { ok: true, at: "2026-10-01T00:00:00.000Z", nginxTest: "passed", nginxReload: "passed" } },
    }),
  );
  const calls: string[] = [];
  const config = baseConfig();
  config.jobs = [
    {
      id: "www",
      index: 0,
      enabled: true,
      domains: ["example.com"],
      challenge: { type: "http-01", webroot: "/var/www/acme" },
      apply: [{ type: "nginx", kind: "baota", certDir: join(dir, "dest"), fullchainName: "fullchain.pem", privkeyName: "privkey.pem", nginxBin: "nginx" }],
      hook: { command: "echo hi", timeoutSeconds: 5 },
    },
  ];
  const code = await runAll({
    config,
    invalidJobs: [],
    dataDir: dir,
    dryRun: false,
    logger: createLogger(join(dir, "logs", "run.log")),
    deps: fakeDeps(async (argv) => {
      calls.push(argv[0]);
      return { code: 0, stdout: "", stderr: "" };
    }),
  });
  assert.equal(code, 0);
  assert.equal(calls.includes("certbot"), false);
  assert.equal(calls.includes("/bin/sh"), false);
});

test("nginx 测试失败后仍执行 CDN，钩子只在新签发后运行", async () => {
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const made = writeFixture(mkdir(join(dir, "made")), "new");
  const uploads: string[] = [];
  const bound: string[] = [];
  let hooks = 0;
  const config = baseConfig();
  config.jobs = [
    {
      id: "www",
      index: 0,
      enabled: true,
      domains: ["example.com", "www.example.com"],
      challenge: { type: "dns-01", zone: "example.com", propagationSeconds: 0 },
      apply: [
        { type: "nginx", kind: "custom", fullchainPath: join(dir, "out", "fullchain.pem"), privkeyPath: join(dir, "out", "privkey.pem"), nginxBin: "nginx" },
        { type: "aliyun-cdn", domainNames: ["example.com", "www.example.com"] },
      ],
      hook: { command: "echo after", timeoutSeconds: 5 },
    },
  ];
  const exec: Exec = async (argv) => {
    if (argv[0] === "certbot") {
      const live = join(dir, "letsencrypt", "live", "www");
      mkdir(live);
      writeFileSync(join(live, "fullchain.pem"), readFileSync(made.fullchain));
      writeFileSync(join(live, "privkey.pem"), readFileSync(made.key));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv.includes("-t")) return { code: 1, stdout: "", stderr: "bad" };
    if (argv[0] === "/bin/sh") {
      hooks += 1;
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const deps = fakeDeps(exec);
  deps.certificatesFor = () => ({
    async upload(input) {
      uploads.push(input.name);
      return { certId: 11 };
    },
  });
  let wwwFailed = false;
  deps.cdnFor = () => ({
    async setCertificate(input) {
      if (input.domainName === "www.example.com" && !wwwFailed) {
        wwwFailed = true;
        throw new Error("绑定失败");
      }
      bound.push(input.domainName);
    },
  });
  const code = await runAll({
    config,
    invalidJobs: [],
    dataDir: dir,
    dryRun: false,
    logger: createLogger(join(dir, "logs", "run.log")),
    deps,
  });
  assert.equal(code, 2);
  assert.deepEqual(bound, ["example.com"]);
  assert.equal(uploads.length, 1);
  assert.equal(hooks, 1);
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { logPath: string; jobs: Array<{ nginx: Array<{ nginxTest: string; nginxReload: string }> }> };
  assert.equal(status.jobs[0].nginx[0].nginxTest, "failed");
  assert.equal(status.jobs[0].nginx[0].nginxReload, "skipped");
  assert.equal(status.logPath.endsWith(".log"), true);

  uploads.length = 0;
  bound.length = 0;
  hooks = 0;
  const again = await runAll({
    config,
    invalidJobs: [],
    dataDir: dir,
    dryRun: false,
    logger: createLogger(join(dir, "logs", "again.log")),
    deps,
  });
  assert.equal(again, 2);
  assert.equal(uploads.length, 0);
  assert.deepEqual(bound, ["www.example.com"]);
  assert.equal(hooks, 0);
});

function fakeDeps(exec: Exec): RunnerDeps {
  return {
    now: () => new Date("2026-10-27T00:00:00.000Z"),
    exec,
    hostname: "test-host",
    certificatesFor: () => ({ async upload() { return { certId: 1 }; } }),
    cdnFor: () => ({ async setCertificate() {} }),
  };
}

function loadConfigText(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, text);
  return loadConfig(path);
}

function mkdir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}
