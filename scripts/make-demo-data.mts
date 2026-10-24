/**
 * Build a privacy-safe demo dataset for README screenshots.
 *
 * Generates synthetic sessions for all implemented harnesses (Codex, Claude
 * Code, Pi, Oh-My-Pi, DeepSeek Harness) under <out>/, imports them into
 * <out>/agenttime-demo.sqlite3, and prints the serve command. Every prompt,
 * title and path is fictional; nothing on the machine is read.
 *
 * Usage: npx tsx scripts/make-demo-data.mts /tmp/agenttime-demo
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

const out = path.resolve(process.argv[2] ?? "/tmp/agenttime-demo");
mkdirSync(out, { recursive: true });

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const midnight = () => {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return n.getTime();
};
// Local wall-clock: daysAgo days back at hh:mm today's timezone.
const d = (daysAgo: number, h: number, m: number) => midnight() - daysAgo * DAY + (h * 60 + m) * 60_000;
const write = (rel: string, rows: unknown[]) => {
  const p = path.join(out, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

// ---------- Codex (rollout jsonl: event_msg / response_item / turn_context) ----------
type CodexRow = Record<string, unknown>;
const codexMeta = (id: string, cwd: string, at: number): CodexRow => ({
  type: "session_meta",
  timestamp: iso(at),
  payload: { id, source: "cli", cwd, originator: "codex_cli_rs", history_mode: "paginated" },
});
const codexMsg = (type: string, at: number, turn: string, extra: object = {}): CodexRow => ({
  type: "event_msg",
  timestamp: iso(at),
  payload: { type, turn_id: turn, ...extra },
});
const codexResp = (type: string, at: number, extra: object): CodexRow => ({
  type: "response_item",
  timestamp: iso(at),
  payload: { type, ...extra },
});
const codexCtx = (at: number, model: string, turn: string): CodexRow => ({
  type: "turn_context",
  timestamp: iso(at),
  payload: { model, turn_id: turn },
});
const codexTokens = (at: number, totals: Record<string, number>): CodexRow => ({
  type: "event_msg",
  timestamp: iso(at),
  payload: { type: "token_count", info: { total_token_usage: totals } },
});
const tok = (input: number, cached: number, output: number, reasoning: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + cached + output,
});

function codexCheckout(): CodexRow[] {
  const base = d(0, 9, 12);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const totals = (input: number, cached: number, out: number, r: number) => tok(input, cached, out, r);
  return [
    codexMeta("demo-checkout-1", "/home/dev/checkout-flow", t(0)),
    // Turn 1: read → patch → verify, completes
    codexCtx(t(0), "gpt-5.2-codex", "t1"),
    codexMsg("task_started", t(0), "t1"),
    codexResp("function_call", t(0, 25), { call_id: "c1", name: "shell_command" }),
    codexResp("function_call_output", t(0, 40), { call_id: "c1" }),
    codexResp("custom_tool_call", t(1), { call_id: "c2", name: "apply_patch" }),
    codexResp("custom_tool_call_output", t(1, 30), { call_id: "c2" }),
    codexResp("function_call", t(1, 45), { call_id: "c3", name: "shell_command" }),
    codexResp("function_call_output", t(2, 5), { call_id: "c3" }),
    codexMsg("item_completed", t(2, 40), "t1", {
      item: { type: "AgentMessage", id: "i1" },
      completed_at_ms: t(2, 35),
    }),
    codexMsg("task_complete", t(2, 41), "t1"),
    codexTokens(t(2, 41), totals(48_120, 38_900, 2_310, 640)),
    // Turn 2: follow-up question, completes quickly
    codexCtx(t(4), "gpt-5.2-codex", "t2"),
    codexMsg("task_started", t(4), "t2"),
    codexMsg("item_completed", t(5, 20), "t2", {
      item: { type: "AgentMessage", id: "i2" },
      completed_at_ms: t(5, 15),
    }),
    codexMsg("task_complete", t(5, 21), "t2"),
    codexTokens(t(5, 21), totals(61_402, 52_100, 3_020, 812)),
    // Turn 3: user interrupts a long run
    codexCtx(t(7), "gpt-5.2-codex", "t3"),
    codexMsg("task_started", t(7), "t3"),
    codexResp("function_call", t(7, 20), { call_id: "c4", name: "shell_command" }),
    codexResp("function_call_output", t(7, 50), { call_id: "c4" }),
    codexMsg("turn_aborted", t(8, 10), "t3", { reason: "interrupted" }),
    codexTokens(t(8, 10), totals(70_311, 58_440, 3_552, 903)),
  ];
}

function codexLogParser(): CodexRow[] {
  const base = d(1, 16, 3);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  return [
    codexMeta("demo-log-parser-1", "/home/dev/log-parser", t(0)),
    codexCtx(t(0), "gpt-5.2-codex", "t1"),
    codexMsg("task_started", t(0), "t1"),
    codexResp("function_call", t(0, 15), { call_id: "c1", name: "shell_command" }),
    codexResp("function_call_output", t(0, 55), { call_id: "c1" }),
    codexResp("function_call", t(1, 10), { call_id: "c2", name: "shell_command" }),
    codexResp("function_call_output", t(1, 40), { call_id: "c2" }),
    codexMsg("item_completed", t(3, 30), "t1", {
      item: { type: "AgentMessage", id: "i1" },
      completed_at_ms: t(3, 25),
    }),
    codexMsg("task_complete", t(3, 31), "t1"),
    codexTokens(t(3, 31), tok(42_088, 33_150, 1_980, 511)),
    codexCtx(t(6), "gpt-5.2-codex", "t2"),
    codexMsg("task_started", t(6), "t2"),
    codexMsg("item_completed", t(8, 40), "t2", {
      item: { type: "AgentMessage", id: "i2" },
      completed_at_ms: t(8, 35),
    }),
    codexMsg("task_complete", t(8, 41), "t2"),
    codexTokens(t(8, 41), tok(55_640, 44_900, 2_744, 690)),
  ];
}

// ---------- Claude Code (projects jsonl) ----------
const claudeRow = (type: string, uuid: string, at: number, extra: Record<string, unknown>) => ({
  type,
  uuid,
  sessionId: "demo-claude-1",
  timestamp: iso(at),
  cwd: "/home/dev/dashboard",
  parentUuid: null,
  ...extra,
});
function claudeDashboard(): unknown[] {
  const base = d(0, 14, 2);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const r = (type: string, uuid: string, at: number, extra: Record<string, unknown>) => ({
    ...claudeRow(type, uuid, at, {}),
    parentUuid: undefined,
    ...extra,
  });
  return [
    r("user", "u1", t(0), { message: { role: "user", content: "把深色模式的对比度问题修一下" } }),
    r("assistant", "a1", t(0, 30), {
      parentUuid: "u1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file: "tokens.css" } }],
      },
    }),
    r("user", "t1", t(0, 55), {
      parentUuid: "a1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    }),
    r("assistant", "a2", t(1, 20), {
      parentUuid: "t1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_2", name: "Edit", input: { file: "tokens.css" } }],
      },
    }),
    r("user", "t2", t(1, 50), {
      parentUuid: "a2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] },
    }),
    r("assistant", "a3", t(3, 40), {
      parentUuid: "t2",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "对比度已达标 WCAG AA。" }],
      },
    }),
    r("user", "u2", t(20), { parentUuid: "a3", message: { role: "user", content: "顺手把焦点环也统一了" } }),
    r("assistant", "a4", t(20, 40), {
      parentUuid: "u2",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "焦点环已统一为 2px outline。" }],
      },
    }),
  ];
}
function claudeApiGateway(): unknown[] {
  const base = d(2, 10, 30);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const r = (type: string, uuid: string, at: number, extra: Record<string, unknown>) => ({
    ...claudeRow(type, uuid, at, {}),
    cwd: "/home/dev/api-gateway",
    sessionId: "demo-claude-2",
    parentUuid: undefined,
    ...extra,
  });
  return [
    r("user", "u1", t(0), { message: { role: "user", content: "给限流中间件补测试" } }),
    r("assistant", "a1", t(0, 35), {
      parentUuid: "u1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已补充 12 个用例。" }],
      },
    }),
  ];
}

// ---------- Pi (agent/sessions) ----------
function piApiServer(): unknown[] {
  const base = d(1, 11, 8);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const id = (n: number) => `demo-pi-${String(n).padStart(8, "0")}`;
  return [
    { type: "session", version: 3, id: "demo-pi-session-1", timestamp: iso(t(0)), cwd: "/home/dev/api-server" },
    { type: "session_info", id: id(1), parentId: null, timestamp: iso(t(0)), name: "重构速率限制模块" },
    { type: "message", id: id(2), parentId: null, timestamp: iso(t(0, 5)), message: { role: "user", content: [{ type: "text", text: "把速率限制抽成独立中间件" }], timestamp: t(0, 5) } },
    { type: "message", id: id(3), parentId: id(2), timestamp: iso(t(2, 10)), message: { role: "assistant", timestamp: t(0, 20), durationMs: 110_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "toolUse", content: [{ type: "text", text: "先读现有实现。" }, { type: "toolCall", id: "pc1", name: "read" }] } },
    { type: "message", id: id(4), parentId: id(3), timestamp: iso(t(2, 40)), message: { role: "toolResult", toolCallId: "pc1", toolName: "read", timestamp: t(2, 40), durationMs: 8_200, content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: id(5), parentId: id(4), timestamp: iso(t(5, 30)), message: { role: "assistant", timestamp: t(2, 50), durationMs: 155_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "中间件已抽出并接线。" }] } },
  ];
}

// ---------- Oh-My-Pi (agent/sessions + history.db) ----------
function ompDocsSite(): { rows: unknown[]; prompts: [string, number][] } {
  const base = d(0, 11, 5);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const sid = "01900000-4aa4-7000-9d93-00000000c0de";
  const rows = [
    { type: "session", version: 3, id: sid, timestamp: iso(t(0)), cwd: "/home/dev/docs-site" },
    { type: "title", v: 1, title: "文档站搜索体验优化", source: "auto", updatedAt: iso(t(0, 10)), pad: " " },
    { type: "message", id: "o1", parentId: null, timestamp: iso(t(0, 30)), message: { role: "user", timestamp: t(0, 30), content: [{ type: "text", text: "搜索结果高亮和分页一起优化掉" }] } },
    { type: "message", id: "o2", parentId: "o1", timestamp: iso(t(1, 40)), message: { role: "assistant", timestamp: t(0, 45), duration: 52_000, model: "deepseek-v4-flash", provider: "new-api", api: "openai-completions", stopReason: "toolUse", content: [{ type: "thinking", thinking: "先定位搜索组件。" }, { type: "toolCall", id: "oc1", name: "grep" }], usage: { input: 21_400, cacheRead: 12_800, cacheWrite: 0, output: 1_120, reasoningTokens: 380, totalTokens: 34_320 } } },
    { type: "custom", customType: "tool_execution_start", id: "oc1s", parentId: "o2", timestamp: iso(t(1, 42)), data: { toolCallId: "oc1", toolName: "grep", startedAt: iso(t(1, 42)), intent: "定位搜索组件", args: { pattern: "SearchResults" } } },
    { type: "message", id: "o3", parentId: "o2", timestamp: iso(t(1, 50)), message: { role: "toolResult", timestamp: t(1, 50), toolCallId: "oc1", toolName: "grep", isError: false, content: [{ type: "text", text: "3 hits" }] } },
    { type: "message", id: "o4", parentId: "o3", timestamp: iso(t(4, 30)), message: { role: "assistant", timestamp: t(2, 0), duration: 96_000, model: "deepseek-v4-flash", provider: "new-api", api: "openai-completions", stopReason: "stop", content: [{ type: "thinking", thinking: "高亮与分页可以同一次提交。" }], usage: { input: 28_310, cacheRead: 18_240, cacheWrite: 0, output: 1_640, reasoningTokens: 522, totalTokens: 48_194 } } },
  ];
  return {
    rows,
    prompts: [
      ["搜索结果高亮和分页一起优化掉", Math.floor(t(0, 30) / 1000)],
      ["再跑一遍 Lighthouse 看分数", Math.floor(t(12, 0) / 1000)],
    ],
  };
}

// ---------- DeepSeek Harness (multi-frame zstd jsonl) ----------
function dshCliRefactor(): Buffer {
  const base = d(2, 15, 12);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const recs: unknown[][] = [
    [{ type: "session", version: 4, id: "demo-dsh-session-1", createdAt: t(0), cwd: "/home/dev/cli-refactor" }],
    [
      { type: "turn/start", time: t(0, 20), data: { turn: 1 } },
      { type: "user/message", time: t(0, 25), data: { content: [{ type: "text", text: "拆掉 god file，按职责分模块" }], source: { kind: "user" }, role: "user" } },
      { type: "step/start", time: t(0, 40), data: { turn: 1, step: 1 } },
      { type: "assistant/message", time: t(2, 30), data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text: "先读目录结构。" }] }, usage: null } },
      { type: "tool/call", time: t(2, 35), data: { turn: 1, step: 1, callId: "dc1", name: "ls", arguments: "{}" } },
      { type: "tool/result", time: t(2, 50), data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "dc1" } } },
      { type: "assistant/message", time: t(6, 40), data: { turn: 1, step: 2, message: { role: "assistant", content: [{ type: "text", text: "拆分为 parser/runner/report 三个模块。" }] }, usage: null } },
    ],
  ];
  return Buffer.concat(
    recs.map((frame) => zlib.zstdCompressSync(Buffer.from(frame.map((r) => JSON.stringify(r)).join("\n") + "\n"))),
  );
}

// ---------- write everything ----------
const files: string[] = [];
files.push(
  write(`codex/sessions/2026/10/rollout-demo-checkout.jsonl`, codexCheckout()),
  write(`codex/sessions/2026/10/rollout-demo-log-parser.jsonl`, codexLogParser()),
  write(`claude/projects/-home-dev-dashboard/demo-claude-1.jsonl`, claudeDashboard()),
  write(`claude/projects/-home-dev-api-gateway/demo-claude-2.jsonl`, claudeApiGateway()),
  write(`pi/agent/sessions/-home-dev-api-server/demo-pi-session-1.jsonl`, piApiServer()),
);
{
  const { rows, prompts } = ompDocsSite();
  files.push(write(`omp/agent/sessions/-home-dev-docs-site/2026-01-01T00-00-00-000Z_${rows[0].id}.jsonl`, rows));
  const db = new DatabaseSync(path.join(out, "omp/agent/history.db"));
  db.exec("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, created_at INTEGER NOT NULL, cwd TEXT, session_id TEXT)");
  const put = db.prepare("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?,?,?,?)");
  for (const [p, at] of prompts) put.run(p, at, "/home/dev/docs-site", rows[0].id);
  db.close();
}
{
  const p = path.join(out, "dsh/sessions/-home-dev-cli-refactor/demo-dsh.jsonl.zstd");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, dshCliRefactor());
  files.push(p);
}

// ---------- import into the demo store ----------
const store = new Store(path.join(out, "agenttime-demo.sqlite3"));
const adapterBy: Record<string, "codex" | "claude" | "pi" | "omp" | "dsh"> = {
  codex: "codex", claude: "claude", pi: "pi", omp: "omp", dsh: "dsh",
};
for (const f of files) {
  const adapter = adapterBy[f.split("/")[0] + (f.includes("/agent/") ? "" : "")] ?? (f.includes("claude/") ? "claude" : (f.split("/")[0] as any));
  const a = f.includes(`${out}/codex/`) ? "codex" : f.includes(`${out}/claude/`) ? "claude" : f.includes(`${out}/pi/`) ? "pi" : f.includes(`${out}/omp/`) ? "omp" : "dsh";
  try {
    const r = await store.importFile(f, null, a);
    console.log(`imported ${a}: ${path.basename(f)} (events ${r.events})`);
  } catch (e) {
    console.error(`FAILED ${a}: ${path.basename(f)}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
store.close();
console.log(`\nDemo data ready at ${out}`);
console.log(`Serve:  npx tsx src/cli.ts --db ${out}/agenttime-demo.sqlite3 serve --port 8766`);
