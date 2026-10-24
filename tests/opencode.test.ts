import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// node:sqlite is experimental before 22.15; CI runs 22.15.0 and 24 where
// DatabaseSync exists, but the gate keeps the suite skippable on older local
// Node versions exactly like the Codex zstd / DSH zstd capability gates.
const sqliteMod = process.getBuiltinModule?.("node:sqlite") as
  | typeof import("node:sqlite")
  | undefined;
const DatabaseSync = sqliteMod?.DatabaseSync;
const sql = DatabaseSync ? test : test.skip;

import { Store, calculateOpencodeTiming } from "../src/store.js";
import { Directories } from "../src/directories.js";
import {
  parseOpencode,
  extractOpencodeTranscript,
} from "../src/opencode.js";
import { ValidationError } from "../src/types.js";

const resources: { dir: string; store?: Store }[] = [];
function setup() {
  const dir = realpathSync(
      mkdtempSync(path.join(tmpdir(), "agenttime-opencode-")),
    ),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return { dir, store, home, dirs: new Directories(store, home, {}, "linux") };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = 1_770_000_000_000;

/** Build an old-format (message/part) OpenCode SQLite database, the schema
 *  verified against the real local ~/.local/share/opencode/opencode.db
 *  (2026-10-24). Only columns the adapter reads are included. */
function buildDb(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE project (
      id text PRIMARY KEY, worktree text NOT NULL, name text,
      time_created integer NOT NULL, time_updated integer NOT NULL
    );
    CREATE TABLE session (
      id text PRIMARY KEY, project_id text NOT NULL, parent_id text,
      slug text NOT NULL, directory text NOT NULL, title text NOT NULL,
      version text NOT NULL, time_created integer NOT NULL,
      time_updated integer NOT NULL, time_archived integer
    );
    CREATE TABLE message (
      id text PRIMARY KEY, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE permission (
      project_id text PRIMARY KEY, time_created integer NOT NULL,
      time_updated integer NOT NULL, data text NOT NULL
    );
  `);
  return db;
}

interface StepSpec {
  id: string;
  created: number;
  completed: number;
  model?: string;
  provider?: string;
  tokens?: Record<string, unknown>;
  reasoning?: { text: string; start: number; end: number };
  tools?: {
    callID: string;
    tool: string;
    start: number;
    end: number;
    input?: unknown;
    status?: string;
  }[];
}

function insertSession(
  db: ReturnType<typeof buildDb>,
  opts: {
    sid?: string;
    worktree?: string;
    directory?: string;
    title?: string;
    steps: StepSpec[];
    users?: { id: string; at: number; text?: string }[];
  },
) {
  const sid = opts.sid ?? "ses_a";
  const worktree = opts.worktree ?? "/home/user/proj-y";
  const pid = "p_" + worktree.replace(/[^a-z0-9]/gi, "_");
  db.prepare(
    "INSERT INTO project(id,worktree,name,time_created,time_updated) VALUES(?,?,?,?,?)",
  ).run(pid, worktree, null, T0, T0);
  db.prepare(
    "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    sid,
    pid,
    null,
    "s-abc",
    opts.directory ?? worktree,
    opts.title ?? "修复登录页",
    "1.1.39",
    T0,
    T0,
  );
  const putMsg = db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
  );
  const putPart = db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
  );
  let partN = 0;
  // Message ids are globally unique in the real table; prefix with the
  // session id so one fixture db can carry several sessions.
  const mid = (id: string) => sid + "_" + id;
  for (const u of opts.users ?? []) {
    // Mirrors the real database: message.time_created is rewritten to the
    // import moment for re-imported sessions, so only data.time carries
    // first-hand evidence. The fixture writes bogus column timestamps on
    // purpose and the adapter must ignore them.
    putMsg.run(
      mid(u.id),
      sid,
      T0 + 999_999,
      T0 + 999_999,
      JSON.stringify({ role: "user", time: { created: u.at } }),
    );
    if (u.text)
      putPart.run(
        mid("up" + ++partN),
        mid(u.id),
        sid,
        T0 + 999_999,
        T0 + 999_999,
        JSON.stringify({ type: "text", text: u.text }),
      );
  }
  for (const s of opts.steps) {
    const data: Record<string, unknown> = {
      role: "assistant",
      time: { created: s.created, completed: s.completed },
      parentID: mid((opts.users ?? [])[0]?.id ?? "u1"),
      modelID: s.model ?? "gemini-3-pro",
      providerID: s.provider ?? "google",
      tokens: s.tokens ?? null,
    };
    putMsg.run(mid(s.id), sid, T0 + 999_999, T0 + 999_999, JSON.stringify(data));
    if (s.reasoning)
      putPart.run(
        mid("rp" + ++partN),
        mid(s.id),
        sid,
        T0 + 999_999,
        T0 + 999_999,
        JSON.stringify({
          type: "reasoning",
          text: s.reasoning.text,
          time: { start: s.reasoning.start, end: s.reasoning.end },
        }),
      );
    for (const t of s.tools ?? [])
      putPart.run(
        mid("tp" + ++partN),
        mid(s.id),
        sid,
        T0 + 999_999,
        T0 + 999_999,
        JSON.stringify({
          type: "tool",
          callID: t.callID,
          tool: t.tool,
          state: {
            status: t.status ?? "completed",
            input: t.input ?? { command: "ls src" },
            time: { start: t.start, end: t.end },
          },
        }),
      );
  }
}

/** Two-turn session: turn 1 has two steps (one with parallel tools), turn 2
 *  is a user message with no reply (open). Column timestamps are poisoned
 *  with T0+999_999 to prove the adapter reads data.time only. */
function twoTurnDb(file: string) {
  const db = buildDb(file);
  insertSession(db, {
    users: [
      { id: "u1", at: T0 + 100, text: "修复登录页面的样式问题" },
      { id: "u2", at: T0 + 2000, text: "再看看移动端" },
    ],
    steps: [
      {
        id: "a1",
        created: T0 + 200,
        completed: T0 + 700,
        tokens: {
          input: 100,
          output: 50,
          reasoning: 10,
          cache: { read: 20, write: 5 },
        },
        reasoning: { text: "先看组件结构", start: T0 + 210, end: T0 + 260 },
        tools: [
          // Parallel pair inside one step: union 300→550 = 250ms, not 350.
          { callID: "c1", tool: "read", start: T0 + 300, end: T0 + 400 },
          { callID: "c2", tool: "glob", start: T0 + 350, end: T0 + 550 },
        ],
      },
      {
        id: "a2",
        created: T0 + 800,
        completed: T0 + 1200,
        tokens: {
          input: 200,
          output: 70,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ],
  });
  db.close();
}

sql("parseOpencode: events, spans, per-turn token sums, project and title", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  const result = parseOpencode(file);
  assert.equal(result.length, 1);
  const s = result[0];
  assert.equal(s.session.id, "opencode/ses_a");
  assert.equal(s.session.agent, "OpenCode");
  assert.equal(s.session.project, "proj-y");
  assert.equal(s.session.client, "opencode");
  assert.equal(s.session.title, "修复登录页");

  const t1 = s.events.filter((e) => e.turn_id === "turn-1");
  const kinds = t1.map((e) => e.kind).sort();
  assert.deepEqual(
    kinds,
    [
      "complete",
      "model",
      "model",
      "start",
      "thinking",
      "tool_result",
      "tool_result",
      "tool_use",
      "tool_use",
    ].sort(),
  );
  // The reasoning part's real span becomes a thinking event inside the turn.
  const thinking = t1.find((e) => e.kind === "thinking")!;
  assert.equal(thinking.at_ms, T0 + 210);
  assert.equal(thinking.end_ms, T0 + 260);
  assert.equal(thinking.model, "google/gemini-3-pro");
  const start = t1.find((e) => e.kind === "start")!;
  assert.equal(start.at_ms, T0 + 100);
  const model1 = t1.find(
    (e) => e.kind === "model" && e.at_ms === T0 + 200,
  )!;
  assert.equal(model1.end_ms, T0 + 700);
  assert.equal(model1.model, "google/gemini-3-pro");
  const complete = t1.find((e) => e.kind === "complete")!;
  assert.equal(complete.at_ms, T0 + 1200);
  for (const call of t1.filter((e) => e.kind === "tool_result")) {
    assert.ok(call.tool_id === "c1" || call.tool_id === "c2");
    assert.ok(call.tool_name === "read" || call.tool_name === "glob");
    assert.equal(call.end_ms! - call.at_ms, call.tool_id === "c1" ? 100 : 200);
  }
  // Turn 2 has a start but no reply: honestly open, no fabricated end.
  const t2 = s.events.filter((e) => e.turn_id === "turn-2");
  assert.deepEqual(t2.map((e) => e.kind), ["start"]);

  // Tokens are per-request on each assistant message (verified: input resets
  // per step while cacheRead grows; `total` equals the component sum), so a
  // turn sums its steps: 100+200 input, 50+70 output, 10 reasoning, 20 read,
  // 5 write, total 455.
  const tokens1 = s.tokens.find((t) => t.turn_id === "turn-1")!;
  assert.equal(tokens1.input_tokens, 300);
  assert.equal(tokens1.output_tokens, 120);
  assert.equal(tokens1.reasoning_output_tokens, 10);
  assert.equal(tokens1.cached_input_tokens, 20);
  assert.equal(tokens1.cache_write_input_tokens, 5);
  assert.equal(tokens1.total_tokens, 455);
  assert.equal(s.tokens.find((t) => t.turn_id === "turn-2"), undefined);
});

sql("parseOpencode: parallel tools are unioned, not double counted", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  const result = parseOpencode(file);
  const t1 = result[0].events.filter((e) => e.turn_id === "turn-1");
  // spans 500 + 400 = 900; tool union [300,550] = 250 → model api 650.
  const timing = calculateOpencodeTiming(t1);
  assert.equal(timing.work_ms, 900);
  assert.equal(timing.breakdown.tool_execution_ms, 250);
  assert.equal(timing.breakdown.model_api_ms, 650);
  // Intra-turn step gap (step 1 completes at +700, step 2 starts at +800):
  // reported as unclassified delay, never folded into work.
  assert.equal(timing.breakdown.unclassified_delay_ms, 100);
  // Reasoning burst is a sub-drill under the model span, per model.
  assert.deepEqual(timing.breakdown.thinking_breakdown, [
    { level: "google/gemini-3-pro", duration_ms: 50 },
  ]);
  // No approval evidence exists in the database: honestly unknown.
  assert.equal(timing.review_wait_ms, null);
  const tools = timing.breakdown.tools.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(
    tools.map((t) => [t.name, t.count]),
    [
      ["glob", 1],
      ["read", 1],
    ],
  );
});

sql("store roundtrip: OpenCode three-state timing and standby", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  await store.importFile(file, null, "opencode");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, "opencode/ses_a");
  assert.equal(s.agent, "OpenCode");
  const t1 = s.turns.find((t) => t.id === "turn-1")!;
  assert.equal(t1.status, "completed");
  assert.equal(t1.work_ms, 900);
  assert.equal(t1.review_wait_ms, null);
  assert.equal(t1.breakdown?.model_api_ms, 650);
  assert.equal(t1.breakdown?.tool_execution_ms, 250);
  assert.equal(t1.breakdown?.unclassified_delay_ms, 100);
  assert.deepEqual(t1.breakdown?.thinking_breakdown, [
    { level: "google/gemini-3-pro", duration_ms: 50 },
  ]);
  assert.equal(t1.tokens?.total_tokens, 455);
  const t2 = s.turns.find((t) => t.id === "turn-2")!;
  assert.equal(t2.status, "open");
  // standby = turn2 user message (T0+2000) − turn1 completion (T0+1200).
  assert.equal(t2.standby_ms, 800);
  assert.equal(s.tokens?.total_tokens, 455);
});

sql("parseOpencode: session_v2 schema is rejected, not mis-parsed", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE session_v2(id text PRIMARY KEY); CREATE TABLE session_message(id text PRIMARY KEY);");
  db.close();
  assert.throws(() => parseOpencode(file), ValidationError, /session_v2/);
});

sql("parseOpencode: a non-SQLite file fails with a clear error", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  writeFileSync(file, "this is not a database");
  assert.throws(() => parseOpencode(file), ValidationError);
});

sql("parseOpencode: never writes the source database", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  const before = statSync(file);
  parseOpencode(file);
  const after = statSync(file);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  // No WAL/SHM sidecars may appear next to a read-only opened source.
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.startsWith("opencode.db-")),
    [],
  );
});

sql("transcript: prompt, thinking, models and tool-call details", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  const turns = extractOpencodeTranscript(file, "opencode/ses_a");
  assert.equal(turns.length, 2);
  const t1 = turns.find((t) => t.turn_id === "turn-1")!;
  assert.equal(t1.prompt, "修复登录页面的样式问题");
  assert.equal(t1.thinking, "先看组件结构");
  assert.deepEqual(t1.models, ["google/gemini-3-pro"]);
  assert.equal(t1.tool_calls.length, 2);
  const c1 = t1.tool_calls.find((c) => c.call_id === "c1")!;
  assert.equal(c1.name, "read");
  assert.equal(c1.duration_ms, 100);
  assert.equal(c1.detail, "ls src");
  const t2 = turns.find((t) => t.turn_id === "turn-2")!;
  assert.equal(t2.prompt, "再看看移动端");
  assert.equal(t2.tool_calls.length, 0);
});

sql("store.transcript dispatches the OpenCode extractor", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  await store.importFile(file, null, "opencode");
  const tr = store.transcript("opencode/ses_a");
  assert.ok(tr);
  assert.equal(tr.missing_fields.length, 0);
  const t1 = tr.turns.find((t) => t.turn_id === "turn-1")!;
  assert.equal(t1.prompt, "修复登录页面的样式问题");
  assert.ok(t1.tool_calls.some((c) => c.name === "read"));
});

sql("directories: root-level opencode.db is discovered and synced", async () => {
  const { store, home, dirs } = setup();
  const root = path.join(home, ".local", "share", "opencode");
  mkdirSync(root, { recursive: true });
  const file = path.join(root, "opencode.db");
  twoTurnDb(file);
  dirs.save("opencode", root, true);
  const { files, agents, notices } = dirs.collect();
  assert.equal(files.size, 1);
  assert.ok(files.has(realpathSync(file)));
  assert.equal(agents.get(realpathSync(file)), "opencode");
  assert.deepEqual(notices, []);
  await store.refresh(dirs);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "OpenCode");
});

sql("directories: default ~/.local/share/opencode is prefilled", () => {
  const { home, dirs } = setup();
  const info = dirs.get("opencode");
  assert.equal(info.name, "OpenCode");
  assert.equal(info.default_path, "~/.local/share/opencode");
  assert.equal(info.supported, true);
});

sql("error tools still count as executed work with their own timestamps", () => {  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  const db = buildDb(file);
  insertSession(db, {
    users: [{ id: "u1", at: T0 + 100, text: "跑一下技能" }],
    steps: [
      {
        id: "a1",
        created: T0 + 200,
        completed: T0 + 600,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
        tools: [
          {
            callID: "c9",
            tool: "skill",
            start: T0 + 300,
            end: T0 + 301,
            status: "error",
            input: { name: "superpowers/missing" },
          },
        ],
      },
    ],
  });
  db.close();
  const result = parseOpencode(file);
  const t1 = result[0].events.filter((e) => e.turn_id === "turn-1");
  const toolResult = t1.find((e) => e.kind === "tool_result")!;
  assert.equal(toolResult.at_ms, T0 + 300);
  assert.equal(toolResult.end_ms, T0 + 301);
  assert.equal(toolResult.tool_name, "skill");
});

sql("reasoning parts without a credible end are skipped with an issue, not guessed", () => {
  const { dir } = setup();
  const file = path.join(dir, "opencode.db");
  const db = buildDb(file);
  insertSession(db, {
    users: [{ id: "u1", at: T0 + 100 }],
    steps: [
      {
        id: "a1",
        created: T0 + 200,
        completed: T0 + 600,
        // Real corpus: 3/285 reasoning rows carry no time.end.
        reasoning: { text: "思考中断的段落", start: T0 + 210, end: T0 + 260 },
        tools: [],
      },
      {
        id: "a2",
        created: T0 + 700,
        completed: T0 + 900,
        // A degenerate burst with no end at all is skipped with an issue.
      },
    ],
  });
  // Overwrite step a2's reasoning part with a missing end directly.
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
  ).run(
    "rp_endless",
    "ses_a_a2",
    "ses_a",
    T0 + 999_999,
    T0 + 999_999,
    JSON.stringify({ type: "reasoning", text: "无结束时间", time: { start: T0 + 720 } }),
  );
  db.close();
  const result = parseOpencode(file)[0];
  // Only the well-formed burst becomes a thinking event.
  const thinking = result.events.filter((e) => e.kind === "thinking");
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0].at_ms, T0 + 210);
  assert.equal(thinking[0].end_ms, T0 + 260);
  assert.ok(
    result.issues.some((i) => i.includes("reasoning 段缺少有效起止时间戳")),
    `issues: ${JSON.stringify(result.issues)}`,
  );
});

sql("refresh: an unknown saved agent name fails loudly instead of falling back to codex", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "opencode.db");
  twoTurnDb(file);
  await store.importFile(file, null, "opencode");
  // Simulate a snapshot row stamped with an agent name no adapter claims:
  // the old ternary silently re-imported it as Codex (mis-routed parse).
  store.db
    .prepare("UPDATE source SET agent=?, path=?")
    .run("MysteryAgent", file);
  const result = await store.refresh();
  assert.equal(result.failed, 1);
  assert.deepEqual(
    result.failures.map((f) => f.reason),
    [
      "已登记会话的 Agent 标识无法识别（MysteryAgent）；已跳过该文件，防止误按 Codex 口径分流",
    ],
  );
  // The stale snapshot keeps its rows rather than being overwritten with
  // wrong-adapter statistics.
  const row = store.db
    .prepare("SELECT agent, last_error FROM source")
    .get() as unknown as { agent: string; last_error: string | null };
  assert.equal(row.agent, "MysteryAgent");
  assert.ok(row.last_error);
});

sql("one .db file with several sessions registers one snapshot per session", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "opencode.db");
  const db = buildDb(file);
  insertSession(db, {
    sid: "ses_one",
    title: "第一个会话",
    users: [{ id: "u1", at: T0 + 100, text: "第一问" }],
    steps: [
      {
        id: "a1",
        created: T0 + 200,
        completed: T0 + 300,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  });
  insertSession(db, {
    sid: "ses_two",
    title: "第二个会话",
    worktree: "/home/user/other",
    users: [{ id: "u1", at: T0 + 500, text: "第二问" }],
    steps: [
      {
        id: "a1",
        created: T0 + 600,
        completed: T0 + 900,
        tokens: { input: 20, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ],
  });
  db.close();
  const parsed = parseOpencode(file);
  assert.equal(parsed.length, 2);
  await store.importFile(file, null, "opencode");
  // Re-import must upsert cleanly (legacy UNIQUE(path) would reject the
  // second snapshot of the same file).
  await store.importFile(file, null, "opencode");
  const sessions = store.sessions();
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.project).sort(), ["other", "proj-y"]);
  assert.deepEqual(sessions.map((s) => s.id).sort(), [
    "opencode/ses_one",
    "opencode/ses_two",
  ]);
  for (const s of sessions) assert.equal(s.turns.length, 1);
});

sql("legacy UNIQUE(path) databases are migrated, keeping rows and events", async () => {
  const { dir } = setup();
  const dbFile = path.join(dir, "legacy.sqlite3");
  // Build a store with the CURRENT schema, then rewrite the source table
  // back to the legacy shape to simulate an existing installation.
  {
    const store = new Store(dbFile);
    store.close();
  }
  const raw = new DatabaseSync(dbFile);
  raw.exec(`
    ALTER TABLE event RENAME TO event_backup;
    ALTER TABLE token_usage RENAME TO token_backup;
    DROP TABLE source;
    CREATE TABLE source (
     id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
     project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL, last_error TEXT, config_root TEXT, title TEXT, agent TEXT,
     imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE event_backup RENAME TO event;
    ALTER TABLE token_backup RENAME TO token_usage;
    INSERT INTO source(id,path,session_id,project,client,issues,agent)
      VALUES('legacy1','/tmp/legacy.jsonl','ses_legacy','proj','Codex','[]','Codex');
  `);
  raw.close();
  const store = new Store(dbFile);
  try {
    // The same path may now back two snapshots (the OpenCode shape).
    store.db
      .prepare(
        "INSERT INTO source(id,path,session_id,project,client,issues,agent) VALUES(?,?,?,?,?,?,?)",
      )
      .run("legacy2", "/tmp/legacy.jsonl", "ses_other", "proj", "Codex", "[]", "Codex");
    assert.equal(store.db.prepare("SELECT COUNT(*) c FROM source").get().c, 2);
  } finally {
    store.close();
  }
});
