/** 由 Certbot 域名和 zone 算出阿里云 RR。apex 是 `_acme-challenge`，www 是 `_acme-challenge.www`。 */
export function txtRecord(certbotDomain: string, zone: string): { rr: string; fqdn: string } {
  const domain = certbotDomain.replace(/^\*\./, "").toLowerCase();
  const root = zone.toLowerCase().replace(/\.$/, "");
  const fqdn = `_acme-challenge.${domain}`;
  if (fqdn === `_acme-challenge.${root}`) return { rr: "_acme-challenge", fqdn };
  const suffix = `.${root}`;
  if (!fqdn.endsWith(suffix)) {
    throw new Error(`校验域名 ${fqdn} 不在解析区 ${root} 下`);
  }
  return { rr: fqdn.slice(0, -suffix.length), fqdn };
}
