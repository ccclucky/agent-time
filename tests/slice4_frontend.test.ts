import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { makeServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agenttime-fe-test-"));
  const store = new Store(join(dir, "test.sqlite3"));
  const dirs = new Directories(store);
  return { store, dirs, dir };
}

function request(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", reject);
    });
  });
}

test("Slice 4 Frontend: Static assets serve official logo, modern tokens, and 5 DoD modules", async () => {
  const { store, dirs } = setup();
  const server = makeServer(store, dirs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // 1. 验证 HTML 根结构
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    const html = page.body.toString("utf8");
    assert(html.includes("AgentTime"), "Index page must contain AgentTime brand");
    assert(html.includes("sidebar"), "Index page must contain 68px sidebar");
    assert(html.includes("detailDrawer"), "Index page must contain two-stage detail drawer");
    assert(html.includes("/logo.png"), "Index page must reference /logo.png");
    assert(html.includes("/favicon.png"), "Index page must declare a favicon");

    // 2. 验证品牌标识静态服务：侧栏显示位只有 44px，136px PNG 已足够。
    //    1024px/662KB 的 jpg 曾占掉 npm 包体积的 80%，这里加体积上限防回归。
    const logoRes = await request(port, "/logo.png");
    assert.equal(logoRes.status, 200, "GET /logo.png must return 200");
    assert.equal(logoRes.headers["content-type"], "image/png", "Logo must be image/png");
    assert(logoRes.body.length > 1000, "Logo image must have valid binary length");
    assert(
      logoRes.body.length < 40_000,
      `Logo must stay small (got ${logoRes.body.length} bytes); 1024px source cost 662KB`,
    );
    const faviconRes = await request(port, "/favicon.png");
    assert.equal(faviconRes.status, 200, "GET /favicon.png must return 200");
    assert.equal(faviconRes.headers["content-type"], "image/png");

    // 3. 验证 /style.css 视觉令牌与五大核心交互样式
    const cssRes = await request(port, "/style.css");
    assert.equal(cssRes.status, 200);
    const css = cssRes.body.toString("utf8");
    assert(css.includes("#FAF9F5"), "CSS must contain Claude ivory warm paper background token");
    assert(css.includes("#CC785C"), "CSS must contain Claude terracotta orange active work token");
    assert(css.includes("#C68A4C"), "CSS must contain high-contrast amber wait token");
    assert(css.includes(".funnel-card"), "CSS must define Time Drop Funnel styles");
    assert(css.includes(".brush-viewport"), "CSS must define Brush & Zoom draggable viewport");
    assert(css.includes(".drawer-panel"), "CSS must define two-stage drawer panel");

    // 4. 验证 /app.js 前端脚本
    const jsRes = await request(port, "/app.js");
    assert.equal(jsRes.status, 200);
    const js = jsRes.body.toString("utf8");
    assert(js.includes("funnel"), "app.js must implement Time Drop Funnel calculation");
    assert(js.includes("timeline"), "app.js must implement Brush & Zoom timeline");
    assert(js.includes("openDrawer"), "app.js must implement two-stage drawer drill-down");
    assert(js.includes("Escape"), "app.js must support ESC key drawer dismissal");

  } finally {
    server.close();
  }
});
