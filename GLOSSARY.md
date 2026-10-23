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
