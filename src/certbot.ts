import { existsSync } from "node:fs";
import { join } from "node:path";
import { outputOf } from "./exec.js";
import type { CertbotRequest, CertbotResult, Exec } from "./types.js";

/** Certbot 单次调用上限。DNS 传播等待也算在里面。 */
export const CERTBOT_TIMEOUT_MS = 15 * 60 * 1000;

/** 拼 certonly 参数。已有 lineage 时由调用方决定是否带 --force-renewal。 */
export function buildCertbotArgs(request: CertbotRequest): string[] {
  const args = [
    "certonly",
    "--non-interactive",
    "--agree-tos",
    "--email",
    request.email,
    "--cert-name",
    request.job.id,
    "--key-type",
    request.keyType,
    "--config-dir",
    request.configDir,
    "--work-dir",
    request.workDir,
    "--logs-dir",
    request.logsDir,
  ];
  if (request.keyType === "ecdsa") args.push("--elliptic-curve", "secp256r1");
  else args.push("--rsa-key-size", "2048");
  if (request.staging) args.push("--server", "https://acme-staging-v02.api.letsencrypt.org/directory");
  if (request.dryRun) args.push("--dry-run");
  if (request.forceRenewal) args.push("--force-renewal");
  for (const domain of request.job.domains) args.push("-d", domain);
  if (request.job.challenge.type === "http-01") {
    args.push("--webroot", "--webroot-path", request.job.challenge.webroot, "--preferred-challenges", "http");
  } else {
    args.push(
      "--manual",
      "--preferred-challenges",
      "dns",
      "--manual-auth-hook",
      "cert-renew dns-auth",
      "--manual-cleanup-hook",
      "cert-renew dns-cleanup",
    );
  }
  return args;
}

/** DNS-01 时把 zone、传播秒数、记录文件和凭据名传给 dns-auth / dns-cleanup。 */
export function certbotEnv(request: CertbotRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (request.job.challenge.type === "dns-01") {
    env.CERT_RENEW_ZONE = request.job.challenge.zone;
    env.CERT_RENEW_PROPAGATION_SECONDS = String(request.job.challenge.propagationSeconds);
    env.CERT_RENEW_RECORD_FILE = request.recordFile;
    if (request.job.credential) env.CERT_RENEW_CREDENTIAL = request.job.credential;
    else delete env.CERT_RENEW_CREDENTIAL;
    env.ALIBABA_CLOUD_REGION_ID = request.regionId;
  }
  return env;
}

/** 执行 Certbot。二进制可用 CERTBOT_BIN 覆盖。 */
export async function runCertbot(request: CertbotRequest, exec: Exec): Promise<CertbotResult> {
  const bin = process.env.CERTBOT_BIN?.trim() || "certbot";
  const result = await exec([bin, ...buildCertbotArgs(request)], {
    env: certbotEnv(request),
    timeoutMs: CERTBOT_TIMEOUT_MS,
  });
  return result;
}

/** 该任务是否已经有 renewal 配置或 live 目录。 */
export function lineageExists(configDir: string, jobId: string): boolean {
  return existsSync(join(configDir, "renewal", `${jobId}.conf`)) || existsSync(join(configDir, "live", jobId));
}

/** 把 Certbot 的 stdout/stderr 收成一条失败原因。 */
export function certbotFailure(result: CertbotResult): string {
  return outputOf(result);
}
