import path from "node:path";
import os from "node:os";
import {
  existsSync,
  realpathSync,
  statSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { RULES } from "./rules.js";
import { locate, expand, type Agent } from "./locations.js";
import {
  ValidationError,
  type AdapterName,
  isAdapterName,
} from "./types.js";
import type { Store } from "./store.js";
export const NAMES: Record<Agent, string> = {
  codex: "Codex",
  claude: "Claude Code",
  omp: "Oh-My-Pi",
  pi: "Pi",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};
// Single source of truth for which filenames count as session files per
// agent: Codex accepts .jsonl and .jsonl.zst, Antigravity only the canonical
// transcript.jsonl (transcript_full.jsonl is a mirror and would double-count),
// every other adapter only .jsonl. Shared by the CLI import walk, directory
// discovery, and Store.importFile so the three can never drift apart.
export function isSessionFile(agent: string, file: string): boolean {
  if (agent === "antigravity")
    // Canonical name only: transcript_full.jsonl is a mirror and would
    // double-count; the basename check implies .jsonl.
    return path.basename(file) === "transcript.jsonl";
  return (
    file.endsWith(".jsonl") ||
    (agent === "codex" && file.endsWith(".jsonl.zst"))
  );
}
export function resolvePath(raw: unknown, home: string): string {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 4096 ||
    raw.includes("\0")
  )
    throw new ValidationError("请输入有效的本地目录");
  const p = expand(raw, home);
  if (!path.isAbsolute(p))
    throw new ValidationError("请使用绝对路径或以 ~/ 开头的路径");
  // Resolve existing ancestor links even when the selected directory is absent.
  function canonical(p: string): string {
    try {
      return realpathSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(p);
      return parent === p ? p : path.join(canonical(parent), path.basename(p));
    }
  }
  const resolved = canonical(path.resolve(p));
  if (
    resolved === path.parse(resolved).root ||
    resolved === canonical(path.resolve(home))
  )
    throw new ValidationError(
      "请选择具体工具目录，不要选择整个磁盘或用户主目录",
    );
  return resolved;
}
export class Directories {
  constructor(
    public store: Store,
    public home = os.homedir(),
    public environment: NodeJS.ProcessEnv = process.env,
    public platform = process.platform,
  ) {}
  location(agent: Agent) {
    return locate(agent, this.home, this.environment, this.platform);
  }
  get(agent: string) {
    if (!Object.hasOwn(NAMES, agent)) throw new ValidationError("不支持的工具");
    const a = agent as Agent;
    const saved = this.store.db
      .prepare("SELECT path,enabled FROM directory WHERE agent=?")
      .get(a) as { path: string | null; enabled: number } | undefined;
    const inferred = this.location(a),
      raw = saved?.path ?? inferred.path,
      source = saved?.path != null ? "custom" : inferred.source;
    let status = "unverified",
      resolved: string | null = null;
    if (raw) {
      try {
        resolved = resolvePath(raw, this.home);
        status = existsSync(resolved)
          ? statSync(resolved).isDirectory()
            ? "directory"
            : "not_directory"
          : "missing";
      } catch {
        status = "unreadable";
      }
    }
    return {
      agent: a,
      name: NAMES[a],
      path: raw,
      default_path: inferred.path,
      resolved_path: resolved,
      source,
      enabled: !!saved?.enabled,
      status,
      supported: isAdapterName(a),
      history_subdirectories: RULES[a].logs,
      location_note: inferred.note,
      evidence_url: inferred.evidence_url,
      history_locations: resolved
        ? RULES[a].logs.map((sub) => path.join(resolved!, sub))
        : [],
      default_verified:
        inferred.path !== null && inferred.evidence_url !== null,
    };
  }
  list() {
    return Object.keys(NAMES).map((a) => this.get(a));
  }
  save(agent: unknown, raw: unknown, enabled: unknown) {
    if (
      typeof agent !== "string" ||
      !Object.hasOwn(NAMES, agent) ||
      typeof enabled !== "boolean"
    )
      throw new ValidationError("请选择有效工具和接入状态");
    if (enabled && !isAdapterName(agent))
      throw new ValidationError(
        "此工具适配器尚未实现，只能保存目录，不能启用接入",
      );
    if (raw !== null && typeof raw !== "string")
      throw new ValidationError("请输入有效的本地目录");
    const effective = raw ?? this.location(agent as Agent).path;
    if (effective !== null) {
      const p = resolvePath(effective, this.home);
      if (existsSync(p) && !statSync(p).isDirectory())
        throw new ValidationError("此路径是文件，请选择工具的数据目录");
    }
    if (enabled && effective === null)
      throw new ValidationError("尚未确认默认位置，请先指定目录");
    this.store.db
      .prepare(
        "INSERT INTO directory(agent,path,enabled) VALUES(?,?,?) ON CONFLICT(agent) DO UPDATE SET path=excluded.path,enabled=excluded.enabled",
      )
      .run(agent, raw, Number(enabled));
    return this.get(agent);
  }
  collect() {
    const files = new Map<string, string>(),
      notices: string[] = [];
    const agents = new Map<string, AdapterName>();
    for (const item of this.list()) {
      if (!item.enabled || !item.supported) continue;
      if (item.status !== "directory") {
        notices.push(`${item.name} 数据目录不存在或无法读取；未扫描`);
        continue;
      }
      const root = item.resolved_path!;
      let count = 0;
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
          (a, b) => a.name.localeCompare(b.name),
        )) {
          if (entry.isSymbolicLink()) continue;
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (item.agent !== "claude" || entry.name !== "subagents") walk(p);
          } else if (entry.isFile() && isSessionFile(item.agent, p)) {
            const real = realpathSync(p),
              rel = path.relative(root, real);
            if (
              rel === ".." ||
              rel.startsWith(".." + path.sep) ||
              path.isAbsolute(rel)
            ) {
              notices.push(`${item.name} 有记录链接超出数据目录，未读取`);
              continue;
            }
            if (
              item.agent === "claude" &&
              path.basename(real).startsWith("agent-")
            )
              continue;
            files.set(real, root);
            agents.set(real, item.agent as AdapterName);
            count++;
            if (files.size > 5000)
              throw new ValidationError(
                "配置目录内超过 5000 个会话文件，请缩小数据目录范围",
              );
          }
        }
      };
      try {
        for (const sub of RULES[item.agent].logs) {
          const dir = path.join(root, sub);
          if (!existsSync(dir)) continue;
          if (lstatSync(dir).isSymbolicLink()) {
            notices.push(
              `${item.name} 会话子目录是符号链接，未扫描；请将数据根目录设为实际位置`,
            );
            continue;
          }
          if (statSync(dir).isDirectory()) walk(dir);
        }
        if (!count)
          notices.push(`${item.name} 目录存在，但没有找到可导入的会话 JSONL`);
      } catch (e) {
        if (e instanceof ValidationError) throw e;
        notices.push(`${item.name} 部分会话目录无法读取；已有记录保留旧快照`);
      }
    }
    return { files, agents, notices: [...new Set(notices)] };
  }
}
