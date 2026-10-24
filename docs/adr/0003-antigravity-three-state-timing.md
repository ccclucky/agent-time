# ADR 0003: Antigravity 事件流三态耗时切分

日期：2026-10-24 · 状态：已采纳 · 关联：issue #9、ADR 0002（Codex 口径）、ADR 0001（三态总纲）

## 背景

Antigravity（Google IDE）在 `~/.gemini/antigravity/` 下维护运行轨迹：全局索引为
SQLite 库 `conversation_summaries.db`，每个会话的原子事件流为
`brain/<conversation-id>/.system_generated/logs/transcript.jsonl`。
issue #9 撰写时假定的字段名与真实语料有出入，本 ADR 以 2026-10 本机真实样本
（12 份 transcript.jsonl，约 3.2k 条记录）一手验证后的口径为准。

## 记录词汇（实测）

- `source`: `USER_EXPLICIT` | `MODEL` | `SYSTEM`
- `type`: `USER_INPUT` | `PLANNER_RESPONSE` | `GENERIC` | `SYSTEM_MESSAGE` | `ERROR_MESSAGE` | `CHECKPOINT`
- `PLANNER_RESPONSE` 携带**明文** `thinking`、`tool_calls[{name,args}]` 与每次请求的
  token 计数（`input_tokens` / `cache_read_tokens` / `output_tokens`，为逐请求直读值，
  非累计快照 → 轮次用量为直读求和，禁做差分）。
- `GENERIC` 承载工具结果文本；其 `created_at` 为结果落盘时刻——对 `ask_question`
  恰为用户作答时刻。
- 事件记录不携带模型名：`models[]` 与分桶中的模型维度对 Antigravity 如实留空。

## 决策

1. **主源单通道**：仅注册 `transcript.jsonl`；`transcript_full.jsonl`（本地实测同记录集）
   在发现层拒绝（`isSessionFile` 按文件名钉住），防重复导入与口径分裂。
2. **事件映射**：`USER_INPUT → start`；`PLANNER_RESPONSE.tool_calls → tool_use`；
   配对结果 `GENERIC → tool_result`；轮末最后一条模型活动记录 → `complete`
   （惰性完成锚点，同 ADR 0002 校准思路）；轮末 `ERROR_MESSAGE` 无重试 → `fail`；
   `CHECKPOINT` 为压缩续跑标记，计时中立。
3. **等待人审阅**：`ask_question` 调用 → `review_wait_start`，其结果记录 →
   `review_wait_end`。因结果在用户作答时才落盘，等待区间完整落在轮次内，
   与下一轮 `standby_ms` 无双计；共享 `calculateEventTiming` 会从工具时长中
   净除该区间，不会重复计入工具执行。
4. **后台任务**：「Tool is running as a background task with task id: …」回执将
   `tool_result` 延迟到报告任务 finished/cancelled 的记录（`SYSTEM_MESSAGE`
   完成回执），完整并行执行计为工具耗时（同 ADR 0002 规则 7 的归并思路）；
   记录结束仍未完成的任务不计时长并出具 issue（不编造）。
5. **Subagent 拓扑（实测语义）**：`invoke_subagent` 的结果为「Created the
   following subagent: {conversationId: …}」——subagent 是**独立子会话**，
   其 transcript 无 `USER_INPUT`，以首条记录合成轮起点并出具 issue，子会话
   的机时在其自身会话内实测。父会话侧将该工具对以 `agent_id = 子会话 ID`
   打标，复用 `groupSubagents` 呈现派生关系（父侧跨度仅覆盖 spawn，累计
   耗时下钻落在子会话自身）。`manage_task` 等进程内后台命令不是 subagent，
   不打标。
6. **标题与项目富化**：复用 ADR 0002 §9 单通道模式——`conversation_summaries.db`
   （只读打开）提供 title 与 workspace 派生项目名，每次导入重算，索引行消失即清空。
7. **发现范围**：仅导入携带 `transcript.jsonl` 的会话；仅存于 `.pb` / 索引库的
   历史会话不可解析，不导入、不推测。
8. **计时器复用**：Antigravity 走共享 `calculateEventTiming`（墙钟扣减），
   与 Claude Code / Codex 同链路。

## 后果

- 三态与 Token 证据全部来自一手记录，不可得处留空并出具诚实 issue（禁裸 0、禁编造）。
- 简单正文记录（如 `PLANNER_RESPONSE` 无工具调用）不构成完成信号（实测存在
  后台任务轮询记录），完成锚点必须取轮末最后一条模型活动记录。
- 上游未公开目录规范：`RULES.antigravity.evidence` 留空（UI 不显示「已验证出处」），
  位置规则以本机实测为准并在 note 中注明。
- **等待人审阅的唯一形态**：本机语料中 `ask_question` 是唯一的用户决策阻断；
  plan 审批等其他形态若上游未来出现，将按工具执行计入并在本 ADR 修订。
- **FIFO 配对限制**：结果记录不带 call id，同一轮内并行工具的结果按 FIFO
  配对——乱序时单工具时长可能张冠李戴，但轮内总计恒等；事件流与转写抽屉
  共用同一 `ToolPairer`，两端口径不会漂移（有逐项一致性测试钉住）。
- **发现与索引的关系**：会话发现走文件系统（`brain/**/transcript.jsonl`），
  `conversation_summaries.db` 只做 title/project 富化。索引库中的 109 个会话
  里多数仅存 `.pb` 快照、无 transcript.jsonl，注册它们只会制造零事件空会话；
  spec「从 db 检索全局会话列表」以「可解析才导入」的诚实口径落地。
