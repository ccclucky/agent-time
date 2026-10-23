# Agent Guidelines

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repo (`ccclucky/agent-time`). See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses five canonical roles mapped to labels on GitHub Issues. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo layout. See `docs/agents/domain.md`.

## Release Guidelines & PR Requirements

This project uses an automated release pipeline with a single human gate (clicking "Publish release" in GitHub Releases). All release notes and version context must be captured upfront in Pull Requests.

### PR Description Standard

Whenever an Agent or contributor opens a Pull Request that introduces changes intended for a release (features, fixes, performance, docs), the PR description MUST include a structured `### Release Notes` section:

```markdown
## Summary
<!-- 1-2 sentence description of what this PR accomplishes -->

### Release Notes
- feat: <concise summary of new user-facing functionality>
- fix: <concise summary of bug fix and impact>

### SemVer Recommendation
<!-- patch | minor | major (default: patch) -->
```

### Rules for Release Notes
1. **User-facing perspective**: Describe what users or integrations will observe, not internal function names or refactoring minutiae.
2. **Explicit types**: Prefix each note with conventional types (`feat:`, `fix:`, `perf:`, `docs:`, `chore:`).
3. **Internal/Non-release changes**: If the PR contains no changes that warrant a public release note (e.g. CI test tweaks), write:
   ```markdown
   ### Release Notes
   None
   ```
4. **Draft Release Aggregation**: Upon merging into `main`, GitHub Actions automatically parses the `### Release Notes` block and appends it to the pending GitHub Draft Release. When the maintainer clicks "Publish release", the accumulated release notes are published directly to npmjs and GitHub Releases with zero manual editing.

## Visual Delivery & Frontend Verification (视觉交付与前端自审规范)

在开发与修复表现层（UI / Web 界面）时，严禁依赖“改了代码就交差”或将测试推给用户。所有参与本项目的 Agent 必须遵循以下底线：

### 1. 截图先审病灶（严禁文字优先）
用户反馈附带截图时，**必须第一时间比对截图中的真实渲染异状**（如 Flex 挤压截断、文字溢出、留白失衡、高度坍塌），严禁只读文字描述而无视图中刺眼的排版崩坏。

### 2. 感官一步到位（严禁敷衍的微小数值递增）
用户指出“太扁/看不清区别/请拉高”等感知问题时：
- **比例感知**：严禁机械增加微小数值（如 48px 改 80px 在 1200px 宽屏下仍是 15:1 细线）；必须代入常见屏幕宽高比，一步调整到正常视觉纵深；
- **非线性对比**：面对多数量级跨度数据（如 1 分钟 vs 5 小时），必须使用幂函数或对数非线性缩放，杜绝常态数据被压成 1px 细线。

### 3. 本地联调防缓存与环境隔离
- 表现层静态资源修改后，在 HTML 引用处增加显式版本戳（如 `?v=xxx`），防止浏览器强缓存造成“已改但用户看不到”的无效排查；
- 多分支并行联调时，Dev Server 必须严格在当前任务的 `.worktree/` 路径下启动，防止被主工作区切分支污染。

### 4. 交付自审杜绝推诿试错
交付用户验收前，必须主动自查渲染因果链路（确认 Flex/Grid 无挤压塌陷、服务端口真实生效），严禁把未经视觉自验的半成品推给用户充当第一测试员。

### 5. 指代先对齐，同视图验证（严禁自证式修复）
用户以截图或指示代词（"这个模块"“如图”“还是没有”）反馈 UI 时：
- **病灶清单先行**：先认领用户当前实际打开的标签页，把参考截图与现状逐元素比对（主行/副行/逐模块逐行），列出全部差异点后一次性修复整张清单；严禁只修自己理解的子集就让用户复验；
- **同视图复验**：修复后必须在用户正在看的那张标签页上刷新，并按其日期范围/滚动位置验证；严禁只在自己导航的视图上验证后宣称完成；
- **演示服务随代码重启**：后端解析/统计逻辑变更后，长驻演示服务必须立即重启再交予用户操作；旧进程的重导会以旧逻辑覆盖库内派生字段（如 title），制造“改了又坏”的假象。

