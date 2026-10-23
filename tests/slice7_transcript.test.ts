import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";
import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { makeServer } from "../src/server.js";
import { extractClaudeTranscript } from "../src/claude.js";
import { extractPiTranscript } from "../src/pi.js";
import { extractCodexTranscript } from "../src/codex.js";
import zlib from "node:zlib";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-t3-"))),
    store = new Store(path.join(dir, "data.sqlite3"));
  resources.push({ dir, store });
  return { dir, store, dirs: new Directories(store, path.join(dir, "home")) };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function jsonl(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

// ---- Claude fixture: two turns; turn 1 carries prompt + thinking + one tool call ----
const claudeRow = (
  type: string,
  uuid: string,
  minute: number,
  extra: Record<string, unknown> = {},
) => ({
  type,
  uuid,
  sessionId: "claude-t3",
  timestamp: `2026-10-21T00:${String(minute).padStart(2, "0")}:00Z`,
  cwd: "/work/demo-project",
  parentUuid: null,
  ...extra,
});
const claudeTranscriptRows = () => [
  claudeRow("user", "u1", 0, {
    message: { role: "user", content: "修复登录页的布局问题" },
  }),
  claudeRow("assistant", "a1", 1, {
    parentUuid: "u1",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "先查看样式文件，定位溢出原因。" },
        { type: "tool_use", id: "toolu-1", name: "Read", input: {} },
      ],
    },
  }),
  claudeRow("user", "tr1", 2, {
    parentUuid: "a1",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu-1", content: "PRIVATE RESULT" },
      ],
    },
  }),
  claudeRow("assistant", "a2", 4, {
    parentUuid: "tr1",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "已修复" }],
    },
  }),
  claudeRow("user", "u2", 6, {
    parentUuid: "a2",
    message: { role: "user", content: [{ type: "text", text: "请再检查移动端" }] },
  }),
  claudeRow("assistant", "a3", 7, {
    parentUuid: "u2",
    message: {
      role: "assistant",
      model: "claude-opus-4-1",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "完成" }],
    },
  }),
];

test("Claude transcript extraction: turn ids match events, prompt/thinking/models/tool durations extracted", () => {
  const { dir, store } = setup();
  const p = jsonl(dir, claudeTranscriptRows());
  store.importFile(p, null, "claude");

  const events = store.sessions()[0].turns.map((t) => t.id);
  assert.deepEqual(events, ["u1", "u2"], "sanity: imported turn ids");

  const turns = extractClaudeTranscript(p);
  assert.equal(turns.length, 2);

  assert.equal(turns[0].turn_id, "u1");
  assert.equal(turns[0].prompt, "修复登录页的布局问题");
  assert.equal(turns[0].thinking, "先查看样式文件，定位溢出原因。");
  assert.deepEqual(turns[0].models, ["claude-sonnet-4-5"]);
  assert.equal(turns[0].tool_calls.length, 1);
  assert.equal(turns[0].tool_calls[0].name, "Read");
  // tool_use at minute 1, tool_result recorded at minute 2 → 60000ms
  assert.equal(turns[0].tool_calls[0].duration_ms, 60000);

  assert.equal(turns[1].turn_id, "u2");
  assert.equal(turns[1].prompt, "请再检查移动端");
  assert.equal(turns[1].thinking, null);
  assert.deepEqual(turns[1].models, ["claude-opus-4-1"]);
  assert.equal(turns[1].tool_calls.length, 0);
});

// ---- Pi fixture: single turn with thinking + toolCall + toolResult durationMs ----
const T = (s: string) => Date.parse(s);
const piTranscriptRows = () => [
  {
    type: "session",
    version: 3,
    id: "aaaabbbb-cccc-dddd-eeee-ffff00000042",
    timestamp: "2026-10-09T22:03:15.000Z",
    cwd: "/Users/demo/work/pi_project",
  },
  {
    type: "message",
    id: "pu1",
    parentId: null,
    timestamp: "2026-10-09T22:03:15.437Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "运行构建并报告结果" }],
      timestamp: T("2026-10-09T22:03:15.437Z"),
    },
  },
  {
    type: "message",
    id: "pa1",
    parentId: "pu1",
    timestamp: "2026-10-09T22:03:17.363Z",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "构建脚本在 package.json，先确认命令。" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
      model: "z-ai/glm-5.3",
      stopReason: "toolUse",
      timestamp: T("2026-10-09T22:03:15.458Z"),
      durationMs: 1904,
      thinkingLevel: "high",
    },
  },
  {
    type: "message",
    id: "pt1",
    parentId: "pa1",
    timestamp: "2026-10-09T22:03:17.394Z",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: ["ok"],
      durationMs: 27,
      timestamp: T("2026-10-09T22:03:17.394Z"),
    },
  },
  {
    type: "message",
    id: "pa2",
    parentId: "pt1",
    timestamp: "2026-10-09T22:03:20.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "z-ai/glm-5.3",
      stopReason: "stop",
      timestamp: T("2026-10-09T22:03:17.400Z"),
      durationMs: 2600,
      thinkingLevel: "high",
    },
  },
];

test("Pi transcript extraction: prompt, thinking, model and tool duration from durationMs evidence", () => {
  const { dir } = setup();
  const p = jsonl(dir, piTranscriptRows(), "pi.jsonl");

  const turns = extractPiTranscript(p);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn_id, "pu1");
  assert.equal(turns[0].prompt, "运行构建并报告结果");
  assert.equal(turns[0].thinking, "构建脚本在 package.json，先确认命令。");
  assert.deepEqual(turns[0].models, ["z-ai/glm-5.3"]);
  assert.equal(turns[0].tool_calls.length, 1);
  assert.equal(turns[0].tool_calls[0].name, "bash");
  assert.equal(turns[0].tool_calls[0].duration_ms, 27);
});

// ---- Codex: user_message / agent_message event rows carry the prompt text ----
const codexTranscriptRows = () => [
  {
    type: "session_meta",
    timestamp: "2026-10-21T00:00:00Z",
    payload: { id: "codex-t3", source: "cli", cwd: "/work/codex-project" },
  },
  {
    type: "turn_context",
    timestamp: "2026-10-21T00:00:01Z",
    payload: { turn_id: "turn-1", model: "gpt-5-codex" },
  },
  {
    type: "event_msg",
    timestamp: "2026-10-21T00:00:02Z",
    payload: { type: "user_message", turn_id: "turn-1", message: "总结这个仓库的架构" },
  },
  {
    type: "event_msg",
    timestamp: "2026-10-21T00:01:00Z",
    payload: { type: "agent_message", turn_id: "turn-1", message: "这是一个单上下文仓库" },
  },
  {
    type: "event_msg",
    timestamp: "2026-10-21T00:02:00Z",
    payload: { type: "task_complete", turn_id: "turn-1" },
  },
];

test("Codex transcript extraction: prompt extracted, thinking honestly reported missing", async () => {
  const { dir, store } = setup();
  const p = jsonl(dir, codexTranscriptRows());
  // Codex 导入经 zstd 流式适配后为异步：必须等待导入完成再查询 transcript。
  await store.importFile(p, null, "codex");

  const result = store.transcript("codex-t3");
  assert.ok(result, "known session must return a transcript");
  assert.equal(result!.session_id, "codex-t3");
  assert.equal(result!.turns.length, 1);
  assert.equal(result!.turns[0].turn_id, "turn-1");
  assert.equal(result!.turns[0].prompt, "总结这个仓库的架构");
  assert.equal(result!.turns[0].thinking, null);
  assert.deepEqual(result!.turns[0].models, ["gpt-5-codex"]);
  assert.ok(
    result!.missing_fields.some((m) => m.includes("思考")),
    "Codex has no thinking text; missing_fields must say so honestly",
  );
});

// ---- Codex rollout where the prompt only exists as response_item/message rows:
// many real files carry no event_msg/user_message at all, plus an environment
// wrapper message and encrypted (ZDR) reasoning rows that must NOT leak in. ----
const codexResponseItemRows = () => [
  {
    type: "session_meta",
    timestamp: "2026-10-21T00:00:00Z",
    payload: { id: "codex-t4", source: "cli", cwd: "/work/codex-project" },
  },
  {
    // Environment/instruction wrapper: must be excluded from the user prompt.
    type: "response_item",
    timestamp: "2026-10-21T00:00:01Z",
    payload: {
      type: "message",
      role: "user",
      id: "msg-env",
      content: [
        { type: "text", text: "<user_instructions>\n# AGENTS.md instructions\n私有内容\n</user_instructions>" },
      ],
    },
  },
  {
    // Real user prompt BEFORE any turn_context: starts a turn keyed by its id.
    type: "response_item",
    timestamp: "2026-10-21T00:00:02Z",
    payload: {
      type: "message",
      role: "user",
      id: "msg-first",
      content: [
        { type: "text", text: "独立首条消息" },
      ],
    },
  },
  {
    type: "turn_context",
    timestamp: "2026-10-21T00:00:03Z",
    payload: { turn_id: "turn-9", model: "gpt-5.3" },
  },
  {
    // Real user prompt AFTER turn_context: associates to the open turn.
    type: "response_item",
    timestamp: "2026-10-21T00:00:05Z",
    payload: {
      type: "message",
      role: "user",
      id: "msg-real",
      content: [
        { type: "text", text: "帮我把首页间距修好" },
      ],
    },
  },
  {
    // Encrypted reasoning (OpenAI ZDR): summary empty, content encrypted.
    type: "response_item",
    timestamp: "2026-10-21T00:00:04Z",
    payload: { type: "reasoning", summary: [], encrypted_content: "ZDR-encrypted-blob" },
  },
  {
    type: "response_item",
    timestamp: "2026-10-21T00:00:06Z",
    payload: {
      type: "function_call",
      name: "exec",
      call_id: "call-1",
      arguments: '{"cmd":"ls -la","timeout":10000}',
    },
  },
  {
    type: "response_item",
    timestamp: "2026-10-21T00:00:07Z",
    payload: {
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "call-2",
      input: "*** Begin Patch\n+line\n*** End Patch",
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-10-21T00:01:00Z",
    payload: { type: "task_complete", turn_id: "turn-9" },
  },
];

test("Codex response_item prompts: real user text extracted, wrappers excluded, ZDR reasoning honestly missing", async () => {
  const { dir, store } = setup();
  const p = jsonl(dir, codexResponseItemRows());
  await store.importFile(p, null, "codex");

  const result = store.transcript("codex-t4");
  assert.ok(result, "known session must return a transcript");
  const turns = result!.turns;
  assert.equal(turns.length, 2, "wrapper must not create a turn of its own");
  const first = turns.find((t) => t.turn_id === "msg-first");
  const main = turns.find((t) => t.turn_id === "turn-9");
  assert.ok(first && main, "pre-turn message keys its own turn; post-turn message joins turn-9");
  assert.equal(first.prompt, "独立首条消息");
  assert.equal(main.prompt, "帮我把首页间距修好");
  assert.deepEqual(main.models, ["gpt-5.3"]);
  assert.equal(main.thinking, null, "ZDR reasoning must stay null, never fabricated");
  assert.ok(
    result!.missing_fields.some((m) => m.includes("ZDR") || m.includes("加密")),
    "missing_fields must explain that Codex thinking is ZDR-encrypted, not just '未记录'",
  );
});

test("Codex tool calls: function_call arguments and custom_tool_call input surface as a detail line", async () => {
  const { dir } = setup();
  const p = jsonl(dir, codexResponseItemRows());
  const turns = extractCodexTranscript(p);
  const main = turns.find((t) => t.turn_id === "turn-9");
  assert.ok(main);
  assert.equal(main.tool_calls.length, 2);
  const exec = main.tool_calls.find((c) => c.name === "exec");
  const patch = main.tool_calls.find((c) => c.name === "apply_patch");
  assert.ok(exec && patch);
  assert.equal(exec.call_id, "call-1");
  assert.equal(exec.detail, "ls -la", "arguments JSON must yield the most informative string field");
  assert.equal(patch.call_id, "call-2");
  assert.match(patch.detail ?? "", /^\*\*\* Begin Patch/, "custom_tool_call input becomes the detail");
  assert.ok(Array.from(patch.detail ?? "").length <= 120, "detail is truncated to ~120 code points");
});

test("Missing source file: transcript degrades to empty turns with an honest reason", () => {
  const { dir, store } = setup();
  const p = jsonl(dir, claudeTranscriptRows());
  store.importFile(p, null, "claude");
  rmSync(p);
  assert.ok(!existsSync(p));

  const result = store.transcript("claude/claude-t3");
  assert.ok(result);
  assert.deepEqual(result!.turns, []);
  assert.ok(
    result!.missing_fields.some((m) => m.includes("不存在") || m.includes("移动")),
    "missing file must surface an honest reason, not silently empty",
  );
});

test("Unknown session id: transcript returns null and the HTTP endpoint answers 404", async () => {
  const { store } = setup();
  assert.equal(store.transcript("claude/does-not-exist"), null);

  const server = makeServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        request(
          { hostname: "127.0.0.1", port, path: "/api/session/transcript?id=claude%2Fghost" },
          (res) => {
            let data = "";
            res.on("data", (d) => (data += d));
            res.on("end", () => resolve({ status: res.statusCode!, body: data }));
          },
        ).on("error", reject).end();
      },
    );
    assert.equal(r.status, 404);
    assert.ok(JSON.parse(r.body).error);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("Transcript HTTP endpoint: 200 with {session_id, turns, missing_fields} and loopback guard", async () => {
  const { dir, store } = setup();
  const p = jsonl(dir, claudeTranscriptRows());
  store.importFile(p, null, "claude");

  const server = makeServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const get = (route: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        request({ hostname: "127.0.0.1", port, path: route }, (res) => {
          let data = "";
          res.on("data", (d) => (data += d));
          res.on("end", () => resolve({ status: res.statusCode!, body: data }));
        }).on("error", reject).end();
      });
    const ok = await get("/api/session/transcript?id=claude%2Fclaude-t3");
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.body);
    assert.equal(body.session_id, "claude/claude-t3");
    assert.equal(body.turns[0].prompt, "修复登录页的布局问题");
    assert.ok(Array.isArray(body.missing_fields));

    assert.equal(
      (await get("/api/session/transcript")).status,
      400,
      "missing id parameter must be a validation error",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("Privacy copy states that turn prompt/CoT text is read on demand from local source files", () => {
  const { store } = setup();
  const privacy = store.sourceInfo().privacy;
  assert.match(privacy, /按需/);
  assert.match(privacy, /本机/);
  assert.match(privacy, /不上传/);
});

test("Codex .jsonl.zst: transcript extraction decompresses instead of reading raw bytes", () => {
  const { dir } = setup();
  const rows = codexResponseItemRows();
  const zstPath = path.join(dir, "rollout.jsonl.zst");
  writeFileSync(
    zstPath,
    zlib.zstdCompressSync(
      Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"),
    ),
  );
  const turns = extractCodexTranscript(zstPath);
  const fromPlain = extractCodexTranscript(jsonl(dir, rows, "plain.jsonl"));
  assert.ok(turns.length > 0, "zst rollouts must yield turns, not binary garbage");
  assert.deepEqual(
    turns.map((t) => ({
      id: t.turn_id,
      prompt: t.prompt,
      tools: t.tool_calls.length,
    })),
    fromPlain.map((t) => ({
      id: t.turn_id,
      prompt: t.prompt,
      tools: t.tool_calls.length,
    })),
    "zst and plain extraction must agree",
  );
});
