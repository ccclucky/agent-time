import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";

// slice 13 · #53 成本账本：Claude Code token 下钻 + 本地单价表 + 估算花费。
// 口径：无价模型与多模型轮如实「—」/未估价计数，绝不推算充数。

import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { baselinePrice, estimateCost } from "../src/pricing.js";
import { makeServer } from "../src/server.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-cost-"))),
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

// 最小 Claude 会话：一条用户提问 + 两条 assistant（各带 usage，含缓存分量）
function claudeSession(opts: {
  id: string;
  usage1: Record<string, number>;
  usage2?: Record<string, number>;
  model?: string;
}) {
  const msg = (uuid: string, type: string, extra: object) =>
    JSON.stringify({
      type,
      sessionId: opts.id,
      uuid,
      timestamp: "2026-11-04T10:00:00Z",
      cwd: "/work/cost",
      ...extra,
    });
  const lines = [
    msg("u1", "user", { message: { content: "hi" } }),
    msg("a1", "assistant", {
      message: {
        model: opts.model ?? "claude-sonnet-4-5",
        usage: opts.usage1,
        content: [{ type: "text", text: "…" }],
        stop_reason: "end_turn",
      },
    }),
    msg("s1", "system", { subtype: "turn_duration" }),
  ];
  if (opts.usage2)
    lines.push(
      msg("u2", "user", { message: { content: "more" } }),
      msg("a2", "assistant", {
        message: {
          model: opts.model ?? "claude-sonnet-4-5",
          usage: opts.usage2,
          content: [{ type: "text", text: "…" }],
          stop_reason: "end_turn",
        },
      }),
      msg("s2", "system", { subtype: "turn_duration" }),
    );
  return lines.join("\n") + "\n";
}

test("Claude token 下钻：usage 四分量按轮累加并落库", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "claude-root", "projects", "p");
  mkdirSync(root, { recursive: true });
  dirs.save("claude", path.dirname(path.dirname(root)), true);
  writeFileSync(
    path.join(root, "sess-cost-1.jsonl"),
    claudeSession({
      id: "sess-cost-1",
      usage1: { input_tokens: 1000, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 300 },
      usage2: { input_tokens: 800, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 },
    }),
  );
  await store.refresh(dirs);
  const sessions = store.sessions();
  const s = sessions.find((x) => x.id === "claude/sess-cost-1");
  assert(s, "会话已导入");
  assert.equal(s!.turns.length, 2);
  assert.equal(s!.turns[0].tokens?.input_tokens, 1000);
  assert.equal(s!.turns[0].tokens?.cached_input_tokens, 2000);
  assert.equal(s!.turns[0].tokens?.cache_write_input_tokens, 500);
  assert.equal(s!.turns[1].tokens?.total_tokens, 900);
  assert(s!.tokens, "会话累计 token 非空");
  assert.equal(s!.tokens!.input_tokens, 1800);
});

test("估算花费：claude 模型走基线价，单价未知为 null，覆盖价生效", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "claude-root", "projects", "p");
  mkdirSync(root, { recursive: true });
  dirs.save("claude", path.dirname(path.dirname(root)), true);
  writeFileSync(
    path.join(root, "sess-cost-2.jsonl"),
    claudeSession({
      id: "sess-cost-2",
      usage1: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
    }),
  );
  writeFileSync(
    path.join(root, "sess-cost-3.jsonl"),
    claudeSession({
      id: "sess-cost-3",
      usage1: { input_tokens: 1_000_000 },
      model: "totally-unknown-model",
    }),
  );
  await store.refresh(dirs);
  const sessions = store.sessions();
  const priced = sessions.find((x) => x.id === "claude/sess-cost-2")!;
  const baseline = baselinePrice("claude-sonnet-4-5")!;
  // 1M input + 1M output，其余 0：花费 = input价 + output价
  assert.equal(
    priced.turns[0].cost_usd,
    baseline.input + baseline.output,
    "基线价估算：1M in + 1M out",
  );
  assert.equal(priced.cost_usd, priced.turns[0].cost_usd);
  assert.equal(priced.unpriced_turns, 0);

  // 无基线价模型：turn 与会话花费均如实为 null
  const unknown = sessions.find((x) => x.id === "claude/sess-cost-3")!;
  assert.equal(unknown.turns[0].cost_usd, null);
  assert.equal(unknown.cost_usd, null);
  assert.equal(unknown.unpriced_turns, 1, "未估价轮如实计数");

  // 覆盖价生效并参与估算
  store.setPriceOverride("totally-unknown-model", {
    input: 2,
    cached_input: 0,
    cache_write_input: 0,
    output: 0,
  });
  const again = store.sessions().find((x) => x.id === "claude/sess-cost-3")!;
  assert.equal(again.turns[0].cost_usd, 2, "1M × $2/M");
  // 清除覆盖 → 回到无价
  store.setPriceOverride("totally-unknown-model", null);
  assert.equal(
    store.sessions().find((x) => x.id === "claude/sess-cost-3")!.turns[0].cost_usd,
    null,
  );
});

test("estimateCost：缓存分量分别计价", () => {
  const price = { input: 3, cached_input: 0.3, cache_write_input: 3.75, output: 15 };
  const cost = estimateCost(
    { input_tokens: 1_000_000, cached_input_tokens: 1_000_000, cache_write_input_tokens: 1_000_000, output_tokens: 1_000_000 },
    price,
  );
  assert.ok(Math.abs(cost - (3 + 0.3 + 3.75 + 15)) < 1e-9);
});

type HttpResult = { status: number; body: string };
function http(port: number, route: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise<HttpResult>((resolve, reject) => {
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
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    r.on("error", reject);
    r.end(body);
  });
}

test("/api/prices：GET 返回基线+数据内模型，POST 设价/清除并校验", async () => {
  const { store, dirs } = setup();
  const server = makeServer(store, dirs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const headers = { "Content-Type": "application/json", "X-AgentTime": "1" };
    // 设覆盖价
    const set = await http(port, "/api/prices", "POST", JSON.stringify({
      model: "mystery-model",
      input: 1, cached_input: 0.1, cache_write_input: 0, output: 5,
    }), headers);
    assert.equal(set.status, 200);
    const prices = JSON.parse(set.body);
    const m = prices.models.find((x: { model: string }) => x.model === "mystery-model");
    assert.equal(m.source, "override");
    assert.equal(m.price.input, 1);
    // GET 透传
    const get = await http(port, "/api/prices");
    assert.equal(JSON.parse(get.body).as_of.length, 7);
    // 校验：负数/缺字段/坏模型名一律 400
    assert.equal(
      (await http(port, "/api/prices", "POST", JSON.stringify({ model: "x", input: -1 }), headers)).status,
      400,
    );
    assert.equal(
      (await http(port, "/api/prices", "POST", JSON.stringify({ model: "x" }), headers)).status,
      400,
    );
    assert.equal(
      (await http(port, "/api/prices", "POST", JSON.stringify({ model: "" }), headers)).status,
      400,
    );
    // 清除覆盖：无基线且不在数据中的模型从价目表消失（不列无价占位行）
    const cleared = await http(port, "/api/prices", "POST", JSON.stringify({
      model: "mystery-model", clear: true,
    }), headers);
    const afterClear = JSON.parse(cleared.body);
    assert.equal(
      afterClear.models.find((x: { model: string }) => x.model === "mystery-model"),
      undefined,
    );
  } finally {
    server.close();
  }
});

// 前端接线：字符串断言（与仓库其他前端切片一致）
const js = readFileSync(
  new URL("../public/app.js", import.meta.url).pathname,
  "utf8",
);

test("前端: 花费展示与价目表入口已接线，口径如实披露", () => {
  assert.ok(js.includes("function fmtUsd"), "花费格式化");
  assert.ok(js.includes('data-action="price-table"'), "价目表入口（抽屉+聚合卡）");
  assert.ok(js.includes('api("/api/prices")'), "价目读写 API");
  assert.ok(js.includes("多模型轮与无价模型不计入"), "聚合口径披露");
  assert.ok(js.includes("本轮估算花费"), "抽屉单轮花费");
  assert.ok(js.includes("会话估算花费"), "抽屉会话花费");
  assert.ok(js.includes("未估价，未计入"), "未估价轮数披露");
  assert.ok(js.includes("估算花费（按模型 TOP 5）"), "聚合花费榜");
  // 无价/留空一律「—」，绝不 0 充数
  assert.ok(js.includes("if (n === null || n === undefined) return \"—\";"), "fmtUsd 空值口径");
});
