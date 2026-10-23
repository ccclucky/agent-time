import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

test("Slice 7 Turn Inspector: app.js renders turn capsules in the detail page", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("turn-capsule"),
    "detail page must render compact turn capsule rows",
  );
  assert.ok(
    js.includes("轮次 #"),
    "each capsule must be labelled 轮次 #N",
  );
  assert.ok(
    js.includes("data-turn-capsule"),
    "capsules and slow-op rows must carry a delegated data-turn-capsule attribute (CSP: no inline onclick)",
  );
  assert.ok(
    js.includes("capsule-bar") || js.includes("260px"),
    "capsules must show the ~260px mini proportion bar",
  );
  // Active highlight synced with the drawer selection
  assert.ok(
    js.includes('classList.toggle("active"') ||
      js.includes(".turn-capsule.active") ||
      js.includes("turn-capsule active"),
    "selected capsule must receive the .active highlight",
  );
});

test("Slice 7 Turn Inspector: capsule mini bar degrades honestly when breakdown is null", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("该轮无细分耗时数据"),
    "Codex turns without breakdown must not show fabricated segments",
  );
});

test("Slice 7 Turn Inspector: drawer shows per-call tool execution stack with 15s slow accent", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("tool-exec-card"),
    "drawer must render .tool-exec-card per-call rows",
  );
  assert.ok(
    js.includes('"slow"') || js.includes("` slow`") || js.includes("tool-exec-card slow") || js.includes('"tool-exec-card${'),
    "calls slower than 15s must get the .slow accent",
  );
  assert.ok(
    js.includes("15000"),
    "slow threshold must stay 15s (15000ms)",
  );
  assert.ok(
    js.includes("perCallToolTimings"),
    "per-call durations must come from the shared perCallToolTimings helper",
  );
});

test("Slice 7 Turn Inspector: drawer loads prompt/CoT via the transcript endpoint with per-session cache and honest errors", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("/api/session/transcript"),
    "drawer must fetch the on-demand transcript endpoint",
  );
  assert.ok(
    js.includes("transcriptCache"),
    "transcripts must be cached per session",
  );
  assert.ok(
    js.includes("用户输入") && js.includes("User Prompt"),
    "drawer must label the user prompt section",
  );
  assert.ok(
    js.includes("模型思考与推理"),
    "drawer must label the CoT section",
  );
  assert.ok(
    js.includes("不存在或已被移动") || js.includes("无法读取"),
    "failed transcript fetch must surface an honest visible hint",
  );
});

test("Slice 7 Turn Inspector: prev/next turn navigation syncs capsules and stays keyboard reachable", () => {
  const js = read("../public/app.js");

  assert.ok(
    js.includes("prev-turn") && js.includes("next-turn"),
    "drawer must offer delegated prev/next turn actions",
  );
  assert.ok(
    js.includes("navigateTurn"),
    "turn stepping must be a named shared helper",
  );
  assert.ok(
    js.includes('"ArrowLeft"') && js.includes('"ArrowRight"'),
    "keyboard arrows must navigate turns while the drawer is open",
  );
});

test("Slice 7 Turn Inspector: style.css ports the prototype capsule and drawer classes", () => {
  const css = read("../public/style.css");

  assert.ok(css.includes(".turn-capsule"), "turn capsule rows must be styled");
  assert.ok(
    css.includes(".turn-capsule.active"),
    "active capsule highlight must be styled",
  );
  assert.ok(css.includes(".capsule-bar"), "260px mini bar must be styled");
  assert.ok(
    css.includes(".tool-exec-card"),
    "tool execution cards must be styled",
  );
  assert.ok(
    css.includes(".tool-exec-card.slow"),
    "slow tool cards must carry the 3px red accent",
  );
});

test("Slice 7 Turn Inspector: index.html bumps the cache-busting stamp and adds drawer step buttons", () => {
  const html = read("../public/index.html");
  const cssV = html.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = html.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV, "both assets must share one version stamp");
  assert.equal(
    cssV,
    "20261025-4",
    "version stamp must be bumped past main's 20261025-2 after the PR #19 merge",
  );
  assert.ok(
    html.includes("prev-turn") && html.includes("next-turn"),
    "drawer header must contain delegated prev/next buttons",
  );
});
