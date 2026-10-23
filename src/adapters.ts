export const SOURCES = [
  {
    agent: "Codex",
    status: "首批适配 · 只读导入",
    supported: true,
    note: "读取明确的开始与结束事件；等待确认或补充的时间无法单独恢复。",
  },
  {
    agent: "Claude Code",
    status: "只读导入 · 消息记录跨度",
    supported: true,
    note: "读取 projects 中的主会话；有明确结束标记时统计消息记录跨度，不能拆分授权等待。",
  },
  {
    agent: "OpenCode",
    status: "已调研 · 尚未接入",
    supported: false,
    note: "不同版本存储结构有差异，需独立适配导出格式。",
  },
  {
    agent: "Pi",
    status: "只读导入 · 事件流三态切分",
    supported: true,
    note: "读取 sessions/<编码项目> 的事件流，按模型响应与工具执行时长切分纯工作；审批等待仅在时间戳可测时计入，未落盘的明细不额外拆分。",
  },
  {
    agent: "Oh-My-Pi",
    status: "已调研 · 尚未接入",
    supported: false,
    note: "与 Pi 分别适配，需验证完成时间和分支归属。",
  },
  {
    agent: "Antigravity",
    status: "数据格式待验证",
    supported: false,
    note: "尚无经过验证的稳定本地导入格式。",
  },
];
