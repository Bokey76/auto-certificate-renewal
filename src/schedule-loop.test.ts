import assert from "node:assert/strict";
import test from "node:test";
import { decide, runScheduleLoop, type ScheduleLoopDeps } from "./schedule-loop.js";
import type { SchedulerSnapshot } from "./control.js";

const zone = "Asia/Shanghai";

test("未暂停的启动要跑，已暂停的启动不跑", () => {
  const now = new Date("2026-10-26T18:30:00.000Z");
  const start = { phase: "startup" as const, nextRunAt: null };
  assert.equal(decide({ now, paused: false, runRequested: false, state: start }).type, "run");
  assert.equal(decide({ now, paused: true, runRequested: false, state: start }).type, "arm-wait");
  const withRequest = decide({ now, paused: true, runRequested: true, state: start });
  assert.equal(withRequest.type, "run");
  if (withRequest.type === "run") assert.equal(withRequest.consumeRequest, true);
});

test("暂停到点只跳过这一档", () => {
  const due = decide({
    now: new Date("2026-10-26T19:00:00.000Z"),
    paused: true,
    runRequested: false,
    state: { phase: "waiting", nextRunAt: "2026-10-26T19:00:00.000Z" },
  });
  assert.equal(due.type, "skip-schedule");
  const waiting = decide({
    now: new Date("2026-10-26T18:40:00.000Z"),
    paused: true,
    runRequested: false,
    state: { phase: "waiting", nextRunAt: "2026-10-26T19:00:00.000Z" },
  });
  assert.equal(waiting.type, "wait");
});

test("未暂停时启动跑一轮，偏移不随滴答改变", async () => {
  const now = { value: new Date("2026-10-26T18:30:00.000Z") };
  let runs = 0;
  let sleeps = 0;
  const offsets: number[] = [];
  let stop = false;
  await runScheduleLoop(deps({
    now: () => now.value,
    sleep: async (ms) => {
      sleeps += 1;
      now.value = new Date(now.value.getTime() + ms);
      if (sleeps >= 3) stop = true;
    },
    offsetMinutes: () => {
      offsets.push(7);
      return 7;
    },
    runOnce: async () => {
      runs += 1;
      return 0;
    },
    tickMs: 5000,
    shouldStop: () => stop,
  }));
  assert.equal(runs, 1);
  assert.deepEqual(offsets, [7]);
  assert.equal(sleeps, 3);
});

test("已暂停时启动不跑，到点跳过且不补跑", async () => {
  const now = { value: new Date("2026-10-26T18:30:00.000Z") };
  let runs = 0;
  const offsets: number[] = [];
  const lines: string[] = [];
  let stop = false;
  await runScheduleLoop(deps({
    now: () => now.value,
    readPaused: () => true,
    sleep: async (ms) => {
      now.value = new Date(now.value.getTime() + ms);
    },
    offsetMinutes: () => {
      offsets.push(0);
      return 0;
    },
    runOnce: async () => {
      runs += 1;
      return 0;
    },
    log: (line) => {
      lines.push(line);
      if (lines.some((item) => item.includes("跳过本次定时检查")) && offsets.length >= 2) stop = true;
    },
    tickMs: 10 * 60 * 1000,
    shouldStop: () => stop,
  }));
  assert.equal(runs, 0);
  assert.equal(lines.some((item) => item.includes("启动时不检查")), true);
  assert.equal(lines.filter((item) => item.includes("跳过本次定时检查")).length, 1);
  assert.equal(offsets.length, 2);
  const nextLogs = lines.filter((item) => item.includes("下次检查"));
  assert.equal(nextLogs.length, 2);
  assert.match(nextLogs[1], /2026-10-27T07:00:00.000Z/);
});

test("暂停时已有请求就只跑一轮并保持暂停", async () => {
  let pending = true;
  let runs = 0;
  const lines: string[] = [];
  await runScheduleLoop(deps({
    readPaused: () => true,
    runPending: () => pending,
    consumeRunRequest: () => {
      if (!pending) return false;
      pending = false;
      return true;
    },
    runOnce: async () => {
      runs += 1;
      return 0;
    },
    log: (line) => lines.push(line),
    shouldStop: () => runs >= 1 && lines.some((item) => item.includes("下次检查")),
  }));
  assert.equal(runs, 1);
  assert.equal(pending, false);
});

test("运行中到来的请求在这一轮结束后再跑一次", async () => {
  let pending = false;
  let runs = 0;
  await runScheduleLoop(deps({
    runPending: () => pending,
    consumeRunRequest: () => {
      if (!pending) return false;
      pending = false;
      return true;
    },
    runOnce: async () => {
      runs += 1;
      if (runs === 1) pending = true;
      return 0;
    },
    shouldStop: () => runs >= 2 && !pending,
  }));
  assert.equal(runs, 2);
  assert.equal(pending, false);
});

test("退出码 1 结束循环，并且运行期间心跳是正在检查", async () => {
  const seen: string[] = [];
  let runs = 0;
  await runScheduleLoop(deps({
    writeHeartbeat: (snapshot) => seen.push(snapshot.state),
    runOnce: async () => {
      runs += 1;
      assert.equal(seen.at(-1), "running");
      return 1;
    },
  }));
  assert.equal(runs, 1);
  assert.equal(seen.includes("running"), true);
});

function deps(over: Partial<ScheduleLoopDeps> & Pick<ScheduleLoopDeps, "runOnce">): ScheduleLoopDeps {
  return {
    now: () => new Date("2026-10-26T18:30:00.000Z"),
    sleep: async () => {},
    timeZone: zone,
    readHours: () => [3, 15],
    readPaused: () => false,
    consumeRunRequest: () => false,
    runPending: () => false,
    writeHeartbeat: (_snapshot: SchedulerSnapshot) => {},
    log: () => {},
    offsetMinutes: () => 0,
    tickMs: 5000,
    startHeartbeat: () => () => {},
    ...over,
  };
}
