import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, hash, truncateCodePoints, TRANSCRIPT_TEXT_LIMIT } from "./codex.js";
import { parseClaude, extractClaudeTranscript } from "./claude.js";
import { parsePi, extractPiTranscript } from "./pi.js";
import { extractCodexTranscript } from "./codex.js";
import { SCHEMA } from "./schema.js";
import { Directories } from "./directories.js";
import { expand } from "./locations.js";
import { unionMs } from "./metrics.js";
import {
  ValidationError,
  type AdapterName,
  type Event,
  type Session,
  type SessionTranscript,
  type Status,
  type SubagentSummary,
  type Turn,
  type TurnBreakdown,
} from "./types.js";

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

export function calculateClaudeTiming(
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

export class Store {
  readonly path: string;
  readonly db: DatabaseSync;
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
  importFile(
    filename: string,
    configRoot: string | null = null,
    adapter: AdapterName = "codex",
  ) {
    const p = realpathSync(expand(filename, os.homedir())),
      before = statSync(p, { bigint: true });
    if (p === this.path || !before.isFile() || path.extname(p) !== ".jsonl")
      throw new ValidationError("请选择支持的 Agent .jsonl 会话文件");
    if (before.size > 512n * 1024n * 1024n)
      throw new ValidationError("文件超过 512 MiB；请先选择较小的会话文件");
    const data =
        adapter === "claude"
          ? parseClaude(p)
          : adapter === "pi"
            ? parsePi(p)
            : parse(p),
      after = statSync(p, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new ValidationError("文件正在变化，本次保留旧记录；稍后重新同步");
    const sid = hash(p),
      m = data.session;
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source(id,path,session_id,project,client,issues,config_root,agent,title) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,project=excluded.project,client=excluded.client,issues=excluded.issues,config_root=excluded.config_root,agent=excluded.agent,title=excluded.title,last_error=NULL,imported_at=CURRENT_TIMESTAMP`,
        )
        .run(
          sid,
          p,
          m.id,
          m.project,
          m.client,
          JSON.stringify(data.issues),
          configRoot,
          m.agent,
          (m as any).title ?? null,
        );
      this.db.prepare("DELETE FROM event WHERE source_id=?").run(sid);
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
    });
    return { events: data.events.length, issues: data.issues };
  }
  refresh(directories = new Directories(this)) {
    const { files, agents, notices } = directories.collect(),
      configured = new Set(
        directories
          .list()
          .filter((i) => i.enabled && i.supported && i.resolved_path)
          .map((i) => i.resolved_path),
      );
    const saved = this.db
      .prepare("SELECT path,config_root,agent FROM source")
      .all() as unknown as Pick<Source, "path" | "config_root" | "agent">[];
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
    let ok = 0,
      failed = 0,
      retired = 0;
    for (const [p, r] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        if (missing.has(p))
          throw new ValidationError(
            "原会话文件已移动或不再位于启用目录；旧快照保留",
          );
        const savedAgent = saved.find((s) => s.path === p)?.agent;
        this.importFile(
          p,
          r,
          agents.get(p) ??
            (savedAgent === "Claude Code"
              ? "claude"
              : savedAgent === "Pi"
                ? "pi"
                : "codex"),
        );
        ok++;
      } catch (error) {
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
      }
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
    return {
      updated: ok,
      failed: failed - retired,
      discovered: files.size,
      failures: [...new Set(failures.values())].map((reason) => ({
        reason,
        count: [...failures.values()].filter((value) => value === reason)
          .length,
      })),
      relocated: retired,
      notices,
      note: "配置目录会发现新会话；关闭接入或更换目录不会删除既有统计",
    };
  }
  sessions(): Session[] {
    const { sources, events } = this.transaction(() => ({
      sources: this.db
        .prepare("SELECT * FROM source ORDER BY id")
        .all() as unknown as Source[],
      events: this.db
        .prepare(
          "SELECT DISTINCT s.session_id,e.key,e.turn_id,e.kind,e.at_ms,e.model,e.agent_id,e.tool_id,e.tool_name,e.end_ms,e.thinking_level FROM event e JOIN source s ON s.id=e.source_id ORDER BY e.at_ms,e.key",
        )
        .all() as unknown as (Event & { session_id: string })[],
    }));
    const sessions = new Map<string, Session>();
    for (const s of sources) {
      const item = sessions.get(s.session_id) ?? {
        id: s.session_id,
        agent: s.agent,
        project: s.project,
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
      const key = JSON.stringify([e.session_id, e.turn_id]),
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
          | ReturnType<typeof calculateClaudeTiming>
          | ReturnType<typeof calculatePiTiming>,
      ) => {
        work_ms = timing.work_ms;
        review_wait_ms = timing.review_wait_ms;
        breakdown = timing.breakdown;
      };

      if (elapsed !== null && start !== null && end !== null && sessionObj.agent === "Claude Code") {
        applyTiming(calculateClaudeTiming(entries, start, end, elapsed));
      } else if (
        elapsed !== null &&
        start !== null &&
        end !== null &&
        sessionObj.agent === "Pi"
      ) {
        applyTiming(calculatePiTiming(entries, start, end, elapsed));
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

      const sessionSubagents = groupSubagents(
        s.turns.flatMap((t) => t.events),
        s.turns,
      );
      if (sessionSubagents.length > 0) {
        s.subagents = sessionSubagents;
      }
    }
    return [...sessions.values()];
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
      const turns =
        agent === "Claude Code"
          ? extractClaudeTranscript(p)
          : agent === "Pi"
            ? extractPiTranscript(p)
            : extractCodexTranscript(p);
      const missing: string[] = [];
      const overLimit = (s: string | null) =>
        s !== null && Array.from(s).length >= TRANSCRIPT_TEXT_LIMIT;
      if (turns.some((t) => overLimit(t.prompt)))
        missing.push("部分轮次的提问文本超长，已截断至 8000 字符");
      if (turns.some((t) => overLimit(t.thinking)))
        missing.push("部分轮次的思考文本超长，已截断至 8000 字符");
      if (agent === "Codex")
        missing.push("Codex 来源未记录模型思考文本，思考与推理无法展示");
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
