import { Temporal } from "@js-temporal/polyfill";
import {
  openSync,
  readSync,
  closeSync,
  readFileSync,
  createReadStream,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { TextDecoder } from "node:util";
import zlib from "node:zlib";
import {
  ValidationError,
  diffUsage,
  type Event,
  type Kind,
  type TokenUsage,
  type TranscriptTurn,
} from "./types.js";
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
// Turns imported from other agents carry synthetic import-moment timestamps.
const EXTERNAL_IMPORT_TURN = "external-import-turn-";
// token_count rows are cumulative session snapshots, not events: several rows
// share the same last_token_usage (measured 2,994 repeated pairs locally), so
// a turn's usage is the diff between its final snapshot and the previous
// turn's final snapshot — never a sum of last_token_usage.
type TokenSnapshot = TokenUsage;
const tokenSnapshot = (v: unknown): TokenSnapshot | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const num = (x: unknown) =>
    typeof x === "number" && Number.isFinite(x) ? x : 0;
  return {
    input_tokens: num(r.input_tokens),
    cached_input_tokens: num(r.cached_input_tokens),
    cache_write_input_tokens: num(r.cache_write_input_tokens),
    output_tokens: num(r.output_tokens),
    reasoning_output_tokens: num(r.reasoning_output_tokens),
    total_tokens: num(r.total_tokens),
  };
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
const LINE_CAP = 16 * 1024 * 1024;
// Cumulative decompressed ceiling: the 512 MiB cap applies to the compressed
// file, so a zip-bomb-ish input could otherwise stream out multi-GiB payloads.
export const DECOMPRESSED_CAP = 2 * 1024 * 1024 * 1024;
// One chunk→line splitter shared by the sync plain-file reader and the
// streaming zstd reader, so the 16 MiB single-record guard exists only here.
// The pending queue holds newline-free carry-over buffers; a line contained in
// a single chunk is returned as a zero-copy view, and only lines spanning
// chunk boundaries are copied. (Concatenating on every chunk instead measurably
// balloons peak RSS ~6x on a 38 MiB payload due to allocator behavior, so the
// queue design is deliberate.)
class LineSplitter {
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let from = 0;
    for (;;) {
      const i = chunk.indexOf(10, from);
      if (i < 0) break;
      const lineEnd = i + 1;
      if (this.pendingBytes + (lineEnd - from) > LINE_CAP)
        throw new ValidationError("单条记录超过 16 MiB；文件未导入");
      out.push(
        this.pending.length === 0 && from === 0
          ? chunk.subarray(0, lineEnd)
          : Buffer.concat([...this.pending, chunk.subarray(from, lineEnd)]),
      );
      this.pending = [];
      this.pendingBytes = 0;
      from = lineEnd;
    }
    if (from < chunk.length) {
      // Copy the carry-over, never hold a view: callers reuse their chunk
      // buffer across push() calls (lines() re-reads into one 64 KiB buffer),
      // so a pending view would be overwritten before the next push concats
      // it and splice stale bytes into the head of the spanning line (first
      // mass-exposed by Oh-My-Pi's long-line corpus: 31 corrupt lines in one
      // 2.7 MiB file).
      this.pending.push(Buffer.from(chunk.subarray(from)));
      this.pendingBytes += chunk.length - from;
      if (this.pendingBytes > LINE_CAP)
        throw new ValidationError("单条记录超过 16 MiB；文件未导入");
    }
    return out;
  }
  flush(): Buffer | null {
    if (!this.pending.length) return null;
    const tail = Buffer.concat(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    return tail;
  }
}
// lines() yields zero-copy views valid only until the consumer's NEXT line
// request (the chunk buffer is reused): every consumer must parse each yielded
// line before requesting the next one; collecting lines for later processing
// will observe overwritten bytes.
// Transcript extraction reads one file synchronously per drawer fetch. Unlike
// the import path it must branch on .zst here too — iterating lines() over a
// compressed file yields binary garbage that fails JSON parsing line-by-line
// and silently produces zero turns. Whole-payload decompression is bounded by
// the same 512 MiB compressed cap the importer enforces.
const TRANSCRIPT_SOURCE_CAP = 512 * 1024 * 1024;
export function* transcriptLines(path: string): Generator<Buffer> {
  if (!path.endsWith(".zst")) {
    yield* lines(path);
    return;
  }
  if (typeof zlib.zstdDecompressSync !== "function")
    throw new ValidationError(
      "此 Node 版本不支持 zstd；请升级到 Node 22.15+ 后按需读取 .jsonl.zst 会话",
    );
  const compressed = readFileSync(path);
  if (compressed.length > TRANSCRIPT_SOURCE_CAP)
    throw new ValidationError("会话文件超过 512 MiB；未按需读取");
  const splitter = new LineSplitter();
  yield* splitter.push(zlib.zstdDecompressSync(compressed));
  const tail = splitter.flush();
  if (tail) yield tail;
}
export function* lines(path: string): Generator<Buffer> {
  const fd = openSync(path, "r"),
    chunk = Buffer.alloc(64 * 1024),
    splitter = new LineSplitter();
  try {
    for (;;) {
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      yield* splitter.push(chunk.subarray(0, n));
    }
    const tail = splitter.flush();
    if (tail) yield tail;
  } finally {
    closeSync(fd);
  }
}
// Streaming zstd decode (zlib.createZstdDecompress): the decompressed payload
// is never materialized whole, so a highly compressible file under the 512 MiB
// compressed cap cannot balloon RSS. Lines and strict UTF-8 decoding behave
// exactly like the plain .jsonl path.
export async function* linesZst(
  path: string,
  maxDecompressedBytes: number = DECOMPRESSED_CAP,
): AsyncGenerator<Buffer> {
  if (typeof zlib.createZstdDecompress !== "function")
    throw new ValidationError(
      "此 Node 版本不支持 zstd；请升级到 Node 22.15+（或 23.8+）后再导入 .jsonl.zst 会话",
    );
  const source = createReadStream(path),
    out = source.pipe(zlib.createZstdDecompress()),
    splitter = new LineSplitter();
  // createReadStream opens lazily; surface its errors (ENOENT/EACCES/…) through
  // the piped stream so the async iteration below rejects instead of hanging.
  source.on("error", (e) =>
    out.destroy(out.readableEnded ? undefined : e),
  );
  let total = 0;
  try {
    for await (const chunk of out as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxDecompressedBytes)
        throw new ValidationError(
          "解压后数据超过 2 GiB 上限；文件可能异常膨胀，未导入",
        );
      yield* splitter.push(chunk);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (
      typeof code === "string" &&
      (code.startsWith("ERR_ZSTD") || code.startsWith("ZSTD_error"))
    )
      throw new ValidationError("zstd 解压失败；文件可能已损坏，未导入");
    throw e;
  } finally {
    out.destroy();
    source.destroy();
  }
  const tail = splitter.flush();
  if (tail) yield tail;
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
    // Newest-wins on duplicate ids: the index may repeat a thread id across
    // lines, and updated_at (the thread's last rename/naming time) selects the
    // freshest entry. It is a duplicate tie-breaker, not a staleness cutoff —
    // an older line never drops the topic of a still-known thread.
    const prev = map.get(id),
      entry = { name: thread_name, updated_at_ms };
    if (
      !prev ||
      (updated_at_ms ?? Number.NEGATIVE_INFINITY) >=
        (prev.updated_at_ms ?? Number.NEGATIVE_INFINITY)
    )
      map.set(id, entry);
  }
  return map;
}

export interface ParseResult {
  session: { id: string; agent: string; project: string; client: string };
  events: Event[];
  tokens: ({ turn_id: string } & TokenUsage)[];
  issues: string[];
  // Stable discriminator (never the Chinese issue text): every timing-bearing
  // turn was an external-agent import, so zero events is the designed outcome.
  external_import_only: boolean;
}

// Stable machine discriminator for by-design exclusions (unknown/remote
// provenance, subagents, forked/inherited histories, rollbacks). Gates match
// this subclass instead of re-matching the human-readable message, which
// stays free to change.
export class ExcludedSessionError extends ValidationError {}

export async function parse(path: string): Promise<ParseResult> {
  let meta: {
      id: string;
      agent: string;
      project: string;
      client: string;
    } | null = null,
    excluded = false,
    unknownSource = false;
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
  // for-await drives both sources uniformly: the async streaming zstd reader
  // and the sync plain-.jsonl reader (sync generators are async-iterable).
  for await (const line of path.endsWith(".zst")
    ? linesZst(path)
    : lines(path)) {
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
        // Mixed session ids in one file is a data problem, not a designed
        // exclusion: report it as a plain import failure.
        if (meta && meta.id !== p.id) unknownSource = true;
        // Recognized by-design markers (fork/subagent/rollback/remote) are
        // excluded on purpose; an unrecognized source is a failure.
        const sourceKnown =
          ["cli", "vscode", "exec"].includes(p.source) ||
          (p.source !== null &&
            typeof p.source === "object" &&
            typeof (p.source as Record<string, unknown>).subagent ===
              "object");
        if (!sourceKnown) unknownSource = true;
        if (
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
  if (unknownSource)
    throw new ValidationError(
      "来源未知或同一文件混合多个会话标识，无法安全解析；未导入",
    );
  if (excluded)
    throw new ExcludedSessionError(
      "远程/云端来源、子 Agent 分支副本或回滚记录按设计排除；未导入",
    );
  issues.add(
    "Codex：基于 task_started/task_complete、工具调用配对与 item_completed 锚点的三态切分；本地语料无审批事件，等待人审阅未单独计量",
  );
  if (externalSeen)
    issues.add("外部导入轮次时间戳为导入时刻，不参与计时");
  const unique = new Map<string, Event>();
  for (const e of events) {
    const key = hash(legacyJSON([meta.id, e]));
    unique.set(key, { ...e, key });
  }
  const tokens = [...turnTokens.entries()].map(
    ([turn_id, { start, end }]): { turn_id: string } & TokenUsage => ({
      turn_id,
      ...diffUsage(end, start),
    }),
  );
  return {
    session: meta,
    events: [...unique.values()],
    tokens,
    issues: [...issues].sort(),
    external_import_only: externalSeen && unique.size === 0,
  };
}

/** On-demand transcript extraction for Codex sessions (never persisted).
 *  The user prompt is carried in two places across real rollouts: the classic
 *  event_msg/user_message rows and response_item/message (role=user) rows —
 *  many files have ONLY the latter. Environment/instruction wrapper messages
 *  (<user_instructions>, <ENVIRONMENT_CONTEXT>, …) are excluded so the real
 *  prompt surfaces; a turn with no real prompt stays honestly null.
 *  Codex sources record no decryptable thinking text (OpenAI ZDR encryption)
 *  and no per-turn tool-call text; the caller reports those honestly via
 *  missing_fields instead of fabricating them.
 */
// Markers identifying host/tool-injected wrapper messages rather than real
// user prompts. Matched anywhere in the text (wrappers embed AGENTS.md bodies,
// environment snapshots, and permission preambles around the marker tags).
const PROMPT_WRAPPER_MARKERS = [
  "<user_instructions>",
  "<app_context>",
  "<app-context>",
  "<ENVIRONMENT_CONTEXT>",
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
  "<turn_context>",
  "<permissions",
];
const isPromptWrapper = (text: string) =>
  PROMPT_WRAPPER_MARKERS.some((m) => text.includes(m));

// Detail-line cap for tool calls (~120 code points, single line).
const TOOL_DETAIL_LIMIT = 120;
// Most-informative-first argument keys: the first string field that looks like
// THE operation (the command / path / query) wins over metadata like timeout.
const TOOL_DETAIL_KEYS = ["cmd", "command", "args", "path", "query"];
const oneLine = (s: string) =>
  truncateCodePoints(s.replace(/\s+/g, " ").trim(), TOOL_DETAIL_LIMIT);
/** Extract a one-line operation detail from a tool-call payload: a JSON
 *  arguments string (Codex function_call), an input string (Codex
 *  custom_tool_call), or an already-parsed input object (Claude tool_use).
 *  Returns null when nothing informative exists. */
export function toolCallDetail(raw: unknown): string | null {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return oneLine(trimmed); // plain string input (e.g. apply_patch bodies)
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (typeof value === "number" || typeof value === "boolean") return null;
    return null;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const pick = (pair: [string, unknown] | undefined): string | null => {
    if (!pair) return null;
    const v = pair[1];
    if (typeof v === "string" && v.trim()) return oneLine(v);
    if (Array.isArray(v)) {
      const joined = v
        .filter((x) => typeof x === "string" && x.trim())
        .join(" ");
      return joined ? oneLine(joined) : null;
    }
    return null;
  };
  for (const key of TOOL_DETAIL_KEYS) {
    const hit = pick(entries.find(([k]) => k === key));
    if (hit) return hit;
  }
  for (const pair of entries) {
    const hit = pick(pair);
    if (hit) return hit;
  }
  return null;
}
// Join a response_item message content[] into one prompt string.
const messageText = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((b) =>
      b && typeof b === "object" && !Array.isArray(b)
        ? (b as Record<string, unknown>).text
        : null,
    )
    .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  return parts.length ? parts.join("\n") : null;
};

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
  const setPrompt = (t: TranscriptTurn | null, text: string | null) => {
    if (!t || t.prompt !== null || !text || !text.trim()) return;
    if (isPromptWrapper(text)) return;
    t.prompt = truncateCodePoints(text);
  };
  for (const line of transcriptLines(path)) {
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
        continue;
      }
      // response_item/function_call & custom_tool_call: capture the invocation
      // (name + call_id + one-line operation detail) so the drawer can show
      // WHAT ran, not just the raw builtin name.
      if (
        row.type === "response_item" &&
        (p.type === "function_call" || p.type === "custom_tool_call")
      ) {
        const t = get(tid);
        if (t) {
          const detail =
            p.type === "custom_tool_call"
              ? toolCallDetail(p.input)
              : toolCallDetail(p.arguments);
          t.tool_calls.push({
            name:
              typeof p.name === "string" && p.name ? p.name : "tool",
            duration_ms: null,
            call_id: typeof p.call_id === "string" ? p.call_id : null,
            detail,
          });
        }
        continue;
      }
      // response_item/message (role=user): the prompt rows most real rollouts
      // carry. They carry no turn_id — associate to the nearest preceding
      // turn_context; a message arriving before any turn starts a turn keyed
      // by its own message id.
      if (row.type === "response_item" && p.type === "message") {
        if (p.role !== "user") continue; // system/developer roles are wrappers by definition
        const text = messageText(p.content);
        if (!text || isPromptWrapper(text)) continue;
        if (tid) setPrompt(get(tid), text);
        else {
          const ownId =
            typeof p.id === "string" && ID.test(p.id) ? p.id : null;
          if (ownId) {
            const t = get(ownId);
            setPrompt(t, text);
            lastTurnId = ownId;
          }
        }
        continue;
      }
    } catch {
      // Unreadable line: skip it; the store reports degradation honestly.
    }
  }
  return [...turns.values()];
}
