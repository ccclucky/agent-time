export const RULES = {
  codex: {
    root: "~/.codex",
    logs: ["sessions", "archived_sessions"],
    evidence:
      "https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/home-dir/src/lib.rs",
    note: "按 Codex 上游规则推导。实际会话位于 sessions 和 archived_sessions；不是配置文件本身。",
  },
  claude: {
    root: "~/.claude",
    logs: ["projects"],
    evidence:
      "https://github.com/anthropics/claude-agent-sdk-python/blob/dd27b703647a4f8989ab656f00c85f98090a60fd/src/claude_agent_sdk/_internal/sessions.py",
    note: "官方 Agent SDK 从 projects/<项目目录> 下读取会话 JSONL。",
  },
  pi: {
    root: "~/.pi/agent",
    logs: ["sessions"],
    evidence:
      "https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts",
    note: "会话位于 agent 目录中的 sessions/<编码后的工作目录>；CLI 指定的其他位置需手动设置。",
  },
  omp: {
    root: "~/.omp/agent",
    logs: ["sessions"],
    evidence:
      "https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/utils/src/dirs.ts",
    note: "默认 profile 的传统位置为 ~/.omp/agent/sessions；命名 profile、agentDir 和已迁移 XDG 位置分别解析。",
  },
  opencode: {
    root: "~/.local/share/opencode",
    logs: [],
    evidence:
      "https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/util/src/global-roots.ts",
    note: "这是数据目录，不是配置目录。稳定渠道通常使用 opencode.db；数据库文件名可随渠道或 OPENCODE_DB 改变。",
  },
  antigravity: {
    root: "~/.gemini/antigravity",
    logs: ["brain"],
    evidence: null,
    note: "会话位于 brain/<会话 ID>/.system_generated/logs/transcript.jsonl（2026-10 本机实测验证）；上游未公开目录规范，如位置有变请手动指定。",
  },
};
