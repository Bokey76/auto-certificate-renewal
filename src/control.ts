import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
export function requestRun(dataDir: string, at: string): { already: boolean } {
  mkdirSync(controlDir(dataDir), { recursive: true });
  if (existsSync(runRequestPath(dataDir))) return { already: true };
  writeFileSync(runRequestPath(dataDir), at, "utf8");
  return { already: false };
}

/** 调度开始跑之前删掉请求。没有请求时返回 false。 */
export function consumeRunRequest(dataDir: string): boolean {
  if (!existsSync(runRequestPath(dataDir))) return false;
  rmSync(runRequestPath(dataDir), { force: true });
  return true;
}

/** 原子写入 scheduler.json。先写临时文件再改名，避免网页读到半截 JSON。 */
export function writeScheduler(dataDir: string, snapshot: SchedulerSnapshot): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "scheduler.json");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
  try {
    renameSync(tmp, path);
  } catch {
    rmSync(path, { force: true });
    renameSync(tmp, path);
  }
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
