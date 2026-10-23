# Agent 效能与耗时度量 (Agent Performance & Timing)

度量本地 AI Coding Agent（如 Claude Code、Codex）会话执行效率、能效比与人机协同开销的领域模型术语。

## 术语表 (Language)

**等待人审阅 (Review Wait)**:
Agent 触发工具权限申请（如执行命令、写文件）或需要确认时，挂起自身执行、等待人类审阅并点击授权的时长。
_Avoid_: 人工等待, 用户等待, 确认等待

**纯工作耗时 (Active Work Duration)**:
Agent 处于活跃工作状态的物理执行时间，由模型 API 生成推理耗时与本地工具实际运行耗时相加构成。
_Avoid_: 墙钟耗时, 任务总跨度

**模型推理耗时 (Model API Duration)**:
Agent 构造 Prompt 发往大模型 API 至接收完整返回（或流式结束）的纯网络与生成耗时。
_Avoid_: 执行耗时, 处理耗时

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

