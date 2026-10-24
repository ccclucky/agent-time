import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

// ------------------------------------------------------------------
// 纯函数块提取：app.js 中的 PURE HELPERS 块是零浏览器依赖的纯函数，
// 这里整块摘出在 node:vm 里执行，用夹具数据做行为级 TDD
// ------------------------------------------------------------------
function loadPureHelpers(): Record<string, any> {
  const js = read("../public/app.js");
  const m = js.match(
    /\/\/ ==== PURE HELPERS BEGIN ====([\s\S]*?)\/\/ ==== PURE HELPERS END ====/,
  );
  assert.ok(m, "the PURE HELPERS block must exist in public/app.js");
  const sandbox: Record<string, any> = {};
  vm.runInNewContext(m![1], sandbox, { filename: "app-pure-helpers.js" });
  return sandbox;
}

// node:vm 的独立 realm 有自己的 Object/Array 原型，deepStrictEqual 会因
// 跨 realm 原型不同而误报；断言前统一 JSON 往返抹平 realm 边界
const norm = (x: unknown) => JSON.parse(JSON.stringify(x));

function makeTurn(partial: Record<string, any> = {}) {
  return {
    id: "t",
    start_ms: 0,
    end_ms: 0,
    elapsed_ms: null,
    status: "completed",
    reason: null,
    models: [],
    events: [],
    work_ms: null,
    review_wait_ms: null,
    standby_ms: null,
    human_ms: null,
    response_gap_ms: null,
    period_ms: null,
    breakdown: null,
    ...partial,
  };
}

function makeSession(partial: Record<string, any> = {}) {
  return {
    id: "s",
    agent: "Claude Code",
    project: "proj",
    title: null,
    turns: [],
    imported_at: 0,
    period_ms: 0,
    measured_turns: 0,
    work_ms: 0,
    review_wait_ms: 0,
    standby_ms: 0,
    ...partial,
  };
}

// ------------------------------------------------------------------
// Fix 2：抽屉总账回填（可推导数据回填 + 未完结轮次诚实说明）
// ------------------------------------------------------------------
test("Rollup: completed turn with breakdown shows real numbers and no backfill", () => {
  const { resolveRollup } = loadPureHelpers();
  const turn = makeTurn({
    start_ms: 0,
    end_ms: 60_000,
    elapsed_ms: 60_000,
    work_ms: 40_000,
    review_wait_ms: 12_000,
    breakdown: {
      model_api_ms: 30_000,
      tool_execution_ms: 15_000,
      tools: [{ name: "Bash", count: 2, duration_ms: 15_000 }],
    },
  });
  const r = resolveRollup(turn, 1_000_000);
  assert.equal(r.apiMs, 30_000);
  assert.equal(r.toolMs, 15_000);
  assert.equal(r.toolBackfilled, false);
  assert.equal(r.waitMs, 12_000);
  assert.equal(r.wallMs, 60_000);
  assert.equal(r.wallBackfilled, false);
  assert.equal(r.workRate, 67);
  assert.equal(r.openEnded, false);
});

test("Rollup: open turn without breakdown backfills Tools from per-call durations and Wall from start→now", () => {
  const { resolveRollup } = loadPureHelpers();
  const now = 10_000_000_000;
  const turn = makeTurn({
    start_ms: now - 120_000,
    end_ms: null,
    elapsed_ms: null,
    period_ms: null,
    work_ms: null,
    status: "open",
    events: [
      { kind: "tool_use", at_ms: now - 118_000, tool_name: "Bash", tool_id: "t1" },
      { kind: "tool_result", at_ms: now - 114_000, end_ms: now - 112_000, tool_id: "t1" },
      { kind: "tool_use", at_ms: now - 100_000, tool_name: "Bash", tool_id: "t2" },
      { kind: "tool_result", at_ms: now - 96_000, end_ms: now - 90_000, tool_id: "t2" },
    ],
  });
  const r = resolveRollup(turn, now);
  // Pi 口径：duration = result.end_ms − result.at_ms → 2000 + 6000 = 8000
  assert.equal(r.toolMs, 8_000);
  assert.equal(r.toolBackfilled, true);
  assert.equal(r.wallMs, 120_000);
  assert.equal(r.wallBackfilled, true);
  assert.equal(r.workRate, null);
  assert.equal(r.openEnded, true);
});

test("Rollup: elapsed_ms wins for wall time when present (no speculative now-span)", () => {
  const { resolveRollup } = loadPureHelpers();
  const turn = makeTurn({
    start_ms: 0,
    end_ms: 5_000,
    elapsed_ms: 5_000,
    breakdown: { model_api_ms: 1_000, tool_execution_ms: 500, tools: [] },
  });
  const r = resolveRollup(turn, 999_999_999);
  assert.equal(r.wallMs, 5_000);
  assert.equal(r.wallBackfilled, false);
});

test("Rollup: honest reason lines — open turn vs no-breakdown source get DISTINCT copies", () => {
  const { rollupEvidenceNote } = loadPureHelpers();
  const openTurn = makeTurn({ end_ms: null, status: "open" });
  assert.equal(
    rollupEvidenceNote(openTurn),
    "该轮未正常结束，无结束记录，无法核算",
    "an open turn must name the missing end record",
  );
  const codexTurn = makeTurn({ end_ms: 5_000, breakdown: null });
  const codexNote = rollupEvidenceNote(codexTurn);
  assert.ok(codexNote, "a completed breakdown-less turn must still explain itself");
  assert.notEqual(
    codexNote,
    "该轮未正常结束，无结束记录，无法核算",
    "the Codex/three-state degradation copy must be distinct from the open-turn copy",
  );
  const evidenceTurn = makeTurn({
    end_ms: 5_000,
    breakdown: { model_api_ms: 1, tool_execution_ms: 1, tools: [] },
  });
  assert.equal(rollupEvidenceNote(evidenceTurn), null);
});

// ------------------------------------------------------------------
// Fix 3：首页维度聚合统计（聚合，不是过滤）
// ------------------------------------------------------------------
test("Aggregation: byAgent returns one row per agent with counts and wall share", () => {
  const { aggregateSessionsByAgent } = loadPureHelpers();
  const sessions = [
    makeSession({ id: "a1", agent: "Claude Code", turns: [
      makeTurn({ start_ms: 1_700_000_000_000, end_ms: 1_700_000_060_000 }),
      makeTurn({ start_ms: 1_700_000_070_000, end_ms: 1_700_000_110_000 }),
    ] }),
    makeSession({ id: "b1", agent: "Codex", turns: [
      makeTurn({ start_ms: 1_700_000_000_000, end_ms: 1_700_000_300_000 }),
    ] }),
  ];
  const agg = norm(aggregateSessionsByAgent(sessions));
  assert.equal(agg.totalWallMs, 410_000);
  assert.deepEqual(
    agg.rows.map((r: any) => [r.agent, r.sessions, r.turns, r.wallMs]),
    [
      ["Codex", 1, 1, 300_000],
      ["Claude Code", 1, 2, 110_000],
    ],
    "rows must be one per agent, sorted by wall time desc",
  );
  const shareSum = agg.rows.reduce(
    (s: number, r: any) => s + (r.wallMs / agg.totalWallMs) * 100,
    0,
  );
  assert.ok(Math.abs(shareSum - 100) < 0.001, "shares must sum to ≈100%");
});

test("Aggregation: byProject returns TOP 5 plus an honest tail count", () => {
  const { aggregateSessionsByProject } = loadPureHelpers();
  const sessions = Array.from({ length: 7 }, (_, i) =>
    makeSession({
      id: `p${i}`,
      project: `proj-${i}`,
      turns: [makeTurn({ start_ms: 1_700_000_000_000, end_ms: 1_700_000_000_000 + (i + 1) * 10_000 })],
    }),
  );
  const agg = norm(aggregateSessionsByProject(sessions));
  assert.equal(agg.top.length, 5);
  assert.equal(agg.restCount, 2);
  assert.equal(agg.top[0].project, "proj-6", "largest wall time first");
  assert.equal(agg.totalWallMs, 280_000);
});

test("Aggregation: byTool merges breakdown.tools across sessions and counts the evidence basis", () => {
  const { aggregateTurnsByTool, toolLabel } = loadPureHelpers();
  const sessions = [
    makeSession({ id: "s1", turns: [
      makeTurn({
        breakdown: {
          model_api_ms: 1,
          tool_execution_ms: 14_000,
          tools: [
            { name: "Bash", count: 2, duration_ms: 5_000 },
            { name: "exec", count: 1, duration_ms: 9_000 },
          ],
        },
      }),
    ] }),
    makeSession({ id: "s2", turns: [
      makeTurn({
        breakdown: {
          model_api_ms: 1,
          tool_execution_ms: 3_000,
          tools: [{ name: "Bash", count: 1, duration_ms: 3_000 }],
        },
      }),
    ] }),
    // Codex：breakdown 为 null，不计入证据基础
    makeSession({ id: "s3", agent: "Codex", turns: [makeTurn({ breakdown: null })] }),
  ];
  const agg = norm(aggregateTurnsByTool(sessions));
  assert.equal(agg.basisSessions, 2, "only sessions with measured breakdown count as basis");
  assert.deepEqual(
    agg.top.map((r: any) => [r.name, r.count, r.durationMs]),
    [
      ["exec", 1, 9_000],
      ["Bash", 3, 8_000],
    ],
    "durations must merge across sessions and sort desc",
  );
  assert.equal(toolLabel("exec"), "执行命令", "friendly tool names must be available");
});

// ------------------------------------------------------------------
// 静态断言：CSS / 模板结构 / 徽标 / 版本戳
// ------------------------------------------------------------------
test("Fix 1: .agent-cell must NOT use display:flex on a td (that breaks row borders)", () => {
  const css = read("../public/style.css");
  const m = css.match(/\.agent-cell\s*\{([^}]*)\}/);
  assert.ok(m, ".agent-cell rule must exist");
  assert.doesNotMatch(
    m![1],
    /display:\s*flex/,
    "display:flex on a td demotes it to a block inside an anonymous cell — the exact badge-box misalignment from screenshot 1",
  );
  assert.match(m![1], /vertical-align:\s*middle/);
  assert.match(m![1], /white-space:\s*nowrap/);
});

test("Fix 1: agent-cell children are inline middle-aligned without extra box chrome", () => {
  const css = read("../public/style.css");
  assert.match(css, /\.agent-cell \.agent-mark\s*\{[^}]*vertical-align:\s*middle/);
  assert.match(css, /\.agent-cell \.tag\s*\{[^}]*vertical-align:\s*middle/);
});

test("Fix 2 markup: drawer rollup renders backfill note and honest reason lines", () => {
  const js = read("../public/app.js");
  assert.ok(
    js.includes("该轮未正常结束，无结束记录，无法核算"),
    "open turns must show the reason line, not a bare —",
  );
  assert.ok(
    js.includes("逐次调用累计"),
    "backfilled tool totals must disclose their derivation",
  );
  assert.ok(
    js.includes("项工具执行"),
    "the 'N 项工具执行' subtitle must be kept",
  );
  assert.ok(
    js.includes("resolveRollup(turn"),
    "openDrawer must consume the shared resolveRollup helper",
  );
});

test("Fix 3 markup: overview hosts the aggregation module between s1-grid and the session stream", () => {
  const js = read("../public/app.js");
  const overview = js.match(/function overview\(\)[\s\S]*?\n\}/);
  assert.ok(overview, "overview() must exist");
  const body = overview![0];
  const gridIdx = body.indexOf("</div>");
  const aggIdx = body.indexOf("viewportAggregationCard(");
  const streamIdx = body.indexOf("sessionStream()");
  assert.ok(aggIdx > gridIdx, "aggregation module must sit below the s1-grid");
  assert.ok(aggIdx < streamIdx, "aggregation module must sit above 全部会话流");
  assert.ok(
    body.includes("viewportAggregationCard(scopedModel)"),
    "the aggregation must aggregate the SAME scoped viewport as the breakdown card",
  );
  assert.ok(
    js.includes("基于已测量 breakdown 的"),
    "the tool grouping must state its evidence basis",
  );
  assert.ok(
    js.includes("当前视口"),
    "the aggregation subtitle must state the viewport basis",
  );
  assert.ok(js.includes("个项目"), "project grouping needs the 等 N 个项目 tail");
  const css = read("../public/style.css");
  for (const cls of [".agg-grid", ".agg-row", ".agg-share-bar", ".agg-share-fill"]) {
    assert.ok(css.includes(cls), `aggregation styles must include ${cls}`);
  }
});

test("Fix 4: badges carry the real OpenAI mark for Codex and the new Pi pixel mark", () => {
  const js = read("../public/app.js");
  assert.ok(
    js.includes("M22.2819 9.8211"),
    "Codex badge must embed the official OpenAI mark path (simple-icons, viewBox 0 0 24 24)",
  );
  assert.doesNotMatch(js, /glyph:\s*"Cx"/, "the fake Cx monogram must be gone");
  assert.doesNotMatch(js, /glyph:\s*"π"/, "the fake π monogram must be gone");
  assert.ok(
    js.includes('shape-rendering="crispEdges"'),
    "the Pi pixel mark must render crisp",
  );
  for (const color of ["#E48A7A", "#4F8EB3", "#EAB65D"]) {
    assert.ok(js.includes(color), `Pi pixel mark must contain ${color}`);
  }
  // Claude sunburst untouched (user accepted it)
  assert.match(js, /M8 2\.2v11\.6M2\.2 8h11\.6/);
  // Outer badge chrome unchanged (rounded square, currentColor, 16x16)
  assert.match(js, /<svg viewBox="0 0 16 16"[^>]*><rect x="0" y="0" width="16" height="16" rx="4\.5" fill="currentColor"\/>/);
});

test("Version stamp: both assets advance to 20261025-10", () => {
  const html = read("../public/index.html");
  const cssV = html.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = html.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV, "both assets must share one version stamp");
  assert.equal(cssV, "20261025-10", "stamp must advance per AGENTS.md (9 → 10)");
});
