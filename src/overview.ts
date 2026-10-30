import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { cdnTargetKey } from "./cdn.js";
import { loadConfig, nginxDestination } from "./config.js";
import { isPaused, isRunRequested, readScheduler, schedulerOnline } from "./control.js";
import { readJobState } from "./state.js";
import type { ApplyAction, JobConfig, JobRunResult, JobState, StatusFile } from "./types.js";

const LOG_TAIL_LINES = 200;
const LOG_TAIL_BYTES = 64 * 1024;
const JOB_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface OverviewNginx {
  path: string;
  nginxTest: "passed" | "failed" | "skipped";
  nginxReload: "passed" | "failed" | "skipped";
  ok: boolean;
  error: string | null;
}

export interface OverviewCdn {
  domain: string;
  ok: boolean | null;
  error: string | null;
  text: string;
}

export type JobViewStatus = "success" | "skipped" | "failed" | "invalid" | "absent";

export interface OverviewJob {
  id: string;
  enabled: boolean | null;
  enabledText: string;
  domains: string[];
  inConfig: boolean;
  status: JobViewStatus;
  statusText: string;
  error: string | null;
  notAfter: string | null;
  notAfterText: string | null;
  expiryText: string | null;
  fingerprintPrefix: string | null;
  cas: { certId: number; name: string } | null;
  nginx: OverviewNginx[];
  cdn: OverviewCdn[];
  hook: "有" | "无";
}

export interface Overview {
  server: {
    serverName: string;
    scheduler: {
      online: boolean;
      activity: "offline" | "running" | "paused" | "sleeping";
      activityText: string;
      paused: boolean;
      runPending: boolean;
      updatedAt: string | null;
      nextRunAt: string | null;
      nextRunText: string | null;
      note: string | null;
    };
    lastRun: {
      startedAt: string;
      finishedAt: string;
      startedText: string | null;
      finishedText: string | null;
      exitCode: number;
      counts: { total: number; success: number; skipped: number; failed: number };
      summaryText: string;
    } | null;
    configError: string | null;
    statusError: string | null;
    renewBeforeDays: number | null;
    jobs: OverviewJob[];
  };
  log: { lines: string[]; missing: boolean; message: string | null };
}

/** 把本机配置、最近一轮、任务状态和心跳收成一页。不读证书和密钥。 */
export function loadOverview(input: { dataDir: string; configPath: string; now: Date; timeZone: string }): Overview {
  const loaded = loadConfig(input.configPath);
  const statusRead = readStatusFile(input.dataDir);
  const status = statusRead.status;
  const paused = isPaused(input.dataDir);
  const runPending = isRunRequested(input.dataDir);
  const snapshot = readScheduler(input.dataDir);
  const online = schedulerOnline(snapshot, input.now);
  const activity = !online ? "offline" : snapshot?.state === "running" ? "running" : paused ? "paused" : "sleeping";
  const activityText = activity === "offline" ? "调度未在运行" : activity === "running" ? "正在检查" : activity === "paused" ? "已暂停" : "等待下次检查";
  const notes: string[] = [];
  if (!online) notes.push("调度未在运行。按钮会记下操作，调度进程起来后才会执行。");
  else if (activity === "running" && paused) notes.push("暂停已记下，当前这轮会跑完。");
  else if (paused) notes.push("到点不会检查。");
  if (runPending && activity === "running") notes.push("这一轮结束后再跑一轮。");
  else if (runPending) notes.push("已请求，等待调度开始。");
  if (statusRead.error) notes.push(`${statusRead.error}。`);

  const renewBeforeDays = loaded.ok ? loaded.config.letsencrypt.renewBeforeDays : null;
  const serverName = status?.serverName?.trim() || (loaded.ok ? loaded.config.serverName?.trim() : "") || "未命名";
  const jobs = loaded.ok ? buildJobs(input.dataDir, loaded.config.jobs, loaded.invalidJobs, status, input.now, renewBeforeDays, input.timeZone) : [];
  const log = statusRead.error
    ? { lines: [], missing: true, message: statusRead.error }
    : readLogTail(input.dataDir, status?.logPath);

  const counts = countJobs(status);
  return {
    server: {
      serverName,
      scheduler: {
        online,
        activity,
        activityText,
        paused,
        runPending,
        updatedAt: snapshot?.updatedAt ?? null,
        nextRunAt: snapshot?.nextRunAt ?? null,
        nextRunText: formatTime(snapshot?.nextRunAt ?? null, input.timeZone),
        note: notes.length > 0 ? notes.join("") : null,
      },
      lastRun: status
        ? {
            startedAt: status.startedAt,
            finishedAt: status.finishedAt,
            startedText: formatTime(status.startedAt, input.timeZone),
            finishedText: formatTime(status.finishedAt, input.timeZone),
            exitCode: status.exitCode,
            counts,
            summaryText: `退出码 ${status.exitCode}，成功 ${counts.success}，跳过 ${counts.skipped}，失败 ${counts.failed}`,
          }
        : null,
      configError: loaded.ok ? null : loaded.error,
      statusError: statusRead.error,
      renewBeforeDays,
      jobs,
    },
    log,
  };
}

/** 只读 status.json 指向的、且落在数据目录 logs/ 下的文件末尾。 */
export function readLogTail(dataDir: string, logPath: string | undefined): { lines: string[]; missing: boolean; message: string | null } {
  if (!logPath) return { lines: [], missing: true, message: "还没有日志" };
  const logsDir = join(dataDir, "logs");
  let root: string;
  try {
    root = realpathSync(logsDir);
  } catch {
    return { lines: [], missing: true, message: "日志文件不在" };
  }
  let file: string;
  try {
    file = realpathSync(logPath);
  } catch {
    return insideDir(root, resolveInside(logPath))
      ? { lines: [], missing: true, message: "日志文件不在" }
      : { lines: [], missing: true, message: "日志路径不合法" };
  }
  if (!insideDir(root, file)) return { lines: [], missing: true, message: "日志路径不合法" };
  let size = 0;
  try {
    const info = statSync(file);
    if (!info.isFile()) return { lines: [], missing: true, message: "日志路径不合法" };
    size = info.size;
  } catch {
    return { lines: [], missing: true, message: "日志文件不在" };
  }
  const start = Math.max(0, size - LOG_TAIL_BYTES);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { lines: lines.slice(-LOG_TAIL_LINES), missing: false, message: null };
  } finally {
    closeSync(fd);
  }
}

function resolveInside(logPath: string): string {
  return isAbsolute(logPath) ? logPath : join(process.cwd(), logPath);
}

function insideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "" || rel === "..") return false;
  if (rel.startsWith(`..${sep}`) || rel.startsWith("../") || rel.startsWith("..\\")) return false;
  return !isAbsolute(rel);
}

function readStatusFile(dataDir: string): { status: StatusFile | null; error: string | null } {
  const path = join(dataDir, "status.json");
  if (!existsSync(path)) return { status: null, error: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StatusFile;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.jobs)) return { status: null, error: "状态文件读不了" };
    return { status: parsed, error: null };
  } catch {
    return { status: null, error: "状态文件读不了" };
  }
}

function countJobs(status: StatusFile | null): { total: number; success: number; skipped: number; failed: number } {
  const jobs = status?.jobs ?? [];
  return {
    total: jobs.length,
    success: jobs.filter((job) => job.status === "success").length,
    skipped: jobs.filter((job) => job.status === "skipped").length,
    failed: jobs.filter((job) => job.status === "failed").length,
  };
}

function buildJobs(
  dataDir: string,
  jobs: JobConfig[],
  invalid: { index: number; id?: string; error: string }[],
  status: StatusFile | null,
  now: Date,
  renewBeforeDays: number | null,
  timeZone: string,
): OverviewJob[] {
  const rows: OverviewJob[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...jobs.map((job) => ({ index: job.index, job, invalid: null as { index: number; id?: string; error: string } | null })),
    ...invalid.map((item) => ({ index: item.index, job: null as JobConfig | null, invalid: item })),
  ].sort((a, b) => a.index - b.index);

  for (const item of ordered) {
    if (item.invalid) {
      const id = item.invalid.id && item.invalid.id.length > 0 ? item.invalid.id : `第 ${item.invalid.index + 1} 条`;
      seen.add(id);
      rows.push(emptyJob(id, "invalid", item.invalid.error, false));
      continue;
    }
    const job = item.job;
    if (!job) continue;
    seen.add(job.id);
    const statusJob = status?.jobs.find((entry) => entry.id === job.id);
    const state = readState(dataDir, job.id);
    const nginx = statusJob && Array.isArray(statusJob.nginx) ? nginxFromStatus(statusJob.nginx) : nginxFromConfig(job, state.state);
    const domains = job.apply
      .filter((action): action is Extract<ApplyAction, { type: "aliyun-cdn" }> => action.type === "aliyun-cdn")
      .flatMap((action) => action.domainNames);
    rows.push(finishJob({
      id: job.id,
      enabled: job.enabled,
      domains: job.domains,
      inConfig: true,
      status: statusJob ? asStatus(statusJob.status) : "absent",
      error: statusJob?.error ?? state.error,
      notAfter: statusJob?.notAfter ?? state.state.notAfter ?? null,
      state: state.state,
      nginx,
      cdnDomains: domains,
      hook: job.hook ? "有" : "无",
      now,
      renewBeforeDays,
      timeZone,
    }));
  }

  for (const entry of status?.jobs ?? []) {
    if (seen.has(entry.id)) continue;
    const state = safeId(entry.id) ? readState(dataDir, entry.id) : { state: emptyState(entry.id), error: null };
    const domains = Object.keys(state.state.targets)
      .filter((key) => key.startsWith("cdn:"))
      .map((key) => key.slice(4));
    rows.push(finishJob({
      id: entry.id,
      enabled: null,
      domains: [],
      inConfig: false,
      status: asStatus(entry.status),
      error: entry.error ?? state.error,
      notAfter: entry.notAfter ?? state.state.notAfter ?? null,
      state: state.state,
      nginx: nginxFromStatus(Array.isArray(entry.nginx) ? entry.nginx : []),
      cdnDomains: domains,
      hook: "无",
      now,
      renewBeforeDays,
      timeZone,
    }));
  }
  return rows;
}

function finishJob(input: {
  id: string;
  enabled: boolean | null;
  domains: string[];
  inConfig: boolean;
  status: JobViewStatus;
  error: string | null;
  notAfter: string | null;
  state: JobState;
  nginx: OverviewNginx[];
  cdnDomains: string[];
  hook: "有" | "无";
  now: Date;
  renewBeforeDays: number | null;
  timeZone: string;
}): OverviewJob {
  const expiry = expiryText(input.notAfter, input.now, input.renewBeforeDays);
  const fingerprint = input.state.fingerprint ?? "";
  return {
    id: input.id,
    enabled: input.enabled,
    enabledText: input.enabled === true ? "启用" : input.enabled === false ? "已停用" : "—",
    domains: input.domains,
    inConfig: input.inConfig,
    status: input.status,
    statusText: statusText(input.status, input.inConfig),
    error: input.error,
    notAfter: input.notAfter,
    notAfterText: formatTime(input.notAfter, input.timeZone),
    expiryText: expiry.text,
    fingerprintPrefix: fingerprint.length > 0 ? fingerprint.slice(0, 12) : null,
    cas: input.state.cas && typeof input.state.cas.certId === "number" ? { certId: input.state.cas.certId, name: input.state.cas.name } : null,
    nginx: input.nginx,
    cdn: cdnRows(input.cdnDomains, input.state),
    hook: input.hook,
  };
}

function emptyJob(id: string, status: JobViewStatus, error: string, inConfig: boolean): OverviewJob {
  return {
    id,
    enabled: null,
    enabledText: "—",
    domains: [],
    inConfig,
    status,
    statusText: statusText(status, inConfig),
    error,
    notAfter: null,
    notAfterText: null,
    expiryText: null,
    fingerprintPrefix: null,
    cas: null,
    nginx: [],
    cdn: [],
    hook: "无",
  };
}

function statusText(status: JobViewStatus, inConfig: boolean): string {
  const label = status === "success" ? "成功" : status === "skipped" ? "跳过" : status === "failed" ? "失败" : status === "invalid" ? "配置不合法" : "还没有跑过";
  return inConfig ? label : `${label}（配置里已没有）`;
}

function asStatus(status: JobRunResult["status"] | undefined): JobViewStatus {
  if (status === "success" || status === "skipped" || status === "failed") return status;
  return "failed";
}

function nginxFromStatus(rows: JobRunResult["nginx"]): OverviewNginx[] {
  return rows.map((row) => ({
    path: row.path,
    nginxTest: asCheck(row.nginxTest),
    nginxReload: asCheck(row.nginxReload),
    ok: row.ok === true,
    error: row.error ?? null,
  }));
}

function nginxFromConfig(job: JobConfig, state: JobState): OverviewNginx[] {
  return job.apply.filter((action): action is Extract<ApplyAction, { type: "nginx" }> => action.type === "nginx").map((action) => {
    const path = nginxDestination(action).fullchain;
    const saved = state.targets[path];
    return {
      path,
      nginxTest: asCheck(saved?.nginxTest),
      nginxReload: asCheck(saved?.nginxReload),
      ok: saved?.ok === true,
      error: saved?.error ?? null,
    };
  });
}

function cdnRows(domains: string[], state: JobState): OverviewCdn[] {
  return domains.map((domain) => {
    const saved = state.targets[cdnTargetKey(domain)];
    if (!saved) return { domain, ok: null, error: null, text: "尚未绑定" };
    if (saved.ok) return { domain, ok: true, error: null, text: "已绑定" };
    return { domain, ok: false, error: saved.error ?? null, text: saved.error ?? "绑定失败" };
  });
}

function readState(dataDir: string, id: string): { state: JobState; error: string | null } {
  try {
    return { state: readJobState(dataDir, id), error: null };
  } catch {
    return { state: emptyState(id), error: "状态读不了" };
  }
}

function emptyState(id: string): JobState {
  return { jobId: id, certName: id, targets: {} };
}

function safeId(id: string): boolean {
  return JOB_ID.test(id);
}

function asCheck(value: unknown): "passed" | "failed" | "skipped" {
  if (value === "passed" || value === "failed" || value === "skipped") return value;
  return "skipped";
}

function expiryText(notAfter: string | null, now: Date, renewBeforeDays: number | null): { text: string | null } {
  if (!notAfter) return { text: null };
  const at = Date.parse(notAfter);
  if (Number.isNaN(at)) return { text: null };
  const days = Math.floor((at - now.getTime()) / 86_400_000);
  const when = days < 0 ? `已过期 ${-days} 天` : `剩余 ${days} 天`;
  const window = renewBeforeDays === null ? "" : `，续签窗口 ${renewBeforeDays} 天`;
  return { text: `${when}${window}` };
}

function formatTime(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(date);
  } catch {
    return iso;
  }
}
