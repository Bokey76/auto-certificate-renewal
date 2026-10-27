import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { nginxDestination } from "./config.js";
import { certbotFailure, lineageExists, runCertbot } from "./certbot.js";
import { applyCdn, cdnTargetKey } from "./cdn.js";
import { readCertificate, withinRenewWindow } from "./expiry.js";
import { runHook } from "./hook.js";
import type { Logger } from "./log.js";
import { applyNginx, livePaths } from "./nginx.js";
import { readJobState, writeJobState, writeStatus } from "./state.js";
import type {
  AppConfig,
  ApplyAction,
  CdnService,
  CertificateService,
  Exec,
  InvalidJob,
  JobConfig,
  JobRunResult,
  JobState,
  StatusFile,
} from "./types.js";

/** 时钟、进程、阿里云客户端都从这里注入，测试里换成假实现。 */
export interface RunnerDeps {
  now: () => Date;
  exec: Exec;
  certificatesFor: (credential: string | undefined) => CertificateService;
  cdnFor: (credential: string | undefined) => CdnService;
  hostname?: string;
}

/** 按配置顺序执行任务，写 status.json，返回退出码 0 或 2。 */
export async function runAll(input: {
  config: AppConfig;
  invalidJobs: InvalidJob[];
  dataDir: string;
  dryRun: boolean;
  onlyJob?: string;
  logger: Logger;
  deps: RunnerDeps;
}): Promise<number> {
  const startedAt = input.deps.now().toISOString();
  const jobs = selectJobs(input.config.jobs, input.invalidJobs, input.onlyJob);
  if (input.onlyJob && jobs.runnable.length === 0 && jobs.invalid.length === 0) {
    input.logger.line(input.onlyJob, "配置里没有这个任务");
    const status = finish(input, startedAt, [{ id: input.onlyJob, status: "failed", error: "配置里没有这个任务", nginx: [] }], 2);
    return status.exitCode;
  }

  const ordered = [
    ...jobs.invalid.map((job) => ({ kind: "invalid" as const, index: job.index, job })),
    ...jobs.runnable.map((job) => ({ kind: "run" as const, index: job.index, job })),
  ].sort((a, b) => a.index - b.index);

  const results: JobRunResult[] = [];
  for (const item of ordered) {
    if (item.kind === "invalid") {
      input.logger.line(item.job.id, `配置不合法：${item.job.error}`);
      results.push({ id: item.job.id ?? `第 ${item.job.index + 1} 条`, status: "failed", error: item.job.error, nginx: [] });
      continue;
    }
    try {
      results.push(await runJob(item.job, input));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.logger.line(item.job.id, `失败：${message}`);
      results.push({ id: item.job.id, status: "failed", error: message, nginx: [] });
    }
  }
  const failed = results.filter((item) => item.status === "failed").length;
  const skipped = results.filter((item) => item.status === "skipped").length;
  const succeeded = results.filter((item) => item.status === "success").length;
  const exitCode = failed > 0 ? 2 : 0;
  input.logger.line(undefined, `汇总：总数 ${results.length}，跳过 ${skipped}，成功 ${succeeded}，失败 ${failed}`);
  finish(input, startedAt, results, exitCode);
  return exitCode;
}

/** 单条任务：跳过、签发、应用、钩子。抛错由 runAll 接住，后面的任务继续。 */
async function runJob(job: JobConfig, input: Parameters<typeof runAll>[0]): Promise<JobRunResult> {
  const logger = input.logger;
  if (!job.enabled) {
    logger.line(job.id, "已停用，跳过");
    return { id: job.id, status: "skipped", nginx: [] };
  }
  const state = readJobState(input.dataDir, job.id);
  const letsencryptDir = join(input.dataDir, "letsencrypt");
  const live = livePaths(letsencryptDir, job.id);
  const before = readCertificate(live.fullchain);
  const now = input.deps.now();
  const failedApply = hasFailedApply(job, state);
  const needsIssue =
    input.dryRun ||
    !before ||
    withinRenewWindow(before.notAfter, input.config.letsencrypt.renewBeforeDays, now) ||
    Boolean(state.lastIssueError);

  if (!needsIssue && !failedApply) {
    logger.line(job.id, `证书仍在续签窗口外，到期 ${before?.notAfter}，跳过`);
    return { id: job.id, status: "skipped", notAfter: before?.notAfter, nginx: nginxView(state, job) };
  }

  let issued = false;
  if (needsIssue) {
    logger.line(job.id, input.dryRun ? "开始 Certbot 演练" : "开始签发");
    mkdirSync(join(input.dataDir, "dns-records"), { recursive: true });
    const result = await runCertbot(
      {
        job,
        email: input.config.letsencrypt.email,
        staging: input.config.letsencrypt.staging,
        keyType: input.config.letsencrypt.keyType,
        configDir: letsencryptDir,
        workDir: join(letsencryptDir, "work"),
        logsDir: join(letsencryptDir, "logs"),
        dryRun: input.dryRun,
        forceRenewal: !input.dryRun && lineageExists(letsencryptDir, job.id),
        recordFile: join(input.dataDir, "dns-records", `${job.id}.json`),
        regionId: input.config.alibaba.regionId,
      },
      input.deps.exec,
    );
    if (input.dryRun) {
      if (result.code !== 0) {
        const error = certbotFailure(result);
        logger.line(job.id, `演练失败：${error}`);
        return { id: job.id, status: "failed", error, notAfter: before?.notAfter, nginx: [] };
      }
      logger.line(job.id, "演练模式，跳过 Nginx、CDN 和命令钩子");
      return { id: job.id, status: "success", notAfter: before?.notAfter, nginx: [] };
    }
    if (result.code !== 0) {
      state.lastIssueError = certbotFailure(result);
      writeJobState(input.dataDir, state);
      logger.line(job.id, `签发失败：${state.lastIssueError}`);
      return { id: job.id, status: "failed", error: state.lastIssueError, notAfter: before?.notAfter, nginx: [] };
    }
    state.lastIssueError = undefined;
    const afterIssue = readCertificate(live.fullchain);
    issued = Boolean(afterIssue && afterIssue.fingerprint !== before?.fingerprint);
    if (afterIssue) {
      state.fingerprint = afterIssue.fingerprint;
      state.notAfter = afterIssue.notAfter;
      if (issued) state.lastIssuedAt = now.toISOString();
    }
    logger.line(job.id, issued ? "签发成功" : "Certbot 没有写出新证书");
    writeJobState(input.dataDir, state);
  }

  const cert = readCertificate(live.fullchain);
  if (!cert) {
    const error = "数据卷里没有可用证书";
    writeJobState(input.dataDir, state);
    logger.line(job.id, error);
    return { id: job.id, status: "failed", error, nginx: [] };
  }

  const retryOnly = !issued && !needsIssue;
  let failed = false;
  const nginx: JobRunResult["nginx"] = [];
  for (const action of job.apply) {
    if (retryOnly && actionHealthy(action, state)) {
      if (action.type === "nginx") nginx.push(nginxResultFromState(action, state));
      continue;
    }
    if (action.type === "nginx") {
      const applied = await applyNginx(action, live.fullchain, live.privkey, input.deps.exec);
      const key = nginxDestination(action).fullchain;
      state.targets[key] = {
        ok: applied.ok,
        at: input.deps.now().toISOString(),
        error: applied.error,
        nginxTest: applied.nginxTest,
        nginxReload: applied.nginxReload,
      };
      nginx.push({
        path: applied.path,
        ok: applied.ok,
        nginxTest: applied.nginxTest,
        nginxReload: applied.nginxReload,
        error: applied.error,
      });
      logger.line(job.id, applied.ok ? `Nginx 已重载 ${applied.path}` : `Nginx 失败 ${applied.path}：${applied.error}`);
      if (!applied.ok) failed = true;
      continue;
    }
    const cdnResult = await applyCdn({
      jobId: job.id,
      domainNames: action.domainNames,
      cert: cert!,
      fullchainPath: live.fullchain,
      privkeyPath: live.privkey,
      state,
      now: input.deps.now(),
      certificates: input.deps.certificatesFor(job.credential),
      cdn: input.deps.cdnFor(job.credential),
    });
    if (cdnResult.cas) state.cas = cdnResult.cas;
    const at = input.deps.now().toISOString();
    for (const domain of cdnResult.domains) {
      state.targets[cdnTargetKey(domain.domain)] = { ok: domain.ok, at, error: domain.error };
    }
    if (cdnResult.domains.length === 0 && cdnResult.error) {
      for (const domain of action.domainNames) {
        state.targets[cdnTargetKey(domain)] = { ok: false, at, error: cdnResult.error };
      }
    }
    logger.line(job.id, cdnResult.ok ? "CDN 已更新" : `CDN 失败：${cdnResult.error}`);
    if (!cdnResult.ok) failed = true;
  }

  if (issued && job.hook && cert) {
    try {
      await runHook({
        command: job.hook.command,
        timeoutSeconds: job.hook.timeoutSeconds,
        exec: input.deps.exec,
        env: {
          ...process.env,
          CERT_JOB_ID: job.id,
          CERT_DOMAINS: job.domains.join(","),
          CERT_LIVE_DIR: live.dir,
          CERT_FULLCHAIN: live.fullchain,
          CERT_PRIVKEY: live.privkey,
          CERT_NOT_AFTER: cert.notAfter,
        },
      });
      state.targets.hook = { ok: true, at: input.deps.now().toISOString() };
      state.hookRanForFingerprint = cert.fingerprint;
      logger.line(job.id, "钩子完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.targets.hook = { ok: false, at: input.deps.now().toISOString(), error: message };
      failed = true;
      logger.line(job.id, `钩子失败：${message}`);
    }
  }

  if (cert) {
    state.fingerprint = cert.fingerprint;
    state.notAfter = cert.notAfter;
  }
  writeJobState(input.dataDir, state);
  return {
    id: job.id,
    status: failed ? "failed" : "success",
    error: failed ? "有应用动作或钩子失败" : undefined,
    notAfter: cert?.notAfter,
    nginx,
  };
}

/** `--job` 只留下这个 id；省略则留下全部合法与非法任务。 */
function selectJobs(jobs: JobConfig[], invalidJobs: InvalidJob[], onlyJob?: string): { runnable: JobConfig[]; invalid: InvalidJob[] } {
  if (!onlyJob) return { runnable: jobs, invalid: invalidJobs };
  return {
    runnable: jobs.filter((job) => job.id === onlyJob),
    invalid: invalidJobs.filter((job) => job.id === onlyJob),
  };
}

/** 任一 Nginx 路径或 CDN 域名在状态里不是 ok，就需要重试应用。 */
function hasFailedApply(job: JobConfig, state: JobState): boolean {
  return job.apply.some((action) => !actionHealthy(action, state));
}

/** Nginx 看目标 fullchain 路径；CDN 看每个 `cdn:<域名>` 是否上次成功。 */
function actionHealthy(action: ApplyAction, state: JobState): boolean {
  if (action.type === "nginx") return state.targets[nginxDestination(action).fullchain]?.ok === true;
  return action.domainNames.every((domain) => state.targets[cdnTargetKey(domain)]?.ok === true);
}

/** 跳过或重试时，把上次 nginx -t / reload 结果带进本轮 status.json。 */
function nginxResultFromState(action: Extract<ApplyAction, { type: "nginx" }>, state: JobState): JobRunResult["nginx"][number] {
  const path = nginxDestination(action).fullchain;
  const saved = state.targets[path];
  return {
    path,
    ok: saved?.ok === true,
    nginxTest: saved?.nginxTest ?? "skipped",
    nginxReload: saved?.nginxReload ?? "skipped",
    error: saved?.error,
  };
}

/** 整条任务被跳过时，仍把已有 Nginx 动作结果写进汇总。 */
function nginxView(state: JobState, job: JobConfig): JobRunResult["nginx"] {
  return job.apply.filter((action) => action.type === "nginx").map((action) => nginxResultFromState(action, state));
}

/** 把本轮汇总写到 dataDir/status.json，给第二期控制机读。 */
function finish(
  input: Parameters<typeof runAll>[0],
  startedAt: string,
  jobs: JobRunResult[],
  exitCode: number,
): StatusFile {
  const status: StatusFile = {
    serverName: input.config.serverName?.trim() || input.deps.hostname || hostname(),
    startedAt,
    finishedAt: input.deps.now().toISOString(),
    exitCode,
    logPath: input.logger.path,
    jobs,
  };
  writeStatus(input.dataDir, status);
  return status;
}
