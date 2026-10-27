import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Logger {
  line(jobId: string | undefined, message: string): void;
  path: string;
}

/** 一行同时写 stdout 和文件。格式：ISO 时间 [任务id] 中文说明。 */
export function createLogger(logPath: string): Logger {
  mkdirSync(dirname(logPath), { recursive: true });
  return {
    path: logPath,
    line(jobId, message) {
      const id = jobId && jobId.length > 0 ? jobId : "-";
      const text = `${new Date().toISOString()} [${id}] ${message}`;
      process.stdout.write(`${text}\n`);
      appendFileSync(logPath, `${text}\n`, "utf8");
    },
  };
}
