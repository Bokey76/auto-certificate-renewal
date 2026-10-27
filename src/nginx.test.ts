import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyNginx } from "./nginx.js";
import type { Exec, NginxBaotaAction } from "./types.js";

function setup(): { action: NginxBaotaAction; sourceFullchain: string; sourceKey: string; destFullchain: string } {
  const dir = mkdtempSync(join(tmpdir(), "nginx-"));
  const sourceDir = join(dir, "live");
  const destDir = join(dir, "cert");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(destDir, { recursive: true });
  const sourceFullchain = join(sourceDir, "fullchain.pem");
  const sourceKey = join(sourceDir, "privkey.pem");
  writeFileSync(sourceFullchain, "new-cert");
  writeFileSync(sourceKey, "new-key");
  const destFullchain = join(destDir, "fullchain.pem");
  writeFileSync(destFullchain, "old-cert");
  writeFileSync(join(destDir, "privkey.pem"), "old-key");
  const action: NginxBaotaAction = {
    type: "nginx",
    kind: "baota",
    certDir: destDir,
    fullchainName: "fullchain.pem",
    privkeyName: "privkey.pem",
    nginxBin: "/www/server/nginx/sbin/nginx",
  };
  return { action, sourceFullchain, sourceKey, destFullchain };
}

test("nginx -t 失败时还原备份并且不 reload", async () => {
  process.env.CERT_RENEW_DIRECT_NGINX = "1";
  const { action, sourceFullchain, sourceKey, destFullchain } = setup();
  const argv: string[][] = [];
  const exec: Exec = async (command) => {
    argv.push(command);
    if (command.includes("-t")) return { code: 1, stdout: "", stderr: "bad config" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await applyNginx(action, sourceFullchain, sourceKey, exec);
  assert.equal(result.ok, false);
  assert.equal(result.nginxTest, "failed");
  assert.equal(result.nginxReload, "skipped");
  assert.equal(readFileSync(destFullchain, "utf8"), "old-cert");
  assert.equal(argv.some((item) => item.includes("reload")), false);
});

test("reload 失败时还原证书并再 reload 一次", async () => {
  process.env.CERT_RENEW_DIRECT_NGINX = "1";
  const { action, sourceFullchain, sourceKey, destFullchain } = setup();
  let reloads = 0;
  const exec: Exec = async (command) => {
    if (command.includes("-t")) return { code: 0, stdout: "", stderr: "" };
    reloads += 1;
    return { code: 1, stdout: "", stderr: "reload failed" };
  };
  const result = await applyNginx(action, sourceFullchain, sourceKey, exec);
  assert.equal(result.nginxReload, "failed");
  assert.equal(reloads, 2);
  assert.equal(readFileSync(destFullchain, "utf8"), "old-cert");
});
