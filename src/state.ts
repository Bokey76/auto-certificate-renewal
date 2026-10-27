import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JobState, StatusFile } from "./types.js";

/** 单条任务状态文件：dataDir/state/<jobId>.json。 */
export function jobStatePath(dataDir: string, jobId: string): string {
  return join(dataDir, "state", `${jobId}.json`);
}

/** 读任务状态。没有文件时返回空 targets，不算失败。 */
export function readJobState(dataDir: string, jobId: string): JobState {
  const path = jobStatePath(dataDir, jobId);
  if (!existsSync(path)) {
    return { jobId, certName: jobId, targets: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JobState;
  return { ...parsed, jobId, certName: jobId, targets: parsed.targets ?? {} };
}

/** 覆盖写入任务状态：指纹、到期、各目标成败、CAS CertId。 */
export function writeJobState(dataDir: string, state: JobState): void {
  const path = jobStatePath(dataDir, state.jobId);
  mkdirSync(join(dataDir, "state"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 写本轮汇总 status.json，第二期控制机读这份。 */
export function writeStatus(dataDir: string, status: StatusFile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}
