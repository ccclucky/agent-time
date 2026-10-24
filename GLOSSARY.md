# Agent 效能与耗时度量 (Agent Performance & Timing)

度量本地 AI Coding Agent（如 Claude Code、Codex）会话执行效率、能效比与人机协同开销的领域模型术语。

## 术语表 (Language)

**等待人审阅 (Review Wait)**:
Agent 触发工具权限申请（如执行命令、写文件）或需要确认时，挂起自身执行、等待人类审阅并点击授权的时长。
_Avoid_: 人工等待, 用户等待, 确认等待

**纯工作耗时 (Active Work Duration)**:
Agent 处于活跃工作状态的物理执行时间，由模型 API 生成推理耗时与本地工具实际运行耗时相加构成。
_Avoid_: 墙钟耗时, 任务总跨度

**自动化自治率 (Autonomy Rate)**:
会话维度的自动化程度指标：纯工作耗时 ÷ (纯工作耗时 + 等待人审阅) × 100%，衡量 Agent 无需人工授权卡点即可自主推进工作的占比。人工确认卡点次数按成对闭合的 review_wait_start/end 事件计数（仅 Claude 落盘；Codex 会话不提供三态切分，该指标如实留空而非推算）。
_Avoid_: 自主率, 自动化率, AI 占比

**慢操作瓶颈数 (Slow Operation Count)**:
会话内单次工具调用耗时超过 15 秒（15000ms）的调用次数，按 tool_use ↔ tool_result 事件配对在客户端核算，剔除与等待人审阅重叠的时间。
_Avoid_: 卡顿次数, 超时数

**模型推理耗时 (Model API Duration)**:
Agent 构造 Prompt 发往大模型 API 至接收完整返回（或流式结束）的纯网络与生成耗时。
_Avoid_: 执行耗时, 处理耗时

**思考等级 (Thinking Level)**:
assistant 响应请求的推理深度档位（off/low/medium/high）。
_Avoid_: 思考模式, 推理等级

**工具执行耗时 (Tool Execution Duration)**:
Agent 发出工具调用指令至本地操作系统或环境返回执行结果（`tool_result`）的纯系统执行耗时。
_Avoid_: 外部耗时

**待命时长 (Standby Duration)**:
上一轮 Agent 答复交割完毕至人类下达下一条任务之间的时间跨度。此期间 Agent 处于零消耗的静默待命状态，终端保持挂载等待人类下一次唤醒。
_Avoid_: 轮次间空闲, 轮次间阅读, 响应间隙, 人工思考时间

**惰性完成时间戳 (Lazy Completion Timestamp)**:
部分 Agent 写入器（如 Codex CLI/旧版）把轮次完成记录滞留到下一条用户消息落盘时才写出，导致完成行时间戳包含人工阅读与思考间隔，不能直接当作 Agent 真正干完的时刻。
_Avoid_: 完成时刻, 结束时间戳

**完成锚点 (Completion Anchor)**:
轮内最后一个非用户消息内容项的完成时刻（如 Codex 的 `item_completed.completed_at_ms`），用于校准惰性完成时间戳，还原 Agent 真正答完的边界。
_Avoid_: 结束锚点, 答复时间

**外部导入轮次 (External-Import Turn)**:
从其他 Agent 会话导入的历史轮次（turn_id 带 `external-import-turn-` 前缀）。其行时间戳是导入瞬间而非真实对话时刻，不参与耗时计量；Token 累计快照仍然真实有效。
_Avoid_: 导入会话, 迁移轮次

**Token 用量（快照差分） (Token Usage by Snapshot Diff)**:
基于源记录中的会话级累计 Token 快照，按"轮末快照减去前轮末快照"差分得到的轮次用量；各轮差分之和精确等于会话最后快照。缺失快照时不计入，绝不以 0 冒充。
_Avoid_: Token 求和, 单次响应用量

**Token 用量（逐请求合计） (Token Usage by Per-Request Sum)**:
DSH 与 OpenCode 的轮次用量口径：assistant 每条记录自带本次请求的真实用量（实测 inputTokens/outputTokens 逐请求重置，非累计快照；OpenCode 的 total 字段恒等于分量之和，亦非累计），轮次用量为其在轮内各步的合计。与「快照差分」是来源不同的两种计量口径，禁止互相套用；reasoning 用量源中不存在时记 0 而非推断。
_Avoid_: 快照差分（用于 DSH/OpenCode）, Token 累计快照（用于 DSH/OpenCode）

**ask_question 阻断 (Antigravity Review Wait)**:
Antigravity 以 `ask_question` 工具调用向用户提问，其结果记录在用户作答时才落盘；调用到结果记录的区间即为等待人审阅，完整落在轮次内，与待命时长不重复计量。
_Avoid_: 提问耗时, 对话框时间

**后台任务完成标记 (Background Task Completion Receipt)**:
Antigravity 把长命令转为进程内后台任务（task id 形如 `<会话 ID>/task-N`），后续以轮询与 `SYSTEM_MESSAGE` 完成回执落盘；工具耗时按完成回执时刻结算，未完成的不计（不编造）。`invoke_subagent` 派生按同机制打 `agent_id` 标供下钻。
_Avoid_: 后台耗时估算, 子任务时长

