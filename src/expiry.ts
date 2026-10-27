import { readFileSync, existsSync } from "node:fs";
import { X509Certificate } from "node:crypto";
import type { CertificateInfo } from "./types.js";

export function readCertificate(fullchainPath: string): CertificateInfo | undefined {
  if (!existsSync(fullchainPath)) return undefined;
  const pem = readFileSync(fullchainPath, "utf8");
  const leaf = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!leaf) return undefined;
  const cert = new X509Certificate(leaf[0]);
  return {
    fingerprint: cert.fingerprint256.toLowerCase(),
    notAfter: new Date(cert.validTo).toISOString(),
    sans: subjectAltNames(cert),
  };
}

export function subjectAltNames(cert: X509Certificate): string[] {
  const names = new Set<string>();
  const alt = cert.subjectAltName ?? "";
  for (const part of alt.split(",")) {
    const item = part.trim();
    if (item.toLowerCase().startsWith("dns:")) names.add(item.slice(4).trim().toLowerCase());
  }
  const cn = cert.subject.split("\n").find((line) => line.startsWith("CN="));
  if (cn) names.add(cn.slice(3).trim().toLowerCase());
  return [...names];
}

/** name 被 san 覆盖。泛域名只覆盖下一级。 */
export function nameCovered(name: string, sans: string[]): boolean {
  const host = name.toLowerCase();
  for (const san of sans) {
    const pattern = san.toLowerCase();
    if (pattern === host) return true;
    if (!pattern.startsWith("*.")) continue;
    const base = pattern.slice(2);
    const suffix = `.${base}`;
    if (!host.endsWith(suffix)) continue;
    const head = host.slice(0, -suffix.length);
    if (head.length > 0 && !head.includes(".")) return true;
  }
  return false;
}

export function withinRenewWindow(notAfterIso: string, renewBeforeDays: number, now: Date): boolean {
  const notAfter = new Date(notAfterIso).getTime();
  const windowMs = renewBeforeDays * 24 * 60 * 60 * 1000;
  return notAfter - now.getTime() <= windowMs;
}
