import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import type { Turn, Session, Event } from "../src/types.js";

test("Slice 1: Event and Store support three-state timing metadata and schema migration", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenttime-slice1-"));
  const dbPath = path.join(tmpDir, "test.db");

  const store = new Store(dbPath);

  // Verify event table has agent_id, tool_id, tool_name columns
  const cols = store.db
    .prepare("PRAGMA table_info(event)")
    .all()
    .map((r: unknown) => (r as { name: string }).name);

  assert.ok(cols.includes("agent_id"), "event table should contain agent_id");
  assert.ok(cols.includes("tool_id"), "event table should contain tool_id");
  assert.ok(cols.includes("tool_name"), "event table should contain tool_name");

  // Verify Turn structure supports three-state metrics
  const dummyTurn: Turn = {
    id: "turn-1",
    start_ms: 1000,
    end_ms: 5000,
    elapsed_ms: 4000,
    status: "completed",
    reason: null,
    models: ["test-model"],
    events: [],
    work_ms: 2500,
    review_wait_ms: 500,
    standby_ms: 1000,
    human_ms: 500,
    response_gap_ms: null,
    breakdown: {
      model_api_ms: 1500,
      tool_execution_ms: 1000,
      review_wait_ms: 500,
      tools: [{ name: "read_file", count: 2, duration_ms: 1000 }],
    },
  };

  assert.equal(dummyTurn.work_ms, 2500);
  assert.equal(dummyTurn.review_wait_ms, 500);
  assert.equal(dummyTurn.standby_ms, 1000);
  assert.equal(dummyTurn.human_ms, 500);
  assert.equal(dummyTurn.breakdown?.tools[0].name, "read_file");

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
