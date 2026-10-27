import assert from "node:assert/strict";
import test from "node:test";
import { nextRun } from "./schedule.js";

const zone = "Asia/Shanghai";

test("时刻表落在 03:00 与 15:00 加偏移", () => {
  assert.equal(nextRun(new Date("2026-10-26T18:30:00.000Z"), zone, 0).toISOString(), "2026-10-26T19:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-27T02:00:00.000Z"), zone, 0).toISOString(), "2026-10-27T07:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-27T08:00:00.000Z"), zone, 0).toISOString(), "2026-10-27T19:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-26T18:30:00.000Z"), zone, 10).toISOString(), "2026-10-26T19:10:00.000Z");
});
