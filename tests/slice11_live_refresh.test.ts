import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync, rmSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request } from "node:http";

// slice 11 · 实时账本：服务端对源目录变化自动重导入（watch + mtime 扫描
// 双通道、单飞队列），/api/pulse 暴露 revision；前端轮询感知后自动刷新。

import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";
import { LiveSync } from "../src/live.js";
import { makeServer } from "../src/server.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "agenttime-live-"))),
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

async function waitFor(
  label: string,
  probe: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`等待 ${label} 超时（${timeoutMs}ms）`);
}

// 最小合法 Pi 会话（version 3 头 + 用户/助手两消息），保证 import 成功路径
const piSession = (id: string) =>
  [
    JSON.stringify({ type: "session", version: 3, id, cwd: "/work/live" }),
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

test("LiveSync：新会话文件落盘后自动重导入并推进 revision（扫描通道兜底）", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root", "sessions");
  mkdirSync(root, { recursive: true });
  dirs.save("pi", path.dirname(root), true);

  const live = new LiveSync(dirs, store, { scanIntervalMs: 50, debounceMs: 50 });
  live.start();
  try {
    assert.equal(live.revision, 0);
    writeFileSync(
      path.join(root, "0199ffff-0000-4000-8000-000000000001.jsonl"),
      piSession("sess-live-1"),
    );
    await waitFor("首次自动同步", () => live.revision >= 1);
    const pulse = live.pulse();
    assert.equal(pulse.revision, live.revision);
    assert(pulse.last_refresh_at_utc, "自动同步完成时间已记录");
    assert.equal(pulse.last_result?.updated, 1, "新文件被导入");

    writeFileSync(
      path.join(root, "0199ffff-0000-4000-8000-000000000002.jsonl"),
      piSession("sess-live-2"),
    );
    await waitFor("增量自动同步", () => live.revision >= 2);
    assert.equal(live.pulse().last_result?.updated, 2);
  } finally {
    live.stop();
  }
});

test("LiveSync：手动 sync 与自动触发共用单飞队列，revision 连续推进", async () => {
  const { dir, store, dirs } = setup();
  const root = path.join(dir, "pi-root", "sessions");
  mkdirSync(root, { recursive: true });
  dirs.save("pi", path.dirname(root), true);
  const live = new LiveSync(dirs, store, { scanIntervalMs: 50, debounceMs: 50 });
  live.start();
  try {
    const r1 = await live.sync();
    assert.equal(typeof r1.updated, "number");
    const before = live.revision;
    await live.sync();
    assert.equal(live.revision, before + 1, "每次完成的同步恰好推进一格");
  } finally {
    live.stop();
  }
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

test("/api/pulse：live 在场时透传心跳，手动 refresh 走同一条单飞队列", async () => {
  const { store, dirs } = setup();
  let syncCalls = 0;
  const live = {
    revision: 7,
    pulse: () => ({
      revision: 7,
      mode: "watch",
      watching: 2,
      last_refresh_at_utc: "2026-10-31T00:00:00.000Z",
      last_result: null,
    }),
    sync: async () => {
      syncCalls++;
      return { updated: 3, failed: 0, excluded: 0, discovered: 3, notices: [] };
    },
    rearm: () => {},
    nudge: () => {},
  } as unknown as LiveSync;
  const server = makeServer(store, dirs, live);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const p = await http(port, "/api/pulse");
    assert.equal(p.status, 200);
    const pulse = JSON.parse(p.body);
    assert.equal(pulse.revision, 7);
    assert.equal(pulse.watching, 2);

    const headers = { "Content-Type": "application/json", "X-AgentTime": "1" };
    const r = await http(port, "/api/refresh", "POST", "{}", headers);
    assert.equal(r.status, 200);
    assert.equal(syncCalls, 1, "手动同步经由 LiveSync 单飞队列");
    assert.equal(JSON.parse(r.body).updated, 3);
  } finally {
    server.close();
  }
});

test("/api/pulse：未接入 LiveSync 的 server 如实声明未开启自动同步", async () => {
  const { store, dirs } = setup();
  const server = makeServer(store, dirs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const p = await http(port, "/api/pulse");
    assert.equal(JSON.parse(p.body).revision, null);
  } finally {
    server.close();
  }
});

// 前端接线：与仓库其他前端切片一致，按源码字符串断言关键动线
const js = readFileSync(
  new URL("../public/app.js", import.meta.url).pathname,
  "utf8",
);

test("前端：pulse 轮询已接入，感知 revision 前进即重拉报表", () => {
  assert.ok(js.includes('api("/api/pulse")'), "轮询 /api/pulse");
  assert.ok(js.includes("setInterval(pulseLoop, 5000)"), "5s 心跳循环");
  assert.ok(js.includes("p.revision !== lastPulse"), "revision 前进判定");
  assert.ok(js.includes("await load()"), "变化后重拉当前视图");
});

test("前端：状态存活底线——接入页有未保存草稿时暂停自动刷新", () => {
  assert.ok(
    js.includes('state.page === "sources" && Object.keys(state.drafts).length > 0'),
    "脏草稿守卫",
  );
});

test("前端：手动同步后重置 pulse 基线，且实时状态写入顶部 liveStatus", () => {
  assert.ok(js.includes("lastPulse = null;"), "手动同步后重置基线");
  assert.ok(js.includes('$("#liveStatus")'), "自动同步状态可见");
});
