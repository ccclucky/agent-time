/** Parse DeepSeek Harness (DSH) session files into the shared Event stream.
 *
 * Basis: first-hand forensics of real local sessions under ~/.dsh/sessions
 * (4 sessions, all `session.v4.jsonl.zstd`, verified 2026-10-24). Format facts
 * the parser relies on:
 *
 * - Layout: sessions/<encoded-cwd>/<sessionId>/session[.v4].jsonl.zstd. The
 *   file is a concatenation of many independent zstd frames (measured 1,923
 *   frames in one 3.1 MiB file), each frame holding one or more JSONL records.
 *   Node's zstdDecompressSync decodes only the FIRST frame and the streaming
 *   createZstdDecompress rejects the second with ZSTD_error_prefix_unknown, so
 *   frames must be decoded sequentially by walking frame-boundary magics.
 * - Records are {type, seq, time(epoch ms), data}; only the flat `session`
 *   header (version 4, carrying id/cwd) omits `data`. Fields below are read
 *   through a {record, data} merge so both shapes share one accessor set.
 *   Only version 4 is verified against real samples — other versions are
 *   rejected instead of silently mis-parsed.
 * - Turn lifecycle: turn/start {turn} → step/start {turn,step} →
 *   assistant/message {turn,step,message,usage} → tool/call {turn,step,callId,
 *   name,arguments} → tool/result {turn,step,message.toolCallId} → step/end →
 *   turn/end {turn,reason:{kind}} with kinds completed|aborted observed.
 * - Timing evidence is first-hand per step: [step/start, assistant/message] is
 *   the model inference span (retries included), [tool/call, tool/result] the
 *   tool execution span. This matches the Pi timing model (machine-time span
 *   accumulation), not the Codex wall-clock decomposition.
 * - Tokens: usage on assistant/message is PER-REQUEST (verified: inputTokens
 *   resets each step while cacheRead grows), so a turn's usage is the SUM over
 *   its assistant messages — unlike Codex's cumulative snapshot diff.
 * - approval/policy, permission/preset and sandbox/mode are static settings,
 *   not blocking events; the local corpus carries no approval-wait events, so
 *   review wait is honestly unknown (null), same degradation as Pi.
 */
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { posix } from "node:path";
import {
  lines,
  hash,
  legacyJSON,
  truncateCodePoints,
  toolCallDetail,
} from "./codex.js";
import {
  ValidationError,
  type Event,
  type TokenUsage,
  type TranscriptTurn,
} from "./types.js";

const validId = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0;

// Same compressed-source cap as the Codex transcript reader.
const SOURCE_CAP = 512 * 1024 * 1024;
// Decompressed ceiling per frame: bounds a crafted zip-bomb frame under the
// 512 MiB compressed cap (ERR_BUFFER_TOO_LARGE verified on local Node).
const MAX_FRAME_OUTPUT = 2 * 1024 * 1024 * 1024;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH JSONL lines, transparently decoding the multi-frame zstd container.
 *  Frame boundaries are located by scanning the magic; a boundary candidate
 *  that fails to decode means the magic bytes collided with frame payload, so
 *  the window widens to the next magic and retries — a truncated frame never
 *  decodes "successfully" because zstd frames are terminated by an explicit
 *  end block (plus checksum when present). Plain .jsonl files (no leading
 *  magic) fall through to the shared sync line reader. */
export function* dshLines(path: string): Generator<string> {
  const buf = readFileSync(path);
  if (buf.length > SOURCE_CAP)
    throw new ValidationError("会话文件超过 512 MiB；未读取");
  if (!buf.subarray(0, 4).equals(ZSTD_MAGIC)) {
    for (const line of lines(path)) yield line.toString("utf8");
    return;
  }
  let i = 0;
  for (;;) {
    const next = buf.indexOf(ZSTD_MAGIC, i + 1);
    const end = next < 0 ? buf.length : next;
    let frame: Buffer;
    try {
      frame = zlib.zstdDecompressSync(buf.subarray(i, end), {
        maxOutputLength: MAX_FRAME_OUTPUT,
      });
    } catch {
      if (next < 0)
        throw new ValidationError("zstd 解压失败；文件可能已损坏，未导入");
      i = next;
      continue;
    }
    for (const line of frame.toString("utf8").split("\n")) yield line;
    if (next < 0) return;
    i = next;
  }
}

interface DshRecord {
  type: string;
  time: number;
  turn?: number;
  step?: number;
  version?: unknown;
  id?: unknown;
  cwd?: unknown;
  provider?: unknown;
  model?: unknown;
  header?: { config?: { provider?: unknown; model?: unknown } };
  title?: unknown;
  usage?: Record<string, unknown> | null;
  content?: unknown;
  message?: { content?: unknown; toolCallId?: unknown };
  callId?: unknown;
  name?: unknown;
  arguments?: unknown;
  reason?: { kind?: unknown };
}

// Records other than the flat session header nest their fields under `data`;
// merging once keeps every consumer on a single accessor set.
const normalize = (raw: Record<string, unknown>): DshRecord => {
  const data = raw.data;
  return {
    ...raw,
    ...(data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}),
  } as unknown as DshRecord;
};

const num = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

const modelName = (r: DshRecord): string | null => {
  // model/selection carries {provider, model}; request/header nests the same
  // pair in header.config. Display form follows the Pi convention.
  const provider = r.provider ?? r.header?.config?.provider,
    model = r.model ?? r.header?.config?.model;
  if (typeof model !== "string" || !model.trim()) return null;
  const full =
    typeof provider === "string" && provider.trim()
      ? provider + "/" + model
      : model;
  return truncateCodePoints(full, 120);
};

const turnId = (n: number) => "turn-" + n;

export function parseDsh(path: string) {
  let sid: string | null = null,
    project: string | null = null,
    sessionTitle: string | null = null;
  const issues = new Set<string>(),
    events: Event[] = [],
    tokensByTurn = new Map<string, TokenUsage>();
  // (turn, step) -> step/start time: the model inference span opens here.
  const stepStart = new Map<string, number>();
  // callId -> issuing tool/call: pairs with tool/result for timing.
  const toolCalls = new Map<string, { start: number; name: string }>();
  let lastModel: string | null = null;
  // Turns whose turn/end has not been seen; flagged as possibly-in-progress.
  const openTurns = new Set<string>();

  const add = (
    turn_id: string,
    kind: Event["kind"],
    at_ms: number,
    model: string | null = null,
    extras: {
      end_ms?: number | null;
      tool_id?: string | null;
      tool_name?: string | null;
    } = {},
  ) => {
    const rawObj: Record<string, unknown> = { turn_id, kind, at_ms, model };
    if (extras.end_ms != null) rawObj.end_ms = extras.end_ms;
    if (extras.tool_id) rawObj.tool_id = extras.tool_id;
    if (extras.tool_name) rawObj.tool_name = extras.tool_name;
    events.push({
      turn_id,
      kind,
      at_ms,
      model,
      end_ms: extras.end_ms ?? undefined,
      tool_id: extras.tool_id ?? undefined,
      tool_name: extras.tool_name ?? undefined,
      key: hash(legacyJSON(["DeepSeek Harness", sid, rawObj])),
    });
  };

  for (const line of dshLines(path)) {
    if (!line.trim()) continue;
    let r: DshRecord;
    try {
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error();
      r = normalize(raw);
      // The flat session header carries createdAt but no `time`; every other
      // record type is time-stamped and invalid times are unverifiable.
      if (
        r.type !== "session" &&
        (typeof r.time !== "number" || !Number.isFinite(r.time) || r.time <= 0)
      )
        throw Error();
    } catch {
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
      continue;
    }
    const at = r.time;
    if (r.type === "session") {
      // Only version 4 is verified against real samples; other versions may
      // carry different fields, and guessing would silently distort stats.
      if (r.version !== 4)
        throw new ValidationError(
          `DSH 会话格式版本 ${String(r.version ?? "缺失")} 未经真实样本验证，未导入`,
        );
      if (!validId(r.id)) {
        issues.add("会话头缺少有效标识，未导入该文件");
        continue;
      }
      if (sid && sid !== r.id)
        throw new ValidationError(
          "同一文件混合多个会话标识，无法安全解析；未导入",
        );
      sid = r.id;
      if (typeof r.cwd === "string" && r.cwd.trim())
        project =
          posix
            .basename(r.cwd.replaceAll("\\", "/"))
            .slice(0, 100) || project;
      continue;
    }
    if (r.type === "session/title") {
      if (typeof r.title === "string" && r.title.trim())
        sessionTitle = truncateCodePoints(
          r.title.replace(/[\r\n]+/g, " ").trim(),
          100,
        );
      continue;
    }
    if (r.type === "model/selection" || r.type === "request/header") {
      const model = modelName(r);
      if (model) lastModel = model;
      continue;
    }
    if (!sid) continue;
    const t =
      typeof r.turn === "number" && Number.isInteger(r.turn) && r.turn > 0
        ? turnId(r.turn)
        : null;
    if (r.type === "turn/start") {
      if (!t) {
        issues.add("部分轮次缺少有效编号，未猜测归属");
        continue;
      }
      openTurns.add(t);
      add(t, "start", at);
      continue;
    }
    if (r.type === "step/start") {
      if (t && typeof r.step === "number")
        stepStart.set(t + "\u0000" + r.step, at);
      continue;
    }
    if (r.type === "assistant/message") {
      if (!t) continue;
      const spanStart =
        typeof r.step === "number"
          ? (stepStart.get(t + "\u0000" + r.step) ?? null)
          : null;
      // Model inference span: first-hand [step/start, assistant/message];
      // null-model spans still carry timing evidence (bucketed 未知模型).
      add(t, "model", spanStart ?? at, lastModel, { end_ms: at });
      if (r.usage && typeof r.usage === "object") {
        const cur: TokenUsage = {
          input_tokens: num(r.usage.inputTokens),
          cached_input_tokens: num(r.usage.cacheReadTokens),
          cache_write_input_tokens: num(r.usage.cacheWriteTokens),
          output_tokens: num(r.usage.outputTokens),
          reasoning_output_tokens: num(r.usage.reasoningTokens),
          total_tokens: num(r.usage.totalTokens),
        };
        const prev = tokensByTurn.get(t);
        if (!prev) tokensByTurn.set(t, cur);
        else
          for (const f of Object.keys(cur) as (keyof TokenUsage)[])
            prev[f] += cur[f];
      }
      continue;
    }
    if (r.type === "tool/call") {
      if (!t) continue;
      const callId = typeof r.callId === "string" ? r.callId : null,
        name =
          typeof r.name === "string" && r.name.trim() ? r.name.trim() : "tool";
      if (callId) toolCalls.set(callId, { start: at, name });
      add(t, "tool_use", at, null, { tool_id: callId, tool_name: name });
      continue;
    }
    if (r.type === "tool/result") {
      if (!t) continue;
      const callId =
        typeof r.message?.toolCallId === "string" ? r.message.toolCallId : null;
      const issuing = callId ? toolCalls.get(callId) : undefined;
      if (issuing) {
        add(t, "tool_result", issuing.start, null, {
          end_ms: at,
          tool_id: callId,
          tool_name: issuing.name,
        });
      } else {
        // No matching tool/call: start unknown, keep an honest zero-length
        // result rather than guessing a duration.
        issues.add("部分工具结果缺少对应的调用记录；未猜测执行时长");
        add(t, "tool_result", at, null, {
          end_ms: at,
          tool_id: callId,
          tool_name: null,
        });
      }
      continue;
    }
    if (r.type === "turn/end") {
      if (!t) continue;
      openTurns.delete(t);
      // Observed reason kinds: completed | aborted. An unknown kind maps to
      // abort (least-wrong: the elapsed span still measures) and is flagged
      // instead of silently counting as success.
      if (r.reason?.kind === "completed") add(t, "complete", at);
      else {
        add(t, "abort", at);
        if (r.reason?.kind !== "aborted")
          issues.add(
            `存在未知的轮次结束类型（${String(r.reason?.kind ?? "缺失")}）；按中止计`,
          );
      }
      continue;
    }
  }
  if (!sid) throw new ValidationError("未找到有效 DSH 会话元数据");
  if (openTurns.size)
    issues.add("部分轮次缺少结束事件；可能进行中，不推测当前状态");

  if (project === null) {
    // Header cwd missing: the encoded directory name is a lossy cwd fallback.
    let encoded = posix.basename(posix.dirname(path));
    if (encoded.startsWith("--")) encoded = encoded.slice(2);
    if (encoded.endsWith("--")) encoded = encoded.slice(0, -2);
    const last = encoded.split("-").pop() ?? "";
    project = last ? truncateCodePoints(last, 100) : "未知项目";
    issues.add("会话头缺少 cwd；项目名由编码目录名有损解码，可能不准确");
  }
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "dsh/" + sid,
      agent: "DeepSeek Harness",
      project,
      client: "dsh",
      title: sessionTitle,
    },
    events: [...unique.values()],
    tokens: [...tokensByTurn.entries()].map(([turn_id, usage]) => ({
      turn_id,
      ...usage,
    })),
    issues: [...issues].sort(),
  };
}

/** On-demand transcript extraction for DSH sessions (never persisted).
 *  Turn ids mirror parseDsh ("turn-<N>"), so the drawer can join this against
 *  turn.id from the event stream. The prompt is the turn's first user message;
 *  queued follow-up messages in the same turn are not re-shown. Tool-call
 *  durations pair tool/call with tool/result first-hand timestamps. Extraction
 *  is best-effort and only returns what the file truly holds. */
export function extractDshTranscript(path: string): TranscriptTurn[] {
  const turns = new Map<string, TranscriptTurn>();
  let lastModel: string | null = null;
  // user/message records carry no turn number; they belong to the latest
  // turn/start seen, mirroring the append order in real files.
  let currentTurn: string | null = null;
  const toolCalls = new Map<string, { name: string; start: number }>();
  const resultAt = new Map<string, number>();
  const get = (t: string | null): TranscriptTurn | null => {
    if (!t) return null;
    let turn = turns.get(t);
    if (!turn) {
      turn = {
        turn_id: t,
        prompt: null,
        thinking: null,
        models: [],
        tool_calls: [],
      };
      turns.set(t, turn);
    }
    return turn;
  };
  for (const line of dshLines(path)) {
    if (!line.trim()) continue;
    let r: DshRecord;
    try {
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      r = normalize(raw);
    } catch {
      continue; // Unreadable line: skip; the store reports degradation honestly.
    }
    if (r.type === "model/selection" || r.type === "request/header") {
      const model = modelName(r);
      if (model) lastModel = model;
      continue;
    }
    const t =
      typeof r.turn === "number" && Number.isInteger(r.turn) && r.turn > 0
        ? turnId(r.turn)
        : null;
    if (r.type === "turn/start") currentTurn = t;
    if (r.type === "user/message") {
      const turn = get(t ?? currentTurn);
      if (!turn) continue;
      // Queued follow-ups share the turn: only the first message surfaces.
      // Unlike assistant messages, user messages carry content directly on data.
      if (turn.prompt === null && Array.isArray(r.content)) {
        const text = (r.content as unknown[])
          .filter(
            (b) =>
              b &&
              typeof b === "object" &&
              !Array.isArray(b) &&
              (b as { type?: string }).type === "text" &&
              typeof (b as { text?: unknown }).text === "string",
          )
          .map((b) => (b as { text: string }).text)
          .join("\n")
          .trim();
        if (text) turn.prompt = truncateCodePoints(text);
      }
      continue;
    }
    if (r.type === "assistant/message") {
      const turn = get(t);
      if (!turn) continue;
      if (lastModel && !turn.models.includes(lastModel))
        turn.models.push(lastModel);
      if (Array.isArray(r.message?.content)) {
        for (const b of r.message.content as unknown[]) {
          if (
            b &&
            typeof b === "object" &&
            !Array.isArray(b) &&
            (b as { type?: string }).type === "reasoning" &&
            typeof (b as { text?: unknown }).text === "string" &&
            (b as { text: string }).text.trim()
          ) {
            const text = (b as { text: string }).text.trim();
            turn.thinking = turn.thinking
              ? truncateCodePoints(turn.thinking + "\n" + text)
              : truncateCodePoints(text);
          }
        }
      }
      continue;
    }
    if (r.type === "tool/call") {
      const turn = get(t);
      if (!turn) continue;
      const callId = typeof r.callId === "string" ? r.callId : null;
      const name =
        typeof r.name === "string" && r.name.trim() ? r.name.trim() : "tool";
      if (callId)
        toolCalls.set(callId, {
          name,
          start: typeof r.time === "number" ? r.time : 0,
        });
      turn.tool_calls.push({
        name,
        duration_ms: null,
        call_id: callId,
        detail:
          typeof r.arguments === "string" ? toolCallDetail(r.arguments) : null,
      });
      continue;
    }
    if (r.type === "tool/result") {
      const callId =
        typeof r.message?.toolCallId === "string" ? r.message.toolCallId : null;
      if (callId && typeof r.time === "number") resultAt.set(callId, r.time);
      continue;
    }
  }
  // Durations from call→result first-hand timestamps.
  for (const turn of turns.values()) {
    for (const call of turn.tool_calls) {
      if (!call.call_id) continue;
      const issued = toolCalls.get(call.call_id);
      const done = resultAt.get(call.call_id);
      if (issued && done && done >= issued.start)
        call.duration_ms = done - issued.start;
    }
  }
  return [...turns.values()];
}
