# 贡献指南 / Contributing

感谢关注 AgentTime！欢迎以下几类贡献：

- **接入新 harness**：新增适配器是最有价值的贡献；
- **口径完善**：为现有适配器补充更精确的耗时证据链；
- **前端打磨**：表现层、可访问性、交互；
- **文档与翻译**。

## 开始之前

```sh
npm ci
npm test     # 全部测试通过再动手
npm run dev  # 本地起服务
```

需要演示数据做手工验证：`npx tsx scripts/make-demo-data.mts /tmp/agenttime-demo`。

## 接入新 Harness 的路径

1. **先勘察一手数据**：拿到真实会话样本（自己的机器即可），确认会话流格式、轮次边界事件、工具配对方式、是否存在审批/确认事件；
2. **写 ADR**：参考 [docs/adr/0002](docs/adr/0002-codex-three-state-timing.md) 与 [0004](docs/adr/0004-omp-db-source-session-registration.md)，把「事件映射契约、轮次边界口径、降级与披露规则」定下来——**口径先行，代码后行**；
3. **实现适配器**：在 `src/` 新增 `<name>.ts`，对外暴露 `parseX(path)` 与 `extractXTranscript(path)`（Turn Inspector 硬性依赖），并在 `src/types.ts` 的 `ADAPTERS`、`src/directories.ts`、`src/store.ts` 等接线点注册；
4. **三态切分**：有审批事件走 `calculateEventTiming` 通道；无审批事件（或仅有一手 duration 证据）走 `calculatePiTiming` 通道。**缺失证据必须如实披露，禁止推算**；
5. **测试 + 真实样本冒烟**：合成夹具单测之外，必须在本机真实数据上静默批量导入一次并核对结果；
6. **更新文案与徽标**：`src/adapters.ts` 的 SOURCES、前端 `agentMark()`（官方素材渲染自审）、相关 pin 测试。

## 提交约定

- PR 描述请附 `### Release Notes`（面向用户视角，见既有 PR 样例）；
- 提交前跑 `npm test` 与 `npx tsc --noEmit`；
- 大改动建议先开 issue 对齐口径再动手。
