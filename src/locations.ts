import path from "node:path";
import { existsSync } from "node:fs";
import { RULES } from "./rules.js";
export type Agent = keyof typeof RULES;
export const expand = (raw: string, home: string) =>
  raw === "~"
    ? home
    : /^~[/\\]/.test(raw)
      ? path.join(home, raw.slice(2))
      : raw;
export function locate(
  agent: Agent,
  home: string,
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  const rule = RULES[agent];
  const result = (
    root: string | null = null,
    source = "default",
    note = rule.note,
  ) => ({
    path: root,
    source,
    note,
    evidence_url: rule.evidence,
    logs: rule.logs,
  });
  const unresolved = (note: string) => result(null, "unresolved", note);
  if (agent === "omp") {
    const profile = (value: string | undefined) => {
      const n = value?.trim() ?? "";
      if (!n || n === "default") return null;
      if (
        !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(n) ||
        n.endsWith(".") ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(n)
      )
        throw Error();
      return n;
    };
    try {
      const name = profile(env.OMP_PROFILE ?? env.PI_PROFILE),
        config = env.PI_CONFIG_DIR || ".omp";
      if (
        path.isAbsolute(config) ||
        config.split(/[/\\]/).includes("..") ||
        config.includes("~")
      )
        return unresolved(
          "PI_CONFIG_DIR 不是明确的主目录相对位置，请手动指定 Oh-My-Pi 的会话数据目录。",
        );
      const base = path.join(home, config),
        root = name ? path.join(base, "profiles", name) : base,
        defaultAgent = path.join(root, "agent");
      let resolved = defaultAgent;
      if (!name && env.PI_CODING_AGENT_DIR) {
        let legacy: string | null = null;
        try {
          legacy = profile(env.PI_PROFILE);
        } catch {}
        if (
          env.PI_CODING_AGENT_DIR !==
          (legacy ? path.join(base, "profiles", legacy, "agent") : null)
        ) {
          if (!path.isAbsolute(env.PI_CODING_AGENT_DIR))
            return unresolved(
              "PI_CODING_AGENT_DIR 为相对路径，无法知道 Oh-My-Pi 的启动工作目录；请手动指定。",
            );
          resolved = path.normalize(env.PI_CODING_AGENT_DIR);
        }
      }
      if (
        ["linux", "darwin"].includes(platform) &&
        resolved === defaultAgent &&
        env.XDG_DATA_HOME
      ) {
        if (!path.isAbsolute(env.XDG_DATA_HOME))
          return unresolved(
            "XDG_DATA_HOME 不是绝对路径，无法可靠推导已迁移数据的位置。",
          );
        const target = name
          ? path.join(env.XDG_DATA_HOME, "omp", "profiles", name)
          : path.join(env.XDG_DATA_HOME, "omp");
        if (existsSync(target))
          return result(
            target,
            "environment",
            "按 Oh-My-Pi 上游迁移规则：对应的 XDG 应用/profile 目录已存在，会话位于其 sessions 子目录。",
          );
      }
      if (
        name ||
        env.PI_CONFIG_DIR ||
        resolved !== path.join(home, ".omp", "agent")
      )
        return result(
          resolved,
          "environment",
          "按 Oh-My-Pi 的 profile、配置根目录和 agentDir 优先级推导；会话在该目录的 sessions 中。",
        );
      return result(rule.root);
    } catch {
      return unresolved(
        "当前 profile 或目录状态无法可靠解析，请手动指定实际会话数据目录。",
      );
    }
  }
  if (agent === "opencode") {
    const base = expand(env.XDG_DATA_HOME || "~/.local/share", home);
    if (!path.isAbsolute(base))
      return unresolved(
        "XDG_DATA_HOME 为相对路径，无法推导其他进程实际使用的数据目录。",
      );
    const root = path.join(base, "opencode");
    if (env.OPENCODE_DB !== undefined) {
      const db = env.OPENCODE_DB;
      if (!db || db === ":memory:")
        return unresolved(
          "OPENCODE_DB 未指定持久化会话文件，不能预填一个假定的会话数据库目录。",
        );
      return result(
        path.dirname(path.isAbsolute(db) ? db : path.join(root, db)),
        "environment",
        "按 OPENCODE_DB 推导数据库所在目录；实际数据库文件名由该环境变量指定。",
      );
    }
    return result(
      env.XDG_DATA_HOME ? root : rule.root,
      env.XDG_DATA_HOME ? "environment" : "default",
    );
  }
  if (agent === "pi" && env.PI_CODING_AGENT_SESSION_DIR)
    return unresolved(
      "检测到 PI_CODING_AGENT_SESSION_DIR 指定独立会话目录，不再采用默认 agent/sessions。当前字段用于工具数据根目录，本版不猜测如何反推根目录，请手动设置。",
    );
  const key = (
    {
      codex: "CODEX_HOME",
      claude: "CLAUDE_CONFIG_DIR",
      pi: "PI_CODING_AGENT_DIR",
    } as Partial<Record<Agent, string>>
  )[agent];
  if (key && env[key]) {
    const raw = env[key]!,
      p = agent === "pi" ? expand(raw, home) : raw;
    if (!path.isAbsolute(p))
      return unresolved(
        `${key} 不是可确定的绝对目录，无法推导其他进程的启动路径，请手动指定。`,
      );
    return result(
      path.normalize(p),
      "environment",
      rule.note + ` 当前采用 ${key}。`,
    );
  }
  return result(rule.root, rule.root === null ? "unresolved" : "default");
}
