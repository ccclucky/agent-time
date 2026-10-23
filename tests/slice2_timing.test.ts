import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import { report } from "../src/metrics.js";

const makeRow = (
  type: string,
  uuid: string,
  minute: number,
  extra: Record<string, unknown> = {},
) => ({
  type,
  uuid,
  sessionId: "claude-timing-test",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  cwd: "/work/test-project",
  parentUuid: null,
  ...extra,
});

test("Slice 2: Claude Code three-state timing calculates work, review wait, standby and tool breakdown", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-slice2-"));
  const dbPath = path.join(tmpDir, "test.db");
  const store = new Store(dbPath);

  // Turn 1: 00:00 to 00:10 (10 mins = 600,000 ms)
  // - 00:00: user prompt
  // - 00:02: assistant tool_use (bash) -> model API took 2 mins = 120,000 ms
  // - 00:03: permission_request (review wait start)
  // - 00:05: permission_response (review wait end) -> wait took 2 mins = 120,000 ms
  // - 00:06: tool_result (bash returned) -> tool execution took 4 mins - 2 mins wait = 2 mins = 120,000 ms
  // - 00:10: assistant end_turn -> model API took 4 mins = 240,000 ms
  // Expected Turn 1:
  // elapsed_ms = 600,000 ms
  // review_wait_ms = 120,000 ms
  // tool_execution_ms = 120,000 ms
  // model_api_ms = 360,000 ms
  // work_ms = 480,000 ms
  //
  // Turn 2: 00:15 to 00:20 (5 mins = 300,000 ms)
  // Standby gap between Turn 1 end (00:10) and Turn 2 start (00:15) = 5 mins = 300,000 ms
  const rows = [
    makeRow("user", "u-1", 0, { message: { role: "user", content: "first prompt" } }),
    makeRow("assistant", "a-1", 2, {
      parentUuid: "u-1",
      message: {
        role: "assistant",
        model: "claude-3-5-sonnet",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "bash" }],
      },
    }),
    makeRow("permission_request", "perm-req-1", 3, { parentUuid: "a-1" }),
    makeRow("permission_response", "perm-res-1", 5, { parentUuid: "perm-req-1" }),
    makeRow("user", "u-tool-1", 6, {
      parentUuid: "perm-res-1",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
      },
    }),
    makeRow("assistant", "a-end-1", 10, {
      parentUuid: "u-tool-1",
      message: { role: "assistant", model: "claude-3-5-sonnet", stop_reason: "end_turn", content: [{ type: "text", text: "done 1" }] },
    }),
    // Turn 2
    makeRow("user", "u-2", 15, { parentUuid: "a-end-1", message: { role: "user", content: "second prompt" } }),
    makeRow("assistant", "a-end-2", 20, {
      parentUuid: "u-2",
      message: { role: "assistant", model: "claude-3-5-sonnet", stop_reason: "end_turn", content: [{ type: "text", text: "done 2" }] },
    }),
  ];

  const jsonlPath = path.join(tmpDir, "claude-session.jsonl");
  fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  store.importFile(jsonlPath, null, "claude");

  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.turns.length, 2);

  const t1 = s.turns[0];
  assert.equal(t1.elapsed_ms, 600000);
  assert.equal(t1.review_wait_ms, 120000);
  assert.equal(t1.work_ms, 480000);
  assert.equal(t1.human_ms, 120000);
  assert.equal(t1.breakdown?.tool_execution_ms, 120000);
  assert.equal(t1.breakdown?.model_api_ms, 360000);
  assert.equal(t1.breakdown?.tools[0].name, "bash");
  assert.equal(t1.breakdown?.tools[0].count, 1);
  assert.equal(t1.breakdown?.tools[0].duration_ms, 120000);

  const t2 = s.turns[1];
  assert.equal(t2.elapsed_ms, 300000);
  assert.equal(t2.standby_ms, 300000); // 5 mins idle between 00:10 and 00:15
  assert.equal(t2.work_ms, 300000);
  assert.equal(t2.review_wait_ms, 0);

  // Check report summary aggregation
  const rep = report(sessions, "2026-10-21", "2026-10-21", "UTC", "Claude Code");
  assert.equal(rep.summary.processing_ms, 900000);
  assert.equal(rep.summary.work_ms, 780000); // 480000 + 300000
  assert.equal(rep.summary.review_wait_ms, 120000);
  assert.equal(rep.summary.standby_ms, 300000);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
