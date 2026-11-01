import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteCredential, listCredentialViews, upsertCredential } from "./credentials.js";
import { alibabaCredential } from "./env.js";

test("凭据写入文件后列表不带密钥，读取优先于环境变量", () => {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const config = join(dir, "config.yaml");
  writeFileSync(config, "jobs: []\n");
  const previousPath = process.env.CONFIG_PATH;
  const previousId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const previousSecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  process.env.CONFIG_PATH = config;
  process.env.ALIBABA_CLOUD_ACCESS_KEY_ID = "env-id";
  process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET = "env-secret";
  try {
    const saved = upsertCredential(config, "default", "file-id", "file-secret");
    assert.equal(saved.ok, true);
    const views = listCredentialViews(config);
    assert.equal(views[0].name, "default");
    assert.equal(views[0].source, "file");
    assert.equal(JSON.stringify(views).includes("file-secret"), false);
    assert.equal(alibabaCredential().accessKeyId, "file-id");
    assert.equal(deleteCredential(config, "default").ok, true);
    assert.equal(alibabaCredential().accessKeyId, "env-id");
  } finally {
    restore("CONFIG_PATH", previousPath);
    restore("ALIBABA_CLOUD_ACCESS_KEY_ID", previousId);
    restore("ALIBABA_CLOUD_ACCESS_KEY_SECRET", previousSecret);
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
