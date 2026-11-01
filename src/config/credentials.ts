/** 配置旁的 credentials.json。网页读写密钥，签发时优先于 .env。 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../lib/write-file.js";

const NAME = /^[A-Za-z0-9]+$/;

export interface CredentialRecord {
  accessKeyId: string;
  accessKeySecret: string;
}

export interface CredentialView {
  name: string;
  configured: boolean;
  source: "file" | "env" | null;
}

/** 凭据文件在配置 YAML 同目录。 */
export function credentialsPath(configPath: string): string {
  return join(dirname(configPath), "credentials.json");
}

/** 只读文件里的密钥。文件不在或坏 JSON 当成没有。 */
export function loadCredentialsMap(path: string): Record<string, CredentialRecord> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return {};
    const out: Record<string, CredentialRecord> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (!NAME.test(name) || !isRecord(value)) continue;
      const accessKeyId = typeof value.accessKeyId === "string" ? value.accessKeyId.trim() : "";
      const accessKeySecret = typeof value.accessKeySecret === "string" ? value.accessKeySecret.trim() : "";
      if (!accessKeyId || !accessKeySecret) continue;
      out[name] = { accessKeyId, accessKeySecret };
    }
    return out;
  } catch {
    return {};
  }
}

/** 列出凭据名和来源（文件或环境变量），不返回密钥。 */
export function listCredentialViews(configPath: string): CredentialView[] {
  const file = loadCredentialsMap(credentialsPath(configPath));
  const names = new Set<string>(["default", ...Object.keys(file), ...envCredentialNames()]);
  return [...names].sort(sortNames).map((name) => {
    if (file[name]) return { name, configured: true, source: "file" };
    if (envCredential(name)) return { name, configured: true, source: "env" };
    return { name, configured: false, source: null };
  });
}

/** 写入或覆盖一条凭据。名只能是字母和数字。 */
export function upsertCredential(
  configPath: string,
  name: string,
  accessKeyId: string,
  accessKeySecret: string,
): { ok: true } | { ok: false; error: string } {
  if (!NAME.test(name)) return { ok: false, error: "凭据名只能包含字母和数字" };
  const id = accessKeyId.trim();
  const secret = accessKeySecret.trim();
  if (!id || !secret) return { ok: false, error: "AccessKeyId 和 AccessKeySecret 都不能为空" };
  const path = credentialsPath(configPath);
  const map = loadCredentialsMap(path);
  map[name] = { accessKeyId: id, accessKeySecret: secret };
  writeMap(path, map);
  return { ok: true };
}

/** 只删文件里的那条。环境变量里的凭据删不掉。 */
export function deleteCredential(configPath: string, name: string): { ok: true } | { ok: false; error: string } {
  if (!NAME.test(name)) return { ok: false, error: "凭据名只能包含字母和数字" };
  const path = credentialsPath(configPath);
  const map = loadCredentialsMap(path);
  if (!map[name]) return { ok: false, error: "文件里没有这个凭据" };
  delete map[name];
  writeMap(path, map);
  return { ok: true };
}

function writeMap(path: string, map: Record<string, CredentialRecord>): void {
  atomicWrite(path, `${JSON.stringify(map, null, 2)}\n`);
}

function envCredential(name: string): CredentialRecord | undefined {
  const suffix = name === "default" ? "" : `_${name.toUpperCase()}`;
  const accessKeyId = process.env[`ALIBABA_CLOUD_ACCESS_KEY_ID${suffix}`]?.trim() ?? "";
  const accessKeySecret = process.env[`ALIBABA_CLOUD_ACCESS_KEY_SECRET${suffix}`]?.trim() ?? "";
  if (!accessKeyId || !accessKeySecret) return undefined;
  return { accessKeyId, accessKeySecret };
}

function envCredentialNames(): string[] {
  const names: string[] = [];
  if (envCredential("default")) names.push("default");
  const prefix = "ALIBABA_CLOUD_ACCESS_KEY_ID_";
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length).toLowerCase();
    if (NAME.test(name) && envCredential(name)) names.push(name);
  }
  return names;
}

function sortNames(a: string, b: string): number {
  if (a === "default") return -1;
  if (b === "default") return 1;
  return a.localeCompare(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
