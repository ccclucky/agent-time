import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// slice 13 · 增量同步：refresh 对签名（size+mtimeNs）未变化的健康文件跳过
// 重解析，只保留单通道标题富化；sessions() 重建结果按写入失效缓存。

import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-incr-"))),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return { dir, store, home, dirs: new Directories(store, home, {}, process.platform) };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// 最小合法 Pi 会话（version 3 头 + 用户/助手两消息）
const piSession = (id: string) =>
  [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/work/incr" }),
    JSON.stringify({
      type: "message",
      id: id + "-m1",
      parentId: null,
      timestamp: "2026-10-31T00:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    }),
    JSON.stringify({
      type: "message",
      id: id + "-m2",
      parentId: id + "-m1",
      timestamp: "2026-10-31T00:01:00Z",
      message: {
        role: "assistant",
        timestamp: "2026-10-31T00:00:10Z",
        durationMs: 5000,
        model: "test-model",
        content: [{ type: "text", text: "ok" }],
      },
    }),
  ].join("\n") + "\n";

const codexSession = (id: string) =>
  [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-10-21T00:00:00Z",
      payload: { id, source: "cli", cwd: "/work/example", originator: "codex_cli_rs" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-10-21T00:00:01Z",
      payload: { type: "task_started", turn_id: "t1" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-10-21T00:02:00Z",
      payload: { type: "task_complete", turn_id: "t1" },
    }),
  ].join("\n") + "\n";

const agSession = (convId: string) =>
  [
    JSON.stringify({
      type: "USER_INPUT",
      source: "USER_EXPLICIT",
      step_index: 0,
      created_at: "2026-11-01T00:00:00Z",
      content: "你好",
    }),
    JSON.stringify({
      type: "PLANNER_RESPONSE",
      source: "MODEL",
      step_index: 1,
      created_at: "2026-11-01T00:01:00Z",
      tool_calls: [],
      content: "回复",
    }),
  ].join("\n") + "\n";

test("refresh：签名未变化的健康文件跳过重解析，仍计入 updated", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000001.jsonl");
  writeFileSync(p, piSession("sess-incr-1"));
  dirs.save("pi", root, true);

  const r1 = await store.refresh(dirs);
  assert.equal(r1.updated, 1);
  assert.equal(r1.skipped, 0, "首轮无签名（旧快照/新文件）必须全量重导");

  // 证明跳过：importFile 会把 Pi 会话的无 title 覆写为 NULL；手工标记若在
  // 跳过后的 refresh 中存活，说明文件本体确实没有被重新解析。
  store.db.prepare("UPDATE source SET title='手工标记'").run();
  const r2 = await store.refresh(dirs);
  assert.equal(r2.updated, 1, "跳过的文件仍计入 updated（UI 口径不变）");
  assert.equal(r2.skipped, 1);
  assert.equal(store.sessions()[0].title, "手工标记", "跳过路径未重读文件，title 未被覆写");
  assert.equal(store.sessions()[0].turns.length, 1, "统计完好");
});

test("refresh：追加会话内容后下一轮重新导入", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000002.jsonl");
  writeFileSync(p, piSession("sess-incr-2"));
  dirs.save("pi", root, true);
  await store.refresh(dirs);

  // 追加第二轮（size 变化 → 签名失配 → 重导）
  writeFileSync(
    p,
    piSession("sess-incr-2") +
      [
        JSON.stringify({
          type: "message",
          id: "sess-incr-2-m3",
          parentId: "sess-incr-2-m2",
          timestamp: "2026-10-31T00:02:00Z",
          message: { role: "user", content: [{ type: "text", text: "second" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "sess-incr-2-m4",
          parentId: "sess-incr-2-m3",
          timestamp: "2026-10-31T00:03:00Z",
          message: {
            role: "assistant",
            timestamp: "2026-10-31T00:02:05Z",
            durationMs: 3000,
            model: "test-model",
            content: [{ type: "text", text: "done" }],
          },
        }),
      ].join("\n") + "\n",
  );
  const r2 = await store.refresh(dirs);
  assert.equal(r2.skipped, 0);
  assert.equal(store.sessions()[0].turns.length, 2, "追加的轮次已进入统计");
});

test("refresh：仅 mtime 变化（touch）也触发重导", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000003.jsonl");
  writeFileSync(p, piSession("sess-incr-3"));
  dirs.save("pi", root, true);
  await store.refresh(dirs);

  utimesSync(p, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z"));
  const r2 = await store.refresh(dirs);
  assert.equal(r2.skipped, 0, "mtimeNs 变化即视为可疑，宁可重导不可漏导");
  assert.equal(r2.updated, 1);
});

test("refresh：带 last_error 的快照每轮重试，成功后清除", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000004.jsonl");
  writeFileSync(p, piSession("sess-incr-4"));
  dirs.save("pi", root, true);
  await store.refresh(dirs);
  // 模拟历史失败：失败文件即使签名未变也必须重试，成功后 last_error 清空
  store.db.prepare("UPDATE source SET last_error='模拟失败'").run();
  const r2 = await store.refresh(dirs);
  assert.equal(r2.skipped, 0, "失败文件不跳过");
  assert.equal(r2.updated, 1);
  const row = store.db.prepare("SELECT last_error FROM source").get() as { last_error: string | null };
  assert.equal(row.last_error, null, "重试成功后 last_error 清除");
});

test("sessions()：重复调用命中缓存，导入后失效", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  dirs.save("pi", root, true);
  const p1 = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000005.jsonl");
  writeFileSync(p1, piSession("sess-incr-5"));
  await store.importFile(p1, root, "pi");
  const first = store.sessions();
  assert.equal(first.length, 1);
  assert.equal(store.sessions(), first, "无写入时返回同一缓存实例");
  assert.ok(Object.isFrozen(first), "缓存顶层冻结（只读契约）");

  const p2 = path.join(sessionsDir, "0199aaaa-0000-4000-8000-000000000006.jsonl");
  writeFileSync(p2, piSession("sess-incr-6"));
  await store.importFile(p2, root, "pi");
  assert.equal(store.sessions().length, 2, "导入后缓存已失效并重建");
});

test("refresh：Codex 注册表改名仍会富化被跳过的文件", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "codex-home");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(path.join(sessionsDir, "codex-a.jsonl"), codexSession("s1"));
  const writeIndex = (name: string) =>
    writeFileSync(
      path.join(root, "session_index.jsonl"),
      JSON.stringify({ id: "s1", thread_name: name, updated_at: "2026-10-21T00:00:00Z" }) + "\n",
    );
  writeIndex("初版标题");
  dirs.save("codex", root, true);
  await store.refresh(dirs);
  assert.equal(store.sessions()[0].title, "初版标题");

  // 文件本体未变：refresh 跳过重解析，但注册表改名必须照常落库
  writeIndex("改名后的新主题");
  const r2 = await store.refresh(dirs);
  assert.equal(r2.skipped, 1);
  assert.equal(store.sessions()[0].title, "改名后的新主题");
});

test("refresh：确定性失败按签名跳过重解析，启动时重新探测", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "codex-home");
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const p = path.join(sessionsDir, "codex-bad.jsonl");
  // 两个 session_meta 混合会话标识 → 「来源未知…」确定性失败（纯内容判定）
  writeFileSync(
    p,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-10-21T00:00:00Z",
        payload: { id: "bad-1", source: "cli", cwd: "/work/x", originator: "codex_cli_rs" },
      }),
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-10-21T00:00:01Z",
        payload: { id: "bad-2", source: "cli", cwd: "/work/x", originator: "codex_cli_rs" },
      }),
    ].join("\n") + "\n",
  );
  dirs.save("codex", root, true);
  const r1 = await store.refresh(dirs);
  assert.equal(r1.failed, 1);
  assert.equal(r1.skipped, 0, "首轮没有 memo，如实解析后失败");
  const memo = store.db
    .prepare("SELECT reason,agent,last_size,last_mtime_ns FROM import_failure")
    .get() as { reason: string; agent: string; last_size: number; last_mtime_ns: string };
  assert.match(memo.reason, /来源未知/);
  assert.equal(memo.agent, "codex");
  assert.ok(memo.last_size > 0 && memo.last_mtime_ns, "失败签名已落库");

  const r2 = await store.refresh(dirs);
  assert.equal(r2.failed, 1, "UI 口径不变：失败仍计入并保留原因");
  assert.equal(r2.skipped, 1, "稳态跳过重解析");
  const srcCount = (
    store.db.prepare("SELECT COUNT(*) AS c FROM source").get() as { c: number }
  ).c;
  assert.equal(srcCount, 0, "从未成功导入的文件不产生快照行");

  // 新进程（Store 构造清空 memo）→ 重新探测一轮
  const store2 = new Store(path.join(dir, "data.sqlite3"));
  const dirs2 = new Directories(store2, path.join(dir, "home"), {}, process.platform);
  try {
    const r3 = await store2.refresh(dirs2);
    assert.equal(r3.skipped, 0, "启动后 memo 已清空，重新解析探测");
    assert.equal(r3.failed, 1);
  } finally {
    store2.close();
  }

  // 修复内容（单一合法 meta）→ 文件变化使签名失配 → 成功导入并清除 memo
  writeFileSync(
    p,
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-10-21T00:00:00Z",
      payload: { id: "bad-fixed", source: "cli", cwd: "/work/x", originator: "codex_cli_rs" },
    }) +
      "\n" +
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-21T00:01:00Z",
        payload: { type: "task_started", turn_id: "t1" },
      }) +
      "\n" +
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-10-21T00:02:00Z",
        payload: { type: "task_complete", turn_id: "t1" },
      }) +
      "\n",
  );
  const r4 = await store.refresh(dirs);
  assert.equal(r4.failed, 0);
  assert.equal(r4.skipped, 0);
  assert.equal(store.sessions().length, 1);
  assert.equal(
    (store.db.prepare("SELECT COUNT(*) AS c FROM import_failure").get() as { c: number }).c,
    0,
    "成功导入后 memo 已清除",
  );
});

test("refresh：Antigravity 会话库改名仍会富化被跳过的文件", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "ag-home");
  const logs = path.join(
    root,
    "brain",
    "11111111-2222-3333-4444-555555555555",
    ".system_generated",
    "logs",
  );
  mkdirSync(logs, { recursive: true });
  writeFileSync(path.join(logs, "transcript.jsonl"), agSession("11111111-2222-3333-4444-555555555555"));
  const summaries = new DatabaseSync(path.join(root, "conversation_summaries.db"));
  summaries.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, workspace_uris TEXT)",
  );
  summaries
    .prepare("INSERT INTO conversation_summaries VALUES (?,?,?)")
    .run("11111111-2222-3333-4444-555555555555", "初版对话标题", "[]");
  summaries.close();
  dirs.save("antigravity", root, true);
  await store.refresh(dirs);
  assert.equal(store.sessions()[0].title, "初版对话标题");

  const reopen = new DatabaseSync(path.join(root, "conversation_summaries.db"));
  reopen
    .prepare("UPDATE conversation_summaries SET title=? WHERE conversation_id=?")
    .run("改名后的对话标题", "11111111-2222-3333-4444-555555555555");
  reopen.close();
  const r2 = await store.refresh(dirs);
  assert.equal(r2.skipped, 1);
  assert.equal(store.sessions()[0].title, "改名后的对话标题");
});
