import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// node:sqlite is experimental before 22.15; CI runs 22.15.0 and 24. The gate
// keeps the suite skippable on older local Node versions, matching the
// OpenCode adapter tests.
const sqliteMod = process.getBuiltinModule?.("node:sqlite") as
  | typeof import("node:sqlite")
  | undefined;
const DatabaseSync = sqliteMod?.DatabaseSync;
const sql = DatabaseSync ? test : test.skip;

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(
  new URL("../scripts/smoke-opencode.mts", import.meta.url),
);
const tsxCli = require.resolve("tsx/cli");

const resources: string[] = [];
function setup() {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "agenttime-smoke-oc-")),
  );
  resources.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of resources.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_770_000_000_000;

/** Minimal old-layout OpenCode database with one two-step turn. */
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
  `);
  db.prepare(
    "INSERT INTO project(id,worktree,name,time_created,time_updated) VALUES('p1','/home/user/proj',NULL,?,?)",
  ).run(T0, T0);
  db.prepare(
    "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES('ses_a','p1',NULL,'s','/home/user/proj','冒烟','1.2.0',?,?)",
  ).run(T0, T0);
  const putMsg = db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?)",
  );
  const putPart = db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
  );
  putMsg.run("m_u", "ses_a", T0, T0, JSON.stringify({ role: "user", time: { created: T0 + 100 } }));
  putMsg.run(
    "m_a1",
    "ses_a",
    T0,
    T0,
    JSON.stringify({
      role: "assistant",
      time: { created: T0 + 200, completed: T0 + 500 },
      parentID: "m_u",
      modelID: "test-model",
      providerID: "test",
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  );
  putPart.run(
    "p_r",
    "m_a1",
    "ses_a",
    T0,
    T0,
    JSON.stringify({ type: "reasoning", text: "思考", time: { start: T0 + 210, end: T0 + 260 } }),
  );
  db.close();
}

function runSmoke(dataRoot: string) {
  return spawnSync(process.execPath, [tsxCli, SCRIPT], {
    env: { ...process.env, OPENCODE_HOME: dataRoot },
    encoding: "utf8",
    timeout: 120000,
  });
}

sql("smoke: opencode exits 0 with counted rows on a synthetic database", () => {
  const root = setup();
  buildDb(path.join(root, "opencode.db"));
  const r = runSmoke(root);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /"sessions"\s*:\s*1/);
  assert.match(r.stdout, /"turns"\s*:\s*1/);
  assert.match(r.stdout, /"events"\s*:\s*[1-9]/);
  assert.match(r.stdout, /"token_rows"\s*:\s*1/);
  assert.match(r.stdout, /"failures"\s*:\s*\[\]/);
  assert.match(r.stdout, /"source_untouched"\s*:\s*true/);
});

sql("smoke: a missing opencode database is an explicit skip with exit 0", () => {
  const root = setup();
  const r = runSmoke(root);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /OpenCode 会话数据库不存在/);
  assert.match(r.stdout, /跳过冒烟/);
});

sql("smoke: a corrupt database fails the run with the parse reason", () => {
  const root = setup();
  writeFileSync(path.join(root, "opencode.db"), "not a sqlite database");
  const r = runSmoke(root);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /"failures"\s*:\s*\[\s*"/);
});
