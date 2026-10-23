# 用本机样本核对统计

合成测试通过不等于本机日志版本兼容，也不能证明轮次边界正确。遇到异常长耗时或批量跳过时，先核对最小的真实样本，暂不扩大适配器范围。

先提供一份耗时异常的 Claude Code 会话（例如截图的 memory 会话），以及一份被拒绝的 Codex 会话。无需整个 `.claude` / `.codex` 目录，也不要发送 auth.json、配置文件或完整数据库。

在仓库目录运行离线导出工具（Node 22.13+；不需要运行服务或安装额外依赖）：

```powershell
node scripts/export-diagnostics.mjs --agent claude --out .\agenttime-diagnostics-claude "C:\所选会话的完整路径.jsonl"
node scripts/export-diagnostics.mjs --agent codex --out .\agenttime-diagnostics-codex "C:\所选会话的完整路径.jsonl"
```

这里的文件路径需替换成你选择的实际文件。默认 Claude 会话在 `~/.claude/projects/<项目目录>/`，Codex 在 `~/.codex/sessions` 或 `archived_sessions`。输出目录必须不存在；脚本拒绝覆盖已有目录。可以在同一命令末尾指定多份同一工具的会话文件，以保留它们相互一致的匿名 ID。

导出不联网，不扫描目录，不修改原文件。它保留精确时间戳、事件类别、布尔标志、版本号及必要的内容块类型；将 ID 和模型名用本次运行独有的随机密钥做不可直接反查的替换，路径统一改写为 `/redacted/project`。问题、答复、思考内容、工具输入/输出、指令、令牌用量和凭据字段均不导出。未知来源标签归为 other；对象来源只保留 subagent/custom/internal 这类分类，不保留细节。

分享前请自行检查输出的 `sample-*.jsonl` 和 `manifest.json`。精确日期和事件节奏仍能反映活动时间；应确认可以分享。将这两份脱敏样本和各自 manifest 上传即可，另附 Codex / Claude Code 版本号，以及你对异常会话的粗略预期（是否隔夜恢复、是否多次审批或中断）。手动分开导出时 ID 不可跨输出目录关联，不影响单文件分析。

核对顺序：识别来源/版本 → 重建轮次 → 对照起止事件 → 检查恢复、重试、工具结果、子任务、分支和审批 → 独立复算总和/区间并集/按天裁剪。能说明原因后再补回归测试；不通过缩短大数字或设置任意时长上限来“修正”统计。
