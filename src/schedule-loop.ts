import { consumeRunRequest as consumeRunRequestFile, isPaused, isRunRequested, writeScheduler } from "./control.js";
import type { SchedulerSnapshot } from "./control.js";
import { nextRun } from "./schedule.js";

export interface LoopState {
  phase: "startup" | "waiting";
  nextRunAt: string | null;
}

export interface DecideInput {
  now: Date;
  paused: boolean;
  runRequested: boolean;
  state: LoopState;
}

export type Decision =
  | { type: "run"; reason: "startup" | "schedule" | "request"; consumeRequest: boolean; next: LoopState }
  | { type: "skip-schedule"; next: LoopState }
  | { type: "arm-wait"; next: LoopState }
  | { type: "wait"; next: LoopState };

/**
 * 纯决策，不碰时钟以外的状态。
 * 启动和当时已经存在的「再跑一轮」合并成一次。
 * 到点时若仍暂停，丢掉这一档，不把错过的钟点补跑成连续几轮。
 */
export function decide(input: DecideInput): Decision {
  const { now, paused, runRequested, state } = input;
  if (state.phase === "startup") {
    if (!paused || runRequested) {
      return { type: "run", reason: "startup", consumeRequest: true, next: { phase: "waiting", nextRunAt: null } };
    }
    return { type: "arm-wait", next: { phase: "waiting", nextRunAt: null } };
  }
  if (state.nextRunAt === null) return { type: "arm-wait", next: state };
  if (runRequested) return { type: "run", reason: "request", consumeRequest: true, next: state };
  if (now.getTime() >= Date.parse(state.nextRunAt)) {
    if (paused) return { type: "skip-schedule", next: { phase: "waiting", nextRunAt: null } };
    return { type: "run", reason: "schedule", consumeRequest: false, next: { phase: "waiting", nextRunAt: null } };
  }
  return { type: "wait", next: state };
}

export interface ScheduleLoopDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  timeZone: string;
  readHours: () => number[];
  readPaused: () => boolean;
  consumeRunRequest: () => boolean;
  runPending: () => boolean;
  writeHeartbeat: (snapshot: SchedulerSnapshot) => void;
  runOnce: () => Promise<number>;
  log: (line: string) => void;
  /** 每次进入一段等待时抽一次，不在 5 秒滴答里重抽。 */
  offsetMinutes: () => number;
  tickMs: number;
  /** 返回停止函数。长跑期间也要继续写心跳。 */
  startHeartbeat: (beat: () => void) => () => void;
  /** 测试用来停掉循环。生产不传。 */
  shouldStop?: () => boolean;
}

/** 时刻表循环。只有一轮返回退出码 1 时才返回，调用方结束进程。 */
export async function runScheduleLoop(deps: ScheduleLoopDeps): Promise<void> {
  let state: LoopState = { phase: "startup", nextRunAt: null };
  let running = false;

  const beat = (): void => {
    const paused = deps.readPaused();
    deps.writeHeartbeat({
      updatedAt: deps.now().toISOString(),
      state: running ? "running" : paused ? "paused" : "sleeping",
      paused,
      nextRunAt: state.nextRunAt,
      runPending: deps.runPending(),
    });
  };

  const stopHeartbeat = deps.startHeartbeat(beat);
  try {
    beat();
    for (;;) {
      if (deps.shouldStop?.()) return;
      const before = state;
      const decision = decide({
        now: deps.now(),
        paused: deps.readPaused(),
        runRequested: deps.runPending(),
        state,
      });
      state = decision.next;

      if (decision.type === "run") {
        if (decision.consumeRequest) deps.consumeRunRequest();
        const code = await runRound();
        if (code === 1) return;
        continue;
      }

      if (decision.type === "skip-schedule") {
        deps.log(`${deps.now().toISOString()} [-] 暂停中，跳过本次定时检查`);
        continue;
      }

      if (decision.type === "arm-wait") {
        if (before.phase === "startup" && deps.readPaused()) {
          deps.log(`${deps.now().toISOString()} [-] 暂停中，启动时不检查`);
        }
        const offset = deps.offsetMinutes();
        const at = nextRun(deps.now(), deps.timeZone, deps.readHours(), offset);
        state = { phase: "waiting", nextRunAt: at.toISOString() };
        deps.log(`${deps.now().toISOString()} [-] 下次检查 ${at.toISOString()}（偏移 ${offset} 分钟）`);
        beat();
        continue;
      }

      beat();
      await deps.sleep(deps.tickMs);
    }
  } finally {
    stopHeartbeat();
  }

  async function runRound(): Promise<number> {
    running = true;
    beat();
    try {
      return await deps.runOnce();
    } finally {
      running = false;
      beat();
    }
  }
}

/** 给 cli 用的生产依赖里，和数据卷相关的那一半。测试不走这里。 */
export function volumeControl(dataDir: string): Pick<ScheduleLoopDeps, "readPaused" | "consumeRunRequest" | "runPending" | "writeHeartbeat"> {
  return {
    readPaused: () => isPaused(dataDir),
    consumeRunRequest: () => consumeRunRequestFile(dataDir),
    runPending: () => isRunRequested(dataDir),
    writeHeartbeat: (snapshot) => writeScheduler(dataDir, snapshot),
  };
}
