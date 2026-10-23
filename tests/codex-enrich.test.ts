import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
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
