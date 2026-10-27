import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { alibabaCredential } from "./env.js";
import { txtRecord } from "./dns-names.js";
import type { DnsService } from "./types.js";

interface StoredRecord {
  recordId: string;
  fqdn: string;
  value: string;
}

/** Certbot auth 钩子：写 TXT，记下 RecordId；最后一个挑战写完后等待传播。 */
export async function dnsAuth(dns: DnsService, sleep: (ms: number) => Promise<void>): Promise<void> {
  const domain = requiredEnv("CERTBOT_DOMAIN");
  const value = requiredEnv("CERTBOT_VALIDATION");
  const zone = requiredEnv("CERT_RENEW_ZONE");
  const { rr, fqdn } = txtRecord(domain, zone);
  const created = await dns.addTxt({ zone, rr, value });
  const records = readRecords();
  records.push({ recordId: created.recordId, fqdn, value });
  writeRecords(records);
  const remaining = Number(process.env.CERTBOT_REMAINING_CHALLENGES ?? "0");
  if (remaining === 0) {
    const seconds = Number(process.env.CERT_RENEW_PROPAGATION_SECONDS ?? "60");
    await sleep(Math.max(0, seconds) * 1000);
  }
}

/** Certbot cleanup 钩子：只删本轮、本 FQDN、本校验值对应的记录。 */
export async function dnsCleanup(dns: DnsService): Promise<void> {
  const domain = requiredEnv("CERTBOT_DOMAIN");
  const value = requiredEnv("CERTBOT_VALIDATION");
  const zone = requiredEnv("CERT_RENEW_ZONE");
  const { fqdn } = txtRecord(domain, zone);
  const records = readRecords();
  const index = records.findIndex((item) => item.fqdn === fqdn && item.value === value);
  if (index < 0) return;
  const [item] = records.splice(index, 1);
  await dns.deleteRecord(item.recordId);
  writeRecords(records);
}

/** 钩子进程按 CERT_RENEW_CREDENTIAL 取阿里云密钥。 */
export function credentialFromHookEnv(): { accessKeyId: string; accessKeySecret: string } {
  return alibabaCredential(process.env.CERT_RENEW_CREDENTIAL);
}

function readRecords(): StoredRecord[] {
  const file = requiredEnv("CERT_RENEW_RECORD_FILE");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")) as StoredRecord[];
}

function writeRecords(records: StoredRecord[]): void {
  const file = requiredEnv("CERT_RENEW_RECORD_FILE");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}
