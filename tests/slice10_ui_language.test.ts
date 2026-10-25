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
// The list mixes multi-word phrases with bare glossary words (Standby,
// Attribution, Completed, ...). Bare words collide with camelCase identifiers
// (the `sStandby` accumulator), so every probe requires word boundaries: the
// display copy "Standby Duration" hits, the identifier `sStandby` does not.
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

// Word-boundary probe so identifiers such as `sStandby` are not mistaken for
// display copy while a standalone "Standby" annotation is still caught.
const bannedPhraseIn = (source: string, phrase: string) =>
  new RegExp(`(?<![A-Za-z0-9_])${phrase}(?![A-Za-z0-9_])`).test(source);

// Slice out a top-level function body so the definitions() glossary block
// (the one legitimate English surface) is not counted as display copy.
function sliceFunction(js: string, signature: string): string {
  const start = js.indexOf(signature);
  assert.notEqual(start, -1, `${signature} must exist in public/app.js`);
  const next = js.indexOf("\nfunction ", start + signature.length);
  return js.slice(start, next === -1 ? js.length : next);
}

// Extract every balanced `name(...)` call. TypeScript/JS string literals in
// these call sites keep parentheses balanced, so depth counting is enough.
function callBlocks(js: string, name: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = js.indexOf(`${name}(`, from);
    if (start === -1) break;
    let depth = 0;
    let i = js.indexOf("(", start);
    for (; i < js.length; i += 1) {
      if (js[i] === "(") depth += 1;
      else if (js[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(js.slice(start, i + 1));
    from = i + 1;
  }
  return blocks;
}

function dimensionMeta(source: string) {
  const block = source.match(/const BREAKDOWN_DIMENSIONS = \[[\s\S]*?\];/);
  assert.ok(block, "BREAKDOWN_DIMENSIONS must exist");
  const entries = [
    ...block![0].matchAll(/key: "([^"]+)",\s*\n\s*label: "([^"]+)"/g),
  ].map((m) => ({ key: m[1], label: m[2] }));
  return { block: block![0], entries };
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
    const hits = BANNED_EN.filter((phrase) => bannedPhraseIn(source, phrase));
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

test("Slice 10 UI language: 时间流向 renders one partition bar (AI 工作 → 等待确认 → 待命) with an honest 0% legend (#38)", () => {
  const source = app();
  const body = sliceFunction(source, "function funnel()");
  assert.ok(
    body.includes("时间流向"),
    "funnel section title must be 时间流向",
  );
  // Caption must state the composite total in display words, not require math.
  assert.ok(
    body.includes("记录总时长") && body.includes("（AI 工作 + 等待确认 + 待命）"),
    "caption must read 记录总时长 …（AI 工作 + 等待确认 + 待命）",
  );
  // One bar, three segments in the canonical formula order.
  const segColors = [...body.matchAll(/renderFlowSegment\((?:[^,]+,\s*)?"(var\(--state-[a-z]+\))"/g)].map((m) => m[1]);
  assert.deepEqual(
    segColors,
    ["var(--state-work)", "var(--state-wait)", "var(--state-standby)"],
    "segments must render AI 工作 → 等待确认 → 待命 in formula order",
  );
  // wait/standby labels derive from the shared dimension table, not literals.
  assert.ok(body.includes('h(dimensionTitle("wait"))'), "wait label must derive from dimensionTitle");
  assert.ok(body.includes('h(dimensionTitle("standby"))'), "standby label must derive from dimensionTitle");
  // Zero-width segments are disclosed honestly in the legend, never dropped.
  assert.ok(
    body.includes("0.0%（本时段无发生）"),
    "legend must disclose 0% segments as 本时段无发生",
  );
  // The deducted-funnel shape is gone from the default layer.
  assert.equal(body.includes("funnel-bar-row"), false, "four-row funnel must be retired");
  assert.equal(body.includes("100% 记录总时长"), false, "stage-1 full-width row must be retired");
  assert.equal(body.includes("扣除"), false, "扣除 wording must be retired with the funnel");
});

test("Slice 10 UI language: one truth source drives the four dimension labels everywhere", () => {
  const source = app();
  const { block, entries } = dimensionMeta(source);
  const labels = entries.map((e) => e.label);
  assert.deepEqual(labels, ["本地工具", "模型推理", "等待确认", "待命"]);

  assert.match(
    source,
    /const VIEWPORT_SEGMENTS = BREAKDOWN_DIMENSIONS;/,
    "VIEWPORT_SEGMENTS must alias BREAKDOWN_DIMENSIONS (one truth source)",
  );
  assert.match(
    source,
    /const DETAIL_BREAKDOWN_ROWS = BREAKDOWN_DIMENSIONS;/,
    "DETAIL_BREAKDOWN_ROWS must alias BREAKDOWN_DIMENSIONS (one truth source)",
  );

  // No render site may re-hardcode a dimension display label, as data or text.
  // definitions() is the glossary surface, so its table cells are exempt.
  const outside = source
    .replace(block, "")
    .replace(definitionsBody(), "");
  for (const word of labels) {
    assert.equal(
      outside.includes(`label: "${word}"`),
      false,
      `dimension label "${word}" must only live in BREAKDOWN_DIMENSIONS`,
    );
    assert.equal(
      outside.includes(`>${word}<`),
      false,
      `dimension label "${word}" must not be hardcoded in render copy`,
    );
  }
  // Exactly one label declaration per dimension across the whole file.
  const declared = [...source.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  for (const word of labels) {
    assert.equal(
      declared.filter((x) => x === word).length,
      1,
      `"${word}" must be declared exactly once (BREAKDOWN_DIMENSIONS)`,
    );
  }

  // Drawer cards derive label + tooltip from the shared table.
  const drawer = sliceFunction(source, "function openDrawer(");
  for (const key of ["model", "tool", "wait"]) {
    assert.ok(
      drawer.includes(`dimensionTitle("${key}")`),
      `drawer ${key} card title must come from dimensionTitle("${key}")`,
    );
    assert.ok(
      drawer.includes(`dimensionHint("${key}")`),
      `drawer ${key} card tooltip must come from dimensionHint("${key}")`,
    );
  }
  const capsule = sliceFunction(source, "function capsuleBarHtml(");
  assert.ok(
    capsule.includes("dimensionHint(x.key)"),
    "capsule segments must reuse the shared dimension hint",
  );
});

test("Slice 10 UI language: drawer four cards read 模型推理 / 本地工具 / 等待确认 / 本轮时长", () => {
  const body = sliceFunction(app(), "function openDrawer(");
  const keys = [
    ...body.matchAll(/class="drawer-kpi-title">\$\{h\(dimensionTitle\("([^"]+)"\)\)\}/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    keys,
    ["model", "tool", "wait"],
    "the first three cards must be the shared 模型推理/本地工具/等待确认 dimensions",
  );
  assert.ok(
    body.includes('class="drawer-kpi-title">本轮时长<'),
    "the fourth card must read 本轮时长",
  );
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
  // Caption (composite) and AI-work segment stay explicit literals.
  assert.match(
    funnel,
    /class="flow-caption" title="口径：记录总时长 = AI 工作 work_ms/,
    "caption tooltip must name the composite breakdown fields",
  );
  assert.ok(
    funnel.includes('"口径：AI 工作 work_ms = 模型推理 + 本地工具"'),
    "AI 工作 segment tooltip must name the model + tool components",
  );
  // wait/standby tooltips must derive from the shared dimension table.
  for (const key of ["wait", "standby"]) {
    assert.ok(
      funnel.includes(`dimensionHint("${key}")`),
      `segment tooltip must derive from dimensionHint("${key}")`,
    );
  }
  // The segment helper escapes whatever tooltip it receives.
  const segHelper = sliceFunction(source, "function renderFlowSegment(");
  assert.match(
    segHelper,
    /title="\$\{h\(tooltip\)\}"/,
    "renderFlowSegment must h()-escape the tooltip it renders",
  );

  const card = sliceFunction(source, "function viewportBreakdownCard(");
  assert.match(
    card,
    /class="seg-legend-label" title="口径：/,
    "viewport legend labels must carry a 口径 tooltip",
  );

  const detail = sliceFunction(source, "function sessionDetail(");
  const kpiCalls = callBlocks(detail, "detailKpiCard");
  assert.equal(kpiCalls.length, 4, "sessionDetail must render four KPI cards");
  const kpiFields = ["sessionWallSpan", "work_ms", "autonomy_rate", "slow_ops"];
  kpiCalls.forEach((block, i) => {
    assert.ok(
      block.includes("口径："),
      `KPI card ${i + 1} must carry its own 口径 tooltip: ${block}`,
    );
    assert.ok(
      block.includes(kpiFields[i]),
      `KPI card ${i + 1} must name ${kpiFields[i]}: ${block}`,
    );
  });
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
  // Parse the rendered rows so each display word must sit next to its own
  // glossary term and field — independent `includes` would pass trivially.
  const cell = (html: string) => html.replace(/<[^>]+>/g, "").trim();
  const rows = [
    ...body.matchAll(
      /<tr><td>(.*?)<\/td><td class="sub">(.*?)<\/td><td>(.*?)<\/td><\/tr>/g,
    ),
  ].map((m) => [cell(m[1]), cell(m[2]), cell(m[3])]);
  assert.deepEqual(rows, [
    ["累计工作时长", "—", "processing_ms"],
    ["并行去重时长", "—", "processing_union_ms"],
    ["总时长", "wall time", "sessionWallSpan"],
    ["本轮时长", "wall time", "elapsed_ms"],
    ["AI 工作", "Active Work Duration", "work_ms = model_ms + tool execution"],
    ["等待确认", "Review Wait", "review_wait_ms"],
    ["待命", "Standby Duration", "standby_ms"],
    ["自动完成度", "Autonomy Rate", "autonomy_rate"],
    ["超 15s 慢操作", "Slow Operation Count", "slow_ops"],
    ["本地工具", "Tool Execution Duration", "tool execution"],
    ["模型推理", "Model API Duration", "model_ms"],
  ]);
  assert.ok(
    body.includes("「—」表示 GLOSSARY 无独立条目，口径以字段名为准。"),
    "the table must explain that — means no standalone glossary entry",
  );
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
