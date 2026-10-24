import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

test("Feedback: homepage vertical rhythm comes from a real #content flex gap, not zero margins", () => {
  const css = read("../public/style.css");
  assert.match(
    css,
    /#content\s*\{[^}]*display:\s*flex[^}]*gap:\s*24px/,
    "#content must be a flex column with a ≥24px desktop gap between modules",
  );
  assert.match(
    css,
    /#content > \*\s*\{[^}]*margin-bottom:\s*0/,
    "leftover direct-child margin-bottoms must be zeroed so margins never double the gap",
  );
});

test("Feedback: homepage exposes an agent (harness) filter chip row wired to state.overviewAgent", () => {
  const js = read("../public/app.js");
  assert.ok(
    js.includes("overviewAgent"),
    "the selected agent must persist in state.overviewAgent across re-renders",
  );
  assert.ok(
    js.includes("data-agent-chip"),
    "chips must use delegated data-agent-chip attributes (CSP: no inline onclick)",
  );
  assert.match(
    js,
    /function effectiveOverviewAgent\(\)/,
    "an absent agent must fall back to the unfiltered view",
  );
  // The filter narrows the viewport aggregation (sessionSummaries before
  // visibleSessions are consumed by TOP3 + breakdown), not the brush math.
  assert.match(
    js,
    /sessionSummaries\.filter/,
    "the agent filter must apply to sessionSummaries before viewport aggregation",
  );
});

test("Feedback: agentMark badges render inline SVG across stream, TOP3, detail nav, capsules and table", () => {
  const js = read("../public/app.js");
  assert.match(
    js,
    /function agentMark\(/,
    "a shared agentMark(agent) component must exist",
  );
  assert.match(
    js,
    /<svg viewBox="0 0 16 16"/,
    "badges must be inline SVG (CSP allows inline SVG; no static image files)",
  );
  for (const anchor of [
    "rank-subline",
    "stream-left",
    "detail-id-mono",
    "capsule-no",
    "agent-cell",
  ]) {
    // Each anchor sits right next to an agentMark() call site in its template.
    assert.ok(
      new RegExp(`agentMark\\([^)]*\\)[\\s\\S]{0,220}${anchor}`).test(js) ||
        new RegExp(`${anchor}[\\s\\S]{0,220}agentMark\\(`).test(js),
      `badges must appear near ${anchor}`,
    );
  }
  const css = read("../public/style.css");
  assert.ok(css.includes(".agent-mark"), "badge styles must exist");
  assert.ok(
    css.includes(".agent-mark-codex") &&
      css.includes(".agent-mark-claude") &&
      css.includes(".agent-mark-pi"),
    "per-agent accent variants must exist",
  );
  assert.ok(
    css.includes(".agent-filter-row"),
    "the chip row must be styled",
  );
});

test("Feedback: drawer copy separates the honest prompt slot from the Codex ZDR thinking note", () => {
  const js = read("../public/app.js");
  assert.ok(
    js.includes("本机记录未包含该轮的提问文本"),
    "a null prompt must show its own honest copy, never the thinking note",
  );
  assert.ok(
    js.includes("Codex 官方记录对模型思考链加密，本机无法解密展示"),
    "Codex thinking must be explained as encrypted, not 未记录",
  );
  assert.ok(
    !js.includes("（ZDR）"),
    "the display layer must not expose the English acronym (glossary layer only)",
  );
  const ts = read("../src/store.ts");
  assert.ok(
    ts.includes("ZDR"),
    "the transcript endpoint's missing_fields must carry the ZDR explanation",
  );
});

test("Feedback: drawer tool stack shows friendly builtin labels and a muted detail line", () => {
  const js = read("../public/app.js");
  assert.match(
    js,
    /function toolLabel\(/,
    "a shared toolLabel(name) helper must exist",
  );
  assert.ok(
    js.includes("执行命令") && js.includes("跟进任务") && js.includes("应用补丁"),
    "Codex builtin friendly names must be mapped",
  );
  assert.ok(
    js.includes("tool-exec-detail"),
    "each tool call card must render a second muted detail/raw-name line",
  );
  assert.ok(
    js.includes("applyDrawerToolDetails"),
    "transcript details must be merged onto the tool stack by call_id",
  );
});
