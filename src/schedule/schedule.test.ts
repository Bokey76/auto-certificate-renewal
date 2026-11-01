import assert from "node:assert/strict";
import test from "node:test";
import { nextRun, randomOffsetMinutes, SCHEDULE_OFFSET_MAX_MINUTES } from "./schedule.js";

const zone = "Asia/Shanghai";
const defaultHours = [3, 15];

test("时刻表落在配置小时加偏移", () => {
  assert.equal(nextRun(new Date("2026-10-26T18:30:00.000Z"), zone, defaultHours, 0).toISOString(), "2026-10-26T19:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-27T02:00:00.000Z"), zone, defaultHours, 0).toISOString(), "2026-10-27T07:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-27T08:00:00.000Z"), zone, defaultHours, 0).toISOString(), "2026-10-27T19:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-26T18:30:00.000Z"), zone, defaultHours, 10).toISOString(), "2026-10-26T19:10:00.000Z");
});

test("只配置一个小时时睡到下一次该小时", () => {
  assert.equal(nextRun(new Date("2026-10-26T16:30:00.000Z"), zone, [1], 0).toISOString(), "2026-10-26T17:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-26T17:30:00.000Z"), zone, [1], 0).toISOString(), "2026-10-27T17:00:00.000Z");
});

test("自定义 1 点和 12 点", () => {
  assert.equal(nextRun(new Date("2026-10-26T16:30:00.000Z"), zone, [1, 12], 0).toISOString(), "2026-10-26T17:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-26T18:00:00.000Z"), zone, [1, 12], 0).toISOString(), "2026-10-27T04:00:00.000Z");
  assert.equal(nextRun(new Date("2026-10-27T05:00:00.000Z"), zone, [1, 12], 0).toISOString(), "2026-10-27T17:00:00.000Z");
});

test("随机偏移落在 0 到上限含两端", () => {
  for (let i = 0; i < 20; i += 1) {
    const minutes = randomOffsetMinutes();
    assert.equal(Number.isInteger(minutes), true);
    assert.equal(minutes >= 0 && minutes <= SCHEDULE_OFFSET_MAX_MINUTES, true);
  }
});
