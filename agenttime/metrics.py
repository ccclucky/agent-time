"""Explicit interval accounting: sums and unions must never be confused."""
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def union_ms(intervals):
    total, left, right = 0, None, None
    for a, b in sorted(intervals):
        if b < a:
            raise ValueError("negative interval")
        if left is None:
            left, right = a, b
        elif a <= right:
            right = max(right, b)
        else:
            total += right-left
            left, right = a, b
    return total + (0 if left is None else right-left)


def bounds(start, end, timezone):
    """Inclusive local dates; build each midnight separately for DST changes."""
    zone = ZoneInfo(timezone)
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    if b < a or (b-a).days > 366:
        raise ValueError("时间范围需为 1 至 367 天")
    return (round(datetime.combine(a, time.min, zone).timestamp()*1000),
            round(datetime.combine(b+timedelta(days=1), time.min, zone).timestamp()*1000))


def report(sessions, start, end, timezone, agent="all"):
    lo, hi = bounds(start, end, timezone)
    included, intervals = [], []
    counts = {"completed": 0, "aborted": 0, "failed": 0, "open": 0, "incomplete": 0, "invalid": 0}
    for session in sessions:
        if agent not in ("all", session["agent"]):
            continue
        turns = []
        for original in session["turns"]:
            t = dict(original)
            a, b = t["start_ms"], t["end_ms"]
            # No unobserved running duration is manufactured for open intervals.
            valid = t["elapsed_ms"] is not None
            if valid:
                if not (a < hi and b >= lo):
                    continue
                x, y = max(a, lo), min(b, hi)
                if y < x or (y == x and not (lo <= a < hi)):
                    continue
                t["period_ms"] = y-x
                intervals.append((x, y))
            else:
                observed = [e["at_ms"] for e in t["events"]]
                if not any(lo <= x < hi for x in observed):
                    continue
                t["period_ms"] = None
            counts[t["status"]] += 1
            turns.append(t)
        if turns:
            item = dict(session, turns=turns)
            item["period_ms"] = sum(t["period_ms"] or 0 for t in turns)
            item["measured_turns"] = sum(t["period_ms"] is not None for t in turns)
            included.append(item)
    included.sort(key=lambda s: max((t["start_ms"] or t["end_ms"] or 0) for t in s["turns"]), reverse=True)
    total = sum(b-a for a, b in intervals)
    covered = union_ms(intervals)
    return {"range": {"start": start, "end": end, "timezone": timezone},
      "summary": {"processing_ms": total if intervals else None,
        "processing_union_ms": covered if intervals else None,
        "overlap_ms": total-covered if intervals else None,
        "work_ms": None, "human_ms": None, "response_gap_ms": None,
        "sessions": len(included), "turns": sum(counts.values()),
        "measured_turns": counts["completed"]+counts["aborted"]+counts["failed"], "statuses": counts},
      "basis": "Codex 执行开始事件到完成或中止事件；不是精确用户提交到最终答复的完整耗时。审批等待无法独立拆分。",
      "sessions": included}
