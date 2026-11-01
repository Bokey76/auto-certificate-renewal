import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./write-file.js";

/** 调度进程心跳。超过这个毫秒数没有更新，网页视为未在运行。 */
export const HEARTBEAT_STALE_MS = 20_000;

export type SchedulerActivity = "running" | "sleeping" | "paused";

export interface SchedulerSnapshot {
  updatedAt: string;
  state: SchedulerActivity;
  paused: boolean;
  nextRunAt: string | null;
  runPending: boolean;
}

export interface RunRequest {
  at: string;
  jobId: string | null;
  dryRun: boolean;
  force: boolean;
}

function controlDir(dataDir: string): string {
  return join(dataDir, "control");
}

function pausedPath(dataDir: string): string {
  return join(controlDir(dataDir), "paused");
}

function runRequestPath(dataDir: string): string {
  return join(controlDir(dataDir), "run-request");
}

/** 数据卷里有 control/paused 就是暂停。文件可以跨容器重启保留。 */
export function isPaused(dataDir: string): boolean {
  return existsSync(pausedPath(dataDir));
}

/** 网页创建或删除暂停标记。重复调用结果一样。 */
export function setPaused(dataDir: string, paused: boolean): void {
  mkdirSync(controlDir(dataDir), { recursive: true });
  if (paused) writeFileSync(pausedPath(dataDir), "", "utf8");
  else rmSync(pausedPath(dataDir), { force: true });
}

/** 还有一次尚未被调度进程取走的检查。 */
export function isRunRequested(dataDir: string): boolean {
  return existsSync(runRequestPath(dataDir));
}

/** 记下再跑一轮。已经有请求时不覆盖，调用方可以告诉用户「已经记下」。 */
export function requestRun(dataDir: string, request: RunRequest): { already: boolean } {
  mkdirSync(controlDir(dataDir), { recursive: true });
  if (existsSync(runRequestPath(dataDir))) return { already: true };
  atomicWrite(runRequestPath(dataDir), `${JSON.stringify(request)}\n`);
  return { already: false };
}

/** 读尚未取走的请求。没有或坏内容时返回 null。 */
export function readRunRequest(dataDir: string): RunRequest | null {
  const path = runRequestPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    return parseRunRequest(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** 调度开始跑之前取走请求。没有请求时返回 null。 */
export function consumeRunRequest(dataDir: string): RunRequest | null {
  const request = readRunRequest(dataDir);
  if (!request) {
    rmSync(runRequestPath(dataDir), { force: true });
    return null;
  }
  rmSync(runRequestPath(dataDir), { force: true });
  return request;
}

function parseRunRequest(text: string): RunRequest | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{")) {
    if (Number.isNaN(Date.parse(trimmed))) return null;
    return { at: trimmed, jobId: null, dryRun: false, force: false };
  }
  const parsed = JSON.parse(trimmed) as Partial<RunRequest>;
  if (typeof parsed.at !== "string" || Number.isNaN(Date.parse(parsed.at))) return null;
  const jobId = parsed.jobId === undefined || parsed.jobId === null ? null : parsed.jobId;
  if (jobId !== null && (typeof jobId !== "string" || jobId.trim() === "")) return null;
  return {
    at: parsed.at,
    jobId,
    dryRun: parsed.dryRun === true,
    force: parsed.force === true,
  };
}

/** 原子写入 scheduler.json。先写临时文件再改名，避免网页读到半截 JSON。 */
export function writeScheduler(dataDir: string, snapshot: SchedulerSnapshot): void {
  mkdirSync(dataDir, { recursive: true });
  atomicWrite(join(dataDir, "scheduler.json"), `${JSON.stringify(snapshot)}\n`);
}

/** 读心跳。文件不存在或 JSON 不完整时返回 null，网页不当成在线。 */
export function readScheduler(dataDir: string): SchedulerSnapshot | null {
  const path = join(dataDir, "scheduler.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SchedulerSnapshot>;
    if (typeof parsed.updatedAt !== "string" || Number.isNaN(Date.parse(parsed.updatedAt))) return null;
    if (parsed.state !== "running" && parsed.state !== "sleeping" && parsed.state !== "paused") return null;
    return {
      updatedAt: parsed.updatedAt,
      state: parsed.state,
      paused: parsed.paused === true,
      nextRunAt: typeof parsed.nextRunAt === "string" ? parsed.nextRunAt : null,
      runPending: parsed.runPending === true,
    };
  } catch {
    return null;
  }
}

/** 心跳时间落在当前时刻前后一个窗口内才算在线。 */
export function schedulerOnline(snapshot: SchedulerSnapshot | null, now: Date): boolean {
  if (!snapshot) return false;
  const at = Date.parse(snapshot.updatedAt);
  const drift = Math.abs(now.getTime() - at);
  return drift <= HEARTBEAT_STALE_MS;
}
