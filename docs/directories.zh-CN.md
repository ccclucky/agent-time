# 本地目录配置

用户无需先寻找日志并输入导入命令。启动 AgentTime 后进入“配置与接入”，默认目录已填好；勾选 Codex 或 Claude Code 的“从此目录读取会话”，保存即可同步。输入自定义目录或点击“恢复默认”后，仍需保存才会生效。

## 经上游源码核实的位置

预填值来自工具自己的目录解析或会话读取实现，不来自需求示例，也不把 cc-switch 的配置目录视为会话目录。下表是没有覆盖设置时的约定位置；配置页同时展示数据根目录、实际会话位置和“查看上游目录规则”入口。

| 工具 | 预填数据目录 | 实际会话记录 | 核实依据 |
| --- | --- | --- | --- |
| Codex | `~/.codex` | `sessions`、`archived_sessions` 子目录中的 rollout JSONL | Codex `find_codex_home` 和 rollout 子目录常量 |
| Claude Code | `~/.claude` | `projects/<编码后的项目路径>/*.jsonl` | Anthropic 官方 Agent SDK 的 `_get_projects_dir`，不是仅参考配置文件位置 |
| Oh-My-Pi | `~/.omp/agent` | `sessions` 子目录；命名 profile 和迁移后的 XDG 目录另行解析 | Oh-My-Pi `DirResolver`、`getSessionsDir` |
| Pi | `~/.pi/agent` | `sessions/<编码后的工作目录>/*.jsonl` | Pi `getAgentDir`、`getDefaultSessionDirPath` |
| DeepSeek Harness | `~/.dsh` | `sessions/<编码后的工作目录>/<sessionId>/session[.v4].jsonl.zstd`，多帧 zstd 压缩的 JSONL 事件流 | 无公开上游规则文档；按本机真实会话样本（`~/.dsh/sessions`）核实 |
| OpenCode | `~/.local/share/opencode` | 该数据目录内的 SQLite 会话数据库；稳定渠道通常为 `opencode.db` | OpenCode `global-roots.ts` 和 `database-path.ts` |
| Antigravity | 留空 | 未取得已验证的 IDE 会话位置规则 | 不借用 CLI 或其他产品的配置位置 |

**这些是核实过的目录规则，不是对用户电脑安装状态的断言。** AgentTime 无法从云环境知道用户电脑上另一个进程的启动参数。目录存在与实际拥有可读会话也分别判断，不把“目录存在”写成“已成功接入”。

### 环境与自定义位置

优先采用用户保存的自定义目录。未设置覆盖时，根据启动 AgentTime 所继承的环境推导，不能假设其他 Agent 进程也继承了相同的变量。

- Codex：`CODEX_HOME` 覆盖 `~/.codex`。官方要求覆盖目录存在且有效；配置页显示缺失或不可读时，不宣称工具可以正常使用该位置。
- Claude Code：`CLAUDE_CONFIG_DIR` 覆盖根目录，会话仍在其 `projects` 子目录。
- Pi：`PI_CODING_AGENT_DIR` 覆盖 agent 目录，上游会展开 `~`。`--session-dir`、`PI_CODING_AGENT_SESSION_DIR` 和设置中的 `sessionDir` 可以把会话放在独立位置；CLI 的优先级为参数 → 会话目录环境变量 → 设置。由于当前字段表示工具根目录，遇到独立会话目录覆盖时不从任意目录猜测反推出 agent 根目录，留空并说明。
- Oh-My-Pi：`OMP_PROFILE` 优先于兼容的 `PI_PROFILE`，包括显式空值/default；命名 profile 使用 `<配置根>/profiles/<名称>/agent`，不套用默认模式的 agentDir 覆盖。默认模式采用非 profile 派生的 `PI_CODING_AGENT_DIR`。`PI_CONFIG_DIR` 改变配置根目录名称。
- Oh-My-Pi XDG：按所核实版本，Linux/macOS 上，只有 `XDG_DATA_HOME/omp` 已存在，才将默认 profile 的数据位置切换到该目录；命名 profile 则要求对应 `omp/profiles/<名称>` 已存在。不能仅凭设置了 XDG 环境变量就改变预填位置。自定义 agentDir 不自动迁移到 XDG；Windows 不使用这条 XDG 规则。
- OpenCode：数据目录遵循 `XDG_DATA_HOME/opencode`，配置目录的 `OPENCODE_CONFIG_DIR` 不改变它。绝对 `OPENCODE_DB` 指定的文件及相对 data 目录的 `OPENCODE_DB` 会改变数据库所在位置；`:memory:` 没有持久化会话文件，不预填一个假定的磁盘位置。渠道也可能改变数据库文件名。
- 相对环境路径依赖另一个进程未知的工作目录、无效 profile 或未支持的解析情形不猜测路径。用户可以明确保存自己的绝对目录覆盖。

目录设置保存在所选 AgentTime SQLite 数据库中，不修改 Agent 的配置文件，也不读取 cc-switch 的配置或凭据。浏览器显示 `~` 写法及实际展开位置；支持绝对路径及 `~/`，拒绝相对路径、文件、磁盘根目录和整个用户主目录。不执行命令、不做 shell 变量插值。

## 检测、同步和历史

- 首次显示默认位置时只检测目录是否存在，不扫描会话或读取目录内的配置内容。
- 保存但不启用只改变 AgentTime 偏好；启用 Codex 或 Claude Code 后保存会同步其已知会话子目录。
- 后续“同步记录”会发现这些子目录中的新文件；不是只更新首次登记的文件。
- 目录尚不存在时可以先保存；界面明确提示缺失，同步不创建工具目录。
- 扫描不跟随会话子目录或文件符号链接，不进入任意根目录内容。单次最多发现 5000 个会话文件。
- 关闭配置接入后，不再读取由该配置导入的文件；更换目录不删除历史统计。
- CLI 手动导入的来源独立于目录开关，仍按显式选择刷新。同一个文件后来通过目录接入时转为该目录管理，不重复计时。
- 文件从 `sessions` 移到 `archived_sessions` 时，仅在新来源已成功导入且覆盖旧快照的全部规范化事件后，才移除冗余旧缓存；不删除任何源文件或独有历史。
- 无法读取的历史保留旧快照并提示；目录不存在或没有会话文件会在同步结果中说明。

## 一手依据（按版本固定）

- Codex `c7234c1174b27d9c55199fba0d546dc27d1b0415`：[home 解析](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/utils/home-dir/src/lib.rs)、[rollout 子目录](https://github.com/openai/codex/blob/c7234c1174b27d9c55199fba0d546dc27d1b0415/codex-rs/rollout/src/lib.rs)。
- Anthropic 官方 Python SDK `dd27b703647a4f8989ab656f00c85f98090a60fd`：[实际读取会话的 sessions.py](https://github.com/anthropics/claude-agent-sdk-python/blob/dd27b703647a4f8989ab656f00c85f98090a60fd/src/claude_agent_sdk/_internal/sessions.py)。
- Pi `16f5f0af4d85ca583d045ceb5ed6d646fcaf7761`：[agent 目录与变量定义](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/config.ts)、[会话存储目录](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/core/session-manager.ts)、[独立会话目录优先级](https://github.com/badlogic/pi-mono/blob/16f5f0af4d85ca583d045ceb5ed6d646fcaf7761/packages/coding-agent/src/main.ts)。
- Oh-My-Pi `d5cd750e41fede277f9eb933455da92a0738915e`：[DirResolver、profiles、XDG 与会话目录](https://github.com/can1357/oh-my-pi/blob/d5cd750e41fede277f9eb933455da92a0738915e/packages/utils/src/dirs.ts)。
- OpenCode `4d5965762ec5e0d1a0b14630553fc62b51a11fba`：[数据与配置根目录](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/util/src/global-roots.ts)、[数据库实际文件选择](https://github.com/anomalyco/opencode/blob/4d5965762ec5e0d1a0b14630553fc62b51a11fba/packages/cli/src/database-path.ts)。

## cc-switch 的参考边界

[cc-switch 的 DirectorySettings.tsx](https://github.com/farion1231/cc-switch/blob/c776fd0ebfe35d769b5909b86bdfa1ccdf089988/src/components/settings/DirectorySettings.tsx) 仅作为“按工具编辑、展示展开位置、恢复默认”的交互参考。实际会话位置以各工具的一手实现为依据。

cc-switch 的 `agy_config.rs` 面向 Antigravity CLI，不能证明 Antigravity IDE 的会话目录或格式；本次未据此填入 IDE 默认位置。

目前 Codex 和 Claude Code 具备日志导入能力；Claude 使用消息记录跨度口径，与 Codex 执行区间不同。其他工具的路径规则核实不等于已实现适配器，也不代表已经读取过用户本机的真实数据。已有自定义路径不会因为默认规则修正而被静默覆盖。
