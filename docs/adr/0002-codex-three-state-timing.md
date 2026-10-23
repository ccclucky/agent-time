# 0002. Codex 事件流三态切分契约

## 状态 (Status)
accepted (2026-10-24)

## 决策背景 (Context)
Codex 本地会话（`~/.codex/sessions/**/*.jsonl.zst`，本机 799 文件、104,211 行全量实测）的轮次边界与工具轨迹和 Claude Code 事件流形态不同：`task_complete` 行时间戳是惰性落盘（与下一条用户消息同毫秒，含人工间隔），`turn_context`/`response_item`/`token_count` 行均无 `turn_id`，且本地语料不存在任何审批类事件（`exec_command_begin/end`、`*_approval_request`、`approval_decision`、`elicitation` 全量 0 命中）。若直接沿用"起止事件相减"的粗跨度，用户阅读/思考时间会被误计为 AI 工作耗时。

## 架构决策 (Decision)

事件映射契约（探索笔记 `/Users/cclucky/.zcode/explorations/agent-time-spec-5/03-three-state-mapping.md` 全量证据支持）：

| Codex 记录 | Event kind | at_ms | 归因规则 |
| --- | --- | --- | --- |
| `event_msg/task_started` | `start` | 行 timestamp | `payload.turn_id` |
| `event_msg/task_complete`（error==null） | `complete` | **item_completed 完成锚点校准**（见下） | 同上 |
| `event_msg/task_complete`（error!=null） | `fail` | 行 timestamp | 同上 |
| `event_msg/turn_aborted` | `abort` | 行 timestamp | 同上 |
| `turn_context`（每轮首条） | `model` | 行 timestamp | 最近一次 task_started（实测 99.1% 一致） |
| `response_item/function_call`、`custom_tool_call` | `tool_use` | 行 timestamp | 最近一次 task_started 窗口 |
| `response_item/function_call_output`、`custom_tool_call_output` | `tool_result` | 行 timestamp | 同上；`tool_id`=`call_id` 精确配对 |
| `event_msg/item_completed` | 不入库 | — | 仅作完成锚点与惰性时间戳校准 |
| `event_msg/token_count` | 不入库（差分为 Token 统计） | — | 最近一次 task_started |

关键规则：

1. **惰性完成时间戳校准（完成锚点）**：CLI/旧版写入器把 `task_complete` 滞留到下一条用户消息时刻落盘（实测同毫秒），其行时间戳含人工间隔。`complete` 的 `at_ms` 采用轮内最后一个非 UserMessage `item_completed.completed_at_ms`（锚点越界时回退行时间戳），使 elapsed/work 纯净，`standby_ms`（现有 prevEnd→currStart 逻辑）自动变为"用户阅读+思考"间隔。
2. **工具配对**：与 Claude Code 完全同构，按 `call_id` 配对 `tool_use/tool_result`，直接复用共享的 `calculateEventTiming`；未闭合 output 按 0 时长处理（本地实测 93 条未闭合）。
3. **review_wait 如实为 0**：本地 799 文件 0 条审批/elicitation 事件，不得发明等待人工耗时；issues 明示"等待人审阅未单独计量"（术语对齐 GLOSSARY 的 等待人审阅 (Review Wait)）。人机间隔全部计入 standby。
4. **外部导入轮次排除**：`turn_id` 前缀 `external-import-turn-`（本机 238 文件、5,836 条）的行时间戳是导入瞬间而非真实对话时刻，这些轮不生成计时事件（Token 统计保留），issues 明示。
5. **Token 快照差分**：`token_count.info.total_token_usage` 是会话累计快照（重复 `last_token_usage` 行实测 2,994 对，求和会翻倍），轮用量 = 轮末快照 − 前轮末快照，各轮差分之和精确等于会话最后快照（本机实测逐文件核对一致）。
6. **三态启用**：`store.sessions()` 的三态切分条件从仅 Claude Code 放宽到 Codex；无审批事件时共享算法自然退化为 `work = elapsed − tool`、`review_wait = 0`。
7. **分页历史放行**：`history_mode` 为 `paginated`（或 `legacy`/缺省）的本地会话正常导入。依据：本机 799/799 文件全部标注 `paginated`，它是本地写入器的常态而非可疑来源；被拒绝的是 `forked_from_id`/`parent_thread_id`/`history_base`/`subagent_history_start_ordinal` 这类分支继承与子代理来源，以及远程/云 originator 与回滚记录。 2026-10-24 实证（本机全量 52 个带 `parent_thread_id`/`subagent_history_start_ordinal` 标记的文件）：全部为分叉时刻的父会话历史快照——分叉点序号之后自有工作事件为 0，分叉点之前内容与父文件逐字相同（抽查 183/183 工具调用参数逐字命中），且复制记录的时间戳被改写为分叉瞬间（同一会话 19 轮 task_started 挤在同一毫秒）。子 Agent 的并行机时由父会话文件中的 `spawn_agent` 工具调用如实计入，故这些快照导入只会双计或产生同毫秒幽灵轮次。若未来 Codex 改为在子文件自有区段落盘真实事件，接入方式为：仅解析 `subagent_history_start_ordinal` 之后的区段并按 `agent_id` 归属父会话（`groupSubagents` 聚合通道已就绪）。
8. **流式 zstd 解码**：`.jsonl.zst` 通过 `zlib.createZstdDecompress` 流式解压逐行供给解析器，不再整缓冲 `zstdDecompressSync`——512 MiB 压缩上限挡不住高压缩比文件解压出数 GiB 的 RSS 膨胀。保留 16 MiB 单行上限与严格 UTF-8 解码，另设 2 GiB 累计解压上限（超出按 ValidationError 拒绝），防 zip-bomb 式输入。解压失败（`ERR_ZSTD*`/`ZSTD_error*`）保持清晰的 ValidationError；本功能要求 Node 22.15+/23.8+ 内建 zstd。
9. **session_index 时效语义**：`updated_at` 是线程最近一次命名/改名时刻。索引内同一 `id` 出现多行时按 `updated_at` **最新者胜**（此前是末行胜）；它只做重复行的裁决依据，**不是**陈旧度截断——线程仍被索引收录时主题永不因行序靠前而丢失。主题在每次导入时重算：索引条目被删除 → 主题清空为 null（不留旧名）。索引按配置根在一次 refresh 内只读入解析一次（每根一个小缓存），而非每个文件重读一次。

## 产生的影响与后果
- Codex 会话获得与 Claude Code 同口径的三态耗时（纯工作/等待人审阅/待命）与工具执行明细，`elapsed` 与 Codex 自身 `duration_ms` 对齐的同时不再把人工间隔误计为工作时间。
- 全量静默冒烟（`npm run smoke:codex`）成为发布验收门：本机 799 文件 0 解析失败（89 有效导入 / 420 纯元数据空壳 / 238 外部导入会话 / 52 子代理等来源排除）。冒烟按稳定判别器分类（`ExcludedSessionError` 子类与 `external_import_only` 标志），不匹配中文文案，文案可自由改写。
- `.jsonl.zst` 导入内存占用与解压后体积解耦（流式逐行），同时受 2 GiB 累计解压上限保护；`parse()`/`Store.importFile`/`Store.refresh` 由此转为异步。
- 完成锚点依赖 `item_completed` 行持续存在；未来 Codex 变更 rollout 格式时需重新全量实测（复跑探索脚本）后再调整本契约。
