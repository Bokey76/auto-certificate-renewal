/** 把配置、最近一轮、任务状态和调度心跳收成网页用的一页数据。不读证书和密钥。 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { loadConfig, nginxDestination } from "../config/config.js";
import { cdnTargetKey } from "../renew/cdn.js";
import { readJobState } from "../renew/state.js";
import { isPaused, isRunRequested, readRunRequest, readScheduler, schedulerOnline } from "../schedule/control.js";
import type { ApplyAction, JobConfig, JobRunResult, JobState, StatusFile } from "../lib/types.js";

const LOG_TAIL_LINES = 200;
const LOG_TAIL_MAX_LINES = 20_000;
const LOG_DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024;
const LOG_READ_CHUNK = 64 * 1024;
const LOG_LIST_LIMIT = 50;
const LOG_NAME = /^[A-Za-z0-9._-]+\.log$/;
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
      runRequest: { jobId: string | null; dryRun: boolean; force: boolean } | null;
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
  log: OverviewLog;
  logs: { current: string | null; files: LogFileView[] };
}

export interface OverviewLog {
  name: string | null;
  lines: string[];
  missing: boolean;
  message: string | null;
  hasMore: boolean;
}

export interface LogFileView {
  name: string;
  label: string;
  current: boolean;
}

/** 日志文件名必须是 logs 目录下的裸名字，不能带路径。 */
export function isLogName(name: string): boolean {
  return name.length > 4 && name.length <= 128 && LOG_NAME.test(name);
}

/** 把本机配置、最近一轮、任务状态和心跳收成一页。不读证书和密钥。 */
export function loadOverview(input: { dataDir: string; configPath: string; now: Date; timeZone: string }): Overview {
  const loaded = loadConfig(input.configPath);
  const statusRead = readStatusFile(input.dataDir);
  const status = statusRead.status;
  const paused = isPaused(input.dataDir);
  const runPending = isRunRequested(input.dataDir);
  const runRequest = readRunRequest(input.dataDir);
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
  const current = currentLogName(input.dataDir, status?.logPath);
  const files = listLogFiles(input.dataDir, current, input.timeZone);
  const log: OverviewLog = statusRead.error
    ? emptyLog(statusRead.error, current)
    : current
      ? readLogByName(input.dataDir, current)
      : { name: null, ...readLogTail(input.dataDir, status?.logPath) };

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
        runRequest: runRequest ? { jobId: runRequest.jobId, dryRun: runRequest.dryRun, force: runRequest.force } : null,
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
    logs: { current, files },
  };
}

/** 网页 `tail` 查询。缺省 200 行，上限 20000。 */
export function parseLogTail(raw: string | null): number | { error: string } {
  if (raw == null || raw === "") return LOG_TAIL_LINES;
  if (!/^[1-9][0-9]{0,6}$/.test(raw)) return { error: "tail 必须是正整数" };
  return Math.min(Number(raw), LOG_TAIL_MAX_LINES);
}

/** 只读 status.json 指向的、且落在数据目录 logs/ 下的文件末尾。 */
export function readLogTail(
  dataDir: string,
  logPath: string | undefined,
  lineLimit = LOG_TAIL_LINES,
): { lines: string[]; missing: boolean; message: string | null; hasMore: boolean } {
  const located = locateLogFile(dataDir, logPath);
  if (!located.ok) return { lines: [], missing: true, message: located.message, hasMore: false };
  return { ...readLastLines(located.file, located.size, lineLimit), missing: false, message: null };
}

/** 按裸文件名读 logs/ 下某一文件末尾。非法名字不读盘。 */
export function readLogByName(dataDir: string, name: string, lineLimit = LOG_TAIL_LINES): OverviewLog {
  if (!isLogName(name)) return emptyLog("日志路径不合法");
  const tail = readLogTail(dataDir, join(dataDir, "logs", name), lineLimit);
  return { name, ...tail };
}

/** 下载整个日志文件。只允许 logs/ 下的裸文件名。 */
export function readLogDownload(
  dataDir: string,
  name: string,
): { ok: true; name: string; text: string } | { ok: false; error: string; status: 400 | 404 | 413 } {
  if (!isLogName(name)) return { ok: false, error: "日志路径不合法", status: 400 };
  const located = locateLogFile(dataDir, join(dataDir, "logs", name));
  if (!located.ok) {
    const status = located.message === "日志路径不合法" ? 400 : 404;
    return { ok: false, error: located.message, status };
  }
  if (located.size > LOG_DOWNLOAD_MAX_BYTES) {
    return { ok: false, error: "日志文件过大，请在服务器上查看 data/logs/", status: 413 };
  }
  return { ok: true, name, text: readFileSync(located.file, "utf8") };
}

function emptyLog(message: string, name: string | null = null): OverviewLog {
  return { name, lines: [], missing: true, message, hasMore: false };
}

function locateLogFile(
  dataDir: string,
  logPath: string | undefined,
): { ok: true; file: string; size: number } | { ok: false; message: string } {
  if (!logPath) return { ok: false, message: "还没有日志" };
  const logsDir = join(dataDir, "logs");
  let root: string;
  try {
    root = realpathSync(logsDir);
  } catch {
    return { ok: false, message: "日志文件不在" };
  }
  let file: string;
  try {
    file = realpathSync(logPath);
  } catch {
    return { ok: false, message: insideDir(root, resolveInside(logPath)) ? "日志文件不在" : "日志路径不合法" };
  }
  if (!insideDir(root, file)) return { ok: false, message: "日志路径不合法" };
  try {
    const info = statSync(file);
    if (!info.isFile()) return { ok: false, message: "日志路径不合法" };
    return { ok: true, file, size: info.size };
  } catch {
    return { ok: false, message: "日志文件不在" };
  }
}

function readLastLines(file: string, size: number, lineLimit: number): { lines: string[]; hasMore: boolean } {
  if (size === 0 || lineLimit <= 0) return { lines: [], hasMore: false };
  const fd = openSync(file, "r");
  try {
    let pos = size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    while (pos > 0) {
      const n = Math.min(LOG_READ_CHUNK, pos);
      pos -= n;
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, pos);
      chunks.unshift(buf);
      for (let i = 0; i < buf.length; i += 1) {
        if (buf[i] === 10) newlines += 1;
      }
      if (newlines > lineLimit) break;
    }
    let text = Buffer.concat(chunks).toString("utf8");
    const startedMidFile = pos > 0;
    if (startedMidFile) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return { lines: lines.slice(-lineLimit), hasMore: startedMidFile || lines.length > lineLimit };
  } finally {
    closeSync(fd);
  }
}

/** 列出 logs/ 下最近的日志文件，新的在前。最多 50 个。 */
export function listLogFiles(dataDir: string, currentName: string | null, timeZone: string): LogFileView[] {
  const logsDir = join(dataDir, "logs");
  let names: string[] = [];
  try {
    names = readdirSync(logsDir).filter((entry) => {
      if (!isLogName(entry)) return false;
      try {
        return statSync(join(logsDir, entry)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    names = [];
  }
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (currentName && isLogName(currentName) && !names.includes(currentName)) names.unshift(currentName);
  return names.slice(0, LOG_LIST_LIMIT).map((name) => ({
    name,
    label: logLabel(name, timeZone),
    current: name === currentName,
  }));
}

function currentLogName(dataDir: string, logPath: string | undefined): string | null {
  if (!logPath) return null;
  const logsDir = join(dataDir, "logs");
  let root: string;
  try {
    root = realpathSync(logsDir);
  } catch {
    return null;
  }
  try {
    const file = realpathSync(logPath);
    if (!insideDir(root, file)) return null;
    const name = basename(file);
    return isLogName(name) ? name : null;
  } catch {
    const name = basename(logPath);
    if (!isLogName(name)) return null;
    try {
      const candidate = realpathSync(join(root, name));
      return insideDir(root, candidate) ? name : null;
    } catch {
      return null;
    }
  }
}

function logLabel(name: string, timeZone: string): string {
  const stamp = name.replace(/\.log$/i, "");
  const iso = stamp.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}(?:\.\d+)?Z)$/, "$1:$2:$3");
  return formatTime(iso, timeZone) ?? name;
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
