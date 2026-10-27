/** 由 Certbot 传入的域名和配置里的 zone 计算阿里云主机记录。 */
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
