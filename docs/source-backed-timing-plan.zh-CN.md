# AgentTime 时间统计修正方案：源码核对

核对日期：2026-10-21。本轮是设计审计，尚未实现下述修正，也未验证用户本机的 Windows 日志。此前合成测试证明了所写解析规则能通过自建案例，不能据此证明规则符合真实产品行为。当前页面中的历史处理耗时仍待复核。

## 结论

公开源码和已有开源应用足以指导正确的数据架构，不必先让用户提供整份历史。用户的少量脱敏样本用于验证具体版本、Windows 路径及异常案例，是兼容性验证的一步，而不是研究官方契约的替代品。

目前最重要的修正是停止把不同语义的时间合并进一个 `processing_ms`：Codex 的执行起止、Claude 的消息落盘跨度、原生 API 耗时不是同一指标。UI 写出限制不足以使这个总和变成可信的执行时间。

## 核实的来源及可借鉴之处

### 1. Claude 官方 SDK：区分模型响应与用户任务完成

官方发布包 `@anthropic-ai/claude-agent-sdk@0.3.306` 的 [sdk.d.ts](https://cdn.jsdelivr.net/npm/@anthropic-ai/claude-agent-sdk@0.3.306/sdk.d.ts) 将 `SDKResultMessage` 描述为一轮的完成信号，指出一轮之后仍可能出现 informational system 消息；`SDKResultSuccess` 带 `duration_ms`、`duration_api_ms`、`user_message_uuid` / `user_message_uuids` 等字段。排队输入可能合并，不能把结果条数或 `num_turns` 直接解释成用户提问条数。

`stop_reason: end_turn` 属于助手/模型响应层，不能独立替代这个任务级契约。现有 Claude 适配器据此直接关闭用户轮次，证据不足，应修正。SDK 流、交互式 CLI transcript、statusline 输入是不同的数据面；SDK 有某字段不代表历史 JSONL 必然保存它。duration 字段的累计/单轮口径也应按具体通道和版本确认，不能从别的累计字段类推。

官方 Python SDK `dd27b703647a4f8989ab656f00c85f98090a60fd` 的 [sessions.py](https://github.com/anthropics/claude-agent-sdk-python/blob/dd27b703647a4f8989ab656f00c85f98090a60fd/src/claude_agent_sdk/_internal/sessions.py) 与 [测试](https://github.com/anthropics/claude-agent-sdk-python/blob/dd27b703647a4f8989ab656f00c85f98090a60fd/tests/test_sessions.py) 说明：

- uuid / parentUuid 构成历史图；不能仅按文件顺序配对消息。
- 平行工具调用会形成多个父子分支，工具结果还可能需要补回；有分支不等于记录损坏。
- isSidechain、teamName、isMeta 等会影响主会话选择。

官方 SDK 的“当前对话链”适合恢复上下文，但不等于完整的执行时间账本：被回滚或舍弃的分支也可能曾真实执行过。AgentTime 应按执行发生身份去重、保留已发生工作，而不是把当前分支以外的时间全部抹掉。

官方 hooks 插件说明见 [hook-development](https://github.com/anthropics/claude-code/blob/d014fc0fa64280540728772fc84063918ed185cc/plugins/plugin-dev/skills/hook-development/SKILL.md)。其中 Stop 可以被 hook 阻止并继续，因此“收到一次 Stop”也不能不经验证就视为最终完成。完整官方网页文档本环境返回 403，未确认的审批恢复边界仍保留未知。

### 2. ccstatusline：原生计时与日志回退分开看

核对版本 `bed850187783904a9affcaba1dd80e967622e70b`：

- [StatusJSON.ts](https://github.com/sirmalloc/ccstatusline/blob/bed850187783904a9affcaba1dd80e967622e70b/src/types/StatusJSON.ts) 分开读取 `cost.total_duration_ms` 与 `cost.total_api_duration_ms`。
- [SessionClock.ts](https://github.com/sirmalloc/ccstatusline/blob/bed850187783904a9affcaba1dd80e967622e70b/src/widgets/SessionClock.ts) 优先使用原生 `total_duration_ms`，缺失时才使用 transcript 的 sessionDuration。
- [jsonl-metrics.ts](https://github.com/sirmalloc/ccstatusline/blob/bed850187783904a9affcaba1dd80e967622e70b/src/utils/jsonl-metrics.ts) 的 sessionDuration 是首末记录跨度；speed collector 从最近一条 user 记录到 assistant 记录建立区间，再合并区间。

这些是可检查的实现，不是它们测得纯 Agent 工作的证明。特别是 user 记录可能是工具结果，消息时间戳也不是完整请求计时。AgentTime 可以借鉴原生字段读取、流式解析与区间并集，不能把这些日志回退算法直接改名为精确执行时间。

### 3. ccusage：借鉴去重与适配，不照搬时间含义

核对版本 `f49593cf48061f5c0d24977c29df5b34d90aa880`：

- [Claude loader / dedupe](https://github.com/ryoppippi/ccusage/blob/f49593cf48061f5c0d24977c29df5b34d90aa880/rust/adapters/claude/src/lib.rs) 组合 message ID、request ID、session 和时间戳处理重复与 sidechain 回放，不是简单按文件累加。
- [Codex replay](https://github.com/ryoppippi/ccusage/blob/f49593cf48061f5c0d24977c29df5b34d90aa880/rust/adapters/codex/src/replay.rs) 单独处理历史回放。
- [Pi parser](https://github.com/ryoppippi/ccusage/blob/f49593cf48061f5c0d24977c29df5b34d90aa880/rust/adapters/pi/src/parser.rs) 解析 id / parentId 和 parentSession，区分线性历史、活跃路径及继承前缀。

其主要目标是 token / cost 统计。计费窗口（例如五小时窗口）、消息数和会话跨度都不能当成 AgentTime 的执行时长。应借鉴它的格式适配和防重复思路，而非把计费报告解释成时间账本。

### 4. Codex：已有执行事件，但必须处理历史继承

版本 `c7234c1174b27d9c55199fba0d546dc27d1b0415` 的 [protocol.rs](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/protocol/src/protocol.rs)：

- task_started / turn_started 是同类执行开始事件，task_complete / turn_complete 是完成事件；不是任意相邻的用户/助手消息。
- SessionSource 还包括 MCP、Custom、Internal、SubAgent；未知来源不能和子 Agent 混成一条原因。
- SessionMeta 有 forked_from_id、history_base、history_mode、subagent_history_start_ordinal 等继承信息。

当前统一拒绝分支、分页、子 Agent 虽能避免部分重复，却会漏掉合法活动。应升级为按版本识别来源、解析继承范围、只排除无法归属的片段。来源不兼容、主动排除的子任务和真正的 I/O/解析错误须分开计数；尚未验证的来源不能为减少报错而全部放行。

原有 [rollout policy](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/rollout/src/policy.rs) 仍约束可从历史恢复的事件范围：缺少审批恢复配对就不能拆出人工等待。

### 5. Pi / Oh-My-Pi：不是名字相近就能用同一结束边界

Pi `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`：

- [types.ts](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/types.ts) 明确 AssistantMessage.timestamp 是请求开始；durationMs 可选，不能把 timestamp 当响应完成。
- [session-manager.ts](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts) 的 entry.timestamp 是追加记录时写入的时间，属于另一种时间语义。
- [extensions.md](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/extensions.md) 明确 `agent_end` 之后可能重试、恢复、压缩或执行排队消息；`agent_settled` 才表示没有剩余自动继续。`turn_end` 是模型响应及其工具层面的边界，不等于一次用户任务完成。

Oh-My-Pi `d5cd750e41fede277f9eb933455da92a0738915e` 的 [types.ts](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/ai/src/types.ts) 提供可选 completedAt（本地流式完成时间）与 duration。其 [session-entries.ts](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/coding-agent/src/session/session-entries.ts) 还包含 activeLeafId、model_usage 等；后台模型用量不是新的用户交互，最后写入记录也不一定是活跃叶节点。

因此优先做版本化事件适配；只有消息记录时提供明确标注的有限指标，不假定完整任务边界。

### 6. OpenCode：可直接核实数据库，不必先猜 JSONL

稳定旧版 `v1.2.0` 对应提交 `ffc000de8e446c63d41a2e352d119d9ff43530d0`：

- [session.sql.ts](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/session/session.sql.ts) 是 session / message / part。
- [message-v2.ts](https://github.com/anomalyco/opencode/blob/ffc000de8e446c63d41a2e352d119d9ff43530d0/packages/opencode/src/session/message-v2.ts) 有 user.time.created、assistant.time.completed、parentID 和 finish。

新版本 `4d5965762ec5e0d1a0b14630553fc62b51a11fba`：

- [sql.ts](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/session/sql.ts) 已改为 session_v2 / session_message。
- [session-message.ts](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/schema/src/session-message.ts) 区分 created、streamed（provider body 结束，工具尚未 settle）、completed。
- [transfer.ts](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/core/src/session/transfer.ts) 的官方导出是 `{info, messages}`，不能把其所有版本当成同一种 message/part 包装。

应只读探测已知 schema，或解析官方导出；不要启动工具服务、不读凭据、不静默迁移源数据库。模型步骤完成仍须结合 finish、后续工具和会话状态判断，不能每个 assistant 都独立算用户轮次。

### 7. Antigravity：尚不足以承诺适配

本环境访问官方文档返回 403，目前没有验证其 IDE 历史与执行事件的稳定契约。不能拿账号切换器、代理请求耗时、另一个同名 CLI 的日志当作 IDE 任务执行时间。保持“待验证”，后续以可靠的官方导出、受支持事件或脱敏样本确认格式。

## 应采用的统计模型

每个测量结果独立记录：指标名、数据来源与工具版本、适配器版本、原始事件关联 ID、起止时间（若确实存在）、来源直接提供的时长（若有）、状态与未知原因、审批事件覆盖情况。

必须区分：

| 类别 | 可以表达什么 | 不允许做什么 |
| --- | --- | --- |
| 可验证的任务执行区间 | 起止事件之间的经过时间，等待覆盖情况另列 | 无审批配对时称为纯工作 |
| 来源自报的任务/API耗时 | 该工具按自身契约报告的计时值 | 仅凭 duration 反推精确起点、计算跨工具并集或精确按天裁剪 |
| 消息记录跨度 | 两条已关联记录之间的时间差 | 混进任务执行总量，或称为真实等待 |
| 会话总跨度/活动记录 | 会话上下文及日志覆盖情况 | 当成累计执行时间 |
| 缺失或冲突 | 不可用的原因和受影响记录数 | 填 0、把最后消息当结束、用任意时长上限把大数字变小 |

只有口径一致的数值才能汇总。跨工具的共同指标未建立前，先提供分工具总额和覆盖情况；用户仍可展开来源区间、原始时间戳与异常记录。平台自报累计计数器需识别进程/计数 epoch、恢复和清零；不能把每次采样的累计值相加。只有确认该通道的单调累计契约后才计算增量，采样区间跨天的增量也不等于已知其具体发生在哪一天。

人工介入必须有可关联的请求/恢复证据。`任务总时长 - API耗时` 不等于人工等待，因为还含工具执行、排队、重试、退避、hooks 和本地处理。并行工具和子 Agent 应区分父任务包含的总跨度与子执行的独立用时，禁止把包含关系中的父子区间直接相加冒充纯工作总量。

## 实施顺序与验收

1. 保存当前导入结果为待复核版本，不破坏原文件、不静默修改历史数据；为新算法版本重建可回滚的统计快照。
2. 分离计时类别及其汇总，纠正 Claude 用户任务结束判定；细分 Codex / Claude 的拒绝与跳过原因。
3. 将上游现有 fixtures、版本差异和真实脱敏样本作为回归依据。先完整解释一个异常会话的每轮起止及 14h36m 的组成，再扩展适配器。
4. 处理恢复/排队/中断/重试、工具并行、继承/回放、分支及回滚；补跨日与三路重叠复算。
5. 历史不足的工具提供可选实时采集路径（受支持事件、SDK、statusline 或扩展），逐个验证事件语义。历史导入与实时采集分开标注；不自动覆写用户现有 hooks/statusline，也不要求用户改用另一套 Agent。
6. 所有主指标都能从界面下钻到事件依据；同一来源重复导入不变，继承上下文不重复，长间隔不自动变成工作或被静默截断。公开证据不足的工具仍明确标记待验证。

这轮只落实调研文档。真实样本仍有价值，但不再把它当作开始源码分析的前提；后续实现围绕上述契约进行，不能先启用按钮再用免责声明代替测量正确性。
