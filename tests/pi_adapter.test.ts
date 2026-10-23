import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parsePi } from "../src/pi.js";
import { ValidationError } from "../src/types.js";
import { Store } from "../src/store.js";

const writeSession = (dir: string, name: string, rows: object[]) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
};

test("Pi: parses session header and emits start on user message", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const p = writeSession(
    tmpDir,
    "2026-10-09T22-03-15-000Z_01a122b0-a300-7113-8773-07227583e9b1.jsonl",
    [
      {
        type: "session",
        version: 3,
        id: "01a122b0-a300-7113-8773-07227583e9b1",
        timestamp: "2026-10-09T22:03:15.000Z",
        cwd: "/Users/demo/work/my_project",
      },
      {
        type: "message",
        id: "63c30b96",
        parentId: null,
        timestamp: "2026-10-09T22:03:15.437Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: 1791583395437,
        },
      },
    ],
  );

  const data = parsePi(p);
  assert.equal(data.session.id, "pi/01a122b0-a300-7113-8773-07227583e9b1");
  assert.equal(data.session.agent, "Pi");
  assert.equal(data.session.project, "my_project");
  assert.equal(data.session.client, "pi");

  assert.equal(data.events.length, 1);
  const start = data.events[0];
  assert.equal(start.kind, "start");
  assert.equal(start.turn_id, "63c30b96");
  assert.equal(start.at_ms, Date.parse("2026-10-09T22:03:15.437Z"));
  assert.ok(start.key.length > 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: maps a full turn sequence (model/tool_use/tool_result/terminal) with end_ms evidence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  // Numbers verified against the research notes' real-world correlation:
  // request start 22:03:15.458Z + durationMs 1904 -> response end 22:03:17.362Z,
  // record appended 22:03:17.363Z; toolResult created 22:03:17.394Z minus
  // durationMs 27 -> tool start 22:03:17.367Z.
  const p = writeSession(tmpDir, "turn-seq.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000001",
      timestamp: "2026-10-09T22:03:15.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:03:15.437Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "run the build" }],
        timestamp: T("2026-10-09T22:03:15.437Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:17.363Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "<omitted>" },
          { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
        ],
        api: "openai-completions",
        provider: "demo",
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: T("2026-10-09T22:03:15.458Z"),
        durationMs: 1904,
        thinkingLevel: "high",
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-10-09T22:03:17.394Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: ["ok"],
        isError: false,
        durationMs: 27,
        timestamp: T("2026-10-09T22:03:17.394Z"),
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: "2026-10-09T22:03:20.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:17.400Z"),
        durationMs: 2600,
        thinkingLevel: "high",
      },
    },
    // Turn already closed by "stop"; a stray assistant without a new user
    // message must not open a turn nor emit events.
    {
      type: "message",
      id: "a3",
      parentId: "a2",
      timestamp: "2026-10-09T22:03:25.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "orphan" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:24.000Z"),
      },
    },
  ]);

  const data = parsePi(p);
  const kinds = data.events.map((e) => e.kind);
  assert.deepEqual(kinds, [
    "start",
    "model",
    "tool_use",
    "tool_result",
    "model",
    "complete",
  ]);

  const [start, model1, toolUse, toolResult, model2, complete] = data.events;
  assert.equal(start.turn_id, "u1");
  assert.ok(data.events.every((e) => e.turn_id === "u1"));

  assert.equal(model1.model, "z-ai/glm-5.3");
  assert.equal(model1.at_ms, T("2026-10-09T22:03:15.458Z"));
  assert.equal(model1.end_ms, T("2026-10-09T22:03:17.362Z"));
  assert.equal(model1.thinking_level, "high");

  assert.equal(toolUse.tool_id, "call-1");
  assert.equal(toolUse.tool_name, "bash");
  assert.equal(toolUse.at_ms, T("2026-10-09T22:03:17.362Z"));

  assert.equal(toolResult.tool_id, "call-1");
  assert.equal(toolResult.tool_name, "bash");
  assert.equal(toolResult.at_ms, T("2026-10-09T22:03:17.367Z"));
  assert.equal(toolResult.end_ms, T("2026-10-09T22:03:17.394Z"));

  assert.equal(model2.at_ms, T("2026-10-09T22:03:17.400Z"));
  assert.equal(model2.end_ms, T("2026-10-09T22:03:20.000Z"));

  assert.equal(complete.at_ms, T("2026-10-09T22:03:20.000Z"));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: terminal stopReason maps length->complete, aborted->abort, error->fail; toolUse/deferred keep the turn open", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const mk = (id: string, stop: string, minute: number) => ({
    type: "message",
    id,
    parentId: null,
    timestamp: `2026-10-09T22:0${minute}:00.000Z`,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      model: "m",
      stopReason: stop,
      timestamp: Date.parse(`2026-10-09T22:0${minute}:00.000Z`),
    },
  });
  const p = writeSession(tmpDir, "terminals.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000002",
      timestamp: "2026-10-09T22:00:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: Date.parse("2026-10-09T22:01:00.000Z") },
    },
    mk("a1", "toolUse", 2),
    mk("a2", "deferred", 3),
    mk("a3", "pending", 4),
    mk("a4", "length", 5),
  ]);
  const data = parsePi(p);
  assert.deepEqual(
    data.events.map((e) => e.kind),
    ["start", "model", "model", "model", "model", "complete"],
  );
  assert.ok(data.events.every((e) => e.turn_id === "u1"));

  // Now an aborted turn and a failed turn in a separate session file.
  const p2 = writeSession(tmpDir, "terminals2.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000003",
      timestamp: "2026-10-09T22:00:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u9",
      parentId: null,
      timestamp: "2026-10-09T22:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: Date.parse("2026-10-09T22:01:00.000Z") },
    },
    mk("a9", "aborted", 2),
  ]);
  const d2 = parsePi(p2);
  assert.deepEqual(
    d2.events.map((e) => e.kind),
    ["start", "model", "abort"],
  );

  const p3 = writeSession(tmpDir, "terminals3.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000004",
      timestamp: "2026-10-09T22:00:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u8",
      parentId: null,
      timestamp: "2026-10-09T22:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "q" }], timestamp: Date.parse("2026-10-09T22:01:00.000Z") },
    },
    mk("a8", "error", 2),
  ]);
  const d3 = parsePi(p3);
  assert.deepEqual(
    d3.events.map((e) => e.kind),
    ["start", "model", "fail"],
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: approval gap is observable when durationMs is present (seconds-level)", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  // Assistant response ends at 22:03:17.362Z; the tool only starts 5s later
  // (approval pended), runs 1s, result created at 22:03:23.362Z.
  // toolResult.durationMs = 1000 -> tool start 22:03:22.362Z, i.e. a
  // 5000ms observable gap after the issuing response end.
  const p = writeSession(tmpDir, "approval-gap.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000011",
      timestamp: "2026-10-09T22:03:15.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:03:15.437Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "needs approval" }],
        timestamp: T("2026-10-09T22:03:15.437Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:17.363Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-gap", name: "bash", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: T("2026-10-09T22:03:15.458Z"),
        durationMs: 1904,
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-10-09T22:03:23.363Z",
      message: {
        role: "toolResult",
        toolCallId: "call-gap",
        toolName: "bash",
        content: ["ok"],
        durationMs: 1000,
        timestamp: T("2026-10-09T22:03:23.362Z"),
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: "2026-10-09T22:03:24.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:23.400Z"),
        durationMs: 600,
      },
    },
  ]);

  const data = parsePi(p);
  const toolUse = data.events.find((e) => e.kind === "tool_use")!;
  const toolResult = data.events.find((e) => e.kind === "tool_result")!;
  assert.equal(toolUse.at_ms, T("2026-10-09T22:03:17.362Z"));
  assert.equal(toolResult.at_ms, T("2026-10-09T22:03:22.362Z"));
  assert.equal(toolResult.end_ms, T("2026-10-09T22:03:23.362Z"));
  // The seconds-level approval gap is derivable: tool start - response end.
  assert.equal(toolResult.at_ms - toolUse.at_ms, 5000);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: falls back when durationMs is missing (model end and tool start) and records issues", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  const p = writeSession(tmpDir, "no-duration.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000012",
      timestamp: "2026-10-09T22:03:15.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:03:15.437Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: T("2026-10-09T22:03:15.437Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      // durationMs absent: model end_ms falls back to record append ISO.
      timestamp: "2026-10-09T22:03:19.100Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-nb", name: "read", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: T("2026-10-09T22:03:17.000Z"),
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      // durationMs absent: tool start falls back to issuing response end
      // (22:03:19.100Z) and an issue is recorded.
      timestamp: "2026-10-09T22:03:25.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-nb",
        toolName: "read",
        content: ["ok"],
        timestamp: T("2026-10-09T22:03:25.000Z"),
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: "2026-10-09T22:03:26.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:25.500Z"),
      },
    },
  ]);

  const data = parsePi(p);
  const model1 = data.events.find(
    (e) => e.kind === "model" && e.at_ms === T("2026-10-09T22:03:17.000Z"),
  )!;
  assert.equal(model1.end_ms, T("2026-10-09T22:03:19.100Z"));

  const toolResult = data.events.find((e) => e.kind === "tool_result")!;
  assert.equal(toolResult.at_ms, T("2026-10-09T22:03:19.100Z"));
  assert.equal(toolResult.end_ms, T("2026-10-09T22:03:25.000Z"));
  assert.ok(
    data.issues.some((i) => i.includes("durationMs")),
    "missing tool durationMs must be flagged as an issue",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: model_change and thinking_level_change emit model events with evidence", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  const p = writeSession(tmpDir, "model-change.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000013",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    // Session-initial model change happens before any user turn; it is
    // attributed to the turn the next user message opens.
    {
      type: "model_change",
      id: "mc1",
      parentId: null,
      timestamp: "2026-10-09T22:03:00.500Z",
      provider: "dp-llm",
      modelId: "Qwen3.6-35B-A3B",
    },
    {
      type: "message",
      id: "u1",
      parentId: "mc1",
      timestamp: "2026-10-09T22:03:05.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: T("2026-10-09T22:03:05.000Z"),
      },
    },
    // First response keeps the turn open (toolUse) and carries no level.
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:07.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        model: "Qwen3.6-35B-A3B",
        stopReason: "toolUse",
        timestamp: T("2026-10-09T22:03:05.200Z"),
        durationMs: 1800,
      },
    },
    // Level switch while the turn is still open emits a model event with the
    // new level and no model name.
    {
      type: "thinking_level_change",
      id: "tl1",
      parentId: "a1",
      timestamp: "2026-10-09T22:03:07.500Z",
      thinkingLevel: "medium",
    },
    // Final response lacks thinkingLevel; the switched level applies.
    {
      type: "message",
      id: "a2",
      parentId: "tl1",
      timestamp: "2026-10-09T22:03:09.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final" }],
        model: "Qwen3.6-35B-A3B",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:08.000Z"),
        durationMs: 1000,
      },
    },
  ]);

  const data = parsePi(p);
  assert.deepEqual(
    data.events.map((e) => e.kind),
    ["start", "model", "model", "model", "model", "complete"],
  );
  const models = data.events.filter((e) => e.kind === "model");

  const change = models[0];
  assert.equal(change.model, "dp-llm/Qwen3.6-35B-A3B");
  assert.equal(change.at_ms, T("2026-10-09T22:03:00.500Z"));
  assert.equal(change.turn_id, "u1");

  const first = models[1];
  assert.equal(first.model, "Qwen3.6-35B-A3B");
  assert.ok(first.thinking_level == null);

  const levelSwitch = models[2];
  assert.equal(levelSwitch.model, null);
  assert.equal(levelSwitch.thinking_level, "medium");
  assert.equal(levelSwitch.at_ms, T("2026-10-09T22:03:07.500Z"));

  const final = models[3];
  assert.equal(final.model, "Qwen3.6-35B-A3B");
  assert.equal(final.thinking_level, "medium");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: skips non-user-flow entries and unknown types; bad lines become issues", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  const rows: object[] = [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000014",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    { type: "compaction", id: "c1", parentId: null, timestamp: "2026-10-09T22:03:00.100Z" },
    { type: "context_edit", id: "ce1", parentId: "c1", timestamp: "2026-10-09T22:03:00.200Z" },
    { type: "branch_summary", id: "bs1", parentId: "ce1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "custom", id: "cu1", parentId: "bs1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "custom_message", id: "cm1", parentId: "cu1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "label", id: "l1", parentId: "cm1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "session_info", id: "si1", parentId: "l1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "usage", id: "us1", parentId: "si1", timestamp: "2026-10-09T22:03:00.300Z" },
    { type: "mystery_entry", id: "mx1", parentId: "us1", timestamp: "2026-10-09T22:03:00.300Z" },
    {
      type: "message",
      id: "sys1",
      parentId: "mx1",
      timestamp: "2026-10-09T22:03:00.400Z",
      message: { role: "system", content: "", timestamp: T("2026-10-09T22:03:00.400Z") },
    },
    {
      type: "message",
      id: "u1",
      parentId: "sys1",
      timestamp: "2026-10-09T22:03:05.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: T("2026-10-09T22:03:05.000Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:07.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        model: "m",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:05.200Z"),
        durationMs: 1800,
      },
    },
  ];
  const p = path.join(tmpDir, "skips.jsonl");
  fs.writeFileSync(
    p,
    rows.map((r) => JSON.stringify(r)).join("\n") +
      "\n{ this is not json\n" +
      JSON.stringify({
        type: "message",
        id: "u2",
        parentId: null,
        timestamp: "2026-10-09T22:04:05.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "second" }],
          timestamp: T("2026-10-09T22:04:05.000Z"),
        },
      }) +
      "\n",
  );

  const data = parsePi(p);
  // Only the two user turns produce events; skips never open turns or leak in.
  assert.deepEqual(
    data.events.map((e) => `${e.kind}:${e.turn_id}`),
    ["start:u1", "model:u1", "complete:u1", "start:u2"],
  );
  assert.ok(
    data.issues.some((i) => i.includes("无法解析")),
    "malformed line becomes an issue",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: rejects version > 3 sessions and mixed session ids", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const future = writeSession(tmpDir, "future.jsonl", [
    {
      type: "session",
      version: 4,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000021",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
  ]);
  assert.throws(() => parsePi(future), ValidationError);

  // Older versions within the known contract are accepted.
  const v1 = writeSession(tmpDir, "v1.jsonl", [
    {
      type: "session",
      version: 1,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000022",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:03:05.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: Date.parse("2026-10-09T22:03:05.000Z"),
      },
    },
  ]);
  const d1 = parsePi(v1);
  assert.equal(d1.session.id, "pi/aaaabbbb-cccc-dddd-eeee-ffff00000022");
  assert.equal(d1.events.length, 1);

  // A second, different session header in the same file means mixed content.
  const mixed = writeSession(tmpDir, "mixed.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000023",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000024",
      timestamp: "2026-10-09T22:04:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
  ]);
  assert.throws(() => parsePi(mixed), ValidationError);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: missing cwd falls back to decoding the encoded directory name with an issue", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  // Encoding rule: strip leading /, replace / \ : with -, wrap in --.
  // /Users/demo/work/my_first_network -> --Users-demo-work-my_first_network--
  const encodedDir = path.join(tmpDir, "--Users-demo-work-my_first_network--");
  fs.mkdirSync(encodedDir);
  const p = path.join(
    encodedDir,
    "2026-10-09T22-03-15-000Z_aaaabbbb-cccc-dddd-eeee-ffff00000031.jsonl",
  );
  fs.writeFileSync(
    p,
    [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "aaaabbbb-cccc-dddd-eeee-ffff00000031",
        timestamp: "2026-10-09T22:03:00.000Z",
        // cwd intentionally absent (v1-era session).
      }),
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-10-09T22:03:05.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "q" }],
          timestamp: Date.parse("2026-10-09T22:03:05.000Z"),
        },
      }),
    ].join("\n") + "\n",
  );

  const data = parsePi(p);
  assert.equal(data.session.project, "my_first_network");
  assert.ok(
    data.issues.some((i) => i.includes("cwd") && i.includes("解码")),
    "cwd fallback must be flagged as lossy-decoded",
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: imports through Store.importFile into sessions() with end_ms/thinking_level columns", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const T = (s: string) => Date.parse(s);
  const p = writeSession(tmpDir, "store-import.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000041",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "model_change",
      id: "mc1",
      parentId: null,
      timestamp: "2026-10-09T22:03:00.500Z",
      provider: "dp-llm",
      modelId: "Qwen3.6-35B-A3B",
    },
    {
      type: "message",
      id: "u1",
      parentId: "mc1",
      timestamp: "2026-10-09T22:03:05.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: T("2026-10-09T22:03:05.000Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:17.363Z",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        model: "z-ai/glm-5.3",
        stopReason: "toolUse",
        timestamp: T("2026-10-09T22:03:15.458Z"),
        durationMs: 1904,
        thinkingLevel: "high",
      },
    },
    {
      type: "message",
      id: "t1",
      parentId: "a1",
      timestamp: "2026-10-09T22:03:17.394Z",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: ["ok"],
        durationMs: 27,
        timestamp: T("2026-10-09T22:03:17.394Z"),
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "t1",
      timestamp: "2026-10-09T22:03:20.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:17.400Z"),
        durationMs: 2600,
        thinkingLevel: "high",
      },
    },
  ]);

  const store = new Store(path.join(tmpDir, "test.db"));
  const result = store.importFile(p, null, "pi");
  assert.ok(result.events > 0);

  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, "pi/aaaabbbb-cccc-dddd-eeee-ffff00000041");
  assert.equal(s.agent, "Pi");
  assert.equal(s.project, "my_project");
  assert.equal(s.turns.length, 1);

  const turn = s.turns[0];
  assert.equal(turn.id, "u1");
  assert.equal(turn.status, "completed");
  assert.equal(turn.start_ms, T("2026-10-09T22:03:05.000Z"));
  assert.equal(turn.end_ms, T("2026-10-09T22:03:20.000Z"));
  // Timing split lands in the next ticket; this ticket must not fake it.
  assert.equal(turn.work_ms, null);
  assert.deepEqual(turn.models.sort(), ["dp-llm/Qwen3.6-35B-A3B", "z-ai/glm-5.3"]);

  const model = turn.events.find(
    (e) => e.kind === "model" && e.model === "z-ai/glm-5.3" && e.at_ms === T("2026-10-09T22:03:15.458Z"),
  )!;
  assert.equal(model.end_ms, T("2026-10-09T22:03:17.362Z"));
  assert.equal(model.thinking_level, "high");

  const toolResult = turn.events.find((e) => e.kind === "tool_result")!;
  assert.equal(toolResult.end_ms, T("2026-10-09T22:03:17.394Z"));

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Pi: Store migrates a legacy event table by adding end_ms and thinking_level", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-pi-"));
  const dbPath = path.join(tmpDir, "legacy.db");
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE source (
      id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
      project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL, last_error TEXT, config_root TEXT,
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE event (
      source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
      key TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL, model TEXT, agent_id TEXT, tool_id TEXT, tool_name TEXT,
      PRIMARY KEY(source_id,key)
    );
  `);
  raw.close();

  // Constructing Store on the legacy DB must add the new columns in place.
  const store = new Store(dbPath);
  const cols = store.db
    .prepare("PRAGMA table_info(event)")
    .all()
    .map((r) => (r as { name: string }).name);
  assert.ok(cols.includes("end_ms"));
  assert.ok(cols.includes("thinking_level"));

  const T = (s: string) => Date.parse(s);
  const p = writeSession(tmpDir, "migrate-import.jsonl", [
    {
      type: "session",
      version: 3,
      id: "aaaabbbb-cccc-dddd-eeee-ffff00000042",
      timestamp: "2026-10-09T22:03:00.000Z",
      cwd: "/Users/demo/work/my_project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-10-09T22:03:05.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "q" }],
        timestamp: T("2026-10-09T22:03:05.000Z"),
      },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-10-09T22:03:07.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        model: "m",
        stopReason: "stop",
        timestamp: T("2026-10-09T22:03:05.200Z"),
        durationMs: 1800,
      },
    },
  ]);
  store.importFile(p, null, "pi");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const model = sessions[0].turns[0].events.find((e) => e.kind === "model")!;
  assert.equal(model.end_ms, T("2026-10-09T22:03:07.000Z"));

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
