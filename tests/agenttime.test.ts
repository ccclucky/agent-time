import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { Store } from "../src/store.js";
import { Directories, resolvePath } from "../src/directories.js";
import { locate } from "../src/locations.js";
import { bounds, report, unionMs } from "../src/metrics.js";
import { legacyJSON, hash, timestamp } from "../src/codex.js";
import { makeServer } from "../src/server.js";
const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-test-"))),
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
    instructions: "PRIVATE",
    ...extra,
  },
});
const event = (type: string, minute: number, turn = "t1", extra = {}) => ({
  type: "event_msg",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  payload: { type, turn_id: turn, ...extra },
});
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}
const rows = () => [
  meta(),
  event("task_started", 0),
  event("task_complete", 10),
];
const summary = (s: Store) =>
  report(s.sessions(), "2026-10-21", "2026-10-21", "UTC").summary;
test("read-only metadata import is private and idempotent", () => {
  const { dir, store } = setup(),
    p = file(dir, [
      ...rows(),
      { type: "response_item", payload: { text: "PRIVATE" } },
    ]),
    before = readFileSync(p);
  store.importFile(p);
  store.importFile(p);
  assert.deepEqual(readFileSync(p), before);
  assert.equal(summary(store).processing_ms, 600000);
  assert.equal(store.db.prepare("SELECT count(*) n FROM event").get()!.n, 2);
  assert(!JSON.stringify(store.sessions()).includes("PRIVATE"));
  assert(!readFileSync(store.path).includes(Buffer.from("PRIVATE")));
});
test("copied files and resumed sessions deduplicate and retain identity", () => {
  const { dir, store } = setup(),
    p = file(dir, rows()),
    copy = path.join(dir, "copy.jsonl");
  copyFileSync(p, copy);
  store.importFile(p);
  store.importFile(copy);
  store.importFile(
    file(
      dir,
      [
        meta(),
        event("task_started", 20, "t2"),
        event("task_complete", 25, "t2"),
      ],
      "resume.jsonl",
    ),
  );
  assert.equal(store.sessions().length, 1);
  assert.equal(summary(store).processing_ms, 900000);
});
test("legacy event hashes match existing Python databases including unicode", () => {
  const e = { turn_id: "t1", kind: "model", at_ms: 0, model: "模型😀" };
  assert.equal(
    legacyJSON(["s", e]),
    '["s", {"at_ms": 0, "kind": "model", "model": "\\u6a21\\u578b\\ud83d\\ude00", "turn_id": "t1"}]',
  );
  assert.equal(hash(legacyJSON(["s", e])).length, 64);
});
test("three overlapping executions use interval union", () => {
  const { dir, store } = setup();
  for (const [i, a, b] of [
    [1, 0, 30],
    [2, 10, 40],
    [3, 25, 45],
  ])
    store.importFile(
      file(
        dir,
        [meta("s" + i), event("task_started", a), event("task_complete", b)],
        i + ".jsonl",
      ),
    );
  const s = summary(store);
  assert.equal(s.processing_ms, 80 * 60000);
  assert.equal(s.processing_union_ms, 45 * 60000);
  assert.equal(s.overlap_ms, 35 * 60000);
});
test("period clipping preserves source duration", () => {
  const { dir, store } = setup(),
    r = rows();
  r[1].timestamp = "2026-10-20T23:55:00Z";
  store.importFile(file(dir, r));
  const result = report(store.sessions(), "2026-10-21", "2026-10-21", "UTC");
  assert.equal(result.summary.processing_ms, 600000);
  assert.equal(result.sessions[0].turns[0].elapsed_ms, 900000);
});
for (const [name, events, status, elapsed] of [
  ["missing end", [event("task_started", 0)], "open", null],
  ["missing start", [event("task_complete", 10)], "incomplete", null],
  [
    "reversed",
    [event("task_started", 10), event("task_complete", 0)],
    "invalid",
    null,
  ],
  [
    "conflicting starts",
    [
      event("task_started", 0),
      event("task_started", 1),
      event("task_complete", 10),
    ],
    "invalid",
    null,
  ],
  [
    "conflicting terminals",
    [
      event("task_started", 0),
      event("task_complete", 10),
      event("turn_aborted", 11),
    ],
    "invalid",
    null,
  ],
  [
    "failed completion",
    [
      event("task_started", 0),
      event("task_complete", 10, "t1", { error: "PRIVATE" }),
    ],
    "failed",
    600000,
  ],
  [
    "aborted aliases",
    [event("turn_started", 0), event("turn_aborted", 10)],
    "aborted",
    600000,
  ],
  [
    "zero duration",
    [event("task_started", 0), event("turn_complete", 0)],
    "completed",
    0,
  ],
] as const)
  test(name, () => {
    const { dir, store } = setup();
    store.importFile(file(dir, [meta(), ...events]));
    const t = store.sessions()[0].turns[0];
    assert.equal(t.status, status);
    assert.equal(t.elapsed_ms, elapsed);
    assert.equal(summary(store).processing_ms, elapsed);
    assert.equal(t.work_ms, null);
    assert.equal(t.human_ms, null);
  });
for (const extra of [
  { source: "unknown" },
  { source: "cloud" },
  { originator: "remote-worker" },
  { forked_from_id: "x" },
  { parent_thread_id: "x" },
  { history_base: 1 },
  { history_mode: "unsupported-private-value" },
  { thread_source: "subagent" },
  { subagent_history_start_ordinal: 1 },
])
  test("reject unsupported provenance " + JSON.stringify(extra), () => {
    const { dir, store } = setup();
    assert.throws(() =>
      store.importFile(
        file(dir, [meta("s1", extra), event("task_started", 0)]),
      ),
    );
    assert.equal(store.sessions().length, 0);
  });
test("rollback and mixed session identities reject whole snapshot", () => {
  const { dir, store } = setup();
  for (const tail of [
    { type: "event_msg", payload: { type: "thread_rolled_back" } },
    meta("different"),
  ])
    assert.throws(() => store.importFile(file(dir, [...rows(), tail])));
});
test("corruption and unassociated events warn without inventing data", () => {
  const { dir, store } = setup(),
    p = file(dir, [...rows(), event("task_complete", 10, "bad id")]);
  writeFileSync(p, readFileSync(p) + "not JSON PRIVATE\n");
  store.importFile(p);
  assert.equal(store.sessions()[0].issues.length, 2);
  assert.equal(summary(store).turns, 1);
  assert(!JSON.stringify(store.sessions()).includes("PRIVATE"));
});
test("timestamps require a timezone", () => {
  assert.throws(() => timestamp("2026-10-21T00:00:00"));
  assert.throws(() => timestamp("not a timestamp"));
  assert.throws(() => timestamp("2026-02-30T00:00:00Z"));
  assert.equal(
    timestamp("2026-10-21T00:00:00.000600Z"),
    Date.parse("2026-10-21T00:00:00Z") + 1,
  );
  assert.equal(
    timestamp("2026-10-21T00:00:00+08:00"),
    Date.parse("2026-10-20T16:00:00Z"),
  );
});
test("multiple models never multiply a round duration", () => {
  const { dir, store } = setup();
  store.importFile(
    file(dir, [
      ...rows(),
      ...["modelA", "modelB"].map((model) => ({
        type: "turn_context",
        timestamp: "2026-10-21T00:01:00Z",
        payload: { turn_id: "t1", model },
      })),
    ]),
  );
  assert.deepEqual(store.sessions()[0].turns[0].models, ["modelA", "modelB"]);
  assert.equal(summary(store).processing_ms, 600000);
});
test("empty data is unavailable, not zero", () => {
  assert.equal(summary(setup().store).processing_ms, null);
});
test("DST date boundaries use 23 and 25 hour days", () => {
  for (const [date, hours] of [
    ["2026-03-08", 23],
    ["2026-11-01", 25],
  ] as const) {
    const [a, b] = bounds(date, date, "America/New_York");
    assert.equal(b - a, hours * 3600000);
  }
});
test("invalid dates, timezone, backwards and excessive ranges are rejected", () => {
  for (const args of [
    ["2026-02-30", "2026-03-01", "UTC"],
    ["2026-10-22", "2026-10-21", "UTC"],
    ["2020-01-01", "2026-01-01", "UTC"],
    ["2026-10-21", "2026-10-21", "Invalid/Zone"],
  ])
    assert.throws(() => bounds(...(args as [string, string, string])));
});
test("union handles nested, touching, empty and negative intervals", () => {
  assert.equal(
    unionMs([
      [0, 20],
      [2, 4],
      [20, 30],
    ]),
    30,
  );
  assert.equal(unionMs([]), 0);
  assert.throws(() => unionMs([[2, 1]]));
});
test("default directories are metadata-only, disabled and evidence-backed", () => {
  const { store, dirs, home } = setup();
  file(path.join(home, ".codex", "sessions"), rows());
  const list = dirs.list();
  assert.equal(list.length, 6);
  assert(list.every((i) => !i.enabled));
  assert.equal(store.sessions().length, 0);
  assert.equal(list.find((i) => i.agent === "omp")!.path, "~/.omp/agent");
  assert.equal(list.find((i) => i.agent === "antigravity")!.path, null);
  assert(
    list
      .filter((i) => i.agent !== "antigravity")
      .every((i) => !!i.evidence_url),
  );
});
test("enable discovers new files, persists preferences and can reset defaults", () => {
  const { store, dirs, home } = setup();
  dirs.save("codex", null, true);
  file(path.join(home, ".codex", "sessions"), rows());
  assert.equal(store.refresh(dirs).updated, 1);
  file(
    path.join(home, ".codex", "sessions"),
    [meta("s2"), event("task_started", 0), event("task_complete", 5)],
    "b.jsonl",
  );
  assert.equal(store.refresh(dirs).updated, 2);
  assert.equal(store.sessions().length, 2);
  assert(new Directories(store, home, {}).get("codex").enabled);
  dirs.save("codex", path.join(home, "custom"), false);
  assert.equal(dirs.get("codex").source, "custom");
  dirs.save("codex", null, false);
  assert.equal(dirs.get("codex").source, "default");
});
test("disabled or changed roots retain history without reading it", () => {
  const { store, dirs, home } = setup();
  const p = file(path.join(home, ".codex", "sessions"), rows());
  dirs.save("codex", null, true);
  store.refresh(dirs);
  dirs.save("codex", null, false);
  writeFileSync(p, "invalid");
  assert.equal(store.refresh(dirs).failed, 0);
  assert.equal(summary(store).processing_ms, 600000);
  dirs.save("codex", path.join(home, "other"), true);
  assert.equal(store.refresh(dirs).updated, 0);
  assert.equal(summary(store).processing_ms, 600000);
});
test("manual imports refresh independently and failed snapshots recover", () => {
  const { store, dirs, dir } = setup(),
    p = file(dir, rows());
  store.importFile(p);
  writeFileSync(p, "invalid");
  assert.equal(store.refresh(dirs).failed, 1);
  assert.equal(summary(store).processing_ms, 600000);
  assert.equal(store.sourceInfo().failed_sources, 1);
  file(dir, rows());
  assert.equal(store.refresh(dirs).failed, 0);
  assert.equal(store.sourceInfo().failed_sources, 0);
});
test("archive relocation retires only completely covered snapshot", () => {
  const { store, dirs, home } = setup(),
    root = path.join(home, ".codex"),
    p = file(path.join(root, "sessions"), rows());
  dirs.save("codex", null, true);
  store.refresh(dirs);
  mkdirSync(path.join(root, "archived_sessions"));
  renameSync(p, path.join(root, "archived_sessions", "a.jsonl"));
  const result = store.refresh(dirs);
  assert.equal(result.relocated, 1);
  assert.equal(result.failed, 0);
  assert.equal(store.sourceInfo().registered_files, 1);
  assert.equal(summary(store).processing_ms, 600000);
});
test("partial archive copy retains unique historical events", () => {
  const { store, dirs, home } = setup(),
    root = path.join(home, ".codex"),
    p = file(path.join(root, "sessions"), rows());
  dirs.save("codex", null, true);
  store.refresh(dirs);
  rmSync(p);
  file(path.join(root, "archived_sessions"), [
    meta(),
    event("task_started", 0),
  ]);
  const result = store.refresh(dirs);
  assert.equal(result.relocated, 0);
  assert.equal(result.failed, 1);
  assert.equal(summary(store).processing_ms, 600000);
});
test("only known log folders are traversed, without symlink escape", () => {
  const { store, dirs, home, dir } = setup(),
    root = path.join(home, ".codex");
  mkdirSync(path.join(root, "sessions"), { recursive: true });
  const external = file(dir, rows());
  symlinkSync(external, path.join(root, "sessions", "linked.jsonl"));
  file(root, rows(), "ignored.jsonl");
  dirs.save("codex", null, true);
  assert.equal(store.refresh(dirs).discovered, 0);
});
test("missing directories are saved without creation and unsupported adapters cannot enable", () => {
  const { dirs, home } = setup(),
    p = path.join(home, "missing");
  dirs.save("codex", p, true);
  assert(!existsSync(p));
  assert.equal(dirs.get("codex").status, "missing");
  assert.throws(() => dirs.save("pi", null, true));
  for (const raw of ["", home, "/", "relative", "~someone/x", 123])
    assert.throws(() => dirs.save("codex", raw, false));
});
test("path resolving rejects an existing file", () => {
  const { dirs, dir, home } = setup(),
    p = file(dir, rows());
  assert.throws(() => dirs.save("codex", p, false));
  assert.equal(resolvePath("~/custom", home), path.join(home, "custom"));
});
test("environment and custom root precedence", () => {
  const { store, home } = setup(),
    dirs = new Directories(store, home, { CODEX_HOME: path.join(home, "env") });
  assert.equal(dirs.get("codex").source, "environment");
  dirs.save("codex", path.join(home, "custom"), false);
  assert.equal(dirs.get("codex").source, "custom");
  dirs.save("codex", null, false);
  assert.equal(dirs.get("codex").resolved_path, path.join(home, "env"));
});
test("OMP named profiles and explicit default ignore inherited legacy path", () => {
  const { home } = setup();
  assert.equal(
    locate("omp", home, { OMP_PROFILE: "dev", PI_CODING_AGENT_DIR: "/other" })
      .path,
    path.join(home, ".omp", "profiles", "dev", "agent"),
  );
  assert.equal(
    locate("omp", home, {
      OMP_PROFILE: "default",
      PI_PROFILE: "dev",
      PI_CODING_AGENT_DIR: path.join(home, ".omp", "profiles", "dev", "agent"),
    }).path,
    "~/.omp/agent",
  );
  for (const name of ["CON", "a.", "../x", "Bad"])
    assert.equal(locate("omp", home, { OMP_PROFILE: name }).path, null);
});
test("OMP XDG migration requires existing target and respects platform/custom roots", () => {
  const { home } = setup(),
    xdg = path.join(home, "data");
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg }).path,
    "~/.omp/agent",
  );
  mkdirSync(path.join(xdg, "omp"), { recursive: true });
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg }).path,
    path.join(xdg, "omp"),
  );
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg }, "win32").path,
    "~/.omp/agent",
  );
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "/custom" })
      .path,
    "/custom",
  );
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg, OMP_PROFILE: "dev" }).path,
    path.join(home, ".omp", "profiles", "dev", "agent"),
  );
  mkdirSync(path.join(xdg, "omp", "profiles", "dev"), { recursive: true });
  assert.equal(
    locate("omp", home, { XDG_DATA_HOME: xdg, OMP_PROFILE: "dev" }).path,
    path.join(xdg, "omp", "profiles", "dev"),
  );
});
test("ambiguous overrides remain unresolved", () => {
  const { home } = setup();
  for (const [agent, env] of [
    ["codex", { CODEX_HOME: "relative" }],
    ["claude", { CLAUDE_CONFIG_DIR: "~/literal" }],
    ["pi", { PI_CODING_AGENT_SESSION_DIR: "/sessions" }],
    ["omp", { PI_CONFIG_DIR: "../other" }],
    ["opencode", { OPENCODE_DB: ":memory:" }],
  ] as const)
    assert.equal(locate(agent, home, env).path, null);
  assert.equal(
    locate("pi", home, { PI_CODING_AGENT_DIR: "~/pi" }).path,
    path.join(home, "pi"),
  );
});
test("OpenCode uses data rather than config directory and resolves DB parent", () => {
  const { home } = setup();
  assert.equal(
    locate("opencode", home, { OPENCODE_CONFIG_DIR: "/config" }).path,
    "~/.local/share/opencode",
  );
  assert.equal(
    locate("opencode", home, { OPENCODE_DB: "/data/oc.db" }).path,
    "/data",
  );
  assert.equal(
    locate("opencode", home, {
      XDG_DATA_HOME: "/data",
      OPENCODE_DB: "profile/oc.db",
    }).path,
    "/data/opencode/profile",
  );
});
function http(
  port: number,
  route: string,
  method = "GET",
  body?: string,
  headers: Record<string, string> = {},
) {
  return new Promise<{
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }>((resolve, reject) => {
    const r = request(
      {
        hostname: "127.0.0.1",
        port,
        path: route,
        method,
        headers: {
          ...(body !== undefined
            ? { "Content-Length": String(Buffer.byteLength(body)) }
            : {}),
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: data,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}
test("real HTTP API, loopback protections, validated settings and static assets", async () => {
  const { store, dirs } = setup(),
    server = makeServer(store, dirs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const page = await http(port, "/");
    assert.equal(page.status, 200);
    assert(page.body.includes("AgentTime"));
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal((await http(port, "/app.js")).status, 200);
    assert.equal((await http(port, "/style.css")).status, 200);
    const r = await http(port, "/api/report?timezone=Asia%2FShanghai");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).summary.processing_ms, null);
    for (const headers of [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
    ])
      assert.equal(
        (await http(port, "/api/sources", "GET", undefined, headers)).status,
        403,
      );
    assert.equal((await http(port, "/src/store.ts")).status, 404);
    assert.equal((await http(port, "/api/refresh", "POST", "{}")).status, 403);
    const headers = { "Content-Type": "application/json", "X-AgentTime": "1" };
    assert.equal(
      (await http(port, "/api/refresh", "POST", '{"path":"/secret"}', headers))
        .status,
      400,
    );
    assert.equal(
      (await http(port, "/api/refresh", "POST", "[]", headers)).status,
      400,
    );
    assert.equal(
      (await http(port, "/api/refresh", "POST", "{}", headers)).status,
      200,
    );
    assert.equal(
      (
        await http(
          port,
          "/api/directories",
          "POST",
          JSON.stringify({ agent: "codex", path: null, enabled: true }),
          headers,
        )
      ).status,
      200,
    );
    assert(dirs.get("codex").enabled);
    assert.equal(
      (await http(port, "/api/directories", "POST", "{}", headers)).status,
      400,
    );
    for (const query of [
      "start=2026-02-30&end=2026-03-01",
      "timezone=Bad/Zone",
    ])
      assert.equal((await http(port, "/api/report?" + query)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});
test("opens a database produced by the previous runtime and deduplicates a newly imported copy", () => {
  const { store } = setup();
  store.db.exec(
    "PRAGMA foreign_keys=OFF; DROP TABLE event; DROP TABLE source; DROP TABLE directory;",
  );
  store.db.exec(
    readFileSync(new URL("./fixtures/legacy.sql", import.meta.url), "utf8"),
  );
  store.db.exec("PRAGMA foreign_keys=ON");
  const reopened = new Store(store.path);
  assert.equal(summary(reopened).processing_ms, 600000);
  reopened.close();
  store.importFile(
    new URL("./fixtures/legacy.jsonl", import.meta.url).pathname,
  );
  assert.equal(store.sessions().length, 1);
  assert.equal(store.sessions()[0].turns[0].events.length, 3);
  assert.equal(summary(store).processing_ms, 600000);
  assert.deepEqual(store.sessions()[0].turns[0].models, ["模型😀"]);
  assert.equal(
    store.db
      .prepare("SELECT enabled FROM directory WHERE agent=?")
      .get("codex")!.enabled,
    0,
  );
});

test("first-time import failures report sanitized reasons without inventing an old snapshot", () => {
  const { store, dirs, home } = setup();
  const root = path.join(home, ".codex");
  file(path.join(root, "sessions"), [
    meta("s1", { source: "unsupported-private-value" }),
  ]);
  file(
    path.join(root, "sessions"),
    [{ private: "secret prompt" }],
    "invalid.jsonl",
  );
  dirs.save("codex", null, true);
  const result = store.refresh(dirs);
  assert.equal(result.failed, 2);
  assert.equal(
    result.failures.reduce((n, f) => n + f.count, 0),
    2,
  );
  assert.equal(result.updated, 0);
  assert.equal(store.sourceInfo().registered_files, 0);
  assert(!JSON.stringify(result.failures).includes("secret prompt"));
  assert(
    !JSON.stringify(result.failures).includes("unsupported-private-value"),
  );
  assert(!JSON.stringify(result.failures).includes(home));
});

const claudeRow = (
  type: string,
  uuid: string,
  minute: number,
  extra: Record<string, unknown> = {},
) => ({
  type,
  uuid,
  sessionId: "claude-session",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  cwd: "C:\\work\\claude-project",
  parentUuid: null,
  ...extra,
});
const claudeRows = () => [
  claudeRow("user", "user-1", 0, {
    message: { role: "user", content: "PRIVATE PROMPT" },
  }),
  claudeRow("assistant", "assistant-tool", 1, {
    parentUuid: "user-1",
    message: {
      role: "assistant",
      model: "claude-model",
      stop_reason: "tool_use",
      content: [{ type: "tool_use", input: { secret: "PRIVATE INPUT" } }],
    },
  }),
  claudeRow("user", "tool-result", 2, {
    parentUuid: "assistant-tool",
    message: {
      role: "user",
      content: [{ type: "tool_result", content: "PRIVATE RESULT" }],
    },
  }),
  claudeRow("assistant", "assistant-end", 10, {
    parentUuid: "tool-result",
    message: {
      role: "assistant",
      model: "claude-model",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "PRIVATE REPLY" }],
    },
  }),
];
test("Claude directory enablement discovers main transcripts, with privacy and truthful timing", () => {
  const { store, dirs, home } = setup();
  const p = file(
    path.join(home, ".claude", "projects", "project"),
    claudeRows(),
  );
  const before = readFileSync(p);
  dirs.save("claude", null, true);
  const r = store.refresh(dirs);
  assert.equal(r.updated, 1);
  assert.equal(r.failed, 0);
  const sessions = store.sessions();
  assert.equal(sessions[0].agent, "Claude Code");
  assert.equal(sessions[0].project, "claude-project");
  assert.equal(sessions[0].turns.length, 1);
  assert.equal(summary(store).processing_ms, 600000);
  assert.equal(sessions[0].turns[0].work_ms, 600000);
  assert.match(sessions[0].issues.join(" "), /三态耗时切分/);
  assert.deepEqual(readFileSync(p), before);
  assert(!readFileSync(store.path).includes(Buffer.from("PRIVATE")));
});
test("Claude tool results, metadata and compact summaries are not new submissions", () => {
  const { store, dir } = setup();
  store.importFile(
    file(dir, [
      ...claudeRows().slice(0, 3),
      claudeRow("user", "meta", 3, {
        isMeta: true,
        message: { content: "injected" },
      }),
      claudeRow("user", "compact", 4, {
        isCompactSummary: true,
        message: { content: "summary" },
      }),
      claudeRows()[3],
    ]),
    null,
    "claude",
  );
  assert.equal(summary(store).turns, 1);
  assert.equal(summary(store).processing_ms, 600000);
});
test("Claude missing completion stays unknown; last assistant and tool_use never invent an end", () => {
  const { store, dir } = setup();
  store.importFile(file(dir, claudeRows().slice(0, 3)), null, "claude");
  assert.equal(summary(store).processing_ms, null);
  assert.equal(store.sessions()[0].turns[0].status, "open");
});
test("Claude explicit turn-duration boundary uses recorded timestamp, not derived start", () => {
  const { store, dir } = setup();
  store.importFile(
    file(dir, [
      ...claudeRows().slice(0, 3),
      claudeRow("system", "duration-1", 12, {
        subtype: "turn_duration",
        durationMs: 1000,
      }),
    ]),
    null,
    "claude",
  );
  assert.equal(summary(store).processing_ms, 12 * 60000);
  assert.equal(store.sessions()[0].turns.length, 1);
});
test("Claude stop followed by duration marker does not duplicate completion", () => {
  const { store, dir } = setup();
  store.importFile(
    file(dir, [
      ...claudeRows(),
      claudeRow("system", "duration-1", 12, {
        subtype: "turn_duration",
        durationMs: 1000,
      }),
    ]),
    null,
    "claude",
  );
  assert.equal(store.sessions()[0].turns[0].status, "completed");
  assert.equal(summary(store).processing_ms, 600000);
});
test("Claude copied files deduplicate while Codex identities remain separate", () => {
  const { store, dir } = setup();
  const p = file(dir, claudeRows(), "claude.jsonl"),
    copy = path.join(dir, "copy.jsonl");
  copyFileSync(p, copy);
  store.importFile(p, null, "claude");
  store.importFile(copy, null, "claude");
  store.importFile(
    file(
      dir,
      [
        meta("claude-session"),
        event("task_started", 0),
        event("task_complete", 10),
      ],
      "codex.jsonl",
    ),
  );
  assert.equal(store.sessions().length, 2);
  assert.equal(summary(store).processing_ms, 1200000);
  assert.equal(
    report(store.sessions(), "2026-10-21", "2026-10-21", "UTC", "Claude Code")
      .summary.processing_ms,
    600000,
  );
});
test("Claude manual imports retain adapter identity on refresh", () => {
  const { store, dir, dirs } = setup();
  const p = file(dir, claudeRows());
  store.importFile(p, null, "claude");
  assert.equal(store.refresh(dirs).updated, 1);
  assert.equal(store.sessions()[0].agent, "Claude Code");
  assert.equal(summary(store).processing_ms, 600000);
});
test("Claude scanner excludes subagent files and folders", () => {
  const { store, home, dirs } = setup();
  const project = path.join(home, ".claude", "projects", "project");
  file(project, claudeRows(), "main.jsonl");
  file(path.join(project, "main", "subagents"), claudeRows(), "agent-a.jsonl");
  file(project, claudeRows(), "agent-legacy.jsonl");
  dirs.save("claude", null, true);
  assert.equal(store.refresh(dirs).discovered, 1);
});
test("Claude subagents, mixed sessions and competing human branches handle snapshots appropriately", () => {
  const { store, dir } = setup();
  store.importFile(
    file(dir, [
      ...claudeRows(),
      claudeRow("assistant", "side", 20, { isSidechain: true }),
    ]),
    null,
    "claude",
  );
  assert.equal(store.sessions().length, 1);

  // Mixed sessions with different sessionIds must still throw
  assert.throws(() =>
    store.importFile(
      file(dir, [
        ...claudeRows(),
        claudeRow("user", "mixed", 20, { sessionId: "other" }),
      ]),
      null,
      "claude",
    ),
  );

  // Competing human branches (retries/edits) are now supported and do not reject
  store.importFile(
    file(dir, [
      ...claudeRows(),
      claudeRow("user", "branch-a", 20, {
        parentUuid: "assistant-end",
        message: { content: "a" },
      }),
      claudeRow("user", "branch-b", 21, {
        parentUuid: "assistant-end",
        message: { content: "b" },
      }),
    ]),
    null,
    "claude",
  );
});
test("Claude multiple rounds and model switches preserve each model without duplicating time", () => {
  const { store, dir } = setup();
  store.importFile(
    file(dir, [
      ...claudeRows(),
      claudeRow("user", "user-2", 20, {
        parentUuid: "assistant-end",
        message: { content: "next" },
      }),
      claudeRow("assistant", "end-2", 25, {
        parentUuid: "user-2",
        message: { model: "model-2", stop_reason: "stop_sequence" },
      }),
    ]),
    null,
    "claude",
  );
  const turns = store.sessions()[0].turns;
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[1].models, ["model-2"]);
  assert.equal(summary(store).processing_ms, 15 * 60000);
});


