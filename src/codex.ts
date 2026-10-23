import { Temporal } from "@js-temporal/polyfill";
import { openSync, readSync, closeSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import { ValidationError, type Event, type Kind, type TokenUsage } from "./types.js";
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
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
const ID = /^[A-Za-z0-9_.:-]{1,200}(?![\s\S])/;
const kinds: Record<string, Kind> = {
  task_started: "start",
  turn_started: "start",
  task_complete: "complete",
  turn_complete: "complete",
  turn_aborted: "abort",
};
// Turns imported from other agents carry synthetic import-moment timestamps.
const EXTERNAL_IMPORT_TURN = "external-import-turn-";
// token_count rows are cumulative session snapshots, not events: several rows
// share the same last_token_usage (measured 2,994 repeated pairs locally), so
// a turn's usage is the diff between its final snapshot and the previous
// turn's final snapshot — never a sum of last_token_usage.
const TOKEN_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;
type TokenSnapshot = readonly number[];
const tokenSnapshot = (v: unknown): TokenSnapshot | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  return TOKEN_FIELDS.map((f) => {
    const x = r[f];
    return typeof x === "number" && Number.isFinite(x) ? x : 0;
  });
};
const validId = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);
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
export function* linesZst(path: string): Generator<Buffer> {
  if (typeof zlib.zstdDecompressSync !== "function")
    throw new ValidationError(
      "此 Node 版本不支持 zstd；请升级到 Node 22.15+（或 23.8+）后再导入 .jsonl.zst 会话",
    );
  let buf: Buffer;
  try {
    buf = zlib.zstdDecompressSync(readFileSync(path));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      typeof code === "string" &&
      (code.startsWith("ERR_ZSTD") || code.startsWith("ZSTD_error"))
    )
      throw new ValidationError("zstd 解压失败；文件可能已损坏，未导入");
    throw e;
  }
  let start = 0;
  for (;;) {
    const i = buf.indexOf(10, start);
    if (i < 0) break;
    if (i + 1 - start > 16 * 1024 * 1024)
      throw new ValidationError("单条记录超过 16 MiB；文件未导入");
    yield buf.subarray(start, i + 1);
    start = i + 1;
  }
  if (start < buf.length) {
    if (buf.length - start > 16 * 1024 * 1024)
      throw new ValidationError("单条记录超过 16 MiB；文件未导入");
    yield buf.subarray(start);
  }
}
export interface IndexedThread {
  name: string;
  updated_at_ms: number | null;
}
// session_index.jsonl persists only *named* threads (123/799 local files), so
// it is optional enrichment — never a discovery manifest. A missing index,
// unparseable lines, or absent fractional timestamps degrade to "no topic"
// and never fail the import. thread_name is local-only metadata, like project
// names. updated_at carries 4–6 fractional digits (not standard millis), which
// Temporal accepts; anything unparseable stays null while keeping the name.
export function readSessionIndex(
  configRoot: string | null,
): Map<string, IndexedThread> {
  const map = new Map<string, IndexedThread>();
  if (!configRoot) return map;
  let text: string;
  try {
    text = readFileSync(join(configRoot, "session_index.jsonl"), "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const { id, thread_name, updated_at } = row as Record<string, unknown>;
    if (typeof id !== "string" || !ID.test(id)) continue;
    if (typeof thread_name !== "string" || !thread_name.trim()) continue;
    let updated_at_ms: number | null = null;
    if (typeof updated_at === "string") {
      try {
        updated_at_ms = timestamp(updated_at);
      } catch {
        updated_at_ms = null;
      }
    }
    map.set(id, { name: thread_name, updated_at_ms });
  }
  return map;
}

export interface ParseResult {
  session: { id: string; agent: string; project: string; client: string };
  events: Event[];
  tokens: ({ turn_id: string } & TokenUsage)[];
  issues: string[];
}

export function parse(path: string): ParseResult {
  let meta: {
      id: string;
      agent: string;
      project: string;
      client: string;
    } | null = null,
    excluded = false;
  const events: Omit<Event, "key">[] = [],
    issues = new Set<string>();
  // response_item / turn_context rows carry no turn_id: attribute them to the
  // nearest preceding task_started window (99.1% measured consistency).
  let currentTurn: string | null = null,
    externalSeen = false;
  const turnStart = new Map<string, number>(),
    agentDone = new Map<string, number>(),
    modelSeen = new Set<string>();
  // turn -> {start: snapshot before the turn's first token row, end: latest}
  const turnTokens = new Map<string, { start: TokenSnapshot | null; end: TokenSnapshot }>();
  let prevSnapshot: TokenSnapshot | null = null;
  const add = (
    turn_id: string,
    kind: Kind,
    at_ms: number,
    model: string | null = null,
    tool_id: string | null = null,
    tool_name: string | null = null,
  ) => {
    events.push({
      turn_id,
      kind,
      at_ms,
      model,
      ...(tool_id ? { tool_id } : {}),
      ...(tool_name ? { tool_name } : {}),
    });
  };
  for (const line of path.endsWith(".zst") ? linesZst(path) : lines(path)) {
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
          ![undefined, null, "legacy", "paginated"].includes(
            p.history_mode,
          ) ||
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
      // item_completed rows are not events: they anchor the turn's true end.
      // CLI/older writers flush task_complete lazily at the next user message,
      // so its row timestamp contains human idle time.
      if (row.type === "event_msg" && p.type === "item_completed") {
        const item = p.item;
        if (
          validId(p.turn_id) &&
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          item.type !== "UserMessage"
        ) {
          const anchor =
            typeof p.completed_at_ms === "number" && p.completed_at_ms > 0
              ? p.completed_at_ms
              : timestamp(row.timestamp);
          const prev = agentDone.get(p.turn_id);
          if (prev === undefined || anchor > prev) agentDone.set(p.turn_id, anchor);
        }
        continue;
      }
      if (row.type === "event_msg" && p.type === "token_count") {
        // info:null rows (88 locally, all imported sessions) carry nothing.
        const snap = tokenSnapshot(
          p.info && typeof p.info === "object" && !Array.isArray(p.info)
            ? (p.info as Record<string, unknown>).total_token_usage
            : null,
        );
        if (snap && currentTurn) {
          const entry = turnTokens.get(currentTurn);
          if (!entry)
            turnTokens.set(currentTurn, { start: prevSnapshot, end: snap });
          else entry.end = snap;
          prevSnapshot = snap;
        }
        continue;
      }
      if (row.type === "turn_context") {
        const turn = validId(p.turn_id) ? p.turn_id : currentTurn;
        if (!turn) {
          issues.add("部分事件没有可关联的交互 ID，未猜测归属");
          continue;
        }
        // One model event per turn; turn_context repeats on every model call.
        if (modelSeen.has(turn)) continue;
        if (typeof p.model !== "string" || !p.model.trim()) continue;
        modelSeen.add(turn);
        if (turn.startsWith(EXTERNAL_IMPORT_TURN)) continue;
        add(turn, "model", timestamp(row.timestamp), Array.from(p.model).slice(0, 120).join(""));
        continue;
      }
      if (row.type === "response_item") {
        const isCall = p.type === "function_call" || p.type === "custom_tool_call";
        const isOutput =
          p.type === "function_call_output" ||
          p.type === "custom_tool_call_output";
        if (!isCall && !isOutput) continue;
        if (!currentTurn) {
          issues.add("部分事件没有可关联的交互 ID，未猜测归属");
          continue;
        }
        if (currentTurn.startsWith(EXTERNAL_IMPORT_TURN)) {
          externalSeen = true;
          continue;
        }
        const tool_id = validId(p.call_id) ? p.call_id : null;
        add(
          currentTurn,
          isCall ? "tool_use" : "tool_result",
          timestamp(row.timestamp),
          null,
          tool_id,
          isCall && typeof p.name === "string" && p.name ? p.name : isCall ? "tool" : null,
        );
        continue;
      }
      let kind: Kind | undefined = kinds[p.type as string];
      if (row.type !== "event_msg" || !kind) continue;
      if (kind === "complete" && p.error != null) kind = "fail";
      if (!validId(p.turn_id)) {
        issues.add("部分事件没有可关联的交互 ID，未猜测归属");
        continue;
      }
      const rowAt = timestamp(row.timestamp);
      if (kind === "start") {
        currentTurn = p.turn_id;
        turnStart.set(p.turn_id, rowAt);
        if (p.turn_id.startsWith(EXTERNAL_IMPORT_TURN)) {
          externalSeen = true;
          continue;
        }
        add(p.turn_id, "start", rowAt);
        continue;
      }
      if (p.turn_id.startsWith(EXTERNAL_IMPORT_TURN)) {
        externalSeen = true;
        continue;
      }
      if (kind === "complete") {
        // Calibrate to the last non-UserMessage item_completed anchor; fall
        // back to the (possibly lazy) row timestamp within [start, rowAt].
        const anchor = agentDone.get(p.turn_id),
          start = turnStart.get(p.turn_id);
        if (
          anchor !== undefined &&
          anchor <= rowAt &&
          (start === undefined || anchor >= start)
        )
          add(p.turn_id, "complete", anchor);
        else add(p.turn_id, "complete", rowAt);
        continue;
      }
      add(p.turn_id, kind, rowAt);
    } catch {
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!meta) throw new ValidationError("未找到有效 Codex 会话元数据");
  if (excluded)
    throw new ValidationError(
      "来源未知、远程、子 Agent、分支继承或回滚记录暂不支持；未导入",
    );
  issues.add(
    "Codex：基于 task_started/task_complete、工具调用配对与 item_completed 锚点的三态切分；本地语料无审批事件，等待人工未单独计量",
  );
  if (externalSeen)
    issues.add("外部导入轮次时间戳为导入时刻，不参与计时");
  const unique = new Map<string, Event>();
  for (const e of events) {
    const key = hash(legacyJSON([meta.id, e]));
    unique.set(key, { ...e, key });
  }
  // Field order mirrors TOKEN_FIELDS: input, cached, cache_write, output,
  // reasoning, total.
  const tokens = [...turnTokens.entries()].map(
    ([turn_id, { start, end }]): { turn_id: string } & TokenUsage => ({
      turn_id,
      input_tokens: Math.max(0, end[0] - (start?.[0] ?? 0)),
      cached_input_tokens: Math.max(0, end[1] - (start?.[1] ?? 0)),
      cache_write_input_tokens: Math.max(0, end[2] - (start?.[2] ?? 0)),
      output_tokens: Math.max(0, end[3] - (start?.[3] ?? 0)),
      reasoning_output_tokens: Math.max(0, end[4] - (start?.[4] ?? 0)),
      total_tokens: Math.max(0, end[5] - (start?.[5] ?? 0)),
    }),
  );
  return {
    session: meta,
    events: [...unique.values()],
    tokens,
    issues: [...issues].sort(),
  };
}
