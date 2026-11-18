import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./store.js";
import type { AdapterName } from "./types.js";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

function dayAt(daysAgo: number, offsetMinutes = 0): number {
  return Date.now() - daysAgo * DAY - 2 * 3_600_000 + offsetMinutes * 60_000;
}

function writeJsonl(file: string, rows: unknown[]): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

/**
 * Create an isolated temporary Store pre-populated with synthetic multi-harness
 * sessions so `agent-time --demo` works immediately with zero local log files.
 */
export async function createDemoStore(): Promise<{
  store: Store;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "agenttime-demo-"));
  const dbPath = path.join(dir, "demo.sqlite3");
  const store = new Store(dbPath);
  const files: { file: string; adapter: AdapterName }[] = [];

  // 1. Antigravity: full conservation 5-state (work + review_wait + idle_gap + tokens)
  const agBase = dayAt(0, 15);
  const agSteps = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: iso(agBase),
      content: "Audit token diffing and add conservation timing tests.",
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(agBase + 45_000),
      input_tokens: 22_400,
      cache_read_tokens: 14_200,
      output_tokens: 860,
      thinking: "Inspecting existing store tests and timing boundaries.",
      tool_calls: [{ name: "run_command", args: { CommandLine: "npm test -- tests/agenttime.test.ts" } }],
    },
    {
      step_index: 2,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: iso(agBase + 69_000),
      content: "41 tests passed in 24s.",
    },
    {
      step_index: 3,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(agBase + 104_000),
      input_tokens: 25_100,
      cache_read_tokens: 16_800,
      output_tokens: 640,
      tool_calls: [{ name: "ask_question", args: { question: "Keep legacy fallback adapter or deprecate?" } }],
    },
    {
      step_index: 4,
      source: "MODEL",
      type: "GENERIC",
      status: "DONE",
      created_at: iso(agBase + 284_000),
      content: "User answered: Keep legacy fallback adapter with explicit warning.",
    },
    {
      step_index: 5,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(agBase + 494_000), // includes 180s idle gap + 30s model
      input_tokens: 27_300,
      cache_read_tokens: 18_900,
      output_tokens: 1_120,
      thinking: "Adding explicit boundary assertions and wrapping up.",
      content: "Done — conservation assertions added and verified.",
    },
  ];
  const agId = "demo-ag-conservation";
  files.push({
    file: writeJsonl(path.join(dir, `antigravity/brain/${agId}/.system_generated/logs/transcript.jsonl`), agSteps),
    adapter: "antigravity",
  });

  // 2. Claude Code: multi-turn with Bash/Read tools
  const clBase = dayAt(1, 20);
  const clFile = writeJsonl(path.join(dir, "claude/projects/-demo-web-app/demo-claude.jsonl"), [
    { type: "custom-title", sessionId: "demo-claude", customTitle: "Refactor auth middleware & rate limit" },
    { type: "user", uuid: "u1", sessionId: "demo-claude", timestamp: iso(clBase), cwd: "/demo/web-app", parentUuid: null, message: { role: "user", content: "Move rate limiter into standalone middleware" } },
    { type: "assistant", uuid: "a1", sessionId: "demo-claude", timestamp: iso(clBase + 42_000), cwd: "/demo/web-app", parentUuid: "u1", message: { role: "assistant", model: "claude-sonnet-4-5", stop_reason: "tool_use", content: [{ type: "tool_use", id: "tc1", name: "Bash", input: { command: "npm run test:auth" } }] } },
    { type: "user", uuid: "tr1", sessionId: "demo-claude", timestamp: iso(clBase + 66_000), cwd: "/demo/web-app", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tc1", content: "ok" }] } },
    { type: "assistant", uuid: "a2", sessionId: "demo-claude", timestamp: iso(clBase + 290_000), cwd: "/demo/web-app", parentUuid: "tr1", message: { role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "Middleware extracted and tests updated." }] } },
    { type: "user", uuid: "u2", sessionId: "demo-claude", timestamp: iso(clBase + 440_000), cwd: "/demo/web-app", parentUuid: "a2", message: { role: "user", content: "Add burst window edge case test" } },
    { type: "assistant", uuid: "a3", sessionId: "demo-claude", timestamp: iso(clBase + 680_000), cwd: "/demo/web-app", parentUuid: "u2", message: { role: "assistant", model: "claude-sonnet-4-5", stop_reason: "end_turn", content: [{ type: "text", text: "Burst window test added and passing." }] } },
  ]);
  files.push({ file: clFile, adapter: "claude" });

  // 3. Codex: completion anchor + cumulative token snapshot
  const cxBase = dayAt(2, 40);
  const cxFile = writeJsonl(path.join(dir, "codex/sessions/2026/11/rollout-demo.jsonl"), [
    { type: "session_meta", timestamp: iso(cxBase), payload: { id: "demo-codex", source: "cli", cwd: "/demo/checkout-api", originator: "codex_cli_rs", history_mode: "paginated" } },
    { type: "turn_context", timestamp: iso(cxBase), payload: { model: "gpt-5.2-codex", turn_id: "t1" } },
    { type: "event_msg", timestamp: iso(cxBase), payload: { type: "task_started", turn_id: "t1" } },
    { type: "response_item", timestamp: iso(cxBase + 200), payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add idempotency key check on retry" }] } },
    { type: "event_msg", timestamp: iso(cxBase + 420_000), payload: { type: "item_completed", turn_id: "t1", item: { type: "AgentMessage", id: "m1" }, completed_at_ms: cxBase + 418_000 } },
    { type: "event_msg", timestamp: iso(cxBase + 422_000), payload: { type: "task_complete", turn_id: "t1" } },
    { type: "event_msg", timestamp: iso(cxBase + 422_500), payload: { type: "token_count", info: { total_token_usage: { input_tokens: 48_000, cached_input_tokens: 32_000, cache_write_input_tokens: 0, output_tokens: 2_400, reasoning_output_tokens: 680, total_tokens: 82_400 } } } },
  ]);
  files.push({ file: cxFile, adapter: "codex" });

  // 4. DeepSeek Harness (zstd frame)
  const dshBase = dayAt(3, 10);
  const dshFrames = [
    [{ type: "session", version: 4, id: "demo-dsh", createdAt: dshBase, cwd: "/demo/cli-tools" }],
    [
      { type: "turn/start", time: dshBase + 10_000, data: { turn: 1 } },
      { type: "user/message", time: dshBase + 12_000, data: { content: [{ type: "text", text: "Split parser and formatter modules" }], source: { kind: "user" }, role: "user" } },
      { type: "step/start", time: dshBase + 20_000, data: { turn: 1, step: 1 } },
      { type: "assistant/message", time: dshBase + 280_000, data: { turn: 1, step: 1, model: "deepseek-reasoner", message: { role: "assistant", content: [{ type: "text", text: "Split complete." }] }, usage: { inputTokens: 19_400, outputTokens: 1_120 } } },
      { type: "step/end", time: dshBase + 281_000, data: { turn: 1, step: 1 } },
      { type: "turn/end", time: dshBase + 282_000, data: { turn: 1, reason: { kind: "completed" } } },
    ],
  ];
  const dshPath = path.join(dir, "dsh/sessions/demo-dsh.jsonl.zstd");
  mkdirSync(path.dirname(dshPath), { recursive: true });
  writeFileSync(dshPath, Buffer.concat(dshFrames.map((f) => zlib.zstdCompressSync(Buffer.from(f.map((r) => JSON.stringify(r)).join("\n") + "\n")))));
  files.push({ file: dshPath, adapter: "dsh" });

  // 5. Pi
  const piBase = dayAt(4, 5);
  files.push({
    file: writeJsonl(path.join(dir, "pi/sessions/demo-pi.jsonl"), [
      { type: "session", version: 3, id: "demo-pi", timestamp: iso(piBase), cwd: "/demo/api-gateway" },
      { type: "session_info", id: "pi-1", parentId: null, timestamp: iso(piBase), name: "Circuit breaker tuning" },
      { type: "message", id: "pi-2", parentId: null, timestamp: iso(piBase + 5_000), message: { role: "user", content: [{ type: "text", text: "Tune half-open probe backoff" }], timestamp: piBase + 5_000 } },
      { type: "message", id: "pi-3", parentId: "pi-2", timestamp: iso(piBase + 245_000), message: { role: "assistant", timestamp: piBase + 15_000, durationMs: 225_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "Backoff tuned and race test green." }] } },
    ]),
    adapter: "pi",
  });

  for (const f of files) {
    await store.importFile(f.file, null, f.adapter);
  }

  const patchDb = new DatabaseSync(dbPath);
  patchDb
    .prepare("UPDATE source SET title = ?, project = ? WHERE session_id LIKE '%' || ?")
    .run("Audit token diffing & timing", "agent-time", agId);
  patchDb.close();

  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
