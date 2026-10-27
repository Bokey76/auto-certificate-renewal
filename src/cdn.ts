import { readFileSync } from "node:fs";
import { nameCovered } from "./expiry.js";
import type { CertificateInfo, CertificateService, CdnService, JobState, TargetState } from "./types.js";

export interface CdnDomainResult {
  domain: string;
  ok: boolean;
  error?: string;
}

export interface CdnApplyResult {
  ok: boolean;
  error?: string;
  uploaded: boolean;
  domains: CdnDomainResult[];
  cas?: JobState["cas"];
}

/** 检查覆盖、按指纹复用或上传 CAS、再逐个绑定 CDN。同指纹下已成功的域名跳过。 */
export async function applyCdn(input: {
  jobId: string;
  domainNames: string[];
  cert: CertificateInfo;
  fullchainPath: string;
  privkeyPath: string;
  state: JobState;
  now: Date;
  certificates: CertificateService;
  cdn: CdnService;
}): Promise<CdnApplyResult> {
  const uncovered = input.domainNames.filter((name) => !nameCovered(name, input.cert.sans));
  if (uncovered.length > 0) {
    return { ok: false, uploaded: false, domains: [], error: `加速域名不在这张证书里：${uncovered.join(", ")}` };
  }

  const sameCert = input.state.cas?.fingerprint === input.cert.fingerprint && input.state.cas.certId !== undefined;
  let certId = sameCert ? input.state.cas!.certId : undefined;
  let certName = sameCert ? input.state.cas!.name : undefined;
  let uploaded = false;
  if (certId === undefined || certName === undefined) {
    try {
      const created = await uploadWithUniqueName({
        jobId: input.jobId,
        now: input.now,
        certPem: readFileSync(input.fullchainPath, "utf8"),
        keyPem: readFileSync(input.privkeyPath, "utf8"),
        certificates: input.certificates,
      });
      certId = created.certId;
      certName = created.name;
      uploaded = true;
    } catch (error) {
      return {
        ok: false,
        uploaded: false,
        domains: input.domainNames.map((domain) => ({
          domain,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const domains: CdnDomainResult[] = [];
  for (const domain of input.domainNames) {
    const key = cdnTargetKey(domain);
    if (sameCert && input.state.targets[key]?.ok) {
      domains.push({ domain, ok: true });
      continue;
    }
    try {
      await input.cdn.setCertificate({ domainName: domain, certId, certName });
      domains.push({ domain, ok: true });
    } catch (error) {
      domains.push({ domain, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const ok = domains.every((item) => item.ok);
  return {
    ok,
    uploaded,
    domains,
    cas: { fingerprint: input.cert.fingerprint, certId, name: certName },
    error: ok ? undefined : domains.filter((item) => !item.ok).map((item) => `${item.domain}: ${item.error}`).join("; "),
  };
}

/** 状态文件里 CDN 动作的稳定键，不随 apply 数组下标变化。 */
export function cdnTargetKey(domain: string): string {
  return `cdn:${domain.toLowerCase()}`;
}

export function targetOk(state: TargetState | undefined): boolean {
  return state?.ok === true;
}

/** 名称 `acme-<jobId>-YYYYMMDD`，重名则尝试 -2 到 -5。 */
async function uploadWithUniqueName(input: {
  jobId: string;
  now: Date;
  certPem: string;
  keyPem: string;
  certificates: CertificateService;
}): Promise<{ certId: number; name: string }> {
  const day = input.now.toISOString().slice(0, 10).replaceAll("-", "");
  const base = `acme-${input.jobId}-${day}`.slice(0, 63);
  let lastError: unknown;
  for (let n = 0; n < 5; n += 1) {
    const suffix = n === 0 ? "" : `-${n + 1}`;
    const name = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    try {
      const uploaded = await input.certificates.upload({ name, certPem: input.certPem, keyPem: input.keyPem });
      return { certId: uploaded.certId, name };
    } catch (error) {
      lastError = error;
      if (!isDuplicateName(error)) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("证书名称重复，无法上传");
}

function isDuplicateName(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /exist|duplicate|重复|NameExist|InvalidName/i.test(text);
}
