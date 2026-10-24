import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.js";
import { Directories, isSessionFile } from "../src/directories.js";
import { parseOmp, extractOmpTranscript } from "../src/omp.js";
import { ValidationError } from "../src/types.js";

const resources: { dir: string; store?: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-omp-"))),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return {
    dir,
    store,
    home,
    dirs: new Directories(store, home, {}, "linux"),
  };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const SID = "019ffaef-4aa4-7000-9d93-97879f2680e3";
const T0 = 1_700_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One omp session stream shaped like the real corpus (ADR 0004 field evidence). */
function ompSession(opts: {
  cwd?: string;
  title?: string;
  records: unknown[];
}) {
  return [
    {
      type: "session",
      version: 3,
      id: SID,
      timestamp: iso(T0 - 120_000),
      cwd: opts.cwd ?? "/tmp/proj-alpha",
      ...(opts.title ? { title: opts.title, titleSource: "auto" } : {}),
    },
    ...opts.records,
  ];
}

const userMsg = (at: number, text: string, id = "u1") => ({
  type: "message",
  id,
  parentId: "prev",
  timestamp: iso(at),
  message: {
    role: "user",
    attribution: "user",
    timestamp: at,
    content: [{ type: "text", text }],
  },
});

const assistantMsg = (opts: {
  appendAt: number;
  reqStart: number;
  duration?: number;
  model?: string;
  stopReason?: string;
  thinking?: string;
  usage?: Record<string, number>;
  toolCalls?: { id: string; name: string }[];
  id?: string;
}) => ({
  type: "message",
  id: opts.id ?? "a1",
  parentId: "p",
  timestamp: iso(opts.appendAt),
  message: {
    role: "assistant",
    timestamp: opts.reqStart,
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    model: opts.model ?? "deepseek-v4-flash",
    provider: "new-api",
    api: "openai-completions",
    stopReason: opts.stopReason ?? "stop",
    content: [
      ...(opts.thinking ? [{ type: "thinking", thinking: opts.thinking }] : []),
      ...(opts.toolCalls ?? []).map((c) => ({
        type: "toolCall",
        id: c.id,
        name: c.name,
        arguments: { cmd: "ls" },
      })),
    ],
    ...(opts.usage
      ? {
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 165,
            reasoningTokens: 20,
            ...opts.usage,
          },
        }
      : {}),
  },
});

const toolStart = (at: number, callId: string, name: string, intent?: string) => ({
  type: "custom",
  customType: "tool_execution_start",
  id: "c1",
  parentId: "p",
  timestamp: iso(at),
  data: { toolCallId: callId, toolName: name, startedAt: iso(at), ...(intent ? { intent } : {}) },
});

const toolResultMsg = (at: number, callId: string, name: string, id = "t1") => ({
  type: "message",
  id,
  parentId: "p",
  timestamp: iso(at),
  message: {
    role: "toolResult",
    timestamp: at,
    toolCallId: callId,
    toolName: name,
    isError: false,
    content: [{ type: "text", text: "ok" }],
  },
});

const devMsg = (at: number) => ({
  type: "message",
  id: "d1",
  parentId: "p",
  timestamp: iso(at),
  message: {
    role: "developer",
    timestamp: at,
    content: [{ type: "text", text: "<system-reminder>todo</system-reminder>" }],
  },
});

function writeSession(dir: string, records: unknown[], name = `${SID}.jsonl`, slug = "-tmp-proj-alpha") {
  const slugDir = path.join(dir, "sessions", slug);
  mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, name);
  const header = {
    type: "session",
    version: 3,
    id: SID,
    timestamp: iso(T0 - 120_000),
    cwd: "/tmp/proj-alpha",
  };
  writeFileSync(
    file,
    [header, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  return file;
}

test("omp: in-file user messages anchor turns; three-state splits model and tool spans", () => {
  const { dir } = setup();
  const file = writeSession(dir, [
    { type: "title", v: 1, title: "初稿标题", source: "auto", updatedAt: iso(T0 - 60_000), pad: "  " },
    { type: "title_change", id: "t1", parentId: "p", timestamp: iso(T0 - 30_000), title: "定稿标题", source: "auto" },
    userMsg(T0, "第一问", "u1"),
    assistantMsg({
      appendAt: T0 + 2_000,
      reqStart: T0 + 100,
      duration: 1_000,
      thinking: "想一想",
      toolCalls: [{ id: "call-1", name: "bash" }],
      stopReason: "toolUse",
      usage: {},
    }),
    toolStart(T0 + 1_200, "call-1", "bash", "列出文件"),
    toolResultMsg(T0 + 2_200, "call-1", "bash"),
    // stop → developer nudge → auto-continuation stays the same turn.
    assistantMsg({
      appendAt: T0 + 3_500,
      reqStart: T0 + 2_300,
      duration: 1_000,
      model: "kimi-k2",
      stopReason: "stop",
      usage: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, totalTokens: 260, reasoningTokens: 0 },
    }),
    userMsg(T0 + 10_000, "第二问", "u2"),
    assistantMsg({
      appendAt: T0 + 11_000,
      reqStart: T0 + 10_100,
      duration: 800,
      stopReason: "aborted",
    }),
  ]);
  const result = parseOmp(file);
  assert.equal(result.session.id, "omp/" + SID);
  assert.equal(result.session.agent, "Oh-My-Pi");
  assert.equal(result.session.project, "proj-alpha");
  assert.equal(result.session.title, "定稿标题");
  assert.deepEqual(result.issues, []);

  const turns = new Map<string, typeof result.events>();
  for (const e of result.events) {
    const list = turns.get(e.turn_id) ?? [];
    list.push(e);
    turns.set(e.turn_id, list);
  }
  assert.equal(turns.size, 2);
  const [t1, t2] = [...turns.values()];
  const kinds1 = t1.map((e) => e.kind).sort();
  assert.ok(kinds1.includes("start") && kinds1.includes("complete"));
  assert.equal(t1.filter((e) => e.kind === "start").length, 1);
  assert.equal(t1.filter((e) => e.kind === "complete").length, 1);
  // complete anchors at the final assistant append (stop → nudge → continue)
  const complete = t1.find((e) => e.kind === "complete")!;
  assert.equal(complete.at_ms, T0 + 3_500);
  // model events carry first-hand spans (reqStart → +duration)
  const modelSpans = t1
    .filter((e) => e.kind === "model" && e.end_ms != null)
    .map((e) => e.end_ms! - e.at_ms);
  assert.deepEqual(modelSpans.sort((a, b) => a - b), [1_000, 1_000]);
  // tool_result pairs via tool_execution_start: T0+1200 → T0+2200
  const tr = t1.find((e) => e.kind === "tool_result")!;
  assert.equal(tr.at_ms, T0 + 1_200);
  assert.equal(tr.end_ms, T0 + 2_200);
  assert.equal(tr.tool_name, "bash");
  // aborted turn ends with abort
  assert.equal(t2.find((e) => e.kind === "abort")!.at_ms, T0 + 11_000);

  // per-turn tokens: usage summed across responses in the turn; the aborted
  // second turn carries no usage rows and so has no token entry at all.
  const byTurn = new Map(result.tokens.map((t) => [t.turn_id, t]));
  assert.equal(byTurn.size, 1);
  const tok1 = byTurn.get(t1[0].turn_id)!;
  assert.equal(tok1.input_tokens, 300);
  assert.equal(tok1.cached_input_tokens, 10);
  assert.equal(tok1.cache_write_input_tokens, 5);
  assert.equal(tok1.output_tokens, 110);
  assert.equal(tok1.reasoning_output_tokens, 20);
  assert.equal(tok1.total_tokens, 425);
});

test("omp: store roundtrip applies Pi-style three-state timing and per-model breakdown", async () => {
  const { store } = setup();
  const { dir } = setup();
  const file = writeSession(dir, [
    userMsg(T0, "问", "u1"),
    assistantMsg({
      appendAt: T0 + 2_000,
      reqStart: T0 + 100,
      duration: 1_000,
      model: "deepseek-v4-flash",
      toolCalls: [{ id: "call-1", name: "bash" }],
      stopReason: "toolUse",
      usage: {},
    }),
    toolStart(T0 + 1_200, "call-1", "bash"),
    toolResultMsg(T0 + 2_200, "call-1", "bash"),
    assistantMsg({
      appendAt: T0 + 3_500,
      reqStart: T0 + 2_300,
      duration: 1_000,
      model: "kimi-k2",
      stopReason: "stop",
    }),
  ]);
  await store.importFile(file, null, "omp");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.agent, "Oh-My-Pi");
  assert.equal(s.turns.length, 1);
  const turn = s.turns[0];
  assert.equal(turn.status, "completed");
  // work_ms = machine-time accumulation (2×1000 model + 1000 tool), independent
  // of the wall-clock elapsed span (Pi timing semantics).
  assert.equal(turn.work_ms, 3_000);
  assert.equal(turn.review_wait_ms, null);
  assert.equal(turn.breakdown?.model_api_ms, 2_000);
  assert.equal(turn.breakdown?.tool_execution_ms, 1_000);
  // per-model breakdown flows through the existing 4-KPI + rollup structure
  assert.deepEqual(
    turn.breakdown?.model_api_breakdown?.map((m) => m.model).sort(),
    ["deepseek-v4-flash", "kimi-k2"],
  );
  assert.equal(turn.tokens?.input_tokens, 100);
  assert.equal(turn.tokens?.output_tokens, 50);
  assert.equal(s.tokens?.total_tokens, 165);
  // transcript dispatch by agent name
  const tr = store.transcript(s.id);
  assert.ok(tr);
  assert.equal(tr!.turns.length, 1);
  assert.equal(tr!.turns[0].prompt, "问");
});

test("omp: history.db fallback anchors turns when the file predates user-message recording", () => {
  const { dir } = setup();
  // No user-role messages in the stream (old-writer shape, real file sample).
  const file = writeSession(dir, [
    assistantMsg({
      appendAt: T0 + 5_000,
      reqStart: T0 + 4_000,
      duration: 900,
      stopReason: "stop",
    }),
    assistantMsg({
      appendAt: T0 + 40_000,
      reqStart: T0 + 30_000,
      duration: 900,
      stopReason: "stop",
    }),
  ]);
  const agentDir = path.join(path.dirname(path.dirname(file)));
  const db = new DatabaseSync(path.join(agentDir, "history.db"));
  db.exec(
    "CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, created_at INTEGER NOT NULL, cwd TEXT, session_id TEXT)",
  );
  const put = db.prepare(
    "INSERT INTO history (prompt, created_at, cwd, session_id) VALUES (?, ?, ?, ?)",
  );
  put.run("第一问", T0 / 1000 - 1, "/tmp/proj-alpha", SID); // epoch seconds
  put.run("第二问", T0 / 1000 + 25, "/tmp/proj-alpha", SID);
  db.close();

  const result = parseOmp(file);
  assert.deepEqual(result.issues, []);
  const turns = new Map<string, typeof result.events>();
  for (const e of result.events) {
    const list = turns.get(e.turn_id) ?? [];
    list.push(e);
    turns.set(e.turn_id, list);
  }
  assert.equal(turns.size, 2);
  const ids = [...turns.keys()].sort();
  assert.ok(ids[0].startsWith("db-"));
  // second-precision anchor before the first response: start clamps stay sane
  for (const events of turns.values()) {
    const start = events.find((e) => e.kind === "start")!;
    const model = events.find((e) => e.kind === "model" && e.end_ms != null)!;
    assert.ok(start.at_ms <= model.at_ms);
  }
  // transcript mirrors the same db-<created_at>-<n> turn ids and prompts
  const tr = extractOmpTranscript(file);
  assert.equal(tr.length, 2);
  assert.deepEqual(
    tr.map((t) => t.prompt),
    ["第一问", "第二问"],
  );
  assert.deepEqual([...turns.keys()].sort(), tr.map((t) => t.turn_id).sort());
});

test("omp: no anchors anywhere degrades to one honest single-turn import", () => {
  const { dir } = setup();
  const file = writeSession(dir, [
    assistantMsg({
      appendAt: T0 + 5_000,
      reqStart: T0 + 4_000,
      duration: 900,
      stopReason: "stop",
    }),
  ]);
  const result = parseOmp(file);
  assert.ok(
    result.issues.some((i) => i.includes("整段按单轮计")),
  );
  assert.equal(new Set(result.events.map((e) => e.turn_id)).size, 1);
  const start = result.events.find((e) => e.kind === "start")!;
  const complete = result.events.find((e) => e.kind === "complete")!;
  assert.equal(complete.at_ms, T0 + 5_000);
  assert.ok(start.at_ms <= T0 + 4_000);
});

test("omp: discovery only accepts uuid.jsonl session streams", () => {
  assert.ok(isSessionFile("omp", "/x/sessions/-tmp-p/019ffaef-4aa4-7000-9d93-97879f2680e3.jsonl"));
  assert.ok(isSessionFile("omp", "/x/sessions/-tmp-p/2026-08-13T11-43-34-052Z_019ffaef-4aa4-7000-9d93-97879f2680e3.jsonl"));
  // workspace artifacts next to the stream must never be discovered
  assert.ok(!isSessionFile("omp", "/x/sessions/-tmp-p/019ffaef-4aa4-7000-9d93-97879f2680e3/DesignerSpec.jsonl"));
  assert.ok(!isSessionFile("omp", "/x/sessions/-tmp-p/__advisor.jsonl"));
  assert.ok(!isSessionFile("omp", "/x/sessions/-tmp-p/notes.txt"));
  // other adapters keep their generic .jsonl rule
  assert.ok(isSessionFile("pi", "/x/sessions/p/anything.jsonl"));
});

test("omp: rejects files without a session header and merged streams", () => {
  const { dir } = setup();
  const slugDir = path.join(dir, "sessions", "-tmp-p");
  mkdirSync(slugDir, { recursive: true });
  const noHeader = path.join(slugDir, "019ffaef-4aa4-7000-9d93-97879f2680e3.jsonl");
  writeFileSync(noHeader, JSON.stringify({ type: "message", id: "x" }) + "\n");
  assert.throws(() => parseOmp(noHeader), ValidationError);

  const merged = writeSession(dir, [
    { type: "session", version: 3, id: "aaaaaaaa-aaaa-7000-9d93-97879f2680e3", timestamp: iso(T0), cwd: "/tmp" },
    userMsg(T0, "hi"),
    { type: "session", version: 3, id: SID, timestamp: iso(T0 + 1), cwd: "/tmp" },
  ]);
  assert.throws(() => parseOmp(merged), ValidationError);
});

test("omp: directory discovery walks sessions/ and imports via refresh", async () => {
  const { dir, store, dirs, home } = setup();
  const agentDir = path.join(home, ".omp", "agent");
  const slugDir = path.join(agentDir, "sessions", "-tmp-proj-alpha");
  mkdirSync(slugDir, { recursive: true });
  const file = path.join(slugDir, `${SID}.jsonl`);
  writeFileSync(
    file,
    ompSession({
      records: [
        userMsg(T0, "问", "u1"),
        assistantMsg({
          appendAt: T0 + 2_000,
          reqStart: T0 + 100,
          duration: 1_000,
          stopReason: "stop",
        }),
      ],
    })
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  // workspace artifact must not be picked up
  mkdirSync(path.join(slugDir, SID), { recursive: true });
  writeFileSync(path.join(slugDir, SID, "DesignerSpec.jsonl"), "{}\n");
  dirs.save("omp", agentDir, true);
  const result = await store.refresh();
  assert.equal(result.updated, 1);
  assert.equal(result.discovered, 1);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, null);
  assert.equal(sessions[0].project, "proj-alpha");
  assert.equal(sessions[0].turns[0].work_ms, 1_000);
});

test("omp: transcript exposes thinking, tool durations and intent", () => {
  const { dir } = setup();
  const file = writeSession(dir, [
    userMsg(T0, "第一问", "u1"),
    assistantMsg({
      appendAt: T0 + 2_000,
      reqStart: T0 + 100,
      duration: 1_000,
      thinking: "推理 A",
      toolCalls: [{ id: "call-1", name: "bash" }],
      stopReason: "toolUse",
    }),
    toolStart(T0 + 1_200, "call-1", "bash", "列出文件"),
    toolResultMsg(T0 + 2_200, "call-1", "bash"),
    assistantMsg({
      appendAt: T0 + 3_000,
      reqStart: T0 + 2_300,
      duration: 600,
      thinking: "推理 B",
      stopReason: "stop",
    }),
  ]);
  const tr = extractOmpTranscript(file);
  assert.equal(tr.length, 1);
  const turn = tr[0];
  assert.equal(turn.turn_id, "msg-" + T0 + "-0");
  assert.equal(turn.prompt, "第一问");
  assert.equal(turn.thinking, "推理 A\n推理 B");
  assert.deepEqual(turn.models, ["deepseek-v4-flash"]);
  assert.equal(turn.tool_calls.length, 1);
  assert.equal(turn.tool_calls[0].name, "bash");
  assert.equal(turn.tool_calls[0].duration_ms, 1_000);
  assert.equal(turn.tool_calls[0].call_id, "call-1");
  assert.equal(turn.tool_calls[0].detail, "列出文件");
});
