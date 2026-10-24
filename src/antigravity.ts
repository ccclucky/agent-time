/** Parse Antigravity (Google IDE) conversation transcripts into the shared
 *  Event stream. Basis: verified against local real samples under
 *  ~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/
 *  (2026-10 corpus, issue #9). Only timing metadata is persisted; tool
 *  arguments and message content never leave the machine.
 *
 *  Record vocabulary (verified on real data — the issue text approximated it):
 *  - source: USER_EXPLICIT | MODEL | SYSTEM
 *  - type:   USER_INPUT | PLANNER_RESPONSE | GENERIC | SYSTEM_MESSAGE
 *            | ERROR_MESSAGE | CHECKPOINT
 *  - PLANNER_RESPONSE carries plaintext `thinking` (no ZDR-style encryption),
 *    optional `tool_calls[{name,args}]` and per-request token counts
 *    (input_tokens / cache_read_tokens / output_tokens — direct per-request
 *    values, not cumulative snapshots, so per-turn usage is a plain sum,
 *    never a diff).
 *  - GENERIC carries the tool result text; its created_at is the result
 *    append time, which for ask_question is exactly the moment the user
 *    answered — so the user-decision wait lives fully inside the turn and
 *    never leaks into the next turn's standby.
 *  - transcript.jsonl is the registered primary source; transcript_full.jsonl
 *    (same record set locally) is rejected at discovery to prevent double
 *    imports and metric drift.
 *
 *  Three-state mapping (ADR 0003):
 *  - work_ms: wall-clock elapsed minus review wait (shared event calculator).
 *  - review_wait_ms: ask_question tool intervals [call, user answer].
 *  - standby_ms: store-computed gap between turns; the turn completion
 *    anchor is the last model-activity record, mirroring the Codex lazy
 *    completion calibration (ADR 0002).
 *  - Background tasks ("Tool is running as a background task with task id:
 *    <conv>/task-N") defer their tool_result to the record that reports the
 *    task finished/cancelled, so the full parallel execution counts as tool
 *    time (same reasoning as Codex ADR 0002 rule 7). invoke_subagent /
 *    manage_subagents spawns additionally tag their events with agent_id =
 *    task id so groupSubagents builds the drill-down topology.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lines, timestamp, hash, legacyJSON, truncateCodePoints } from "./codex.js";
import {
  ValidationError,
  type Event,
  type TokenUsage,
  type TranscriptToolCall,
  type TranscriptTurn,
} from "./types.js";

const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);

interface AgToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface AgRecord {
  type: string;
  source: string;
  step: number;
  at: number;
  toolCalls: AgToolCall[];
  content: string | null;
  thinking: string | null;
  tokens: { input: number; cached: number; output: number } | null;
}

// transcript.jsonl path embeds the conversation id: brain/<id>/.system_generated/logs/
const CONV_PATH = /[/\\]brain[/\\]([^/\\]+)[/\\]\.system_generated[/\\]logs[/\\]transcript\.jsonl$/;
// Spawn receipt: "Tool is running as a background task with task id:
// <conv-id>/task-8 …". Task ids carry the conversation id with slashes.
const TASK_SPAWNED = /task id:\s*("?[\w.:/-]+"?)/;
// Completion receipt on SYSTEM_MESSAGE: "Task id "<id>" finished with result:".
// (The GENERIC "Task: <id> Status: DONE" rows are poll-tool results and pair
// through the normal FIFO path; the SYSTEM row is the authoritative receipt.)
const TASK_FINISHED_SYSTEM = /Task id "?([\w.:/-]+)"? finished/i;
// Known record sources (verified corpus); anything else gets an issue note.
const KNOWN_SOURCES = new Set(["USER_EXPLICIT", "MODEL", "SYSTEM"]);

// A tool call awaiting its result, as tracked by the shared pairer below.
interface PairedTool {
  id: string;
  name: string;
  at: number;
  turnId: string;
  backgroundTaskId: string | null;
}

// Shared FIFO tool-result pairing for BOTH the event stream and the
// transcript extractor, so durations can never drift between the two.
// Mechanics only: FIFO match within the issuing turn, background-task
// deferral on spawn receipts, completion via SYSTEM receipts. A duplicate
// spawn receipt stays timing-neutral instead of truncating the deferred
// tool at spawn time. The corpus carries no call ids, so parallel results
// pair FIFO — per-tool durations may swap on reordering, per-turn totals
// remain exact (documented in ADR 0003).
class ToolPairer {
  private open: PairedTool[] = [];
  private spawned = new Map<string, PairedTool>();

  issue(
    turnId: string,
    at: number,
    names: string[],
    idOf: (index: number) => string,
  ): PairedTool[] {
    const tools = names.map((name, i) => {
      const tool: PairedTool = {
        id: idOf(i),
        name,
        at,
        turnId,
        backgroundTaskId: null,
      };
      this.open.push(tool);
      return tool;
    });
    return tools;
  }

  /** Result record (GENERIC). Returns the tool this record closes, or null
   *  when the record is timing-neutral (no pending tool, poll row, or a
   *  duplicate spawn receipt). */
  result(turnId: string, at: number, content: string | null): PairedTool | null {
    const spawned = TASK_SPAWNED.exec(content ?? "");
    const idx = this.open.findIndex(
      (t) => t.turnId === turnId && !t.backgroundTaskId,
    );
    const tool = idx !== -1 ? this.open[idx] : null;
    if (tool && spawned) {
      const taskId = spawned[1]?.replaceAll('"', "") ?? null;
      if (taskId && !this.spawned.has(taskId)) {
        tool.backgroundTaskId = taskId;
        this.spawned.set(taskId, tool);
        return null; // deferred: the completion receipt will close it
      }
      // Duplicate spawn receipt (task id already tracked): timing-neutral,
      // never an early close of the deferred tool.
      return null;
    }
    if (tool) {
      this.open.splice(idx, 1);
      return tool;
    }
    return null;
  }

  /** SYSTEM_MESSAGE completion receipt. Returns the deferred tool it closes. */
  receipt(at: number, content: string | null): PairedTool | null {
    const finished = TASK_FINISHED_SYSTEM.exec(content ?? "");
    const match = finished ? this.spawned.get(finished[1]!) : null;
    if (!finished || !match) return null;
    this.spawned.delete(finished[1]!);
    const idx = this.open.indexOf(match);
    if (idx !== -1) this.open.splice(idx, 1);
    return match;
  }

  unfinished(): number {
    return this.spawned.size;
  }
}

function readAgRecords(path: string): { records: AgRecord[]; badLines: number } {
  const records: AgRecord[] = [];
  let badLines = 0;
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error();
      if (r.status === "INVALID") continue;
      const toolCalls = Array.isArray(r.tool_calls)
        ? (r.tool_calls.filter(
            (t: unknown) =>
              t && typeof t === "object" && typeof (t as AgToolCall).name === "string",
          ) as AgToolCall[])
        : [];
      records.push({
        type: typeof r.type === "string" ? r.type : "",
        source: typeof r.source === "string" ? r.source : "",
        step: typeof r.step_index === "number" ? r.step_index : records.length,
        at: timestamp(r.created_at),
        toolCalls,
        content:
          typeof r.content === "string" && r.content.trim() ? r.content : null,
        thinking:
          typeof r.thinking === "string" && r.thinking.trim() ? r.thinking : null,
        tokens:
          typeof r.input_tokens === "number" ||
          typeof r.cache_read_tokens === "number" ||
          typeof r.output_tokens === "number"
            ? {
                input: typeof r.input_tokens === "number" ? r.input_tokens : 0,
                cached:
                  typeof r.cache_read_tokens === "number" ? r.cache_read_tokens : 0,
                output: typeof r.output_tokens === "number" ? r.output_tokens : 0,
              }
            : null,
      });
    } catch {
      badLines++;
    }
  }
  return { records, badLines };
}

export function parseAntigravity(path: string) {
  const convMatch = CONV_PATH.exec(path);
  if (!convMatch || !validId(convMatch[1]))
    throw new ValidationError(
      "无法从路径确定 Antigravity 会话 ID（需位于 brain/<会话 ID>/.system_generated/logs/transcript.jsonl）",
    );
  const sid = convMatch[1];
  const { records, badLines } = readAgRecords(path);
  const issues = new Set<string>();
  if (badLines) issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
  if (records.some((r) => r.source && !KNOWN_SOURCES.has(r.source)))
    issues.add(
      "存在未知 source 的记录；已按记录类型解析，如上游更新词汇表请复核口径",
    );

  const events: Event[] = [];
  const add = (
    turn_id: string,
    kind: Event["kind"],
    at_ms: number,
    extras: {
      end_ms?: number | null;
      tool_id?: string | null;
      tool_name?: string | null;
      agent_id?: string | null;
    } = {},
  ) => {
    const rawObj: Record<string, unknown> = { turn_id, kind, at_ms };
    if (extras.end_ms != null) rawObj.end_ms = extras.end_ms;
    if (extras.tool_id) rawObj.tool_id = extras.tool_id;
    if (extras.tool_name) rawObj.tool_name = extras.tool_name;
    if (extras.agent_id) rawObj.agent_id = extras.agent_id;
    events.push({
      turn_id,
      kind,
      at_ms,
      model: null,
      end_ms: extras.end_ms ?? undefined,
      tool_id: extras.tool_id ?? undefined,
      tool_name: extras.tool_name ?? undefined,
      agent_id: extras.agent_id ?? undefined,
      key: hash(legacyJSON(["Antigravity", sid, rawObj])),
    });
  };

  const isModelActivity = (r: AgRecord) =>
    r.type === "PLANNER_RESPONSE" || r.type === "GENERIC";

  // Tool state lives across turns: a background task spawned in turn 1 can
  // finish while turn 2 is already open; its tool_result then lands on the
  // spawning turn where the execution actually belongs (the pairer filters
  // immediate results by the issuing turn).
  const pairer = new ToolPairer();

  let current: string | null = null,
    turnRecords: AgRecord[] = [],
    pendingFail: { at: number } | null = null,
    seenLeading = false;
  const turnTokens = new Map<
    string,
    { input: number; cached: number; output: number }
  >();

  // Flushes the open turn: emits the completion/fail anchor from the last
  // model-activity record. A trailing GENERIC (tool result without a model
  // follow-up) still anchors a non-final turn — the next USER_INPUT proves
  // the user moved on — while an EOF turn ending on GENERIC stays open
  // (likely still running); both get an honest issue note, never a
  // fabricated reply.
  const endTurn = (eof: boolean) => {
    if (!current) return;
    const turnId = current;
    if (pendingFail) {
      add(turnId, "fail", pendingFail.at);
      pendingFail = null;
    } else {
      const lastActivity = [...turnRecords].reverse().find(isModelActivity);
      if (lastActivity) {
        if (lastActivity.type === "GENERIC" && eof)
          issues.add(
            "部分轮次以工具结果收尾且未见模型回复；会话结束时仍视为进行中，未计入耗时",
          );
        else {
          if (lastActivity.type === "GENERIC")
            issues.add(
              "部分轮次以工具结果收尾，未观察到模型回复；完成锚点取最后一条模型活动记录",
            );
          add(turnId, "complete", lastActivity.at);
        }
      }
    }
    current = null;
    turnRecords = [];
  };

  // Subagent sessions (invoke_subagent spawns a child conversation) carry no
  // USER_INPUT at all: bootstrap a leading turn from the first record so the
  // child's real machine time is measured instead of dropping every record.
  const sawUser = records.some((r) => r.type === "USER_INPUT");
  if (records.length && !sawUser) {
    current = "antigravity-turn-" + records[0].step;
    turnRecords = [];
    add(current, "start", records[0].at);
    issues.add("会话无 USER_INPUT 记录（如子代理会话）；以首条记录为轮起点");
  }

  for (const r of records) {
    if (r.type === "USER_INPUT") {
      endTurn(false);
      current = "antigravity-turn-" + r.step;
      turnRecords = [r];
      add(current, "start", r.at);
      continue;
    }
    if (!current) {
      if (!seenLeading) {
        seenLeading = true;
        issues.add("存在先于首条用户输入的记录；未计入统计");
      }
      continue;
    }
    turnRecords.push(r);
    if (r.type === "CHECKPOINT") continue; // compaction resume marker: timing-neutral

    if (r.type === "ERROR_MESSAGE") {
      // API errors are usually auto-retried; the turn only really failed when
      // the next user input (or EOF) arrives with no model activity between.
      pendingFail = { at: r.at };
      continue;
    }
    // Any model activity after an error proves the request was retried.
    if (isModelActivity(r)) pendingFail = null;

    if (r.type === "PLANNER_RESPONSE") {
      if (r.tokens) {
        const agg = turnTokens.get(current) ?? { input: 0, cached: 0, output: 0 };
        agg.input += r.tokens.input;
        agg.cached += r.tokens.cached;
        agg.output += r.tokens.output;
        turnTokens.set(current, agg);
      }
      const issued = pairer.issue(
        current,
        r.at,
        r.toolCalls.map((tc) => tc.name),
        (i) => `step-${r.step}-${i}`,
      );
      for (const tool of issued) {
        add(current, "tool_use", r.at, {
          tool_id: tool.id,
          tool_name: tool.name,
        });
        if (tool.name === "ask_question") add(current, "review_wait_start", r.at);
      }
      continue;
    }

    if (r.type === "GENERIC") {
      const tool = pairer.result(current, r.at, r.content);
      if (tool) {
        // invoke_subagent spawns a child conversation: its result names the
        // child id. Tag the tool pair with agent_id = child id so
        // groupSubagents exposes the derivation topology; the child session
        // carries its own measured work (parent span covers the spawn only).
        let agentId: string | null = null;
        if (tool.name === "invoke_subagent" || tool.name === "manage_subagents") {
          const child = /conversationId"?\s*[:=]\s*"?([\w.:/-]+)/.exec(r.content ?? "");
          if (child) {
            agentId = child[1];
            for (const e of events)
              if (e.tool_id === tool.id && e.kind === "tool_use") e.agent_id = agentId;
          }
        }
        add(tool.turnId, "tool_result", r.at, {
          end_ms: r.at,
          tool_id: tool.id,
          tool_name: tool.name,
          agent_id: agentId,
        });
        if (tool.name === "ask_question") add(tool.turnId, "review_wait_end", r.at);
      }
      // GENERIC without a pending tool (status polls, stray results) carries
      // no pairable timing evidence and stays timing-neutral.
      continue;
    }

    if (r.type === "SYSTEM_MESSAGE") {
      // "Task id "<conv>/task-22" finished with result:" — completion receipt
      // for a deferred background tool (subagent or backgrounded command).
      const match = pairer.receipt(r.at, r.content);
      if (match)
        add(match.turnId, "tool_result", r.at, {
          end_ms: r.at,
          tool_id: match.id,
          tool_name: match.name,
        });
      continue;
    }
  }
  endTurn(true);
  // A still-open background task leaves its tool_use unpaired: the calculator
  // scores it zero rather than inventing a duration.
  if (pairer.unfinished())
    issues.add("部分后台任务在记录结束前尚未完成；其耗时未计入（不编造时长）");

  const tokens = [...turnTokens.entries()].map(
    ([turn_id, t]): { turn_id: string } & TokenUsage => ({
      turn_id,
      input_tokens: t.input,
      cached_input_tokens: t.cached,
      cache_write_input_tokens: 0,
      output_tokens: t.output,
      reasoning_output_tokens: 0,
      // Prompt tokens split into non-cached (input) and cache-read parts;
      // the source reports no grand total, so it is derived, never asserted.
      total_tokens: t.input + t.cached + t.output,
    }),
  );
  issues.add(
    "Antigravity：基于 USER_INPUT/PLANNER_RESPONSE/GENERIC 记录流、ask_question 阻断与后台任务完成标记的三态切分",
  );
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "antigravity/" + sid,
      agent: "Antigravity",
      project: "未知项目",
      client: "antigravity",
    },
    events: [...unique.values()],
    tokens,
    issues: [...issues].sort(),
  };
}

/** Conversation index enrichment (ADR 0002 §9 single-channel title pattern):
 *  conversation_summaries.db is the global registry — title and workspace
 *  come from here at import time, recomputed on every import, so a dropped
 *  row clears the stored title. The db is opened read-only: it is a live
 *  application database owned by the Antigravity IDE. Missing/unreadable db
 *  degrades to "no enrichment" and never fails the import.
 */
export interface ConversationIndexEntry {
  title: string | null;
  project: string | null;
}
export function readConversationIndex(
  configRoot: string | null,
): Map<string, ConversationIndexEntry> {
  const map = new Map<string, ConversationIndexEntry>();
  if (!configRoot) return map;
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(join(configRoot, "conversation_summaries.db"), {
      readOnly: true,
    });
  } catch {
    return map;
  }
  try {
    const rows = db
      .prepare(
        "SELECT conversation_id,title,workspace_uris FROM conversation_summaries",
      )
      .all() as unknown as {
      conversation_id: string;
      title: string;
      workspace_uris: string;
    }[];
    for (const row of rows) {
      if (!validId(row.conversation_id)) continue;
      let project: string | null = null;
      try {
        const uris = JSON.parse(row.workspace_uris);
        if (Array.isArray(uris) && typeof uris[0] === "string") {
          const p = uris[0].replace(/^file:\/\//, "").replace(/\/+$/, "");
          project = basename(p) || null;
        }
      } catch {
        // Unparseable workspace list: project stays unknown, title still lands.
      }
      map.set(row.conversation_id, {
        title: row.title?.trim()
          ? truncateCodePoints(row.title.trim(), 100)
          : null,
        project,
      });
    }
  } catch {
    return map;
  } finally {
    db.close();
  }
  return map;
}

/** One-line operation detail for the transcript drawer, derived from tool
 *  args only (never persisted server-side). Preferred keys first, then the
 *  first string field, so common tools read naturally without per-tool
 *  lookup tables. */
const detailFromArgs = (args: Record<string, unknown>): string | null => {
  const preferred = [
    "CommandLine", "Command", "Prompt", "TaskDescription",
    "questions", "question", "Path", "FilePath", "File", "query",
  ];
  const clean = (v: string) =>
    truncateCodePoints(v.replace(/^"|"$/g, "").replace(/\\n/g, " "), 120);
  for (const k of preferred) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) return clean(v);
  }
  return null;
};

interface OpenTranscriptTool {
  call: TranscriptToolCall;
  tool: PairedTool;
}

/** On-demand transcript extraction for Antigravity sessions. Turn ids mirror
 *  parseAntigravity (antigravity-turn-<USER_INPUT step_index>) so the drawer
 *  can join against turn.id. Tool durations run through the same shared
 *  ToolPairer as the event stream, deferring background tasks to their
 *  completion receipt, so the drawer can never disagree with the stats. */
export function extractAntigravityTranscript(path: string): TranscriptTurn[] {
  const convMatch = CONV_PATH.exec(path);
  if (!convMatch || !validId(convMatch[1])) return [];
  const { records } = readAgRecords(path);
  const turns = new Map<string, TranscriptTurn>();
  let current: TranscriptTurn | null = null,
    currentTurnId: string | null = null;
  const pairer = new ToolPairer();
  const callByToolId = new Map<string, OpenTranscriptTool>();

  const closeTool = (tool: PairedTool, at: number) => {
    const entry = callByToolId.get(tool.id);
    if (!entry) return;
    callByToolId.delete(tool.id);
    entry.call.duration_ms = Math.max(0, at - tool.at);
  };

  for (const r of records) {
    if (r.type === "USER_INPUT") {
      current = {
        turn_id: "antigravity-turn-" + r.step,
        prompt: r.content ? truncateCodePoints(r.content) : null,
        thinking: null,
        models: [],
        tool_calls: [],
      };
      turns.set(current.turn_id, current);
      currentTurnId = current.turn_id;
      continue;
    }
    if (!current || !currentTurnId) continue;
    if (r.type === "PLANNER_RESPONSE") {
      if (r.thinking)
        current.thinking = current.thinking
          ? truncateCodePoints(current.thinking + "\n" + r.thinking)
          : truncateCodePoints(r.thinking);
      const issued = pairer.issue(
        currentTurnId,
        r.at,
        r.toolCalls.map((tc) => tc.name),
        (i) => `step-${r.step}-${i}`,
      );
      r.toolCalls.forEach((tc, i) => {
        const call: TranscriptToolCall = {
          name: tc.name,
          duration_ms: null,
          detail: detailFromArgs(tc.args ?? {}),
        };
        current!.tool_calls.push(call);
        callByToolId.set(issued[i].id, { call, tool: issued[i] });
      });
      continue;
    }
    if (r.type === "GENERIC") {
      const tool = pairer.result(currentTurnId, r.at, r.content);
      if (tool) closeTool(tool, r.at);
      continue;
    }
    if (r.type === "SYSTEM_MESSAGE") {
      const tool = pairer.receipt(r.at, r.content);
      if (tool) closeTool(tool, r.at);
    }
  }
  // Unresolved tools keep duration_ms null (honest, no invention).
  return [...turns.values()];
}
