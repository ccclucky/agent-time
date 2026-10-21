# 本地 Agent 数据源调研与首批适配

调研日期：2026-10-21。依据公开源码和文档；本环境没有用户本机的六种工具历史记录，不能把源码检查等同于实机兼容性验证。源码版本会变化，下列结论绑定所列提交。

## 产品范围

只统计用户选择导入的本地记录。六个独立目标：Codex、Claude Code、Antigravity、OpenCode、Pi、Oh-My-Pi。浏览器界面、本地计算、本地 SQLite，不需要云账号。不得把子 Agent 的模型循环直接当作新的一轮用户交互。

## 调研结果

| 工具 | 可验证来源 | 可以确认 | 重要限制 | 首批安排 |
| --- | --- | --- | --- | --- |
| Codex | 本地 rollout JSONL 的 session_meta、event_msg、turn_context | task_started/task_complete（亦接受 turn_started/turn_complete）带轮次 ID；可获得执行开始、完成、终止、模型上下文 | 持久化策略明确排除审批、请求权限和请求补充信息事件；缺少它们不能断言无等待。开始执行不是精确用户提交时间。分支、回滚和子 Agent 需要独立处理 | 第一条真实导入链路，显示已记录处理耗时；纯工作与确认等待保持不可用 |
| Claude Code | 官方仓库的 hooks 示例与变更日志 | UserPromptSubmit、Stop、PermissionRequest、PostToolUse 等事件存在 | Stop hooks 可阻止停止并继续执行；PostToolUse 在工具完成后，不能当成用户授权恢复时刻。官方完整 hooks 文档当前被环境代理拒绝，尚未验证完整恢复事件契约 | 第二阶段继续确认 hooks 语义及持久化格式，不凭消息相邻时间伪造纯工作 |
| OpenCode | session/sql.ts、session-message.ts、permission.ts、导出命令 | 结构化 SQLite 消息、创建/完成时间；官方会话导出；模型和用量字段 | 当前源码已为 session_v2，并非旧版 message/part 表。permission.asked/replied 是 ephemeral，不能默认可从历史数据库完整恢复；消息完成不一定等于一次用户交互的最终结束 | 按版本适配官方导出优先，不直接修改其数据库 |
| Pi | 会话管理器、消息类型、扩展事件文档 | ~/.pi/agent/sessions 下 JSONL；session/message/model_change，树形 parentId；消息落盘时间与模型请求时间分别存在 | AssistantMessage.timestamp 是模型请求开始时间，durationMs 可选；turn 是模型循环。agent_end 后还可能重试、整理或继续，当前有 agent_settled。记录写入时间也不能无条件认作用户可见答复完成 | 第三阶段验证扩展采集；历史文件仅输出有证据的指标 |
| Oh-My-Pi | 独立仓库的 session-entries.ts、session-storage.ts、AI types、utils/dirs.ts | 默认 ~/.omp/agent/sessions；支持 profiles/XDG 路径；JSONL 有 parentId；助手可有 completedAt、duration | completedAt 可选；重试、排队、子任务和分支处理需要独立测试；不能当 Pi 的同名兼容适配器 | 与 Pi 分别版本化，先验证 completedAt 和用户交互边界 |
| Antigravity | 尚未获得可验证的公开持久化契约 | 用户将其列为本地目标 | 官方文档域名请求被代理拒绝；本轮没有可靠证据确认稳定日志/导出格式。不逆向猜测数据库字段，不读取凭据或通过私有接口绕过权限 | 标记待验证，不声称支持 |

路径是源码中的默认值，不是保证；自定义目录与环境变量需后续明确支持。本机文件所在位置也不能单独证明会话在本机执行。首批 Codex 只接受已识别的客户端来源，排除明确 cloud、子 Agent、fork、rollback、分页继承记录；未知来源不自动纳入。手动复制到本机的其他来源仍须由用户确认；无法从日志独立证明物理机器身份。

## 核心依据

- Codex commit `c7234c1174b27d9c55199fba0d546dc27d1b0415`：
  - [事件与来源定义](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/protocol/src/protocol.rs)
  - [持久化事件白名单](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/rollout/src/policy.rs)
- Claude Code commit `d014fc0fa64280540728772fc84063918ed185cc`：
  - [变更日志](https://github.com/anthropics/claude-code/blob/d014fc0fa64280540728772fc84063918ed185cc/CHANGELOG.md)
  - [官方插件 hooks 说明](https://github.com/anthropics/claude-code/tree/d014fc0fa64280540728772fc84063918ed185cc/plugins/plugin-dev/skills/hook-development)
- OpenCode commit `a2cb1c4e7f7dfff5de7a17b96a12e78b6799ebcb`：
  - [会话表结构](https://github.com/anomalyco/opencode/blob/a2cb1c4e7f7dfff5de7a17b96a12e78b6799ebcb/packages/core/src/session/sql.ts)
  - [消息时间字段](https://github.com/anomalyco/opencode/blob/a2cb1c4e7f7dfff5de7a17b96a12e78b6799ebcb/packages/schema/src/session-message.ts)
  - [授权事件](https://github.com/anomalyco/opencode/blob/a2cb1c4e7f7dfff5de7a17b96a12e78b6799ebcb/packages/schema/src/permission.ts)
  - [导出命令](https://github.com/anomalyco/opencode/blob/a2cb1c4e7f7dfff5de7a17b96a12e78b6799ebcb/packages/cli/src/commands/handlers/session/export.ts)
- Pi commit `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`（原仓库路径可能重定向）：
  - [会话管理](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts)
  - [消息类型](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/ai/src/types.ts)
  - [扩展生命周期](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/docs/extensions.md)
- Oh-My-Pi commit `d5cd750e41fede277f9eb933455da92a0738915e`：
  - [会话条目](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/coding-agent/src/session/session-entries.ts)
  - [消息类型](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/ai/src/types.ts)
  - [目录定义](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/utils/src/dirs.ts)

## 首批 MVP 的工程选择

Python 3.11+ 标准库 + SQLite + 本地 HTML/CSS/JavaScript。选择理由：只读解析 JSONL、可靠日期计算和本地存储无需服务依赖；无需构建前端即可安装运行。此为首批实现选择，替代此前“技术栈待定”，不表示桌面封装或未来适配器受此限制。

先完成：显式导入 Codex 文件/目录 → 严格元数据筛选 → SQLite 去重 → 本地网页汇总 → 会话 → 每轮事件。浏览器现在可以在“配置与接入”中保存工具根目录并启用 Codex；同步仅查找已配置的 sessions 和 archived_sessions 子目录，同时刷新 CLI 显式导入的来源。不能通过同步接口任意读取文件。纯工作、确认等待、Token 和费用不因缺少数据而记为零。不会自动写入任何 Agent 配置或注册 hooks。

暂缓：其他五种适配器、后台常驻采集、分支与子 Agent 归属、Token/费用、跨模型精确拆分、打包安装器。先验证真实边界和安全本地闭环，再扩大支持面。
