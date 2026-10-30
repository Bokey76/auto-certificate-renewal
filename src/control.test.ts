import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  consumeRunRequest,
  isPaused,
  isRunRequested,
  readScheduler,
  requestRun,
  schedulerOnline,
  setPaused,
  writeScheduler,
} from "./control.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "control-"));
}

test("暂停标记可以创建和删除", () => {
  const data = dir();
  assert.equal(isPaused(data), false);
  setPaused(data, true);
  assert.equal(isPaused(data), true);
  setPaused(data, true);
  assert.equal(isPaused(data), true);
  setPaused(data, false);
  assert.equal(isPaused(data), false);
  setPaused(data, false);
  assert.equal(isPaused(data), false);
});

test("检查请求只被消费一次", () => {
  const data = dir();
  assert.equal(isRunRequested(data), false);
  assert.deepEqual(requestRun(data, "2026-10-30T00:00:00.000Z"), { already: false });
  assert.equal(isRunRequested(data), true);
  assert.deepEqual(requestRun(data, "2026-10-30T01:00:00.000Z"), { already: true });
  assert.equal(readFileSync(join(data, "control", "run-request"), "utf8"), "2026-10-30T00:00:00.000Z");
  assert.equal(consumeRunRequest(data), true);
  assert.equal(isRunRequested(data), false);
  assert.equal(consumeRunRequest(data), false);
});

test("心跳可以读写，坏 JSON 不当成在线", () => {
  const data = dir();
  const now = new Date("2026-10-30T03:00:00.000Z");
  assert.equal(readScheduler(data), null);
  assert.equal(schedulerOnline(null, now), false);

  writeScheduler(data, {
    updatedAt: now.toISOString(),
    state: "sleeping",
    paused: false,
    nextRunAt: "2026-10-30T07:00:00.000Z",
    runPending: false,
  });
  const snap = readScheduler(data);
  assert.equal(snap?.state, "sleeping");
  assert.equal(snap?.nextRunAt, "2026-10-30T07:00:00.000Z");
  assert.equal(schedulerOnline(snap, now), true);
  assert.equal(schedulerOnline(snap, new Date(now.getTime() + 21_000)), false);

  writeFileSync(join(data, "scheduler.json"), "{", "utf8");
  assert.equal(readScheduler(data), null);
  writeFileSync(join(data, "scheduler.json"), JSON.stringify({ updatedAt: now.toISOString() }), "utf8");
  assert.equal(readScheduler(data), null);
});
