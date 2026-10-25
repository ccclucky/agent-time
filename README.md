<div align="center">

<img src="docs/assets/logo.jpg" width="140" alt="AgentTime logo">

# AgentTime

**给 AI Coding Agent 记一本时间账。**

[![Test](https://github.com/ccclucky/agent-time/actions/workflows/test.yml/badge.svg)](https://github.com/ccclucky/agent-time/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@ccclucky/agent-time.svg)](https://www.npmjs.com/package/@ccclucky/agent-time)
[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-58a6ff.svg)](#快速开始)

**简体中文** · [English](README.en.md)

</div>

---

AgentTime 是一个**本地优先**的 Agent 时间账本：把 Codex、Claude Code、Pi、Oh-My-Pi、DeepSeek Harness、Antigravity、OpenCode 等编码 Agent 的会话记录导入本机，切分出**纯工作、等待人审阅、待命**三态耗时，并把总账一路下钻到单个会话、单轮交互、单次工具调用。

你的 Agent 每天到底替你干了多少活、多少时间在等你点头、多少时间在空转？打开页面就能看到。

![AgentTime 总览：时间流向与全景时间轴](docs/assets/hero-overview.png)

## 为什么需要它

- 我一天的 Agent 里，**真正干活的时间**有多少？
- 一场会话里，多少花在模型推理、多少在执行命令、多少在等我确认？
- 哪些会话最耗时？不同 Agent、不同模型的耗时分布差别有多大？

常见的时间统计把「开始到结束」整段记成工作时长——**人在阅读、思考、等待审批的时间全被算成了 AI 在干活**。AgentTime 用事件流里的一手证据把这段账拆开。

## 三态耗时模型

| 态 | 含义 | 计量依据 |
| --- | --- | --- |
| **纯工作** `work_ms` | 模型推理 + 本地工具执行 | 事件流一手机时（响应跨度、工具配对跨度）累加 |
| **等待人审阅** `review_wait_ms` | 人工审批/确认卡点 | 仅当来源落盘了审批事件才计入；否则如实标「未知」，不编造 |
| **待命** `standby_ms` | 上一轮答完到下一轮提交的间隔 | 轮次边界相减，含用户阅读与思考时间 |

界面按展示层短词呈现这三态——**AI 工作 / 等待确认 / 待命**；每个数字背后的术语与字段名，可在页内「这些时间怎么算？」弹窗查到完整三层映射。

配套下钻：轮次四 KPI（总时长 / AI 工作 / 自动完成度 / 超 15s 慢操作）、单轮耗时构成总账、慢操作 TOP 榜、按模型与思考级别的分项、逐轮 Token 用量。**缺失证据一律如实标注，绝不推算充数**——这是 AgentTime 的第一设计原则。

## 快速开始

```sh
npx @ccclucky/agent-time
```

启动后会自动打开 `http://127.0.0.1:8765`（仅绑定本机，`--no-open` 可关闭），在「配置与接入」页启用你的 Agent 数据目录，点「同步记录」即可。也可以全局安装：

```sh
npm install -g @ccclucky/agent-time
agent-time        # 或无连字符别名 agenttime
```

要求 **Node.js ≥ 22.15**（内建 SQLite 与 zstd，无需编译原生模块）。CLI 还支持 `--port`、`--db`、`--no-open` 与 `import --agent <adapter> <路径>` 单独导入，见 `agent-time --help`。

## 支持的 Harness

全部只读导入，格式随上游演进持续适配（设计决策见 [docs/adr](docs/adr/)）：

| Harness | 三态耗时 | Token 下钻 | Turn Inspector 抽屉 | 备注 |
| --- | --- | --- | --- | --- |
| Codex | ✔ 完成锚点校准 | ✔ 累计快照差分 | ✔ | 思考链官方加密（ZDR），如实标注 |
| Claude Code | ✔ 消息记录跨度 | — | ✔ | 主会话流 |
| Pi | ✔ 一手机时累加 | — | ✔ | 分支拓扑只取活跃路径 |
| DeepSeek Harness | ✔ | ✔ 逐请求 | ✔ | 多帧 zstd 事件流 |
| Antigravity | ✔ `ask_question` 计入审阅 | — | ✔ | 后台任务按完成回执计入 |
| OpenCode | ✔ | ✔ 逐请求 | ✔ | SQLite 会话库，一库多会话 |
| Oh-My-Pi | ✔ history.db 锚点回退 | ✔ 逐请求 | ✔ | 旧版文件秒级轮次锚点，如实披露 |

接入能力随上游格式演进持续更新；每个 harness 的轮次边界、完成锚点与降级口径都以 ADR 形式落在 [docs/adr](docs/adr/)。

## 隐私：本地优先，无遥测

- 服务只绑定 `127.0.0.1`，**没有任何遥测、上报或账号体系**；
- 本机只落一份统计元数据库（SQLite），**不保存工具参数、Prompt 源文与凭据**；
- Turn Inspector 的提问与思考文本在你打开抽屉时**按需从本机源文件读取**，不落库、不上传；
- AgentTime 从不读取凭据文件，也从不扫描数据目录之外的任何位置。

## 它长什么样

**会话详情**：三态占比、四个 KPI、慢操作 TOP 榜与耗时归因。

![会话详情](docs/assets/session-detail.png)

**Turn Inspector 抽屉**：单轮的提问原文、模型思考链、工具调用栈与逐项耗时，全部按需从源文件提取。

![Turn Inspector 抽屉](docs/assets/turn-inspector.png)

**聚合面板**：TOP 会话、操作分布、按接入工具 / 项目 / 工具多维汇总。

![聚合面板](docs/assets/analytics-panels.png)

**接入配置**：七个 harness 一页纳管，勾选即接入，支持自定义目录。

![接入配置](docs/assets/sources.png)

## 工作原理

```text
本地会话源（各 harness 数据目录 / SQLite 库，只读）
        │  事件流解析（每 harness 一个适配器）
        ▼
归一化 Event 流（start/complete/abort · model · tool_use/tool_result …）
        │  三态切分（calculateEventTiming / calculatePiTiming）
        ▼
本地 SQLite 统计库（元数据） ──▶ 本地 Web（127.0.0.1:8765，零依赖原生前端）
```

同一文件重复导入幂等；源文件变化时保留旧快照并如实报错；分支副本等已知重复源按设计排除并单列说明。

## 开发

```sh
git clone https://github.com/ccclucky/agent-time && cd agent-time
npm ci
npm test          # 全量测试（node:test，无外部测试框架）
npm run check     # 类型检查
npm run dev       # 从源码启动
```

需要演示数据？`npx tsx scripts/make-demo-data.mts /tmp/agenttime-demo` 生成一套全合成的多 harness 数据集（脚本同入口打印 serve 命令），本 README 的截图即来自它。

欢迎贡献——接入新 harness、完善口径披露、前端打磨都适合下手，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## FAQ

**会拖慢我的 Agent 吗？** 不会。导入是只读解析，无钩子无注入，Agent 进程完全无感。

**为什么有的会话「等待确认」显示「—」？** 该来源没有落盘审批事件，AgentTime 不把缺失证据当作「零等待」。这是刻意为之的诚实口径。

**数据会离开我的电脑吗？** 不会。无遥测、无上报、无账号，全部计算与存储都在本机。

**支持团队聚合视图吗？** 本版本只做本机个人账本。多机聚合在路线图上，但永远不会以牺牲本地隐私为代价。

## License

[MIT](LICENSE)
