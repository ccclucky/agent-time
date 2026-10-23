import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../src/store.js";
import { report } from "../src/metrics.js";
import { calculatePiTiming } from "../src/store.js";
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
  assert.equal(turn.review_wait_ms, 0);
  assert.equal(turn.human_ms, 0);
  assert.equal(turn.breakdown?.model_api_ms, 2500);
  assert.equal(turn.breakdown?.tool_execution_ms, 1000);
  assert.equal(turn.breakdown?.review_wait_ms, 0);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
