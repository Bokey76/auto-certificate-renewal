#!/usr/bin/env node
/** 进程入口：run 跑一轮，schedule 按时刻表循环，web 提供控制台，dns-* 给 Certbot 当钩子。 */
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAliyunClients } from "./aliyun.js";
import { loadConfig } from "./config.js";
import { dnsAuth, dnsCleanup } from "./dns-hook.js";
import { loadDotEnv } from "./env.js";
import { spawnExec } from "./exec.js";
import { createLogger } from "./log.js";
import { runAll } from "./runner.js";
import { DEFAULT_SCHEDULE_HOURS, randomOffsetMinutes, sleep } from "./schedule.js";
import { runScheduleLoop, volumeControl } from "./schedule-loop.js";
import { startWeb } from "./web.js";

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
    process.exit(1);
  }
  if (command === "web") {
    await serveWeb();
  } else {
    process.stderr.write("用法：cert-renew run [--job id] [--dry-run] [--force] | cert-renew schedule | cert-renew web | cert-renew dns-auth | cert-renew dns-cleanup\n");
    process.exit(1);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(command === "dns-auth" || command === "dns-cleanup" ? 1 : 1);
}

/** 读配置并跑一轮。根配置失败返回 1，不写 status.json。 */
async function executeRun(flags: { job?: string; dryRun: boolean; force: boolean }): Promise<number> {
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
    force: flags.force,
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

/** 没有管理员时仍监听，打开网页走初始化。 */
async function serveWeb(): Promise<void> {
  const started = await startWeb({
    dataDir,
    configPath,
    webDir: join(dirname(fileURLToPath(import.meta.url)), "..", "web"),
    host: "0.0.0.0",
    port: webPort(),
    secureCookie: process.env.WEB_COOKIE_SECURE === "true",
    timeZone: process.env.TZ?.trim() || "Asia/Shanghai",
  });
  process.stdout.write(`网页监听 ${started.port}\n`);
}

function webPort(): number {
  const raw = process.env.WEB_PORT?.trim();
  if (!raw) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WEB_PORT 必须是 1–65535 的整数");
  return port;
}

/** 未暂停时启动先跑一轮。退出码 1 则结束进程。等待时每 5 秒看一次暂停和再跑一轮。 */
async function schedule(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const timeZone = process.env.TZ?.trim() || "Asia/Shanghai";
  await runScheduleLoop({
    now: () => new Date(),
    sleep,
    timeZone,
    readHours: () => {
      const loaded = loadConfig(configPath);
      return loaded.ok ? loaded.config.schedule.hours : DEFAULT_SCHEDULE_HOURS;
    },
    ...volumeControl(dataDir),
    runOnce: (request) =>
      executeRun({
        job: request?.jobId ?? undefined,
        dryRun: request?.dryRun ?? false,
        force: request?.force ?? false,
      }),
    log: (line) => process.stdout.write(`${line}\n`),
    offsetMinutes: randomOffsetMinutes,
    tickMs: 5000,
    startHeartbeat: (beat) => {
      const timer = setInterval(beat, 5000);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
}

/** 解析 `run` 的 `--job`、`--dry-run`、`--force`。 */
function readFlags(args: string[]): { job?: string; dryRun: boolean; force: boolean } {
  let job: string | undefined;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--job") {
      job = args[i + 1];
      i += 1;
      if (!job) throw new Error("--job 需要任务 id");
    } else {
      throw new Error(`未知参数 ${arg}`);
    }
  }
  return { job, dryRun, force };
}
