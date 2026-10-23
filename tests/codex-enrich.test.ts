import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { parse, readSessionIndex } from "../src/codex.js";
import { report } from "../src/metrics.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-enrich-"))),
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
const msg = (type: string, minute: number, turn: string, extra = {}, second = 0) => ({
  type: "event_msg",
  timestamp: ts(minute, second),
  payload: { type, turn_id: turn, ...extra },
});
const resp = (ptype: string, minute: number, extra = {}, second = 0) => ({
  type: "response_item",
  timestamp: ts(minute, second),
  payload: { type: ptype, ...extra },
});
const tokenRow = (minute: number, info, second = 0) => ({
  type: "event_msg",
  timestamp: ts(minute, second),
  payload: { type: "token_count", info },
});
const usage = (over = {}) => ({
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
  ...over,
});
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
function sessionIndex(configRoot: string, entries: unknown[]) {
  const p = path.join(configRoot, "session_index.jsonl");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(p, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}

// ---------------------------------------------------------------- slice A: index

test("readSessionIndex parses named threads with odd fractional updated_at digits", () => {
  const { dir } = setup();
  sessionIndex(dir, [
    {
      id: "019c1210-c26b-7f20-bcb0-670265d486b1",
      thread_name: "Remove .env from git history",
      updated_at: "2026-03-12T17:17:06.6699Z",
    },
    {
      id: "019c1254-bf07-7710-a7f6-26a5f519efe9",
      thread_name: "查找已有 ChatGPT 对话",
      updated_at: "2026-03-12T17:17:06.69692Z",
    },
  ]);
  const map = readSessionIndex(dir);
  assert.equal(map.size, 2);
  assert.equal(map.get("019c1210-c26b-7f20-bcb0-670265d486b1")?.name, "Remove .env from git history");
  assert.equal(map.get("019c1254-bf07-7710-a7f6-26a5f519efe9")?.name, "查找已有 ChatGPT 对话");
  // timestamp() rounds half-even to milliseconds (.6699 -> .670); Date.parse
  // would truncate, so the oracle is the rounded instant itself.
  assert.equal(
    map.get("019c1210-c26b-7f20-bcb0-670265d486b1")?.updated_at_ms,
    Date.parse("2026-03-12T17:17:06.670Z"),
  );
});

test("readSessionIndex degrades to an empty map on missing index, null root or bad lines", () => {
  const { dir } = setup();
  assert.equal(readSessionIndex(path.join(dir, "absent")).size, 0);
  assert.equal(readSessionIndex(null).size, 0);
  sessionIndex(dir, [
    "{ not json",
    { id: "x1", updated_at: "2026-03-12T17:17:06.6699Z" }, // no thread_name
    { thread_name: "匿名", updated_at: "2026-03-12T17:17:06.6699Z" }, // no id
    { id: "x2", thread_name: "", updated_at: "oops" }, // empty name
    { id: "x3", thread_name: "有效线程", updated_at: "garbage" }, // name kept, ts null
  ]);
  const map = readSessionIndex(dir);
  assert.equal(map.size, 1);
  assert.equal(map.get("x3")?.name, "有效线程");
  assert.equal(map.get("x3")?.updated_at_ms, null);
});

test("importFile enriches the topic from the session index under the config root", () => {
  const { dir, store } = setup();
  const configRoot = path.join(dir, "codex-home");
  sessionIndex(configRoot, [
    { id: "s1", thread_name: "修复构建脚手架", updated_at: "2026-05-01T08:00:00.5Z" },
  ]);
  const p = file(dir, [meta("s1"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")]);
  store.importFile(p, configRoot);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].topic, "修复构建脚手架");
  const rep = report(sessions, "2026-10-21", "2026-10-21", "UTC", "Codex");
  assert.equal(rep.sessions[0].topic, "修复构建脚手架");
});

test("unnamed sessions and missing indexes import fine without a topic", () => {
  const { dir, store } = setup();
  const configRoot = path.join(dir, "codex-home");
  sessionIndex(configRoot, [{ id: "other", thread_name: "别的线程", updated_at: "2026-05-01T08:00:00Z" }]);
  store.importFile(
    file(dir, [meta("s1"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")], "named.jsonl"),
    configRoot,
  );
  store.importFile(
    file(dir, [meta("s2"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")], "noindex.jsonl"),
    path.join(dir, "empty-root"),
  );
  const sessions = store.sessions();
  assert.deepEqual(
    sessions.map((s) => s.topic).sort(),
    [null, null],
  );
});

test("a stale topic is cleared when a later import no longer finds the thread", () => {
  const { dir, store } = setup();
  const configRoot = path.join(dir, "codex-home");
  const indexPath = sessionIndex(configRoot, [
    { id: "s1", thread_name: "旧主题", updated_at: "2026-05-01T08:00:00Z" },
  ]);
  const p = file(dir, [meta("s1"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")]);
  store.importFile(p, configRoot);
  assert.equal(store.sessions()[0].topic, "旧主题");
  unlinkSync(indexPath);
  store.importFile(p, configRoot);
  assert.equal(store.sessions()[0].topic, null);
});

test("topics longer than 100 characters are truncated like project names", () => {
  const { dir, store } = setup();
  const configRoot = path.join(dir, "codex-home");
  sessionIndex(configRoot, [{ id: "s1", thread_name: "主".repeat(150), updated_at: "2026-05-01T08:00:00Z" }]);
  store.importFile(
    file(dir, [meta("s1"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")]),
    configRoot,
  );
  assert.equal(store.sessions()[0].topic?.length, 100);
});

// ---------------------------------------------------------------- slice B: tokens

test("token_count snapshots become per-turn diffs keyed by the nearest task_started", () => {
  const { dir } = setup();
  const result = parse(
    file(dir, [
      meta(),
      // before any task_started: not attributable, skipped entirely
      tokenRow(0, { total_token_usage: usage({ total_tokens: 5 }) }, 1),
      msg("task_started", 0, "t1"),
      // repeated last_token_usage rows prove a naive sum would double-count
      tokenRow(1, {
        total_token_usage: usage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 12, reasoning_output_tokens: 3, total_tokens: 112 }),
        last_token_usage: usage({ input_tokens: 100, output_tokens: 12, total_tokens: 112 }),
      }),
      tokenRow(2, {
        total_token_usage: usage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 12, reasoning_output_tokens: 3, total_tokens: 112 }),
        last_token_usage: usage({ input_tokens: 100, output_tokens: 12, total_tokens: 112 }),
      }),
      msg("task_complete", 2, "t1"),
      msg("task_started", 3, "t2"),
      tokenRow(4, {
        total_token_usage: usage({ input_tokens: 300, cached_input_tokens: 90, cache_write_input_tokens: 7, output_tokens: 62, reasoning_output_tokens: 9, total_tokens: 362 }),
      }),
      // snapshot diffs: reasoning in t2 is 9 - 3 = 6, cached is 90 - 40 = 50
      msg("task_complete", 5, "t2"),
      msg("task_started", 6, "t3"), // no token rows at all
      msg("task_complete", 7, "t3"),
    ]),
  );
  assert.deepEqual(
    result.tokens.map((t) => [t.turn_id, t.input_tokens, t.cached_input_tokens, t.cache_write_input_tokens, t.output_tokens, t.reasoning_output_tokens, t.total_tokens]),
    [
      ["t1", 100, 40, 0, 12, 3, 112],
      ["t2", 200, 50, 7, 50, 6, 250],
    ],
  );
});

test("token rows with null info or malformed usage are skipped without failing", () => {
  const { dir } = setup();
  const result = parse(
    file(dir, [
      meta(),
      msg("task_started", 0, "t1"),
      tokenRow(0, null, 10),
      tokenRow(0, {}, 20),
      tokenRow(0, { total_token_usage: { input_tokens: "x", total_tokens: 42 } }, 30),
      tokenRow(0, { total_token_usage: usage({ input_tokens: 20, output_tokens: 4, total_tokens: 24 }) }, 40),
      msg("task_complete", 1, "t1"),
    ]),
  );
  assert.deepEqual(
    result.tokens.map((t) => [t.turn_id, t.total_tokens]),
    [["t1", 24]],
  );
});

test("sessions surface per-turn and per-session token totals; absence stays null", () => {
  const { dir, store } = setup();
  store.importFile(
    file(
      dir,
      [
        meta("s1"),
        msg("task_started", 0, "t1"),
        tokenRow(1, { total_token_usage: usage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 12, total_tokens: 112 }) }),
        msg("task_complete", 2, "t1"),
        msg("task_started", 3, "t2"),
        tokenRow(4, { total_token_usage: usage({ input_tokens: 300, cached_input_tokens: 90, output_tokens: 62, total_tokens: 362 }) }),
        msg("task_complete", 5, "t2"),
      ],
      "tokens.jsonl",
    ),
  );
  store.importFile(
    file(
      dir,
      [meta("s2"), msg("task_started", 0, "t1"), msg("task_complete", 2, "t1")],
      "notokens.jsonl",
    ),
  );
  const byId = new Map(store.sessions().map((s) => [s.id, s]));
  const s1 = byId.get("s1")!;
  assert.equal(s1.turns[0].tokens?.total_tokens, 112);
  assert.equal(s1.turns[0].tokens?.cached_input_tokens, 40);
  assert.equal(s1.turns[1].tokens?.total_tokens, 250);
  assert.equal(s1.tokens?.total_tokens, 362);
  assert.equal(s1.tokens?.input_tokens, 300);
  const s2 = byId.get("s2")!;
  assert.equal(s2.tokens, null);
  assert.equal(s2.turns[0].tokens ?? null, null);
  const rep = report([...byId.values()], "2026-10-21", "2026-10-21", "UTC", "Codex");
  const r1 = rep.sessions.find((s) => s.id === "s1")!;
  assert.equal(r1.tokens?.total_tokens, 362);
  assert.equal(r1.turns[0].tokens?.total_tokens, 112);
  const r2 = rep.sessions.find((s) => s.id === "s2")!;
  assert.equal(r2.tokens ?? null, null);
});

test("token_usage rows are rewritten idempotently per source", () => {
  const { dir, store } = setup();
  const p = file(dir, [
    meta("s1"),
    msg("task_started", 0, "t1"),
    tokenRow(1, { total_token_usage: usage({ input_tokens: 100, output_tokens: 12, total_tokens: 112 }) }),
    msg("task_complete", 2, "t1"),
  ]);
  store.importFile(p);
  store.importFile(p);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM token_usage").get()!.n,
    1,
  );
});

// ---------------------------------------------------------------- slice C: migration

test("opening an old-schema database migrates additively and preserves data", () => {
  const { dir } = setup();
  const dbPath = path.join(dir, "old.sqlite3");
  // Schema as of the T2 integration commit (e654817): agent columns exist,
  // but no topic column and no token_usage table.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE source (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
 project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL,
 config_root TEXT, agent TEXT NOT NULL DEFAULT 'Codex', imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE directory (agent TEXT PRIMARY KEY, path TEXT, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE event (
 source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
 key TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
 at_ms INTEGER NOT NULL, model TEXT, PRIMARY KEY(source_id,key)
);`);
  const OLD_KEY = "old-key";
  raw.prepare(
    "INSERT INTO source(id,path,session_id,project,client,issues,config_root,agent) VALUES('old1','/old/path','oldsess','旧项目','cli','[]',NULL,'Codex')",
  ).run();
  raw.prepare(
    "INSERT INTO event(source_id,key,turn_id,kind,at_ms,model) VALUES('old1',?,'t1','start',?,NULL)",
  ).run(OLD_KEY, BASE);
  raw.close();

  const store = new Store(dbPath);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].project, "旧项目");
  assert.equal(sessions[0].topic ?? null, null);
  assert.equal(sessions[0].turns[0].events[0].key, OLD_KEY);
  assert.equal(sessions[0].tokens ?? null, null);
  const cols = store.db.prepare("PRAGMA table_info(source)").all().map((r: any) => r.name);
  assert(cols.includes("topic"), "topic column must be added");
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all().map((r: any) => r.name);
  assert(tables.includes("token_usage"), "token_usage table must be created");
  // new imports into the migrated DB carry topic + tokens end to end
  const configRoot = path.join(dir, "codex-home");
  sessionIndex(configRoot, [{ id: "s1", thread_name: "迁移后的新主题", updated_at: "2026-05-01T08:00:00Z" }]);
  store.importFile(
    file(
      dir,
      [
        meta("s1"),
        msg("task_started", 0, "t1"),
        tokenRow(1, { total_token_usage: usage({ input_tokens: 10, output_tokens: 2, total_tokens: 12 }) }),
        msg("task_complete", 2, "t1"),
      ],
      "fresh.jsonl",
    ),
    configRoot,
  );
  const all = store.sessions();
  const fresh = all.find((s) => s.id === "s1")!;
  assert.equal(fresh.topic, "迁移后的新主题");
  assert.equal(fresh.tokens?.total_tokens, 12);
  const old = all.find((s) => s.id === "oldsess")!;
  assert.equal(old.project, "旧项目");
});

// ---------------------------------------------------------------- slice E: frontend

test("/api/report carries topic and tokens; app.js and index.html render them with a cache stamp", async () => {
  const { dir, store } = setup();
  const configRoot = path.join(dir, "codex-home");
  sessionIndex(configRoot, [{ id: "s1", thread_name: "前端联调主题", updated_at: "2026-05-01T08:00:00Z" }]);
  store.importFile(
    file(
      dir,
      [
        meta("s1"),
        msg("task_started", 0, "t1"),
        tokenRow(1, { total_token_usage: usage({ input_tokens: 900, cached_input_tokens: 300, output_tokens: 60, total_tokens: 960 }) }),
        msg("task_complete", 2, "t1"),
      ],
    ),
    configRoot,
  );
  const { makeServer } = await import("../src/server.js");
  const server = makeServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (p: string) =>
    fetch(`http://127.0.0.1:${port}${p}`).then((r) => {
      assert.equal(r.status, 200);
      return r.text();
    });
  try {
    const reportJson = JSON.parse(await get("/api/report?start=2026-10-21&end=2026-10-21&timezone=UTC"));
    const session = reportJson.sessions.find((s: { id: string }) => s.id === "s1");
    assert.equal(session.topic, "前端联调主题");
    assert.equal(session.tokens.total_tokens, 960);
    assert.equal(session.turns[0].tokens.cached_input_tokens, 300);

    const js = await get("/app.js");
    assert(js.includes("fmtTokens"), "token formatter exists");
    assert(js.includes("本轮 Token 用量"), "turn token KPI box exists");
    assert(js.includes("会话累计 Token"), "session token KPI box exists");
    assert(js.includes("session.topic"), "topic is consumed");
    assert(js.includes("源记录未携带 Token 快照"), "absent tokens render as absent, never zero");
    const html = await get("/");
    assert(html.includes("/style.css?v="), "style.css carries an explicit cache stamp");
    assert(html.includes("/app.js?v="), "app.js carries an explicit cache stamp");
  } finally {
    server.close();
  }
});
