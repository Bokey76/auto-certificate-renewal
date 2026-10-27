#!/usr/bin/env node
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
import { nextRun, sleep } from "./schedule.js";
import { readOffsetMinutes } from "./state.js";

loadDotEnv(resolve(process.cwd(), ".env"));

const dataDir = process.env.CERT_RENEW_DATA_DIR?.trim() || "/var/lib/acme";
const configPath = process.env.CONFIG_PATH?.trim() || "/config/config.yaml";

const argv = process.argv.slice(2);
const command = argv[0] || "run";

try {
  if (command === "dns-auth" || command === "dns-cleanup") {
    const regionId = process.env.ALIBABA_CLOUD_REGION_ID?.trim() || "cn-hangzhou";
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

async function schedule(): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const offset = readOffsetMinutes(dataDir);
  const timeZone = process.env.TZ?.trim() || "Asia/Shanghai";
  for (;;) {
    const code = await executeRun({ dryRun: false });
    if (code === 1) process.exit(1);
    const wait = nextRun(new Date(), timeZone, offset).getTime() - Date.now();
    await sleep(Math.max(1000, wait));
  }
}

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
