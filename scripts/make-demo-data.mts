/**
 * Build a privacy-safe demo dataset for README screenshots and local demos.
 *
 * Generates synthetic sessions for all 7 supported harnesses (Codex, Claude
 * Code, Pi, Oh-My-Pi, DeepSeek Harness, Antigravity, OpenCode) under <out>/,
 * imports them into <out>/agenttime-demo.sqlite3, and prints the serve command.
 * Every prompt, title, thinking text, tool arg, and path is fictional;
 * nothing on the user's machine is read.
 *
 * Usage: npx tsx scripts/make-demo-data.mts /tmp/agenttime-demo
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";

const out = path.resolve(process.argv[2] ?? "/tmp/agenttime-demo");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const midnight = () => {
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return n.getTime();
};
// Local wall-clock: daysAgo days back at hh:mm today's timezone.
const d = (daysAgo: number, h: number, m: number, s = 0) =>
  midnight() - daysAgo * DAY + (h * 60 + m) * 60_000 + s * 1_000;

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
const tok = (input: number, cached: number, output: number, reasoning: number) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + cached + output,
});
const codexTokens = (at: number, totals: ReturnType<typeof tok>): CodexRow => ({
  type: "event_msg",
  timestamp: iso(at),
  payload: { type: "token_count", info: { total_token_usage: totals } },
});

function codexSession(
  id: string,
  cwd: string,
  base: number,
  turns: { durMin: number; gapMin: number; prompt: string; abort?: boolean }[],
): CodexRow[] {
  const rows: CodexRow[] = [codexMeta(id, cwd, base)];
  let cur = base;
  let totalIn = 32_000;
  let totalOut = 1_400;
  let totalReason = 420;
  turns.forEach((tn, idx) => {
    const tid = `t${idx + 1}`;
    const dur = Math.round(tn.durMin * 60_000);
    rows.push(codexCtx(cur, "gpt-5.2-codex", tid));
    rows.push(codexMsg("task_started", cur, tid));
    rows.push(codexResp("message", cur + 100, { role: "user", content: [{ type: "input_text", text: tn.prompt }] }));
    rows.push(codexResp("function_call", cur + 22_000, {
      call_id: `c${idx}_1`,
      name: "shell_command",
      arguments: JSON.stringify({ command: "npm test -- --grep ledger" }),
    }));
    rows.push(codexResp("function_call_output", cur + 48_000, { call_id: `c${idx}_1`, output: "18 tests passed" }));
    rows.push(codexResp("custom_tool_call", cur + Math.round(dur * 0.45), {
      call_id: `c${idx}_2`,
      name: "apply_patch",
      input: "*** Update File: src/retry.ts",
    }));
    rows.push(codexResp("custom_tool_call_output", cur + Math.round(dur * 0.45) + 21_000, {
      call_id: `c${idx}_2`,
      output: "patched src/retry.ts",
    }));
    if (tn.abort) {
      rows.push(codexMsg("turn_aborted", cur + dur, tid, { reason: "interrupted" }));
    } else {
      rows.push(codexMsg("item_completed", cur + dur - 2_000, tid, {
        item: { type: "AgentMessage", id: `i${idx + 1}` },
        completed_at_ms: cur + dur - 5_000,
      }));
      rows.push(codexMsg("task_complete", cur + dur, tid));
    }
    totalIn += 24_000 + idx * 8_000;
    totalOut += 1_100 + idx * 320;
    totalReason += 310 + idx * 90;
    rows.push(codexTokens(cur + dur + 200, tok(totalIn, Math.round(totalIn * 0.72), totalOut, totalReason)));
    cur += dur + Math.round(tn.gapMin * 60_000);
  });
  return rows;
}

// ---------- Claude Code (projects jsonl) ----------
function claudeSession(
  id: string,
  cwd: string,
  base: number,
  title: string,
  turns: { prompt: string; reply: string; workMin: number; gapMin: number; slowTool?: boolean }[],
): unknown[] {
  const rows: unknown[] = [{ type: "custom-title", sessionId: id, customTitle: title }];
  let cur = base;
  let prevUuid: string | null = null;
  turns.forEach((tn, idx) => {
    const uid = `u${idx}`;
    const workMs = Math.round(tn.workMin * 60_000);
    const r = (type: string, uuid: string, at: number, extra: Record<string, unknown>) => ({
      type,
      uuid,
      sessionId: id,
      timestamp: iso(at),
      cwd,
      parentUuid: prevUuid,
      ...extra,
    });
    rows.push(r("user", uid, cur, { message: { role: "user", content: tn.prompt } }));
    prevUuid = uid;

    const a1 = `a${idx}_1`;
    rows.push(r("assistant", a1, cur + 32_000, {
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `toolu_${idx}_1`, name: "Read", input: { file_path: "src/tokens.css" } }],
      },
    }));
    prevUuid = a1;

    const tr1 = `tr${idx}_1`;
    rows.push(r("user", tr1, cur + 50_000, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${idx}_1`, content: "ok" }] },
    }));
    prevUuid = tr1;

    const a2 = `a${idx}_2`;
    const tool2Start = cur + Math.round(workMs * 0.35);
    const tool2Dur = tn.slowTool ? 24_000 : 12_000;
    rows.push(r("assistant", a2, tool2Start, {
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: `toolu_${idx}_2`, name: tn.slowTool ? "Bash" : "Edit", input: { command: "npm run check" } }],
      },
    }));
    prevUuid = a2;

    const tr2 = `tr${idx}_2`;
    rows.push(r("user", tr2, tool2Start + tool2Dur, {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${idx}_2`, content: "ok" }] },
    }));
    prevUuid = tr2;

    const az = `a${idx}_z`;
    rows.push(r("assistant", az, cur + workMs, {
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: tn.reply }],
      },
    }));
    prevUuid = az;
    cur += workMs + Math.round(tn.gapMin * 60_000);
  });
  return rows;
}

// ---------- Antigravity (transcript.jsonl with conservation 5-state + tool I/O) ----------
interface AgTurnSpec {
  prompt: string;
  thinking: string;
  /** Offset relative to session base in ms (allows queued submission!) */
  startOffsetMs: number;
  steps: {
    modelMs: number;
    thinking?: string;
    tool?: { name: string; args: Record<string, unknown>; durMs: number; output: string };
    reviewWaitMs?: number;
    idleGapMs?: number;
  }[];
  finalModelMs: number;
  finalReply: string;
}

function agSession(base: number, turns: AgTurnSpec[]): unknown[] {
  const rows: unknown[] = [];
  let step = 0;
  for (const tn of turns) {
    let cur = base + tn.startOffsetMs;
    rows.push({
      step_index: step++,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: iso(cur),
      content: tn.prompt,
    });
    for (const st of tn.steps) {
      if (st.idleGapMs && st.idleGapMs > 0) {
        // Explicit event-free gap ≥2min before next model response -> recorded as idle_gap_ms
        cur += st.idleGapMs;
      }
      cur += st.modelMs;
      const calls = st.tool
        ? [{ name: st.tool.name, args: st.tool.args }]
        : st.reviewWaitMs
          ? [{ name: "ask_question", args: { question: "保留兼容导出层还是直接清理旧接口？" } }]
          : [];
      rows.push({
        step_index: step++,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: iso(cur),
        input_tokens: 21_400 + step * 1_100,
        cache_read_tokens: 14_800 + step * 600,
        output_tokens: 780 + step * 90,
        thinking: st.thinking ?? (step === 2 ? tn.thinking : undefined),
        tool_calls: calls,
      });
      if (st.tool) {
        cur += st.tool.durMs;
        rows.push({
          step_index: step++,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          created_at: iso(cur),
          content: st.tool.output,
        });
      } else if (st.reviewWaitMs) {
        cur += st.reviewWaitMs;
        rows.push({
          step_index: step++,
          source: "MODEL",
          type: "GENERIC",
          status: "DONE",
          created_at: iso(cur),
          content: "User answered: 保留兼容导出层，只收敛内部调用路径。",
        });
      }
    }
    cur += tn.finalModelMs;
    rows.push({
      step_index: step++,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: iso(cur),
      input_tokens: 26_200,
      cache_read_tokens: 19_400,
      output_tokens: 1_240,
      thinking: "所有改动与验证均已对齐，准备向用户汇报结果。",
      content: tn.finalReply,
    });
  }
  return rows;
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
    { type: "message", id: id(3), parentId: id(2), timestamp: iso(t(4, 10)), message: { role: "assistant", timestamp: t(0, 20), durationMs: 225_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "toolUse", content: [{ type: "text", text: "先读现有实现。" }, { type: "toolCall", id: "pc1", name: "read" }] } },
    { type: "message", id: id(4), parentId: id(3), timestamp: iso(t(4, 42)), message: { role: "toolResult", toolCallId: "pc1", toolName: "read", timestamp: t(4, 42), durationMs: 18_200, content: [{ type: "text", text: "ok" }] } },
    { type: "message", id: id(5), parentId: id(4), timestamp: iso(t(9, 30)), message: { role: "assistant", timestamp: t(4, 50), durationMs: 275_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "中间件已抽出并接线。" }] } },
    { type: "message", id: id(6), parentId: id(5), timestamp: iso(t(13, 0)), message: { role: "user", content: [{ type: "text", text: "补一条并发限流回归测试" }], timestamp: t(13, 0) } },
    { type: "message", id: id(7), parentId: id(6), timestamp: iso(t(18, 20)), message: { role: "assistant", timestamp: t(13, 15), durationMs: 300_000, model: "gemini-2.5-pro", thinkingLevel: "high", stopReason: "stop", content: [{ type: "text", text: "已补充并发用例，全部通过。" }] } },
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
    { type: "message", id: "o2", parentId: "o1", timestamp: iso(t(3, 40)), message: { role: "assistant", timestamp: t(0, 45), duration: 165_000, model: "deepseek-v4-flash", provider: "new-api", api: "openai-completions", stopReason: "toolUse", content: [{ type: "thinking", thinking: "先定位搜索组件。" }, { type: "toolCall", id: "oc1", name: "grep" }], usage: { input: 21_400, cacheRead: 12_800, cacheWrite: 0, output: 1_120, reasoningTokens: 380, totalTokens: 34_320 } } },
    { type: "custom", customType: "tool_execution_start", id: "oc1s", parentId: "o2", timestamp: iso(t(3, 42)), data: { toolCallId: "oc1", toolName: "grep", startedAt: iso(t(3, 42)), intent: "定位搜索组件", args: { pattern: "SearchResults" } } },
    { type: "message", id: "o3", parentId: "o2", timestamp: iso(t(4, 10)), message: { role: "toolResult", timestamp: t(4, 10), toolCallId: "oc1", toolName: "grep", isError: false, content: [{ type: "text", text: "3 hits" }] } },
    { type: "message", id: "o4", parentId: "o3", timestamp: iso(t(8, 30)), message: { role: "assistant", timestamp: t(4, 20), duration: 245_000, model: "deepseek-v4-flash", provider: "new-api", api: "openai-completions", stopReason: "stop", content: [{ type: "thinking", thinking: "高亮与分页可以同一次提交。" }], usage: { input: 28_310, cacheRead: 18_240, cacheWrite: 0, output: 1_640, reasoningTokens: 522, totalTokens: 48_194 } } },
  ];
  return {
    rows,
    prompts: [
      ["搜索结果高亮和分页一起优化掉", Math.floor(t(0, 30) / 1000)],
    ],
  };
}

// ---------- DeepSeek Harness (multi-frame zstd jsonl) ----------
function dshCliRefactor(): Buffer {
  const base = d(4, 15, 12);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  const recs: unknown[][] = [
    [{ type: "session", version: 4, id: "demo-dsh-session-1", createdAt: t(0), cwd: "/home/dev/cli-refactor" }],
    [
      { type: "turn/start", time: t(0, 20), data: { turn: 1 } },
      { type: "user/message", time: t(0, 25), data: { content: [{ type: "text", text: "拆掉 god file，按职责分模块" }], source: { kind: "user" }, role: "user" } },
      { type: "step/start", time: t(0, 40), data: { turn: 1, step: 1 } },
      { type: "assistant/message", time: t(4, 30), data: { turn: 1, step: 1, model: "deepseek-reasoner", message: { role: "assistant", content: [{ type: "text", text: "先读目录结构。" }] }, usage: { inputTokens: 18_200, outputTokens: 840 } } },
      { type: "tool/call", time: t(4, 35), data: { turn: 1, step: 1, callId: "dc1", name: "bash", arguments: JSON.stringify({ command: "npm run test:unit" }) } },
      { type: "tool/result", time: t(5, 0), data: { turn: 1, step: 1, message: { role: "tool", toolCallId: "dc1" } } },
      { type: "step/end", time: t(5, 2), data: { turn: 1, step: 1 } },
      { type: "step/start", time: t(5, 5), data: { turn: 1, step: 2 } },
      { type: "assistant/message", time: t(10, 40), data: { turn: 1, step: 2, model: "deepseek-reasoner", message: { role: "assistant", content: [{ type: "text", text: "拆分为 parser/runner/report 三个模块。" }] }, usage: { inputTokens: 24_600, outputTokens: 1_520 } } },
      { type: "step/end", time: t(10, 42), data: { turn: 1, step: 2 } },
      { type: "turn/end", time: t(10, 45), data: { turn: 1, reason: { kind: "completed" } } },
    ],
  ];
  return Buffer.concat(
    recs.map((frame) => zlib.zstdCompressSync(Buffer.from(frame.map((r) => JSON.stringify(r)).join("\n") + "\n"))),
  );
}

// ---------- OpenCode (opencode.db) ----------
function writeOpencodeDb(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, name text, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);
    CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
    CREATE TABLE permission (project_id text PRIMARY KEY, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  `);
  const base = d(5, 14, 20);
  const t = (m: number, s = 0) => base + m * 60_000 + s * 1_000;
  db.prepare("INSERT INTO project VALUES (?,?,?,?,?)").run("proj-oc-1", "/home/dev/edge-cache", "edge-cache", base, base);
  db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "oc-sess-1", "proj-oc-1", null, "edge-cache-ttl", "/home/dev/edge-cache", "修复边缘缓存失效竞态", "1.2.24", base, t(14), null,
  );
  const insMsg = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)");
  const insPart = db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)");

  insMsg.run("m-u1", "oc-sess-1", t(0), t(0), JSON.stringify({ role: "user", time: { created: t(0) } }));
  insPart.run("p-u1", "m-u1", "oc-sess-1", t(0), t(0), JSON.stringify({ type: "text", text: "并发回源时缓存失效有竞态，排查一下" }));

  insMsg.run("m-a1", "oc-sess-1", t(0, 10), t(6, 20), JSON.stringify({
    role: "assistant",
    parentID: "m-u1",
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    time: { created: t(0, 10), completed: t(6, 20) },
    tokens: { input: 24_200, output: 1_480, reasoning: 640, cache: { read: 14_000, write: 0 } },
  }));
  insPart.run("p-a1-r", "m-a1", "oc-sess-1", t(0, 10), t(2, 0), JSON.stringify({
    type: "reasoning", text: "先定位 singleflight 锁粒度。", time: { start: t(0, 10), end: t(2, 0) },
  }));
  insPart.run("p-a1-t", "m-a1", "oc-sess-1", t(2, 5), t(2, 40), JSON.stringify({
    type: "tool", callID: "oc_call_1", tool: "grep",
    state: { status: "completed", input: { pattern: "invalidateKey" }, time: { start: t(2, 5), end: t(2, 40) } },
  }));

  insMsg.run("m-u2", "oc-sess-1", t(9, 0), t(9, 0), JSON.stringify({ role: "user", time: { created: t(9, 0) } }));
  insPart.run("p-u2", "m-u2", "oc-sess-1", t(9, 0), t(9, 0), JSON.stringify({ type: "text", text: "加上锁超时兜底并补单测" }));

  insMsg.run("m-a2", "oc-sess-1", t(9, 10), t(14, 0), JSON.stringify({
    role: "assistant",
    parentID: "m-u2",
    modelID: "claude-sonnet-4-5",
    providerID: "anthropic",
    time: { created: t(9, 10), completed: t(14, 0) },
    tokens: { input: 29_100, output: 1_920, reasoning: 820, cache: { read: 19_200, write: 0 } },
  }));
  insPart.run("p-a2-t", "m-a2", "oc-sess-1", t(10, 0), t(10, 26), JSON.stringify({
    type: "tool", callID: "oc_call_2", tool: "bash",
    state: { status: "completed", input: { command: "npm test" }, time: { start: t(10, 0), end: t(10, 26) } },
  }));
  db.close();
}

// ---------- Write all 7 harness datasets ----------
const files: { path: string; adapter: "codex" | "claude" | "pi" | "omp" | "dsh" | "antigravity" | "opencode" }[] = [];

files.push(
  {
    path: write("codex/sessions/2026/11/rollout-demo-checkout.jsonl", codexSession(
      "demo-checkout-1",
      "/home/dev/checkout-flow",
      d(0, 9, 12),
      [
        { durMin: 7.5, gapMin: 2.2, prompt: "支付失败重试会重复下单，补一个幂等键" },
        { durMin: 9.2, gapMin: 3.1, prompt: "把重试退避改成指数，失败态文案统一一下" },
        { durMin: 6.4, gapMin: 0, prompt: "跑一轮沙箱压测验证幂等窗口", abort: true },
      ],
    )),
    adapter: "codex",
  },
  {
    path: write("codex/sessions/2026/11/rollout-demo-log-parser.jsonl", codexSession(
      "demo-log-parser-1",
      "/home/dev/log-parser",
      d(2, 16, 3),
      [
        { durMin: 8.5, gapMin: 2.8, prompt: "日志解析太慢，定位热点并改成流式批处理" },
        { durMin: 11.4, gapMin: 0, prompt: "去掉冗余正则并补基准测试" },
      ],
    )),
    adapter: "codex",
  },
  {
    path: write("claude/projects/-home-dev-dashboard/demo-claude-1.jsonl", claudeSession(
      "demo-claude-1",
      "/home/dev/dashboard",
      d(1, 14, 2),
      "深色模式对比度与焦点环统一",
      [
        { prompt: "把深色模式的对比度问题修一下", reply: "对比度已达标 WCAG AA。", workMin: 9.5, gapMin: 3.5, slowTool: true },
        { prompt: "顺手把焦点环和图表骨架屏也统一了", reply: "焦点环已统一为 2px outline。", workMin: 7.8, gapMin: 0 },
      ],
    )),
    adapter: "claude",
  },
  {
    path: write("claude/projects/-home-dev-api-gateway/demo-claude-2.jsonl", claudeSession(
      "demo-claude-2",
      "/home/dev/api-gateway",
      d(3, 10, 30),
      "限流中间件补测试与回压策略",
      [
        { prompt: "给限流中间件补测试", reply: "已补充 12 个用例。", workMin: 8.2, gapMin: 2.4 },
        { prompt: "超时阈值和回压策略统一收进配置", reply: "配置已收口到 gateway.config.ts。", workMin: 6.7, gapMin: 0, slowTool: true },
      ],
    )),
    adapter: "claude",
  },
  {
    path: write("pi/agent/sessions/-home-dev-api-server/demo-pi-session-1.jsonl", piApiServer()),
    adapter: "pi",
  },
);

{
  const { rows, prompts } = ompDocsSite();
  files.push({
    path: write(`omp/agent/sessions/-home-dev-docs-site/2026-11-12T00-00-00-000Z_${(rows[0] as { id: string }).id}.jsonl`, rows),
    adapter: "omp",
  });
  const db = new DatabaseSync(path.join(out, "omp/agent/history.db"));
  db.exec("CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, created_at INTEGER NOT NULL, cwd TEXT, session_id TEXT)");
  const put = db.prepare("INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?,?,?,?)");
  for (const [p, at] of prompts) put.run(p, at, "/home/dev/docs-site", (rows[0] as { id: string }).id);
  db.close();
}

{
  const p = path.join(out, "dsh/sessions/-home-dev-cli-refactor/demo-dsh.jsonl.zstd");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, dshCliRefactor());
  files.push({ path: p, adapter: "dsh" });
}

{
  const ocDb = path.join(out, "opencode/opencode.db");
  writeOpencodeDb(ocDb);
  files.push({ path: ocDb, adapter: "opencode" });
}

// Antigravity sessions (featured conservation demo: work + review wait + idle gap + queue wait + rich tool I/O)
const agSearchId = "ag-search-77";
files.push({
  path: write(`antigravity/brain/${agSearchId}/.system_generated/logs/transcript.jsonl`, agSession(
    d(0, 14, 10),
    [
      {
        prompt: "重建全文检索倒排索引，并校验同义词召回排序的延迟回退。",
        thinking: "先排查现有分词器与权重打分，确认兼容导出边界后再重跑基准测试。\n注意到索引重建阶段有 3 分钟无事件空档（等待本地磁盘镜像），必须按守恒口径单独记为中途停了。",
        startOffsetMs: 0,
        steps: [
          {
            modelMs: 48_000,
            thinking: "先排查现有分词器与权重打分，确认兼容导出边界后再重跑基准测试。",
            tool: {
              name: "read_file",
              args: { Path: "/home/dev/search-index/src/tokenizer.ts", StartLine: 1, EndLine: 120 },
              durMs: 11_000,
              output: "Showing lines 1-120: export function buildInvertedIndex(docs: Doc[]) ...",
            },
          },
          {
            modelMs: 36_000,
            thinking: "跑一遍 50k 文档基准测试，收集重建前后的 p95 延迟基线。",
            tool: {
              name: "run_command",
              args: { CommandLine: "npm run bench:index -- --corpus 50k" },
              durMs: 28_000, // slow op >15s
              output: "Command exited with code 0.\np95 query latency: 38.4ms -> 19.2ms (50,000 docs)",
            },
          },
          {
            modelMs: 24_000,
            thinking: "涉及导出接口变更，向用户确认是否保留兼容层。",
            reviewWaitMs: 250_000, // 4m 10s 等待确认
          },
          {
            modelMs: 35_000,
            idleGapMs: 210_000, // 3m 30s 中途停了 (>= 2m)
            thinking: "按确认结果只调整内部 ranker 权重，保留兼容导出。",
            tool: {
              name: "edit_file",
              args: { Path: "/home/dev/search-index/src/ranker.ts", Target: "weight = 1.0", Replacement: "weight = 1.35" },
              durMs: 18_000, // slow op >15s
              output: "Updated /home/dev/search-index/src/ranker.ts",
            },
          },
        ],
        finalModelMs: 42_000,
        finalReply: "倒排索引已重建并完成同义词权重校准，p95 延迟从 38.4ms 降至 19.2ms。",
      },
      {
        prompt: "把停用词表和拼音容错规则也接进评分器，再跑一次全量回归。",
        thinking: "先用 grep_search 检查全部引用位置，再运行回归套件验证召回率与延迟。",
        startOffsetMs: 920_000, // ~3m 16s standby after turn 1
        steps: [
          {
            modelMs: 52_000,
            tool: {
              name: "grep_search",
              args: { Query: "STOP_WORDS", SearchPath: "/home/dev/search-index/src" },
              durMs: 9_000,
              output: "Found 4 matches in src/tokenizer.ts, src/ranker.ts",
            },
          },
          {
            modelMs: 38_000,
            reviewWaitMs: 195_000, // 3m 15s 等待确认
          },
          {
            modelMs: 44_000,
            tool: {
              name: "run_command",
              args: { CommandLine: "npm test -- tests/recall.test.ts" },
              durMs: 42_000, // slowest op 42s
              output: "Command exited with code 0.\n42/42 recall & latency assertions passed.",
            },
          },
        ],
        finalModelMs: 35_000,
        finalReply: "停用词与拼音容错已接入，42 项回归用例全部通过。",
      },
      {
        prompt: "顺便把基准结果导出成 Markdown 摘要贴进 docs/bench.md。",
        // Queued 70s BEFORE turn 2 finished (turn 2 finishes around 920k + 415k = 1,335,000)
        startOffsetMs: 1_265_000,
        steps: [
          {
            modelMs: 95_000, // picks up 70s queue + 25s model generation
            tool: {
              name: "write_file",
              args: { Path: "/home/dev/search-index/docs/bench.md", Overwrite: true },
              durMs: 19_000, // slow op >15s
              output: "Wrote /home/dev/search-index/docs/bench.md (48 lines)",
            },
          },
        ],
        finalModelMs: 30_000,
        finalReply: "已生成 docs/bench.md。",
      },
    ],
  )),
  adapter: "antigravity",
});

const agTokensId = "ag-tokens-64";
files.push({
  path: write(`antigravity/brain/${agTokensId}/.system_generated/logs/transcript.jsonl`, agSession(
    d(2, 10, 20),
    [
      {
        prompt: "统一设计令牌配色，把守恒口径五维语义色收敛进 DESIGN.md。",
        thinking: "先审计全量样式表色值，确认等待确认与中途停了的对比度差值。",
        startOffsetMs: 0,
        steps: [
          {
            modelMs: 55_000,
            tool: {
              name: "grep_search",
              args: { Query: "--state-", SearchPath: "/home/dev/design-tokens/public/style.css" },
              durMs: 12_000,
              output: "Found 11 custom property definitions",
            },
          },
          {
            modelMs: 30_000,
            reviewWaitMs: 165_000,
          },
          {
            modelMs: 40_000,
            idleGapMs: 185_000,
            tool: {
              name: "run_command",
              args: { CommandLine: "npm run lint:tokens" },
              durMs: 21_000,
              output: "Command exited with code 0. Contrast AA/AAA checks passed.",
            },
          },
        ],
        finalModelMs: 38_000,
        finalReply: "令牌已收敛，对比度检查全绿。",
      },
    ],
  )),
  adapter: "antigravity",
});

const agGatewayId = "ag-gateway-88";
files.push({
  path: write(`antigravity/brain/${agGatewayId}/.system_generated/logs/transcript.jsonl`, agSession(
    d(6, 15, 40),
    [
      {
        prompt: "排查网关上游熔断器半开状态偶发抖动问题。",
        thinking: "检查半开探测计数器的并发更新路径。",
        startOffsetMs: 0,
        steps: [
          {
            modelMs: 65_000,
            tool: {
              name: "run_command",
              args: { CommandLine: "go test ./circuit/... -race" },
              durMs: 26_000,
              output: "ok  gateway/circuit  25.412s",
            },
          },
          {
            modelMs: 45_000,
            reviewWaitMs: 140_000,
          },
        ],
        finalModelMs: 40_000,
        finalReply: "竞态已修复，-race 连续 20 次通过。",
      },
    ],
  )),
  adapter: "antigravity",
});

// ---------- Import into the demo store ----------
const store = new Store(path.join(out, "agenttime-demo.sqlite3"));
for (const f of files) {
  try {
    const r = await store.importFile(f.path, null, f.adapter);
    console.log(`imported ${f.adapter}: ${path.basename(f.path)} (events ${r.events})`);
  } catch (e) {
    console.error(`FAILED ${f.adapter}: ${path.basename(f.path)}: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

// Fill display titles & projects for synthetic Antigravity sessions (not derivable from transcript path)
const demoDb = new DatabaseSync(path.join(out, "agenttime-demo.sqlite3"));
const metaPatches: [string, string, string][] = [
  [agSearchId, "搜索索引重建与排序校准", "search-index"],
  [agTokensId, "设计令牌收敛与色板审计", "design-tokens"],
  [agGatewayId, "网关熔断半开抖动修复", "api-gateway"],
];
for (const [sid, title, project] of metaPatches) {
  demoDb.prepare("UPDATE source SET title = ?, project = ? WHERE session_id LIKE '%' || ?").run(title, project, sid);
}
demoDb.close();
store.close();

console.log(`\nDemo data ready at ${out}`);
console.log(`Serve:  npx tsx src/cli.ts --db ${out}/agenttime-demo.sqlite3 serve --port 8766`);
