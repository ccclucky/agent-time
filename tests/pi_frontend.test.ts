import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { SOURCES } from "../src/adapters.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "agenttime-pi-surface-")),
  );
  const store = new Store(path.join(dir, "data.sqlite3")),
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
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}

test("Pi directory metadata is supported and points at sessions history", () => {
  const { dirs } = setup();
  const item = dirs.get("pi");
  assert.equal(item.supported, true);
  assert.equal(item.name, "Pi");
  assert.equal(item.default_path, "~/.pi/agent");
  assert.deepEqual(item.history_subdirectories, ["sessions"]);
});
test("Pi can be enabled and the preference persists; others still cannot", () => {
  const { store, dirs } = setup();
  dirs.save("pi", null, true);
  assert.equal(dirs.get("pi").enabled, true);
  assert.equal(new Directories(store, "/other-home").get("pi").enabled, true);
  dirs.save("pi", null, false);
  assert.equal(dirs.get("pi").enabled, false);
  assert.throws(() => dirs.save("opencode", null, true), /不能启用/);
});

const piRows = () => [
  {
    type: "session",
    version: 3,
    id: "01a122b0-a300-7113-8773-07227583e9b1",
    timestamp: "2026-10-09T22:03:15.000Z",
    cwd: "/Users/demo/work/my_project",
  },
  {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-09T22:03:15.437Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "run the build" }],
      timestamp: Date.parse("2026-10-09T22:03:15.437Z"),
    },
  },
  {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2026-10-09T22:03:20.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "z-ai/glm-5.3",
      stopReason: "stop",
      timestamp: Date.parse("2026-10-09T22:03:16.000Z"),
      durationMs: 4000,
      thinkingLevel: "high",
    },
  },
];
test("enabled Pi directory discovers sessions/<encoded-project> transcripts as Pi", () => {
  const { store, dirs, home } = setup();
  file(
    path.join(
      home,
      ".pi",
      "agent",
      "sessions",
      "--Users-demo-work-my_project--",
    ),
    piRows(),
    "2026-10-09T22-03-15-000Z_01a122b0-a300-7113-8773-07227583e9b1.jsonl",
  );
  dirs.save("pi", null, true);
  const result = store.refresh(dirs);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.discovered, 1);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "Pi");
  assert.equal(sessions[0].id, "pi/01a122b0-a300-7113-8773-07227583e9b1");
  assert.equal(sessions[0].project, "my_project");
  assert.equal(sessions[0].turns.length, 1);
  assert.equal(sessions[0].turns[0].status, "completed");
});

const worktree = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const cli = (args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(worktree, "src", "cli.ts"), ...args],
    { encoding: "utf8", cwd: worktree },
  );
test("CLI import accepts --agent pi, advertises it in help and rejects others", () => {
  const { dir, home } = setup();
  const p = file(path.join(home, "incoming"), piRows());
  const ok = cli([
    "import",
    "--agent",
    "pi",
    "--db",
    path.join(dir, "cli.sqlite3"),
    p,
  ]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(
    JSON.parse(ok.stdout.trim().split("\n").at(-1)!).imported_files,
    1,
  );
  const store = new Store(path.join(dir, "cli.sqlite3"));
  try {
    assert.equal(store.sessions()[0].agent, "Pi");
  } finally {
    store.close();
  }
  const bad = cli([
    "import",
    "--agent",
    "opencode",
    "--db",
    path.join(dir, "cli.sqlite3"),
    p,
  ]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /codex\|claude\|pi/);
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /codex\|claude\|pi/);
});
test("Pi is advertised as a supported source with three-state event split", () => {
  const pi = SOURCES.find((s) => s.agent === "Pi")!;
  assert.ok(pi, "SOURCES must keep a Pi row");
  assert.equal(pi.supported, true);
  assert.equal(pi.status, "只读导入 · 事件流三态切分");
  assert.ok(!pi.note.includes("尚未接入"));
});
test("frontend copy includes Pi and drawer renders optional breakdown sections", () => {
  const js = readFileSync(
    new URL("../public/app.js", import.meta.url).pathname,
    "utf8",
  );
  assert.ok(js.includes("当前接入 Codex、Claude Code 与 Pi"));
  assert.ok(!js.includes("当前接入 Codex 和 Claude Code"));
  assert.ok(js.includes("启用 Codex、Claude Code 或 Pi 数据目录"));
  assert.ok(js.includes("model_api_breakdown"));
  assert.ok(js.includes("thinking_breakdown"));
  // 防御性访问：字段缺失时不渲染该小节（沿用 breakdown?. 可选链风格）
  assert.ok(js.includes("turn.breakdown?.model_api_breakdown"));
  assert.ok(js.includes("turn.breakdown?.thinking_breakdown"));
});
