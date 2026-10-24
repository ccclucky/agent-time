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
    status: "只读导入 · 消息跨度三态切分",
    supported: true,
    note: "只读打开数据目录中的 SQLite 会话数据库（opencode.db，message/part 旧版结构；session_v2 新格式拒绝导入）。模型生成取助手消息整段流式跨度：消息内流式空档计入模型生成（偏离 spec 字面的 part 口径——90 个 text part 中 88 个 start==end 无时长，reasoning 只覆盖思考突发；实测整段口径约为 part 时长和的 4 倍）。纯工作为该跨度扣除其中并行的工具执行跨度；轮内 step 间隙单列为未分类延迟，不计入纯工作；reasoning 段作为模型推理内部的思考下钻单列。permission 表为 ephemeral 且本地 0 行，等待人审阅记未知；Token 为助手消息逐请求用量的轮次合计（实测非累计快照）；SQL 时间列因重导入整体失真已弃用，仅读 JSON 载荷时间字段。",
  },
  {
    agent: "Pi",
    status: "只读导入 · 事件流三态切分",
    supported: true,
    note: "读取 sessions/<编码项目> 的事件流，按模型推理与工具执行耗时切分纯工作；等待人审阅仅在时间戳可测时计入，未落盘的明细不额外拆分。",
  },
  {
    agent: "Oh-My-Pi",
    status: "只读导入 · 事件流三态切分",
    supported: true,
    note: "读取 sessions/<编码工作目录>/<uuid>.jsonl 事件流（仅识别 UUID 命名的会话流，工作区产物不导入），按模型响应与工具执行跨度切分纯工作；轮次边界优先文件内用户消息，旧版文件回退 history.db 只读提示（秒级精度，ADR 0004）。审批提示不落盘，等待人审阅保持未知；history.db/agent.db 仅作辅助证据，绝不写库。",
  },
  {
    agent: "Antigravity",
    status: "只读导入 · 事件流三态切分",
    supported: true,
    note: "读取 brain/<会话>/.system_generated/logs/transcript.jsonl 事件流；ask_question 阻断计入等待人审阅，后台任务按完成标记计入工具执行。仅导入携带 transcript.jsonl 的会话，标题与项目来自 conversation_summaries.db 富化。",
  },
];
