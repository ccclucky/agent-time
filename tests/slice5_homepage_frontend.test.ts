import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

test("Slice 5 Homepage: app.js ships Plan-A two-module homepage below the heatmap", () => {
  const js = read("../public/app.js");

  // Module 1: TOP 3 leaderboard + viewport Operations Breakdown
  assert.ok(js.includes("s1-grid"), "app.js must render the Plan-A two-column grid");
  assert.ok(js.includes("rank-mini-item"), "app.js must render TOP 3 rank rows");
  assert.ok(js.includes("multi-seg-bar"), "app.js must render the segmented proportion bar");
  assert.ok(
    js.includes("computeTimelineModel"),
    "app.js must extract visible-session viewport math for reuse",
  );
  assert.ok(
    js.includes("visibleSessions"),
    "app.js must aggregate the breakdown over viewport-visible sessions",
  );

  // Module 2: pure session-stream cards (no per-turn tiles on the homepage)
  assert.ok(js.includes("session-stream-card"), "app.js must render session stream cards");
  assert.ok(js.includes("进入会话详情页"), "stream cards must advertise the detail-page entry");
  assert.ok(
    js.includes("#session/"),
    "stream cards must navigate via the #session/:id hash contract",
  );
  assert.ok(
    js.includes("data-open-session"),
    "stream cards must use delegated listeners (CSP: no inline onclick)",
  );

  // Homepage must no longer flatten per-turn rows / expandable session cards
  assert.ok(
    !js.includes("session-timeline-card"),
    "homepage must not render expandable per-session turn lists",
  );
  assert.ok(
    !js.includes("turnRows"),
    "homepage must not build per-turn rows below the heatmap",
  );

  // Kept modules must remain intact
  assert.ok(js.includes("function stats()"), "KPI cards must stay");
  assert.ok(js.includes("function funnel("), "funnel must stay (test-pinned name)");
  assert.ok(js.includes("function timeline("), "timeline brush must stay (test-pinned name)");
  assert.ok(js.includes("function openDrawer("), "drawer must stay (test-pinned name)");
  assert.ok(js.includes("brush-strip-track"), "140px heatmap brush strip must stay");
});

test("Slice 5 Homepage: style.css ports Plan-A prototype classes and segment color tokens", () => {
  const css = read("../public/style.css");

  // Four new segment color tokens from the prototype (SSOT)
  assert.ok(css.includes("--color-mcp"), "CSS must define --color-mcp token");
  assert.ok(css.includes("--color-system"), "CSS must define --color-system token");
  assert.ok(css.includes("--color-skills"), "CSS must define --color-skills token");
  assert.ok(css.includes("--state-standby"), "CSS must define --state-standby token");
  assert.ok(css.includes("#2563EB"), "CSS must carry the prototype 本地工具 blue");
  assert.ok(css.includes("#EA580C"), "CSS must carry the prototype 模型推理 orange");
  assert.ok(css.includes("#D97706"), "CSS must carry the prototype 等待人审阅 amber");

  // Plan-A module styles
  assert.ok(css.includes(".s1-grid"), "CSS must style the two-column Plan-A grid");
  assert.ok(css.includes(".s1-box"), "CSS must style Plan-A boxes");
  assert.ok(css.includes(".rank-mini-item"), "CSS must style TOP 3 rank rows");
  assert.ok(css.includes(".multi-seg-bar"), "CSS must style the segmented bar");
  assert.ok(css.includes(".session-stream-card"), "CSS must style session stream cards");

  // Kept 140px golden heatmap must not be resized
  const brush = css.slice(css.indexOf(".brush-strip-track"));
  assert.ok(
    /height:\s*140px/.test(brush.slice(0, 300)),
    "brush strip must keep its 140px golden height",
  );
});

test("Slice 5 Homepage: index.html bumps the cache-busting version stamp for both assets", () => {
  const html = read("../public/index.html");
  assert.match(html, /style\.css\?v=\d+/);
  assert.match(html, /app\.js\?v=\d+/);
  const cssV = html.match(/style\.css\?v=(\d+)/)![1];
  const jsV = html.match(/app\.js\?v=(\d+)/)![1];
  assert.equal(cssV, jsV, "both assets must share one version stamp");
  assert.notEqual(cssV, "141", "version stamp must be bumped past 141");
});
