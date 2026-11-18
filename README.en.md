<div align="center">

<img src="docs/assets/logo.jpg" width="140" alt="AgentTime logo">

# AgentTime

**A time ledger for your AI coding agents.**

[![Test](https://github.com/ccclucky/agent-time/actions/workflows/test.yml/badge.svg)](https://github.com/ccclucky/agent-time/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/@ccclucky/agent-time.svg)](https://www.npmjs.com/package/@ccclucky/agent-time)
[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.15-58a6ff.svg)](#quick-start)

[简体中文](README.md) · **English**

</div>

---

## AgentTime in 60 Seconds

Time spent should be spent with clarity. In one minute, here is how AgentTime keeps a time ledger for AI coding agents:

https://github.com/user-attachments/assets/08308453-caa0-4b1c-bb41-96cbcdec0dd6

---

AgentTime is a **local-first** time ledger for AI coding agents. It imports sessions from Codex, Claude Code, Pi, Oh-My-Pi, DeepSeek Harness, Antigravity, and OpenCode, splits the recorded time into **pure work, review wait, idle gap, and standby**, and drills every total down to a single session, turn, and tool call.

How much did your agents actually work today — and how much went into waiting for your approval? Open the page and see.

![AgentTime overview: the time-flow bar and full timeline](docs/assets/hero-overview.png)

## Why

- How much of my agents' day was **real work**?
- Within a session, how much went to model inference, command execution, or waiting for me?
- Which sessions are the most expensive? How do agents and models differ?

Typical time tracking counts the whole "start to finish" span as work — **your reading, thinking, and approval time all get billed as AI effort**. AgentTime splits that bill using first-hand evidence from the session event streams.

## The conservation timing model

| State | Meaning | Measured from |
| --- | --- | --- |
| **Pure work** `work_ms` | Model thinking-and-writing + local tool execution | First-hand machine time accumulated from response spans and paired tool spans |
| **Review wait** `review_wait_ms` | Human approval / confirmation blocks | Only counted when the source records approval events; otherwise honestly reported as unknown — never invented |
| **Idle gap** `idle_gap_ms` | In-turn stretches with no source events at all (network blocking, device sleep, busy with the previous message) | Union of in-turn event-free intervals ≥ threshold, minus tool and review spans; sources never state the cause, so only duration is reported |
| **Standby (turn gap)** `standby_ms` | Reply-finished → next submission interval | Turn boundary arithmetic; your time, zero AI consumption |

Conservation identity: **pure work + review wait + idle gap = turn wall clock** (submission → final reply), to the millisecond. Idle thresholds are per-adapter: Antigravity/Pi/Oh-My-Pi/DeepSeek Harness/OpenCode ≥2 minutes; Claude Code/Codex ≥30 minutes (minute-level gaps in interactive turns are genuine generation).

Queued submissions (sent while the previous turn was still running) are recorded separately as `queue_wait_ms`; the tail gap after the final reply is computed live by the frontend — neither is folded into any other dimension.

The web UI renders these states as plain-language labels — **AI 工作 / 等待确认 / 中途停了 / 轮间间隔** — and the in-app "How is this time measured?" dialog maps every label back to the glossary term and field name.

Accompanying drill-downs: six turn KPIs (total time / AI work / auto-completion / 15s+ slow ops / queued submissions / tail gap), per-turn rollup with per-segment conservation breakdown, slowest-operations ranking, per-tool call details with input/output and start/end times, per-model and per-thinking-level breakdowns, and per-turn token usage. The overview also gets a "daily AI work" trend chart (day/week toggle, auto-weekly for long ranges), a per-session work timeline, takeaway cards, and Markdown report export — all generated locally, zero upload. **Missing evidence is always labeled as such — never extrapolated.** That is AgentTime's first design principle.

## Quick start

```sh
npx @ccclucky/agent-time
```

It opens `http://127.0.0.1:8765` for you (bound to localhost only; `--no-open` disables that), enable your agents' data directories on the sources page, and hit "Sync records". While the server runs, syncing is automatic: source changes are re-imported and the page refreshes on its own (manual sync stays available). Or install globally:

```sh
npm install -g @ccclucky/agent-time
agent-time        # dash-less alias: agenttime
```

Requires **Node.js ≥ 22.15** (built-in SQLite and zstd; no native builds). The CLI also supports `--port`, `--db`, `--no-open`, and standalone `import --agent <adapter> <path>` — see `agent-time --help`.

## Supported harnesses

All imports are read-only; formats keep adapting as upstreams evolve (design decisions in [docs/adr](docs/adr/)):

| Harness | Conservation timing | Token drill-down | Turn Inspector drawer | Notes |
| --- | --- | --- | --- | --- |
| Codex | ✔ completion-anchor calibrated · long stall ≥30 min | ✔ cumulative snapshot diff | ✔ | Official reasoning is encrypted (ZDR); honestly labeled |
| Claude Code | ✔ message-record spans · long stall ≥30 min | — | ✔ | Main transcript stream |
| Pi | ✔ first-hand machine-time accumulation · stall ≥2 min | — | ✔ | Branch topology; only the active path |
| DeepSeek Harness | ✔ · stall ≥2 min | ✔ per-request | ✔ | Multi-frame zstd event stream |
| Antigravity | ✔ 5-state conservation · stall ≥2 min · `ask_question` counted as review wait | ✔ per-request I/O | ✔ | Background tasks counted on completion receipts; per-call tool I/O and start/end |
| OpenCode | ✔ · stall ≥2 min | ✔ per-request | ✔ | SQLite session store, one DB many sessions |
| Oh-My-Pi | ✔ history.db anchor fallback · stall ≥2 min | ✔ per-request | ✔ | Legacy files get second-precision anchors, disclosed |

## Privacy: local-first, zero telemetry

- The server binds to `127.0.0.1` only — **no telemetry, no uploads, no accounts**;
- One local SQLite metadata database; **tool arguments, prompt source text, and credentials are never persisted**;
- Turn Inspector reads prompt/thinking text **on demand from local source files** when the drawer opens — never stored, never uploaded;
- AgentTime never reads credential files and never scans outside your configured data directories.

## Screenshots

**Session detail**: five-dimension split (click any row to drill down), six KPIs, slowest operations, and attribution.

![Session detail](docs/assets/session-detail.png)

**Turn Inspector drawer**: the turn's prompt, model reasoning, tool call stack with per-call durations — extracted on demand.

![Turn Inspector drawer](docs/assets/turn-inspector.png)

**Aggregation panels**: top sessions, operations breakdown, per-source / project / tool rollups.

![Aggregation panels](docs/assets/analytics-panels.png)

**Sources**: seven harnesses on one page; toggle to enable, custom paths supported.

![Sources](docs/assets/sources.png)

## How it works

```text
Local session sources (per-harness data dirs / SQLite stores, read-only)
        │  event stream parsing (one adapter per harness)
        ▼
Normalized event stream (start/complete/abort · model · tool_use/tool_result …)
        │  conservation split (calculateEventTiming / calculatePiTiming)
        ▼
Local SQLite stats store (metadata) ──▶ local web UI (127.0.0.1:8765, zero-dependency frontend)
```

Re-imports are idempotent; files that change mid-sync keep their previous snapshot and surface an honest error; known duplicate sources such as fork copies are excluded by design and reported separately.

## Development

```sh
git clone https://github.com/ccclucky/agent-time && cd agent-time
npm ci
npm test          # full suite (node:test, no extra test framework)
npm run check     # type check
npm run dev       # run from source
```

Want demo data? `npx tsx scripts/make-demo-data.mts /tmp/agenttime-demo` generates a fully synthetic multi-harness dataset (the script prints the serve command). Every screenshot in this README comes from it.

Contributions welcome — new harness adapters, timing-disclosure refinements, and frontend polish are good starting points. See [CONTRIBUTING.md](CONTRIBUTING.md).

## FAQ

**Does it slow my agents down?** No. Imports are read-only parsing — no hooks, no injection; your agent processes never notice.

**Why does "waiting for confirmation" (review wait) show "—" for some sessions?** That source records no approval events. AgentTime refuses to treat missing evidence as "zero wait" — an intentional honesty policy.

**Does any data leave my machine?** No. No telemetry, no uploads, no accounts; all computation and storage stay local.

**Team aggregation?** This version is a personal, single-machine ledger. Multi-machine aggregation is on the roadmap — never at the cost of local privacy.

## License

[MIT](LICENSE)
