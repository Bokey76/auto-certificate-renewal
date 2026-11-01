import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadCredentialsMap } from "./credentials.js";

/** 读取项目根目录的 .env。已存在的环境变量不覆盖。 */
export function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** 先读配置旁的 credentials.json，没有再读环境变量。缺值就抛错。 */
export function alibabaCredential(name?: string): { accessKeyId: string; accessKeySecret: string } {
  const key = name?.trim() || "default";
  const configPath = process.env.CONFIG_PATH?.trim() || "/config/config.yaml";
  const fromFile = loadCredentialsMap(join(dirname(configPath), "credentials.json"))[key];
  if (fromFile) return fromFile;
  const suffix = key === "default" ? "" : `_${key.toUpperCase()}`;
  const accessKeyId = process.env[`ALIBABA_CLOUD_ACCESS_KEY_ID${suffix}`]?.trim() ?? "";
  const accessKeySecret = process.env[`ALIBABA_CLOUD_ACCESS_KEY_SECRET${suffix}`]?.trim() ?? "";
  if (!accessKeyId || !accessKeySecret) {
    const label = key === "default" ? "默认凭据" : `credential=${key}`;
    throw new Error(`缺少阿里云${label}：请在网页里填写，或设置 ALIBABA_CLOUD_ACCESS_KEY_ID${suffix} 与 ALIBABA_CLOUD_ACCESS_KEY_SECRET${suffix}`);
  }
  return { accessKeyId, accessKeySecret };
}
