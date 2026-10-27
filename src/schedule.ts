/** 未配置 schedule.hours 时的默认检查小时。 */
export const DEFAULT_SCHEDULE_HOURS = [3, 15];

/** 每次睡到下次检查前随机加的分钟上限（含）。 */
export const SCHEDULE_OFFSET_MAX_MINUTES = 30;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** 把一个 UTC 时刻拆成指定时区的年月日时分。时刻表不用系统 TZ 环境变量。 */
export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
  };
}

/** 把时区内的日历时间换成 UTC。用两次校正处理夏令时。 */
export function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  for (let i = 0; i < 2; i += 1) {
    const got = zonedParts(new Date(utc), timeZone);
    const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, 0);
    const wantUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    utc += wantUtc - gotUtc;
  }
  return new Date(utc);
}

/** 在该时区日历上加整天，用于算第二天的 03:00。 */
export function addDays(parts: ZonedParts, days: number, timeZone: string): ZonedParts {
  const shifted = new Date(zonedTimeToUtc(parts, timeZone).getTime() + days * 24 * 60 * 60 * 1000);
  return zonedParts(shifted, timeZone);
}

/** 时区内下一次 `hours` 整点，再加上本次的分钟偏移。hours 为空时用默认 3 和 15。 */
export function nextRun(now: Date, timeZone: string, hours: number[], offsetMinutes: number): Date {
  const runHours = hours.length > 0 ? hours : DEFAULT_SCHEDULE_HOURS;
  const today = zonedParts(now, timeZone);
  const candidates: Date[] = [];
  for (const dayShift of [0, 1]) {
    const day = dayShift === 0 ? today : addDays({ ...today, hour: 12, minute: 0 }, 1, timeZone);
    for (const hour of runHours) {
      candidates.push(
        zonedTimeToUtc({ year: day.year, month: day.month, day: day.day, hour, minute: offsetMinutes }, timeZone),
      );
    }
  }
  const upcoming = candidates.filter((item) => item.getTime() > now.getTime()).sort((a, b) => a.getTime() - b.getTime());
  return upcoming[0];
}

/** 每次睡前现抽 0–30 分钟，不写盘。 */
export function randomOffsetMinutes(): number {
  return Math.floor(Math.random() * (SCHEDULE_OFFSET_MAX_MINUTES + 1));
}

/** 时刻表和 DNS 传播等待都走这里，测试可注入。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
