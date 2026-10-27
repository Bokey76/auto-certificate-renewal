import { readFileSync, existsSync } from "node:fs";

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

export function alibabaCredential(name?: string): { accessKeyId: string; accessKeySecret: string } {
  const suffix = name ? `_${name.toUpperCase()}` : "";
  const accessKeyId = process.env[`ALIBABA_CLOUD_ACCESS_KEY_ID${suffix}`]?.trim() ?? "";
  const accessKeySecret = process.env[`ALIBABA_CLOUD_ACCESS_KEY_SECRET${suffix}`]?.trim() ?? "";
  if (!accessKeyId || !accessKeySecret) {
    const label = name ? `credential=${name}` : "默认凭据";
    throw new Error(`缺少阿里云${label}：ALIBABA_CLOUD_ACCESS_KEY_ID${suffix} 与 ALIBABA_CLOUD_ACCESS_KEY_SECRET${suffix}`);
  }
  return { accessKeyId, accessKeySecret };
}
