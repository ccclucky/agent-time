export const SOURCES = [
  {
    agent: "Codex",
    status: "只读导入 · 三态耗时与 Token 下钻",
    supported: true,
    note: "基于 task_started/task_complete 轮次边界、call_id 工具配对与 item_completed 完成锚点的三态切分；本地格式无审批事件，等待人审阅未单独计量（记 0）。",
  },
  {
    agent: "DeepSeek Harness",
    status: "只读导入 · 事件流三态切分",
    supported: true,
    note: "读取 sessions/<编码工作目录> 的多帧 zstd 事件流，按模型推理与工具执行跨度切分纯工作；等待人审阅仅在审批阻断事件可测时计入，本地语料未出现（记未知）。",
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
    note: "读取 sessions/<编码项目> 的事件流，按模型推理与工具执行耗时切分纯工作；等待人审阅仅在时间戳可测时计入，未落盘的明细不额外拆分。",
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
