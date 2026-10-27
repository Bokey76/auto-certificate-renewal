import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { dnsAuth, dnsCleanup } from "./dns-hook.js";
import type { DnsService } from "./types.js";

test("最后一个挑战才等待传播，清理只删除本次记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dns-"));
  const recordFile = join(dir, "records.json");
  const previous = {
    CERTBOT_DOMAIN: process.env.CERTBOT_DOMAIN,
    CERTBOT_VALIDATION: process.env.CERTBOT_VALIDATION,
    CERTBOT_REMAINING_CHALLENGES: process.env.CERTBOT_REMAINING_CHALLENGES,
    CERT_RENEW_ZONE: process.env.CERT_RENEW_ZONE,
    CERT_RENEW_PROPAGATION_SECONDS: process.env.CERT_RENEW_PROPAGATION_SECONDS,
    CERT_RENEW_RECORD_FILE: process.env.CERT_RENEW_RECORD_FILE,
  };
  const added: Array<{ zone: string; rr: string; value: string }> = [];
  const deleted: string[] = [];
  const dns: DnsService = {
    async addTxt(input) {
      added.push(input);
      return { recordId: `id-${added.length}` };
    },
    async deleteRecord(recordId) {
      deleted.push(recordId);
    },
  };
  const waits: number[] = [];
  try {
    process.env.CERT_RENEW_ZONE = "example.com";
    process.env.CERT_RENEW_PROPAGATION_SECONDS = "0";
    process.env.CERT_RENEW_RECORD_FILE = recordFile;
    process.env.CERTBOT_DOMAIN = "example.com";
    process.env.CERTBOT_VALIDATION = "token-apex";
    process.env.CERTBOT_REMAINING_CHALLENGES = "1";
    await dnsAuth(dns, async (ms) => {
      waits.push(ms);
    });
    process.env.CERTBOT_DOMAIN = "www.example.com";
    process.env.CERTBOT_VALIDATION = "token-www";
    process.env.CERTBOT_REMAINING_CHALLENGES = "0";
    await dnsAuth(dns, async (ms) => {
      waits.push(ms);
    });
    assert.deepEqual(added, [
      { zone: "example.com", rr: "_acme-challenge", value: "token-apex" },
      { zone: "example.com", rr: "_acme-challenge.www", value: "token-www" },
    ]);
    assert.deepEqual(waits, [0]);

    process.env.CERTBOT_DOMAIN = "www.example.com";
    process.env.CERTBOT_VALIDATION = "token-www";
    await dnsCleanup(dns);
    const left = JSON.parse(readFileSync(recordFile, "utf8")) as Array<{ recordId: string }>;
    assert.deepEqual(deleted, ["id-2"]);
    assert.deepEqual(left.map((item) => item.recordId), ["id-1"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
