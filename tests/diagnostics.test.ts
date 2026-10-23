import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { redactor } from "../scripts/export-diagnostics.mjs";

test("diagnostic redaction retains relationships, timestamp facts and source shape without content", async () => {
  const redact = redactor(),
    secret = "PRIVATE_PROMPT_PASSWORD_PATH";
  const meta = redact(
    {
      type: "session_meta",
      payload: {
        id: "session",
        source: { subagent: { thread_spawn: { parent_thread_id: secret } } },
        originator: "codex_cli_rs",
        cwd: secret,
        cli_version: "1.2.3",
        base_instructions: secret,
        auth: secret,
      },
    },
    "codex",
  );
  assert.deepEqual(meta.payload.source, { subagent: { redacted: true } });
  assert.equal(meta.payload.cli_version, "1.2.3");
  const a = redact(
    {
      type: "user",
      sessionId: "session",
      uuid: "user",
      parentUuid: null,
      timestamp: "2026-10-21T00:00:00Z",
      message: { content: secret },
      isSidechain: false,
    },
    "claude",
  );
  const b = redact(
    {
      type: "assistant",
      sessionId: "session",
      uuid: "reply",
      parentUuid: "user",
      timestamp: "2026-10-21T00:10:00Z",
      message: {
        model: secret,
        stop_reason: "end_turn",
        content: [
          { type: "text", text: secret },
          { type: "tool_use", input: { password: secret } },
        ],
      },
    },
    "claude",
  );
  assert.equal(a.sessionId, b.sessionId);
  assert.equal(a.uuid, b.parentUuid);
  assert.equal(a.timestamp, "2026-10-21T00:00:00Z");
  assert.equal(b.message.stop_reason, "end_turn");
  assert(!JSON.stringify([meta, a, b]).includes(secret));
  assert(!JSON.stringify([meta, a, b]).includes("codex_cli_rs"));
  assert.notEqual(
    redactor()({ type: "user", uuid: "user" }, "claude").uuid,
    a.uuid,
  );
});

test("offline CLI export preserves timing results, never changes input, and refuses overwrite", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "agenttime-diagnostic-test-"));
  let original: Store | undefined, sanitized: Store | undefined;
  try {
    const input = path.join(dir, "private.jsonl"),
      output = path.join(dir, "export");
    const rows = [
      {
        type: "user",
        uuid: "user-1",
        sessionId: "session-1",
        cwd: "/private/project",
        timestamp: "2026-10-21T00:00:00Z",
        message: { content: "PRIVATE_USER_PROMPT" },
      },
      {
        type: "assistant",
        uuid: "answer-1",
        parentUuid: "user-1",
        sessionId: "session-1",
        timestamp: "2026-10-21T00:10:00Z",
        message: {
          content: [{ type: "text", text: "PRIVATE_REPLY" }],
          model: "private-model",
          stop_reason: "end_turn",
        },
      },
    ];
    writeFileSync(input, rows.map(JSON.stringify).join("\n"));
    const before = readFileSync(input);
    const args = [
      "scripts/export-diagnostics.mjs",
      "--agent",
      "claude",
      "--out",
      output,
      input,
    ];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(input), before);
    const safeFile = path.join(output, "sample-1.jsonl"),
      safe = readFileSync(safeFile, "utf8");
    assert(!safe.includes("PRIVATE"));
    assert(!safe.includes("/private/project"));
    assert(!safe.includes("private-model"));
    assert.equal(
      JSON.parse(readFileSync(path.join(output, "manifest.json"), "utf8"))
        .files[0].kept,
      2,
    );
    original = new Store(path.join(dir, "original.sqlite3"));
    sanitized = new Store(path.join(dir, "safe.sqlite3"));
    await original.importFile(input, null, "claude");
    await sanitized.importFile(safeFile, null, "claude");
    const originalTurn = original.sessions()[0].turns[0],
      safeTurn = sanitized.sessions()[0].turns[0];
    assert.equal(safeTurn.elapsed_ms, originalTurn.elapsed_ms);
    assert.equal(safeTurn.status, originalTurn.status);
    assert.equal(safeTurn.start_ms, originalTurn.start_ms);
    assert.equal(safeTurn.end_ms, originalTurn.end_ms);
    assert.notEqual(
      spawnSync(process.execPath, args, { encoding: "utf8" }).status,
      0,
    );
    assert.equal(readFileSync(safeFile, "utf8"), safe);
  } finally {
    original?.close();
    sanitized?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
