import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parsePi } from "../src/pi.js";

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
