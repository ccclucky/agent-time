import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// slice 14 · 守恒口径（用户视角）：等待 = 干活（模型响应 + 工具执行）+ 等待
// 审阅 + 中途停了。中途停了仅 Antigravity 启用；排队不产生负间隔。

import { Store, calculateEventTiming } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { report } from "../src/metrics.js";
import type { Event } from "../src/types.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-ledger-"))),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return { dir, store, home, dirs: new Directories(store, home, {}, process.platform) };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const agSession = (records: unknown[]) =>
  records.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("Antigravity：轮内 ≥2 分钟无事件缝隙单列为中途停了，守恒成立", async () => {
  const { dir, store } = setup();
  const root = path.join(dir, "ag-home");
  const logs = path.join(root, "brain", "aaaaaaaa-0000-4000-8000-00000000ledger", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "transcript.jsonl"),
    agSession([
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 0, created_at: "2026-11-01T00:00:00Z", content: "你好" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-11-01T00:01:00Z", tool_calls: [{ name: "run_command", args: {} }], content: "" },
      { type: "GENERIC", source: "MODEL", step_index: 2, created_at: "2026-11-01T00:03:00Z", content: "done" },
      // 00:03 → 00:07 无任何记录（4 分钟 ≥ 2 分钟阈值）→ 中途停了
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 3, created_at: "2026-11-01T00:07:00Z", tool_calls: [], content: "答复" },
    ]),
  );
  await store.importFile(path.join(logs, "transcript.jsonl"), root, "antigravity");
  const t = store.sessions()[0].turns[0];
  // 守恒：模型 1m + 工具 2m + 中途停了 4m = 等待 7m
  assert.equal(t.elapsed_ms, 420000);
  assert.equal(t.breakdown?.tool_execution_ms, 120000);
  assert.equal(t.breakdown?.idle_gap_ms, 240000);
  assert.equal(t.breakdown?.model_api_ms, 60000);
  assert.equal(t.review_wait_ms, 0);
  assert.equal(t.work_ms, 180000, "干活 = 模型 + 工具，不含中途停了");
  assert.equal(
    (t.breakdown!.model_api_ms ?? 0) + t.breakdown!.tool_execution_ms + (t.breakdown!.idle_gap_ms ?? 0) + (t.review_wait_ms ?? 0),
    t.elapsed_ms!,
    "守恒恒等式：干活 + 停了 + 审阅 = 等待",
  );
});

test("Antigravity：排队输入记录 queue_wait_ms，轮间待命保持 null，无负间隔", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "ag-home");
  const logs = path.join(root, "brain", "aaaaaaaa-0000-4000-8000-00000000queue", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  // 轮 A：00:00 发出 → 01:00 答复完毕；轮 B：00:30 排队发出（文件顺序在 A 之后，
  // 模拟 USER_INPUT 懒落盘），01:01 接单，01:10 答复完毕。
  writeFileSync(
    path.join(logs, "transcript.jsonl"),
    agSession([
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 0, created_at: "2026-11-01T00:00:00Z", content: "第一条" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-11-01T01:00:00Z", tool_calls: [], content: "A 答复" },
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 2, created_at: "2026-11-01T00:30:00Z", content: "第二条（排队）" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 3, created_at: "2026-11-01T01:01:00Z", tool_calls: [], content: "" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 4, created_at: "2026-11-01T01:10:00Z", tool_calls: [], content: "B 答复" },
    ]),
  );
  dirs.save("antigravity", root, true);
  await store.refresh(dirs);
  const s = store.sessions()[0];
  assert.equal(s.turns.length, 2);
  const b = s.turns[1];
  assert.equal(b.queue_wait_ms, 1800000, "排队 30 分钟（上一轮未答完）");
  assert.equal(b.standby_ms, null, "排队轮无轮间空档，不产生负待命");
  // 发出→接单 31 分钟（忙上一条）与接单→答复 9 分钟（生成期，无法与停摆区分）
  // 均 ≥2 分钟，按已批准口径统一记中途停了——宁可少报干活，不编造归因。
  assert.equal(b.breakdown?.idle_gap_ms, 2400000);
  assert.equal(b.breakdown?.model_api_ms, 0);
  // 守恒：中途停了 40m = 等待 40m（无工具、无审阅）
  assert.equal(b.elapsed_ms, 2400000);
  assert.equal(
    (b.breakdown!.idle_gap_ms ?? 0) + b.breakdown!.model_api_ms + b.breakdown!.tool_execution_ms + (b.review_wait_ms ?? 0),
    b.elapsed_ms!,
  );
  assert.equal(s.queue_count, 1);
  assert.equal(s.queue_wait_ms, 1800000);
  assert.equal(s.last_done_ms, b.end_ms, "末轮答复完毕时刻 = 收尾空档锚点");
});

test("Claude/Codex：长挂起阈值分档——短缝隙归生成，跨小时空洞归停摆", () => {
  const entries: Event[] = [
    { key: "k1", turn_id: "t", kind: "start", at_ms: 0, model: null },
    { key: "k2", turn_id: "t", kind: "tool_use", at_ms: 60000, model: null, tool_id: "tool-1", tool_name: "bash" },
    { key: "k3", turn_id: "t", kind: "tool_result", at_ms: 180000, model: null, tool_id: "tool-1", tool_name: "bash" },
    // 180000 → 420000 无事件（4 分钟）：Claude 交互式轮次里这是模型在慢生成
    { key: "k4", turn_id: "t", kind: "complete", at_ms: 420000, model: null },
  ];
  const claude = calculateEventTiming(entries, 0, 420000, 420000, {
    idleGapMinMs: 1800000,
  });
  assert.equal(claude.breakdown.idle_gap_ms, 0, "4 分钟 < 30 分钟长挂起阈值 → 归模型响应");
  assert.equal(claude.breakdown.model_api_ms, 300000);
  assert.equal(claude.work_ms, 420000);

  // 同样的缝隙按 Antigravity 阈值（2 分钟）则单列为停摆
  const ag = calculateEventTiming(entries, 0, 420000, 420000, {
    idleGapMinMs: 120000,
  });
  assert.equal(ag.breakdown.idle_gap_ms, 240000, "Antigravity 阈值下同一缝隙为停摆");
  assert.equal(ag.breakdown.model_api_ms, 60000);
  assert.equal(ag.work_ms, 180000);
});

test("Antigravity：不到 2 分钟的缝隙不算中途停了（归模型响应）", async () => {
  const { dir, store } = setup();
  const root = path.join(dir, "ag-home");
  const logs = path.join(root, "brain", "aaaaaaaa-0000-4000-8000-00000000sub2m", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "transcript.jsonl"),
    agSession([
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 0, created_at: "2026-11-01T00:00:00Z", content: "你好" },
      // 110 秒的响应间隙 < 120 秒阈值 → 模型慢生成，不算停摆
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-11-01T00:01:50Z", tool_calls: [], content: "答复" },
    ]),
  );
  await store.importFile(path.join(logs, "transcript.jsonl"), root, "antigravity");
  const t = store.sessions()[0].turns[0];
  assert.equal(t.breakdown?.idle_gap_ms, 0);
  assert.equal(t.breakdown?.model_api_ms, t.elapsed_ms, "全部等待计入模型响应");
});

test("OMP/Pi 系：跨天无事件空洞单列为停摆（1250h 实证口径）", async () => {
  const { dir, store } = setup();
  const root = path.join(dir, "omp-root");
  const slugDir = path.join(root, "sessions", "-work-omp");
  mkdirSync(slugDir, { recursive: true });
  const T0 = Date.parse("2026-08-13T11:45:00Z");
  const APPEND = T0 + 52 * 24 * 3600 * 1000; // 52 天后结果才落盘
  const file = path.join(slugDir, "0199bbbb-0000-4000-8000-0000000000a1.jsonl");
  const iso = (ms: number) => new Date(ms).toISOString();
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "omp-idle-1", timestamp: iso(T0 - 120000), cwd: "/work/omp" }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: "prev",
        timestamp: iso(T0),
        message: { role: "user", attribution: "user", timestamp: T0, content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: "u1",
        // 外层 timestamp = 结果落盘时刻（52 天后），message.timestamp = 请求起点
        timestamp: iso(APPEND),
        message: {
          role: "assistant",
          attribution: "assistant",
          timestamp: T0 + 60000,
          duration: 74000,
          model: "test-model",
          provider: "new-api",
          api: "openai-completions",
          stopReason: "stop",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ].join("\n") + "\n",
  );
  await store.importFile(file, root, "omp");
  const s = store.sessions()[0];
  const t = s.turns[0];
  // 轮次墙钟 ≈ 52 天；work = 模型机时 74s（诚实计量）；52 天长空洞 → 停了
  assert.equal(t.status, "completed");
  assert.equal(t.breakdown?.model_api_ms, 74000, "模型机时按 span 诚实计量");
  assert.ok(
    (t.breakdown?.idle_gap_ms ?? 0) > 50 * 24 * 3600000,
    "52 天无事件空洞单列为停摆",
  );
});

test("report：停摆与排队进入汇总口径", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "ag-home");
  const logs = path.join(root, "brain", "aaaaaaaa-0000-4000-8000-00000000rept", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(
    path.join(logs, "transcript.jsonl"),
    agSession([
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 0, created_at: "2026-11-01T00:00:00Z", content: "第一条" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 1, created_at: "2026-11-01T01:00:00Z", tool_calls: [], content: "A" },
      { type: "USER_INPUT", source: "USER_EXPLICIT", step_index: 2, created_at: "2026-11-01T00:30:00Z", content: "第二条" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 3, created_at: "2026-11-01T01:01:00Z", tool_calls: [], content: "" },
      { type: "PLANNER_RESPONSE", source: "MODEL", step_index: 4, created_at: "2026-11-01T01:10:00Z", tool_calls: [], content: "B" },
    ]),
  );
  dirs.save("antigravity", root, true);
  await store.refresh(dirs);
  const rep = report(store.sessions(), "2026-11-01", "2026-11-01", "UTC", "Antigravity");
  assert.equal(rep.summary.idle_gap_ms, 3600000 + 2400000, "轮 A 60m + 轮 B 40m");
  assert.equal(rep.summary.queue_count, 1);
  assert.equal(rep.summary.queue_wait_ms, 1800000);
});
