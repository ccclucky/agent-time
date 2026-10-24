# Security Policy / 安全策略

AgentTime 是本地优先工具：服务仅绑定 `127.0.0.1`，无遥测、无上报、无账号。

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 最新 main 与最新 npm release | ✅ 支持 |

## 报告漏洞

**请不要通过公开 issue 报告安全漏洞。**

使用 GitHub 的 [Private vulnerability reporting](https://github.com/ccclucky/agent-time/security/advisories/new) 私密报告，或通过维护者 GitHub 主页的联系方式联系。

请在报告中包含：影响范围（本地文件读取/服务端口/数据完整性等）、复现步骤、受影响的 commit 或版本。我们会在 7 天内确认并在修复后致谢（如你愿意）。

## 设计边界（非漏洞）

以下属于产品设计边界，不是漏洞，但仍欢迎以 issue 讨论：

- AgentTime 以只读方式解析用户显式配置的数据目录中的会话文件；目录外的文件不会被扫描；
- 统计元数据库保存在本机 `~/.local/share/agenttime/`（或 `$XDG_DATA_HOME`），权限 0600；
- Turn Inspector 在打开抽屉时按需读取本机源文件中的提问与思考文本用于本机展示，不落库、不上传。
