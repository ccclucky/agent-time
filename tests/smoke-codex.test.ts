import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL("../scripts/smoke-codex.mts", import.meta.url));
const tsxCli = require.resolve("tsx/cli");

const resources: string[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-smoke-")));
  resources.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of resources.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const meta = (id: string) => ({
  type: "session_meta",
  timestamp: "2026-10-21T00:00:00Z",
  payload: { id, source: "cli", cwd: "/work/example", originator: "codex_cli_rs", history_mode: "paginated" },
});
const turn = () => [
  { type: "event_msg", timestamp: "2026-10-21T00:00:00Z", payload: { type: "task_started", turn_id: "t1" } },
  { type: "event_msg", timestamp: "2026-10-21T00:01:00Z", payload: { type: "task_complete", turn_id: "t1" } },
];
function zstFile(root: string, rel: string, rows: unknown[]) {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  const text = rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(p, zlib.zstdCompressSync(Buffer.from(text)));
  return p;
}

function runSmoke(codexHome: string) {
  return spawnSync(process.execPath, [tsxCli, SCRIPT], {
    env: { ...process.env, CODEX_HOME: codexHome },
    encoding: "utf8",
    timeout: 120000,
  });
}

test("smoke: codex exits 0 with a classified summary on a synthetic mini-tree", () => {
  const home = setup();
  zstFile(home, "sessions/2026/06/13/rollout-a.jsonl.zst", [meta("a"), ...turn()]);
  // empty stub: metadata only, zero events
  zstFile(home, "sessions/2026/06/13/rollout-b.jsonl.zst", [meta("b")]);
  // excluded by design: subagent provenance
  zstFile(home, "sessions/2026/06/14/rollout-c.jsonl.zst", [
    { ...meta("c"), payload: { ...meta("c").payload, forked_from_id: "parent" } },
    ...turn(),
  ]);
  zstFile(home, "archived_sessions/rollout-d.jsonl.zst", [meta("d"), ...turn()]);
  // external-import-only: all turns stripped of timing events by design
  zstFile(home, "sessions/2026/06/14/rollout-e.jsonl.zst", [
    meta("e"),
    { type: "event_msg", timestamp: "2026-10-21T00:00:00Z", payload: { type: "task_started", turn_id: "external-import-turn-1" } },
    { type: "event_msg", timestamp: "2026-10-21T00:00:00Z", payload: { type: "task_complete", turn_id: "external-import-turn-1" } },
  ]);
  const r = runSmoke(home);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /"total"\s*:\s*5/);
  assert.match(r.stdout, /"imported"\s*:\s*2/);
  assert.match(r.stdout, /"empty_stubs"\s*:\s*1/);
  assert.match(r.stdout, /"external_import_only"\s*:\s*1/);
  assert.match(r.stdout, /"excluded_by_design"\s*:\s*1/);
  assert.match(r.stdout, /"failures"\s*:\s*\[\]/);
});

test("smoke: a corrupted zst file makes the run exit non-zero with the reason", () => {
  const home = setup();
  zstFile(home, "sessions/2026/06/13/rollout-a.jsonl.zst", [meta("a"), ...turn()]);
  const broken = path.join(home, "sessions/2026/06/13/rollout-broken.jsonl.zst");
  mkdirSync(path.dirname(broken), { recursive: true });
  writeFileSync(broken, Buffer.from("garbage-not-zstd"));
  const r = runSmoke(home);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /"failures"\s*:\s*\[\n/);
  assert.match(r.stdout, /rollout-broken\.jsonl\.zst/);
});
