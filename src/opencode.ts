/** Parse OpenCode session databases into the shared Event stream.
 *
 * Basis: first-hand forensics of the real local database
 * ~/.local/share/opencode/opencode.db (5 projects / 16 sessions / 443
 * messages / 1703 parts, permission table 0 rows, session versions
 * 1.1.36–1.2.24, verified 2026-10-24). Format facts the parser relies on:
 *
 * - Old storage layout: tables project ➔ session ➔ message ➔ part with a
 *   JSON `data` column. Upstream has since migrated to session_v2 /
 *   session_message (see docs/local-adapter-research.zh-CN.md); a database
 *   carrying those tables is rejected instead of silently mis-parsed.
 * - Column timestamps lie after a re-import: whole sessions share the same
 *   message/part time_updated (the import moment), and message.time_updated
 *   diverges from data.time.completed on 377/443 rows. Only the JSON payload
 *   fields are first-hand: message.data.time.created / time.completed, and
 *   part.data inner `time` objects. DEVIATION, declared: the SQL time_created/
 *   time_updated columns are never read — they would fabricate identical
 *   import-moment timelines for every session.
 * - Turn shape: one user message, then every assistant message whose
 *   data.parentID points at it (verified 0 exceptions in 443 rows). A turn
 *   completes at the LAST assistant message's time.completed; a trailing
 *   user message without replies stays honestly open.
 * - Model generation (术语表 模型推理耗时): the assistant message span
 *   [time.created, time.completed]. Deviation from the spec's literal
 *   reasoning|text-part basis, declared on purpose: 90 text parts carry
 *   start==end on 88 of them (no duration) and reasoning parts only cover
 *   thinking bursts, so no part-level measure covers the whole streaming
 *   step. The message span therefore counts intra-message streaming gaps as
 *   model generation — measured on the 1703-part corpus the message-span
 *   figure is ~4x the reasoning+text part-duration sum (6,292,879 ms vs
 *   1,589,825 ms). Verified containment: all tool state.time spans and
 *   reasoning spans sit inside their message span (0 outside), and adjacent
 *   steps never overlap.
 * - Reasoning parts (fine-grained part timing, 285/285 carry time.start,
 *   282 also a credible end): treated as thinking bursts INSIDE the message
 *   span, not additive work. Sampled against the parent message span on the
 *   real database: 282/285 fully contained, 0 ending after completed — the
 *   timestamps are trustworthy; the 3 rows missing an end are skipped with
 *   an issue instead of guessed. They surface as "thinking" events so the
 *   turn breakdown can show a per-model thinking drill-down.
 * - Tools: part.data.state.time.{start,end} (ms) on every tool part
 *   (450/450 present, 0 inverted); status completed|error both carry real
 *   execution. Several tools may run in parallel inside one step, so the
 *   turn-level execution time is the union of tool intervals.
 * - Tokens: message.data.tokens are PER-REQUEST (verified: input/output are
 *   non-monotonic across steps — each request resets — and the optional
 *   `total` field exactly equals input+output+reasoning+cache.read+
 *   cache.write). A turn's usage is therefore the sum over its assistant
 *   messages, the same 逐请求合计 semantics as DSH; message.tokens is
 *   identical to its step-finish part tokens, so summing messages never
 *   double counts.
 * - Review wait: permission rows are ephemeral upstream (asked/replied
 *   never persisted historically) and the local table has 0 rows, so
 *   review_wait stays null (unknown) — same honest degradation as Pi/DSH.
 *
 * The database is opened read-only and the file is never written, including
 * no WAL/SHM sidecars.
 */
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import {
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

// Tables that identify the old message/part layout this adapter verifies.
const REQUIRED_TABLES = ["project", "session", "message", "part"] as const;
// Upstream's new schema names; their presence means an unverified format.
const V2_TABLES = ["session_v2", "session_message"] as const;

const num = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) ? x : 0;

const dataOf = (raw: unknown): Record<string, unknown> | null => {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

interface MessageRow {
  id: string;
  role: string;
  created: number;
  completed: number | null;
  parentID: string | null;
  model: string | null;
  tokens: TokenUsage | null;
  parts: PartRow[];
}

interface PartRow {
  type: string;
  text: string | null;
  callID: string | null;
  tool: string | null;
  toolStart: number | null;
  toolEnd: number | null;
  toolInput: unknown;
  reasoningStart: number | null;
  reasoningEnd: number | null;
}

const tokensOf = (raw: unknown): TokenUsage | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const cache =
    t.cache && typeof t.cache === "object"
      ? (t.cache as Record<string, unknown>)
      : {};
  const input = num(t.input),
    output = num(t.output),
    reasoning = num(t.reasoning);
  return {
    input_tokens: input,
    cached_input_tokens: num(cache.read),
    cache_write_input_tokens: num(cache.write),
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    // `total` is present on only 130/379 assistant messages in the real
    // corpus, and on every one of those it equals the component sum; the
    // other 249 rows carry no total, so deriving it keeps all rows
    // comparable rather than claiming a field the source omits.
    total_tokens: input + output + reasoning + num(cache.read) + num(cache.write),
  };
};

function readMessages(db: DatabaseSync, sid: string): MessageRow[] {
  const rows = db
    .prepare(
      "SELECT id, data FROM message WHERE session_id=? ORDER BY time_created, rowid",
    )
    .all(sid) as unknown as { id: string; data: string }[];
  const messages: MessageRow[] = [];
  for (const row of rows) {
    const d = dataOf(row.data);
    if (!d) continue;
    const time =
      d.time && typeof d.time === "object"
        ? (d.time as Record<string, unknown>)
        : {};
    const parts = readParts(db, row.id, sid);
    messages.push({
      id: row.id,
      role: typeof d.role === "string" ? d.role : "",
      // The SQL column equals data.time.created on the whole verified corpus;
      // the JSON payload stays the single source of truth.
      created: num(time.created),
      completed:
        typeof time.completed === "number" && Number.isFinite(time.completed)
          ? time.completed
          : null,
      parentID: typeof d.parentID === "string" ? d.parentID : null,
      model:
        typeof d.modelID === "string" && d.modelID.trim()
          ? truncateCodePoints(
              (typeof d.providerID === "string" && d.providerID.trim()
                ? d.providerID + "/"
                : "") + d.modelID,
              120,
            )
          : null,
      tokens: tokensOf(d.tokens),
      parts,
    });
  }
  return messages;
}

function readParts(
  db: DatabaseSync,
  messageId: string,
  sid: string,
): PartRow[] {
  const rows = db
    .prepare(
      "SELECT data FROM part WHERE message_id=? AND session_id=? ORDER BY rowid",
    )
    .all(messageId, sid) as unknown as { data: string }[];
  const parts: PartRow[] = [];
  for (const row of rows) {
    const d = dataOf(row.data);
    if (!d) continue;
    const state =
      d.state && typeof d.state === "object"
        ? (d.state as Record<string, unknown>)
        : {};
    const toolTime =
      state.time && typeof state.time === "object"
        ? (state.time as Record<string, unknown>)
        : {};
    const time =
      d.time && typeof d.time === "object"
        ? (d.time as Record<string, unknown>)
        : {};
    parts.push({
      type: typeof d.type === "string" ? d.type : "",
      text: typeof d.text === "string" ? d.text : null,
      callID: typeof d.callID === "string" ? d.callID : null,
      tool: typeof d.tool === "string" && d.tool.trim() ? d.tool : null,
      toolStart:
        typeof toolTime.start === "number" && Number.isFinite(toolTime.start)
          ? toolTime.start
          : null,
      toolEnd:
        typeof toolTime.end === "number" && Number.isFinite(toolTime.end)
          ? toolTime.end
          : null,
      toolInput: state.input ?? null,
      reasoningStart:
        typeof time.start === "number" && Number.isFinite(time.start)
          ? time.start
          : null,
      reasoningEnd:
        typeof time.end === "number" && Number.isFinite(time.end)
          ? time.end
          : null,
    });
  }
  return parts;
}

/** Open an OpenCode SQLite database strictly read-only and verify the old
 *  message/part schema. Any unknown layout fails loudly instead of silently
 *  producing empty statistics. */
function openVerified(file: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    throw new ValidationError("无法以只读方式打开该 SQLite 数据库；未导入");
  }
  let names: string[];
  try {
    names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
        unknown as { name: string }[]
    ).map((r) => r.name);
  } catch (e) {
    db.close();
    throw new ValidationError("该文件不是可读的 SQLite 数据库；未导入");
  }
  const has = (n: string) => names.includes(n);
  if (!REQUIRED_TABLES.every(has)) {
    if (V2_TABLES.some(has))
      throw new ValidationError(
        "OpenCode 数据库为 session_v2 新版格式（message/part 表已迁移），该格式尚未经真实样本验证；未导入",
      );
    throw new ValidationError(
      "该数据库缺少 OpenCode 会话所需的 message/part 表；未导入",
    );
  }
  return db;
}

export interface OpencodeParsed {
  session: {
    id: string;
    agent: string;
    project: string;
    client: string;
    title: string | null;
  };
  events: Event[];
  // Same shared shape every adapter hands to the store: per-turn usage keyed
  // by turn_id (TokenUsage & { turn_id }), no adapter-local field ladder.
  tokens: ({ turn_id: string } & TokenUsage)[];
  issues: string[];
}

/** Parse every session in the database. One .db file carries many sessions,
 *  so this returns one result per session row; Store.importFile registers a
 *  source snapshot per session (keyed by file + session id). */
export function parseOpencode(file: string): OpencodeParsed[] {
  const db = openVerified(file);
  try {
    const sessions = db
      .prepare(
        "SELECT s.id, s.directory, s.title, s.version, p.worktree FROM session s LEFT JOIN project p ON p.id=s.project_id ORDER BY s.time_created, s.rowid",
      )
      .all() as unknown as {
      id: string;
      directory: string;
      title: string;
      version: string;
      worktree: string | null;
    }[];
    return sessions.map((row) => parseSession(db, file, row));
  } finally {
    db.close();
  }
}

function parseSession(
  db: DatabaseSync,
  file: string,
  row: {
    id: string;
    directory: string;
    title: string;
    version: string;
    worktree: string | null;
  },
): OpencodeParsed {
  const issues = new Set<string>();
  const messages = readMessages(db, row.id);
  const events: Event[] = [];
  // Tokens are per-request on each assistant message, so a turn's usage is
  // the sum over its steps (same 逐请求合计 semantics as DSH); token_usage
  // is keyed (source, turn), so aggregation happens here, not in the store.
  const tokensByTurn = new Map<string, TokenUsage>();

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
      tool_name: (extras.tool_name || undefined) as string | undefined,
      key: hash(legacyJSON(["OpenCode", row.id, rawObj])),
    });
  };

  // A turn = one user message + every assistant message parented to it.
  // Turn numbering follows the user-message ordinal (time order), and the
  // same ids are used by extractOpencodeTranscript so the drawer can join.
  const turnByMessage = new Map<string, string>();
  const turnUsers = new Map<string, MessageRow>();
  let n = 0;
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!m.created) {
      issues.add("部分用户消息缺少有效时间戳；未猜测轮次起点");
      continue;
    }
    n++;
    const tid = "turn-" + n;
    turnUsers.set(m.id, m);
    turnByMessage.set(m.id, tid);
    add(tid, "start", m.created);
  }

  // Assistant steps grouped under their parent user message; steps verified
  // sequential (0 adjacent overlaps in the corpus).
  const stepsByTurn = new Map<string, MessageRow[]>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (!m.created) {
      issues.add("部分助手消息缺少请求时间戳；该步未计入耗时");
      continue;
    }
    const parentTurn = m.parentID ? turnByMessage.get(m.parentID) : null;
    if (!parentTurn) {
      issues.add("部分助手消息无法归属到任何用户提问轮次；未猜测归属");
      continue;
    }
    const list = stepsByTurn.get(parentTurn) ?? [];
    list.push(m);
    stepsByTurn.set(parentTurn, list);
  }

  for (const [parentId, tid] of turnByMessage) {
    const user = turnUsers.get(parentId)!;
    const steps = (stepsByTurn.get(tid) ?? []).sort(
      (a, b) => a.created - b.created,
    );
    for (const step of steps) {
      add(tid, "model", step.created, step.model, { end_ms: step.completed });
      if (step.tokens) {
        const prev = tokensByTurn.get(tid);
        if (!prev) tokensByTurn.set(tid, { ...step.tokens });
        else
          for (const f of Object.keys(step.tokens) as (keyof TokenUsage)[])
            prev[f] += step.tokens[f];
      }
      for (const part of step.parts) {
        // Reasoning spans are first-hand thinking bursts INSIDE the message
        // span (285/285 carry start; sampled containment 282/285, none past
        // completed), so they are emitted as "thinking" events for the
        // breakdown drill-down — never added to work on top of the span.
        // Rows without a credible end stay skipped with an issue, not guessed.
        if (part.type === "reasoning") {
          if (
            part.reasoningStart != null &&
            part.reasoningEnd != null &&
            part.reasoningEnd >= part.reasoningStart
          )
            add(tid, "thinking", part.reasoningStart, step.model, {
              end_ms: part.reasoningEnd,
            });
          else
            issues.add("部分 reasoning 段缺少有效起止时间戳；未计入思考耗时");
          continue;
        }
        if (part.type !== "tool") continue;
        const name = part.tool ?? "tool";
        if (part.toolStart == null) {
          issues.add("部分工具调用缺少执行时间戳；未猜测时长");
          continue;
        }
        add(tid, "tool_use", part.toolStart, null, {
          tool_id: part.callID,
          tool_name: name,
        });
        add(tid, "tool_result", part.toolStart, null, {
          end_ms: part.toolEnd,
          tool_id: part.callID,
          tool_name: name,
        });
      }
    }
    // Complete at the LAST step's completion anchor — the message spans are
    // first-hand (no lazy-write distortion like Codex task_complete rows).
    const last = steps[steps.length - 1];
    if (last?.completed != null) add(tid, "complete", last.completed);
  }

  // Project name: the project worktree basename; sessions on the pseudo
  // "global" project (worktree "/") fall back to the session directory.
  let project = row.worktree ? basename(row.worktree) : "";
  if (!project || project === "/")
    project = row.directory ? basename(row.directory) : "";
  if (!project) {
    project = "未知项目";
    issues.add("会话缺少有效的项目工作目录；项目名记为未知");
  }

  return {
    session: {
      id: "opencode/" + row.id,
      agent: "OpenCode",
      project,
      client: "opencode",
      title: row.title?.trim()
        ? truncateCodePoints(row.title.replace(/[\r\n]+/g, " ").trim(), 100)
        : null,
    },
    events,
    tokens: [...tokensByTurn.entries()].map(([turn_id, usage]) => ({
      turn_id,
      ...usage,
    })),
    issues: [...issues].sort(),
  };
}

/** On-demand transcript extraction for OpenCode sessions (never persisted).
 *  Turn ids mirror parseOpencode ("turn-<N>"), so the drawer can join this
 *  against turn.id from the event stream. Tool-call durations pair the tool
 *  state.time first-hand timestamps. */
export function extractOpencodeTranscript(
  file: string,
  sessionId?: string,
): TranscriptTurn[] {
  const db = openVerified(file);
  try {
    const want = sessionId?.startsWith("opencode/")
      ? sessionId.slice("opencode/".length)
      : sessionId;
    const rows = (
      db.prepare("SELECT id FROM session ORDER BY time_created, rowid").all() as unknown as {
        id: string;
      }[]
    ).map((r) => r.id);
    const ids = want ? rows.filter((id) => id === want) : rows;
    const turns: TranscriptTurn[] = [];
    for (const sid of ids) {
      const messages = readMessages(db, sid);
      let n = 0;
      for (const user of messages) {
        if (user.role !== "user" || !user.created) continue;
        n++;
        const tid = "turn-" + n;
        const turn: TranscriptTurn = {
          turn_id: tid,
          prompt: null,
          thinking: null,
          models: [],
          tool_calls: [],
        };
        const promptText = user.parts
          .filter((p) => p.type === "text" && p.text?.trim())
          .map((p) => p.text!.trim())
          .join("\n");
        if (promptText) turn.prompt = truncateCodePoints(promptText);
        const steps = messages
          .filter((m) => m.role === "assistant" && m.parentID === user.id)
          .sort((a, b) => a.created - b.created);
        for (const step of steps) {
          if (step.model && !turn.models.includes(step.model))
            turn.models.push(step.model);
          for (const part of step.parts) {
            if (
              part.type === "reasoning" &&
              part.text?.trim()
            ) {
              turn.thinking = turn.thinking
                ? truncateCodePoints(turn.thinking + "\n" + part.text.trim())
                : truncateCodePoints(part.text.trim());
            }
            if (part.type !== "tool") continue;
            turn.tool_calls.push({
              name: part.tool ?? "tool",
              duration_ms:
                part.toolStart != null && part.toolEnd != null && part.toolEnd >= part.toolStart
                  ? part.toolEnd - part.toolStart
                  : null,
              call_id: part.callID,
              detail: toolCallDetail(part.toolInput),
            });
          }
        }
        turns.push(turn);
      }
    }
    return turns;
  } finally {
    db.close();
  }
}
