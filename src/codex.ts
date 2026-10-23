import { Temporal } from "@js-temporal/polyfill";
import { openSync, readSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { TextDecoder } from "node:util";
import { ValidationError, type Event, type Kind, type TranscriptTurn } from "./types.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
// Per-turn transcript text caps (code points) so transcript responses stay bounded.
export const TRANSCRIPT_TEXT_LIMIT = 8000;
// Unicode-safe truncation by code points, never splitting a surrogate pair.
export function truncateCodePoints(s: string, n = TRANSCRIPT_TEXT_LIMIT): string {
  return Array.from(s).slice(0, n).join("").trim();
}
// Match the previous Python JSON serialization so existing snapshots deduplicate.
export function legacyJSON(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(legacyJSON).join(", ") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => legacyJSON(k) + ": " + legacyJSON(v))
        .join(", ") +
      "}"
    );
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
export const ID = /^[A-Za-z0-9_.:-]{1,200}(?![\s\S])/;
const kinds: Record<string, Kind> = {
  task_started: "start",
  turn_started: "start",
  task_complete: "complete",
  turn_complete: "complete",
  turn_aborted: "abort",
};
export function timestamp(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
  )
    throw new ValidationError("invalid timestamp");
  const year = Number(value.slice(0, 4));
  if (year < 1970 || year > 2200)
    throw new ValidationError("invalid timestamp");
  try {
    return Temporal.Instant.from(value).round({
      smallestUnit: "millisecond",
      roundingMode: "halfEven",
    }).epochMilliseconds;
  } catch {
    throw new ValidationError("invalid timestamp");
  }
}
export function* lines(path: string): Generator<Buffer> {
  const fd = openSync(path, "r"),
    chunk = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      pending = Buffer.concat([pending, chunk.subarray(0, n)]);
      let i;
      while ((i = pending.indexOf(10)) >= 0) {
        if (i + 1 > 16 * 1024 * 1024)
          throw new ValidationError("单条记录超过 16 MiB；文件未导入");
        yield pending.subarray(0, i + 1);
        pending = pending.subarray(i + 1);
      }
      if (pending.length > 16 * 1024 * 1024)
        throw new ValidationError("单条记录超过 16 MiB；文件未导入");
    }
    if (pending.length) yield pending;
  } finally {
    closeSync(fd);
  }
}
export function parse(path: string) {
  let meta: {
      id: string;
      agent: string;
      project: string;
      client: string;
    } | null = null,
    excluded = false;
  const events: Omit<Event, "key">[] = [],
    issues = new Set<string>();
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const row = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!row || typeof row !== "object" || Array.isArray(row)) throw Error();
      const p = row.payload;
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      if (row.type === "session_meta") {
        if (typeof p.id !== "string" || !ID.test(p.id)) throw Error();
        if (meta && meta.id !== p.id) excluded = true;
        if (
          !["cli", "vscode", "exec"].includes(p.source) ||
          /cloud|remote/i.test(String(p.originator ?? "")) ||
          p.forked_from_id ||
          p.parent_thread_id ||
          p.history_base ||
          p.subagent_history_start_ordinal ||
          ![undefined, null, "legacy"].includes(p.history_mode) ||
          ![undefined, null, "user"].includes(p.thread_source)
        )
          excluded = true;
        meta = {
          id: p.id,
          agent: "Codex",
          project:
            posix
              .basename(String(p.cwd ?? "").replaceAll("\\", "/"))
              .slice(0, 100) || "未知项目",
          client: typeof p.source === "string" ? p.source : "unknown",
        };
        continue;
      }
      if (row.type === "event_msg" && p.type === "thread_rolled_back") {
        excluded = true;
        continue;
      }
      let kind: Kind;
      if (row.type === "turn_context") kind = "model";
      else if (row.type === "event_msg" && Object.hasOwn(kinds, p.type))
        kind = kinds[p.type];
      else continue;
      if (kind === "complete" && p.error != null) kind = "fail";
      if (typeof p.turn_id !== "string" || !ID.test(p.turn_id)) {
        issues.add("部分事件没有可关联的交互 ID，未猜测归属");
        continue;
      }
      const at = timestamp(row.timestamp);
      let model: string | null = null;
      if (kind === "model") {
        if (typeof p.model !== "string" || !p.model.trim()) continue;
        model = Array.from(p.model as string)
          .slice(0, 120)
          .join("");
      }
      events.push({ turn_id: p.turn_id, kind, at_ms: at, model });
    } catch {
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!meta) throw new ValidationError("未找到有效 Codex 会话元数据");
  if (excluded)
    throw new ValidationError(
      "来源未知、远程、子 Agent、分支继承或回滚记录暂不支持；未导入",
    );
  const unique = new Map<string, Event>();
  for (const e of events) {
    const key = hash(legacyJSON([meta.id, e]));
    unique.set(key, { ...e, key });
  }
  return {
    session: meta,
    events: [...unique.values()],
    issues: [...issues].sort(),
  };
}

/** On-demand transcript extraction for Codex sessions (never persisted).
 *  Codex event_msg rows carry the user prompt text (user_message) and the
 *  model reply (agent_message) per turn_id. Codex sources record no thinking
 *  text and no per-turn tool-call text; the caller reports those honestly via
 *  missing_fields instead of fabricating them.
 */
export function extractCodexTranscript(path: string): TranscriptTurn[] {
  const turns = new Map<string, TranscriptTurn>();
  let lastTurnId: string | null = null;
  const get = (tid: string | null): TranscriptTurn | null => {
    if (!tid || !ID.test(tid)) return null;
    let t = turns.get(tid);
    if (!t) {
      t = { turn_id: tid, prompt: null, thinking: null, models: [], tool_calls: [] };
      turns.set(tid, t);
    }
    return t;
  };
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const row = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const p = row.payload;
      if (!p || typeof p !== "object" || Array.isArray(p)) continue;
      const tid =
        typeof p.turn_id === "string" && ID.test(p.turn_id)
          ? ((lastTurnId = p.turn_id), p.turn_id)
          : lastTurnId;
      if (row.type === "turn_context") {
        const t = get(tid);
        if (
          t &&
          typeof p.model === "string" &&
          p.model.trim() &&
          !t.models.includes(p.model)
        )
          t.models.push(truncateCodePoints(p.model, 120));
        continue;
      }
      if (row.type === "event_msg" && p.type === "user_message") {
        const t = get(tid);
        if (t && t.prompt === null && typeof p.message === "string" && p.message.trim())
          t.prompt = truncateCodePoints(p.message);
      }
    } catch {
      // Unreadable line: skip it; the store reports degradation honestly.
    }
  }
  return [...turns.values()];
}
