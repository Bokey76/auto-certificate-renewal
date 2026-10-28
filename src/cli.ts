#!/usr/bin/env node
/** 进程入口：run 跑一轮，schedule 先跑再按时刻表循环，dns-* 给 Certbot 当钩子。 */
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { createAliyunClients } from "./aliyun.js";
import { loadConfig } from "./config.js";
import { dnsAuth, dnsCleanup } from "./dns-hook.js";
import { loadDotEnv } from "./env.js";
import { spawnExec } from "./exec.js";
import { createLogger } from "./log.js";
import { runAll } from "./runner.js";
import { DEFAULT_SCHEDULE_HOURS, nextRun, randomOffsetMinutes, sleep } from "./schedule.js";

loadDotEnv(resolve(process.cwd(), ".env"));

const dataDir = process.env.CERT_RENEW_DATA_DIR?.trim() || "/var/lib/acme";
const configPath = process.env.CONFIG_PATH?.trim() || "/config/config.yaml";

const argv = process.argv.slice(2);
const command = argv[0] || "run";

try {
  if (command === "dns-auth" || command === "dns-cleanup") {
    const regionId = process.env.ALIBABA_CLOUD_REGION_ID?.trim() || "cn-shenzhen";
    const clients = createAliyunClients(regionId, process.env.CERT_RENEW_CREDENTIAL);
    if (command === "dns-auth") await dnsAuth(clients.dns, sleep);
    else await dnsCleanup(clients.dns);
    process.exit(0);
  }
  if (command === "run") {
    const code = await executeRun(readFlags(argv.slice(1)));
    process.exit(code);
  }
  if (command === "schedule") {
    await schedule();
    process.exit(0);
  }
  process.stderr.write("用法：cert-renew run [--job id] [--dry-run] | cert-renew schedule | cert-renew dns-auth | cert-renew dns-cleanup\n");
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(command === "dns-auth" || command === "dns-cleanup" ? 1 : 1);
}

/** 读配置并跑一轮。根配置失败返回 1，不写 status.json。 */
async function executeRun(flags: { job?: string; dryRun: boolean }): Promise<number> {
  const loaded = loadConfig(configPath);
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const logger = createLogger(join(dataDir, "logs", `${stamp}.log`));
  if (!loaded.ok) {
    logger.line(undefined, loaded.error);
    return 1;
  }
  return runAll({
    config: loaded.config,
    invalidJobs: loaded.invalidJobs,
    dataDir,
    dryRun: flags.dryRun,
    onlyJob: flags.job,
    logger,
    deps: {
      now: () => new Date(),
      exec: spawnExec,
      hostname: hostname(),
      certificatesFor: (credential) => createAliyunClients(loaded.config.alibaba.regionId, credential).certificates,
      cdnFor: (credential) => createAliyunClients(loaded.config.alibaba.regionId, credential).cdn,
    },
  });
}

/** 启动先跑一轮；配置读不了则退出；否则睡到配置里下一次检查时刻。 */
async function schedule(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const timeZone = process.env.TZ?.trim() || "Asia/Shanghai";
  for (;;) {
    const code = await executeRun({ dryRun: false });
    if (code === 1) process.exit(1);
    const loaded = loadConfig(configPath);
    const hours = loaded.ok ? loaded.config.schedule.hours : DEFAULT_SCHEDULE_HOURS;
    const offset = randomOffsetMinutes();
    const at = nextRun(new Date(), timeZone, hours, offset);
    process.stdout.write(`${new Date().toISOString()} [-] 下次检查 ${at.toISOString()}（偏移 ${offset} 分钟）\n`);
    await sleep(Math.max(1000, at.getTime() - Date.now()));
  }
}

/** 解析 `run` 的 `--job` 和 `--dry-run`。 */
function readFlags(args: string[]): { job?: string; dryRun: boolean } {
  let job: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--job") {
      job = args[i + 1];
      i += 1;
      if (!job) throw new Error("--job 需要任务 id");
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return { job, dryRun };
}
