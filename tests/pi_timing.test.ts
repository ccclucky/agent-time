import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import { report } from "../src/metrics.js";
import { calculatePiTiming } from "../src/store.js";
import { parsePi } from "../src/pi.js";
import type { Event } from "../src/types.js";

// All fixtures are synthetic (no real user content) and use one base epoch so
// every expected number below is hand-derived from the ms offsets.
const B = Date.parse("2026-10-21T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const writeSession = (dir: string, name: string, rows: object[]) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

test("Pi timing: terminated turns fill work/review_wait from duration evidence (no approval gap)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  // Single turn, tool starts exactly at the issuing response end:
  // model a1 [B+1000, B+3000) = 2000ms, bash [B+3000, B+4000) = 1000ms,
  // model a2 [B+4000, B+4500) = 500ms -> work = 3500ms, wait = 0ms.
  const p = writeSession(tmpDir, "no-gap.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000001",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 3001),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: B + 1000,
        durationMs: 2000,
        thinkingLevel: "high",
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: iso(B + 4001),
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: ["ok"],
        durationMs: 1000,
        timestamp: B + 4000,
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: iso(B + 4500),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: B + 4000,
        durationMs: 500,
        thinkingLevel: "high",
      },
    },
  ]);

  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const turn = sessions[0].turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.elapsed_ms, 4500);
  assert.equal(turn.work_ms, 3500);
  assert.equal(turn.review_wait_ms, null);
  assert.equal(turn.human_ms, null);
  assert.equal(turn.breakdown?.model_api_ms, 2500);
  assert.equal(turn.breakdown?.tool_execution_ms, 1000);
  assert.equal(turn.breakdown?.unclassified_delay_ms, 0);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: two-turn session — exact split, model/thinking breakdown, durationMs fallback, standby, report()", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  // Turn 1 [B, B+12100): model glm [1000,3000)=2000 (high); parallel calls —
  // read starts right away [3000,8000)=5000, bash pends approval
  // [3000,6000) then runs [6000,10000)=4000; model opus [10500,12100)=1600
  // (medium). work=12600, wait=3000 (union), tools bash 4000 + read 5000.
  // Turn 2 [B+30000, B+40900): fallback everywhere — model a3 has no
  // durationMs (request 31000, end falls back to record ISO 33100 ->
  // 2100ms), tool result t-C has no durationMs (start falls back to the
  // issuing response end 33100 -> 6900ms, zero measurable wait), model a4
  // [40000,40900)=900. work=9900, wait=0, standby=17900.
  const p = writeSession(tmpDir, "two-turns.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000003",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q1" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 3001),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-A", name: "bash", arguments: {} },
          { type: "toolCall", id: "call-B", name: "read", arguments: {} },
        ],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: B + 1000,
        durationMs: 2000,
        thinkingLevel: "high",
      },
    },
    {
      type: "message",
      id: "tB",
      parentId: "a1",
      timestamp: iso(B + 8001),
      message: {
        role: "toolResult",
        toolCallId: "call-B",
        toolName: "read",
        content: ["ok"],
        durationMs: 5000,
        timestamp: B + 8000,
      },
    },
    {
      type: "message",
      id: "tA",
      parentId: "tB",
      timestamp: iso(B + 10001),
      message: {
        role: "toolResult",
        toolCallId: "call-A",
        toolName: "bash",
        content: ["ok"],
        durationMs: 4000,
        timestamp: B + 10000,
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "tA",
      timestamp: iso(B + 12100),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done 1" }],
        model: "anthropic/claude-opus-4",
        stopReason: "stop",
        timestamp: B + 10500,
        durationMs: 1600,
        thinkingLevel: "medium",
      },
    },
    {
      type: "message",
      id: "u2",
      parentId: "a2",
      timestamp: iso(B + 30000),
      message: { role: "user", content: [{ type: "text", text: "q2" }], timestamp: B + 30000 },
    },
    {
      type: "message",
      id: "a3",
      parentId: "u2",
      // durationMs absent: model end falls back to this record ISO.
      timestamp: iso(B + 33100),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-C", name: "bash", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: B + 31000,
      },
    },
    {
      type: "message",
      id: "tC",
      parentId: "a3",
      // durationMs absent: tool start falls back to the issuing response end.
      timestamp: iso(B + 40001),
      message: {
        role: "toolResult",
        toolCallId: "call-C",
        toolName: "bash",
        content: ["ok"],
        timestamp: B + 40000,
      },
    },
    {
      type: "message",
      id: "a4",
      parentId: "tC",
      timestamp: iso(B + 40900),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done 2" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: B + 40000,
        durationMs: 900,
      },
    },
  ]);

  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.agent, "Pi");
  assert.equal(s.turns.length, 2);

  const t1 = s.turns[0];
  assert.equal(t1.id, "u1");
  assert.equal(t1.status, "completed");
  assert.equal(t1.elapsed_ms, 12100);
  assert.equal(t1.work_ms, 12600);
  // No approval evidence in Pi sources: the 3000ms tool-ready → tool-start
  // gap is unclassified delay; review wait stays unknown (null).
  assert.equal(t1.review_wait_ms, null);
  assert.equal(t1.human_ms, null);
  assert.equal(t1.standby_ms, null);
  assert.equal(t1.breakdown?.model_api_ms, 3600);
  assert.equal(t1.breakdown?.tool_execution_ms, 9000);
  assert.equal(t1.breakdown?.unclassified_delay_ms, 3000);
  assert.deepEqual(t1.breakdown?.tools, [
    { name: "bash", count: 1, duration_ms: 4000 },
    { name: "read", count: 1, duration_ms: 5000 },
  ]);
  assert.deepEqual(t1.breakdown?.model_api_breakdown, [
    { model: "anthropic/claude-opus-4", duration_ms: 1600 },
    { model: "z-ai/glm-5.3", duration_ms: 2000 },
  ]);
  assert.deepEqual(t1.breakdown?.thinking_breakdown, [
    { level: "high", duration_ms: 2000 },
    { level: "medium", duration_ms: 1600 },
  ]);

  const t2 = s.turns[1];
  assert.equal(t2.id, "u2");
  assert.equal(t2.status, "completed");
  assert.equal(t2.elapsed_ms, 10900);
  // Fallback: the unmeasurable gap stays inside tool time (never fabricated
  // as review wait) and the missing durationMs is flagged.
  assert.equal(t2.work_ms, 9900);
  assert.equal(t2.review_wait_ms, null);
  assert.equal(t2.breakdown?.unclassified_delay_ms, 0);
  assert.equal(t2.standby_ms, 17900);
  assert.equal(t2.response_gap_ms, 17900);
  assert.deepEqual(t2.breakdown?.tools, [
    { name: "bash", count: 1, duration_ms: 6900 },
  ]);
  assert.deepEqual(t2.breakdown?.model_api_breakdown, [
    { model: "z-ai/glm-5.3", duration_ms: 3000 },
  ]);
  assert.deepEqual(t2.breakdown?.thinking_breakdown, []);
  assert.ok(
    s.issues.some((i) => i.includes("durationMs")),
    "fallback must surface an issue instead of inventing timing",
  );

  // Session-level aggregation.
  assert.equal(s.work_ms, 22500);
  assert.equal(s.review_wait_ms, null);
  assert.equal(s.standby_ms, 17900);

  // report() aggregation for the Pi filter.
  const rep = report(sessions, "2026-10-21", "2026-10-21", "UTC", "Pi");
  assert.equal(rep.summary.processing_ms, 23000);
  assert.equal(rep.summary.processing_union_ms, 23000);
  assert.equal(rep.summary.overlap_ms, 0);
  assert.equal(rep.summary.work_ms, 22500);
  assert.equal(rep.summary.review_wait_ms, null);
  assert.equal(rep.summary.human_ms, null);
  assert.equal(rep.summary.standby_ms, 17900);
  assert.equal(rep.summary.sessions, 1);
  assert.equal(rep.summary.turns, 2);
  assert.equal(rep.summary.measured_turns, 2);
  assert.equal(rep.summary.statuses.completed, 2);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: parallel calls share one approval gap (interval union, not sum) and tools[] aggregates by name", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  // One assistant response [B+1000, B+3000) issues two parallel calls; both
  // hang on the same approval until B+6000, then run in parallel:
  // bash [B+6000, B+10000) = 4000ms, read [B+6000, B+9000) = 3000ms, final
  // model [B+10000, B+11600) = 1600ms. Both waits are [B+3000, B+6000), so
  // the union is 3000ms (a naive sum would double-count 6000ms).
  const p = writeSession(tmpDir, "parallel-gap.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000002",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 3001),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-A", name: "bash", arguments: {} },
          { type: "toolCall", id: "call-B", name: "read", arguments: {} },
        ],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: B + 1000,
        durationMs: 2000,
        thinkingLevel: "high",
      },
    },
    {
      type: "message",
      id: "tB",
      parentId: "a1",
      timestamp: iso(B + 9001),
      message: {
        role: "toolResult",
        toolCallId: "call-B",
        toolName: "read",
        content: ["ok"],
        durationMs: 3000,
        timestamp: B + 9000,
      },
    },
    {
      type: "message",
      id: "tA",
      parentId: "tB",
      timestamp: iso(B + 10001),
      message: {
        role: "toolResult",
        toolCallId: "call-A",
        toolName: "bash",
        content: ["ok"],
        durationMs: 4000,
        timestamp: B + 10000,
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "tA",
      timestamp: iso(B + 11600),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: B + 10000,
        durationMs: 1600,
      },
    },
  ]);

  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const turn = store.sessions()[0].turns[0];
  assert.equal(turn.elapsed_ms, 11600);
  assert.equal(turn.review_wait_ms, null);
  assert.equal(turn.breakdown?.unclassified_delay_ms, 3000);
  // Machine accumulation: 2000 + 4000 + 3000 + 1600 = 10600.
  assert.equal(turn.work_ms, 10600);
  assert.deepEqual(turn.breakdown?.tools, [
    { name: "bash", count: 1, duration_ms: 4000 },
    { name: "read", count: 1, duration_ms: 3000 },
  ]);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: report basis documents the Pi measurement methodology", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  const p = writeSession(tmpDir, "basis.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000004",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 2000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: B + 500,
        durationMs: 1500,
      },
    },
  ]);
  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const rep = report(store.sessions(), "2026-10-21", "2026-10-21", "UTC", "Pi");
  assert.ok(rep.basis.includes("Pi"), "basis must cover the Pi 口径");
  assert.ok(rep.basis.includes("机时累加"));
  assert.ok(rep.basis.includes("未分类延迟"));
  assert.ok(rep.basis.includes("不落盘审批事件"));

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: parsePi no longer tells users the three-state split is coming", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  const p = writeSession(tmpDir, "no-notice.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000005",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
  ]);
  const data = parsePi(p);
  assert.ok(
    !data.issues.some((i) => i.includes("后续版本") || i.includes("暂不显示")),
    "timing exists now; the informational issue must be gone",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: marker events without end_ms and invalid spans contribute zero, never fabricate", () => {
  // Unit seam, mirroring calculateClaudeTiming's direct testability.
  const ev = (e: Partial<Event>): Event => ({
    key: JSON.stringify(e),
    turn_id: "u1",
    kind: "model",
    at_ms: 0,
    model: null,
    ...e,
  } as Event);
  const timing = calculatePiTiming(
    [
      // model_change marker: a point in time, no duration evidence.
      ev({ kind: "model", at_ms: 1000, model: "dp-llm/qwen" }),
      // Real response span: 3000ms.
      ev({ kind: "model", at_ms: 2000, end_ms: 5000, model: "z-ai/glm-5.3" }),
      // Tool result with no issuing tool_use: duration still counts, no wait.
      ev({ kind: "tool_result", at_ms: 5000, end_ms: 9000, tool_name: "bash" }),
      // Inverted span (end before start): treated as missing evidence, 0ms.
      ev({ kind: "tool_result", at_ms: 6000, end_ms: 5900, tool_id: "x", tool_name: "bash" }),
    ],
    0,
    9000,
    9000,
  );
  assert.equal(timing.work_ms, 7000);
  assert.equal(timing.review_wait_ms, null);
  assert.equal(timing.breakdown.unclassified_delay_ms, 0);
  assert.equal(timing.breakdown.model_api_ms, 3000);
  assert.equal(timing.breakdown.tool_execution_ms, 4000);
  assert.deepEqual(timing.breakdown.tools, [
    { name: "bash", count: 2, duration_ms: 4000 },
  ]);
  assert.deepEqual(timing.breakdown.model_api_breakdown, [
    { model: "z-ai/glm-5.3", duration_ms: 3000 },
  ]);
  assert.deepEqual(timing.breakdown.thinking_breakdown, []);
});

test("Pi timing: assistant response without a model name still counts its duration as 未知模型", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  // a1 omits message.model entirely: the response span [B+500, B+2000) is
  // still first-hand evidence and must land in work_ms, bucketed as
  // 未知模型 in model_api_breakdown instead of being silently dropped.
  const p = writeSession(tmpDir, "no-model.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000007",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 2000),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        timestamp: B + 500,
        durationMs: 1500,
        thinkingLevel: "low",
      },
    },
  ]);
  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const turn = store.sessions()[0].turns[0];
  assert.equal(turn.status, "completed");
  assert.equal(turn.work_ms, 1500);
  assert.equal(turn.breakdown?.model_api_ms, 1500);
  assert.deepEqual(turn.breakdown?.model_api_breakdown, [
    { model: "未知模型", duration_ms: 1500 },
  ]);
  assert.deepEqual(turn.breakdown?.thinking_breakdown, [
    { level: "low", duration_ms: 1500 },
  ]);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi timing: open turns keep null timing instead of guessing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pit-"));
  const p = writeSession(tmpDir, "open-turn.jsonl", [
    {
      type: "session",
      version: 3,
      id: "pit-0000-0000-0000-000000000006",
      timestamp: iso(B),
      cwd: "/work/demo_app",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 3000),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: B + 1000,
        durationMs: 2000,
      },
    },
    // No tool result, no terminal event: the turn is still open.
  ]);
  const store = new Store(path.join(tmpDir, "test.db"));
  store.importFile(p, null, "pi");
  const turn = store.sessions()[0].turns[0];
  assert.equal(turn.status, "open");
  assert.equal(turn.work_ms, null);
  assert.equal(turn.review_wait_ms, null);
  assert.equal(turn.breakdown, null);
  const sessions = store.sessions();
  assert.equal(sessions[0].work_ms, null);
  assert.equal(sessions[0].review_wait_ms, null);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
