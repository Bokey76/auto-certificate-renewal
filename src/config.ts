import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import type {
  AlibabaConfig,
  AppConfig,
  ApplyAction,
  Challenge,
  ConfigLoadResult,
  HookConfig,
  InvalidJob,
  JobConfig,
  KeyType,
  LetsEncryptConfig,
  ScheduleConfig,
} from "./types.js";
import { DEFAULT_SCHEDULE_HOURS } from "./schedule.js";

const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const DOMAIN = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/** 读 YAML。根结构失败返回 ok:false；单条任务失败进 invalidJobs，其余照常。 */
export function loadConfig(path: string): ConfigLoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: `无法读取配置 ${path}：${messageOf(error)}` };
  }
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (error) {
    return { ok: false, error: `YAML 无法解析：${messageOf(error)}` };
  }
  if (!isRecord(raw)) return { ok: false, error: "配置根必须是映射" };
  const letsencrypt = parseLetsEncrypt(raw.letsencrypt);
  if (typeof letsencrypt === "string") return { ok: false, error: letsencrypt };
  const alibaba = parseAlibaba(raw.alibaba);
  if (typeof alibaba === "string") return { ok: false, error: alibaba };
  const schedule = parseSchedule(raw.schedule);
  if (typeof schedule === "string") return { ok: false, error: schedule };
  if (!Array.isArray(raw.jobs)) return { ok: false, error: "jobs 必须是数组" };

  const serverName = raw.serverName === undefined ? undefined : raw.serverName;
  if (serverName !== undefined && (typeof serverName !== "string" || serverName.trim() === "")) {
    return { ok: false, error: "serverName 必须是非空字符串" };
  }

  const jobs: JobConfig[] = [];
  const invalidJobs: InvalidJob[] = [];
  const seen = new Set<string>();
  raw.jobs.forEach((item, index) => {
    const parsed = parseJob(item, index, seen);
    if ("error" in parsed) invalidJobs.push(parsed);
    else jobs.push(parsed);
  });

  const config: AppConfig = {
    serverName: typeof serverName === "string" ? serverName.trim() : undefined,
    letsencrypt,
    alibaba,
    schedule,
    jobs,
  };
  return { ok: true, config, invalidJobs };
}

function parseLetsEncrypt(value: unknown): LetsEncryptConfig | string {
  if (!isRecord(value)) return "letsencrypt 必须是映射";
  if (typeof value.email !== "string" || !value.email.includes("@")) return "letsencrypt.email 必须是邮箱";
  const staging = value.staging === undefined ? false : value.staging;
  if (typeof staging !== "boolean") return "letsencrypt.staging 必须是布尔值";
  const renewBeforeDays = value.renewBeforeDays === undefined ? 30 : value.renewBeforeDays;
  if (typeof renewBeforeDays !== "number" || !Number.isInteger(renewBeforeDays) || renewBeforeDays < 1) {
    return "letsencrypt.renewBeforeDays 必须是大于 0 的整数";
  }
  const keyType = value.keyType === undefined ? "ecdsa" : value.keyType;
  if (keyType !== "ecdsa" && keyType !== "rsa") return "letsencrypt.keyType 只能是 ecdsa 或 rsa";
  return { email: value.email.trim(), staging, renewBeforeDays, keyType: keyType as KeyType };
}

function parseAlibaba(value: unknown): AlibabaConfig | string {
  if (value === undefined) return { regionId: "cn-hangzhou" };
  if (!isRecord(value)) return "alibaba 必须是映射";
  const regionId = value.regionId === undefined ? "cn-hangzhou" : value.regionId;
  if (typeof regionId !== "string" || regionId.trim() === "") return "alibaba.regionId 必须是非空字符串";
  return { regionId: regionId.trim() };
}

function parseSchedule(value: unknown): ScheduleConfig | string {
  if (value === undefined) return { hours: [...DEFAULT_SCHEDULE_HOURS] };
  if (!isRecord(value)) return "schedule 必须是映射";
  if (value.hours === undefined) return { hours: [...DEFAULT_SCHEDULE_HOURS] };
  if (!Array.isArray(value.hours) || value.hours.length === 0) {
    return "schedule.hours 至少要有一个 0–23 的整数";
  }
  const unique = new Set<number>();
  for (const hour of value.hours) {
    if (typeof hour !== "number" || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      return "schedule.hours 必须是 0–23 的整数";
    }
    unique.add(hour);
  }
  return { hours: [...unique].sort((a, b) => a - b) };
}

function parseJob(value: unknown, index: number, seen: Set<string>): JobConfig | InvalidJob {
  if (!isRecord(value)) return { index, error: "任务必须是映射" };
  const id = typeof value.id === "string" ? value.id : undefined;
  const fail = (error: string): InvalidJob => ({ index, id, error });
  if (!id || !JOB_ID.test(id)) return fail("id 必须是 1–40 位小写字母、数字或连字符，且不能以连字符开头或结尾");
  if (seen.has(id)) return fail(`id 重复：${id}`);
  seen.add(id);
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") return fail("enabled 必须是布尔值");
  if (!Array.isArray(value.domains) || value.domains.length === 0) return fail("domains 至少要有一个域名");
  const domains: string[] = [];
  for (const domain of value.domains) {
    if (typeof domain !== "string" || !DOMAIN.test(domain)) return fail(`域名不合法：${String(domain)}`);
    domains.push(domain.toLowerCase());
  }
  const challenge = parseChallenge(value.challenge, domains);
  if (typeof challenge === "string") return fail(challenge);
  let credential: string | undefined;
  if (value.credential !== undefined) {
    if (typeof value.credential !== "string" || !/^[A-Za-z0-9]+$/.test(value.credential)) {
      return fail("credential 只能包含字母和数字");
    }
    credential = value.credential;
  }
  const apply: ApplyAction[] = [];
  if (value.apply !== undefined) {
    if (!Array.isArray(value.apply)) return fail("apply 必须是数组");
    for (const action of value.apply) {
      const parsed = parseAction(action);
      if (typeof parsed === "string") return fail(parsed);
      apply.push(parsed);
    }
  }
  let hook: HookConfig | undefined;
  if (value.hook !== undefined) {
    const parsed = parseHook(value.hook);
    if (typeof parsed === "string") return fail(parsed);
    hook = parsed;
  }
  return { id, enabled, domains, challenge, credential, apply, hook, index };
}

function parseChallenge(value: unknown, domains: string[]): Challenge | string {
  if (!isRecord(value)) return "challenge 必须是映射";
  const wildcard = domains.some((domain) => domain.startsWith("*."));
  if (value.type === "http-01") {
    if (wildcard) return "泛域名必须使用 dns-01";
    const webroot = value.webroot === undefined ? "/var/www/acme" : value.webroot;
    if (typeof webroot !== "string" || webroot.trim() === "") return "http-01.webroot 必须是非空路径";
    return { type: "http-01", webroot: webroot.trim() };
  }
  if (value.type === "dns-01") {
    if (typeof value.zone !== "string" || !DOMAIN.test(value.zone) || value.zone.startsWith("*.")) {
      return "dns-01.zone 必须是阿里云解析里的主域名";
    }
    const propagationSeconds = value.propagationSeconds === undefined ? 60 : value.propagationSeconds;
    if (
      typeof propagationSeconds !== "number" ||
      !Number.isInteger(propagationSeconds) ||
      propagationSeconds < 0 ||
      propagationSeconds > 3600
    ) {
      return "dns-01.propagationSeconds 必须是 0–3600 的整数";
    }
    return { type: "dns-01", zone: value.zone.toLowerCase(), propagationSeconds };
  }
  return "challenge.type 只能是 http-01 或 dns-01";
}

function parseAction(value: unknown): ApplyAction | string {
  if (!isRecord(value)) return "应用动作必须是映射";
  if (value.type === "nginx") {
    if (value.kind === "baota") {
      if (typeof value.certDir !== "string" || value.certDir.trim() === "") return "宝塔动作必须填写 certDir";
      const fullchainName = value.fullchainName === undefined ? "fullchain.pem" : value.fullchainName;
      const privkeyName = value.privkeyName === undefined ? "privkey.pem" : value.privkeyName;
      const nginxBin = value.nginxBin === undefined ? "/www/server/nginx/sbin/nginx" : value.nginxBin;
      if (typeof fullchainName !== "string" || typeof privkeyName !== "string" || typeof nginxBin !== "string") {
        return "宝塔动作的文件名和 nginxBin 必须是字符串";
      }
      return {
        type: "nginx",
        kind: "baota",
        certDir: value.certDir.trim(),
        fullchainName: fullchainName.trim(),
        privkeyName: privkeyName.trim(),
        nginxBin: nginxBin.trim(),
      };
    }
    if (value.kind === "custom") {
      if (typeof value.fullchainPath !== "string" || typeof value.privkeyPath !== "string" || typeof value.nginxBin !== "string") {
        return "自装 Nginx 必须填写 fullchainPath、privkeyPath 和 nginxBin";
      }
      return {
        type: "nginx",
        kind: "custom",
        fullchainPath: value.fullchainPath.trim(),
        privkeyPath: value.privkeyPath.trim(),
        nginxBin: value.nginxBin.trim(),
      };
    }
    return "nginx.kind 只能是 baota 或 custom";
  }
  if (value.type === "aliyun-cdn") {
    if (!Array.isArray(value.domainNames) || value.domainNames.length === 0) return "aliyun-cdn.domainNames 至少要有一个加速域名";
    const domainNames: string[] = [];
    for (const name of value.domainNames) {
      if (typeof name !== "string" || !DOMAIN.test(name) || name.startsWith("*.")) return `加速域名不合法：${String(name)}`;
      domainNames.push(name.toLowerCase());
    }
    return { type: "aliyun-cdn", domainNames };
  }
  return `未知的应用动作：${String(value.type)}`;
}

function parseHook(value: unknown): HookConfig | string {
  if (!isRecord(value)) return "hook 必须是映射";
  if (typeof value.command !== "string" || value.command.trim() === "") return "hook.command 必须是非空命令";
  const timeoutSeconds = value.timeoutSeconds === undefined ? 60 : value.timeoutSeconds;
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
    return "hook.timeoutSeconds 必须是 1–300 的整数";
  }
  return { command: value.command, timeoutSeconds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 宝塔用 certDir+文件名，custom 用显式路径，收成同一组目标路径。状态键用这里的 fullchain。 */
export function nginxDestination(action: Extract<ApplyAction, { type: "nginx" }>): { fullchain: string; privkey: string; bin: string } {
  if (action.kind === "baota") {
    return {
      fullchain: join(action.certDir, action.fullchainName),
      privkey: join(action.certDir, action.privkeyName),
      bin: action.nginxBin,
    };
  }
  return { fullchain: action.fullchainPath, privkey: action.privkeyPath, bin: action.nginxBin };
}
