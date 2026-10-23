/** Read only allowlisted transcript metadata; never persist message content.
 * Basis: official SDK sessions.py / test_sessions.py at dd27b703647a4f8989ab656f00c85f98090a60fd.
 * Message timestamps are record times, not exact model execution boundaries.
 */
import { posix } from "node:path";
import { lines, timestamp, hash, legacyJSON } from "./codex.js";
import { ValidationError, type Event } from "./types.js";

const validId = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:-]{1,200}(?![\s\S])/.test(v);

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
}

export function parseClaude(path: string) {
  let sid: string | null = null,
    project = "未知项目",
    current: string | null = null,
    lastTurnId: string | null = null,
    excluded = false,
    sessionTitle: string | null = null,
    firstPrompt: string | null = null;
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
    agent_id: string | null = null,
    tool_id: string | null = null,
    tool_name: string | null = null,
  ) => {
    const rawObj: Record<string, unknown> = { turn_id, kind, at_ms, model };
    if (agent_id) rawObj.agent_id = agent_id;
    if (tool_id) rawObj.tool_id = tool_id;
    if (tool_name) rawObj.tool_name = tool_name;
    const event: Event = {
      turn_id,
      kind,
      at_ms,
      model,
      agent_id: agent_id ?? undefined,
      tool_id: tool_id ?? undefined,
      tool_name: tool_name ?? undefined,
      key: hash(legacyJSON(["Claude Code", sid, rawObj])),
    };
    events.push(event);
  };
  for (const line of lines(path)) {
    if (!line.toString().trim()) continue;
    try {
      const r = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(line),
      );
      if (!r || typeof r !== "object" || Array.isArray(r)) throw Error();
      if (
        !["user", "assistant", "system", "progress", "attachment", "permission_request", "permission_response"].includes(
          r.type,
        )
      )
        continue;
      const agentId =
        typeof r.agentId === "string"
          ? r.agentId
          : r.isSidechain === true
            ? "sidechain"
            : r.teamName
              ? String(r.teamName)
              : null;
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
        !(r.type === "system" && r.subtype === "turn_duration") &&
        !(r.type === "permission_request" || r.subtype === "permission_request") &&
        !(r.type === "permission_response" || r.subtype === "permission_response")
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
        content = r.message?.content as unknown;

      const activeTurn = current || (agentId ? lastTurnId : null);

      if (r.type === "permission_request" || r.subtype === "permission_request") {
        if (activeTurn) add(activeTurn, "review_wait_start", at, null, agentId);
        continue;
      }
      if (r.type === "permission_response" || r.subtype === "permission_response") {
        if (activeTurn) add(activeTurn, "review_wait_end", at, null, agentId);
        continue;
      }

      if (r.type === "custom-title" && typeof r.title === "string" && r.title.trim() && r.title !== "undefined") {
        sessionTitle = r.title.trim();
        continue;
      }
      if (r.type === "user") {
        if (!firstPrompt && !r.isMeta && !r.isCompactSummary) {
          let t = "";
          if (typeof content === "string") t = content;
          else if (Array.isArray(content)) {
            t = content.filter((b: any) => b && typeof b === "object" && b.type === "text").map((b: any) => b.text).join(" ");
          }
          if (t && !t.startsWith("<local-command-caveat>")) {
            const argsMatch = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
            let candidate = "";
            if (argsMatch && argsMatch[1].trim()) {
              candidate = argsMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            }
            if (!candidate) {
              candidate = t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
            }
            if (
              candidate &&
              !/^\/?(clear|model|compact|init|help|cost|doctor)(\s+|$)/i.test(candidate) &&
              !candidate.startsWith("Set model to") &&
              !candidate.startsWith("Compacted") &&
              candidate.length >= 3
            ) {
              firstPrompt = candidate.slice(0, 60);
            }
          }
        }
        const isToolResult =
          r.toolUseResult ||
          (Array.isArray(content) &&
            content.some(
              (b: unknown) =>
                b &&
                typeof b === "object" &&
                (b as ContentBlock).type === "tool_result",
            ));

        if (isToolResult) {
          if (activeTurn) {
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b && typeof b === "object" && (b as ContentBlock).type === "tool_result") {
                  const tid = typeof (b as ContentBlock).tool_use_id === "string" ? (b as ContentBlock).tool_use_id! : null;
                  add(activeTurn, "tool_result", at, null, agentId, tid, null);
                }
              }
            } else {
              add(activeTurn, "tool_result", at, null, agentId);
            }
          }
          continue;
        }

        if (r.isMeta || r.isCompactSummary || r.isSynthetic || r.sourceToolAssistantUUID)
          continue;

        if (!(
          typeof content === "string" ||
          (Array.isArray(content) &&
            content.some(
              (b: unknown) =>
                b &&
                typeof b === "object" &&
                (b as ContentBlock).type === "text",
            ))
        ))
          continue;
        if (validId(r.parentUuid)) {
          const previous = userParents.get(r.parentUuid);
          if (previous && previous !== r.uuid) {
            issues.add("会话包含重试或分支提问；已兼容解析所有有效轮次");
          }
          userParents.set(r.parentUuid, r.uuid);
        }
        current = r.uuid as string;
        lastTurnId = current;
        add(current, "start", at, null, agentId);
        continue;
      }
      if (!activeTurn) continue;
      if (r.type === "assistant") {
        if (typeof r.message?.model === "string")
          add(
            activeTurn,
            "model",
            at,
            Array.from(r.message.model as string)
              .slice(0, 120)
              .join(""),
            agentId,
          );
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === "object" && (b as ContentBlock).type === "tool_use") {
              const tid = typeof (b as ContentBlock).id === "string" ? (b as ContentBlock).id! : null;
              const tname = typeof (b as ContentBlock).name === "string" ? (b as ContentBlock).name! : "tool";
              add(activeTurn, "tool_use", at, null, agentId, tid, tname);
            }
          }
        }
        if (["end_turn", "stop_sequence"].includes(r.message?.stop_reason)) {
          add(activeTurn, "complete", at, null, agentId);
          if (!agentId) current = null;
        }
      } else if (r.type === "system" && r.subtype === "turn_duration") {
        add(activeTurn, "complete", at, null, agentId);
        if (!agentId) current = null;
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
      "Claude Code 混合会话或分支记录暂不支持；未导入",
    );
  issues.add(
    "Claude Code 已支持基于 tool_use ↔ tool_result 事件流与 turn_duration 埋点的三态耗时切分（纯工作、等待人审阅、待命）。缺少明确结束标记时不计时。",
  );
  const unique = new Map(events.map((e) => [e.key, e]));
  return {
    session: {
      id: "claude/" + sid,
      agent: "Claude Code",
      project,
      title: sessionTitle || firstPrompt || null,
      client: "claude",
    },
    events: [...unique.values()],
    issues: [...issues].sort(),
  };
}
