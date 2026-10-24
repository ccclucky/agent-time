import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Directories, isSessionFile } from "../src/directories.js";
import { parseDsh, extractDshTranscript } from "../src/dsh.js";
import { ValidationError } from "../src/types.js";

// DSH sessions are multi-frame zstd containers; CI (Node 22.13) may lack the
// zstd API, so every decompression-backed test gates on capability like the
// Codex .zst suite.
const hasZstd =
  typeof zlib.zstdCompressSync === "function" &&
  typeof zlib.zstdDecompressSync === "function";
const zst = hasZstd ? test : test.skip;

const resources: { dir: string; store?: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-dsh-"))),
    store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return {
    dir,
    store,
    home,
    dirs: new Directories(store, home, {}, "linux"),
  };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = 1_700_000_000_000;

/** Build one DSH frame: a zstd frame carrying one or more JSONL records, the
 *  container shape verified in real ~/.dsh/sessions files. */
const frame = (...records: unknown[]): Buffer =>
  zlib.zstdCompressSync(
    Buffer.from(records.map((r) => JSON.stringify(r)).join("\n") + "\n"),
  );

interface TurnSpec {
  turn: number;
  steps: {
    step: number;
    stepStartAt: number;
    msgAt: number;
    reasoning?: string;
    usage?: Record<string, number>;
    tools?: {
      callId: string;
      name: string;
      arguments?: string;
      callAt: number;
      resultAt: number;
    }[];
  }[];
  startAt: number;
  endAt: number;
  endKind?: string;
  prompt?: string;
}

/** A realistic record set for one turn, packed into frames the way DSH does:
 *  the header frame, then one frame per append batch (here per record). */
function turnRecords(spec: TurnSpec): unknown[] {
  const recs: unknown[] = [
    { type: "turn/start", time: spec.startAt, data: { turn: spec.turn } },
  ];
  if (spec.prompt !== undefined)
    recs.push({
      type: "user/message",
      time: spec.startAt + 1,
      data: {
        content: [{ type: "text", text: spec.prompt }],
        source: { kind: "user" },
        role: "user",
      },
    });
  for (const s of spec.steps) {
    recs.push({ type: "step/start", time: s.stepStartAt, data: { turn: spec.turn, step: s.step } });
    const content: unknown[] = [];
    if (s.reasoning) content.push({ type: "reasoning", text: s.reasoning });
    for (const t of s.tools ?? [])
      content.push({
        type: "tool-call",
        id: t.callId,
        name: t.name,
        arguments: t.arguments,
      });
    recs.push({
      type: "assistant/message",
      time: s.msgAt,
      data: {
        turn: spec.turn,
        step: s.step,
        message: { role: "assistant", content },
        usage: s.usage ?? null,
      },
    });
    for (const t of s.tools ?? []) {
      recs.push({ type: "tool/call", time: t.callAt, data: { turn: spec.turn, step: s.step, callId: t.callId, name: t.name, arguments: t.arguments } });
      recs.push({ type: "tool/result", time: t.resultAt, data: { turn: spec.turn, step: s.step, message: { role: "tool", toolCallId: t.callId } } });
    }
    recs.push({
      type: "step/end",
      time: Math.max(s.msgAt, ...(s.tools ?? []).map((t) => t.resultAt)) + 1,
      data: { turn: spec.turn, step: s.step },
    });
  }
  recs.push({ type: "turn/end", time: spec.endAt, data: { turn: spec.turn, reason: { kind: spec.endKind ?? "completed" } } });
  return recs;
}

const header = (id: string, cwd: string): unknown => ({
  type: "session",
  version: 4,
  id,
  createdAt: T0,
  cwd,
  isSeeded: false,
  delegationDepth: 0,
  agentPreset: "standard",
});

const modelSelection = {
  type: "model/selection",
  time: T0 + 1,
  data: { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "max" },
};

function writeSession(
  file: string,
  chunks: Buffer[] | { plain: string },
) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    chunks instanceof Array
      ? Buffer.concat(chunks)
      : Buffer.from(chunks.plain, "utf8"),
  );
}

function twoTurnSession(id: string, cwd: string): Buffer[] {
  return [
    frame(header(id, cwd)),
    frame(modelSelection),
    frame(
      ...turnRecords({
        turn: 1,
        startAt: T0 + 10,
        endAt: T0 + 1620,
        prompt: "列出当前目录",
        steps: [
          {
            step: 1,
            stepStartAt: T0 + 20,
            msgAt: T0 + 520,
            reasoning: "先看一眼目录",
            usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, totalTokens: 165 },
            tools: [
              { callId: "c1", name: "bash", arguments: '{"command":"ls"}', callAt: T0 + 530, resultAt: T0 + 1030 },
            ],
          },
          {
            step: 2,
            stepStartAt: T0 + 1100,
            msgAt: T0 + 1600,
            usage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 260 },
          },
        ],
      }),
    ),
    frame(
      ...turnRecords({
        turn: 2,
        startAt: T0 + 2000,
        endAt: T0 + 2100,
        endKind: "aborted",
        prompt: "停一下",
        steps: [
          { step: 1, stepStartAt: T0 + 2010, msgAt: T0 + 2050, usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 10 } },
        ],
      }),
    ),
  ];
}

zst("session file naming: dsh accepts .jsonl.zstd, codex does not", () => {
  assert.ok(isSessionFile("dsh", "session.v4.jsonl.zstd"));
  assert.ok(isSessionFile("dsh", "session.jsonl.zstd"));
  assert.ok(isSessionFile("dsh", "session.jsonl"));
  assert.ok(!isSessionFile("dsh", "session.v4.jsonl.zst"));
  assert.ok(!isSessionFile("dsh", "session.lock"));
  assert.ok(!isSessionFile("codex", "session.v4.jsonl.zstd"));
});

zst("parseDsh: events, spans, per-turn token sums, project and title", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  const result = parseDsh(file);

  assert.equal(result.session.id, "dsh/session-abc");
  assert.equal(result.session.agent, "DeepSeek Harness");
  assert.equal(result.session.project, "proj-x");
  assert.equal(result.session.client, "dsh");
  assert.equal(result.session.title, null);

  const byTurn = (t: string) => result.events.filter((e) => e.turn_id === t);
  const t1 = byTurn("turn-1");
  assert.deepEqual(
    t1.map((e) => e.kind).sort(),
    ["complete", "model", "model", "start", "tool_result", "tool_use"].sort(),
  );
  const model1 = t1.find((e) => e.kind === "model")!;
  assert.equal(model1.model, "deepseek-account/deepseek-flash");
  assert.equal(model1.at_ms, T0 + 20);
  assert.equal(model1.end_ms, T0 + 520);
  const toolResult = t1.find((e) => e.kind === "tool_result")!;
  assert.equal(toolResult.at_ms, T0 + 530);
  assert.equal(toolResult.end_ms, T0 + 1030);
  assert.equal(toolResult.tool_name, "bash");
  // Turn 2 aborted (user): abort event instead of complete.
  assert.ok(byTurn("turn-2").some((e) => e.kind === "abort"));
  assert.ok(!byTurn("turn-2").some((e) => e.kind === "complete"));

  // Usage is per-request on each assistant message, so a turn sums its steps.
  const tokens1 = result.tokens.find((t) => t.turn_id === "turn-1")!;
  assert.equal(tokens1.input_tokens, 300);
  assert.equal(tokens1.cached_input_tokens, 10);
  assert.equal(tokens1.cache_write_input_tokens, 5);
  assert.equal(tokens1.output_tokens, 110);
  assert.equal(tokens1.total_tokens, 425);
  const tokens2 = result.tokens.find((t) => t.turn_id === "turn-2")!;
  assert.equal(tokens2.total_tokens, 10);
});

zst("parseDsh: session/title latest wins, multi-frame packing", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.jsonl.zstd");
  // Two title records inside ONE frame: exercises multiple records per frame
  // and the latest-wins title rule together with the multi-frame walk.
  writeSession(file, [
    frame(header("session-abc", "/tmp/proj-x")),
    frame({ type: "session/title", time: T0, data: { title: "第一版标题" } }),
    frame({ type: "session/title", time: T0 + 5, data: { title: "最终标题" } }),
    frame(modelSelection),
    frame(...turnRecords({ turn: 1, startAt: T0 + 10, endAt: T0 + 50, steps: [] })),
  ]);
  const result = parseDsh(file);
  assert.equal(result.session.title, "最终标题");
});

zst("parseDsh: unknown format version is rejected, not guessed", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.jsonl.zstd");
  writeSession(file, [
    frame({ type: "session", version: 3, id: "session-old", createdAt: T0, cwd: "/tmp/p" }),
  ]);
  assert.throws(() => parseDsh(file), ValidationError, /未经真实样本验证/);
});

zst("parseDsh: mixed session ids are a plain failure", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, [
    frame(header("session-abc", "/tmp/p")),
    frame(header("session-other", "/tmp/p")),
  ]);
  assert.throws(() => parseDsh(file), ValidationError, /混合多个会话标识/);
});

zst("parseDsh: missing cwd degrades to the encoded project directory name", () => {
  const { dir } = setup();
  // Two-level layout without a cwd header: project comes from the
  // GRANDPARENT of the file (sessions/<proj>/<sessionId>/file), flagged as
  // lossy, never from the sessionId directory one level up.
  const file = path.join(
    dir,
    "sessions",
    "--tmp-proj-x--",
    "session-abc",
    "session.v4.jsonl.zstd",
  );
  const headerNoCwd = { type: "session", version: 4, id: "session-abc", createdAt: T0 };
  writeSession(file, [
    frame(headerNoCwd),
    frame(modelSelection),
    frame(...turnRecords({ turn: 1, startAt: T0 + 10, endAt: T0 + 50, steps: [] })),
  ]);
  const result = parseDsh(file);
  assert.equal(result.session.project, "x");
  assert.ok(result.issues.some((i) => i.includes("有损解码")));
});

zst("parseDsh: unknown turn/end reason degrades to abort with an issue", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, [
    frame(header("session-abc", "/tmp/p")),
    frame(
      ...turnRecords({
        turn: 1,
        startAt: T0 + 10,
        endAt: T0 + 50,
        endKind: "crashed",
        steps: [],
      }),
    ),
  ]);
  const result = parseDsh(file);
  assert.ok(result.events.some((e) => e.kind === "abort"));
  assert.ok(result.issues.some((i) => i.includes("未知的轮次结束类型")));
});

zst("parseDsh: plain .jsonl (uncompressed) falls through the shared reader", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.jsonl");
  const records = [header("session-abc", "/tmp/proj-y"), modelSelection];
  writeSession(file, {
    plain: [...records, ...turnRecords({ turn: 1, startAt: T0 + 10, endAt: T0 + 50, steps: [] })]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  });
  const result = parseDsh(file);
  assert.equal(result.session.project, "proj-y");
  assert.ok(result.events.some((e) => e.kind === "start"));
});

zst("store roundtrip: DSH timing follows the span-accumulation model", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  await store.importFile(file, null, "dsh");
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, "dsh/session-abc");
  assert.equal(s.agent, "DeepSeek Harness");
  const t1 = s.turns.find((t) => t.id === "turn-1")!;
  assert.equal(t1.status, "completed");
  // work = model spans (500+500) + tool span (500); review wait unknown.
  assert.equal(t1.work_ms, 1500);
  assert.equal(t1.review_wait_ms, null);
  assert.equal(t1.breakdown?.model_api_ms, 1000);
  assert.equal(t1.breakdown?.tool_execution_ms, 500);
  assert.equal(t1.tokens?.total_tokens, 425);
  const t2 = s.turns.find((t) => t.id === "turn-2")!;
  assert.equal(t2.status, "aborted");
  assert.equal(s.tokens?.total_tokens, 435);
});

zst("directories: ~/.dsh sessions two-level layout is discovered", async () => {
  const { store, home, dirs } = setup();
  const root = path.join(home, ".dsh");
  const file = path.join(
    root,
    "sessions",
    "--tmp-proj-x--",
    "session-abc",
    "session.v4.jsonl.zstd",
  );
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  // session.lock must never be picked up as a session file.
  writeFileSync(path.join(root, "sessions", "--tmp-proj-x--", "session-abc", "session.lock"), "");
  dirs.save("dsh", root, true);
  const { files, agents, notices } = dirs.collect();
  assert.equal(files.size, 1);
  assert.ok(files.has(realpathSync(file)));
  assert.equal(agents.get(realpathSync(file)), "dsh");
  assert.deepEqual(notices, []);
  await store.refresh(dirs);
  const sessions = store.sessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agent, "DeepSeek Harness");
});

zst("directories: default ~/.dsh path is prefilled from rules", () => {
  const { home, dirs } = setup();
  const info = dirs.get("dsh");
  assert.equal(info.name, "DeepSeek Harness");
  assert.equal(info.default_path, "~/.dsh");
  assert.equal(info.supported, true);
  assert.deepEqual(info.history_subdirectories, ["sessions"]);
});

zst("transcript: prompt, thinking, models and tool-call details per turn", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  const turns = extractDshTranscript(file);
  assert.equal(turns.length, 2);
  const t1 = turns.find((t) => t.turn_id === "turn-1")!;
  assert.equal(t1.prompt, "列出当前目录");
  assert.equal(t1.thinking, "先看一眼目录");
  assert.deepEqual(t1.models, ["deepseek-account/deepseek-flash"]);
  assert.equal(t1.tool_calls.length, 1);
  assert.equal(t1.tool_calls[0].name, "bash");
  assert.equal(t1.tool_calls[0].duration_ms, 500);
  assert.equal(t1.tool_calls[0].call_id, "c1");
  assert.equal(t1.tool_calls[0].detail, "ls");
  const t2 = turns.find((t) => t.turn_id === "turn-2")!;
  assert.equal(t2.prompt, "停一下");
  assert.equal(t2.tool_calls.length, 0);
});

zst("store.transcript dispatches the DSH extractor by agent name", async () => {
  const { store, dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  await store.importFile(file, null, "dsh");
  const tr = store.transcript("dsh/session-abc");
  assert.ok(tr);
  assert.equal(tr.missing_fields.length, 0);
  const t1 = tr.turns.find((t) => t.turn_id === "turn-1")!;
  assert.equal(t1.prompt, "列出当前目录");
  assert.ok(t1.tool_calls.some((c) => c.name === "bash"));
});

zst("truncated container: a corrupt trailing frame fails loudly", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  const good = frame(header("session-abc", "/tmp/p"));
  // The trailing junk starts with the frame magic: the walk opens a decode
  // window that can never succeed and must fail loudly instead of silently
  // ignoring the corruption.
  const garbage = Buffer.concat([
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
    Buffer.alloc(64, 0x28),
  ]);
  writeSession(file, [good, garbage]);
  assert.throws(() => parseDsh(file), ValidationError, /解压失败/);
});

zst("boundary scan: an invalid boundary candidate widens to the next frame", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  // Emulate a magic-byte false positive between frames: the candidate window
  // starting at the stray magic must fail, widen, and still decode the last
  // frame instead of corrupting the whole import.
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const collision = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "system/message", time: T0 + 2, data: { note: "x" } }) + "\n")),
    magic,
    Buffer.from("not-a-frame"),
    zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: "turn/start", time: T0 + 10, data: { turn: 1 } }) + "\n")),
  ]);
  writeSession(file, [
    frame(header("session-abc", "/tmp/p")),
    collision,
  ]);
  const result = parseDsh(file);
  assert.ok(result.events.some((e) => e.kind === "start"));
});

// Regression for the Codex lesson: a compressed file iterated as raw bytes
// yields zero turns silently — the reader must branch on the container.
zst("zstd suffix is handled explicitly, never by raw-byte iteration", () => {
  const { dir } = setup();
  const file = path.join(dir, "session.v4.jsonl.zstd");
  writeSession(file, twoTurnSession("session-abc", "/tmp/proj-x"));
  const raw = readFileSync(file);
  // Sanity: the fixture really is compressed (raw text parsing would fail).
  assert.ok(!raw.toString("utf8").includes("session"));
  const result = parseDsh(file);
  assert.ok(result.events.length > 0);
});
