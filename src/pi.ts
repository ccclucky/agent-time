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
    excluded = false;
  const events: Event[] = [],
    issues = new Set<string>();

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
      if (!sid || r.type !== "message") continue;
      const m = r.message;
      if (!m || typeof m !== "object" || Array.isArray(m)) continue;
      if (m.role !== "user") continue;
      if (!validId(r.id)) {
        issues.add("部分记录缺少有效消息 ID，未猜测归属");
        continue;
      }
      current = r.id as string;
      add(current, "start", iso(r.timestamp));
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件");
    }
  }
  if (!sid) throw new ValidationError("未找到有效 Pi 会话元数据");
  if (excluded)
    throw new ValidationError("Pi 混合会话记录暂不支持；未导入");
  if (project === null) project = "未知项目";
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
