import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseAntigravity, extractAntigravityTranscript } from "../src/antigravity.js";
import { isSessionFile } from "../src/directories.js";
import { Store } from "../src/store.js";

const resources: { dir: string; store?: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-ag-")));
  resources.push({ dir });
  return dir;
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fixture layout mirrors the verified real shape:
// brain/<conv-id>/.system_generated/logs/transcript.jsonl
function agFile(dir: string, convId: string, rows: unknown[]) {
  const p = path.join(
    dir,
    "brain",
    convId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}
const at = (min: number, sec = 0) =>
  `2026-10-24T10:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}Z`;

// ---- Unit: event mapping on a two-turn session ----
test("parseAntigravity: USER_INPUT/PLANNER_RESPONSE/GENERIC event mapping", () => {
  const dir = setup();
  const p = agFile(dir, "conv-1", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), input_tokens: 100, cache_read_tokens: 50, output_tokens: 20, thinking: "先查再改", tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 30), content: "The command exited with code 0." },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 40), input_tokens: 80, output_tokens: 10 },
    { step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(5) },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(5, 20) },
  ]);
  const { session, events, tokens, issues } = parseAntigravity(p);
  assert.equal(session.id, "antigravity/conv-1");
  assert.equal(session.agent, "Antigravity");
  const turn1 = events.filter((e) => e.turn_id === "antigravity-turn-0");
  const turn2 = events.filter((e) => e.turn_id === "antigravity-turn-4");
  assert.deepEqual(
    turn1.map((e) => e.kind),
    ["start", "tool_use", "tool_result", "complete"],
  );
  assert.equal(turn1[1].tool_name, "run_command");
  assert.equal(turn1[2].end_ms, turn1[2].at_ms); // result append time is the end
  assert.equal(turn2[0].kind, "start");
  assert.deepEqual(turn2.slice(1).map((e) => e.kind), ["complete"]);
  // 完成锚点 = 末条模型活动记录，而非用户下一条输入
  assert.equal(turn1.at(-1)!.at_ms, Date.parse(at(0, 40)));
  // Token 按轮直读求和（非快照差分）
  assert.equal(tokens.length, 1);
  assert.deepEqual(tokens[0], {
    turn_id: "antigravity-turn-0",
    input_tokens: 180,
    cached_input_tokens: 50,
    cache_write_input_tokens: 0,
    output_tokens: 30,
    reasoning_output_tokens: 0,
    total_tokens: 260,
  });
  assert.ok(issues.some((i) => i.startsWith("Antigravity：")));
});

test("parseAntigravity: ask_question is review wait inside the turn", () => {
  const dir = setup();
  const p = agFile(dir, "conv-2", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "ask_question", args: { questions: '["A 还是 B?"]' } }] },
    // 用户在对话框作答后才落盘的结果记录
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(1, 10), content: "A1: 选 A" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(1, 20) },
  ]);
  const { events } = parseAntigravity(p);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes("review_wait_start"));
  assert.ok(kinds.includes("review_wait_end"));
  const start = events.find((e) => e.kind === "review_wait_start")!;
  const end = events.find((e) => e.kind === "review_wait_end")!;
  assert.equal(end.at_ms - start.at_ms, 60_000);
});

test("parseAntigravity: background task defers tool_result to completion receipt", () => {
  const dir = setup();
  const p = agFile(dir, "conv-3", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "run_command", args: { CommandLine: '"long test"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 20), content: "Created At: x Tool is running as a background task with task id: conv-3/task-8 Task Description: x" },
    // 轮询记录不带 tool_calls：不得误配对到已转后台的工具
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 30) },
    { step_index: 4, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 35), content: "Task: conv-3/task-8 Status: RUNNING" },
    { step_index: 5, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: at(2, 10), content: 'Task id "conv-3/task-8" finished with result:\n\ndone' },
    { step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(2, 20) },
  ]);
  const { events, issues } = parseAntigravity(p);
  const result = events.find((e) => e.kind === "tool_result")!;
  // 完整后台执行（2 分钟）计为该工具耗时，而非 spawn 回执时刻
  assert.equal(result.at_ms, Date.parse(at(2, 10)));
  assert.equal(result.at_ms - Date.parse(at(0, 10)), 120_000);
  assert.ok(!issues.some((i) => i.includes("尚未完成")));
});

test("parseAntigravity: invoke_subagent tags agent_id with the child conversation id", () => {
  const dir = setup();
  const p = agFile(dir, "conv-4", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "invoke_subagent", args: { Prompt: '"做评审"' } }] },
    // 真实语义：结果为创建子会话回执（conversationId），非 task id
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 20), content: 'Created At: x Created the following subagent: { "conversationId": "child-conv-1", "role": "PM" }' },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 30) },
  ]);
  const { events } = parseAntigravity(p);
  const tagged = events.filter((e) => e.agent_id === "child-conv-1");
  assert.deepEqual(
    tagged.map((e) => e.kind),
    ["tool_use", "tool_result"],
  );
  assert.equal(tagged[0].tool_name, "invoke_subagent");
});

test("parseAntigravity: child subagent session without USER_INPUT gets a leading turn", () => {
  const dir = setup();
  const p = agFile(dir, "child-conv-1", [
    { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: at(0), content: "[Message] from parent" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "read_file", args: { Path: '"a.md"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 40), content: "file content" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 50), content: "评审结论" },
  ]);
  const { events, issues } = parseAntigravity(p);
  const kinds = events.map((e) => e.kind);
  assert.deepEqual(kinds, ["start", "tool_use", "tool_result", "complete"]);
  assert.equal(events.at(-1)!.at_ms - events[0].at_ms, 50_000);
  assert.ok(issues.some((i) => i.includes("子代理会话")));
});

test("parseAntigravity: error retry keeps the turn; error-then-user-input fails it", () => {
  const dir = setup();
  const p = agFile(dir, "conv-5", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: at(0, 5), error: "API error (attempt 1)" },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 30) },
    { step_index: 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(5) },
    { step_index: 4, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", created_at: at(5, 10), error: "API error (attempt 2)" },
  ]);
  const { events } = parseAntigravity(p);
  const kindsByTurn = (tid: string) =>
    events.filter((e) => e.turn_id === tid).map((e) => e.kind);
  assert.deepEqual(kindsByTurn("antigravity-turn-0"), ["start", "complete"]);
  assert.deepEqual(kindsByTurn("antigravity-turn-3"), ["start", "fail"]);
});

test("parseAntigravity: EOF turn ending on a tool result stays open", () => {
  const dir = setup();
  const p = agFile(dir, "conv-6", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10) },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 20), content: "partial output" },
  ]);
  const { events, issues } = parseAntigravity(p);
  assert.ok(!events.some((e) => e.kind === "complete"));
  assert.ok(issues.some((i) => i.includes("仍视为进行中")));
});

test("parseAntigravity: rejects paths without the brain transcript layout", () => {
  const dir = setup();
  const p = path.join(dir, "random.jsonl");
  writeFileSync(p, "{}\n");
  assert.throws(() => parseAntigravity(p), /无法从路径确定 Antigravity 会话 ID/);
});

// ---- Transcript extractor ----
test("extractAntigravityTranscript: prompts, thinking and tool details", () => {
  const dir = setup();
  const p = agFile(dir, "conv-7", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0), content: "<USER_REQUEST>\n修复登录页\n</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), thinking: "第一步排查", tool_calls: [{ name: "read_file", args: { Path: '"src/app.ts"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 25), content: "file content" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 30), thinking: "第二步修复" },
  ]);
  const turns = extractAntigravityTranscript(p);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn_id, "antigravity-turn-0");
  assert.ok(turns[0].prompt!.includes("修复登录页"));
  assert.equal(turns[0].thinking, "第一步排查\n第二步修复");
  assert.equal(turns[0].tool_calls.length, 1);
  assert.equal(turns[0].tool_calls[0].name, "read_file");
  assert.equal(turns[0].tool_calls[0].duration_ms, 15_000);
  assert.equal(turns[0].tool_calls[0].detail, "src/app.ts");
});

// ---- Discovery: only the canonical transcript.jsonl counts ----
test("isSessionFile: antigravity accepts transcript.jsonl only", () => {
  assert.ok(isSessionFile("antigravity", "/x/brain/c/.system_generated/logs/transcript.jsonl"));
  assert.ok(!isSessionFile("antigravity", "/x/brain/c/.system_generated/logs/transcript_full.jsonl"));
  assert.ok(!isSessionFile("antigravity", "/x/notes.jsonl"));
});

// ---- Store integration: title/project enrichment + three-state timing ----
function fixtureIndexDb(configRoot: string, rows: [string, string, string][]) {
  const db = new DatabaseSync(path.join(configRoot, "conversation_summaries.db"));
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT '', workspace_uris text NOT NULL DEFAULT '')",
  );
  const put = db.prepare(
    "INSERT INTO conversation_summaries(conversation_id,title,workspace_uris) VALUES(?,?,?)",
  );
  for (const [id, title, uris] of rows) put.run(id, title, uris);
  db.close();
}

test("Store: antigravity import enriches title/project and computes three-state timing", async () => {
  const dir = setup();
  const configRoot = path.join(dir, "antigravity");
  mkdirSync(configRoot, { recursive: true });
  fixtureIndexDb(configRoot, [
    ["conv-8", "[done] 修复布局", '["file:///work/demo-project"]'],
  ]);
  const p = agFile(configRoot, "conv-8", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0), content: "<USER_REQUEST>\n修复布局\n</USER_REQUEST>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), input_tokens: 10, output_tokens: 5, tool_calls: [{ name: "run_command", args: { CommandLine: '"ls"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 30), content: "exited 0" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 40) },
    { step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(5) },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(5, 30) },
  ]);
  const store = new Store(path.join(dir, "data.sqlite3"));
  resources.push({ dir, store });
  await store.importFile(p, configRoot, "antigravity");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, "antigravity/conv-8");
  assert.equal(s.agent, "Antigravity");
  assert.equal(s.title, "[done] 修复布局");
  assert.equal(s.project, "demo-project");
  // 轮 1：elapsed 40s，工具 20s → work 40s、model_api 20s；轮 2 待命 = 260s
  const [t1, t2] = s.turns;
  assert.equal(t1.work_ms, 40_000);
  assert.equal(t1.review_wait_ms, 0);
  assert.equal(t1.breakdown?.tool_execution_ms, 20_000);
  assert.equal(t2.standby_ms, 260_000);
  // 会话合计 = 轮 1（40s）+ 轮 2（30s）
  assert.equal(s.work_ms, 70_000);
  assert.equal(s.standby_ms, 260_000);
  // Token 会话合计
  assert.equal(s.tokens?.input_tokens, 10);
  assert.equal(s.tokens?.total_tokens, 15);
  // 按需转写走 Antigravity 提取器
  const transcript = store.transcript(s.id);
  assert.ok(transcript);
  assert.equal(transcript!.turns[0].turn_id, t1.id);
  assert.ok(transcript!.turns[0].prompt!.includes("USER_REQUEST"));
  // 来源页宣告接入
  const { SOURCES } = await import("../src/adapters.js");
  assert.ok(SOURCES.find((x) => x.agent === "Antigravity")?.supported);
});

test("parseAntigravity: duplicate background spawn receipt does not close the tool early", () => {
  const dir = setup();
  const p = agFile(dir, "conv-9", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "run_command", args: {} }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 20), content: "Tool is running as a background task with task id: conv-9/task-1 x" },
    // 重复回执：保持计时中立，不得把延迟工具截断到 spawn 时刻
    { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 30), content: "Tool is running as a background task with task id: conv-9/task-1 x" },
    { step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: at(2), content: 'Task id "conv-9/task-1" finished with result:\nok' },
    { step_index: 5, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(2, 10) },
  ]);
  const { events } = parseAntigravity(p);
  const results = events.filter((e) => e.kind === "tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].at_ms, Date.parse(at(2)));
});

test("event stream and transcript extractor agree on tool durations", () => {
  const dir = setup();
  const p = agFile(dir, "conv-10", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at(0), content: "q" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(0, 10), tool_calls: [{ name: "run_command", args: { CommandLine: '"bg"' } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(0, 20), content: "Tool is running as a background task with task id: conv-10/task-1 x" },
    { step_index: 3, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", created_at: at(1, 40), content: 'Task id "conv-10/task-1" finished with result:\nok' },
    { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(1, 50), tool_calls: [{ name: "read_file", args: { Path: '"a.ts"' } }] },
    { step_index: 5, source: "MODEL", type: "GENERIC", status: "DONE", created_at: at(2), content: "content" },
    { step_index: 6, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at(2, 10) },
  ]);
  const { events } = parseAntigravity(p);
  const useByName = new Map(
    events.filter((e) => e.kind === "tool_use").map((e) => [e.tool_name!, e]),
  );
  const resultByName = new Map(
    events.filter((e) => e.kind === "tool_result").map((e) => [e.tool_name!, e]),
  );
  const turns = extractAntigravityTranscript(p);
  const calls = turns[0].tool_calls;
  for (const c of calls) {
    const use = useByName.get(c.name)!;
    const result = resultByName.get(c.name)!;
    assert.equal(c.duration_ms, result.at_ms - use.at_ms, `${c.name} duration must match the event stream`);
  }
  assert.equal(calls[0].duration_ms, 90_000); // background: deferred to receipt
  assert.equal(calls[1].duration_ms, 10_000); // foreground: FIFO immediate
});
