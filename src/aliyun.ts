import casModule from "@alicloud/cas20200407";
import cdnModule from "@alicloud/cdn20180510";
import dnsModule from "@alicloud/alidns20150109";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { alibabaCredential } from "./env.js";
import type { CdnService, CertificateService, DnsService } from "./types.js";

export interface AliyunClients {
  certificates: CertificateService;
  cdn: CdnService;
  dns: DnsService;
}

export function createAliyunClients(regionId: string, credentialName?: string): AliyunClients {
  const credential = alibabaCredential(credentialName);
  const cas = new casModule.default(config(credential, "cas.aliyuncs.com", regionId));
  const cdn = new cdnModule.default(config(credential, "cdn.aliyuncs.com", regionId));
  const dns = new dnsModule.default(config(credential, "alidns.aliyuncs.com", regionId));
  return {
    certificates: {
      async upload(input) {
        const response = await cas.uploadUserCertificate(
          new casModule.UploadUserCertificateRequest({ name: input.name, cert: input.certPem, key: input.keyPem }),
        );
        const certId = response.body?.certId;
        if (certId === undefined || certId === null) throw new Error("上传证书没有返回 CertId");
        return { certId: Number(certId) };
      },
    },
    cdn: {
      async setCertificate(input) {
        await cdn.setCdnDomainSSLCertificate(
          new cdnModule.SetCdnDomainSSLCertificateRequest({
            domainName: input.domainName,
            certId: input.certId,
            certType: "cas",
            certName: input.certName,
            SSLProtocol: "on",
          }),
        );
      },
    },
    dns: {
      async addTxt(input) {
        const response = await dns.addDomainRecord(
          new dnsModule.AddDomainRecordRequest({
            domainName: input.zone,
            RR: input.rr,
            type: "TXT",
            value: input.value,
            TTL: 600,
          }),
        );
        const recordId = response.body?.recordId;
        if (recordId === undefined || recordId === null || String(recordId) === "") {
          throw new Error("添加 TXT 没有返回 RecordId");
        }
        return { recordId: String(recordId) };
      },
      async deleteRecord(recordId) {
        await dns.deleteDomainRecord(new dnsModule.DeleteDomainRecordRequest({ recordId }));
      },
    },
  };
}

function config(
  credential: { accessKeyId: string; accessKeySecret: string },
  endpoint: string,
  regionId: string,
): $OpenApiUtil.Config {
  return new $OpenApiUtil.Config({
    accessKeyId: credential.accessKeyId,
    accessKeySecret: credential.accessKeySecret,
    regionId,
    endpoint,
  });
}
