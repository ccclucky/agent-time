import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

test("Slice 6 Detail View: app.js wires #session/:id hash routing with a hashchange listener and boot-time parse", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes('addEventListener("hashchange"'),
    "app.js must listen to hashchange so deep links and browser back work",
  );
  assert.ok(
    js.includes("decodeURIComponent"),
    "session ids contain '/', the hash segment must be decoded after encodeURIComponent",
  );
  assert.ok(
    js.includes("#session/"),
    "route prefix #session/ must be parsed",
  );
  assert.ok(
    js.includes("function applyRoute(") || js.includes("const applyRoute ="),
    "boot-time route application must be a named applyRoute step",
  );
  // Back affordance must be a delegated action (CSP: no inline onclick)
  assert.ok(
    js.includes("back-overview"),
    "detail page must offer a delegated back-to-overview action",
  );
});

test("Slice 6 Detail View: app.js renders the session detail first screen (breakdown + 4 KPIs + diag grid)", () => {
  const js = read("../public/app.js");

  // First screen: session-exclusive Operations Breakdown
  assert.ok(
    js.includes("session-breakdown-full"),
    "detail page must render the full-width session breakdown panel",
  );
  assert.ok(
    js.includes("multi-seg-bar tall"),
    "detail breakdown must use the pre-styled 8px .multi-seg-bar.tall variant",
  );
  assert.ok(
    js.includes("breakdown-row"),
    "detail breakdown must render the 4 percentage rows",
  );
  // All four dimensions from the prototype legend
  assert.ok(js.includes("本地工具"), "本地工具 (tool_execution_ms) row");
  assert.ok(js.includes("模型推理"), "模型推理 (model_api_ms) row");
  assert.ok(js.includes("等待人审阅"), "等待人审阅 (review_wait_ms) row");
  assert.ok(js.includes("待命"), "待命 (standby_ms) row");
  // Honest degradation for Codex (breakdown === null): no fabricated splits
  assert.ok(
    js.includes("暂无细分耗时数据"),
    "Codex sessions without breakdown must show an honest empty state",
  );

  // 4 core health KPI cards
  assert.ok(js.includes("detail-kpis"), "detail page must render 4 KPI cards");
  assert.ok(js.includes("WALL TIME"), "KPI 1 总壁钟时长 WALL TIME");
  assert.ok(js.includes("ACTIVE WORK"), "KPI 2 纯工作有效净值 ACTIVE WORK");
  assert.ok(js.includes("AUTONOMY"), "KPI 3 自动化自治率 AUTONOMY");
  assert.ok(js.includes("慢操作瓶颈数"), "KPI 4 慢操作瓶颈数");

  // Middle two-column diagnostics
  assert.ok(js.includes("detail-diag-grid"), "two-column diagnostics grid");
  assert.ok(js.includes("slow-tool-row"), "slow tool TOP leaderboard rows");
  assert.ok(
    js.includes("15000"),
    "slow-op threshold must be 15s (15000ms) client-side",
  );
  assert.ok(
    js.includes("perCallToolTimings") || js.includes("toolCallDurations"),
    "per-call tool durations must be derived from turn.events (tool_use ↔ tool_result pairing)",
  );
});

test("Slice 6 Detail View: app.js degrades gracefully when a deep-linked session is outside the date range", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("不在当前统计日期范围"),
    "missing-session fallback must explain the range clipping instead of crashing",
  );
});

test("Slice 6 Detail View: homepage slice-1 behavior stays intact (stream cards still navigate via hash)", () => {
  const js = read("../public/app.js");

  assert.ok(js.includes("session-stream-card"), "session stream must stay");
  assert.ok(
    js.includes('data-open-session'),
    "delegated card entry points must stay",
  );
  assert.ok(
    js.includes("location.hash = "),
    "cards must still write the #session/:id hash",
  );
});

test("Slice 6 Detail View: style.css ports the prototype detail-page classes", () => {
  const css = read("../public/style.css");

  assert.ok(css.includes(".detail-nav"), "detail nav bar must be styled");
  assert.ok(css.includes(".btn-back-home"), "back link must be styled");
  assert.ok(
    css.includes(".session-breakdown-full"),
    "full-width breakdown panel must be styled",
  );
  assert.ok(css.includes(".breakdown-row"), "breakdown rows must be styled");
  assert.ok(css.includes(".detail-kpis"), "detail KPI grid must be styled");
  assert.ok(css.includes(".kpi-card"), "KPI cards must be styled");
  assert.ok(
    css.includes(".detail-diag-grid"),
    "two-column diagnostics grid must be styled",
  );
  assert.ok(css.includes(".diag-card"), "diagnostic cards must be styled");
  assert.ok(css.includes(".slow-tool-row"), "slow tool rows must be styled");
  assert.ok(css.includes("#DC2626"), "slow-op red accent must be defined");
});

test("Slice 6 Detail View: index.html keeps one shared cache-busting stamp for both assets", () => {
  const html = read("../public/index.html");
  const cssV = html.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = html.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV, "both assets must share one version stamp");
  assert.equal(
    cssV,
    "20261025-5",
    "version stamp must advance with each visual round (feedback fixes: 20261025-4 → 20261025-5)",
  );
});

test("Slice 6 Detail View: GLOSSARY.md documents the autonomy formula", () => {
  const g = read("../GLOSSARY.md");
  assert.ok(
    g.includes("自动化自治率"),
    "GLOSSARY must define 自动化自治率 (Autonomy Rate)",
  );
});
