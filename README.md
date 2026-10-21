# AgentTime

AI Agent Time & Efficiency Analytics.

AgentTime is a lightweight, local-first time ledger for AI coding agents. See recorded time costs, inspect overlapping execution, and follow a total down to individual sessions and timestamped events.

**Status: early MVP.** The working adapters import selected local Codex rollout and Claude Code transcript JSONL files into a local SQLite database and serve a browser interface. It measures recorded processing intervals, not pure agent work: approval waits cannot be reconstructed reliably from these history files. Claude Code reports user-message-to-explicit-end **record timestamp spans**, which are a different basis from Codex execution boundaries. Other integrations remain planned. Compatibility has been checked against pinned upstream source and synthetic fixtures; validation with users’ local installations is still needed.

## Run locally

Requires **Node.js 22.13+** (Node 24 LTS recommended) and npm. SQLite is provided by Node; there is no Python runtime or native-addon build requirement. Node 22 may print its built-in SQLite experimental warning. The browser interface uses native HTML/CSS/JavaScript and the backend uses TypeScript. An account or API key is not needed.

From this checkout:

```sh
npm ci
npm run dev
```
Open **配置与接入 (Configuration & sources)** in the interface. Codex defaults to `~/.codex`; Claude Code defaults to `~/.claude` (transcripts under `projects`). For either tool, enable **从此目录读取会话 (Read sessions from this directory)** and save to import its history. Change the directory or restore its default in the same page. No command-line import is needed for this workflow.

The default listener is `127.0.0.1:8765`, accessible only on this machine. A custom port is available with `serve --port 8766`. `Ctrl+C` stops the server. The npm package has not been published. For a package-level trial, run `npm pack` and then, from any directory, `npx --package /absolute/path/agenttime-0.1.0.tgz agenttime`. Do not use a bare `npx agenttime` yet: the registry name has not been verified or claimed. The package is marked private to prevent accidental publication.

By default, metadata is stored at `$XDG_DATA_HOME/agenttime/agenttime.sqlite3`, or `~/.local/share/agenttime/agenttime.sqlite3` when the variable is unset. To choose a different location, use the same `--db` path for every command:

```sh
npm run dev -- --db /path/to/agenttime.sqlite3 import --agent codex /path/to/local/session.jsonl
npm run dev -- --db /path/to/agenttime.sqlite3 serve
```

Import a file or a directory containing JSONL files. Repeating an import, including an identical copied file, does not double-count its events. An import with skipped files returns a nonzero exit code and reports the failures. Custom Codex directories can be saved in the configuration page, or supplied to the advanced CLI import. AgentTime never reads credential files or searches arbitrary device directories.

The **Sync records** button discovers new JSONL files in enabled Codex data directories (`sessions` and `archived_sessions`) and Claude Code `projects` and updates existing snapshots. Directory settings persist in the same local database. Disabling a directory stops future reads from it; changing directories preserves previously imported statistics. Advanced CLI-imported files are still refreshed independently. Alternatively, run `npm run dev -- refresh`. Unreadable or changing files retain their previous snapshot, and failed refreshes remain visible. There is no background collector yet.

## What works today

- Daily, 7-day, 30-day, and custom-date totals using the browser's timezone.
- Recorded processing time, overlapping interval deduplication, and a breakdown of measurable, incomplete, failed, and interrupted rounds.
- Clickable totals → contributing sessions → individual execution boundaries.
- Session search, sorting, model-context grouping, and CSV export of the selected period.
- Read-only Codex and Claude Code imports and transactional local persistence of allowlisted metadata.
- Clear unavailable states for pure work time, confirmation waits, user response intervals, tokens, and costs.

Codex processing time uses timestamps on execution-start and completion/abort events. These are **not** exact user-submission timestamps. Failed and interrupted executions with valid endpoints contribute to recorded time costs and are labeled separately. Open or conflicting intervals never become fabricated completed durations. Cross-date intervals contribute only their overlap with the selected dates; full round durations remain available in details.

Only recognized CLI, VS Code, and exec provenance is accepted. Explicit remote/cloud origins, unknown sources, child agents, forked/inherited histories, paginated histories, and rollbacks are not supported by this first adapter and are rejected rather than flattened. Local file placement alone cannot prove physical execution location; import only records from your own local agent use.

The configuration page pre-fills defaults for Codex, Claude Code, Oh-My-Pi, Pi, and OpenCode. Antigravity’s default session location remains unverified. Codex and Claude Code can currently be enabled; other tools may have their directory preferences saved without claiming ingestion support. Default locations are verified against each tool’s own source, not inferred from example names or configuration folders. Oh-My-Pi uses its agent/profile/XDG data rules; unresolvable overrides stay unfilled. See [directory configuration](docs/directories.zh-CN.md) for pinned primary sources, actual session locations, and the cc-switch UI reference.

Source bodies are read in memory to parse JSONL, but prompts, replies, tool inputs/outputs, credentials, and instruction content are not saved or served. Stored metadata includes IDs, project basename, model-context labels, timestamps, and import diagnostics. The local source registry retains selected file paths for refresh; individual registered file paths are not returned by the web API. The configuration page intentionally displays the user-selected data root and its resolved local path. Nothing is uploaded, and the application makes no outbound requests. It does not install hooks or edit agent configuration.

Claude Code imports exclude `subagents` directories, legacy `agent-*.jsonl` files, sidechain/team records, mixed session IDs, and detected competing user branches. Tool-result messages, injected metadata and compact summaries do not start user rounds. An assistant with explicit `end_turn` / `stop_sequence`, or a `system` `turn_duration` record, supplies an observed end timestamp; `durationMs` is not used to invent a start. A last assistant message, missing stop reason, or a tool-use completion alone never proves the interaction finished. Missing ends remain unmeasured. These transcript timestamps describe recording, not precise model execution or user-visible reply completion. Do not compare their durations directly with Codex execution timing. No hooks or agent configuration changes are needed. Use `npm run dev -- import --agent claude /selected/session.jsonl` for explicit imports.

## Why AgentTime?

As agents take on longer tasks and run in parallel, chat history alone makes it difficult to answer practical questions:

- How much time did my agents spend working today?
- How much of a session went into execution, approvals, and gaps between messages?
- Which sessions took the most time?
- How do execution times vary across agents and models?

AgentTime will use observable events and timestamps. It will not infer whether a user was paying attention, actively waiting, or doing other work.

## Time metrics

These definitions describe the target measurement contract. The initial adapter exposes a narrower, explicitly labeled recorded-processing basis where source events cannot establish the full metric. Unavailable measurements remain unavailable, never zero.

| Metric | Definition |
| --- | --- |
| Agent work time | Time from execution start to reply completion, including model responses and tool execution, excluding recorded human intervention pauses. |
| User response interval | Time from an agent's completed reply to the user's next submission in the same session. This measures an interval, not user attention or actual waiting. |
| Human intervention time | Time from a request for approval, authorization, or additional information to the user's corresponding action. |
| Turn elapsed time | Time from a user's submission to the agent's completed reply, including human intervention. |
| Session span | Time from the session's first user submission to its last completed agent reply. |
| Session cumulative work time | Sum of agent work time across the session's turns. |
| Agent cumulative work time | Sum of an agent's work time across sessions within a selected time range. |

### Measurement boundaries

- **No next message:** a final reply has no completed user response interval. The interval is absent, rather than zero.
- **Idle gaps:** retain original timestamps and intervals. A configurable idle threshold may flag or filter long gaps in summaries; it must not rewrite the underlying data.
- **Resumed sessions:** keep the same session identity across dates and flag long gaps.
- **Parallel execution:** report cumulative agent work separately from elapsed time covered by the union of work intervals. Overlapping work can make the cumulative total exceed elapsed time.
- **Human intervention:** separate recorded approval and clarification pauses from agent work. Full turn duration must not be presented as pure execution time.
- **Incomplete evidence:** mark metrics unavailable or explicitly label a different measurement basis when an integration lacks the necessary events. Missing pause events must not be treated as proof that no pauses occurred.
- **Unfinished activity:** do not present open turns or unresolved intervention requests as completed durations.
- **Reporting periods:** daily, weekly, and monthly summaries need an explicit timezone and rules for intervals crossing period boundaries. The first adapter uses the browser timezone and clips each measured interval at local date boundaries, including daylight-saving transitions.

## Analysis structure

Time will be organized as **Agent → Session → Turn**, with **Model** as a separate analysis dimension.

- **Agent:** the coding tool producing events, such as Claude Code or Codex.
- **Session:** a conversation with its aggregate metrics and timeline.
- **Turn:** a user submission and the resulting agent execution, intervention periods, and subsequent user response interval when one exists.
- **Model:** model attribution independent of the session hierarchy. A session may switch models, and a single turn may involve several models. Shared or unattributed time must not be counted in full against every model.

Planned analysis includes daily, weekly, and monthly totals; agent usage rankings; session time breakdowns and interaction timelines; and duration summaries such as averages, P50, and P95. Token and cost analysis will depend on available source data, with missing values kept distinct from zero.

Agent and model comparisons will need context about task complexity and measurement coverage. A shorter duration alone does not establish better output quality or higher efficiency.

## Planned integrations

| Agent | Status |
| --- | --- |
| Claude Code | Read-only main transcript import; user-message-to-explicit-end record spans; waits remain unknown |
| Codex | Initial read-only JSONL adapter; processing boundaries only, with the limitations above |
| OpenCode | Researched; adapter not yet implemented |
| Pi | Researched; adapter not yet implemented |
| Oh-My-Pi | Researched independently of Pi; adapter not yet implemented |
| Antigravity | Planned; stable local format not yet verified |

An extensible adapter design is intended to accommodate differences in event coverage without hiding them behind misleadingly uniform metrics. See the [source-backed adapter research](docs/local-adapter-research.zh-CN.md) for evidence, pinned versions, and limitations.

## Design principles

- **Local first:** collect, store, and analyze data locally by default.
- **Privacy first:** do not upload prompts, code, or sensitive business data by default; minimize collected content.
- **Low overhead:** keep collection lightweight and avoid disrupting agent execution.
- **Low configuration:** aim for straightforward installation and integration.
- **Accurate metrics:** prefer verifiable events and explicit limitations over estimated precision.
- **Developer friendly:** keep the workflow simple and the results understandable.

## Roadmap

- [x] Document the product scope, time metrics, and measurement boundaries.
- [x] Investigate the six local integration targets and document known event gaps; Antigravity remains unverified.
- [ ] Define a normalized event schema, session identity, pause handling, and model attribution.
- [x] Choose Codex read-only imports, local SQLite storage, and a local browser interface for the first slice.
- [x] Build an initial working slice and validate processing, overlap, incomplete records, interruptions, privacy, and cross-date accounting against source-shaped synthetic fixtures.
- [ ] Validate compatibility with real local installations and expand supported history variants.
- [x] Add timestamped execution details and time-range processing summaries.
- [ ] Reconstruct confirmation waits and response intervals only when sufficient source events are available.
- [ ] Extend agent coverage and add model, token, and cost analysis where evidence supports it.

The order and scope may change as integration research establishes what can be measured reliably.

## Development and contributions

The implementation uses TypeScript, Node’s built-in SQLite, a Temporal timezone library, and native HTML/CSS/JavaScript. Existing Python-version SQLite snapshots and directory preferences remain readable without conversion. From the repository root:

```sh
npm ci
npm run check
npm test
npm run build
npm pack
```

If Node is available, `node --check public/app.js` checks frontend syntax. Functional browser QA has also been run using Playwright/Chromium against the actual local API with synthetic imported files. No production data is bundled; a new database starts empty. The separate [HTML prototype](prototypes/agenttime/README.md) contains labeled synthetic data and is not the runtime application.

Product planning is maintained in [user stories](docs/user-stories.zh-CN.md) and [local adapter research](docs/local-adapter-research.zh-CN.md). Planned features there are not all implemented in this slice.

Feedback on event sources, metric definitions, and real-world edge cases is welcome through GitHub issues. Please redact prompts, code, credentials, and other sensitive data from examples.
