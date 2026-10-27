import type { Exec } from "./types.js";

export async function runHook(input: {
  command: string;
  timeoutSeconds: number;
  env: NodeJS.ProcessEnv;
  exec: Exec;
}): Promise<void> {
  const result = await input.exec(["/bin/sh", "-c", input.command], {
    env: input.env,
    timeoutMs: input.timeoutSeconds * 1000,
  });
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim();
    throw new Error(detail.length > 0 ? detail : `钩子退出码 ${result.code}`);
  }
}
