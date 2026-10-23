/** Parse Pi agent session JSONL into the shared Event stream.
 * Basis: badlogic/pi-mono pinned 16f5f0af4d85ca583d045ceb5ed6d646fcaf7761
 * (coding-agent 1.4.0) session-manager encoding and SessionEntry types.
 * Only timing metadata is read; message content is never persisted.
 */
import { posix } from "node:path";
import { lines, timestamp, hash, legacyJSON } from "./codex.js";
import { ValidationError, type Event } from "./types.js";

const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}(?![\s\S])/.test(v);

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

export function parsePi(path: string) {
  let sid: string | null = null,
    project: string | null = null,
    current: string | null = null,
    currentThinking: string | null = null,
    excluded = false;
  const events: Event[] = [],
    issues = new Set<string>(),
    // toolCallId -> issuing assistant response end + tool name, so toolResult
    // records can fall back to the issuing response end when durationMs is
    // missing and prefer their own toolName when present.
    toolCalls = new Map<string, { end: number; name: string | null }>(),
    // model_change entries seen before any open user turn describe the model
    // the next turn starts with; keep them until a turn opens.
    pendingModels: { at: number; model: string }[] = [];

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
        if (typeof r.cwd === "string" && r.cwd.trim())
          project =
            posix
              .basename(r.cwd.replaceAll("\\", "/"))
              .slice(0, 100) || project;
        continue;
      }
      if (r.type === "model_change") {
        if (!sid) continue;
        const provider = typeof r.provider === "string" ? r.provider.trim() : "";
        const modelId = typeof r.modelId === "string" ? r.modelId.trim() : "";
        if (!provider || !modelId) continue;
        const at = iso(r.timestamp),
          model = Array.from(provider + "/" + modelId).slice(0, 120).join("");
        if (current) add(current, "model", at, model);
        else pendingModels.push({ at, model });
        continue;
      }
      if (r.type === "thinking_level_change") {
        if (!sid) continue;
        const level =
          typeof r.thinkingLevel === "string" && r.thinkingLevel.trim()
            ? Array.from(r.thinkingLevel.trim()).slice(0, 40).join("")
            : null;
        if (!level) continue;
        currentThinking = level;
        // Inside an open turn the switch itself is timing evidence.
        if (current) add(current, "model", iso(r.timestamp), null, { thinking_level: level });
        continue;
      }
      if (!sid || r.type !== "message") continue;
      const m = r.message;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      if (m.role === "user") {
        if (!validId(r.id)) {
          issues.add("部分记录缺少有效消息 ID，未猜测归属");
          continue;
        }
        current = r.id as string;
        add(current, "start", iso(r.timestamp));
        for (const m of pendingModels.splice(0)) add(current, "model", m.at, m.model);
        continue;
      }
      if (m.role === "assistant") {
        // The model loop (toolUse/deferred) continues the same user turn.
        if (!current) continue;
        const turn = current,
          requestStart = epochMs(m.timestamp),
          dur = durationMs(m.durationMs),
          recordAt = iso(r.timestamp),
          // Response end: monotonic duration preferred, else record append ISO.
          responseEnd = dur !== null ? requestStart + dur : recordAt;
        const level =
          typeof m.thinkingLevel === "string" && m.thinkingLevel.trim()
            ? Array.from(m.thinkingLevel.trim()).slice(0, 40).join("")
            : currentThinking;
        if (typeof m.model === "string" && m.model.trim())
          add(turn, "model", requestStart, Array.from(m.model).slice(0, 120).join(""), {
            end_ms: responseEnd,
            thinking_level: level,
          });
        if (Array.isArray(m.content))
          for (const b of m.content) {
            if (!b || typeof b !== "object" || Array.isArray(b)) continue;
            if (b.type !== "toolCall") continue;
            const tid = typeof b.id === "string" ? b.id : null;
            const tname = typeof b.name === "string" && b.name ? b.name : "tool";
            if (tid) toolCalls.set(tid, { end: responseEnd, name: tname });
            add(turn, "tool_use", responseEnd, null, {
              tool_id: tid,
              tool_name: tname,
            });
          }
        if (m.stopReason === "stop" || m.stopReason === "length") {
          add(turn, "complete", recordAt);
          current = null;
        } else if (m.stopReason === "aborted") {
          add(turn, "abort", recordAt);
          current = null;
        } else if (m.stopReason === "error") {
          add(turn, "fail", recordAt);
          current = null;
        }
        continue;
      }
      if (m.role === "toolResult") {
        if (!current) continue;
        const created = epochMs(m.timestamp),
          dur = durationMs(m.durationMs),
          tid = typeof m.toolCallId === "string" ? m.toolCallId : null,
          issuing = tid ? toolCalls.get(tid) : undefined;
        const tname =
          typeof m.toolName === "string" && m.toolName
            ? m.toolName
            : (issuing?.name ?? null);
        let at: number;
        if (dur !== null) at = created - dur;
        else if (issuing) {
          at = issuing.end;
          issues.add(
            "部分工具结果缺少 durationMs；工具开始时刻回退为发起响应结束，可能包含审批等待",
          );
        } else {
          at = iso(r.timestamp);
          issues.add("部分工具结果缺少 durationMs 且无法定位发起响应；计时精度受限");
        }
        add(current, "tool_result", at, null, {
          end_ms: created,
          tool_id: tid,
          tool_name: tname,
        });
        continue;
      }
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!sid) throw new ValidationError("未找到有效 Pi 会话元数据");
  if (excluded)
    throw new ValidationError("Pi 混合会话记录暂不支持；未导入");
  if (project === null) {
    // v1-era sessions have no cwd header; the session directory name encodes
    // the original cwd lossily (all path separators became "-"), so take the
    // final segment and flag the uncertainty.
    let encoded = posix.basename(posix.dirname(path));
    if (encoded.startsWith("--")) encoded = encoded.slice(2);
    if (encoded.endsWith("--")) encoded = encoded.slice(0, -2);
    const last = encoded.split("-").pop() ?? "";
    project = last ? Array.from(last).slice(0, 100).join("") : "未知项目";
    issues.add("会话头缺少 cwd；项目名由编码目录名有损解码，可能不准确");
  }
  issues.add(
    "Pi 已导入含 end_ms 计时证据的事件流（模型请求、工具执行、思考等级）；三态耗时切分将由后续版本提供，当前耗时暂不显示。",
  );
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "pi/" + sid,
      agent: "Pi",
      project,
      client: "pi",
    },
    events: [...unique.values()],
    issues: [...issues].sort(),
  };
}
