import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addAdmin, changePassword, createFirstAdmin, hasAdmins, listAdmins, removeAdmin, verifyAdmin } from "./admins.js";

function path(): string {
  return join(mkdtempSync(join(tmpdir(), "admins-")), "admins.json");
}

test("第一个管理员可以创建，重复创建失败", async () => {
  const file = path();
  assert.equal(hasAdmins(file), false);
  const created = await createFirstAdmin(file, "ops", "correct-password", "2026-10-30T00:00:00.000Z");
  assert.equal(created.ok, true);
  assert.equal(hasAdmins(file), true);
  assert.equal(await verifyAdmin(file, "ops", "correct-password"), true);
  assert.equal(await verifyAdmin(file, "ops", "wrong-password-x"), false);
  const again = await createFirstAdmin(file, "other", "correct-password", "2026-10-30T00:00:00.000Z");
  assert.equal(again.ok, false);
});

test("可以加人，不能删自己或最后一个", async () => {
  const file = path();
  await createFirstAdmin(file, "ops", "correct-password", "2026-10-30T00:00:00.000Z");
  const added = await addAdmin(file, "two", "another-password", "2026-10-30T00:00:00.000Z");
  assert.equal(added.ok, true);
  assert.equal(listAdmins(file).length, 2);
  assert.equal(removeAdmin(file, "ops", "ops").ok, false);
  assert.equal(removeAdmin(file, "two", "ops").ok, true);
  assert.equal(removeAdmin(file, "ops", "ops").ok, false);
  assert.equal(listAdmins(file).length, 1);
});

test("改口令要核对旧口令", async () => {
  const file = path();
  await createFirstAdmin(file, "ops", "correct-password", "2026-10-30T00:00:00.000Z");
  const bad = await changePassword(file, "ops", "wrong-password-x", "new-password-xx");
  assert.equal(bad.ok, false);
  const ok = await changePassword(file, "ops", "correct-password", "new-password-xx");
  assert.equal(ok.ok, true);
  assert.equal(await verifyAdmin(file, "ops", "new-password-xx"), true);
});
