/** 配置、状态和可注入依赖的类型。字段含义见 docs/配置.md 与 docs/源码.md。 */
export type KeyType = "ecdsa" | "rsa";

export interface LetsEncryptConfig {
  email: string;
  staging: boolean;
  renewBeforeDays: number;
  keyType: KeyType;
}

export interface AlibabaConfig {
  regionId: string;
}

export interface ScheduleConfig {
  /** 时区内每天检查的小时，0–23，至少一个。默认 3 和 15。 */
  hours: number[];
}

export interface DnsChallenge {
  type: "dns-01";
  zone: string;
  propagationSeconds: number;
}

export interface HttpChallenge {
  type: "http-01";
  webroot: string;
}

export type Challenge = DnsChallenge | HttpChallenge;

export interface NginxBaotaAction {
  type: "nginx";
  kind: "baota";
  certDir: string;
  fullchainName: string;
  privkeyName: string;
  nginxBin: string;
}

export interface NginxCustomAction {
  type: "nginx";
  kind: "custom";
  fullchainPath: string;
  privkeyPath: string;
  nginxBin: string;
}

export interface CdnAction {
  type: "aliyun-cdn";
  domainNames: string[];
}

export type ApplyAction = NginxBaotaAction | NginxCustomAction | CdnAction;

export interface HookConfig {
  command: string;
  timeoutSeconds: number;
}

export interface JobConfig {
  id: string;
  enabled: boolean;
  domains: string[];
  challenge: Challenge;
  credential?: string;
  apply: ApplyAction[];
  hook?: HookConfig;
  /** 原始下标，日志里能对上配置文件。 */
  index: number;
}

export interface AppConfig {
  serverName?: string;
  letsencrypt: LetsEncryptConfig;
  alibaba: AlibabaConfig;
  schedule: ScheduleConfig;
  jobs: JobConfig[];
}

export interface InvalidJob {
  index: number;
  id?: string;
  error: string;
}

export interface ConfigLoadOk {
  ok: true;
  config: AppConfig;
  invalidJobs: InvalidJob[];
}

export interface ConfigLoadErr {
  ok: false;
  error: string;
}

export type ConfigLoadResult = ConfigLoadOk | ConfigLoadErr;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (
  argv: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<ExecResult>;

export interface CertificateInfo {
  fingerprint: string;
  notAfter: string;
  sans: string[];
}

export interface TargetState {
  ok: boolean;
  at: string;
  error?: string;
  nginxTest?: "passed" | "failed" | "skipped";
  nginxReload?: "passed" | "failed" | "skipped";
}

export interface CasState {
  fingerprint: string;
  certId: number;
  name: string;
}

export interface JobState {
  jobId: string;
  certName: string;
  fingerprint?: string;
  notAfter?: string;
  lastIssuedAt?: string;
  lastIssueError?: string;
  hookRanForFingerprint?: string;
  targets: Record<string, TargetState>;
  cas?: CasState;
}

export interface JobRunResult {
  id: string;
  status: "success" | "skipped" | "failed";
  error?: string;
  notAfter?: string;
  nginx: Array<{
    path: string;
    nginxTest: "passed" | "failed" | "skipped";
    nginxReload: "passed" | "failed" | "skipped";
    ok: boolean;
    error?: string;
  }>;
}

export interface StatusFile {
  serverName: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  logPath: string;
  jobs: JobRunResult[];
}

export interface CertificateService {
  upload(input: { name: string; certPem: string; keyPem: string }): Promise<{ certId: number }>;
}

export interface CdnService {
  setCertificate(input: { domainName: string; certId: number; certName: string }): Promise<void>;
}

export interface DnsService {
  addTxt(input: { zone: string; rr: string; value: string }): Promise<{ recordId: string }>;
  deleteRecord(recordId: string): Promise<void>;
}

export interface CertbotRequest {
  job: JobConfig;
  email: string;
  staging: boolean;
  keyType: KeyType;
  configDir: string;
  workDir: string;
  logsDir: string;
  dryRun: boolean;
  forceRenewal: boolean;
  recordFile: string;
  regionId: string;
}

export interface CertbotResult {
  code: number;
  stdout: string;
  stderr: string;
}
