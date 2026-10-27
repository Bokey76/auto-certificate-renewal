import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { JobState, StatusFile } from "./types.js";

export function jobStatePath(dataDir: string, jobId: string): string {
  return join(dataDir, "state", `${jobId}.json`);
}

export function readJobState(dataDir: string, jobId: string): JobState {
  const path = jobStatePath(dataDir, jobId);
  if (!existsSync(path)) {
    return { jobId, certName: jobId, targets: {} };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JobState;
  return { ...parsed, jobId, certName: jobId, targets: parsed.targets ?? {} };
}

export function writeJobState(dataDir: string, state: JobState): void {
  const path = jobStatePath(dataDir, state.jobId);
  mkdirSync(join(dataDir, "state"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function writeStatus(dataDir: string, status: StatusFile): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

export function readOffsetMinutes(dataDir: string): number {
  const path = join(dataDir, "schedule-offset.json");
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { minutes?: number };
    if (typeof parsed.minutes === "number" && parsed.minutes >= 0 && parsed.minutes <= 30) return parsed.minutes;
  }
  const minutes = Math.floor(Math.random() * 31);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ minutes }, null, 2)}\n`, "utf8");
  return minutes;
}
