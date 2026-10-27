import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyCdn } from "./cdn.js";
import type { CertificateInfo, CertificateService, CdnService, JobState } from "./types.js";

const cert: CertificateInfo = {
  fingerprint: "aa",
  notAfter: "2027-01-01T00:00:00.000Z",
  sans: ["example.com", "www.example.com", "*.example.com"],
};

function files(): { fullchainPath: string; privkeyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "cdn-"));
  const fullchainPath = join(dir, "fullchain.pem");
  const privkeyPath = join(dir, "privkey.pem");
  writeFileSync(fullchainPath, "cert");
  writeFileSync(privkeyPath, "key");
  return { fullchainPath, privkeyPath };
}

test("加速域名超出证书范围时不上传", async () => {
  let uploads = 0;
  const certificates: CertificateService = {
    async upload() {
      uploads += 1;
      return { certId: 1 };
    },
  };
  const result = await applyCdn({
    jobId: "www",
    domainNames: ["other.example.net"],
    cert,
    ...files(),
    state: { jobId: "www", certName: "www", targets: {} },
    now: new Date("2026-10-27T00:00:00.000Z"),
    certificates,
    cdn: { async setCertificate() {} },
  });
  assert.equal(result.ok, false);
  assert.equal(uploads, 0);
});

test("一个加速域名失败时另一个仍然绑定", async () => {
  const bound: string[] = [];
  const certificates: CertificateService = { async upload() { return { certId: 9 }; } };
  const cdn: CdnService = {
    async setCertificate(input) {
      if (input.domainName === "www.example.com") throw new Error("绑定失败");
      bound.push(input.domainName);
    },
  };
  const result = await applyCdn({
    jobId: "www",
    domainNames: ["example.com", "www.example.com"],
    cert,
    ...files(),
    state: { jobId: "www", certName: "www", targets: {} },
    now: new Date("2026-10-27T00:00:00.000Z"),
    certificates,
    cdn,
  });
  assert.equal(result.ok, false);
  assert.deepEqual(bound, ["example.com"]);
  assert.equal(result.cas?.certId, 9);
});

test("证书未变时只重试失败的域名", async () => {
  let uploads = 0;
  const bound: string[] = [];
  const state: JobState = {
    jobId: "www",
    certName: "www",
    targets: { "cdn:example.com": { ok: true, at: "2026-10-01T00:00:00.000Z" } },
    cas: { fingerprint: "aa", certId: 9, name: "acme-www-20261001" },
  };
  const result = await applyCdn({
    jobId: "www",
    domainNames: ["example.com", "www.example.com"],
    cert,
    ...files(),
    state,
    now: new Date("2026-10-27T00:00:00.000Z"),
    certificates: {
      async upload() {
        uploads += 1;
        return { certId: 10 };
      },
    },
    cdn: {
      async setCertificate(input) {
        bound.push(input.domainName);
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(uploads, 0);
  assert.deepEqual(bound, ["www.example.com"]);
  assert.equal(result.cas?.certId, 9);
});
