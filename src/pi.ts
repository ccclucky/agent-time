/** Parse Pi agent session JSONL into the shared Event stream.
 * Basis: badlogic/pi-mono pinned 16f5f0af4d85ca583d045ceb5ed6d646fcaf7761
 * (coding-agent 1.4.0) session-manager encoding and SessionEntry types.
 * Only timing metadata is read; message content is never persisted.
 *
 * v2/v3 sessions are entry trees keyed by id/parentId: when the user resumes
 * from an earlier entry, the previously active branch is abandoned. Only the
 * root-to-last-entry path is imported; abandoned branches are skipped with an
 * issue note so they never inflate turn counts or timing. Files carrying a
 * parentSession header are fork copies that duplicate the parent's entries
 * and are rejected outright.
 */
import { posix } from "node:path";
import { lines, timestamp, hash, legacyJSON, ID } from "./codex.js";
import { ValidationError, type Event } from "./types.js";

const validId = (v: unknown): v is string =>
  typeof v === "string" && ID.test(v);

// Unicode-safe truncation by code points, never splitting a surrogate pair.
const truncate = (s: string, n: number) => Array.from(s).slice(0, n).join("");

// message.timestamp is epoch ms (request start / result creation per role).
const epochMs = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 4102444800000)
    throw Error();
  return v;
};
// message.durationMs is an optional monotonic-clock duration; absent or
// malformed means "fall back", never abort.
const durationMs = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

// Record-level ISO timestamps are record append times; invalid ones mark the
// single line bad (issue) instead of aborting the import, so wrap as plain Error.
const iso = (v: unknown): number => {
  try {
    return timestamp(v);
  } catch {
    throw Error();
  }
};

// Slim per-record projection: only the fields events are built from.
interface PiRecord {
  type: string;
  id: string;
  parentId: string | null;
  at: number; // record append time (ISO timestamp)
  role?: "user" | "assistant" | "toolResult";
  reqStart?: number; // assistant: message.timestamp (request start)
  dur?: number | null; // assistant / toolResult: durationMs
  model?: string | null;
  thinkingLevel?: string | null;
  stopReason?: string;
  toolCalls?: { id: string; name: string }[];
  toolCallId?: string | null;
  toolName?: string | null;
  name?: string; // session_info
}

export function parsePi(path: string) {
  let sid: string | null = null,
    project: string | null = null,
    sessionTitle: string | null = null,
    excluded = false;
  const issues = new Set<string>(),
    records: PiRecord[] = [],
    // Topology over every entry (not just interesting types) so the active
    // path can walk through skipped entries such as context_edit/compaction.
    parentOf = new Map<string, string | null>();
  let lastEntryId: string | null = null,
    idlessEntries = false;
  // toolCallId -> issuing assistant response end + tool name, so toolResult
  // records can fall back to the issuing response end when durationMs is
  // missing and prefer their own toolName when present.
  const toolCalls = new Map<string, { end: number; name: string | null }>();
  const events: Event[] = [];

  const add = (
    turn_id: string,
    kind: Event["kind"],
    at_ms: number,
    model: string | null = null,
    extras: {
      end_ms?: number | null;
      thinking_level?: string | null;
      tool_id?: string | null;
      tool_name?: string | null;
    } = {},
  ) => {
    const rawObj: Record<string, unknown> = { turn_id, kind, at_ms, model };
    if (extras.end_ms != null) rawObj.end_ms = extras.end_ms;
    if (extras.thinking_level) rawObj.thinking_level = extras.thinking_level;
    if (extras.tool_id) rawObj.tool_id = extras.tool_id;
    if (extras.tool_name) rawObj.tool_name = extras.tool_name;
    events.push({
      turn_id,
      kind,
      at_ms,
      model,
      end_ms: extras.end_ms ?? undefined,
      thinking_level: extras.thinking_level ?? undefined,
      tool_id: extras.tool_id ?? undefined,
      tool_name: extras.tool_name ?? undefined,
      key: hash(legacyJSON(["Pi", sid, rawObj])),
    });
  };

  // ---- Phase A: collect slim records and the full id->parentId topology. ----
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error();
      if (r.type === "session") {
        if (typeof r.version !== "number" || r.version > 3)
          throw new ValidationError("Pi 会话版本大于 3；未知格式不猜测，未导入");
        if (!validId(r.id)) throw Error();
        if (sid && sid !== r.id) excluded = true;
        sid = r.id;
        if (typeof r.parentSession === "string" && r.parentSession.trim())
          throw new ValidationError(
            "Pi fork 副本（parentSession）会重复继承父会话记录，暂不支持导入",
          );
        if (typeof r.cwd === "string" && r.cwd.trim())
          project =
            posix
              .basename(r.cwd.replaceAll("\\", "/"))
              .slice(0, 100) || project;
        continue;
      }
      // Topology covers every entry (skipped types included) and the tree leaf
      // is whatever was appended last, so the active path can walk through
      // context_edit/compaction entries unbroken.
      if (validId(r.id)) {
        parentOf.set(r.id, typeof r.parentId === "string" ? r.parentId : null);
        lastEntryId = r.id;
      } else if (r.type === "message" || r.type === "model_change" || r.type === "thinking_level_change" || r.type === "session_info")
        idlessEntries = true;
      if (r.type === "model_change") {
        if (!sid) continue;
        const provider = typeof r.provider === "string" ? r.provider.trim() : "";
        const modelId = typeof r.modelId === "string" ? r.modelId.trim() : "";
        if (!provider || !modelId) continue;
        records.push({
          type: "model_change",
          id: String(r.id ?? ""),
          parentId: typeof r.parentId === "string" ? r.parentId : null,
          at: iso(r.timestamp),
          model: truncate(provider + "/" + modelId, 120),
        });
        continue;
      }
      if (r.type === "thinking_level_change") {
        if (!sid) continue;
        const level =
          typeof r.thinkingLevel === "string" && r.thinkingLevel.trim()
            ? truncate(r.thinkingLevel.trim(), 40)
            : null;
        if (!level) continue;
        records.push({
          type: "thinking_level_change",
          id: String(r.id ?? ""),
          parentId: typeof r.parentId === "string" ? r.parentId : null,
          at: iso(r.timestamp),
          thinkingLevel: level,
        });
        continue;
      }
      if (r.type === "session_info") {
        if (!sid) continue;
        records.push({
          type: "session_info",
          id: String(r.id ?? ""),
          parentId: typeof r.parentId === "string" ? r.parentId : null,
          at: iso(r.timestamp),
          // Upstream semantics: the latest entry wins and a name that is empty
          // after sanitizing explicitly clears the display name.
          name:
            typeof r.name === "string" && r.name.replace(/[\r\n]+/g, " ").trim()
              ? truncate(r.name.replace(/[\r\n]+/g, " ").trim(), 100)
              : "",
        });
        continue;
      }
      if (r.type !== "message") continue;
      const m = r.message;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      const base = {
        type: "message",
        id: typeof r.id === "string" ? r.id : "",
        parentId: typeof r.parentId === "string" ? r.parentId : null,
        at: iso(r.timestamp),
      };
      if (m.role === "user") {
        if (!validId(base.id)) {
          issues.add("部分记录缺少有效消息 ID，未猜测归属");
          continue;
        }
        records.push({ ...base, role: "user" });
      } else if (m.role === "assistant") {
        records.push({
          ...base,
          role: "assistant",
          reqStart: epochMs(m.timestamp),
          dur: durationMs(m.durationMs),
          thinkingLevel:
            typeof m.thinkingLevel === "string" && m.thinkingLevel.trim()
              ? truncate(m.thinkingLevel.trim(), 40)
              : null,
          model:
            typeof m.model === "string" && m.model.trim()
              ? truncate(m.model, 120)
              : null,
          stopReason: typeof m.stopReason === "string" ? m.stopReason : "",
          toolCalls: Array.isArray(m.content)
            ? m.content
                .filter(
                  (b: unknown) =>
                    b &&
                    typeof b === "object" &&
                    !Array.isArray(b) &&
                    (b as { type?: string }).type === "toolCall",
                )
                .map((b: unknown) => {
                  const c = b as { id?: unknown; name?: unknown };
                  return {
                    id: typeof c.id === "string" ? c.id : "",
                    name:
                      typeof c.name === "string" && c.name ? c.name : "tool",
                  };
                })
            : [],
        });
      } else if (m.role === "toolResult") {
        records.push({
          ...base,
          role: "toolResult",
          reqStart: epochMs(m.timestamp),
          dur: durationMs(m.durationMs),
          toolCallId:
            typeof m.toolCallId === "string" ? m.toolCallId : null,
          toolName:
            typeof m.toolName === "string" && m.toolName ? m.toolName : null,
        });
      }
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!sid) throw new ValidationError("未找到有效 Pi 会话元数据");
  if (excluded)
    throw new ValidationError("Pi 混合会话记录暂不支持；未导入");

  // ---- Phase B: select the active root-to-last-entry path. ----
  let active: Set<string> | null = null;
  const hasTopology = lastEntryId !== null && !idlessEntries;
  if (hasTopology) {
    active = new Set<string>();
    let cursor: string | null = lastEntryId;
    let broken = false;
    while (cursor !== null) {
      if (active.has(cursor)) break; // defensive: cycle guard
      active.add(cursor);
      const parent = parentOf.get(cursor);
      if (parent !== undefined && parent !== null && !parentOf.has(parent)) {
        broken = true; // parentId dangles outside the file
        break;
      }
      cursor = parent ?? null;
    }
    if (broken) {
      active = null;
      issues.add("会话分支结构不完整；按追加顺序导入，可能包含被放弃的分支");
    }
  } else if (records.length > 0) {
    issues.add("部分记录缺少有效 ID，无法重建分支结构；按追加顺序导入");
  }
  const selected = active
    ? records.filter((r) => active!.has(r.id))
    : records;
  if (active) {
    const abandoned = records.length - selected.length;
    if (abandoned > 0)
      issues.add(
        `会话包含 ${abandoned} 条被放弃的分支记录，未计入统计`,
      );
  }

  // ---- Phase C: emit events along the active path. ----
  let current: string | null = null,
    currentThinking: string | null = null;
  // model_change entries seen before any open user turn describe the model
  // the next turn starts with; keep them until a turn opens.
  const pendingModels: { at: number; model: string }[] = [];
  // stopReason "error" may be automatically retried by the agent loop with no
  // intervening user message: defer the terminal until the next record proves
  // whether the turn really ended ({ at } = error record append time).
  let pendingFail: { at: number } | null = null;

  for (const r of selected) {
    const at = r.at;
    if (r.type === "session_info") {
      sessionTitle = r.name ? r.name : null;
      continue;
    }
    if (r.type === "model_change") {
      if (current) add(current, "model", at, r.model ?? null);
      else if (r.model)
        pendingModels.push({ at, model: r.model });
      continue;
    }
    if (r.type === "thinking_level_change") {
      currentThinking = r.thinkingLevel ?? null;
      // Inside an open turn the switch itself is timing evidence.
      if (current && r.thinkingLevel)
        add(current, "model", at, null, { thinking_level: r.thinkingLevel });
      continue;
    }
    if (r.role === "user") {
      if (current && pendingFail) {
        // No retry followed the error: the turn really ended in failure.
        add(current, "fail", pendingFail.at);
      }
      pendingFail = null;
      current = r.id;
      add(current, "start", at);
      for (const m of pendingModels.splice(0)) add(current, "model", m.at, m.model);
      continue;
    }
    if (r.role === "assistant") {
      if (!current) continue;
      // Any further assistant/tool activity without a user message proves the
      // error response was retried automatically: keep the originating turn.
      pendingFail = null;
      const turn = current,
        requestStart = r.reqStart!,
        dur = r.dur ?? null,
        // Response end: monotonic duration preferred, else record append ISO.
        responseEnd = dur !== null ? requestStart + dur : at;
      const level = r.thinkingLevel ?? currentThinking;
      // Always emit the model event: even without a model name the response
      // span is first-hand timing evidence for work_ms; the null model is
      // bucketed as 未知模型 downstream.
      add(turn, "model", requestStart, r.model ?? null, {
        end_ms: responseEnd,
        thinking_level: level,
      });
      for (const c of r.toolCalls ?? []) {
        if (c.id) toolCalls.set(c.id, { end: responseEnd, name: c.name });
        add(turn, "tool_use", responseEnd, null, {
          tool_id: c.id || null,
          tool_name: c.name,
        });
      }
      if (r.stopReason === "stop" || r.stopReason === "length") {
        add(turn, "complete", at);
        current = null;
      } else if (r.stopReason === "error") {
        pendingFail = { at };
      } else if (r.stopReason === "aborted") {
        add(turn, "abort", at);
        current = null;
      }
      continue;
    }
    if (r.role === "toolResult") {
      if (!current) continue;
      pendingFail = null;
      const created = r.reqStart!,
        dur = r.dur ?? null,
        tid = r.toolCallId,
        issuing = tid ? toolCalls.get(tid) : undefined;
      const tname = r.toolName ?? (issuing?.name ?? null);
      let toolStart: number;
      if (dur !== null) toolStart = created - dur;
      else if (issuing) {
        toolStart = issuing.end;
        issues.add(
          "部分工具结果缺少 durationMs；工具开始时刻回退为发起响应结束，可能包含未分类延迟",
        );
      } else {
        toolStart = at;
        issues.add("部分工具结果缺少 durationMs 且无法定位发起响应；计时精度受限");
      }
      add(current, "tool_result", toolStart, null, {
        end_ms: created,
        tool_id: tid,
        tool_name: tname,
      });
      continue;
    }
  }
  if (current && pendingFail) add(current, "fail", pendingFail.at);

  if (project === null) {
    // v1-era sessions have no cwd header; the session directory name encodes
    // the original cwd lossily (all path separators became "-"), so take the
    // final segment and flag the uncertainty.
    let encoded = posix.basename(posix.dirname(path));
    if (encoded.startsWith("--")) encoded = encoded.slice(2);
    if (encoded.endsWith("--")) encoded = encoded.slice(0, -2);
    const last = encoded.split("-").pop() ?? "";
    project = last ? truncate(last, 100) : "未知项目";
    issues.add("会话头缺少 cwd；项目名由编码目录名有损解码，可能不准确");
  }
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "pi/" + sid,
      agent: "Pi",
      project,
      client: "pi",
      title: sessionTitle,
    },
    events: [...unique.values()],
    issues: [...issues].sort(),
  };
}
