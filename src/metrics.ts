import { Temporal } from "@js-temporal/polyfill";
import { ValidationError, type Session, type Status } from "./types.js";
export function unionMs(intervals: [number, number][]) {
  let total = 0,
    left: number | null = null,
    right = 0;
  for (const [a, b] of [...intervals].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  )) {
    if (b < a) throw new ValidationError("negative interval");
    if (left === null) {
      left = a;
      right = b;
    } else if (a <= right) right = Math.max(right, b);
    else {
      total += right - left;
      left = a;
      right = b;
    }
  }
  return total + (left === null ? 0 : right - left);
}
export function bounds(
  start: string,
  end: string,
  timezone: string,
): [number, number] {
  try {
    if (!/^\d{4}-\d\d-\d\d$/.test(start) || !/^\d{4}-\d\d-\d\d$/.test(end))
      throw Error();
    const a = Temporal.PlainDate.from(start),
      b = Temporal.PlainDate.from(end),
      days = a.until(b).days;
    if (days < 0 || days > 366) throw Error();
    return [
      a.toZonedDateTime(timezone).epochMilliseconds,
      b.add({ days: 1 }).toZonedDateTime(timezone).epochMilliseconds,
    ];
  } catch {
    throw new ValidationError("日期或时区无效；请选择有效范围（最多 367 天）");
  }
}
export function report(
  sessions: Session[],
  start: string,
  end: string,
  timezone: string,
  agent = "all",
) {
  const [lo, hi] = bounds(start, end, timezone),
    included: Session[] = [],
    intervals: [number, number][] = [];
  const counts: Record<Status, number> = {
    completed: 0,
    aborted: 0,
    failed: 0,
    open: 0,
    incomplete: 0,
    invalid: 0,
  };
  for (const session of sessions) {
    if (agent !== "all" && agent !== session.agent) continue;
    const turns = [];
    for (const original of session.turns) {
      const t = { ...original };
      const a = t.start_ms,
        b = t.end_ms;
      if (t.elapsed_ms !== null && a !== null && b !== null) {
        if (!(a < hi && b >= lo)) continue;
        const x = Math.max(a, lo),
          y = Math.min(b, hi);
        if (y < x || (y === x && !(lo <= a && a < hi))) continue;
        t.period_ms = y - x;
        intervals.push([x, y]);
      } else {
        if (!t.events.some((e) => lo <= e.at_ms && e.at_ms < hi)) continue;
        t.period_ms = null;
      }
      counts[t.status]++;
      turns.push(t);
    }
    if (turns.length)
      included.push({
        ...session,
        turns,
        period_ms: turns.reduce((s, t) => s + (t.period_ms ?? 0), 0),
        measured_turns: turns.filter((t) => t.period_ms !== null).length,
      });
  }
  included.sort(
    (a, b) =>
      Math.max(...b.turns.map((t) => t.start_ms ?? t.end_ms ?? 0)) -
      Math.max(...a.turns.map((t) => t.start_ms ?? t.end_ms ?? 0)),
  );
  const total = intervals.reduce((s, [a, b]) => s + b - a, 0),
    covered = unionMs(intervals);

  let totalWork: number | null = null;
  let totalHuman: number | null = null;
  let totalStandby: number | null = null;

  for (const s of included) {
    for (const t of s.turns) {
      if (t.work_ms !== null) {
        const period = t.period_ms ?? null;
        totalWork =
          (totalWork ?? 0) +
          (period !== null && t.elapsed_ms
            ? Math.round((t.work_ms * period) / t.elapsed_ms)
            : t.work_ms);
      }
      if (t.review_wait_ms !== null) {
        const period = t.period_ms ?? null;
        totalHuman =
          (totalHuman ?? 0) +
          (period !== null && t.elapsed_ms
            ? Math.round((t.review_wait_ms * period) / t.elapsed_ms)
            : t.review_wait_ms);
      }
      if (t.standby_ms !== null) {
        totalStandby = (totalStandby ?? 0) + t.standby_ms;
      }
    }
  }

  return {
    range: { start, end, timezone },
    summary: {
      processing_ms: intervals.length ? total : null,
      processing_union_ms: intervals.length ? covered : null,
      overlap_ms: intervals.length ? total - covered : null,
      work_ms: totalWork,
      human_ms: totalHuman,
      review_wait_ms: totalHuman,
      standby_ms: totalStandby,
      response_gap_ms: totalStandby,
      sessions: included.length,
      turns: Object.values(counts).reduce((a, b) => a + b, 0),
      measured_turns: counts.completed + counts.aborted + counts.failed,
      statuses: counts,
    },
    basis:
      "Codex：执行开始至结束记录；Claude Code：基于 tool_use ↔ tool_result 事件流与 turn_duration 埋点的三态耗时切分（纯工作、等待人审阅、待命）。",
    sessions: included,
  };
}
