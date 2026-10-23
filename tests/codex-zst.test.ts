import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { parse, linesZst, DECOMPRESSED_CAP } from "../src/codex.js";
import { ValidationError } from "../src/types.js";
import { report } from "../src/metrics.js";
const hasZstd =
  typeof zlib.zstdCompressSync === "function" &&
  typeof zlib.zstdDecompressSync === "function";
const zst = hasZstd ? test : test.skip;
const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-zst-"))),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return { dir, store, home, dirs: new Directories(store, home, {}, "linux") };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
const meta = (id = "s1", extra = {}) => ({
  type: "session_meta",
  payload: {
    id,
    source: "cli",
    cwd: "/work/example",
    originator: "codex_cli_rs",
    history_mode: "paginated",
    ...extra,
  },
});
const event = (type: string, minute: number, turn = "t1", extra = {}) => ({
  type: "event_msg",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  payload: { type, turn_id: turn, ...extra },
});
const rows = () => [
  meta(),
  event("task_started", 0),
  event("task_complete", 10),
];
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
function zstFile(dir: string, rows: unknown[], name = "a.jsonl.zst") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  const text = rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(p, zlib.zstdCompressSync(Buffer.from(text)));
  return p;
}
const summary = (s: Store) =>
  report(s.sessions(), "2026-10-21", "2026-10-21", "UTC").summary;
test("plain .jsonl sessions with paginated history_mode import", async () => {
  const { dir, store } = setup();
  await store.importFile(file(dir, [meta("p1"), event("task_started", 0), event("task_complete", 10)]));
  assert.equal(store.sessions().length, 1);
  assert.equal(summary(store).processing_ms, 600000);
});
zst("parse reads .jsonl.zst identically to the uncompressed original", async () => {
  const { dir } = setup();
  const expected = await parse(file(dir, rows(), "plain.jsonl"));
  const result = await parse(zstFile(dir, rows(), "rollout-2026-06-13T09-30-00-01.jsonl.zst"));
  assert.deepEqual(result, expected);
  assert.equal(result.session.id, "s1");
  assert.equal(result.events.length, 2);
});
zst("importFile stores .jsonl.zst events idempotently", async () => {
  const { dir, store } = setup(),
    p = zstFile(dir, rows());
  const { events, issues } = await store.importFile(p);
  assert.equal(events, 2);
  assert.ok(issues.some((i: string) => /三态切分/.test(i)));
  await store.importFile(p);
  assert.equal(store.sessions().length, 1);
  assert.equal(summary(store).processing_ms, 600000);
  assert.equal(
    store.db.prepare("SELECT count(*) n FROM event").get()!.n,
    2,
  );
});
zst("collect discovers nested .jsonl.zst for codex only, claude stays .jsonl", async () => {
  const { store, dirs, home } = setup();
  const zstP = zstFile(
    path.join(home, ".codex", "sessions", "2026", "06", "13"),
    [meta("z1"), event("task_started", 0), event("task_complete", 5)],
    "rollout-2026-06-13T09-30-00-019f.jsonl.zst",
  );
  const jsonlP = file(
    path.join(home, ".codex", "sessions"),
    [meta("p1"), event("task_started", 0), event("task_complete", 10)],
    "plain.jsonl",
  );
  const claudeZst = zstFile(
    path.join(home, ".claude", "projects", "p"),
    rows(),
    "c.jsonl.zst",
  );
  dirs.save("codex", null, true);
  dirs.save("claude", null, true);
  const { files } = dirs.collect();
  assert(files.has(realpathSync(zstP)));
  assert(files.has(realpathSync(jsonlP)));
  assert(!files.has(realpathSync(claudeZst)));
  assert.equal((await store.refresh(dirs)).updated, 2);
  assert.equal(store.sessions().length, 2);
  assert.equal(summary(store).processing_ms, 900000);
});
zst("claude adapter rejects .zst files", async () => {
  const { dir, store } = setup(),
    p = zstFile(dir, rows());
  await assert.rejects(() => store.importFile(p, null, "claude"), ValidationError);
  assert.equal(store.sessions().length, 0);
});
zst("codex importFile rejects a bare .zst file that is not .jsonl.zst", async () => {
  const { dir, store } = setup(),
    p = zstFile(dir, rows(), "plain.zst");
  await assert.rejects(() => store.importFile(p), ValidationError);
  assert.equal(store.sessions().length, 0);
});
zst("corrupt zstd data reports a validation error without importing", async () => {
  const { dir, store } = setup(),
    p = path.join(dir, "broken.jsonl.zst");
  writeFileSync(p, Buffer.from("garbage-not-zstd"));
  await assert.rejects(() => store.importFile(p), ValidationError);
  assert.equal(store.sessions().length, 0);
});
zst("streaming decode enforces the cumulative decompressed-size cap", async () => {
  const { dir } = setup();
  const payload = [
    meta(),
    event("task_started", 0, "t1"),
    event("task_complete", 10, "t1"),
  ];
  const p = zstFile(dir, payload);
  const text = payload.map((x) => JSON.stringify(x)).join("\n") + "\n";
  const size = Buffer.byteLength(text);
  // Exact decompressed size: allowed, and the streamed lines reassemble the
  // original payload byte for byte.
  const got: Buffer[] = [];
  for await (const line of linesZst(p, size)) got.push(line);
  assert.equal(Buffer.concat(got).toString(), text);
  // One byte under the payload: the cumulative cap rejects mid-stream.
  await assert.rejects(
    async () => {
      for await (const _ of linesZst(p, size - 1));
    },
    ValidationError,
  );
  // The production ceiling is 2 GiB of decompressed output.
  assert.equal(DECOMPRESSED_CAP, 2 * 1024 * 1024 * 1024);
});
zst("decompressed records still respect the 16 MiB single-line cap", async () => {
  const { dir } = setup(),
    p = zstFile(dir, [
      meta(),
      event("task_started", 0, "t1", { pad: "x".repeat(17 * 1024 * 1024) }),
    ]);
  await assert.rejects(() => parse(p), ValidationError);
});
