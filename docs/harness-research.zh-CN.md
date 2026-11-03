# 新 Harness 接入调研：Gemini CLI / Cursor / Aider

> Issue #55 的调研结论（2026-11-04）。目的：在写任何解析器之前，先核实每个候选「会话记录格式 + 轮次边界 / 完成锚点 / 三态可判定性」，沿用 ADR 口径纪律——**未证实的不猜测**。
>
> 术语与三态定义见 README「三态耗时模型」；既有接入的口径决策见 [docs/adr](adr/)。

## 总览

| 维度 | Gemini CLI | Cursor | Aider |
| --- | --- | --- | --- |
| 存储 | `~/.gemini/tmp/<项目>/chats/session-*.jsonl` | `globalStorage/state.vscdb`（SQLite）`cursorDiskKV` 表 | `.aider.chat.history.md` + 可选 `.aider.llm.history` |
| 格式 | JSONL append-only，结构化 | SQLite + 明文 JSON blob | 纯 Markdown（仅 llm.history 带逐条时间戳） |
| 轮次边界 | ✅ 可行 | ✅ 可行 | ⚠️ 部分（需开启 llm.history） |
| 工具耗时 | ⚠️ 部分（单时间戳） | ✅ 可行（timingInfo 双时间戳） | ❌ 不可行 |
| 审批事件 | ⚠️ 部分（status 枚举支持，流转落盘未证实） | ❓ 未证实 | ⚠️ 部分（有落盘、无时间戳） |
| Token | ✅ 可行（逐请求） | ⚠️ 部分（字段在但实测常为 0） | ⚠️ 部分（逐轮汇总文本） |
| **三态总体** | **✅ 可行** | **⚠️ 部分可行** | **⚠️ 部分可行（强依赖 llm.history）** |

**建议接入顺序：Gemini CLI → Cursor → Aider**。Gemini CLI 证据链最完整；Cursor 需先解决审批/token 样本不足；Aider 默认配置下三态基本不可判，仅适合「尽力而为 + 如实披露」的接入。

---

## 1. Gemini CLI（google-gemini/gemini-cli）—— 可行

### 存储位置 / 格式

- 现行版本：JSONL，位于 `~/.gemini/tmp/<project-identifier>/chats/session-<timestamp>-<shortId>.jsonl`；subagent 会话嵌套在 `chats/<parentSessionId>/` 子目录。
  依据：`packages/core/src/services/chatRecordingService.ts`（`getProjectTempDir()` + `chats` 目录、`SESSION_FILE_PREFIX` + `.jsonl` 文件名构造）。
- 版本间有变化：旧版为 `~/.gemini/tmp/<hash>/logs.json`（`packages/core/src/core/logger.ts` `LOG_FILE_NAME = 'logs.json'`）；`storage.ts` 存在「legacy hash 目录 → slug 目录」迁移逻辑，项目目录命名方案也改过。JSONL 录制服务自 2025-08 引入。
- 记录类型：`ConversationRecord`（元数据）+ `MessageRecord`（type: `user | info | error | warning | gemini`）+ `MessagePatchRecord`（`$patch` 增量）+ 元数据更新。依据：`packages/core/src/services/chatRecordingTypes.ts`。

### 三态可判定性

- **轮次边界：可行。** 每条 `MessageRecord` 带 `id` + ISO `timestamp`；`user` 与 `gemini` 消息交替，轮次起止均有时戳。
- **工具耗时：部分可行。** `ToolCallRecord` 含 `id/name/args/result/status/timestamp`，随 gemini 消息落盘；结果经 functionResponse 机制 patch 回填。但每条 toolCall 只保留一个 `timestamp` 且按 id 合并时旧时戳被覆盖（`recordToolCalls` merge 逻辑）——开始时间可得，结束时间只能从后续事件时戳推断，须在实现时如实披露精度。
- **审批事件：部分可行（未证实完整）。** 类型系统明确有 `CoreToolCallStatus.AwaitingApproval = 'awaiting_approval'`（`packages/core/src/scheduler/types.ts`），`ToolCallRecord.status` 引用该枚举，即 schema 能表达「等待审批」；但「awaiting_approval 快照 + 批准后快照」是否各留一条带时戳的 JSONL 记录，**未逐帧证实**。
- **Token：可行（逐请求）。** `TokensSummary`（input/output/cached/thoughts/tool/total）随 gemini 消息逐条落盘（`recordMessageTokens` 直取 `GenerateContentResponseUsageMetadata`），非累计快照。

### 结论

三态切分总体可行：work/review_wait 边界靠工具 status（含 awaiting_approval）+ 消息时戳；standby 由相邻消息时差得出。**风险点：审批状态流转的落盘完整性需实机样本取证后再固化解析器**；旧版 `logs.json` 是否兼容，取决于本机是否存在旧格式语料。

### 证据

- [chatRecordingService.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts)
- [chatRecordingTypes.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingTypes.ts)
- [scheduler/types.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/scheduler/types.ts)
- [logger.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/core/logger.ts)、[storage.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/config/storage.ts)

---

## 2. Cursor —— 部分可行

### 存储位置 / 格式

- 全局库：`~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`（Windows/Linux 对应 `%APPDATA%`/`~/.config` 下同构路径），含 `ItemTable`、`composerHeaders`、`cursorDiskKV` 三张表。会话元数据在 `composerData:<uuid>` 键，单条消息在 `bubbleId:<composerId>:<bubbleId>` 键，值为 JSON 文本。**本机（Cursor 3.15.6）一手取证属实。**
- 工作区库：`workspaceStorage/<hash>/state.vscdb` 的 `ItemTable` 存会话 ID 列表（`allComposers` 含 createdAt/mode），与全局库配合定位项目。
- **未加密**：bubble JSON 为明文（text 字段可直接读）；Privacy Mode 只管服务端不上传训练，不加密本地库。本机数据明文可读，多个社区导出工具可正常解析佐证。
- 版本结构：旧版（约 0.4x 前）聊天内嵌在 workspaceStorage 的 `chatSerializedData`/`conversationMap`；新版改为「headers 只存 ID 列表 + bubble 主体拆到 cursorDiskKV」。本机 `composerData` 里 `conversationMap` 为空、`fullConversationHeadersOnly` 指向独立 bubble 行，符合新结构。

### 三态可判定性

- **轮次边界：可行。** `fullConversationHeadersOnly` 为有序数组，`{bubbleId, type}` 中 type=1 用户 / type=2 AI，每个 bubble 有 ISO `createdAt`（本机样本：`type:1 createdAt 2026-01-08T12:02:19.426Z`）。
- **工具耗时：可行。** bubble 含 `timingInfo: {clientRpcSendTime(epoch ms), clientSettleTime, clientEndTime}`（本机一手取证）；执行耗时 = settle/end − send。工具细节在 `toolFormerData`（name/status/args）。注意终端命令没有直接存 duration，需由 timingInfo 推导——本机字段存在即已足够。
- **审批事件：未证实。** 本机 20 条 bubble 样本未见 accept/approve/confirm 字段；代码建议的接受/拒绝有 `userResponsesToSuggestedCodeBlocks`，终端命令 y/n 审批是否落盘、以何字段落盘**未证实**。
- **Token：部分可行（未证实完整性）。** bubble 有 `tokenCount: {inputTokens, outputTokens}`，但本机样本全部为 0（疑似计费/遥测走服务端），落盘形态不稳定。

### 结论

轮次与工具耗时数据质量最好；review_wait 与 token 的落盘字段在本机样本中缺失或为零。**接入前需要更大真实样本取证（尤其审批字段与 tokenCount 非零样本）**，否则三态中「等待确认」只能如实标未知。

### 证据

- 本机 `state.vscdb` 一手取证（Cursor 3.15.6，2026-11-04）
- [Where Does Cursor Store Chat History (vibe-replay)](https://vibe-replay.com/blog/cursor-local-storage)
- [How to find my old cursor chats (Medium)](https://medium.com/@furry_ai_diary/how-to-find-my-old-cursor-chats-a-complete-guide-bea510218c23)
- [state.vscdb 膨胀与 bubbleId（Cursor Forum）](https://forum.cursor.com/t/state-vscdb-grows-to-30gb-due-to-bubbleid-agentkv-entries/167641)
- [Privacy Mode 不加密本地库（Deska）](https://deska.dev/blog/cursor-privacy-mode-explained)、[cursor-chat 导出脚本 Gist](https://gist.github.com/legel/ebd0bbc012bf019a1db5212b825e7d16)

---

## 3. Aider（Aider-AI/aider）—— 部分可行，强依赖 llm.history

### 存储位置 / 格式

- 默认 `.aider.chat.history.md`（git root 下，`--chat-history-file` 可配，`aider/args.py`）；纯 Markdown 追加写（`io.py` `append_chat_history`）。
- 另有 `--llm-history-file`（默认关闭，需显式开启）：按 `USER <ISO时戳>` / `ASSISTANT <ISO时戳>` + 原始内容逐条记录（`io.py` `log_llm_history`）。

### 三态可判定性

- **轮次边界：部分可行。** `.chat.history.md` 只有会话级时间戳（`# aider chat started at ...`），`#### <用户输入>` 与 AI 正文之间**无逐轮时戳**；开启 `.llm.history` 后每条 LLM 消息带秒级时戳，轮次起止可近似还原。
- **工具耗时：不可行。** 无独立工具执行事件；文件修改经 git auto-commit（属 git 数据非会话记录）；历史文件只有 tool_output/tool_warning 文本，无耗时字段。
- **审批事件：部分可行。** `confirm_ask`/`prompt_ask` 的 y/n 回答以 `> <问题> <回答>` 引用行落盘（`io.py`）——审批交互**有落盘但无时戳**，等待时长不可判。`--yes yes/no` 全自动模式跳过交互但仍写一条记录。
- **Token：部分可行。** 每轮的 usage report 经 `io.tool_output` 追加进 chat history（`base_coder.py`），形如 `Tokens: ... sent, ... received. / Cost: $x message, $y session.`——逐轮 token/费用**文本**可解析，无时戳，为汇总口径（含 cache hit/write 细分）。

### 结论

默认配置下只有会话起点时戳，三态切分基本不可行；启用 `.llm.history` 后轮次级 work 与轮间 standby 可近似切分；review_wait 无时戳，只能以「ASSISTANT 结束 → 下一条 USER」区间近似并如实披露精度限制。**适合「尽力而为 + 强披露」的接入，优先级放最后。**

### 证据

- [aider 官方 Options 文档](https://aider.chat/docs/config/options.html)
- [io.py](https://github.com/Aider-AI/aider/blob/main/aider/io.py)、[base_coder.py](https://github.com/Aider-AI/aider/blob/main/aider/coders/base_coder.py)、[args.py](https://github.com/Aider-AI/aider/blob/main/aider/args.py)
- [Aider transcript schema 分析](https://seanthegeek.net/doubleagent/analyzer/research/aider.html)、[Issue #3607](https://github.com/Aider-AI/aider/issues/3607)

---

## 下一步

1. **Gemini CLI**：本机真实使用积累语料（重点取证 awaiting_approval 的落盘流转）→ 出 ADR → 实现适配器（一个独立 PR）。
2. **Cursor**：积累 tokenCount 非零样本与审批字段样本 → 复核本调研结论 → 再决定是否排期。
3. **Aider**：如接入，仅承诺「开启 llm.history 后的近似三态」，README 支持表与页内口径弹窗必须如实标注精度限制。
