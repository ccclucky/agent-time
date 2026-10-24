# 0004. Oh-My-Pi 会话注册与三态切分契约（DB 源 + 文件 transcript）

## 状态 (Status)
accepted (2026-10-24)

## 决策背景 (Context)
Oh-My-Pi（omp，Pi 的下游发行版，本机版本 18.10.0+）在 `~/.omp/agent/` 下同时存在 SQLite 数据库（`history.db`：用户提示历史；`agent.db`：模型性能与用量的全局聚合）与 `sessions/<编码工作目录>/<uuid>.jsonl` 会话事件流。issue #7 以 DB 为中心描述数据源，直接套用会产生设计缺口：现有 `source` 表以文件路径定位会话、transcript 端点按需重读源文件，而数据库行不是可按需重放的会话流。本机 2 个真实会话（2026-08 全量样本）实测：

- 会话本体是 JSONL 事件流：`session` 头（id/cwd/version=3）、`title`/`title_change`、`model_change`、`thinking_level_change`、`message`（assistant 带 `model/provider/duration/ttft/usage/cost` 一手耗时与逐请求用量；toolResult 带内层 epoch 时间戳；user 角色消息部分文件缺失）、`custom`（`tool_execution_start` 提供 startedAt，`session_exit` 提供退出标记）。
- `history.db.history`（id/prompt/created_at/cwd/session_id）是唯一的用户提示通道；旧版本会话文件（实测 2026-08-13 样本）不落盘 user 消息。issue 提到的 `session_recaps` 表本机 schema 中不存在，以实测为准。
- `agent.db.model_perf/model_usage` 是按 model_key 的全局累计聚合，不携带会话维度，无法参与逐会话切分。
- 本地语料 0 条审批/确认事件（默认 `yolo` 审批模式，审批提示是 UI 层交互，不落盘会话流）。

## 架构决策 (Decision)

1. **会话注册仍以文件路径为单一通道**：`source.path` 注册 `sessions/<slug>/<uuid>.jsonl`。`history.db` / `agent.db` 只作辅助证据（轮次锚点回退、issue 披露），不做数据库行注册。这保持 `GET /api/session/transcript` 按需重读源文件的既有契约不变。适配器只识别 basename 为 `[<时间戳>_]<uuid>.jsonl` 的文件（实测两种命名形态并存），`sessions/<slug>/<uuid>/` 工作区产物（DesignerSpec.jsonl 等）不是会话流， discovery 与 `isSessionFile` 双重排除。
2. **Turn 边界单通道**：文件内 user 消息（毫秒精度）优先；文件未记录 user 消息时回退 `history.db`（`session_id` 精确匹配，`created_at` 为秒级 epoch，锚点精度 ±1s，如实披露）；两者皆缺时整段会话记单轮并出 issue。turn_id：文件锚点用消息 id，DB 锚点用 `db-<created_at>-<序号>`（parse 与 transcript 提取器共用同一锚点算法，保证轮次可对齐）。锚点前悬挂的元数据记录（title/model_change）归入首个轮次。DB 连接一律只读打开；打开失败降级为无 DB 锚点并出 issue，绝不写库。
3. **三态切分复用 `calculatePiTiming`（一手机时累加口径）**：assistant 消息 → `model` 事件（`at_ms`=内层 `message.timestamp` 请求起点，`end_ms`=起点+`duration`，TTFT 字段无对应事件通道不入库）；`tool_execution_start.startedAt` → `tool_result.at_ms`（执行起点），toolResult 内层 timestamp → `end_ms`（结果创建），按 `toolCallId` 配对；无审批事件 → `review_wait_ms` 保持未知（null），审批等待若发生会计入工具执行跨度，与 Pi 同样不猜测、不编造。轮次收束锚点：轮内最后一条 assistant 记录的落盘时间（stop→系统提醒自动续跑不另开新轮）；轮内无 assistant 时以 `session_exit.recordedAt` 兜底收束。
4. **Token 逐请求合计**：`usage` 为每条 assistant 消息一条（实测非累计快照），轮用量 = 轮内各响应之和。字段映射：`input→input_tokens`、`cacheRead→cached_input_tokens`、`cacheWrite→cache_write_input_tokens`、`output→output_tokens`、`reasoningTokens→reasoning_output_tokens`、`totalTokens→total_tokens`。
5. **标题与项目**：标题单通道——`session` 头、`title`、`title_change` 全部候选按时间最新者胜，每次导入重算；项目 = `session.cwd` 末段。会话 id 注册为 `omp/<uuid>`。
6. **分模型效能落既有结构**：`calculatePiTiming` 产出的 `model_api_breakdown`（分模型推理时长）+ 逐轮 Token 下钻即 issue 目标 3 的「分模型效能看板」，落在会话详情页既有 4 KPI + Rollup 结构上，不另起看板形态。逐响应 `usage.cost` 与 `agent.db` 全局成本暂不入库：`TokenUsage` 无成本通道，本版不发明口径；`agent.db` 聚合不含会话维度，无法与耗时曲线关联，列为后续扩展。
7. **Transcript 提取器**：`extractOmpTranscript(path)` 与 parse 共用记录读取与锚点算法，按轮输出 prompt（文件 user 文本或 DB prompt）、thinking（assistant thinking 块）、tool_calls（`intent`/工具名 + startedAt→结果创建的执行时长）；与 Codex 相同仅读纯文本 JSONL，无压缩分流问题。

## 产生的影响与后果
- Oh-My-Pi 会话获得与 Pi 同口径的三态耗时、Token 下钻与分模型 breakdown；DB 锚点轮次的 start 精度为秒级（±1s 内），elapsed/work 的一手机时证据不受影响。
- `history.db` 只读依赖是松耦合：DB 缺失/损坏只降级轮次锚点精度并披露 issue，不阻断导入。
- 若未来 OMP 把审批交互落盘（如 `tool_approval` 类 custom 事件），需复测后按 Codex 的 review_wait 通道接入；本版不预测事件形态。
- 若未来 OMP 修改会话流命名（非 UUID basename）或 DB schema（`history` 表列变更），适配器按未知格式拒绝或降级，不猜测。
