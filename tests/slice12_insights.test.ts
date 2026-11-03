import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// slice 12 · #54 洞察动作化：跨日三态趋势（按日/按周）、本时段结论卡、
// Markdown 报告导出。全部为前端从现有报表逐轮字段推导，零后端改动。

const js = readFileSync(
  new URL("../public/app.js", import.meta.url).pathname,
  "utf8",
);
const html = readFileSync(
  new URL("../public/index.html", import.meta.url).pathname,
  "utf8",
);

test("Slice 12 趋势: 按轮次开始日/周归桶，粒度可切换且随视图持久化", () => {
  assert.ok(js.includes("function trendBuckets"), "归桶聚合函数");
  assert.ok(js.includes('gran === "week" ? weekBucket(start) : dayKey(start)'), "日/周桶键");
  assert.ok(js.includes('data-trend-gran="day"'), "按日切换入口");
  assert.ok(js.includes('data-trend-gran="week"'), "按周切换入口");
  assert.ok(
    js.includes('["day", "week"].includes(b.dataset.trendGran)'),
    "粒度入参白名单校验",
  );
  assert.ok(/trendGran: state\.trendGran/.test(js), "trendGran 写入视图持久化");
  assert.ok(
    js.includes('v.trendGran === "day" || v.trendGran === "week"'),
    "恢复时白名单校验",
  );
});

test("Slice 12 趋势: 口径如实披露——三态贡献与 summary 同口径、柱高非线性、缺失不充数", () => {
  assert.ok(
    js.includes("三态贡献与 summary 完全同口径") ||
      js.includes("同口径"),
    "缩放口径注释",
  );
  assert.ok(js.includes("平方根缩放"), "柱高非线性缩放对用户披露");
  assert.ok(
    js.includes("整体计入起始"),
    "跨日/周轮归属口径对用户披露",
  );
  assert.ok(js.includes("无法按"), "无开始时刻轮次的诚实空态");
  // 某态缺失的轮不计入该态：走 work_ms !== null 判定而非直接累加
  assert.ok(js.includes("if (t.work_ms !== null) b.work += scale(t.work_ms)"));
  assert.ok(
    js.includes("if (t.review_wait_ms !== null) b.wait += scale(t.review_wait_ms)"),
  );
});

test("Slice 12 报告: Markdown 导出为本地 Blob 下载，仅含所选区间", () => {
  assert.ok(js.includes('data-action="export-report"'), "导出入口");
  assert.ok(js.includes("case \"export-report\""), "动作接线");
  assert.ok(js.includes("exportWeeklyReport"), "导出函数");
  assert.ok(js.includes('"text/markdown;charset=utf-8"'), "Markdown MIME");
  assert.ok(
    js.includes("agenttime-report-${state.start}-to-${state.end}.md"),
    "文件名携带区间",
  );
  assert.ok(
    js.includes("生成于 AgentTime 本地数据 · 仅含所选区间 · 无遥测"),
    "导出尾注声明",
  );
  // 与 CSV 导出同一下载通道，无上传行为
  assert.ok(js.includes("URL.revokeObjectURL"), "Blob 释放");
});

test("Slice 12 结论卡: 只做可从页面数字直接推出的观察，证据不足如实说明", () => {
  assert.ok(js.includes("本时段结论"), "结论卡标题");
  assert.ok(js.includes("不做推测性归因"), "口径副标题");
  assert.ok(
    js.includes("暂无法生成结论"),
    "无细分数据时的诚实回退",
  );
  // 四类结论各自的证据门槛
  assert.ok(js.includes("if (toolTotal > 0 && tools[0])"), "工具结论需有实测");
  assert.ok(
    js.includes("if ((s.review_wait_ms || 0) > 0)"),
    "等待确认结论需非零",
  );
  assert.ok(
    js.includes("/ gross >= 0.3"),
    "待命提示仅在占比显著时出现",
  );
  // 结论卡不使用内联样式硬编码颜色之外的行为断言：卡片在总览页装配
  assert.ok(js.includes("${adviceCards()}"), "总览页装配结论卡");
  assert.ok(js.includes("${trendCard()}"), "总览页装配趋势卡");
});

test("Slice 12 评审回归: 工具聚合保留 name，会话占比分子分母同口径", () => {
  // #57 Codex 评审 P2×2：累加器丢 name 导致工具名显示为占位；挂钟时长对
  // 三态分母求占比会超 100%
  assert.ok(
    js.includes("{ name: tool.name, count: 0, durationMs: 0 }"),
    "累加器必须携带 name",
  );
  assert.ok(js.includes("function sessionThreeStateMs"), "同口径会话测量函数");
  const uses = js.split("sessionThreeStateMs(x)").length - 1;
  assert.ok(uses >= 2, "结论卡与导出都使用同口径测量");
  assert.ok(
    js.includes("AI 工作 + 等待确认 + 待命合计口径"),
    "导出的 TOP 会话列表标注口径",
  );
});

test("Slice 12 静态资源: 版本戳统一递增到 20261104-2", () => {
  const cssV = html.match(/style\.css\?v=([0-9-]+)/)![1];
  const jsV = html.match(/app\.js\?v=([0-9-]+)/)![1];
  assert.equal(cssV, jsV, "两个资源共用一个版本戳");
  assert.equal(cssV, "20261104-2", "本次改动必须伴随新戳");
});
