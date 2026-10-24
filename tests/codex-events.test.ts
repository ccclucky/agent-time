import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Store } from "../src/store.js";
import { parse, ExcludedSessionError, lines } from "../src/codex.js";
import { ValidationError } from "../src/types.js";
import { report } from "../src/metrics.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-codex-"))),
    store = new Store(path.join(dir, "data.sqlite3"));
  resources.push({ dir, store });
  return { dir, store };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const BASE = Date.parse("2026-10-21T00:00:00Z");
const ts = (minute: number, second = 0) =>
  `2026-10-21T00:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`;
const at = (minute: number, second = 0) => BASE + minute * 60000 + second * 1000;

const meta = (id = "s1", extra = {}) => ({
  type: "session_meta",
  timestamp: ts(0),
  payload: {
    id,
    source: "cli",
    cwd: "/work/example",
    originator: "codex_cli_rs",
    history_mode: "paginated",
    ...extra,
  },
});
const msg = (
  type: string,
  minute: number,
  turn: string,
  extra = {},
  second = 0,
) => ({
  type: "event_msg",
  timestamp: ts(minute, second),
  payload: { type, turn_id: turn, ...extra },
});
const itemDone = (
  turn: string,
  itemType: string,
  minute: number,
  anchorMs: number,
  second = 0,
) => ({
  type: "event_msg",
  timestamp: ts(minute, second),
  payload: {
    type: "item_completed",
    turn_id: turn,
    item: { type: itemType, id: "item-1" },
    completed_at_ms: anchorMs,
  },
});
const resp = (ptype: string, minute: number, extra = {}, second = 0) => ({
  type: "response_item",
  timestamp: ts(minute, second),
  payload: { type: ptype, ...extra },
});
const ctx = (minute: number, model: string, turn?: string, second = 0) => ({
  type: "turn_context",
  timestamp: ts(minute, second),
  payload: { model, ...(turn ? { turn_id: turn } : {}) },
});
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
const kindsOf = (p: Awaited<ReturnType<typeof parse>>) =>
  p.events.map((e) => [e.kind, e.turn_id, e.at_ms]);

test("turn boundaries map to start/complete/fail/abort with row timestamps", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "t1"),
      msg("task_complete", 10, "t1", { error: {} }),
      msg("task_started", 20, "t2"),
      itemDone("t2", "AgentMessage", 22, at(22)),
      msg("turn_aborted", 25, "t2", { reason: "interrupted" }),
    ]),
  );
  assert.deepEqual(kindsOf(result), [
    ["start", "t1", at(0)],
    ["fail", "t1", at(10)],
    ["start", "t2", at(20)],
    ["abort", "t2", at(25)],
  ]);
});

test("response_item tool calls pair by call_id and attribute to the nearest task_started", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      resp("function_call", 0, { call_id: "call_9", name: "shell_command" }, 30),
      msg("task_started", 1, "t1"),
      resp("function_call", 1, { call_id: "call_1", name: "shell_command" }, 30),
      resp("function_call_output", 1, { call_id: "call_1" }, 45),
      resp("custom_tool_call", 2, { call_id: "call_2" }),
      resp("custom_tool_call_output", 2, { call_id: "call_2" }, 10),
      msg("task_started", 5, "t2"),
      resp("function_call", 5, { call_id: "call_3", name: "exec_command" }, 30),
      resp("function_call_output", 6, { call_id: "call_3" }),
    ]),
  );
  const tools = result.events.filter((e) =>
    ["tool_use", "tool_result"].includes(e.kind),
  );
  assert.deepEqual(
    tools.map((e) => [
      e.kind,
      e.turn_id,
      e.at_ms,
      e.tool_id ?? null,
      e.tool_name ?? null,
    ]),
    [
      ["tool_use", "t1", at(1, 30), "call_1", "shell_command"],
      ["tool_result", "t1", at(1, 45), "call_1", null],
      ["tool_use", "t1", at(2), "call_2", "tool"],
      ["tool_result", "t1", at(2, 10), "call_2", null],
      ["tool_use", "t2", at(5, 30), "call_3", "exec_command"],
      ["tool_result", "t2", at(6), "call_3", null],
    ],
  );
  assert(result.issues.includes("部分事件没有可关联的交互 ID，未猜测归属"));
});

test("only the first turn_context of a turn emits a model event", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "t1"),
      ctx(0, "gpt-5.2-codex", undefined, 1),
      ctx(0, "gpt-5.2-codex", undefined, 2),
      ctx(0, "gpt-5.2-codex", "t1", 3),
      msg("task_started", 5, "t2"),
      ctx(5, "gpt-5.3-codex", undefined, 1),
    ]),
  );
  assert.deepEqual(
    result.events
      .filter((e) => e.kind === "model")
      .map((e) => [e.turn_id, e.at_ms, e.model]),
    [
      ["t1", at(0, 1), "gpt-5.2-codex"],
      ["t2", at(5, 1), "gpt-5.3-codex"],
    ],
  );
});

test("task_complete is calibrated to the last non-UserMessage item_completed anchor", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "t1"),
      itemDone("t1", "Reasoning", 0, at(0, 30), 30),
      itemDone("t1", "AgentMessage", 2, at(2)),
      itemDone("t1", "UserMessage", 9, at(9)),
      msg("task_complete", 10, "t1"),
    ]),
  );
  assert.deepEqual(kindsOf(result), [
    ["start", "t1", at(0)],
    ["complete", "t1", at(2)],
  ]);
});

test("turns without item_completed fall back to the task_complete row timestamp", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [meta(), msg("task_started", 0, "t1"), msg("task_complete", 10, "t1")]),
  );
  assert.deepEqual(kindsOf(result), [
    ["start", "t1", at(0)],
    ["complete", "t1", at(10)],
  ]);
});

test("anchors outside the turn window never stretch or flip the completion", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "t1"),
      itemDone("t1", "AgentMessage", 20, at(20)),
      msg("task_complete", 10, "t1"),
    ]),
  );
  const complete = result.events.find((e) => e.kind === "complete")!;
  assert.equal(complete.at_ms, at(10));
});

test("external-import turns keep no timing events and add an issues note", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "external-import-turn-1"),
      itemDone("external-import-turn-1", "AgentMessage", 0, at(0, 500), 500),
      msg("task_complete", 0, "external-import-turn-1", {}, 1),
      msg("task_started", 30, "t2"),
      msg("task_complete", 31, "t2"),
    ]),
  );
  assert.deepEqual(kindsOf(result), [
    ["start", "t2", at(30)],
    ["complete", "t2", at(31)],
  ]);
  assert(result.issues.includes("外部导入轮次时间戳为导入时刻，不参与计时"));
  // A real turn remains, so this is not an external-import-only session.
  assert.equal(result.external_import_only, false);
});

test("external-import-only sessions flag external_import_only instead of text matching", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "external-import-turn-1"),
      msg("task_complete", 1, "external-import-turn-1"),
    ]),
  );
  assert.equal(result.events.length, 0);
  assert.equal(result.external_import_only, true);
});

test("by-design exclusions throw ExcludedSessionError (a ValidationError subclass)", async () => {
  const { dir } = setup();
  const subagentFile = file(dir, [
    { ...meta("s2"), payload: { ...meta("s2").payload, parent_thread_id: "p" } },
    msg("task_started", 0, "t1"),
  ]);
  await assert.rejects(() => parse(subagentFile), ExcludedSessionError);
  await assert.rejects(() => parse(subagentFile), ValidationError);
  await assert.rejects(
    () =>
      parse(
        file(dir, [
          meta(),
          msg("task_started", 0, "t1"),
          {
            type: "event_msg",
            timestamp: ts(0),
            payload: { type: "thread_rolled_back" },
          },
        ]),
      ),
    ExcludedSessionError,
  );
});

test("codex parse reports the three-state basis issue", async () => {
  const { dir } = setup();
  const result = await parse(
    file(dir, [meta(), msg("task_started", 0, "t1"), msg("task_complete", 1, "t1")]),
  );
  assert(
    result.issues.some((i) => /三态切分/.test(i) && /等待人审阅未单独计量/.test(i)),
  );
});

test("codex sessions compute work, review wait, standby and tool breakdown", async () => {
  const { dir, store } = setup();
  await store.importFile(
    file(dir, [
      meta(),
      // Turn 1: 00:00 -> agent done 00:06 (task_complete row lazily written 00:15)
      msg("task_started", 0, "t1"),
      ctx(0, "gpt-5.2-codex", undefined, 1),
      resp("function_call", 1, { call_id: "call_1", name: "shell_command" }),
      resp("function_call_output", 3, { call_id: "call_1" }),
      resp("custom_tool_call", 4, { call_id: "call_2", name: "apply_patch" }),
      resp("custom_tool_call_output", 5, { call_id: "call_2" }),
      itemDone("t1", "AgentMessage", 6, at(6)),
      msg("task_complete", 15, "t1"),
      // Turn 2: 00:20 -> 00:22 with one unclosed tool call
      msg("task_started", 20, "t2"),
      ctx(20, "gpt-5.3-codex", undefined, 1),
      resp("function_call", 21, { call_id: "call_3", name: "shell_command" }),
      itemDone("t2", "AgentMessage", 22, at(22)),
      msg("task_complete", 22, "t2", {}, 1),
    ]),
  );
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "Codex");
  const [t1, t2] = sessions[0].turns;
  assert.equal(t1.elapsed_ms, 360000);
  assert.equal(t1.work_ms, 360000);
  assert.equal(t1.review_wait_ms, 0);
  assert.equal(t1.human_ms, 0);
  assert.equal(t1.standby_ms, null);
  assert.equal(t1.breakdown?.tool_execution_ms, 180000);
  assert.equal(t1.breakdown?.model_api_ms, 180000);
  assert.equal(t1.breakdown?.review_wait_ms, 0);
  const shell = t1.breakdown?.tools.find((t) => t.name === "shell_command")!;
  assert.equal(shell.count, 1);
  assert.equal(shell.duration_ms, 120000);
  const patch = t1.breakdown?.tools.find((t) => t.name === "apply_patch")!;
  assert.equal(patch.duration_ms, 60000);
  assert.deepEqual(t1.models, ["gpt-5.2-codex"]);

  assert.equal(t2.elapsed_ms, 120000);
  assert.equal(t2.work_ms, 120000);
  assert.equal(t2.review_wait_ms, 0);
  // human gap between agent done (00:06) and the next task_started (00:20)
  assert.equal(t2.standby_ms, 840000);
  assert.equal(t2.response_gap_ms, 840000);
  const unclosed = t2.breakdown?.tools.find((t) => t.name === "shell_command")!;
  assert.equal(unclosed.duration_ms, 0);
  assert.deepEqual(t2.models, ["gpt-5.3-codex"]);

  assert.equal(sessions[0].work_ms, 480000);
  assert.equal(sessions[0].review_wait_ms, 0);
  assert.equal(sessions[0].standby_ms, 840000);
  const rep = report(sessions, "2026-10-21", "2026-10-21", "UTC", "Codex");
  assert.equal(rep.summary.processing_ms, 480000);
  assert.equal(rep.summary.work_ms, 480000);
  assert.equal(rep.summary.review_wait_ms, 0);
  assert.equal(rep.summary.standby_ms, 840000);
  assert.match(rep.basis, /Codex/);
  assert.match(rep.basis, /item_completed/);
});

const home = process.env.HOME ?? "";
const corpus = path.join(home, ".codex", "sessions");
const hasCorpus = !!home && existsSync(corpus);
const realTest = hasCorpus ? test : test.skip;

function findRealSamples(limit = 5, scanCap = 60) {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".jsonl.zst")) files.push(p);
    }
  };
  try {
    walk(corpus);
  } catch {
    return [];
  }
  files.sort();
  const picked: string[] = [];
  for (const f of files.slice(0, scanCap)) {
    if (picked.length >= limit) break;
    try {
      const st = statSync(f);
      if (st.size > 3_000_000) continue;
      const rows = zlib
        .zstdDecompressSync(readFileSync(f))
        .toString()
        .split("\n");
      let starts = 0,
        calls = 0,
        anchors = 0,
        external = false,
        sourceOk = false;
      for (const line of rows) {
        if (!line.trim()) continue;
        let r: {
          type: string;
          payload?: { type?: string; turn_id?: string; source?: unknown; completed_at_ms?: unknown };
        };
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const pt = r.payload?.type;
        if (r.type === "session_meta" && ["cli", "vscode", "exec"].includes(String(r.payload?.source)))
          sourceOk = true;
        if (r.type === "event_msg" && pt === "task_started") {
          starts++;
          if (String(r.payload?.turn_id ?? "").startsWith("external-import-turn-"))
            external = true;
        }
        if (
          r.type === "response_item" &&
          (pt === "function_call" || pt === "custom_tool_call")
        )
          calls++;
        if (
          r.type === "event_msg" &&
          pt === "item_completed" &&
          typeof r.payload?.completed_at_ms === "number"
        )
          anchors++;
      }
      if (sourceOk && starts >= 2 && calls >= 1 && anchors >= 1 && !external)
        picked.push(f);
    } catch {
      // unreadable file, keep scanning
    }
  }
  return picked;
}

realTest("real multi-turn .jsonl.zst samples produce non-null three-state timing", async () => {
  const samples = findRealSamples();
  assert.ok(samples.length >= 1, "no suitable real samples found");
  const { dir, store } = setup();
  const imported: string[] = [];
  for (const p of samples) {
    try {
      await store.importFile(p);
      imported.push(p);
    } catch {
      // keep scanning
    }
  }
  assert.ok(imported.length >= 1);
  const sessions = store.sessions().filter((s) => s.agent === "Codex");
  assert.ok(sessions.length >= 1);
  let measured = 0,
    withStandby = 0;
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.work_ms !== null) {
        measured++;
        assert.ok(t.work_ms >= 0);
        assert.ok(t.elapsed_ms !== null && t.work_ms <= t.elapsed_ms);
        assert.equal(t.review_wait_ms, 0);
      }
      if (t.standby_ms !== null && t.standby_ms > 0) withStandby++;
    }
    assert.ok(s.turns.some((t) => t.work_ms !== null));
    assert.equal(s.review_wait_ms, 0);
  }
  assert.ok(measured >= 2, "expected at least two measured turns");
  assert.ok(withStandby >= 1, "expected at least one standby gap");
});

// Regression (spec #7, ADR 0004): lines() reuses one 64 KiB chunk buffer, and
// the splitter's carry-over used to hold a zero-copy view into it — the next
// readSync overwrote the bytes before the spanning line was concatenated, so
// every line crossing a chunk boundary came back with a stale garbage head.
// First mass-exposed by Oh-My-Pi's long-line corpus (31 corrupt lines in one
// 2.7 MiB file); a >64 KiB single record deterministically crosses the
// boundary, and the trailing record catches tail corruption.
test("lines(): spanning-line carry-over survives chunk buffer reuse", () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-lsplit-")));
  try {
    const long = "x".repeat(70_000);
    const file = path.join(dir, "big.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "head", n: 1 }),
        JSON.stringify({ type: "custom", data: { blob: long } }),
        JSON.stringify({ type: "tail", n: 3 }),
      ].join("\n") + "\n",
    );
    // Parse inside the loop: lines() yields zero-copy views that are only
    // valid until the next chunk read, matching every real consumer.
    const got: unknown[] = [];
    for (const b of lines(file))
      got.push(JSON.parse(new TextDecoder().decode(b)));
    assert.equal(got.length, 3);
    assert.equal((got[1] as { data: { blob: string } }).data.blob.length, long.length);
    assert.equal((got[1] as { data: { blob: string } }).data.blob, long);
    assert.deepEqual(got[0], { type: "head", n: 1 });
    assert.deepEqual(got[2], { type: "tail", n: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
