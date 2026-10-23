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
  sessionId: "subagent-session",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  cwd: "/work/subagent-project",
  parentUuid: null,
  ...extra,
});

test("Slice 3: Subagents are unblocked, cumulative machine time is recorded, and 6-level drill-down is verified", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-slice3-"));
  const dbPath = path.join(tmpDir, "test.db");
  const store = new Store(dbPath);

  // Main turn starts at 00:00, ends at 00:10 (10 mins = 600,000 ms)
  // Subagent runs concurrently at 00:02 to 00:08 (6 mins = 360,000 ms) with agentId: "subagent-research"
  const rows = [
    makeRow("user", "u-1", 0, { message: { role: "user", content: "perform research" } }),
    makeRow("assistant", "a-sub-start", 2, {
      agentId: "subagent-research",
      parentUuid: "u-1",
      message: {
        role: "assistant",
        model: "claude-3-5-sonnet",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t-sub-1", name: "search_web" }],
      },
    }),
    makeRow("user", "u-sub-res", 4, {
      agentId: "subagent-research",
      parentUuid: "a-sub-start",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t-sub-1", content: "search results" }],
      },
    }),
    makeRow("assistant", "a-sub-end", 8, {
      agentId: "subagent-research",
      parentUuid: "u-sub-res",
      message: { role: "assistant", model: "claude-3-5-sonnet", stop_reason: "end_turn", content: [{ type: "text", text: "subagent done" }] },
    }),
    makeRow("assistant", "a-main-end", 10, {
      parentUuid: "u-1",
      message: { role: "assistant", model: "claude-3-5-sonnet", stop_reason: "end_turn", content: [{ type: "text", text: "all done" }] },
    }),
  ];

  const jsonlPath = path.join(tmpDir, "subagent-session.jsonl");
  fs.writeFileSync(jsonlPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  await store.importFile(jsonlPath, null, "claude");

  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];

  // Check Level 2: Project
  assert.equal(s.project, "subagent-project");

  // Check Level 3: Session
  assert.equal(s.id, "claude/subagent-session");

  // Check Level 4: Subagent breakdown
  assert.ok(s.subagents && s.subagents.length === 1);
  const sub = s.subagents![0];
  assert.equal(sub.agent_id, "subagent-research");
  assert.equal(sub.work_ms, 360000); // 00:02 to 00:08

  // Check Level 5: Turn
  assert.equal(s.turns.length, 1);
  const t = s.turns[0];
  assert.equal(t.elapsed_ms, 600000);
  assert.ok(t.subagents && t.subagents.length === 1);

  // Check Level 6: Atomic events & tool breakdown
  assert.ok(t.breakdown);
  assert.ok(t.breakdown.tools.some((tl) => tl.name === "search_web"));
  assert.ok(t.events.length >= 5);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
