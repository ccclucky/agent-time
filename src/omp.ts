/** Parse Oh-My-Pi (omp) session JSONL into the shared Event stream.
 * Basis: real local corpus (~/.omp/agent/sessions/<cwd-slug>/<uuid>.jsonl,
 * session header version 3, omp 18.x) — the upstream ships no session-format
 * spec, so every rule here is backed by ADR 0004 field evidence.
 * Only timing metadata is read; message content is never persisted.
 *
 * The session body is the JSONL stream; `history.db` is auxiliary evidence
 * only. Turn boundaries come from in-file user messages (ms precision) and
 * fall back to history.db prompts (second precision) for files that predate
 * user-message recording; the two channels never merge (ADR 0004 rule 2).
 */
import { posix } from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lines, timestamp, hash, legacyJSON, ID, truncateCodePoints } from "./codex.js";
import {
  addUsage,
  ValidationError,
  zeroUsage,
  type Event,
  type TokenUsage,
  type TranscriptTurn,
} from "./types.js";

const AGENT = "Oh-My-Pi";
const validId = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);

// Record-level ISO timestamps are record append times; invalid ones mark the
// single line bad (issue) instead of aborting the import, so wrap as plain Error.
const iso = (v: unknown): number => {
  try {
    return timestamp(v);
  } catch {
    throw Error();
  }
};
// message.timestamp is epoch ms (request start / result creation per role).
const epochMs = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 4102444800000)
    throw Error();
  return v;
};
// duration is an optional float ms measured on a monotonic clock; absent or
// malformed means "fall back", never abort.
const durationMs = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const cleanLine = (s: unknown, n: number): string | null =>
  typeof s === "string" && s.trim() ? s.replace(/[\r\n]+/g, " ").trim().slice(0, n) : null;

// Slim per-record projection: only the fields events/transcript are built from.
interface OmpRecord {
  type:
    | "user"
    | "assistant"
    | "toolResult"
    | "toolStart"
    | "modelChange"
    | "thinkingChange"
    | "sessionExit";
  at: number; // record append time (ISO timestamp)
  // user
  text?: string | null;
  // assistant
  reqStart?: number;
  dur?: number | null;
  stopReason?: string;
  thinking?: string | null;
  usage?: Record<string, unknown>;
  toolCalls?: { id: string; name: string }[];
  // toolResult
  resultAt?: number;
  toolCallId?: string | null;
  toolName?: string | null;
  // toolStart
  startedAt?: number;
  intent?: string | null;
  // modelChange / thinkingChange (level reuses model slot downstream)
  model?: string | null;
  // sessionExit
  exitAt?: number;
}

interface OmpAnchor {
  at: number;
  id: string;
  prompt: string | null;
}

// ---- Shared phase 1: read the JSONL into slim records + header info. ----
function readOmp(path: string): {
  sid: string;
  project: string | null;
  title: string | null;
  records: OmpRecord[];
  issues: Set<string>;
} {
  let sid: string | null = null,
    project: string | null = null;
  const records: OmpRecord[] = [],
    issues = new Set<string>(),
    titleCandidates: { at: number; title: string }[] = [];
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error();
      if (r.type === "session") {
        if (!validId(r.id)) throw Error();
        // One stream per file; a second header means a merged file whose
        // records cannot be attributed safely — reject instead of guessing.
        if (sid && sid !== r.id)
          throw new ValidationError("Oh-My-Pi 混合会话记录暂不支持；未导入");
        sid = r.id;
        if (typeof r.cwd === "string" && r.cwd.trim())
          project =
            posix
              .basename(r.cwd.replaceAll("\\", "/"))
              .slice(0, 100) || project;
        const t = cleanLine(r.title, 100);
        if (t) titleCandidates.push({ at: iso(r.timestamp), title: t });
        continue;
      }
      if (r.type === "title") {
        const t = cleanLine(r.title, 100);
        if (t) titleCandidates.push({ at: iso(r.updatedAt), title: t });
        continue;
      }
      if (r.type === "title_change") {
        const t = cleanLine(r.title, 100);
        if (t) titleCandidates.push({ at: iso(r.timestamp), title: t });
        continue;
      }
      if (r.type === "model_change") {
        const m = typeof r.model === "string" && r.model.trim() ? r.model.slice(0, 120) : null;
        if (m) records.push({ type: "modelChange", at: iso(r.timestamp), model: m });
        continue;
      }
      if (r.type === "thinking_level_change") {
        const level = cleanLine(r.thinkingLevel, 40);
        if (level)
          records.push({ type: "thinkingChange", at: iso(r.timestamp), model: level });
        continue;
      }
      if (r.type === "custom") {
        if (r.customType === "tool_execution_start") {
          const d = r.data;
          if (d && typeof d === "object" && typeof d.toolCallId === "string")
            records.push({
              type: "toolStart",
              at: iso(r.timestamp),
              toolCallId: d.toolCallId,
              startedAt:
                typeof d.startedAt === "string" ? iso(d.startedAt) : iso(r.timestamp),
              toolName: cleanLine(d.toolName, 120),
              intent: cleanLine(d.intent, 200),
            });
          continue;
        }
        if (r.customType === "session_exit") {
          const d = r.data;
          if (d && typeof d === "object" && typeof d.recordedAt === "string")
            records.push({
              type: "sessionExit",
              at: iso(r.timestamp),
              exitAt: iso(d.recordedAt),
            });
          continue;
        }
        continue;
      }
      if (r.type !== "message") continue;
      const m = r.message;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      if (m.role === "user") {
        records.push({
          type: "user",
          at: iso(r.timestamp),
          text:
            Array.isArray(m.content)
              ? m.content
                  .filter(
                    (b: unknown) =>
                      b &&
                      typeof b === "object" &&
                      !Array.isArray(b) &&
                      (b as { type?: string }).type === "text" &&
                      typeof (b as { text?: unknown }).text === "string",
                  )
                  .map((b: unknown) => (b as { text: string }).text)
                  .join("\n")
                  .trim() || null
              : null,
        });
      } else if (m.role === "assistant") {
        records.push({
          type: "assistant",
          at: iso(r.timestamp),
          reqStart: epochMs(m.timestamp),
          dur: durationMs(m.duration),
          model: cleanLine(m.model, 120),
          stopReason: typeof m.stopReason === "string" ? m.stopReason : "",
          thinking:
            Array.isArray(m.content)
              ? m.content
                  .filter(
                    (b: unknown) =>
                      b &&
                      typeof b === "object" &&
                      !Array.isArray(b) &&
                      (b as { type?: string }).type === "thinking" &&
                      typeof (b as { thinking?: unknown }).thinking === "string",
                  )
                  .map((b: unknown) => (b as { thinking: string }).thinking.trim())
                  .filter(Boolean)
                  .join("\n") || null
              : null,
          usage:
            m.usage && typeof m.usage === "object" && !Array.isArray(m.usage)
              ? (m.usage as Record<string, unknown>)
              : undefined,
          toolCalls: Array.isArray(m.content)
            ? m.content
                .filter(
                  (b: unknown) =>
                    b &&
                    typeof b === "object" &&
                    !Array.isArray(b) &&
                    (b as { type?: string }).type === "toolCall" &&
                    typeof (b as { id?: unknown }).id === "string",
                )
                .map((b: unknown) => {
                  const c = b as { id: string; name?: unknown };
                  return {
                    id: c.id,
                    name: typeof c.name === "string" && c.name ? c.name : "tool",
                  };
                })
            : [],
        });
      } else if (m.role === "toolResult") {
        records.push({
          type: "toolResult",
          at: iso(r.timestamp),
          resultAt: epochMs(m.timestamp),
          toolCallId: typeof m.toolCallId === "string" ? m.toolCallId : null,
          toolName: cleanLine(m.toolName, 120),
        });
      }
      // developer-role messages (system reminders) carry no timing evidence
      // and never anchor or end a turn; they only keep the stream flowing.
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!sid) throw new ValidationError("未找到有效 Oh-My-Pi 会话元数据");
  // Title single channel (ADR 0004 rule 5): header/title/title_change are all
  // candidates for the same channel and the newest wins (ties: later record).
  let title: string | null = null,
    titleAt = -1;
  for (const c of titleCandidates)
    if (c.at >= titleAt) {
      title = c.title;
      titleAt = c.at;
    }
  return { sid, project, title, records, issues };
}

// ---- Shared phase 2: turn anchors (single channel, ADR 0004 rule 2). ----
// history.db lives at the agent root: sessions/<slug>/<uuid>.jsonl → ../../.
// A user-configured root pointing straight at sessions/ or sessions/<slug> is
// also honored; candidates are probed from the agent root downwards.
function historyDbCandidates(path: string): string[] {
  const norm = path.split(/[\\/]/).join("/");
  const slugDir = posix.dirname(norm);
  const sessionsDir = posix.dirname(slugDir);
  const agentDir = posix.dirname(sessionsDir);
  return [
    posix.join(agentDir, "history.db"),
    posix.join(sessionsDir, "history.db"),
    posix.join(slugDir, "history.db"),
  ];
}

function readHistoryPrompts(
  path: string,
  sessionId: string,
  issues: Set<string>,
  overrideDb?: string,
): OmpAnchor[] {
  const candidates = overrideDb
    ? [overrideDb]
    : historyDbCandidates(path).filter(existsSync);
  for (const db of candidates) {
    try {
      // Strictly read-only: a live WAL database must never be written or
      // checkpointed by the importer. Failure degrades to anchor-less import.
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        const rows = conn
          .prepare(
            "SELECT prompt, created_at FROM history WHERE session_id=? ORDER BY created_at, id",
          )
          .all(sessionId) as unknown as {
          prompt: unknown;
          created_at: unknown;
        }[];
        const out: OmpAnchor[] = [];
        for (const row of rows) {
          if (
            typeof row.created_at !== "number" ||
            !Number.isFinite(row.created_at) ||
            row.created_at <= 0 ||
            typeof row.prompt !== "string" ||
            !row.prompt.trim()
          )
            continue;
          out.push({
            // created_at is epoch SECONDS: anchor precision is ±1s, disclosed
            // in ADR 0004. First-hand machine-time evidence is unaffected.
            at: row.created_at * 1000,
            id: `db-${row.created_at}-${out.length}`,
            prompt: truncateCodePoints(row.prompt),
          });
        }
        return out;
      } finally {
        conn.close();
      }
    } catch {
      issues.add("history.db 无法只读打开；轮次边界降级为会话单轮切分");
    }
  }
  if (candidates.length === 0)
    issues.add("未找到 history.db；轮次边界降级为会话单轮切分");
  return [];
}

function buildAnchors(
  path: string,
  sid: string,
  records: OmpRecord[],
  issues: Set<string>,
  overrideDb?: string,
): OmpAnchor[] {
  const users = records.filter((r) => r.type === "user");
  if (users.length > 0)
    return users.map((r, i) => ({
      at: r.at,
      id: `msg-${r.at}-${i}`,
      prompt: r.text ?? null,
    }));
  const prompts = readHistoryPrompts(path, sid, issues, overrideDb);
  if (prompts.length > 0) return prompts;
  // No anchor channel at all: one synthetic turn so the machine-time evidence
  // in the stream still lands (work_ms is duration-accumulated, not wall-clock).
  issues.add("会话未记录用户消息且 history.db 无提示记录；整段按单轮计");
  const first = records.find(
    (r) =>
      r.type === "assistant" || r.type === "toolStart" || r.type === "toolResult",
  );
  return [{ at: first?.at ?? 0, id: "turn-0", prompt: null }];
}

/** Parse an Oh-My-Pi session JSONL (see module header and ADR 0004). */
export function parseOmp(path: string, opts?: { historyDb?: string }) {
  const { sid, project: headerProject, title, records, issues } = readOmp(path);
  const anchors = buildAnchors(path, sid, records, issues, opts?.historyDb);

  // ---- Phase 3: bucket records into user-anchored turns, emit events. ----
  const events: Event[] = [];
  const tokens = new Map<string, TokenUsage>();
  let currentLevel: string | null = null;
  // toolCallId → execution start (tool_execution_start), issuing response end
  // and name (assistant toolCall block) for fallback pairing.
  const toolStarts = new Map<string, { at: number; name: string | null; intent: string | null }>();
  const issued = new Map<string, { end: number; name: string }>();
  // Per-turn ending evidence, resolved after the record walk.
  const lastAssistant = new Map<string, { at: number; stopReason: string }>();
  const exitAtByTurn = new Map<string, number>();
  // Timing-relevant evidence only: bare title/model markers before a turn's
  // first response must not drag the turn start (and so elapsed) earlier.
  const firstEvidenceAt = new Map<string, number>();
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
  const add = (
    turn_id: string,
    kind: Event["kind"],
    rawAt: number,
    model: string | null = null,
    extras: {
      end_ms?: number | null;
      thinking_level?: string | null;
      tool_id?: string | null;
      tool_name?: string | null;
    } = {},
  ) => {
    // duration fields are float monotonic ms; the event stream stays integer.
    const at_ms = Math.round(rawAt);
    const rawObj: Record<string, unknown> = { turn_id, kind, at_ms, model };
    if (extras.end_ms != null) rawObj.end_ms = Math.round(extras.end_ms);
    if (extras.thinking_level) rawObj.thinking_level = extras.thinking_level;
    if (extras.tool_id) rawObj.tool_id = extras.tool_id;
    if (extras.tool_name) rawObj.tool_name = extras.tool_name;
    events.push({
      turn_id,
      kind,
      at_ms,
      model,
      end_ms: extras.end_ms != null ? Math.round(extras.end_ms) : undefined,
      thinking_level: extras.thinking_level ?? undefined,
      tool_id: extras.tool_id ?? undefined,
      tool_name: extras.tool_name ?? undefined,
      key: hash(legacyJSON([AGENT, sid, rawObj])),
    });
  };

  let anchorIdx = 0;
  for (const r of records) {
    while (anchorIdx + 1 < anchors.length && anchors[anchorIdx + 1].at <= r.at)
      anchorIdx++;
    const turn = anchors[anchorIdx].id;
    if (r.type === "assistant") {
      const requestStart = r.reqStart!;
      const dur = r.dur ?? null;
      // Response end: monotonic duration preferred, else record append ISO.
      const responseEnd = dur !== null ? requestStart + dur : r.at;
      const evidence = Math.min(requestStart, responseEnd);
      const prevEvidence = firstEvidenceAt.get(turn);
      if (prevEvidence === undefined || evidence < prevEvidence)
        firstEvidenceAt.set(turn, evidence);
      // Even without a model name the response span is first-hand timing
      // evidence for work_ms; null models bucket as 未知模型 downstream.
      add(turn, "model", requestStart, r.model ?? null, {
        end_ms: responseEnd,
        thinking_level: currentLevel,
      });
      for (const c of r.toolCalls ?? []) {
        if (c.id) issued.set(c.id, { end: responseEnd, name: c.name });
        add(turn, "tool_use", responseEnd, null, {
          tool_id: c.id || null,
          tool_name: c.name,
        });
      }
      if (r.usage) {
        const u = r.usage;
        const usage: TokenUsage = {
          input_tokens: num(u.input),
          cached_input_tokens: num(u.cacheRead),
          cache_write_input_tokens: num(u.cacheWrite),
          output_tokens: num(u.output),
          reasoning_output_tokens: num(u.reasoningTokens),
          total_tokens: num(u.totalTokens),
        };
        tokens.set(turn, addUsage(tokens.get(turn) ?? zeroUsage(), usage));
      }
      lastAssistant.set(turn, { at: r.at, stopReason: r.stopReason ?? "" });
      continue;
    }
    if (r.type === "toolStart") {
      if (r.toolCallId && !toolStarts.has(r.toolCallId))
        toolStarts.set(r.toolCallId, {
          at: r.startedAt ?? r.at,
          name: r.toolName ?? null,
          intent: r.intent ?? null,
        });
      continue;
    }
    if (r.type === "sessionExit") {
      if (r.exitAt != null && !exitAtByTurn.has(turn)) exitAtByTurn.set(turn, r.exitAt);
      continue;
    }
    if (r.type === "modelChange") {
      add(turn, "model", r.at, r.model ?? null);
      continue;
    }
    if (r.type === "thinkingChange") {
      currentLevel = r.model ?? null;
      add(turn, "model", r.at, null, { thinking_level: currentLevel });
      continue;
    }
    if (r.type === "toolResult") {
      const tid = r.toolCallId ?? null;
      const start = tid ? toolStarts.get(tid) : undefined;
      const issuing = tid ? issued.get(tid) : undefined;
      const resultAt = r.resultAt ?? r.at;
      let toolStart: number;
      if (start) toolStart = start.at;
      else if (issuing) {
        toolStart = issuing.end;
        issues.add(
          "部分工具结果缺少 tool_execution_start；工具开始时刻回退为发起响应结束，可能包含未分类延迟",
        );
      } else {
        toolStart = resultAt;
        issues.add("部分工具结果无法定位执行起点；按结果创建时刻计 0 时长");
      }
      if (toolStart < (firstEvidenceAt.get(turn) ?? Infinity))
        firstEvidenceAt.set(turn, toolStart);
      add(turn, "tool_result", toolStart, null, {
        end_ms: resultAt,
        tool_id: tid,
        tool_name: r.toolName ?? (issuing?.name ?? start?.name ?? null),
      });
      continue;
    }
    // user records themselves anchor turns; their start event is emitted in
    // the anchor pass below together with DB/synthetic anchors.
  }

  // Anchor pass: one start per turn, one honest ending per turn. The turn's
  // final assistant append is the completion anchor; stop → system-reminder
  // auto-continuation stays inside the same turn (ADR 0004 rule 3). A turn
  // without assistant evidence closes at session_exit, else stays open.
  for (const anchor of anchors) {
    const turn = anchor.id;
    const last = lastAssistant.get(turn);
    if (last) {
      if (last.stopReason === "aborted") add(turn, "abort", last.at);
      else if (last.stopReason === "stop") add(turn, "complete", last.at);
      // toolUse/error endings leave the turn open: the stream proves no
      // clean completion, and inventing one would shift standby attribution.
    } else {
      const exitAt = exitAtByTurn.get(turn);
      if (exitAt != null) add(turn, "complete", exitAt);
    }
    const startAt = Math.min(anchor.at, firstEvidenceAt.get(turn) ?? anchor.at);
    add(turn, "start", startAt);
  }

  let project = headerProject;
  if (project === null) {
    // Header missing cwd: the session directory name encodes the original
    // cwd lossily (all path separators became "-").
    let encoded = posix.basename(posix.dirname(path.split(/[\\/]/).join("/")));
    if (encoded.startsWith("--")) encoded = encoded.slice(2);
    if (encoded.endsWith("--")) encoded = encoded.slice(0, -2);
    const last = encoded.split("-").pop() ?? "";
    project = last ? last.slice(0, 100) : "未知项目";
    issues.add("会话头缺少 cwd；项目名由编码目录名有损解码，可能不准确");
  }
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "omp/" + sid,
      agent: AGENT,
      project,
      client: "omp",
      title,
    },
    events: [...unique.values()],
    issues: [...issues].sort(),
    tokens: [...tokens.entries()].map(([turn_id, u]) => ({ turn_id, ...u })),
  };
}

/** On-demand transcript extraction for Oh-My-Pi sessions (never persisted).
 *  Turn ids mirror parseOmp (msg-<at>-<n> or db-<created_at>-<n>), so the
 *  drawer can join this against turn.id from the event stream. */
export function extractOmpTranscript(
  path: string,
  opts?: { historyDb?: string },
): TranscriptTurn[] {
  const { sid, records, issues } = readOmp(path);
  const anchors = buildAnchors(path, sid, records, issues, opts?.historyDb);
  const turns = new Map<string, TranscriptTurn>();
  const openTurn = (i: number): TranscriptTurn => {
    const anchor = anchors[i];
    let t = turns.get(anchor.id);
    if (!t) {
      t = {
        turn_id: anchor.id,
        prompt: anchor.prompt ? truncateCodePoints(anchor.prompt) : null,
        thinking: null,
        models: [],
        tool_calls: [],
      };
      turns.set(anchor.id, t);
    }
    return t;
  };
  const toolStarts = new Map<string, { at: number; intent: string | null }>();
  const issued = new Map<string, string>();
  let anchorIdx = 0;
  for (const r of records) {
    while (anchorIdx + 1 < anchors.length && anchors[anchorIdx + 1].at <= r.at)
      anchorIdx++;
    const current = openTurn(anchorIdx);
    if (r.type === "assistant") {
      if (r.model && !current.models.includes(r.model))
        current.models.push(r.model);
      if (r.thinking)
        current.thinking = current.thinking
          ? truncateCodePoints(current.thinking + "\n" + r.thinking)
          : truncateCodePoints(r.thinking);
      for (const c of r.toolCalls ?? [])
        if (c.id) issued.set(c.id, c.name);
      continue;
    }
    if (r.type === "toolStart") {
      if (r.toolCallId && !toolStarts.has(r.toolCallId))
        toolStarts.set(r.toolCallId, {
          at: r.startedAt ?? r.at,
          intent: r.intent ?? null,
        });
      continue;
    }
    if (r.type === "toolResult") {
      const start = r.toolCallId ? toolStarts.get(r.toolCallId) : undefined;
      current.tool_calls.push({
        name:
          r.toolName ??
          (r.toolCallId ? issued.get(r.toolCallId) : undefined) ??
          "tool",
        duration_ms:
          start && r.resultAt != null && r.resultAt >= start.at
            ? Math.round(r.resultAt - start.at)
            : null,
        call_id: r.toolCallId ?? null,
        detail: start?.intent ?? null,
      });
      continue;
    }
  }
  return [...turns.values()];
}
