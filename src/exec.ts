import { spawn } from "node:child_process";
import type { Exec, ExecResult } from "./types.js";

/** 跑子进程。timeoutMs 到期会 kill。测试用假 Exec 替换，不走这里。 */
export const spawnExec: Exec = (argv, options = {}) =>
  new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error("命令为空"));
      return;
    }
    const child = spawn(argv[0], argv.slice(1), {
      env: options.env ?? process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            child.kill();
          }, options.timeoutMs)
        : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** 默认 `nsenter -t 1 -m -- <nginx>`。CERT_RENEW_DIRECT_NGINX=1 时不加 nsenter。 */
export function nginxArgv(bin: string, args: string[]): string[] {
  if (process.env.CERT_RENEW_DIRECT_NGINX === "1") return [bin, ...args];
  return ["nsenter", "-t", "1", "-m", "--", bin, ...args];
}

/** 优先 stderr，空则 stdout，再空则「退出码 N」。 */
export function outputOf(result: ExecResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  return text.length > 0 ? text : `退出码 ${result.code}`;
}
