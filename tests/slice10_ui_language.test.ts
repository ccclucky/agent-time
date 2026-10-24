import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Issue #36: two-layer UI language.
// Display layer = one short Chinese word per concept, no English annotations.
// Glossary/field layer = English + field names, allowed ONLY in definitions()
// and CSV headers.
const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

const app = () => read("../public/app.js");
const html = () => read("../public/index.html");
const css = () => read("../public/style.css");

// Old contributor-facing vocabulary. Comments are NOT exempt.
const BANNED_ZH = [
  "壁钟",
  "机时",
  "并集",
  "卡点",
  "蒸发",
  "微缩",
  "自治率",
  "审阅",
  "静默",
  "纯工作",
  "慢操作瓶颈数",
];

// English display annotations. Only definitions() may use them.
// Phrases (not bare words) so code identifiers cannot trip the assertion.
const BANNED_EN = [
  "WALL TIME",
  "ACTIVE WORK",
  "AUTONOMY",
  "Review Wait",
  "Standby",
  "Union Span",
  "Operations Breakdown",
  "Session Operations Breakdown",
  "Brush & Zoom",
  "Time Drop Funnel",
  "Rollup Summary",
  "CoT & Reasoning",
  "User Prompt",
  "Operations Stack",
  "Model API",
  "Tool Execution",
  "Slowest Operations",
  "Attribution",
  "Unclassified",
  "Completed",
  "Top Sessions",
];

// English bare parenthetical suffixes that must be deleted outright.
const BANNED_SUFFIXES = ["(API)", "(Tools)", "(Session)", "(Wall Time)"];

// Slice out a top-level function body so the definitions() glossary block
// (the one legitimate English surface) is not counted as display copy.
function sliceFunction(js: string, signature: string): string {
  const start = js.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist in public/app.js`);
  const next = js.indexOf("\nfunction ", start + signature.length);
  return js.slice(start, next === -1 ? js.length : next);
}

const definitionsBody = () => sliceFunction(app(), "function definitions()");
const defaultLayer = () => app().replace(definitionsBody(), "");

test("Slice 10 UI language: banned Chinese vocabulary is gone from every public asset (comments included)", () => {
  for (const [name, source] of [
    ["public/app.js", app()],
    ["public/index.html", html()],
    ["public/style.css", css()],
  ] as const) {
    const hits = BANNED_ZH.filter((term) => source.includes(term));
    assert.deepEqual(
      hits,
      [],
      `${name} still contains banned display terms: ${hits.join("、")}`,
    );
  }
});

test("Slice 10 UI language: default layer has no English annotations (definitions() exempt)", () => {
  for (const [name, source] of [
    ["public/app.js", defaultLayer()],
    ["public/index.html", html()],
    ["public/style.css", css()],
  ] as const) {
    const hits = BANNED_EN.filter((phrase) => source.includes(phrase));
    assert.deepEqual(
      hits,
      [],
      `${name} default layer still contains English phrases: ${hits.join(", ")}`,
    );
    const suffixes = BANNED_SUFFIXES.filter((s) => source.includes(s));
    assert.deepEqual(
      suffixes,
      [],
      `${name} still carries bare parenthetical annotations: ${suffixes.join(", ")}`,
    );
  }
});

test("Slice 10 UI language: time-flow funnel reads 记录总时长 → 扣除等待确认 → 扣除待命 → 剩下 AI 工作", () => {
  const body = sliceFunction(app(), "function funnel()");
  assert.ok(
    body.includes("时间流向"),
    "funnel section title must be 时间流向",
  );
  const labels = [...body.matchAll(/<span>\d\.\s*([^<]+)<\/span>/g)].map((m) =>
    m[1].trim(),
  );
  assert.deepEqual(
    labels,
    ["记录总时长", "扣除等待确认", "扣除待命", "剩下 AI 工作"],
    "the four stages must use the authoritative display words in order",
  );
  assert.ok(
    body.includes("100% 记录总时长"),
    "stage 1 inside fill must read 100% 记录总时长",
  );
});

test("Slice 10 UI language: one truth source drives the four dimension labels everywhere", () => {
  const source = app();
  const block = source.match(/const BREAKDOWN_DIMENSIONS = \[[\s\S]*?\];/);
  assert.ok(block, "BREAKDOWN_DIMENSIONS must exist");
  const labels = [...block![0].matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["本地工具", "模型推理", "等待确认", "待命"]);

  assert.match(
    source,
    /const VIEWPORT_SEGMENTS = BREAKDOWN_DIMENSIONS\.map/,
    "VIEWPORT_SEGMENTS must derive from BREAKDOWN_DIMENSIONS",
  );
  assert.match(
    source,
    /const DETAIL_BREAKDOWN_ROWS = BREAKDOWN_DIMENSIONS\.map/,
    "DETAIL_BREAKDOWN_ROWS must derive from BREAKDOWN_DIMENSIONS",
  );

  // No render site may re-hardcode a dimension display label.
  const outside = source.replace(block![0], "");
  for (const word of labels) {
    assert.equal(
      outside.includes(`label: "${word}"`),
      false,
      `dimension label "${word}" must only live in BREAKDOWN_DIMENSIONS`,
    );
  }
});

test("Slice 10 UI language: drawer four cards read 模型推理 / 本地工具 / 等待确认 / 本轮时长", () => {
  const body = sliceFunction(app(), "function openDrawer(");
  const titles = [...body.matchAll(/class="drawer-kpi-title"[^>]*>([^<]+)</g)].map(
    (m) => m[1].trim(),
  );
  assert.deepEqual(titles.slice(0, 4), ["模型推理", "本地工具", "等待确认", "本轮时长"]);
  assert.ok(body.includes("你的提问"), "prompt slot must read 你的提问");
  assert.ok(body.includes("模型思考过程"), "CoT slot must read 模型思考过程");
  assert.ok(body.includes("本轮时间构成"), "rollup section must read 本轮时间构成");
  assert.ok(body.includes("本轮工具调用"), "tool stack must read 本轮工具调用");
  assert.ok(body.includes("AI 工作占比"), "work rate must read AI 工作占比");
  assert.ok(body.includes("不计入等待确认"), "unclassified note must end 不计入等待确认");
});

test("Slice 10 UI language: detail page four KPIs read 总时长 / AI 工作 / 自动完成度 / 超 15s 慢操作", () => {
  const body = sliceFunction(app(), "function sessionDetail(");
  const titles = [...body.matchAll(/detailKpiCard\(\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["总时长", "AI 工作", "自动完成度", "超 15s 慢操作"]);
  assert.ok(
    body.includes("本会话操作与耗时分布"),
    "breakdown panel must read 本会话操作与耗时分布",
  );
  assert.ok(body.includes("最慢操作"), "diagnostic card must read 最慢操作");
  assert.ok(body.includes("效率归因"), "diagnostic card must read 效率归因");
});

test("Slice 10 UI language: tooltips expose the glossary layer on stats, funnel, legend and KPIs", () => {
  const source = app();
  const stats = sliceFunction(source, "function stats()");
  assert.ok(
    stats.includes('title="口径：累计工作时长 processing_ms'),
    "stats card must hint 累计工作时长 processing_ms",
  );
  assert.ok(
    stats.includes('title="口径：并行去重时长 processing_union_ms'),
    "stats card must hint 并行去重时长 processing_union_ms",
  );

  const funnel = sliceFunction(source, "function funnel()");
  const funnelTitles = [
    ...funnel.matchAll(/<div class="funnel-bar-row" title="口径：([^"]+)"/g),
  ].map((m) => m[1]);
  assert.equal(funnelTitles.length, 4, "each funnel stage row needs a 口径 tooltip");
  for (const field of [
    "work_ms",
    "review_wait_ms",
    "standby_ms",
    "模型推理 + 本地工具",
  ]) {
    assert.ok(
      funnelTitles.some((t) => t.includes(field)),
      `funnel tooltips must mention ${field}: ${funnelTitles.join(" | ")}`,
    );
  }

  const card = sliceFunction(source, "function viewportBreakdownCard(");
  assert.match(
    card,
    /class="seg-legend-label" title="口径：/,
    "viewport legend labels must carry a 口径 tooltip",
  );

  const detail = sliceFunction(source, "function sessionDetail(");
  for (const field of [
    "sessionWallSpan",
    "work_ms",
    "autonomy_rate",
    "slow_ops",
  ]) {
    assert.ok(
      detail.includes(`口径：`) && detail.includes(field),
      `KPI tooltips must name ${field}`,
    );
  }
  const kpi = sliceFunction(source, "function detailKpiCard(");
  assert.match(
    kpi,
    /function detailKpiCard\(label, val, sub, tone = "", hint = ""\)/,
    "detailKpiCard must accept an optional hint argument",
  );
  assert.ok(
    kpi.includes('title="${h(hint)}"'),
    "detailKpiCard must render the hint as a title attribute",
  );
});

test("Slice 10 UI language: definitions() carries the full three-layer mapping table", () => {
  const body = definitionsBody();
  for (const header of ["展示词", "口径术语", "字段 / 计算式"]) {
    assert.ok(body.includes(header), `definitions table header must include ${header}`);
  }
  for (const field of [
    "processing_ms",
    "processing_union_ms",
    "sessionWallSpan",
    "elapsed_ms",
    "work_ms",
    "review_wait_ms",
    "standby_ms",
    "autonomy_rate",
    "slow_ops",
    "model_ms",
    "tool execution",
  ]) {
    assert.ok(body.includes(field), `definitions table must map ${field}`);
  }
  for (const display of [
    "累计工作时长",
    "并行去重时长",
    "总时长",
    "本轮时长",
    "AI 工作",
    "等待确认",
    "待命",
    "自动完成度",
    "超 15s 慢操作",
    "本地工具",
    "模型推理",
  ]) {
    assert.ok(body.includes(display), `definitions table must list display word ${display}`);
  }
  assert.ok(
    body.includes("Autonomy Rate"),
    "the glossary column must keep Autonomy Rate for 自动完成度",
  );
});

test("Slice 10 UI language: both assets share the 20261025-12 cache-busting stamp", () => {
  const source = html();
  const cssV = source.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = source.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV, "both assets must share one version stamp");
  assert.equal(cssV, "20261025-12", "copy convergence requires a new asset stamp");
});
