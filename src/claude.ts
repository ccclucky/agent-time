/** Read only allowlisted transcript metadata; never persist message content.
 * Basis: official SDK sessions.py / test_sessions.py at dd27b703647a4f8989ab656f00c85f98090a60fd.
 * Message timestamps are record times, not exact model execution boundaries.
 */
import { posix } from "node:path";
import { lines, timestamp, hash, legacyJSON } from "./codex.js";
import { ValidationError, type Event } from "./types.js";
const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}(?![\s\S])/.test(v);
export function parseClaude(path: string) {
  let sid: string | null = null,
    project = "未知项目",
    current: string | null = null,
    excluded = false;
  const events: Event[] = [],
    issues = new Set<string>(),
    seen = new Set<string>();
  // Keep topology metadata only. Parallel assistant/tool blocks may fan out;
  // reject branching user submissions instead of summing alternative histories.
  const userParents = new Map<string, string>();
  const add = (
    turn_id: string,
    kind: Event["kind"],
    at_ms: number,
    model: string | null = null,
  ) => {
    const event = { turn_id, kind, at_ms, model };
    events.push({
      ...event,
      key: hash(legacyJSON(["Claude Code", sid, event])),
    });
  };
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error();
      if (
        !["user", "assistant", "system", "progress", "attachment"].includes(
          r.type,
        )
      )
        continue;
      if (r.isSidechain === true || r.teamName || r.agentId) {
        excluded = true;
        continue;
      }
      if (!validId(r.sessionId)) continue;
      if (sid && sid !== r.sessionId) {
        excluded = true;
        continue;
      }
      sid = r.sessionId;
      if (typeof r.cwd === "string")
        project =
          posix.basename(r.cwd.replaceAll("\\", "/")).slice(0, 100) || project;
      if (
        r.type !== "user" &&
        r.type !== "assistant" &&
        !(r.type === "system" && r.subtype === "turn_duration")
      )
        continue;
      if (!validId(r.uuid)) {
        issues.add("部分记录缺少有效消息 ID，未猜测归属");
        continue;
      }
      const key = r.uuid + ":" + r.type;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = timestamp(r.timestamp),
        content = r.message?.content;
      if (r.type === "user") {
        // Tool results, injected metadata, compact summaries and synthetic prompts
        // are not independent human submissions.
        if (
          r.isMeta ||
          r.isCompactSummary ||
          r.isSynthetic ||
          r.toolUseResult ||
          r.sourceToolAssistantUUID ||
          (Array.isArray(content) &&
            content.some(
              (b: unknown) =>
                b &&
                typeof b === "object" &&
                (b as { type?: unknown }).type === "tool_result",
            ))
        )
          continue;
        if (!(
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.some(
              (b: unknown) =>
                b &&
                typeof b === "object" &&
                (b as { type?: unknown }).type === "text",
            ))
        ))
          continue;
        if (validId(r.parentUuid)) {
          const previous = userParents.get(r.parentUuid);
          if (previous && previous !== r.uuid) excluded = true;
          userParents.set(r.parentUuid, r.uuid);
        }
        current = r.uuid as string;
        add(current, "start", at);
        continue;
      }
      if (!current) continue;
      if (r.type === "assistant") {
        if (typeof r.message?.model === "string")
          add(
            current,
            "model",
            at,
            Array.from(r.message.model as string)
              .slice(0, 120)
              .join(""),
          );
        // A tool-use completion is not a completed user interaction. Null or
        // missing stop_reason never implies completion from the last file line.
        if (["end_turn", "stop_sequence"].includes(r.message?.stop_reason)) {
          add(current, "complete", at);
          current = null;
        }
      } else if (r.type === "system" && r.subtype === "turn_duration") {
        // Use its observed timestamp, not timestamp-durationMs as an invented start.
        add(current, "complete", at);
        current = null;
      }
    } catch {
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!sid)
    throw new ValidationError(
      "未找到有效 Claude Code 会话记录（需要 sessionId）",
    );
  if (excluded)
    throw new ValidationError(
      "Claude Code 子 Agent、混合会话或分支记录暂不支持；未导入",
    );
  issues.add(
    "Claude Code 耗时为用户消息记录至明确结束记录的跨度，可能包含授权等待；不是精确执行耗时。缺少明确结束标记时不计时。",
  );
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "claude/" + sid,
      agent: "Claude Code",
      project,
      client: "claude",
    },
    events: [...unique.values()],
    issues: [...issues].sort(),
  };
}
