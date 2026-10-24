import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 反馈轮 4（本地试用反馈 2026-10-25）：
// #1 三个 harness 徽标失真；#2 全局同步不落盘草稿；#3 日期状态刷新即丢；
// #4 自选日期无选中态、无区段展示；#5 接入状态不持久化。

const js = readFileSync(
  new URL("../public/app.js", import.meta.url).pathname,
  "utf8",
);
const css = readFileSync(
  new URL("../public/style.css", import.meta.url).pathname,
  "utf8",
);
const html = readFileSync(
  new URL("../public/index.html", import.meta.url).pathname,
  "utf8",
);

test("Round4 #1: Antigravity 官方 path 必须带 evenodd 镂空（漏写渲染成实心色块）", () => {
  const glyph = js.match(/Antigravity: \{[\s\S]{0,200}?<svg[\s\S]{0,300}?<\/svg>/)?.[0] ?? "";
  assert.ok(glyph.includes("fill-rule=\"evenodd\""), glyph);
});

test("Round4 #1: OpenCode 使用 simple-icons 官方方环标，不再自绘尖括号", () => {
  assert.ok(js.includes('OPENCODE_MARK_PATH = "M22 24H2V0h20zM17 4.8H7v14.4h10z"'));
  assert.ok(!js.includes("终端尖括号"));
  const glyph = js.match(/OpenCode: \{[\s\S]{0,200}?<svg[\s\S]{0,300}?<\/svg>/)?.[0] ?? "";
  assert.ok(glyph.includes("fill-rule=\"evenodd\""), glyph);
});

test("Round4 #1: OMP 使用 hero 主视觉渐变 π（几何实测），弃用细腿 icon.svg 版", () => {
  assert.ok(js.includes('viewBox="0 0 178 169"'), "hero 实测几何");
  assert.ok(js.includes('id="omp-g"'), "品牌渐变");
  assert.ok(!js.includes("OMP_MARK_SHAPES"), "旧 icon.svg 版已移除");
  assert.ok(css.includes(".agent-mark-omp"), "徽标底色类存在");
  assert.ok(css.includes("#1D1226"), "深紫底色承托渐变 π");
});

test("Round4 #2/#5: 全局同步先批量落盘接入草稿，并回报保存数量", () => {
  assert.ok(js.includes("async function persistDrafts()"), "批量落盘入口");
  // refresh() 在调用 /api/refresh 前必须先 persistDrafts()
  const refresh = js.slice(js.indexOf("async function refresh()"), js.indexOf("async function refresh()") + 1200);
  const persistAt = refresh.indexOf("await persistDrafts()");
  const apiAt = refresh.indexOf('api("/api/refresh"');
  assert.ok(persistAt > -1 && apiAt > persistAt, "落盘必须先于同步请求");
  assert.ok(js.includes("已保存 ${savedCount} 项接入设置"), "toast 回报保存数");
  // 单卡保存与全局同步共用同一请求体语义
  assert.ok(js.includes("function directoryPayload("));
});

test("Round4 #3/#5: 日期区段状态持久化到 localStorage 并在启动时恢复", () => {
  assert.ok(js.includes('"agenttime.view.v1"'), "持久化键");
  assert.ok(js.includes("function saveView()"));
  assert.ok(js.includes("function restoreView()"));
  // 启动序列：restoreView 必须先于首次 applyRoute/load
  const boot = js.slice(-400);
  assert.ok(
    boot.indexOf("restoreView();") < boot.indexOf("applyRoute();") &&
      boot.indexOf("applyRoute();") < boot.indexOf("load();"),
    boot,
  );
  // 预设切换与自选应用都要写回
  const rangeClick = js.slice(js.indexOf('if (b.dataset.range) {'), js.indexOf('if (b.dataset.range) {') + 700);
  assert.ok(rangeClick.includes("saveView()"));
});

test("Round4 #4: 自选段按钮存在，激活时直接展示实际区段", () => {
  assert.ok(js.includes('"custom",'), "ranges 列表含自选段");
  assert.ok(js.includes("自选 ${state.start.slice(5)} ~ ${state.end.slice(5)}"), "区段展示在按钮上");
  // 点击自选直接打开日期选择弹层
  const rangeClick = js.slice(js.indexOf('if (b.dataset.range) {'), js.indexOf('if (b.dataset.range) {') + 700);
  assert.ok(rangeClick.includes('data-action="dates"'));
});

test("Round4: 两个静态资源的版本戳保持一致且可递增", () => {
  const cssV = html.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = html.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV);
  assert.match(jsV, /^\d{8}-\d+$/);
});
