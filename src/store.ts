import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  chmodSync,
  realpathSync,
  statSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parse,
  hash,
  truncateCodePoints,
  TRANSCRIPT_TEXT_LIMIT,
  extractCodexTranscript,
  readSessionIndex,
  ExcludedSessionError,
  type IndexedThread,
} from "./codex.js";
import { parseClaude, extractClaudeTranscript } from "./claude.js";
import { parsePi, extractPiTranscript } from "./pi.js";
import { parseDsh, extractDshTranscript } from "./dsh.js";
import {
  parseAntigravity,
  extractAntigravityTranscript,
  readConversationIndex,
  type ConversationIndexEntry,
} from "./antigravity.js";
import { parseOmp, extractOmpTranscript } from "./omp.js";
import {
  parseOpencode,
  extractOpencodeTranscript,
} from "./opencode.js";
import { SCHEMA } from "./schema.js";
import { Directories, isSessionFile } from "./directories.js";
import { expand } from "./locations.js";
import { unionMs } from "./metrics.js";
import {
  addUsage,
  mapUsage,
  ValidationError,
  zeroUsage,
  type AdapterName,
  type Event,
  type Session,
  type SessionTranscript,
  type Status,
  type SubagentSummary,
  type TokenUsage,
  type TranscriptTurn,
  type Turn,
  type TurnBreakdown,
} from "./types.js";

// session_index.jsonl is read once per config root per refresh/import call:
// repeated imports under the same root (799 files locally) reuse one parsed
// Map instead of re-reading the index for every file.
type SessionIndexCache = Map<string, Map<string, IndexedThread>>;

// On-demand transcript extractor dispatch (agent name → extractor). Unknown
// agent names fall back to the Codex extractor, matching the previous
// ternary chain; nothing here is persisted.
const TRANSCRIPT_EXTRACTORS: Record<
  string,
  (path: string) => TranscriptTurn[]
> = {
  "Claude Code": extractClaudeTranscript,
  Pi: extractPiTranscript,
  Codex: extractCodexTranscript,
  Antigravity: extractAntigravityTranscript,
  "DeepSeek Harness": extractDshTranscript,
  "Oh-My-Pi": extractOmpTranscript,
};

// conversation_summaries.db is read once per config root per refresh/import
// call, mirroring the session_index cache above.
type ConversationIndexCache = Map<string, Map<string, ConversationIndexEntry>>;

function sessionIndex(
  configRoot: string,
  cache: SessionIndexCache,
): Map<string, IndexedThread> {
  const key = path.resolve(configRoot);
  let index = cache.get(key);
  if (!index) cache.set(key, (index = readSessionIndex(key)));
  return index;
}

// Saved-snapshot agent name → adapter for refresh re-imports that directory
// discovery did not classify (files imported via CLI whose directory entry is
// disabled or gone). The previous nested ternary silently fell back to
// "codex" for ANY unknown name, mis-routing foreign snapshots through the
// wrong parser; unknown names now fail loudly so the file surfaces as a sync
// failure instead of wrong-adapter statistics. A missing name keeps the
// historical Codex default: the agent column was added via ALTER TABLE with
// NOT NULL DEFAULT 'Codex', so every pre-existing row is stamped 'Codex'.
function savedAgentAdapter(agent: string | undefined | null): AdapterName {
  if (agent == null) return "codex";
  switch (agent) {
    case "Codex":
      return "codex";
    case "Claude Code":
      return "claude";
    case "Pi":
      return "pi";
    case "Antigravity":
      return "antigravity";
    case "DeepSeek Harness":
      return "dsh";
    case "OpenCode":
      return "opencode";
    case "Oh-My-Pi":
      return "omp";
    default:
      throw new ValidationError(
        `已登记会话的 Agent 标识无法识别（${agent}）；已跳过该文件，防止误按 Codex 口径分流`,
      );
  }
}

function conversationIndex(
  configRoot: string,
  cache: ConversationIndexCache,
): Map<string, ConversationIndexEntry> {
  const key = path.resolve(configRoot);
  let index = cache.get(key);
  if (!index) cache.set(key, (index = readConversationIndex(key)));
  return index;
}

interface Source {
  agent: string;
  id: string;
  path: string;
  session_id: string;
  project: string;
  client: string;
  issues: string;
  last_error: string | null;
  config_root: string | null;
  imported_at: string;
  title: string | null;
}

/** refresh 用已落库快照行：last_size/last_mtime_ns 是上次成功导入时源文件的
 *  签名（mtimeNs 超出 Number 安全整数，存 TEXT 做精确相等比较）。title/project
 *  一并带出，供跳过路径的富化做纯内存比较，避免逐行 SELECT 的 N+1。 */
type SavedRow = Pick<
  Source,
  "id" | "path" | "session_id" | "config_root" | "agent" | "last_error" | "title"
> & { project: string; last_size: number | null; last_mtime_ns: string | null };

export function groupSubagents(
  events: Event[],
  turns: Turn[] = [],
): SubagentSummary[] {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    if (e.agent_id) {
      const list = map.get(e.agent_id) ?? [];
      list.push(e);
      map.set(e.agent_id, list);
    }
  }
  const result: SubagentSummary[] = [];
  for (const [subId, sEvents] of map.entries()) {
    sEvents.sort((a, b) => a.at_ms - b.at_ms);
    const subStart = sEvents[0].at_ms;
    const subEnd = sEvents[sEvents.length - 1].at_ms;
    result.push({
      agent_id: subId,
      start_ms: subStart,
      end_ms: subEnd,
      work_ms: Math.max(0, subEnd - subStart),
      review_wait_ms: 0,
      turns: turns.filter((t) => t.events.some((e) => e.agent_id === subId)),
    });
  }
  return result;
}

/**
 * Three-state timing shared by Claude Code and Codex. Both adapters emit the
 * same event vocabulary (turn boundaries, tool_use/tool_result pairs keyed by
 * tool_id, optional review_wait_start/end). With no review-wait events it
 * degrades naturally: review_wait_ms = 0 and work = elapsed - tool time.
 */
export function calculateEventTiming(
  entries: Event[],
  start: number,
  end: number,
  elapsed: number,
): {
  work_ms: number;
  review_wait_ms: number;
  breakdown: TurnBreakdown;
} {
  const waitStarts = entries
    .filter((e) => e.kind === "review_wait_start")
    .map((e) => e.at_ms)
    .sort((a, b) => a - b);
  const waitEnds = entries
    .filter((e) => e.kind === "review_wait_end")
    .map((e) => e.at_ms)
    .sort((a, b) => a - b);

  const waitIntervals: [number, number][] = [];
  const usedWaitEnds = new Set<number>();
  for (const wStart of waitStarts) {
    const wEndIdx = waitEnds.findIndex(
      (t, idx) => !usedWaitEnds.has(idx) && t >= wStart,
    );
    let wEnd = end;
    if (wEndIdx !== -1) {
      usedWaitEnds.add(wEndIdx);
      wEnd = waitEnds[wEndIdx];
    }
    if (wEnd > wStart) {
      waitIntervals.push([wStart, wEnd]);
    }
  }
  const totalWait = unionMs(waitIntervals);

  const toolUses = entries.filter((e) => e.kind === "tool_use");
  const toolResults = entries.filter((e) => e.kind === "tool_result");
  const usedResultIndices = new Set<number>();
  const toolsMap = new Map<string, { name: string; count: number; duration_ms: number }>();
  let totalToolMs = 0;

  for (const u of toolUses) {
    const tname = u.tool_name || "tool";
    let rIndex = -1;
    if (u.tool_id) {
      rIndex = toolResults.findIndex(
        (r, idx) =>
          !usedResultIndices.has(idx) &&
          r.tool_id === u.tool_id &&
          r.at_ms >= u.at_ms,
      );
    }
    if (rIndex === -1) {
      rIndex = toolResults.findIndex(
        (r, idx) => !usedResultIndices.has(idx) && r.at_ms >= u.at_ms,
      );
    }

    let tDuration = 0;
    if (rIndex !== -1) {
      usedResultIndices.add(rIndex);
      const rAt = toolResults[rIndex].at_ms;
      let waitInside = 0;
      for (const [ws, we] of waitIntervals) {
        const overlap = Math.max(0, Math.min(rAt, we) - Math.max(u.at_ms, ws));
        waitInside += overlap;
      }
      tDuration = Math.max(0, rAt - u.at_ms - waitInside);
    }
    totalToolMs += tDuration;
    const existing = toolsMap.get(tname) ?? { name: tname, count: 0, duration_ms: 0 };
    existing.count += 1;
    existing.duration_ms += tDuration;
    toolsMap.set(tname, existing);
  }

  const modelApiMs = Math.max(0, elapsed - totalToolMs - totalWait);
  const work_ms = Math.max(0, elapsed - totalWait);
  return {
    work_ms,
    review_wait_ms: totalWait,
    breakdown: {
      model_api_ms: modelApiMs,
      tool_execution_ms: totalToolMs,
      review_wait_ms: totalWait,
      tools: [...toolsMap.values()],
    },
  };
}

/** Pi three-state timing split (ADR-0001 semantics adapted to Pi evidence).
 * work_ms is machine-time accumulation of first-hand duration evidence:
 * model response spans (end_ms - at_ms) plus tool execution spans on
 * tool_result events. It is independent of the wall-clock elapsed span, so
 * parallel tools may legitimately push it above elapsed_ms.
 */
export function calculatePiTiming(
  entries: Event[],
  start: number,
  end: number,
  elapsed: number,
): {
  work_ms: number;
  review_wait_ms: number | null;
  breakdown: TurnBreakdown;
} {
  let modelApiMs = 0;
  let toolMs = 0;
  const modelTotals = new Map<string, number>();
  const thinkingTotals = new Map<string, number>();
  // Model events without end_ms (model_change / thinking_level_change
  // markers) carry no duration evidence and contribute zero.
  for (const e of entries) {
    if (e.kind !== "model" || e.end_ms == null || e.end_ms < e.at_ms) continue;
    const dur = e.end_ms - e.at_ms;
    modelApiMs += dur;
    // Response spans recorded without a model name (message.model absent)
    // still carry timing evidence; bucket them instead of dropping.
    const modelKey = e.model ?? "未知模型";
    modelTotals.set(modelKey, (modelTotals.get(modelKey) ?? 0) + dur);
    if (e.thinking_level)
      thinkingTotals.set(
        e.thinking_level,
        (thinkingTotals.get(e.thinking_level) ?? 0) + dur,
      );
  }
  // Tools aggregate from tool_result events, where Pi's duration evidence
  // lives (at_ms = tool start, end_ms = result creation).
  const toolsMap = new Map<string, { name: string; count: number; duration_ms: number }>();
  // Unclassified delay: positive interval from the issuing response end
  // (tool_use.at_ms = tool ready) to the actual tool start (tool_result.at_ms),
  // unioned across parallel calls. Pi persists no approval/permission events,
  // so this gap cannot be attributed to human review — it may equally be
  // scheduling, extension work, or rate limiting. It is reported separately
  // and never counted as review wait. Fallback results start exactly at the
  // issuing response end, contributing zero naturally.
  const toolUses = entries.filter(
    (e) => e.kind === "tool_use" && e.tool_id != null,
  );
  const usedUses = new Set<number>();
  const delayIntervals: [number, number][] = [];
  for (const r of entries) {
    if (r.kind !== "tool_result") continue;
    const dur =
      r.end_ms != null && r.end_ms >= r.at_ms ? r.end_ms - r.at_ms : 0;
    toolMs += dur;
    const tname = r.tool_name || "tool";
    const agg = toolsMap.get(tname) ?? { name: tname, count: 0, duration_ms: 0 };
    agg.count += 1;
    agg.duration_ms += dur;
    toolsMap.set(tname, agg);
    if (r.tool_id == null) continue;
    const uIdx = toolUses.findIndex(
      (u, idx) => !usedUses.has(idx) && u.tool_id === r.tool_id && r.at_ms > u.at_ms,
    );
    if (uIdx !== -1) {
      usedUses.add(uIdx);
      delayIntervals.push([toolUses[uIdx].at_ms, r.at_ms]);
    }
  }
  const unclassifiedDelayMs = unionMs(delayIntervals);
  return {
    work_ms: modelApiMs + toolMs,
    // Pi sources carry no approval evidence; review wait stays unknown.
    review_wait_ms: null,
    breakdown: {
      model_api_ms: modelApiMs,
      tool_execution_ms: toolMs,
      unclassified_delay_ms: unclassifiedDelayMs,
      tools: [...toolsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      model_api_breakdown: [...modelTotals.entries()]
        .map(([model, duration_ms]) => ({ model, duration_ms }))
        .sort((a, b) => a.model.localeCompare(b.model)),
      thinking_breakdown: [...thinkingTotals.entries()]
        .map(([level, duration_ms]) => ({ level, duration_ms }))
        .sort((a, b) => a.level.localeCompare(b.level)),
    },
  };
}

/** OpenCode three-state timing split (ADR-0002 semantics on message/part
 *  evidence). Unlike Pi/DSH, OpenCode's model span (assistant message
 *  [created, completed]) CONTAINS its tool execution: verified on the
 *  1703-part corpus, every tool state.time span sits inside its message
 *  span and adjacent steps never overlap. So the turn's model API time is
 *  the model spans minus the UNION of tool intervals (parallel calls must
 *  not be subtracted twice), tool execution is that union, and work is
 *  their sum (the full streaming spans). Review wait stays unknown: the
 *  permission table is ephemeral upstream and empty locally.
 *
 *  Two honest side-ledgers, neither folded into work:
 *  - unclassified_delay_ms: gaps between consecutive steps inside a turn
 *    (step N completed → step N+1 created). Real corpus: 315/315 gaps
 *    positive, 5,999 ms total, max 203 ms — neither streaming nor tool
 *    execution; attribution unknown (scheduling, extensions), so it is
 *    reported separately like Pi's tool-ready gap.
 *  - thinking_breakdown: reasoning-part spans emitted as "thinking" events.
 *    They sit INSIDE the model span (sampled containment 282/285, none past
 *    completed), so they are a sub-drill of model_api_ms, never additive.
 *
 *  Signature takes only the event entries: every duration is first-hand
 *  evidence on the events; the turn's wall-clock start/end/elapsed play no
 *  role in the split and the parameters were dead weight.
 */
export function calculateOpencodeTiming(entries: Event[]): {
  work_ms: number;
  review_wait_ms: number | null;
  breakdown: TurnBreakdown;
} {
  const toolIntervals: [number, number][] = [];
  for (const e of entries)
    if (e.kind === "tool_result" && e.end_ms != null && e.end_ms >= e.at_ms)
      toolIntervals.push([e.at_ms, e.end_ms]);
  const toolMs = unionMs(toolIntervals);

  const modelTotals = new Map<string, number>();
  const modelSpans: [number, number][] = [];
  let modelSpanMs = 0;
  for (const e of entries) {
    if (e.kind !== "model" || e.end_ms == null || e.end_ms < e.at_ms) continue;
    const dur = e.end_ms - e.at_ms;
    modelSpanMs += dur;
    modelSpans.push([e.at_ms, e.end_ms]);
    const modelKey = e.model ?? "未知模型";
    modelTotals.set(modelKey, (modelTotals.get(modelKey) ?? 0) + dur);
  }
  // Intra-turn step gaps: wall-clock between consecutive streaming spans
  // that no measurement covers. Unioned so overlapping steps (none in the
  // verified corpus) cannot double count.
  modelSpans.sort((a, b) => a[0] - b[0]);
  const delayIntervals: [number, number][] = [];
  for (let i = 1; i < modelSpans.length; i++)
    if (modelSpans[i][0] > modelSpans[i - 1][1])
      delayIntervals.push([modelSpans[i - 1][1], modelSpans[i][0]]);
  const unclassifiedDelayMs = unionMs(delayIntervals);

  // Reasoning bursts: a per-model drill-down under the model spans.
  const thinkingTotals = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== "thinking" || e.end_ms == null || e.end_ms < e.at_ms)
      continue;
    const modelKey = e.model ?? "未知模型";
    thinkingTotals.set(
      modelKey,
      (thinkingTotals.get(modelKey) ?? 0) + (e.end_ms - e.at_ms),
    );
  }
  // Per-call durations stay raw (matching the client-side slow-operation
  // pairing); the union above keeps the turn total free of parallel overlap.
  const toolsMap = new Map<string, { name: string; count: number; duration_ms: number }>();
  for (const e of entries) {
    if (e.kind !== "tool_result") continue;
    const dur = e.end_ms != null && e.end_ms >= e.at_ms ? e.end_ms - e.at_ms : 0;
    const tname = e.tool_name || "tool";
    const agg = toolsMap.get(tname) ?? { name: tname, count: 0, duration_ms: 0 };
    agg.count += 1;
    agg.duration_ms += dur;
    toolsMap.set(tname, agg);
  }
  const modelApiMs = Math.max(0, modelSpanMs - toolMs);
  return {
    work_ms: modelApiMs + toolMs,
    review_wait_ms: null,
    breakdown: {
      model_api_ms: modelApiMs,
      tool_execution_ms: toolMs,
      unclassified_delay_ms: unclassifiedDelayMs,
      tools: [...toolsMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
      model_api_breakdown: [...modelTotals.entries()]
        .map(([model, duration_ms]) => ({ model, duration_ms }))
        .sort((a, b) => a.model.localeCompare(b.model)),
      thinking_breakdown: [...thinkingTotals.entries()]
        .map(([level, duration_ms]) => ({ level, duration_ms }))
        .sort((a, b) => a.level.localeCompare(b.level)),
    },
  };
}

export class Store {
  readonly path: string;
  readonly db: DatabaseSync;
  // sessions() 重建是 O(全部事件)，而 /api/report 每次请求都会调用。缓存重建
  // 结果，任何可能改变其输出的写入（导入、失败标记、快照退役、宿主墓碑清理）
  // 都必须经 invalidateSessionCache() 失效，漏标会读到陈旧统计。
  private sessionCache: Session[] | null = null;
  constructor(filename: string) {
    this.path = path.resolve(expand(filename, os.homedir()));
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    this.db.exec(SCHEMA);
    try {
      this.db.prepare("ALTER TABLE source ADD COLUMN title TEXT").run();
    } catch {}
    const columns = this.db
      .prepare("PRAGMA table_info(source)")
      .all()
      .map((r) => (r as { name: string }).name);
    if (!columns.includes("agent"))
      this.db.exec(
        "ALTER TABLE source ADD COLUMN agent TEXT NOT NULL DEFAULT 'Codex'",
      );
    for (const col of ["last_error", "config_root"])
      if (!columns.includes(col))
        this.db.exec(`ALTER TABLE source ADD COLUMN ${col} TEXT`);
    // Legacy databases carry UNIQUE(path): one file = one snapshot. OpenCode
    // registers one source snapshot per (file, session) because a single
    // .db file holds many sessions, so the constraint is relaxed by a one-
    // time table rebuild, guarded on the old inline definition still being
    // present. The rebuild must run with foreign_keys OFF: DROP TABLE on the
    // parent would cascade-delete every event/token row.
    const sourceSql = (
      this.db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name='source'",
        )
        .get() as { sql: string } | undefined
    )?.sql;
    if (sourceSql?.includes("path TEXT NOT NULL UNIQUE")) {
      this.db.exec("PRAGMA foreign_keys=OFF");
      this.transaction(() => {
        this.db.exec(
          `CREATE TABLE source_migrated (
 id TEXT PRIMARY KEY, path TEXT NOT NULL, session_id TEXT NOT NULL,
 project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL, last_error TEXT, config_root TEXT, title TEXT, agent TEXT,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO source_migrated SELECT id,path,session_id,project,client,issues,last_error,config_root,title,agent,imported_at FROM source;
DROP TABLE source;
ALTER TABLE source_migrated RENAME TO source;`,
        );
      });
      this.db.exec("PRAGMA foreign_keys=ON");
    }
    // 增量同步签名列。放在 legacy 重建之后：重建会按显式列清单重建表，先前
    // ALTER 出的列会被丢掉，重建后再补齐才可靠。
    const sourceColumns = this.db
      .prepare("PRAGMA table_info(source)")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const [col, type] of [
      ["last_size", "INTEGER"],
      ["last_mtime_ns", "TEXT"],
    ] as const)
      if (!sourceColumns.includes(col))
        this.db.exec(`ALTER TABLE source ADD COLUMN ${col} ${type}`);
    // 启动即清空确定性失败 memo：每个进程生命周期内对失败文件至少完整探测
    // 一轮——适配器升级或上游格式修复后，同一份字节内容可能已能成功导入。
    this.db.exec("DELETE FROM import_failure");
    const eventCols = this.db
      .prepare("PRAGMA table_info(event)")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const [col, type] of [
      ["agent_id", "TEXT"],
      ["tool_id", "TEXT"],
      ["tool_name", "TEXT"],
      ["end_ms", "INTEGER"],
      ["thinking_level", "TEXT"],
    ] as const)
      if (!eventCols.includes(col))
        this.db.exec(`ALTER TABLE event ADD COLUMN ${col} ${type}`);
    try {
      chmodSync(this.path, 0o600);
    } catch {}
  }
  close() {
    this.db.close();
  }
  /** sessions() 的重建结果是缓存的：导入、失败标记、快照退役、宿主墓碑清理
   *  等任何会改变其输出的写入都必须调用本方法，漏标会读到陈旧统计。 */
  private invalidateSessionCache() {
    this.sessionCache = null;
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async importFile(
    filename: string,
    configRoot: string | null = null,
    adapter: AdapterName = "codex",
    indexCache: SessionIndexCache = new Map(),
    convIndexCache: ConversationIndexCache = new Map(),
  ): Promise<{
    events: number;
    issues: string[];
    external_import_only: boolean;
  }> {
    const p = realpathSync(expand(filename, os.homedir())),
      before = statSync(p, { bigint: true });
    if (p === this.path || !before.isFile() || !isSessionFile(adapter, p))
      throw new ValidationError(
        adapter === "codex"
          ? "请选择支持的 Agent .jsonl 或 .jsonl.zst 会话文件"
          : adapter === "dsh"
            ? "请选择 DSH .jsonl 或 .jsonl.zstd 会话文件"
            : adapter === "opencode"
              ? "请选择 OpenCode 会话数据库文件（如 opencode.db）"
              : "请选择支持的 Agent .jsonl 会话文件",
      );
    try {
      if (before.size > 512n * 1024n * 1024n)
        throw new ValidationError(
          "文件超过 512 MiB；请先选择较小的会话文件",
          { permanent: true },
        );
    // The file-change guard spans the awaited parse: stat before and after, so
    // a file rewritten mid-import is rejected instead of half-ingested.
    // OpenCode differs from every other adapter: one .db file carries many
    // sessions, so its parser returns one result per session and each is
    // registered as its own source snapshot keyed by file + session id.
    const codex = adapter === "codex" ? await parse(p) : null;
    const parsed: {
      session: {
        id: string;
        agent: string;
        project: string;
        client: string;
        title?: string | null;
      };
      events: Event[];
      tokens?: ({ turn_id: string } & TokenUsage)[];
      issues: string[];
    }[] = codex
      ? [codex]
      : adapter === "claude"
        ? [parseClaude(p)]
        : adapter === "antigravity"
          ? [parseAntigravity(p)]
          : adapter === "pi"
            ? [parsePi(p)]
            : adapter === "opencode"
              ? parseOpencode(p)
              : adapter === "omp"
                ? [parseOmp(p)]
                : [parseDsh(p)];
    const after = statSync(p, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new ValidationError("文件正在变化，本次保留旧记录；稍后重新同步");
    const multi = adapter === "opencode" && parsed.length > 1;
    this.transaction(() => {
      for (const data of parsed) {
        const sid = multi ? hash(p + "\u0000" + data.session.id) : hash(p),
          m = data.session;
        // Title/projects are single-channel enriched from each harness's global
        // registry (Codex: session_index.jsonl; Antigravity: conversation_summaries.db;
        // Claude/Pi: title inside the session file itself). Recomputed on every
        // import, so a dropped registry entry clears the stored value rather
        // than leaving a stale one.
        const conversation =
          adapter === "antigravity" && configRoot
            ? conversationIndex(configRoot, convIndexCache).get(m.id.replace(/^antigravity\//, ""))
            : undefined;
        const title =
          adapter === "codex" && configRoot
            ? (sessionIndex(configRoot, indexCache).get(m.id)?.name ?? "").slice(
                0,
                100,
              ) || null
            : adapter === "antigravity"
              ? (conversation?.title ?? null)
              : ((m as { title?: string | null }).title ?? null);
        const project =
          adapter === "antigravity" ? (conversation?.project ?? m.project) : m.project;
        // Codex diffs cumulative snapshots; DSH, Antigravity and OpenCode already
        // emit per-request usage summed per turn, so all arrive as ready token rows.
        const tokens = codex
          ? codex.tokens
          : "tokens" in data
            ? (data.tokens ?? [])
            : [];
        this.db
          .prepare(
            `INSERT INTO source(id,path,session_id,project,client,issues,config_root,agent,title) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,project=excluded.project,client=excluded.client,issues=excluded.issues,config_root=excluded.config_root,agent=excluded.agent,title=excluded.title,last_error=NULL,imported_at=CURRENT_TIMESTAMP`,
          )
          .run(
            sid,
            p,
            m.id,
            project,
            m.client,
            JSON.stringify(data.issues),
            configRoot,
            m.agent,
            title,
          );
        this.db.prepare("DELETE FROM event WHERE source_id=?").run(sid);
        this.db.prepare("DELETE FROM token_usage WHERE source_id=?").run(sid);
        const put = this.db.prepare(
          "INSERT INTO event(source_id,key,turn_id,kind,at_ms,model,agent_id,tool_id,tool_name,end_ms,thinking_level) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        );
        for (const e of data.events)
          put.run(
            sid,
            e.key,
            e.turn_id,
            e.kind,
            e.at_ms,
            e.model,
            e.agent_id ?? null,
            e.tool_id ?? null,
            e.tool_name ?? null,
            e.end_ms ?? null,
            e.thinking_level ?? null,
          );
        if (tokens.length) {
          const putTokens = this.db.prepare(
            "INSERT INTO token_usage(source_id,turn_id,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_output_tokens,total_tokens) VALUES(?,?,?,?,?,?,?,?)",
          );
          for (const t of tokens)
            putTokens.run(
              sid,
              t.turn_id,
              t.input_tokens,
              t.cached_input_tokens,
              t.cache_write_input_tokens,
              t.output_tokens,
              t.reasoning_output_tokens,
              t.total_tokens,
            );
        }
      }
      // 增量同步签名：记录本次成功导入时源文件的 size + mtimeNs，refresh
      // 据此跳过未变化文件。导入失败回滚时签名一并回滚，不会误标。
      this.db
        .prepare("UPDATE source SET last_size=?, last_mtime_ns=? WHERE path=?")
        .run(Number(after.size), after.mtimeNs.toString(), p);
      // 成功导入即解除确定性失败 memo：同一份内容下次按健康快照走签名跳过。
      this.db.prepare("DELETE FROM import_failure WHERE path=?").run(p);
    });
      this.invalidateSessionCache();
      return {
        events: parsed.reduce((acc, d) => acc + d.events.length, 0),
        issues: [...new Set(parsed.flatMap((d) => d.issues))],
        external_import_only: codex?.external_import_only ?? false,
      };
    } catch (e) {
      if (
        (e instanceof ValidationError && e.permanent) ||
        e instanceof ExcludedSessionError
      ) {
        // 确定性结论 memo（失败或按设计排除）：同一份字节内容重试必然得到
        // 同一结论，落签名让稳态同步跳过重解析；构造 Store 时会清空 memo，
        // 适配器升级后自动重新探测。排除类单独标记，UI 口径仍是 excluded。
        try {
          const st = statSync(p, { bigint: true });
          this.importFailureUpsertStmt().run(
            p,
            e instanceof ValidationError ? e.message : "导入被排除",
            adapter,
            Number(st.size),
            st.mtimeNs.toString(),
            e instanceof ExcludedSessionError ? 1 : 0,
          );
        } catch {
          // 文件已消失等极端情况：memo 落不上就落不上，下一轮如实重试
        }
      }
      throw e;
    }
  }
  /** 文件级增量跳过判定：该路径的全部快照健康（无 last_error）且 size+mtimeNs
   *  与上次成功导入时一致。mtimeNs 以字符串做精确相等比较；旧快照签名为 NULL
   *  → 不跳过（升级后首轮全量重导一次、落签名后进入稳态）；stat 失败（竞态
   *  删除等）也不跳过，交给 importFile 走完整的文件变化守卫与错误处理。 */
  private skipUnchanged(p: string, savedRows: SavedRow[]): boolean {
    if (
      savedRows.some(
        (row) =>
          row.last_error !== null ||
          row.last_size === null ||
          row.last_mtime_ns === null,
      )
    )
      return false;
    try {
      const st = statSync(p, { bigint: true });
      return savedRows.every(
        (row) =>
          Number(row.last_size) === Number(st.size) &&
          row.last_mtime_ns === st.mtimeNs.toString(),
      );
    } catch {
      return false;
    }
  }
  /** 跳过重解析的文件仍走一遍「单通道标题富化」（ADR-0002 §9 语义）：title/
   *  project 每次导入重算、注册表变化即落库或清除，只是不再重读会话文件本体。
   *  仅 Codex（session_index.jsonl）与 Antigravity（conversation_summaries.db）
   *  的富化来自外部注册表；其余适配器的标题在会话文件内部，文件未变即标题未变。
   *  比较全部在内存完成（saved 行自带 title/project），UPDATE 语句实例级复用，
   *  避免稳态同步对几百个跳过文件做逐行 prepare 的 N+1。 */
  private reenrichSkipped(
    configRoot: string | null,
    agent: AdapterName,
    savedRows: SavedRow[],
    indexCache: SessionIndexCache,
    convIndexCache: ConversationIndexCache,
  ) {
    for (const row of savedRows) {
      let title: string | null | undefined;
      let project: string | null | undefined;
      if (agent === "codex" && configRoot) {
        title =
          (sessionIndex(configRoot, indexCache).get(row.session_id)?.name ??
            "").slice(0, 100) || null;
      } else if (agent === "antigravity") {
        const conv = configRoot
          ? conversationIndex(configRoot, convIndexCache).get(
              row.session_id.replace(/^antigravity\//, ""),
            )
          : undefined;
        title = conv?.title ?? null;
        project = conv?.project ?? "未知项目";
      } else {
        continue;
      }
      const nextTitle = title ?? null,
        nextProject = project ?? row.project;
      if (row.title !== nextTitle || row.project !== nextProject) {
        this.enrichUpdateStmt().run(nextTitle, nextProject, row.id);
        this.invalidateSessionCache();
      }
    }
  }
  /** 富化 UPDATE 的实例级预编译：稳态同步会被反复调用，编译一次常驻复用。 */
  private enrichUpdateStmt() {
    if (!this.enrichUpdate)
      this.enrichUpdate = this.db.prepare(
        "UPDATE source SET title=?, project=? WHERE id=?",
      );
    return this.enrichUpdate;
  }
  private enrichUpdate:
    | ReturnType<DatabaseSync["prepare"]>
    | null = null;
  /** 确定性失败 memo 的实例级预编译 upsert。 */
  private importFailureUpsertStmt() {
    if (!this.importFailureUpsert)
      this.importFailureUpsert = this.db.prepare(
        "INSERT INTO import_failure(path,reason,agent,last_size,last_mtime_ns,excluded) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET reason=excluded.reason,agent=excluded.agent,last_size=excluded.last_size,last_mtime_ns=excluded.last_mtime_ns,excluded=excluded.excluded",
      );
    return this.importFailureUpsert;
  }
  private importFailureUpsert:
    | ReturnType<DatabaseSync["prepare"]>
    | null = null;
  async refresh(directories = new Directories(this)) {
    const { files, agents, notices } = directories.collect(),
      configured = new Set(
        directories
          .list()
          .filter((i) => i.enabled && i.supported && i.resolved_path)
          .map((i) => i.resolved_path),
      );
    // Desktop hosts (e.g. Claude Desktop) delete session files they release and
    // leave a sibling <stem>.desktop-released.json tombstone. Such files fail
    // every future sync ("file moved away") forever unless retired here.
    const hostReleased = (p: string): boolean => {
      try {
        const stem = p.replace(/\.jsonl(\.zst)?$/, "");
        const row = JSON.parse(
          readFileSync(stem + ".desktop-released.json", "utf8"),
        );
        return (
          !!row &&
          typeof row === "object" &&
          (row as Record<string, unknown>).reason === "delete"
        );
      } catch {
        return false;
      }
    };
    const saved = this.db
      .prepare(
        "SELECT id,path,session_id,config_root,agent,last_error,last_size,last_mtime_ns,title,project FROM source",
      )
      .all() as unknown as SavedRow[];
    // 按路径聚合：OpenCode 一个 .db 挂多个会话快照，同路径会有多行；跳过判定
    // 与 agent 回落都必须看「该路径的全部行」，同时取代逐文件线性 find。
    const savedByPath = new Map<string, SavedRow[]>();
    for (const s of saved) {
      const list = savedByPath.get(s.path);
      if (list) list.push(s);
      else savedByPath.set(s.path, [s]);
    }
    // 确定性失败 memo：从无成功快照的文件（体积超限、来源不明、按设计排除等）
    // 按签名跳过重解析；agent 列防止目录重分类后误用旧适配器的失败结论。
    const failureMemo = new Map(
      (
        this.db
          .prepare(
            "SELECT path,reason,agent,last_size,last_mtime_ns,excluded FROM import_failure",
          )
          .all() as unknown as {
          path: string;
          reason: string;
          agent: string;
          last_size: number | null;
          last_mtime_ns: string | null;
          excluded: number;
        }[]
      ).map((m) => [m.path, m]),
    );
    const paths = new Map(
      saved
        .filter((s) => s.config_root === null || configured.has(s.config_root))
        .map((s) => [s.path, s.config_root]),
    );
    const missing = new Set(
      [...paths]
        .filter(([p, r]) => r !== null && !files.has(p))
        .map(([p]) => p),
    );
    for (const [p, r] of files) paths.set(p, r);
    const failures = new Map<string, string>();
    // By-design exclusions (e.g. Codex fork copies of already-imported
    // sessions) are not failures: they never generate statistics and must
    // not read as errors in the UI or set last_error on any snapshot.
    const exclusions = new Map<string, string>();
    // One shared index cache for the whole refresh: every config root's
    // session_index.jsonl is read and parsed at most once below.
    const indexCache: SessionIndexCache = new Map();
    const convIndexCache: ConversationIndexCache = new Map();
    let ok = 0,
      failed = 0,
      excluded = 0,
      retired = 0,
      hostDeleted = 0,
      skipped = 0;
    for (const [p, r] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        if (missing.has(p)) {
          if (hostReleased(p)) {
            // Released by the host on purpose: retire the snapshot (events
            // cascade via FK) and surface a notice — never a failure.
            this.db.prepare("DELETE FROM source WHERE path=?").run(p);
            hostDeleted++;
            this.invalidateSessionCache();
            continue;
          }
          throw new ValidationError(
            "原会话文件已移动或不再位于启用目录；旧快照保留",
          );
        }
        const savedRows = savedByPath.get(p);
        const savedAgent = savedRows?.[0]?.agent;
        const agent = agents.get(p) ?? savedAgentAdapter(savedAgent);
        // 确定性失败 memo 命中：该文件从未成功导入、失败原因纯由内容决定、
        // 适配器未变且签名一致 → 重解析必然得到同一失败。仍计入 failed 与
        // 失败清单（UI 口径不变），只是不再白付解析成本。
        const memo = failureMemo.get(p);
        if (
          !savedRows?.length &&
          memo &&
          memo.agent === agent &&
          memo.last_size !== null &&
          memo.last_mtime_ns !== null
        ) {
          try {
            const st = statSync(p, { bigint: true });
            if (
              Number(memo.last_size) === Number(st.size) &&
              memo.last_mtime_ns === st.mtimeNs.toString()
            ) {
              if (memo.excluded) {
                excluded++;
                exclusions.set(p, memo.reason);
              } else {
                failed++;
                failures.set(p, memo.reason);
              }
              skipped++;
              continue;
            }
          } catch {
            // stat 失败（竞态删除等）：不跳过，走 importFile 给出准确错误
          }
        }
        // 增量跳过：全部快照健康且文件签名（size+mtimeNs）与上次成功导入一致
        // 时，不再重新解析——只保留单通道标题富化。签名缺失（旧快照/升级首轮）
        // 或快照带 last_error 时绝不跳过，保证失败文件每轮都被重试。
        if (
          savedRows &&
          savedRows.length > 0 &&
          savedAgentAdapter(savedRows[0].agent) === agent &&
          this.skipUnchanged(p, savedRows)
        ) {
          this.reenrichSkipped(
            r,
            agent,
            savedRows,
            indexCache,
            convIndexCache,
          );
          ok++;
          skipped++;
          continue;
        }
        await this.importFile(
          p,
          r,
          agent,
          indexCache,
          convIndexCache,
        );
        ok++;
      } catch (error) {
        if (error instanceof ExcludedSessionError) {
          excluded++;
          exclusions.set(p, error.message);
          continue;
        }
        failed++;
        const code = (error as NodeJS.ErrnoException).code;
        failures.set(
          p,
          error instanceof ValidationError
            ? error.message
            : code === "EACCES" || code === "EPERM"
              ? "无权读取会话文件，请检查文件权限"
              : code === "ENOENT"
                ? "会话文件不存在或同步期间被移动"
                : code?.startsWith("ERR_SQLITE")
                  ? "写入本地统计数据库失败，请检查权限和磁盘空间"
                  : "无法读取或导入文件；请通过命令行导入检查此版本兼容性",
        );
        this.db
          .prepare("UPDATE source SET last_error=? WHERE path=?")
          .run("最近同步失败；显示上次成功导入的快照", p);
        this.invalidateSessionCache();
      }
    }
    if (hostDeleted > 0) {
      notices.push(
        `${hostDeleted} 个会话已被宿主删除（desktop-released 墓碑），已同步清理其统计`,
      );
    }
    this.transaction(() => {
      for (const p of missing) {
        const old = this.db
          .prepare("SELECT id,session_id,config_root FROM source WHERE path=?")
          .get(p) as unknown as Source | undefined;
        if (!old) continue;
        const other = this.db
          .prepare(
            "SELECT 1 FROM source WHERE id<>? AND session_id=? AND config_root=? AND last_error IS NULL LIMIT 1",
          )
          .get(old.id, old.session_id, old.config_root);
        const uncovered = this.db
          .prepare(
            `SELECT 1 FROM event e WHERE e.source_id=? AND NOT EXISTS (SELECT 1 FROM event alt JOIN source s ON s.id=alt.source_id WHERE s.id<>? AND s.session_id=? AND s.config_root=? AND s.last_error IS NULL AND alt.key=e.key) LIMIT 1`,
          )
          .get(old.id, old.id, old.session_id, old.config_root);
        if (other && !uncovered) {
          this.db.prepare("DELETE FROM source WHERE id=?").run(old.id);
          retired++;
          failures.delete(p);
        }
      }
    });
    this.invalidateSessionCache();
    return {
      updated: ok,
      failed: failed - retired,
      excluded,
      skipped,
      discovered: files.size,
      failures: [...new Set(failures.values())].map((reason) => {
        const group = [...failures.entries()].filter(
          ([, value]) => value === reason,
        );
        // Basenames (≤3, "等 N 个" in the UI) so the failure toast can name
        // the offending files instead of a faceless count.
        return {
          reason,
          count: group.length,
          files: group
            .map(([p]) => path.basename(p))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 3),
        };
      }),
      exclusions: [...new Set(exclusions.values())].map((reason) => ({
        reason,
        count: [...exclusions.values()].filter((value) => value === reason)
          .length,
      })),
      relocated: retired,
      notices,
      note: "配置目录会发现新会话；关闭接入或更换目录不会删除既有统计",
    };
  }
  sessions(): Session[] {
    // 命中缓存直接返回。契约：返回值为共享只读视图（顶层已冻结），调用方不得
    // 增删会话或就地改写统计字段——需要变形时先浅拷贝（report() 即此做法）。
    if (this.sessionCache) return this.sessionCache;
    const { sources, events, tokenRows } = this.transaction(() => ({
      sources: this.db
        .prepare("SELECT * FROM source ORDER BY id")
        .all() as unknown as Source[],
      events: this.db
        .prepare(
          "SELECT DISTINCT s.session_id,e.key,e.turn_id,e.kind,e.at_ms,e.model,e.agent_id,e.tool_id,e.tool_name,e.end_ms,e.thinking_level FROM event e JOIN source s ON s.id=e.source_id ORDER BY e.at_ms,e.key",
        )
        .all() as unknown as (Event & { session_id: string })[],
      tokenRows: this.db
        .prepare(
          "SELECT s.session_id,t.turn_id,t.input_tokens,t.cached_input_tokens,t.cache_write_input_tokens,t.output_tokens,t.reasoning_output_tokens,t.total_tokens FROM token_usage t JOIN source s ON s.id=t.source_id ORDER BY t.total_tokens",
        )
        .all() as unknown as (TokenUsage & { session_id: string; turn_id: string })[],
    }));
    // Session ids and turn ids cannot contain NUL, so this pair key is
    // collision-free and cheaper than JSON.stringify.
    const pairKey = (a: string, b: string) => a + "\u0000" + b;
    // The same session may be registered from two paths (e.g. .jsonl and
    // .jsonl.zst); keep the widest snapshot per session/turn.
    const turnTokens = new Map<string, TokenUsage>();
    // Per-session view of the same rows: turn ids that never become event
    // groups (external-import-only turns) still carry retained token rows,
    // and their deltas must reach the session rollup.
    const tokensBySession = new Map<string, Map<string, TokenUsage>>();
    for (const r of tokenRows) {
      const key = pairKey(r.session_id, r.turn_id);
      const prev = turnTokens.get(key);
      if (!prev || r.total_tokens > prev.total_tokens) {
        turnTokens.set(key, mapUsage(r, (v) => v));
        let byTurn = tokensBySession.get(r.session_id);
        if (!byTurn) tokensBySession.set(r.session_id, (byTurn = new Map()));
        byTurn.set(r.turn_id, mapUsage(r, (v) => v));
      }
    }
    const sessions = new Map<string, Session>();
    for (const s of sources) {
      const item = sessions.get(s.session_id) ?? {
        id: s.session_id,
        agent: s.agent,
        project: s.project,
        title: null,
        issues: [],
        turns: [],
        imported_at: s.imported_at,
      };
      item.issues = [
        ...new Set([
          ...item.issues,
          ...JSON.parse(s.issues),
          ...(s.last_error ? [s.last_error] : []),
        ]),
      ].sort();
      if (s.imported_at > item.imported_at) item.imported_at = s.imported_at;
      if (s.title && !item.title) item.title = s.title;
      sessions.set(s.session_id, item);
    }
    const seen = new Set<string>(),
      grouped = new Map<
        string,
        { sid: string; tid: string; entries: Event[] }
      >();
    for (const e of events) {
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      const key = pairKey(e.session_id, e.turn_id),
        g = grouped.get(key) ?? {
          sid: e.session_id,
          tid: e.turn_id,
          entries: [],
        };
      g.entries.push(e);
      grouped.set(key, g);
    }
    for (const { sid, tid, entries } of grouped.values()) {
      let starts = [
        ...new Set(
          entries.filter((e) => e.kind === "start" && !e.agent_id).map((e) => e.at_ms),
        ),
      ].sort((a, b) => a - b);
      if (starts.length === 0) {
        starts = [
          ...new Set(
            entries.filter((e) => e.kind === "start").map((e) => e.at_ms),
          ),
        ].sort((a, b) => a - b);
      }

      let endings = [
        ...new Map(
          entries
            .filter((e) => ["complete", "abort", "fail"].includes(e.kind) && !e.agent_id)
            .map((e) => [`${e.at_ms}:${e.kind}`, e]),
        ).values(),
      ];
      if (endings.length === 0) {
        endings = [
          ...new Map(
            entries
              .filter((e) => ["complete", "abort", "fail"].includes(e.kind))
              .map((e) => [`${e.at_ms}:${e.kind}`, e]),
          ).values(),
        ];
      }

      const start = starts.length === 1 ? starts[0] : null,
        end = endings.length === 1 ? endings[0].at_ms : null,
        endKind = endings.length === 1 ? endings[0].kind : null;
      let status: Status =
        endKind === "complete"
          ? "completed"
          : endKind === "abort"
            ? "aborted"
            : endKind === "fail"
              ? "failed"
              : "open",
        reason: string | null = null;
      if (starts.length > 1 || endings.length > 1) {
        status = "invalid";
        reason = "同一轮存在冲突的起止事件，未计入耗时";
      } else if (start === null) {
        status = "incomplete";
        reason = "缺少执行开始事件";
      } else if (end !== null && end < start) {
        status = "invalid";
        reason = "结束时间早于开始时间，未计入耗时";
      } else if (end === null)
        reason = "尚无结束事件；可能进行中，也可能记录中断，不推测当前状态";

      const elapsed =
        ["completed", "aborted", "failed"].includes(status) &&
        start !== null &&
        end !== null
          ? end - start
          : null;

      const sessionObj = sessions.get(sid)!;
      let work_ms: number | null = null;
      let review_wait_ms: number | null = null;
      let breakdown: Turn["breakdown"] = null;
      const applyTiming = (
        timing:
          | ReturnType<typeof calculateEventTiming>
          | ReturnType<typeof calculatePiTiming>,
      ) => {
        work_ms = timing.work_ms;
        review_wait_ms = timing.review_wait_ms;
        breakdown = timing.breakdown;
      };

      if (
        elapsed !== null &&
        start !== null &&
        end !== null &&
        (sessionObj.agent === "Claude Code" ||
          sessionObj.agent === "Codex" ||
          sessionObj.agent === "Antigravity")
      ) {
        applyTiming(calculateEventTiming(entries, start, end, elapsed));
      } else if (
        elapsed !== null &&
        start !== null &&
        end !== null &&
        (sessionObj.agent === "Pi" ||
          sessionObj.agent === "DeepSeek Harness" ||
          sessionObj.agent === "Oh-My-Pi")
      ) {
        applyTiming(calculatePiTiming(entries, start, end, elapsed));
      } else if (
        elapsed !== null &&
        start !== null &&
        end !== null &&
        sessionObj.agent === "OpenCode"
      ) {
        applyTiming(calculateOpencodeTiming(entries));
      }

      const turnSubagents = groupSubagents(entries);

      sessionObj.turns.push({
        id: tid,
        start_ms: start,
        end_ms: end,
        elapsed_ms: elapsed,
        status,
        reason,
        models: [
          ...new Set(
            entries.map((e) => e.model).filter((m): m is string => !!m),
          ),
        ].sort(),
        events: entries,
        work_ms,
        review_wait_ms,
        standby_ms: null,
        human_ms: review_wait_ms,
        response_gap_ms: null,
        subagents: turnSubagents.length ? turnSubagents : undefined,
        breakdown,
        tokens: turnTokens.get(pairKey(sid, tid)) ?? null,
      });
    }
    for (const s of sessions.values()) {
      s.turns.sort(
        (a, b) =>
          (a.start_ms ?? a.end_ms ?? 0) - (b.start_ms ?? b.end_ms ?? 0) ||
          a.id.localeCompare(b.id),
      );
      for (let i = 1; i < s.turns.length; i++) {
        const prevEnd = s.turns[i - 1].end_ms;
        const currStart = s.turns[i].start_ms;
        if (prevEnd !== null && currStart !== null && currStart >= prevEnd) {
          s.turns[i].standby_ms = currStart - prevEnd;
          s.turns[i].response_gap_ms = s.turns[i].standby_ms;
        }
      }
      s.work_ms = s.turns.some((t) => t.work_ms !== null)
        ? s.turns.reduce((acc, t) => acc + (t.work_ms ?? 0), 0)
        : null;
      s.review_wait_ms = s.turns.some((t) => t.review_wait_ms !== null)
        ? s.turns.reduce((acc, t) => acc + (t.review_wait_ms ?? 0), 0)
        : null;
      s.standby_ms = s.turns.some((t) => t.standby_ms !== null)
        ? s.turns.reduce((acc, t) => acc + (t.standby_ms ?? 0), 0)
        : null;

      const tokened = s.turns.filter((t) => t.tokens);
      // Token rows for turns without event groups (external-import-only)
      // have no Turn object; roll them into the session total so retained
      // history is not silently dropped from the advertised totals.
      const usedTurnIds = new Set(s.turns.map((t) => t.id));
      const orphanUsages: TokenUsage[] = [];
      for (const [tid, usage] of tokensBySession.get(s.id) ?? []) {
        if (!usedTurnIds.has(tid)) orphanUsages.push(usage);
      }
      const tokenSums = [
        ...tokened.map((t) => t.tokens!),
        ...orphanUsages,
      ];
      s.tokens = tokenSums.length
        ? tokenSums.reduce((acc, u) => addUsage(acc, u), zeroUsage())
        : null;

      const sessionSubagents = groupSubagents(
        s.turns.flatMap((t) => t.events),
        s.turns,
      );
      if (sessionSubagents.length > 0) {
        s.subagents = sessionSubagents;
      }
    }
    // 运行时冻结顶层增删；类型系统仍按 Session[] 暴露（调用方浅拷贝后变形，
    // 如 report()），只读契约由注释与本冻结共同约束。
    this.sessionCache = Object.freeze([...sessions.values()]) as unknown as Session[];
    return this.sessionCache;
  }
  /** On-demand per-turn transcript for the session detail drawer: re-reads the
   *  registered source file and extracts prompt/thinking text. Nothing is
   *  persisted. Returns null when the session is unknown; degrades to
   *  turns:[] with an honest missing_fields reason when the file is gone or
   *  unreadable. */
  transcript(sessionId: string): SessionTranscript | null {
    const rows = this.db
      .prepare(
        "SELECT path, agent FROM source WHERE session_id=? ORDER BY imported_at DESC LIMIT 1",
      )
      .all(sessionId) as unknown as { path: string; agent: string }[];
    if (!rows.length) return null;
    const { path: p, agent } = rows[0];
    try {
      // OpenCode's source file is one database holding many sessions; the
      // extractor filters to the requested one. Other agents are 1:1.
      const turns =
        agent === "OpenCode"
          ? extractOpencodeTranscript(p, sessionId)
          : (TRANSCRIPT_EXTRACTORS[agent] ?? extractCodexTranscript)(p);
      const missing: string[] = [];
      const overLimit = (s: string | null) =>
        s !== null && Array.from(s).length >= TRANSCRIPT_TEXT_LIMIT;
      if (turns.some((t) => overLimit(t.prompt)))
        missing.push("部分轮次的提问文本超长，已截断至 8000 字符");
      if (turns.some((t) => overLimit(t.thinking)))
        missing.push("部分轮次的思考文本超长，已截断至 8000 字符");
      if (agent === "Codex")
        missing.push(
          "Codex 官方记录对模型思考链加密（ZDR），本机无法解密展示",
        );
      return { session_id: sessionId, turns, missing_fields: missing };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        session_id: sessionId,
        turns: [],
        missing_fields: [
          code === "ENOENT"
            ? "原始会话文件不存在或已被移动；无法按需读取轮次提问与思考文本（耗时统计不受影响）"
            : "原始会话文件暂时无法读取；无法按需提取轮次提问与思考文本（耗时统计不受影响）",
        ],
      };
    }
  }
  sourceInfo() {
    const sources = this.db
      .prepare("SELECT * FROM source ORDER BY imported_at DESC")
      .all() as unknown as Source[];
    return {
      registered_files: sources.length,
      last_imported_at_utc: sources[0]?.imported_at ?? null,
      failed_sources: sources.filter((s) => s.last_error).length,
      imports: sources.map((s) => ({
        session_id: s.session_id,
        project: s.project,
        imported_at_utc: s.imported_at,
        issues: [
          ...JSON.parse(s.issues),
          ...(s.last_error ? [s.last_error] : []),
        ],
      })),
      privacy:
        "仅本机存储统计元数据，不保存工具参数或凭据；会话详情页在打开抽屉时按需从本机源文件读取该轮的提问与模型思考文本用于本地展示，仍仅限本机、不上传。",
    };
  }
}
