import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse, hash, readSessionIndex, type IndexedThread } from "./codex.js";
import { parseClaude } from "./claude.js";
import { SCHEMA } from "./schema.js";
import { Directories, isSessionFile } from "./directories.js";
import { expand } from "./locations.js";
import { unionMs } from "./metrics.js";
import {
  addUsage,
  mapUsage,
  ValidationError,
  zeroUsage,
  type Event,
  type Session,
  type Status,
  type SubagentSummary,
  type TokenUsage,
  type Turn,
  type TurnBreakdown,
} from "./types.js";

// session_index.jsonl is read once per config root per refresh/import call:
// repeated imports under the same root (799 files locally) reuse one parsed
// Map instead of re-reading the index for every file.
type SessionIndexCache = Map<string, Map<string, IndexedThread>>;
function sessionIndex(
  configRoot: string,
  cache: SessionIndexCache,
): Map<string, IndexedThread> {
  const key = path.resolve(configRoot);
  let index = cache.get(key);
  if (!index) cache.set(key, (index = readSessionIndex(key)));
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
  topic: string | null;
  imported_at: string;
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

export class Store {
  readonly path: string;
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.path = path.resolve(expand(filename, os.homedir()));
    mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
    this.db.exec(SCHEMA);
    const columns = this.db
      .prepare("PRAGMA table_info(source)")
      .all()
      .map((r) => (r as { name: string }).name);
    if (!columns.includes("agent"))
      this.db.exec(
        "ALTER TABLE source ADD COLUMN agent TEXT NOT NULL DEFAULT 'Codex'",
      );
    for (const col of ["last_error", "config_root", "topic"])
      if (!columns.includes(col))
        this.db.exec(`ALTER TABLE source ADD COLUMN ${col} TEXT`);
    const eventCols = this.db
      .prepare("PRAGMA table_info(event)")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const col of ["agent_id", "tool_id", "tool_name"])
      if (!eventCols.includes(col))
        this.db.exec(`ALTER TABLE event ADD COLUMN ${col} TEXT`);
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
  async importFile(
    filename: string,
    configRoot: string | null = null,
    adapter: "codex" | "claude" = "codex",
    indexCache: SessionIndexCache = new Map(),
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
          : "请选择支持的 Agent .jsonl 会话文件",
      );
    if (before.size > 512n * 1024n * 1024n)
      throw new ValidationError("文件超过 512 MiB；请先选择较小的会话文件");
    // The file-change guard spans the awaited parse: stat before and after, so
    // a file rewritten mid-import is rejected instead of half-ingested.
    const codex = adapter === "codex" ? await parse(p) : null,
      data = codex ?? parseClaude(p),
      after = statSync(p, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new ValidationError("文件正在变化，本次保留旧记录；稍后重新同步");
    const sid = hash(p),
      m = data.session;
    // session_index.jsonl lives under the config root the file was discovered
    // in (CODEX_HOME-aware); CLI imports without a config root stay untitled.
    // The topic is recomputed on every import, so an entry dropped from the
    // index clears the stored topic rather than leaving a stale one.
    const topic =
      adapter === "codex" && configRoot
        ? (sessionIndex(configRoot, indexCache).get(m.id)?.name ?? "").slice(
            0,
            100,
          ) || null
        : null;
    const tokens = codex ? codex.tokens : [];
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO source(id,path,session_id,project,client,issues,config_root,topic,agent) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,project=excluded.project,client=excluded.client,issues=excluded.issues,config_root=excluded.config_root,topic=excluded.topic,agent=excluded.agent,last_error=NULL,imported_at=CURRENT_TIMESTAMP`,
        )
        .run(
          sid,
          p,
          m.id,
          m.project,
          m.client,
          JSON.stringify(data.issues),
          configRoot,
          topic,
          m.agent,
        );
      this.db.prepare("DELETE FROM event WHERE source_id=?").run(sid);
      this.db.prepare("DELETE FROM token_usage WHERE source_id=?").run(sid);
      const put = this.db.prepare(
        "INSERT INTO event(source_id,key,turn_id,kind,at_ms,model,agent_id,tool_id,tool_name) VALUES(?,?,?,?,?,?,?,?,?)",
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
    });
    return {
      events: data.events.length,
      issues: data.issues,
      external_import_only: codex?.external_import_only ?? false,
    };
  }
  async refresh(directories = new Directories(this)) {
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
    // One shared index cache for the whole refresh: every config root's
    // session_index.jsonl is read and parsed at most once below.
    const indexCache: SessionIndexCache = new Map();
    let ok = 0,
      failed = 0,
      retired = 0;
    for (const [p, r] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        if (missing.has(p))
          throw new ValidationError(
            "原会话文件已移动或不再位于启用目录；旧快照保留",
          );
        await this.importFile(
          p,
          r,
          agents.get(p) ??
            (saved.find((s) => s.path === p)?.agent === "Claude Code"
              ? "claude"
              : "codex"),
          indexCache,
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
    const { sources, events, tokenRows } = this.transaction(() => ({
      sources: this.db
        .prepare("SELECT * FROM source ORDER BY id")
        .all() as unknown as Source[],
      events: this.db
        .prepare(
          "SELECT DISTINCT s.session_id,e.key,e.turn_id,e.kind,e.at_ms,e.model,e.agent_id,e.tool_id,e.tool_name FROM event e JOIN source s ON s.id=e.source_id ORDER BY e.at_ms,e.key",
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
    for (const r of tokenRows) {
      const key = pairKey(r.session_id, r.turn_id);
      const prev = turnTokens.get(key);
      if (!prev || r.total_tokens > prev.total_tokens)
        turnTokens.set(key, mapUsage(r, (v) => v));
    }
    const sessions = new Map<string, Session>();
    for (const s of sources) {
      const item = sessions.get(s.session_id) ?? {
        id: s.session_id,
        agent: s.agent,
        project: s.project,
        topic: null,
        issues: [],
        turns: [],
        imported_at: s.imported_at,
      };
      if (s.topic && !item.topic) item.topic = s.topic;
      item.issues = [
        ...new Set([
          ...item.issues,
          ...JSON.parse(s.issues),
          ...(s.last_error ? [s.last_error] : []),
        ]),
      ].sort();
      if (s.imported_at > item.imported_at) item.imported_at = s.imported_at;
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

      if (
        elapsed !== null &&
        start !== null &&
        end !== null &&
        (sessionObj.agent === "Claude Code" || sessionObj.agent === "Codex")
      ) {
        const timing = calculateEventTiming(entries, start, end, elapsed);
        work_ms = timing.work_ms;
        review_wait_ms = timing.review_wait_ms;
        breakdown = timing.breakdown;
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
      s.tokens = tokened.length
        ? tokened.reduce((acc, t) => addUsage(acc, t.tokens!), zeroUsage())
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
      privacy: "仅本机存储统计元数据，不保存问题、答复、工具参数或凭据。",
    };
  }
}
