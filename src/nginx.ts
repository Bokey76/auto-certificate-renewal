import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { nginxDestination } from "./config.js";
import { nginxArgv, outputOf } from "./exec.js";
import type { ApplyAction, Exec } from "./types.js";

export interface NginxApplyResult {
  ok: boolean;
  path: string;
  nginxTest: "passed" | "failed" | "skipped";
  nginxReload: "passed" | "failed" | "skipped";
  error?: string;
}

const BAK = ".bak-cert-renew";

export async function applyNginx(
  action: Extract<ApplyAction, { type: "nginx" }>,
  sourceFullchain: string,
  sourcePrivkey: string,
  exec: Exec,
): Promise<NginxApplyResult> {
  const dest = nginxDestination(action);
  const report = (partial: Omit<NginxApplyResult, "path">): NginxApplyResult => ({ path: dest.fullchain, ...partial });
  let fullchainBak: string | undefined;
  let privkeyBak: string | undefined;
  let replaced = false;
  let rolledBack = false;
  const rollback = (): void => {
    if (rolledBack || !replaced) return;
    rolledBack = true;
    restore(dest.fullchain, fullchainBak);
    restore(dest.privkey, privkeyBak);
  };
  try {
    mkdirSync(dirname(dest.fullchain), { recursive: true });
    mkdirSync(dirname(dest.privkey), { recursive: true });
    fullchainBak = backup(dest.fullchain);
    privkeyBak = backup(dest.privkey);
    writeFileSync(dest.fullchain, readFileSync(sourceFullchain));
    writeFileSync(dest.privkey, readFileSync(sourcePrivkey));
    replaced = true;
    chmodSync(dest.fullchain, 0o644);
    chmodSync(dest.privkey, 0o600);

    const test = await exec(nginxArgv(dest.bin, ["-t"]));
    if (test.code !== 0) {
      rollback();
      return report({ ok: false, nginxTest: "failed", nginxReload: "skipped", error: outputOf(test) });
    }

    const reload = await exec(nginxArgv(dest.bin, ["-s", "reload"]));
    if (reload.code !== 0) {
      rollback();
      const again = await exec(nginxArgv(dest.bin, ["-s", "reload"]));
      const detail = again.code === 0 ? outputOf(reload) : `${outputOf(reload)}；还原后 reload 也失败：${outputOf(again)}`;
      return report({ ok: false, nginxTest: "passed", nginxReload: "failed", error: detail });
    }

    removeBak(fullchainBak);
    removeBak(privkeyBak);
    return report({ ok: true, nginxTest: "passed", nginxReload: "passed" });
  } catch (error) {
    try {
      rollback();
    } catch {
      // 还原失败时仍返回原来的错误。
    }
    return report({
      ok: false,
      nginxTest: "skipped",
      nginxReload: "skipped",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function backup(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const bak = `${file}${BAK}`;
  copyFileSync(file, bak);
  return bak;
}

function restore(file: string, bak: string | undefined): void {
  if (bak && existsSync(bak)) {
    copyFileSync(bak, file);
    rmSync(bak, { force: true });
    return;
  }
  rmSync(file, { force: true });
}

function removeBak(bak: string | undefined): void {
  if (bak) rmSync(bak, { force: true });
}

export function livePaths(configDir: string, jobId: string): { dir: string; fullchain: string; privkey: string } {
  const dir = join(configDir, "live", jobId);
  return { dir, fullchain: join(dir, "fullchain.pem"), privkey: join(dir, "privkey.pem") };
}
