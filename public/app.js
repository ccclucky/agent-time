"use strict";

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const escapeHTML = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const h = escapeHTML;

const names = {
  overview: ["时间总览", "先看时间花销，再沿着记录核对明细。"],
  sessions: ["会话记录", "每次会话，都能查看到每轮的起止记录。"],
  compare: ["工具与模型", "比较已记录时长，不把速度当作质量排名。"],
  sources: ["配置与接入", "默认识别常用目录，也可随时修改。"],
};

// 1.8px 极简 SVG 矢量线框图标，彻底杜绝操作系统 Emoji
const icons = {
  overview:
    '<path d="M3 3v18h18"/><path d="M19 9l-5 5-4-4-6 6"/>',
  sessions:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/>',
  compare:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
  sources:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  close:
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  dot:
    '<circle cx="12" cy="12" r="6"/>',
};

const icon = (n) =>
  `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[n] || ""}</svg>`;

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function localDate() {
  const p = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const v = (t) => p.find((x) => x.type === t).value;
  return `${v("year")}-${v("month")}-${v("day")}`;
}

function previous(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const state = {
  page: "overview",
  range: "week",
  start: previous(localDate(), 6),
  end: localDate(),
  query: "",
  sort: "recent",
  report: null,
  sources: null,
  directories: [],
  drafts: {},
  saving: new Set(),
  busy: false,
  syncPhase: "",
  // 视口与下钻状态
  activeSessionId: null,
  selectedTurnId: null,
  zoomStartPct: 0,
  zoomEndPct: 100,
  // 首页接入工具筛选（"all" 或当前报告中实际存在的 agent 名）
  overviewAgent: "all",
  // 跨日趋势的桶粒度（day=按日 / week=按周，周一为一周起点）；随视图状态持久化
  trendGran: "day",
  // Turn Inspector 抽屉的按需会话文本缓存（session_id → {status, data?, message?}）
  transcriptCache: new Map(),
};

// 视图状态持久化：日期区段（预设 + 自选）写入 localStorage，刷新页面不再丢失
// （反馈轮 4 #3/#4/#5 的状态面）。只接受格式合法且跨度 ≤367 天的历史值。
const VIEW_KEY = "agenttime.view.v1";
function saveView() {
  try {
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        range: state.range,
        start: state.start,
        end: state.end,
        trendGran: state.trendGran,
      }),
    );
  } catch {}
}
function restoreView() {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null");
    const iso = (x) =>
      typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null;
    const start = iso(v?.start),
      end = iso(v?.end);
    if (!start || !end || start > end) return;
    if ((new Date(end) - new Date(start)) / 86400000 > 366) return;
    if (!["today", "week", "month", "custom"].includes(v.range)) return;
    state.range = v.range;
    state.start = start;
    state.end = end;
    // 趋势粒度是独立于日期区段的用户选择，单独校验、单独恢复
    if (v.trendGran === "day" || v.trendGran === "week") {
      state.trendGran = v.trendGran;
      state.trendGranManual = true;
    }
  } catch {}
}

let focusBeforeDialog = null;
let requestVersion = 0;

function fmt(ms) {
  if (ms === null || ms === undefined) return "暂无数据";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60000);
  const remSec = Math.floor((ms % 60000) / 1000);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    : `${m}m ${remSec ? `${remSec}s` : ""}`;
}

const stamp = (ms) =>
  ms === null || !ms
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(ms);

// Token 数量紧凑格式：<1k 原样，<1M 保留一位小数的 k，再往上 M
function fmtTokens(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

const tokenSub = (t) =>
  t
    ? `输入 ${fmtTokens(t.input_tokens)} · 缓存 ${fmtTokens(t.cached_input_tokens)} · 输出 ${fmtTokens(t.output_tokens)}`
    : "源记录未携带 Token 快照";

const statuses = {
  completed: "已完结",
  aborted: "已中止",
  failed: "执行失败",
  open: "暂无结束记录",
  incomplete: "缺少起点",
  invalid: "记录冲突",
};

// Codex 内建工具的友好显示名与 toolLabel() 定义已并入下方 PURE HELPERS 纯函数块，
// 与总账回填 / 维度聚合助手共用同一块零浏览器依赖代码（node:vm 整块提取做行为级单测）

// 首页/抽屉统一使用的接入工具徽标（独立官方 SVG 图标文件，避免内联 filter/mask ID 冲突）
const AGENT_MARK_META = {
  Codex: { icon: "codex.svg", cls: "codex", label: "Codex" },
  "Claude Code": { icon: "claude.svg", cls: "claude", label: "Claude Code" },
  Pi: { icon: "pi.svg", cls: "pi", label: "Pi" },
  Antigravity: { icon: "antigravity.svg", cls: "antigravity", label: "Antigravity" },
  "DeepSeek Harness": { icon: "deepseek.svg", cls: "dsh", label: "DeepSeek Harness" },
  "Oh-My-Pi": { icon: "omp.svg", cls: "omp", label: "Oh-My-Pi" },
  OpenCode: { icon: "opencode.svg", cls: "opencode", label: "OpenCode" },
};

function agentMark(agent) {
  const m = AGENT_MARK_META[agent];
  if (!m) return "";
  return `<span class="agent-mark agent-mark-${m.cls}" title="${h(m.label)}" aria-label="${h(m.label)}"><img class="agent-mark-img" src="/icons/${m.icon}?v=20261119-1" alt="${h(m.label)}" width="16" height="16"/></span>`;
}

const UNKNOWN_PROJECT_HINT =
  "该会话在来源工具中未绑定代码目录（如全局对话或启动于根目录 /），并非解析缺失";

function isUnboundProject(project) {
  return !project || project === "未知项目";
}

function projectLabel(project) {
  return isUnboundProject(project) ? "未绑定工作区" : project;
}

function projectHint(project) {
  return isUnboundProject(project) ? UNKNOWN_PROJECT_HINT : project;
}

function spinnerIcon(cls = "btn-spinner") {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
}

function setSyncState(busy, phase = "") {
  state.busy = busy;
  state.syncPhase = busy ? phase || "正在扫描并解析本地会话记录…" : "";
  const btn = $("#refresh");
  if (btn) {
    btn.disabled = busy;
    btn.innerHTML = busy ? `${spinnerIcon()}同步中…` : "同步记录";
  }
  const bar = $("#syncBar");
  if (bar) bar.classList.toggle("active", busy);
  const banner = $("#syncBanner");
  if (banner) {
    if (busy) {
      banner.hidden = false;
      banner.innerHTML = `
        <div class="sync-banner-left">
          ${spinnerIcon("sync-banner-spinner")}
          <span class="sync-banner-text">${h(state.syncPhase)}</span>
        </div>
        <span class="sync-banner-sub">大体积日志首次解析可能需要数秒，请勿关闭页面</span>
      `;
    } else {
      banner.hidden = true;
      banner.innerHTML = "";
    }
  }
  if (window.applyI18n) window.applyI18n();
}

async function api(url, options) {
  const r = await fetch(url, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "读取失败，请重试");
  return data;
}

function error(message) {
  $("#error").innerHTML = message ? `<div class="err" role="alert">${h(message)}</div>` : "";
}

async function load() {
  const version = ++requestVersion;
  error("");
  try {
    const q = new URLSearchParams({
      start: state.start,
      end: state.end,
      timezone,
    });
    const [report, sources, settings] = await Promise.all([
      api("/api/report?" + q),
      api("/api/sources"),
      api("/api/directories"),
    ]);
    if (version !== requestVersion) return;
    state.report = report;
    state.sources = sources;
    state.directories = settings.directories;
    render();
  } catch (e) {
    if (version === requestVersion) {
      error(e.message);
      if (!state.report)
        $("#content").innerHTML =
          '<div class="empty">本地数据未能读取。请确认服务仍在运行，然后重新同步。</div>';
    }
  }
}

// ── 实时账本（slice 11）：轮询 /api/pulse 感知服务端自动同步 ──────────────
// 服务端对源目录变化自动重导入并推进 revision；前端每 5s 探一次，revision
// 前进即按当前视图状态重新拉取报表（state.range/日期筛选全部存活于 state，
// 不受重渲染影响）。用户在接入页有未保存草稿时暂停自动刷新，防止重渲染
// 覆盖正在编辑的输入；离开页面（导航触发 load()）后自然补上。
let lastPulse = null; // null = 尚未建立基线，下一轮只记录不刷新
async function pulseLoop() {
  let p;
  try {
    p = await api("/api/pulse");
  } catch {
    return; // 服务未开启自动同步或瞬时离线：不作提示，下一轮再试
  }
  if (typeof p.revision !== "number") return; // 明确未开启（revision: null）
  if (lastPulse === null) {
    lastPulse = p.revision;
  } else if (p.revision !== lastPulse) {
    const dirtyDraft = state.page === "sources" && Object.keys(state.drafts).length > 0;
    if (!dirtyDraft && !state.busy) {
      lastPulse = p.revision;
      await load();
    }
  }
  if (p.last_refresh_at_utc) {
    const el = $("#liveStatus");
    if (el)
      el.textContent =
        "自动同步已开启 · 最近刷新 " + stamp(Date.parse(p.last_refresh_at_utc));
  }
}

function render() {
  if (!state.report) return;

  // 1. 顶部标题（#session/:id 详情页拥有专属标题，不占用侧边导航四页命名）
  const pageTitle =
    state.page === "session"
      ? ["会话详情", "本会话专属操作分布、体检指标与瓶颈归因。"]
      : names[state.page];
  $("#title").textContent = pageTitle[0];
  $("#subtitle").textContent = pageTitle[1];

  // 2. 导航栏 (带 1.8px 矢量 SVG 图标与活动状态)
  $("#nav").innerHTML = Object.entries(names)
    .map(
      ([key, value]) =>
        `<button class="nav-btn ${state.page === key ? "active" : ""}" data-page="${key}" ${state.page === key ? 'aria-current="page"' : ""} title="${value[0]}" aria-label="${value[0]}">${icon(key)}</button>`,
    )
    .join("");

  // 3. 日期范围切换
  $("#ranges").innerHTML = [
    ["today", "今天"],
    ["week", "近 7 天"],
    ["month", "近 30 天"],
    // 自选段：激活时把实际区段直接写在按钮上，用户无需回忆选过什么（反馈轮 4 #4）
    [
      "custom",
      state.range === "custom"
        ? `自选 ${state.start.slice(5)} ~ ${state.end.slice(5)}`
        : "自选",
    ],
  ]
    .map(
      ([k, t]) =>
        `<button data-range="${k}" class="${state.range === k ? "active" : ""}" aria-pressed="${state.range === k}">${t}</button>`,
    )
    .join("");

  const r = state.report.range;
  $("#rangetext").textContent = `${r.start} — ${r.end} · ${r.timezone}`;
  $("#updated").textContent =
    `统计快照 ${new Date(state.report.generated_at).toLocaleTimeString("zh-CN")}`;

  if (state.sources.failed_sources) {
    error(
      `有 ${state.sources.failed_sources} 个数据源最近同步失败，当前显示其上次成功导入的快照。请检查源文件后重新同步。`,
    );
  }

  // 4. 页面主体分发（#session/:id 详情页取代首页组合视图）
  $("#content").innerHTML =
    state.page === "session"
      ? sessionDetail()
      : {
          overview: overview,
          sessions: sessions,
          compare: compare,
          sources: sources,
        }[state.page]();

  if ($("#search")) $("#search").value = state.query;

  // 挂载时间轴拖拽与视口缩放手柄监听
  bindBrushEvents();
  if (window.applyI18n) window.applyI18n();
}

function noData() {
  if (state.busy && state.syncPhase) {
    return `<section class="panel empty" style="max-width:560px; margin:24px auto;">
      <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:8px;">
        ${spinnerIcon("sync-banner-spinner")}
        <h2 style="margin:0;">${h(state.syncPhase)}</h2>
      </div>
      <p>正在只读扫描并解析本机历史事件流，首次导入大体积日志可能需要数秒…</p>
    </section>`;
  }
  const detected = (state.directories || []).filter(
    (d) => d.status === "directory" && !d.enabled,
  );
  if (state.sources?.registered_files === 0 && detected.length > 0) {
    const chips = detected
      .map(
        (d) =>
          `<span class="agent-chip" style="cursor:default;">${agentMark(d.name)}<span>${h(d.name)}</span></span>`,
      )
      .join("");
    return `<section class="panel empty" style="text-align:left; max-width:680px; margin:24px auto;">
      <h2>发现本机已有 ${detected.length} 个编码工具的会话记录</h2>
      <p>AgentTime 只读解析本机事件流，不读取凭据或上传数据。确认接入下方已检测到的工具后即可立即生成你的时间账本：</p>
      <div style="display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 18px;">${chips}</div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn primary" data-action="onboard-enable-all">一键接入并立即同步 (${detected.length})</button>
        <button class="btn" data-page="sources">手动配置目录</button>
      </div>
    </section>`;
  }
  return `<section class="panel empty"><h2>这个时间范围还没有会话记录</h2><p>已登记 ${state.sources.registered_files} 个本地文件。请在配置页启用 Codex、Claude Code、Pi、Antigravity、DeepSeek Harness、OpenCode 或 Oh-My-Pi 数据目录并保存，或调整日期范围。</p><button class="btn primary" data-page="sources">配置数据目录</button></section>`;
}

function stats() {
  const s = state.report.summary;
  return `<div class="stats">
    <div class="stat" title="口径：累计工作时长 processing_ms = 各轮可测量区间相加">
      <label>累计工作时长</label>
      <div class="number">${fmt(s.processing_ms)}</div>
      <small>各轮可测量记录区间时间相加 ↗</small>
    </div>
    <div class="stat">
      <label>已测量 / 已记录轮次</label>
      <div class="number">${s.measured_turns} / ${s.turns}</div>
      <small>未结束或异常记录单列 ↗</small>
    </div>
    <div class="stat">
      <label>统计会话总数</label>
      <div class="number">${s.sessions}</div>
      <small>已接入本地工具全部记录 ↗</small>
    </div>
  </div>`;
}

// ========================================================
// 模块 2：核心大盘 —— 时间流向
// 严格对齐 GLOSSARY.md：严禁粗暴相减，真实数据核算
// ========================================================

// 占比条分段（#38 方案 A）：宽度不足 12% 时段内不写字（图例兜底），0% 段不渲染
function renderFlowSegment(pct, colorVar, label, tooltip, isGlow = false) {
  if (Number(pct) <= 0) return "";
  const inside = Number(pct) >= 12 ? `<span class="flow-seg-text">${label} ${pct}%</span>` : "";
  return `
      <div class="flow-seg" style="width: ${pct}%; background: ${colorVar}; ${isGlow ? "box-shadow: 0 0 10px rgba(204,120,92,0.35);" : ""}" title="${h(tooltip)}">${inside}</div>`;
}

function funnel() {
  const s = state.report.summary;
  const proc = s.processing_ms || 0;
  if (!proc) return "";

  const union = s.processing_union_ms || proc;
  const concurrency = union > 0 ? (proc / union).toFixed(1) : "1.0";

  // 严格核查三态数据是否存在
  const hasThreeState = s.work_ms !== null && s.review_wait_ms !== null;
  if (!hasThreeState) {
    return `
    <section class="funnel-card">
      <div class="section-header">
        <div>
          <span class="section-title">时间流向</span>
          <span class="section-subtitle">基于一手事件流真实度量 · 无伪造推算</span>
        </div>
        <span class="funnel-concurrency-pill">${concurrency}x 并发效能倍率</span>
      </div>
      <div class="demo" style="margin: 8px 0 0;">
        <strong>口径提示</strong>
        <span>当前所选时间范围内的会话尚未包含细粒度三态事件，暂不推断 AI 工作与等待确认的拆分。</span>
      </div>
    </section>`;
  }

  const work = s.work_ms;
  const wait = s.review_wait_ms;
  const standby = s.standby_ms || 0;
  // 守恒口径第 4 态：中途停了（仅 Antigravity 等启用方有数据，其余来源为 null/0）
  const idle = s.idle_gap_ms || 0;
  const queueCount = s.queue_count || 0;

  // 分母必须由各态精确相加构成，确保百分比之和严格为 100%，杜绝击穿
  const grossTotal = work + wait + idle + standby || 1;

  const waitPct = ((wait / grossTotal) * 100).toFixed(1);
  const idlePct = ((idle / grossTotal) * 100).toFixed(1);
  const standbyPct = ((standby / grossTotal) * 100).toFixed(1);
  const workPct = ((work / grossTotal) * 100).toFixed(1);

  // 图例兜底：0% 段与窄段装不进条内的信息，全部在这里诚实披露
  const legendItem = (colorVar, name, ms, pct) => `
        <span class="flow-legend-item">
          <i style="background:${colorVar};"></i>${name} <strong>${fmt(ms)}</strong>
          <span class="flow-legend-pct">${Number(pct) <= 0 ? "0.0%（本时段无发生）" : `${pct}%`}</span>
        </span>`;

  return `
  <section class="funnel-card">
    <div class="section-header">
      <div>
        <span class="section-title">时间流向</span>
        <span class="section-subtitle">一屏看清时间与等待的流向</span>
      </div>
      <span class="funnel-concurrency-pill">${concurrency}x 并发效能倍率</span>
    </div>

    <div class="flow-caption" title="守恒口径：记录总时长 = AI 工作 work_ms + 等待确认 review_wait_ms + 中途停了 idle_gap_ms + 轮间间隔 standby_ms">
      记录总时长 <strong>${fmt(grossTotal)}</strong>（AI 工作 + 等待确认${idle > 0 ? " + 中途停了" : ""} + 轮间间隔）${queueCount > 0 ? ` · 排队输入 ${queueCount} 次` : ""}
    </div>
    <div class="flow-bar" role="img" aria-label="守恒占比：AI 工作 ${workPct}%、等待确认 ${waitPct}%、${idle > 0 ? `中途停了 ${idlePct}%、` : ""}轮间间隔 ${standbyPct}%">
      ${renderFlowSegment(workPct, "var(--state-work)", "AI 工作", "口径：AI 工作 work_ms = 模型想和写 + 本地工具", true)}
      ${renderFlowSegment(waitPct, "var(--state-wait)", h(dimensionTitle("wait")), dimensionHint("wait"))}
      ${idle > 0 ? renderFlowSegment(idlePct, "var(--state-idle-strong, #B3261E)", h(dimensionTitle("idle")), dimensionHint("idle")) : ""}
      ${renderFlowSegment(standbyPct, "var(--state-standby)", h(dimensionTitle("standby")), dimensionHint("standby"))}
    </div>
    <div class="flow-legend">
${legendItem("var(--state-work)", "AI 工作", work, workPct)}
${legendItem("var(--state-wait)", h(dimensionTitle("wait")), wait, waitPct)}
${idle > 0 ? legendItem("var(--state-idle-strong, #B3261E)", h(dimensionTitle("idle")), idle, idlePct) : ""}
${legendItem("var(--state-standby)", h(dimensionTitle("standby")), standby, standbyPct)}
    </div>
  </section>`;
}

// ========================================================
// 模块 2.5：洞察三件套 —— 跨日趋势 / 归因建议 / Markdown 报告导出（#54）
// 数据全部取自现有报表逐轮字段，零后端改动；口径原则不变：
// 只陈述可从页面数字直接推出的结论，证据缺失如实说，不做推测性归因。
// ========================================================

// 本地时区的 YYYY-MM-DD 键（浏览器时区与页面其余展示一致）
const dayKey = (ms) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);

// 周桶以周一为起点，桶键即周一日期串；标签为「MM/DD–MM/DD」
function weekBucket(ms) {
  const key = dayKey(ms);
  const start = new Date(key + "T12:00:00");
  const dow = (start.getDay() + 6) % 7; // 周一=0
  start.setDate(start.getDate() - dow);
  return dayKey(start.getTime());
}

function weekLabel(mondayKey) {
  const start = new Date(mondayKey + "T12:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const md = (d) => d.getMonth() + 1 + "/" + d.getDate();
  return `${md(start)}–${md(end)}`;
}

// 三态贡献与 summary 完全同口径：跨范围裁剪后的 period 等比缩放，
// standby 不缩放；某态缺失的轮不计入该态（绝不记 0 充数）。
function trendBuckets(sessions, gran) {
  const buckets = new Map();
  for (const s of sessions) {
    for (const t of s.turns) {
      const start = t.start_ms ?? t.end_ms ?? null;
      if (start === null) continue;
      const key = gran === "week" ? weekBucket(start) : dayKey(start);
      const b =
        buckets.get(key) ??
        { key, work: 0, wait: 0, idle: 0, standby: 0, turns: 0 };
      b.turns++;
      const period = t.period_ms ?? null;
      const scale = (v) =>
        period !== null && t.elapsed_ms
          ? Math.round((v * period) / t.elapsed_ms)
          : v;
      if (t.work_ms !== null) b.work += scale(t.work_ms);
      if (t.review_wait_ms !== null) b.wait += scale(t.review_wait_ms);
      if (t.breakdown?.idle_gap_ms != null)
        b.idle += scale(t.breakdown.idle_gap_ms);
      if (t.standby_ms !== null) b.standby += t.standby_ms;
      buckets.set(key, b);
    }
  }
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

function trendCard() {
  const sessions = state.report.sessions;
  // 自动粒度：日桶超过 60 根时整排小柱等高、失去信息量，自动切按周；
  // 用户手动点过「按日/按周」（或恢复过持久化选择）后尊重手动选择
  const autoWeek =
    !state.trendGranManual &&
    trendBuckets(sessions, "day").length > 60;
  const gran = autoWeek ? "week" : state.trendGran;
  const buckets = trendBuckets(sessions, gran);
  const exportBtn = `<button class="textbtn" data-action="share-card">生成分享图</button><button class="textbtn" data-action="export-report">导出报告 Markdown</button>`;
  const header = `
      <div class="section-header">
        <div>
          <span class="section-title">跨日趋势</span>
          <span class="section-subtitle">按轮次开始${gran === "week" ? "周" : "日"}归属 · 跨${gran === "week" ? "周" : "日"}轮整体计入起始${gran === "week" ? "周" : "日"} · 柱 = 当${gran === "week" ? "周" : "日"} AI 干活合计 · 柱高按平方根缩放${autoWeek ? " · 已自动按周聚合" : ""}</span>
        </div>
        <div class="trend-toolbar">
          <button class="textbtn${state.trendGran === "day" ? " active" : ""}" data-trend-gran="day" aria-pressed="${state.trendGran === "day"}">按日</button>
          <button class="textbtn${gran === "week" ? " active" : ""}" data-trend-gran="week" aria-pressed="${gran === "week"}">按周</button>
          ${exportBtn}
        </div>
      </div>`;

  if (!buckets.length)
    return `
    <section class="funnel-card">
      ${header}
      <div class="demo" style="margin: 8px 0 0;">
        <strong>暂无趋势</strong>
        <span>本时段的轮次缺少可定位的开始时刻，无法按${gran === "week" ? "周" : "日"}归桶。</span>
      </div>
    </section>`;

  // 单指标：柱高 ∝ 当天 AI 干活（平方根 + 8px 底高），与「一眼看出哪天
  // AI 真在干活」的改版意图一致；间隔/停了只在 hover 明细中体现
  const maxWork = Math.max(...buckets.map((b) => b.work), 1);
  const n = buckets.length;
  // 数值标注：只标干活最久的前 3 个桶（柱多时全标反而成噪音）
  const topDayKeys = new Set(
    [...buckets].sort((a, b) => b.work - a.work).slice(0, 3).map((b) => b.key),
  );
  // 数值标注：柱顶显示当天干活时长。柱少（列宽 ≥26px）时每根都标；
  // 柱多时按等距抽稀防重叠，但 TOP3 峰值永远标注。
  const labelStep = n <= 40 ? 1 : Math.max(1, Math.ceil(n / 40));
  // 柱高用容器百分比：最长柱 = 容器 92%，其余按 √ 相对计算——不留大片
  // 空白，且随容器实际高度自适应。基线由列的 justify-content: flex-end 锚定。
  // 日期标签：按柱数自适应密度（最多约 16 个），与数值标签相互独立
  const dateLabelEvery = n <= 16 ? 1 : Math.ceil(n / 16);
  const bars = buckets
    .map((b, i) => {
      const heightPct =
        b.work > 0 ? (4 + 88 * Math.sqrt(b.work / maxWork)).toFixed(1) : "2";
      const isTop3 = topDayKeys.has(b.key);
      const showVal = (i % labelStep === 0 || isTop3) && b.work > 0;
      const hrs = b.work / 3600000;
      const valText = hrs >= 1 ? `${hrs.toFixed(1)}h` : `${Math.round(b.work / 60000)}m`;
      const valueLabel = showVal ? `<span class="trend-val">${valText}</span>` : "";
      const showLabel = i % dateLabelEvery === 0 || i === n - 1;
      const label = gran === "week" ? weekLabel(b.key) : b.key.slice(5).replace("-", "/");
      return `
      <div class="trend-col">
        ${valueLabel}
        <div class="trend-bar" style="height:${heightPct}%;" title="${h(label)}：AI 干活 ${fmt(b.work)} · ${h(dimensionTitle("idle"))} ${fmt(b.idle || 0)} · ${h(dimensionTitle("standby"))} ${fmt(b.standby)} · ${b.turns} 轮"><div class="trend-w" style="height:100%;"></div></div>
        <span class="trend-day">${showLabel ? h(label) : ""}</span>
      </div>`;
    })
    .join("");

  return `
  <section class="funnel-card">
    ${header}
    <div class="trend-scroll">
      <div class="trend-bars" role="img" aria-label="按${gran === "week" ? "周" : "日"}的 AI 干活趋势柱状图，共 ${n} 个${gran === "week" ? "周" : "日"}桶">${bars}</div>
    </div>
    <div class="flow-legend">
      <span class="flow-legend-item"><i style="background:var(--state-work);"></i>AI 干活（当${gran === "week" ? "周" : "日"}全部轮次合计）</span>
      <span class="flow-legend-item sub">hover 任意柱：停了 / 间隔 / 轮次明细</span>
    </div>
  </section>`;
}

// 归因建议：只输出「从当前页面数字可直接读出」的结论句，上限 4 条；
// 全部证据缺失时如实说无法生成，不编建议。
// 工具聚合：name 必须随累加器一起保留，否则排序后只剩 undefined
// （#57 评审 P2：结论卡与导出曾因此丢工具名）。结论卡与报告导出共用。
function aggregateToolTotals(sessions) {
  const toolMap = new Map();
  for (const sess of sessions)
    for (const t of sess.turns)
      for (const tool of t.breakdown?.tools ?? []) {
        const cur =
          toolMap.get(tool.name) || { name: tool.name, count: 0, durationMs: 0 };
        cur.count += tool.count || 0;
        cur.durationMs += tool.duration_ms || 0;
        toolMap.set(tool.name, cur);
      }
  return [...toolMap.values()].sort((a, b) => b.durationMs - a.durationMs);
}

function adviceCards() {
  const sessions = state.report.sessions;
  const s = state.report.summary;
  const cards = [];

  // 1) 累计执行最久的工具（与「按工具 TOP」同一来源，不截断取全量）
  const tools = aggregateToolTotals(sessions);
  const toolTotal = tools.reduce((acc, t) => acc + t.durationMs, 0);
  if (toolTotal > 0 && tools[0]) {
    const top = tools[0];
    cards.push(
      `<b>${h(toolLabel(top.name))}</b> 是本时段累计执行最久的工具：${top.count} 次 · <b>${fmt(top.durationMs)}</b>（占已测量工具执行 ${((top.durationMs / toolTotal) * 100).toFixed(1)}%）`,
    );
  }

  // 2) 干活最久会话：与 TOP 榜同口径（Σ work_ms），搁置跨度不再冒充耗时
  const topSession = [...sessions]
    .map((x) => ({
      s: x,
      ms: (x.turns || []).reduce((acc, t) => acc + (t.work_ms || 0), 0),
    }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms)[0];
  const workGross = s.work_ms || 0;
  if (topSession && workGross > 0)
    cards.push(
      `<b>${h(topSession.s.title || projectLabel(topSession.s.project) || topSession.s.session_id)}</b> 是本时段干活最久的会话：<b>${fmt(topSession.ms)}</b>（占 AI 工作 ${((topSession.ms / workGross) * 100).toFixed(1)}%）`,
    );

  // 3) 等待确认集中日
  if ((s.review_wait_ms || 0) > 0) {
    const dayBuckets = trendBuckets(sessions, "day");
    const peak = [...dayBuckets].sort((a, b) => b.wait - a.wait)[0];
    if (peak && peak.wait > 0)
      cards.push(
        `${h(peak.key.slice(5).replace("-", "/"))} 是等待确认最集中的一天：<b>${fmt(peak.wait)}</b>（占本时段等待确认 ${((peak.wait / s.review_wait_ms) * 100).toFixed(1)}%）`,
      );
  }

  // 4) 轮间间隔占比（显著时才提示，中性陈述）。
  // 守恒分母：工作 + 等待确认 + 中途停了 + 轮间间隔（gross 定义随
  // topSession 块改写丢失过一次，现显式放在使用点之前）
  const gross =
    (s.work_ms || 0) +
    (s.review_wait_ms || 0) +
    (s.idle_gap_ms || 0) +
    (s.standby_ms || 0);
  if (gross > 0 && (s.standby_ms || 0) / gross >= 0.3)
    cards.push(
      `${h(dimensionTitle("standby"))}占记录总时长 <b>${((s.standby_ms / gross) * 100).toFixed(1)}%</b>（${fmt(s.standby_ms)}）：主要是你自己的时间（阅读、离开、睡觉），AI 零消耗`,
    );

  const body = cards.length
    ? cards.map((c) => `<div class="advice-card">${c}</div>`).join("")
    : `<div class="advice-card">本时段没有可测量的细分数据，暂无法生成结论。</div>`;
  return `
  <section class="funnel-card" aria-label="本时段结论">
    <div class="section-header">
      <div>
        <span class="section-title">本时段结论</span>
        <span class="section-subtitle">仅陈述可从页面数字直接推出的观察 · 不做推测性归因</span>
      </div>
    </div>
    ${body}
  </section>`;
}

// Markdown 报告导出：与 CSV 同为本地 Blob 下载，零上传；
// 只汇总当前所选区间（与页面同源同口径），无数据的段落如实省略。
function exportWeeklyReport() {
  const s = state.report.summary;
  const sessions = state.report.sessions;
  const lines = [];
  lines.push(`## AgentTime 时间报告（${state.start} ~ ${state.end}）`);
  lines.push("");
  const gross = (s.work_ms || 0) + (s.review_wait_ms || 0) + (s.standby_ms || 0);
  if (gross > 0) {
    const pct = (v) => ((v / gross) * 100).toFixed(1) + "%";
    lines.push(
      `**记录总时长** ${fmt(gross)} ｜ **AI 工作** ${fmt(s.work_ms)}（${pct(s.work_ms || 0)}）｜ **${dimensionTitle("wait")}** ${fmt(s.review_wait_ms)} ｜ **${dimensionTitle("standby")}** ${fmt(s.standby_ms)}`,
    );
    lines.push(`（口径：记录总时长 = AI 工作 + 等待确认${(s.idle_gap_ms || 0) > 0 ? " + 中途停了" : ""} + 轮间间隔）`);
    lines.push("");
  } else {
    lines.push("本时段没有可测量的三态耗时数据。");
    lines.push("");
  }
  const top = [...sessions]
    .map((x) => ({
      s: x,
      ms: (x.turns || []).reduce((acc, t) => acc + (t.work_ms || 0), 0),
    }))
    .filter((x) => x.ms > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 3);
  if (top.length) {
    lines.push("**干活 TOP 3 会话**（AI 工作 work_ms 合计口径）");
    top.forEach((x, i) =>
      lines.push(
        `${i + 1}. ${x.s.title || x.s.project || x.s.session_id} · ${x.s.agent} · ${fmt(x.ms)}`,
      ),
    );
    lines.push("");
  }
  const tools = aggregateToolTotals(sessions);
  if (tools.length)
    lines.push(
      `**累计执行最久工具**：${tools[0].name}（${tools[0].count} 次 · ${fmt(tools[0].durationMs)}；仅统计有细分数据的来源）`,
    );
  const dayBuckets = trendBuckets(sessions, "day").filter(
    (b) => b.work + b.wait + b.standby > 0,
  );
  if (dayBuckets.length) {
    const peak = [...dayBuckets].sort(
      (a, b) => b.work + b.wait + b.standby - (a.work + a.wait + a.standby),
    )[0];
    lines.push(
      `**趋势峰值**：${peak.key}（AI 工作 ${fmt(peak.work)} / 记录总时长 ${fmt(peak.work + peak.wait + peak.standby)}）`,
    );
  }
  lines.push("");
  lines.push(`生成于 AgentTime 本地数据 · 仅含所选区间 · 无遥测`);
  const blob = new Blob([lines.join("\n")], {
    type: "text/markdown;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `agenttime-report-${state.start}-to-${state.end}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let lastShareCardUrl = "";

function renderShareCardDataUrl() {
  const r = state.report;
  const s = r.summary;
  const sessions = r.sessions || [];
  const L = window.getShareCardLabels?.() || {
    brandSub: "本地 AI Coding 时间账本 · 零上传",
    title: "本时段 Agent 时间账单",
    work: "AI 工作",
    wait: "等待确认",
    idle: "中途停了",
    standby: "轮间间隔",
    autonomy: "自动完成度",
    sessions: "统计会话",
    turns: "已测轮次",
    topAgents: "工具分布",
    unknown: "暂无数据",
    footer: "npx @ccclucky/agent-time",
  };
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 675;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";

  const work = s.work_ms || 0;
  const wait = s.review_wait_ms || 0;
  const idle = s.idle_gap_ms || 0;
  const standby = s.standby_ms || 0;
  const denom = work + wait + idle + standby || 1;
  const autoDenom = work + wait;
  const autonomyPct =
    s.work_ms !== null && s.review_wait_ms !== null && autoDenom > 0
      ? `${((work / autoDenom) * 100).toFixed(1)}%`
      : L.unknown;

  // Paper & Ink card canvas
  ctx.fillStyle = "#FAF9F5";
  ctx.fillRect(0, 0, 1200, 675);
  ctx.fillStyle = "#FFFFFF";
  ctx.strokeStyle = "#E5E0D8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(36, 36, 1128, 603, 18);
  ctx.fill();
  ctx.stroke();

  // Accent left mark & header
  ctx.fillStyle = "#CC785C";
  ctx.fillRect(72, 74, 8, 42);
  ctx.fillStyle = "#1F1E1D";
  ctx.font = '800 28px Inter, "PingFang SC", sans-serif';
  ctx.fillText("AgentTime", 94, 100);
  ctx.fillStyle = "#827C75";
  ctx.font = '500 15px Inter, "PingFang SC", sans-serif';
  ctx.fillText(L.brandSub, 94, 122);

  ctx.textAlign = "right";
  ctx.fillStyle = "#494541";
  ctx.font = '600 16px "JetBrains Mono", monospace';
  ctx.fillText(`${r.range.start} — ${r.range.end}`, 1124, 96);
  ctx.fillStyle = "#827C75";
  ctx.font = '500 13px "JetBrains Mono", monospace';
  ctx.fillText(r.range.timezone, 1124, 118);
  ctx.textAlign = "left";

  // Divider
  ctx.strokeStyle = "#F0EAE1";
  ctx.beginPath();
  ctx.moveTo(72, 148);
  ctx.lineTo(1128, 148);
  ctx.stroke();

  ctx.fillStyle = "#827C75";
  ctx.font = '600 14px Inter, "PingFang SC", sans-serif';
  ctx.fillText(L.title, 72, 182);

  // 4 Hero KPIs
  const kpis = [
    [L.work, s.work_ms !== null ? fmt(s.work_ms) : L.unknown, "#CC785C"],
    [L.wait, s.review_wait_ms !== null ? fmt(s.review_wait_ms) : L.unknown, "#C68A4C"],
    [L.autonomy, autonomyPct, "#1F1E1D"],
    [`${L.sessions} / ${L.turns}`, `${s.sessions} / ${s.measured_turns}`, "#5E7A8B"],
  ];
  kpis.forEach(([label, val, color], idx) => {
    const x = 72 + idx * 268;
    ctx.fillStyle = "#FAF9F5";
    ctx.strokeStyle = "#E5E0D8";
    ctx.beginPath();
    ctx.roundRect(x, 202, 248, 116, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#827C75";
    ctx.font = '600 13px Inter, "PingFang SC", sans-serif';
    ctx.fillText(label, x + 18, 232);
    ctx.fillStyle = color;
    ctx.font = '800 30px "JetBrains Mono", monospace';
    ctx.fillText(val, x + 18, 282);
  });

  // Conservation partitioned bar
  const segs = [
    [L.work, work, "#CC785C"],
    [L.wait, wait, "#C68A4C"],
    [L.idle, idle, "#5E7A8B"],
    [L.standby, standby, "#7A7268"],
  ];
  let bx = 72;
  const barW = 1056;
  ctx.fillStyle = "#F5F2EB";
  ctx.beginPath();
  ctx.roundRect(72, 352, barW, 38, 8);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(72, 352, barW, 38, 8);
  ctx.clip();
  segs.forEach(([, ms, color]) => {
    if (ms <= 0) return;
    const w = (ms / denom) * barW;
    ctx.fillStyle = color;
    ctx.fillRect(bx, 352, w, 38);
    bx += w;
  });
  ctx.restore();

  // Legend row
  let lx = 72;
  segs.forEach(([label, ms, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, 412, 12, 12);
    ctx.fillStyle = "#494541";
    ctx.font = '600 14px Inter, "PingFang SC", sans-serif';
    const pct = ((ms / denom) * 100).toFixed(0);
    const txt = `${label} ${fmt(ms)} (${pct}%)`;
    ctx.fillText(txt, lx + 20, 423);
    lx += Math.max(220, ctx.measureText(txt).width + 54);
  });

  // Top agents (aggregate only — zero project names or prompts)
  const byAgent = new Map();
  for (const sess of sessions) {
    const cur = byAgent.get(sess.agent) || { name: sess.agent, ms: 0, count: 0 };
    cur.ms += sess.period_ms || 0;
    cur.count += 1;
    byAgent.set(sess.agent, cur);
  }
  const top = [...byAgent.values()].sort((a, b) => b.ms - a.ms).slice(0, 4);
  ctx.fillStyle = "#827C75";
  ctx.font = '600 13px Inter, "PingFang SC", sans-serif';
  ctx.fillText(L.topAgents, 72, 476);
  top.forEach((ag, i) => {
    const x = 72 + i * 268;
    ctx.fillStyle = "#F5F2EB";
    ctx.beginPath();
    ctx.roundRect(x, 492, 248, 66, 10);
    ctx.fill();
    ctx.fillStyle = "#1F1E1D";
    ctx.font = '700 15px Inter, sans-serif';
    ctx.fillText(ag.name, x + 16, 520);
    ctx.fillStyle = "#827C75";
    ctx.font = '500 13px "JetBrains Mono", monospace';
    ctx.fillText(`${fmt(ag.ms)} · ${ag.count}`, x + 16, 543);
  });

  // Footer
  ctx.fillStyle = "#827C75";
  ctx.font = '600 14px "JetBrains Mono", monospace';
  ctx.fillText(L.footer, 72, 608);
  ctx.textAlign = "right";
  ctx.fillText("github.com/ccclucky/agent-time", 1124, 608);
  ctx.textAlign = "left";

  return canvas.toDataURL("image/png");
}

function openShareCardModal() {
  if (!state.report?.summary?.sessions) {
    toast("当前时间范围暂无可生成分享图的记录。");
    return;
  }
  lastShareCardUrl = renderShareCardDataUrl();
  if (!lastShareCardUrl) return;
  open(
    `${head("分享时间账单卡片", "已自动隐藏项目名、提问原文与本地路径，仅包含汇总统计。")}
     <div style="margin:14px 0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--bg-card-muted);">
       <img src="${lastShareCardUrl}" alt="AgentTime Summary Card" style="display:block; width:100%; height:auto;" />
     </div>
     <div style="display:flex; gap:10px; justify-content:flex-end;">
       <button class="btn" data-action="copy-share-card">复制图片</button>
       <button class="btn primary" data-action="download-share-card">下载 PNG</button>
     </div>`,
    true,
  );
}

// ========================================================
// 模块 3：全景时间轴与无级拖拽视口滑块
// 设计意图：按三态整段着色（工作 / 等待确认 / 待命），避免同一维度
// 被拆成难以辨认的碎片；视口会话聚合数学由 computeTimelineModel() 抽出，
// 供首页双列组合榜（TOP 3 榜 + 视口操作分布）复用
// ========================================================
function computeTimelineModel() {
  const sessions = state.report.sessions || [];

  const allTurns = [];
  for (const s of sessions) {
    for (let i = 0; i < s.turns.length; i++) {
      allTurns.push({
        session: s,
        turn: s.turns[i],
        turnIndex: i + 1,
      });
    }
  }

  // 严格按真实时间戳线性排序
  allTurns.sort((a, b) => (a.turn.start_ms || 0) - (b.turn.start_ms || 0));

  const totalTurns = allTurns.length;

  if (!state.zoomInitialized) {
    state.zoomStartPct = 0;
    state.zoomEndPct = 100;
    state.zoomInitialized = true;
  }

  const firstTurn = allTurns[0]?.turn;
  const lastTurn = allTurns[allTurns.length - 1]?.turn;
  const minTime = firstTurn
    ? firstTurn.start_ms || firstTurn.end_ms || Date.now()
    : Date.now();
  const maxTime = lastTurn
    ? lastTurn.end_ms || lastTurn.start_ms || minTime + 1000
    : minTime + 1000;
  const totalTimelineSpan = Math.max(1, maxTime - minTime);

  // 方案 A：以会话为一级主体聚合（按首次活动时间排序——全景柱按此序均匀排列）
  const sessionSummaries = sessions.map((s) => {
    let sWork = 0;
    let sWait = 0;
    let sStandby = 0;
    let sMinTime = Infinity;
    let sMaxTime = 0;

    for (const t of s.turns) {
      sWork += t.work_ms || 0;
      sWait += t.review_wait_ms || 0;
      sStandby += t.standby_ms || 0;
      const st = t.start_ms || t.end_ms;
      const en = t.end_ms || t.start_ms;
      if (st && st < sMinTime) sMinTime = st;
      if (en && en > sMaxTime) sMaxTime = en;
    }
    if (sMinTime === Infinity) sMinTime = minTime;
    if (sMaxTime === 0) sMaxTime = maxTime;

    const sSum = sWork + sWait + sStandby;
    return {
      session: s,
      work: sWork,
      wait: sWait,
      standby: sStandby,
      total: sSum,
      minTime: sMinTime,
      maxTime: sMaxTime,
      turnsCount: s.turns.length,
    };
  });

  // 排序后再按会话序号区间过滤（滑块拖动 % → 序号区间），柱序与时间序一致
  sessionSummaries.sort((a, b) => a.minTime - b.minTime);
  const startIdx = Math.floor((state.zoomStartPct / 100) * sessionSummaries.length);
  const endIdx = Math.ceil((state.zoomEndPct / 100) * sessionSummaries.length);
  const visibleSessions = sessionSummaries.slice(startIdx, endIdx);

  return {
    sessions,
    allTurns,
    totalTurns,
    minTime,
    maxTime,
    totalTimelineSpan,
    sessionSummaries,
    visibleSessions,
    startIdx,
    endIdx,
  };
}

function timeline(model) {
  const { sessionSummaries, visibleSessions, totalTurns } = model;
  if (!sessionSummaries.length) return "";

  // 每会话一柱（与效果预览一致）：只画有干活数据的会话，均匀排列，
  // 高度 ∝ √干活；hover 显示会话名 / 工具 / 干活 / 跨度 / 轮数。
  const withWork = sessionSummaries.filter((item) => item.work > 0);
  const maxWork = Math.max(1, ...withWork.map((x) => x.work));
  const visibleSet = new Set(visibleSessions.map((item) => item.session.id));

  const bars = withWork
    .map((item) => {
      const hPct = Math.max(4, Math.round(Math.pow(item.work / maxWork, 0.42) * 100));
      const t = item.session;
      const f = item.minTime ? stamp(item.minTime).slice(0, 11) : "";
      const l = item.maxTime ? stamp(item.maxTime).slice(0, 11) : "";
      const span = f && l && f !== l ? `${f} → ${l}` : f;
      const inView = visibleSet.has(t.id);
      return `
        <div class="brush-bucket-col" title="${h(t.title || projectLabel(t.project))} · ${h(t.agent)} · 干活 ${fmt(item.work)} · 跨度 ${h(span)} · ${item.turnsCount} 轮">
          <div class="brush-bucket-bar ${inView ? "in-viewport" : "out-viewport"}" style="height:${hPct}%; background:var(--state-work);"></div>
        </div>
      `;
    })
    .join("");

  const first = withWork[0];
  const last = withWork.at(-1);
  const fLabel = first && first.minTime ? stamp(first.minTime) : "";
  const lLabel = last && last.maxTime ? stamp(last.maxTime) : "";

  return `
  <section class="timeline-card">
    <div class="section-header">
      <div>
        <span class="section-title">每个会话干了多久</span>
        <span class="section-subtitle">柱 = 一个会话的干活合计 · 高度 ∝ √干活 · hover 看会话名与跨度</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${(state.zoomStartPct > 0 || state.zoomEndPct < 100) ? `
          <button class="filter-chip js-reset-zoom" style="padding: 2px 8px; font-size: var(--text-xs);">重置查看全部</button>
        ` : ""}
        <span class="brush-scope-pill" id="brushScopeText">展示 ${visibleSessions.length} 个会话（共 ${sessionSummaries.length} 个，${totalTurns} 轮交互）</span>
      </div>
    </div>

    <div class="brush-section">
      <div class="brush-strip-track" id="brushTrack">
        ${bars}
        <div class="brush-viewport" id="brushViewport" style="left: ${state.zoomStartPct}%; width: ${Math.max(6, state.zoomEndPct - state.zoomStartPct)}%;">
          <div class="brush-handle-bar" data-handle="left" title="向左拖拽缩小会话范围"></div>
          <div class="brush-handle-bar" data-handle="right" title="向右拖拽扩大会话范围"></div>
        </div>
      </div>
      <div class="brush-ticks">
        <span>${h(fLabel)}</span>
        <span>${h(fLabel && lLabel && fLabel !== lLabel ? fLabel + " ~ " + lLabel : "")}</span>
        <span>${h(lLabel)}</span>
      </div>
    </div>
  </section>`;
}

// ========================================================
// 方案 A 替换模块 1：双列组合榜
// 左：会话耗时 TOP 3 榜 · 右：当前视口操作与耗时分布
// 聚合口径：仅统计当前热力图视口（zoomStartPct..zoomEndPct）内可见的会话
// ========================================================
// 本期分摊口径：period_ms 是逐轮"裁剪到统计日期范围"的时长相加
// （/api/report 对越界轮次做裁剪）。命名必须暴露"裁剪分摊"语义，
// 与详情页的首末轮次首尾跨度（sessionWallSpan）严格区分，不得混用。
function sessionClippedPeriodMs(s) {
  return s.measured_turns ? s.period_ms || 0 : 0;
}

function zoomedViewport() {
  return state.zoomStartPct > 0 || state.zoomEndPct < 100;
}

function topSessionsCard(model) {
  // 主数字 = AI 干活（守恒口径）：跨天搁置跨度不再污染 TOP 榜；
  // 墙钟跨度降级为副行（omp 那种 1250h 会显示「干活 74m · 跨度 52 天」）
  const top = model.visibleSessions
    .map((item) => item.session)
    .map((s) => ({
      s,
      work: (s.turns || []).reduce((acc, t) => acc + (t.work_ms || 0), 0),
      span: sessionWallSpan(s).wallMs || 0,
    }))
    .filter((x) => x.work > 0)
    .sort((a, b) => b.work - a.work)
    .slice(0, 3);

  const rows = top
    .map(({ s, work, span }, idx) => {
      const spanDays = span >= 48 * 3600000 ? ` · 搁置 ${Math.round(span / 86400000)} 天` : "";
      const pName = projectLabel(s.project);
      return `
        <div class="rank-mini-item" data-open-session="${h(s.id)}" role="button" tabindex="0" aria-label="进入会话详情页：${h(s.title || pName)}">
          <span class="rank-num">${String(idx + 1).padStart(2, "0")}</span>
          <div class="rank-main">
            <span class="rank-title">${h(s.title || pName)}</span>
            <span class="rank-subline">${agentMark(s.agent)}<span class="rank-subline-text" title="${h(projectHint(s.project))}">${h(pName)} · 干活 ${fmt(work)}${spanDays ? " · 跨度 " + fmt(span) + spanDays : ""}</span></span>
          </div>
          <span class="rank-duration">${fmt(work)}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div class="s1-box">
      <div class="s1-title">会话干活 TOP 3 榜（当前视口）</div>
      ${rows || `
        <div class="s1-empty">
          当前视口内没有已测量耗时的会话${zoomedViewport() ? "，可点击" : ""}
          ${zoomedViewport() ? '<button class="filter-chip js-reset-zoom" style="margin-left: 6px; padding: 2px 8px; font-size: var(--text-xs);">重置查看全部</button>' : "。"}
        </div>
      `}
    </div>
  `;
}

// 五维配置（维度键 + 短标签 + 分段色 + 口径提示）的唯一真理源：
// 首页视口分段条、详情页明细行、轮次胶囊条与会话流迷你条均直接别名或派生自此表，
// 杜绝同一维度在多个视图漂移出两种颜色或两种写法。
// 中途停了 = 轮内 ≥2 分钟无任何源事件的区间（守恒口径，仅 Antigravity 启用）：
// 可能装着网络阻塞、设备休眠、忙上一条——源记录不写原因，只给时长不编造归因。
const BREAKDOWN_DIMENSIONS = [
  {
    key: "tool",
    label: "本地工具",
    color: "var(--color-mcp)",
    hint: "本地工具 tool execution = 工具调用执行耗时（Bash / Edit 等）",
  },
  {
    key: "model",
    label: "模型想和写",
    color: "var(--color-system)",
    hint: "模型想和写 model_ms = 模型响应耗时（含思考与输出，源记录整条落盘不可再分）",
  },
  {
    key: "wait",
    label: "等待确认",
    color: "var(--color-skills)",
    hint: "等待确认 review_wait_ms = 工具授权与方案确认的挂起时长",
  },
  {
    key: "idle",
    label: "中途停了",
    color: "var(--state-idle-strong, #B3261E)",
    hint: "中途停了 idle_gap_ms = 轮内 ≥2 分钟无任何源事件（网络阻塞、设备休眠、忙上一条等，原因不明不编造）",
  },
  {
    key: "standby",
    label: "轮间间隔",
    color: "var(--state-standby)",
    hint: "轮间间隔 standby_ms = 上轮答复完毕至下一条发出（你的时间，AI 零消耗）",
  },
];

const breakdownDimension = (key) =>
  BREAKDOWN_DIMENSIONS.find((d) => d.key === key);
const dimensionTitle = (key) => breakdownDimension(key)?.label ?? "";
const dimensionHint = (key) => {
  const d = breakdownDimension(key);
  return d ? `口径：${d.hint}` : "";
};

// 五维耗时累加器（键序与 BREAKDOWN_DIMENSIONS 一致）：
// Codex 会话 breakdown 为 null，天然按 0 贡献并优雅降级
function addTurnBreakdown(agg, t) {
  agg.tool += t.breakdown?.tool_execution_ms ?? 0;
  agg.model += t.breakdown?.model_api_ms ?? 0;
  agg.wait += t.review_wait_ms ?? 0;
  agg.idle += t.breakdown?.idle_gap_ms ?? 0;
  agg.standby += t.standby_ms ?? 0;
}

function sumBreakdown(agg) {
  return {
    ...agg,
    total: agg.tool + agg.model + agg.wait + (agg.idle || 0) + agg.standby,
  };
}

// 多维操作分段条（首页视口图例）的四个维度：直接别名唯一真理源，
// 渲染处只负责布局与百分比，不再复制一份用户可见长文案
const VIEWPORT_SEGMENTS = BREAKDOWN_DIMENSIONS;

function aggregateViewportBreakdown(visibleSessions) {
  const agg = { tool: 0, model: 0, wait: 0, idle: 0, standby: 0 };
  for (const item of visibleSessions) {
    for (const t of item.session.turns) {
      addTurnBreakdown(agg, t);
    }
  }
  return sumBreakdown(agg);
}

function viewportBreakdownCard(model) {
  const agg = aggregateViewportBreakdown(model.visibleSessions);
  const total = agg.total;

  const segHtml =
    total > 0
      ? VIEWPORT_SEGMENTS.map((seg) => {
          const pct = (agg[seg.key] / total) * 100;
          return pct > 0
            ? `<div style="width:${pct.toFixed(1)}%; background:${seg.color};" title="口径：${h(seg.hint)} · ${pct.toFixed(1)}%"></div>`
            : "";
        }).join("")
      : "";

  const legendHtml = VIEWPORT_SEGMENTS.map((seg) => {
    const ms = agg[seg.key];
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0.0";
    return `
      <div class="seg-legend-row">
        <span class="seg-legend-label" title="口径：${h(seg.hint)}">
          <span class="seg-legend-swatch" style="background:${seg.color};"></span>
          ${h(seg.label)}
        </span>
        <span class="seg-legend-val">${ms > 0 ? fmt(ms) : "—"} · <strong>${pct}%</strong></span>
      </div>
    `;
  }).join("");

  return `
    <div class="s1-box">
      <div class="s1-title">当前视口操作与耗时分布（${model.visibleSessions.length} 个会话）</div>
      ${total > 0 ? `
        <div class="multi-seg-bar">${segHtml}</div>
        <div class="seg-legend">${legendHtml}</div>
      ` : `
        <div class="s1-empty">
          当前视口内的会话暂无细分数据（Codex 会话不提供细分数据）${zoomedViewport() ? "，可点击" : ""}
          ${zoomedViewport() ? '<button class="filter-chip js-reset-zoom" style="margin-left: 6px; padding: 2px 8px; font-size: var(--text-xs);">重置查看全部</button>' : "。"}
        </div>
      `}
    </div>
  `;
}

// ========================================================
// 首页维度聚合统计（反馈轮 3 Fix 3）：用户要的是聚合、统计，不是过滤。
// 与双列榜共用 scopedModel.visibleSessions（当前视口 + 接入工具筛选同口径），
// 在筛选芯片之外叠加三个只读聚合维度：按接入工具 / 按项目 TOP 5 / 按工具 TOP 5。
// 纯聚合数学在上方 PURE HELPERS 块（aggregateSessionsByAgent 等）单测覆盖。
// ========================================================
// 线性占比条：数值就在条旁，直接线性即可；fill 保底 2% 防极小份额不可见
function aggShareBar(pct, color, label) {
  const w = Math.max(2, Math.min(100, pct));
  return `<div class="agg-share-bar" role="img" aria-label="${h(label)} ${pct.toFixed(1)}%"><div class="agg-share-fill" style="width:${w.toFixed(1)}%; background:${color};"></div></div>`;
}

function viewportAggregationCard(model) {
  const sessions = model.visibleSessions.map((i) => i.session);
  const byAgent = aggregateSessionsByAgent(sessions);
  const byProject = aggregateSessionsByProject(sessions);
  const byTool = aggregateTurnsByTool(sessions);

  const agentRows = byAgent.rows
    .map((r) => {
      const pct =
        byAgent.totalWallMs > 0 ? (r.wallMs / byAgent.totalWallMs) * 100 : 0;
      return `
      <div class="agg-row">
        <div class="agg-row-top">
          <span class="agg-agent">${agentMark(r.agent)}<span class="agg-agent-name">${h(r.agent)}</span></span>
          <span class="agg-nums">${r.sessions} 会话 · ${r.turns} 轮 · <strong>${fmt(r.wallMs)}</strong></span>
        </div>
        ${aggShareBar(pct, "var(--state-work)", `${r.agent} 的总时长占比`)}
      </div>
    `;
    })
    .join("");

  const projectRows =
    byProject.top
      .map((r) => {
        const pct =
          byProject.totalWallMs > 0 ? (r.wallMs / byProject.totalWallMs) * 100 : 0;
        const pName = projectLabel(r.project);
        return `
      <div class="agg-row">
        <div class="agg-row-top">
          <span class="agg-agent"><span class="agg-agent-name" title="${h(projectHint(r.project))}">${h(pName)}</span></span>
          <span class="agg-nums">${r.sessions} 会话 · <strong>${fmt(r.wallMs)}</strong></span>
        </div>
        ${aggShareBar(pct, "var(--state-work)", `${pName} 的总时长占比`)}
      </div>
    `;
      })
      .join("") +
    (byProject.restCount > 0
      ? `<div class="agg-tail">等 ${byProject.restCount} 个项目</div>`
      : "");

  const maxToolMs = byTool.top[0]?.durationMs || 0;
  const toolRows = byTool.top
    .map((r) => {
      const pct = maxToolMs > 0 ? (r.durationMs / maxToolMs) * 100 : 0;
      return `
      <div class="agg-row">
        <div class="agg-row-top">
          <span class="agg-agent"><span class="agg-agent-name" title="${h(r.name)}">${h(toolLabel(r.name))}</span></span>
          <span class="agg-nums">${r.count} 次 · <strong>${fmt(r.durationMs)}</strong></span>
        </div>
        ${aggShareBar(pct, "var(--color-mcp)", `${toolLabel(r.name)} 的累计执行耗时占比`)}
      </div>
    `;
    })
    .join("");

  const emptyRow =
    '<div class="s1-empty">当前视口内没有可聚合的会话。</div>';

  return `
    <div class="agg-grid" aria-label="维度聚合统计（当前视口）">
      <div class="s1-box">
        <div class="s1-title">按接入工具（会话 · 轮次 · 总时长 · 当前视口）</div>
        ${agentRows || emptyRow}
      </div>
      <div class="s1-box">
        <div class="s1-title">按项目 TOP 5（总时长 · 当前视口）</div>
        ${projectRows || emptyRow}
      </div>
      <div class="s1-box">
        <div class="s1-title">按工具 TOP 5（累计执行耗时）</div>
        <div class="agg-basis">基于已有细分数据的 ${byTool.basisSessions} 个会话 · 未测量来源不计入</div>
        ${toolRows || `<div class="s1-empty">当前视口内没有已测量细分数据的会话（Codex 会话不提供细分数据）。</div>`}
      </div>
    </div>
  `;
}

// ========================================================
// 方案 A 替换模块 2：纯会话流列表
// 首页最小原子是会话，绝不在首页平铺每一轮次；
// 点击卡片写入 #session/:id 哈希，独立详情页由后续切片落地
// ========================================================
// 迷你条：以列表内最长会话为基准的相对时长占比条，
// 分段色沿用 BREAKDOWN_DIMENSIONS 四维令牌，与首页/详情页同一套颜色；
// 无细分数据的来源（Codex）诚实退化为单色待命条
function streamMiniBarHtml(s, maxDuration) {
  const duration = sessionClippedPeriodMs(s);
  if (!duration || !(maxDuration > 0)) return "";
  const b = sessionBreakdown(s);
  const fill =
    b.total > 0
      ? BREAKDOWN_DIMENSIONS.filter((d) => b[d.key] > 0)
          .map(
            (d) =>
              `<div style="width:${((b[d.key] / b.total) * 100).toFixed(1)}%; background:${d.color};" title="${d.label}: ${fmt(b[d.key])}"></div>`,
          )
          .join("")
      : `<div style="width:100%; background:var(--state-standby);" title="该会话无细分耗时数据（来源不提供细分数据）"></div>`;
  // 最短可见宽度 2%：避免极短会话被压成不可感知的 0px 细线
  const widthPct = Math.max(2, (duration / maxDuration) * 100);
  return `
    <div class="stream-mini-bar" role="img" aria-label="相对最长会话的耗时迷你条">
      <div class="stream-mini-bar-fill" style="width:${widthPct.toFixed(1)}%;">${fill}</div>
    </div>`;
}

// ========================================================
// 接入工具筛选（Fix：首页展示的内容不知道来自哪个接入工具）
// 只列出当前报告中实际存在的 agent；筛选收窄会话流、TOP 3 榜与
// 视口操作分布聚合（在 sessionSummaries 进入视口聚合前过滤），
// 热力图与视口拖拽逻辑保持全量口径不受影响
// ========================================================
function availableAgents() {
  const present = [...new Set((state.report.sessions || []).map((s) => s.agent))];
  const order = ["Codex", "Claude Code", "Pi"];
  return [
    ...order.filter((a) => present.includes(a)),
    ...present.filter((a) => !order.includes(a)),
  ];
}

function effectiveOverviewAgent() {
  const agents = availableAgents();
  return agents.includes(state.overviewAgent) ? state.overviewAgent : "all";
}

function agentFilterChips() {
  const agents = availableAgents();
  // 单一接入来源时"全部 / 唯一来源"两枚芯片是噪音，直接省略
  if (agents.length < 2) return "";
  const active = effectiveOverviewAgent();
  const chip = (key, html) =>
    `<button class="filter-chip agent-chip${active === key ? " active" : ""}" data-agent-chip="${h(key)}" aria-pressed="${active === key}">${html}</button>`;
  return `
    <div class="agent-filter-row" role="group" aria-label="按接入工具筛选">
      ${chip("all", "全部")}
      ${agents.map((a) => chip(a, `${agentMark(a)}<span>${h(a)}</span>`)).join("")}
    </div>
  `;
}

function sessionStream() {
  const agent = effectiveOverviewAgent();
  const rows = (state.report.sessions || [])
    .filter((s) => agent === "all" || s.agent === agent)
    .slice()
    .sort((a, b) => sessionClippedPeriodMs(b) - sessionClippedPeriodMs(a));
  const maxDuration = Math.max(0, ...rows.map(sessionClippedPeriodMs));

  return `
    ${agentFilterChips()}
    <div class="session-stream-head">
      <h3>全部会话流 (点击任一卡片跳转至独立详情页)</h3>
      <span class="sub">共 ${rows.length} 个会话${agent !== "all" ? ` · ${h(agent)}` : ""}</span>
    </div>
    ${rows
      .map((s) => {
        const pName = projectLabel(s.project);
        return `
      <div class="session-stream-card" data-open-session="${h(s.id)}" role="button" tabindex="0" aria-label="进入会话详情页：${h(s.title || pName)}">
        <div class="stream-left">
          ${agentMark(s.agent)}
          <span class="stream-project-pill" title="${h(projectHint(s.project))}">${h(pName)}</span>
          <strong class="stream-title">${h(s.title || pName)}</strong>
          <span class="stream-turns-pill">${s.turns.length} 轮交互</span>
        </div>
        <div class="stream-right">
          <span class="stream-duration" title="口径：AI 干活 = 全部轮次 work_ms 合计">${fmt((s.turns || []).reduce((acc, t) => acc + (t.work_ms || 0), 0) || null)}</span>
          <span class="stream-enter-chip">进入会话详情页 →</span>
        </div>
        ${streamMiniBarHtml(s, maxDuration)}
      </div>
    `;
      })
      .join("")}
    ${
      rows.length
        ? ""
        : `<div class="s1-empty">当前筛选的接入工具在此时间范围内没有会话，点击上方"全部"恢复完整列表。</div>`
    }
  `;
}

// ========================================================
// 切片 2：独立会话详情页与路由联动 (#session/:id)
// 数据全部客户端聚合自 state.report.sessions（轮次与事件已内嵌），
// 本切片不做任何后端改动；轮次时序流胶囊区为切片 3 预留。
// ========================================================

// 会话 id 形如 claude/<uuid>，卡片写入时已 encodeURIComponent，
// 解析时必须 decode 还原完整 id
function parseSessionHash() {
  const hash = location.hash || "";
  if (!hash.startsWith("#session/")) return null;
  const raw = hash.slice("#session/".length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// hashchange 与首屏引导共用：解析 #session/:id 切换视图状态
function applyRoute() {
  const id = parseSessionHash();
  if (id) {
    state.activeSessionId = id;
    state.page = "session";
  } else if (state.page === "session") {
    state.page = "overview";
    state.activeSessionId = null;
  }
  render();
  if (state.page === "session") window.scrollTo(0, 0);
}

// “← 返回总览”：清掉哈希并恢复首页组合视图
function goOverview() {
  if (parseSessionHash()) {
    history.pushState(null, "", location.pathname + location.search);
  }
  state.page = "overview";
  state.activeSessionId = null;
  render();
  window.scrollTo(0, 0);
}

function detailSession() {
  return (
    (state.report?.sessions || []).find((s) => s.id === state.activeSessionId) ||
    null
  );
}

// 深链会话可能不在 /api/report 的裁剪日期范围内：显式兜底而非崩溃
function sessionDetailFallback() {
  return `
    <section class="panel empty">
      <h2>该会话不在当前统计日期范围内</h2>
      <p class="sub">统计快照只包含 ${h(state.start)} — ${h(state.end)} 内的会话记录。请放宽日期范围后重试，或返回总览。</p>
      <div style="display:flex; gap:10px; justify-content:center; margin-top:14px;">
        <button class="btn" data-range="month">放宽至近 30 天</button>
        <button class="btn primary" data-action="back-overview">← 返回总览</button>
      </div>
    </section>`;
}

// 会话状态 pill：后端只有逐轮状态，这里按轮聚合
function sessionStatus(s) {
  const total = s.turns.length;
  if (!total) return { label: "暂无轮次记录", cls: "" };
  const done = s.turns.filter((t) => t.status === "completed").length;
  if (done === total) return { label: "已完结", cls: "ok" };
  return { label: `存在未完结轮次（${done}/${total} 轮完结）`, cls: "warn" };
}

// 会话专属五维聚合：本地工具 / 模型想和写 / 等待确认 / 中途停了 / 轮间间隔
// （sessionWallSpan 已并入上方 PURE HELPERS 纯函数块）
function sessionBreakdown(s) {
  const agg = { tool: 0, model: 0, wait: 0, idle: 0, standby: 0 };
  for (const t of s.turns) {
    addTurnBreakdown(agg, t);
  }
  return sumBreakdown(agg);
}

// ==== PURE HELPERS BEGIN ====
// 零浏览器依赖的纯函数块（tests/slice9_feedback_round3.test.ts 通过 node:vm
// 整块提取执行本块做行为级单测）：工具友好名、逐次工具耗时配对、
// 抽屉总账回填 (resolveRollup / rollupEvidenceNote) 与首页维度聚合
// (aggregateSessionsByAgent / aggregateSessionsByProject / aggregateTurnsByTool)。
// 在本块内新增逻辑时必须保持纯函数语义 —— 不碰 DOM、不读 state、不引用 window。

// Codex 内建工具的友好显示名（仅展示名；原始 id 保留在 title / 明细行中）。
const TOOL_LABELS = {
  exec: "执行命令",
  wait: "等待",
  followup_task: "跟进任务",
  apply_patch: "应用补丁",
  read_file: "读取文件",
  write_file: "写入文件",
  view_image: "查看图片",
};

// 工具名的统一展示入口：内建名映射为友好名，未知名原样透传
function toolLabel(name) {
  return TOOL_LABELS[name] || name || "本地工具";
}

// 配对 review_wait_start / review_wait_end 形成等待区间（与后端口径一致）
function reviewWaitIntervals(turn) {
  const starts = (turn.events || [])
    .filter((e) => e.kind === "review_wait_start")
    .map((e) => e.at_ms)
    .sort((a, b) => a - b);
  const ends = (turn.events || [])
    .filter((e) => e.kind === "review_wait_end")
    .map((e) => e.at_ms)
    .sort((a, b) => a - b);
  const used = new Set();
  const intervals = [];
  for (const ws of starts) {
    const eIdx = ends.findIndex((t, i) => !used.has(i) && t >= ws);
    const we = eIdx !== -1 ? (used.add(eIdx), ends[eIdx]) : null;
    if (we !== null && we > ws) intervals.push([ws, we]);
  }
  return intervals;
}

// 单次调用粒度的工具耗时（慢操作榜单的原始证据）。
// 配对与时长口径镜像后端 calculateClaudeTiming / calculatePiTiming：
// - Pi：tool_result.end_ms 落盘了实际完成时间 → duration = end_ms − result.at_ms
// - Claude：tool_result 只有记录时刻 → duration = result.at_ms − use.at_ms − 区间内等待确认重叠
function perCallToolTimings(turn) {
  const evs = [...(turn.events || [])].sort((a, b) => a.at_ms - b.at_ms);
  const waits = reviewWaitIntervals(turn);
  const uses = evs.filter((e) => e.kind === "tool_use");
  const results = evs.filter((e) => e.kind === "tool_result");
  const used = new Set();
  const calls = [];
  for (const u of uses) {
    let rIdx = -1;
    if (u.tool_id) {
      rIdx = results.findIndex(
        (r, i) => !used.has(i) && r.tool_id === u.tool_id && r.at_ms >= u.at_ms,
      );
    }
    if (rIdx === -1) {
      rIdx = results.findIndex((r, i) => !used.has(i) && r.at_ms >= u.at_ms);
    }
    if (rIdx === -1) continue;
    used.add(rIdx);
    const r = results[rIdx];
    let duration;
    // end_ms 严格大于 at_ms 才是真实执行区间（Pi：at=工具就绪、end=完成）；
    // Antigravity 的结果记录是单时间戳（end_ms == at_ms，相减恒 0），必须
    // 回退为 发出→结果 的口径（扣除区间内等待确认），否则逐次全显 0ms。
    if (r.end_ms != null && r.end_ms > r.at_ms) {
      duration = r.end_ms - r.at_ms;
    } else {
      let waitInside = 0;
      for (const [ws, we] of waits) {
        waitInside += Math.max(0, Math.min(r.at_ms, we) - Math.max(u.at_ms, ws));
      }
      duration = Math.max(0, r.at_ms - u.at_ms - waitInside);
    }
    calls.push({
      name: u.tool_name || r.tool_name || "本地工具",
      duration_ms: duration,
      callId: u.tool_id || null,
      turnId: turn.id,
      // 起止时刻：供维度下钻展示每次调用的具体时间窗
      at: u.at_ms,
      end: r.end_ms != null && r.end_ms > r.at_ms ? r.end_ms : r.at_ms,
    });
  }
  return calls;
}

// ------------------------------------------------------------------
// 抽屉总账回填（反馈轮 3 Fix 2）：breakdown 为 null 的轮次（未完结轮、
// Codex 等不落盘分解的来源）凡是可从一手事件推导的指标都要回填，
// 推导不出来的维度给出诚实的一行原因，而不是孤零零一个 "—"
// ------------------------------------------------------------------
// 总时长（sessionWallSpan）：当前范围内该会话轮次的首尾跨度
// （TOP 3 榜、详情页 KPI 与下方维度聚合的统一口径）
function sessionWallSpan(s) {
  let first = Infinity;
  let last = 0;
  for (const t of s.turns) {
    const st = t.start_ms || t.end_ms;
    const en = t.end_ms || t.start_ms;
    if (st && st < first) first = st;
    if (en && en > last) last = en;
  }
  if (first === Infinity || !last) return { firstMs: null, lastMs: null, wallMs: null };
  return { firstMs: first, lastMs: last, wallMs: Math.max(0, last - first) };
}
function resolveRollup(turn, nowMs = Date.now()) {
  const bd = turn.breakdown;
  const hasBd = bd != null;
  const perCall = perCallToolTimings(turn);
  const perCallTotal = perCall.reduce((s, c) => s + c.duration_ms, 0);

  // 未正常结束（无结束记录）的轮次：end_ms 缺失
  const openEnded = turn.end_ms == null;

  const apiMs =
    hasBd && typeof bd.model_api_ms === "number" ? bd.model_api_ms : null;

  // 工具耗时：breakdown 有一手总账 → 直接用；否则按逐次调用时长累计回填
  let toolMs = null;
  let toolBackfilled = false;
  if (hasBd && typeof bd.tool_execution_ms === "number") {
    toolMs = bd.tool_execution_ms;
  } else if (perCall.length) {
    toolMs = perCallTotal;
    toolBackfilled = true;
  }

  const waitMs = turn.review_wait_ms ?? null;
  const workMs = turn.work_ms ?? null;
  // 守恒口径补充：中途停了（breakdown 单列）与排队等待（轮间元数据）
  const idleMs =
    hasBd && typeof bd.idle_gap_ms === "number" ? bd.idle_gap_ms : null;
  const queueWaitMs =
    typeof turn.queue_wait_ms === "number" && turn.queue_wait_ms > 0
      ? turn.queue_wait_ms
      : null;

  // 本轮时长（elapsed_ms）：elapsed_ms 优先；open 轮次回退为 起点→当前时刻 的已进行跨度
  let wallMs = turn.elapsed_ms ?? turn.period_ms ?? null;
  let wallBackfilled = false;
  if (wallMs == null && typeof turn.start_ms === "number" && nowMs > turn.start_ms) {
    wallMs = nowMs - turn.start_ms;
    wallBackfilled = true;
  }

  const workRate =
    wallMs && workMs !== null ? Math.round((workMs / wallMs) * 100) : null;

  return {
    apiMs,
    toolMs,
    toolBackfilled,
    waitMs,
    workMs,
    idleMs,
    queueWaitMs,
    wallMs,
    wallBackfilled,
    workRate,
    openEnded,
  };
}

// 缺证卡片的诚实下标文案：两种口径必须可区分 ——
// 1) 未正常结束的轮次（无结束记录，任何事后核算都缺依据）
// 2) 已完结但不落盘 breakdown 的来源（Codex / 三态降级，来源本身不提供该维度）
function rollupEvidenceNote(turn) {
  if (turn.end_ms == null) return "该轮未正常结束，无结束记录，无法核算";
  if (turn.breakdown == null) return "该来源不提供此维度的一手分解数据";
  return null;
}

// ------------------------------------------------------------------
// 首页维度聚合统计（反馈轮 3 Fix 3）：聚合、统计，不是过滤。
// 输入是"当前视口可见会话"，与视口操作分布卡完全同口径。
// ------------------------------------------------------------------

// 会话总时长口径（与 TOP 3 榜、详情页 KPI 同源）：首末轮次的首尾跨度
function aggregateSessionsByAgent(sessions) {
  const map = new Map();
  let totalWallMs = 0;
  for (const s of sessions) {
    const wall = sessionWallSpan(s).wallMs || 0;
    totalWallMs += wall;
    const cur = map.get(s.agent) || { agent: s.agent, sessions: 0, turns: 0, wallMs: 0 };
    cur.sessions += 1;
    cur.turns += s.turns.length;
    cur.wallMs += wall;
    map.set(s.agent, cur);
  }
  return {
    totalWallMs,
    rows: [...map.values()].sort((a, b) => b.wallMs - a.wallMs),
  };
}

// 按项目：全部行按总时长排序，上层取 TOP 5 并对剩余数量诚实披露
function aggregateSessionsByProject(sessions) {
  const map = new Map();
  let totalWallMs = 0;
  for (const s of sessions) {
    const wall = sessionWallSpan(s).wallMs || 0;
    totalWallMs += wall;
    const cur = map.get(s.project) || { project: s.project, sessions: 0, wallMs: 0 };
    cur.sessions += 1;
    cur.wallMs += wall;
    map.set(s.project, cur);
  }
  const rows = [...map.values()].sort((a, b) => b.wallMs - a.wallMs);
  return {
    totalWallMs,
    top: rows.slice(0, 5),
    restCount: Math.max(0, rows.length - 5),
  };
}

// 按工具：跨会话聚合 turn.breakdown.tools[]（逐会话一手测量值），
// 只统计确有测量证据的会话；Codex 等 breakdown 为 null 的来源不虚构数据
function aggregateTurnsByTool(sessions) {
  const map = new Map();
  let basisSessions = 0;
  for (const s of sessions) {
    let hasEvidence = false;
    for (const t of s.turns) {
      if (t.breakdown?.tools?.length) {
        hasEvidence = true;
        for (const tool of t.breakdown.tools) {
          const cur = map.get(tool.name) || { name: tool.name, count: 0, durationMs: 0 };
          cur.count += tool.count || 0;
          cur.durationMs += tool.duration_ms || 0;
          map.set(tool.name, cur);
        }
      }
    }
    if (hasEvidence) basisSessions += 1;
  }
  return {
    basisSessions,
    top: [...map.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5),
  };
}

// 区间集合减法：从 base 扣除 cut（镜像 src/metrics.ts 的 subtractMs）
function subtractIntervals(base, cut) {
  let parts = base;
  for (const [ca, cb] of [...cut].sort((a, b) => a[0] - b[0])) {
    const next = [];
    for (const [a, b] of parts) {
      if (cb <= a || ca >= b) { next.push([a, b]); continue; }
      if (ca > a) next.push([a, Math.min(ca, b)]);
      if (cb < b) next.push([Math.max(cb, a), b]);
    }
    parts = next;
  }
  return parts;
}

// 轮内「中途停了」的具体区间（与后端 calculateEventTiming 的 idle 口径镜像：
// ≥2 分钟无事件缝隙，扣除工具执行与等待确认）。只读 turn 一手事件，纯函数。
const IDLE_GAP_MIN_MS_UI = 120000;
function turnIdleIntervals(turn) {
  const evs = [...(turn.events || [])].sort((a, b) => a.at_ms - b.at_ms);
  const waits = reviewWaitIntervals(turn);
  const uses = evs.filter((e) => e.kind === "tool_use");
  const results = evs.filter((e) => e.kind === "tool_result");
  const used = new Set();
  const toolIv = [];
  for (const u of uses) {
    let rIdx = -1;
    if (u.tool_id) {
      rIdx = results.findIndex((r, i) => !used.has(i) && r.tool_id === u.tool_id && r.at_ms >= u.at_ms);
    }
    if (rIdx === -1) {
      rIdx = results.findIndex((r, i) => !used.has(i) && r.at_ms >= u.at_ms);
    }
    if (rIdx === -1) continue;
    used.add(rIdx);
    const r = results[rIdx];
    const end = Math.min(r.end_ms != null ? r.end_ms : r.at_ms, turn.end_ms != null ? turn.end_ms : Infinity);
    if (end > u.at_ms) toolIv.push([u.at_ms, end]);
  }
  const times = [];
  for (const e of evs) {
    times.push(e.at_ms);
    if (e.end_ms != null) times.push(e.end_ms);
  }
  times.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] >= IDLE_GAP_MIN_MS_UI) gaps.push([times[i - 1], times[i]]);
  }
  return subtractIntervals(subtractIntervals(gaps, toolIv), waits);
}

// 五维下钻数据：全会话聚合（不按轮组织），供维度抽屉消费。纯函数。
// 每维返回 { head, rows: [{ label, value, sub, slow }], note }
function dimensionDrilldownData(session, key) {
  const tstamp = (ms) =>
    new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const turns = session.turns || [];
  const turnNo = (id) => turns.findIndex((t) => t.id === id) + 1;

  if (key === "tool") {
    const calls = [];
    turns.forEach((t, i) => {
      for (const c of perCallToolTimings(t)) calls.push({ ...c, turnIndex: i + 1 });
    });
    const tstamp2 = (ms) =>
      new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const map = new Map();
    for (const c of calls) {
      const cur = map.get(c.name) ?? { name: c.name, count: 0, total: 0, max: 0, slow: 0, turns: new Set() };
      cur.count += 1;
      cur.total += c.duration_ms;
      cur.max = Math.max(cur.max, c.duration_ms);
      if (c.duration_ms > SLOW_OP_THRESHOLD_MS) cur.slow += 1;
      cur.turns.add(c.turnIndex);
      map.set(c.name, cur);
    }
    const rows = [...map.values()]
      .sort((a, b) => b.total - a.total)
      .map((a) => ({
        label: toolLabel(a.name) + " ×" + a.count,
        value: fmt(a.total),
        sub: `最长 ${fmt(a.max)} · 出现在轮 ${[...a.turns].sort((x, y) => x - y).join(", ")}` + (a.slow ? ` · 超 15s 慢操作 ${a.slow} 次` : ""),
        slow: a.slow > 0,
        calls: calls
          .filter((c) => c.name === a.name)
          .sort((x, y) => y.duration_ms - x.duration_ms)
          .map((c) => ({
            label: `轮次 #${c.turnIndex}`,
            value: fmt(c.duration_ms),
            sub: `${tstamp2(c.at)} → ${tstamp2(c.end)}`,
            slow: c.duration_ms > SLOW_OP_THRESHOLD_MS,
            at: c.at,
            turnId: c.turnId,
          })),
      }));
    return {
      head: `${calls.length} 次调用 · ${rows.length} 类工具`,
      rows,
      note: "逐次时长 = 工具发出到出结果的墙钟（含可能的审批等待，来源不落盘则拆不出）",
    };
  }

  if (key === "model") {
    const rows = turns
      .map((t, i) => ({ label: `轮次 #${i + 1}`, value: t.breakdown ? fmt(t.breakdown.model_api_ms ?? 0) : "—", sub: (t.models || []).join(" / ") || "模型上下文未知", slow: false }))
      .filter((r) => r.value !== "—");
    const total = turns.reduce((a, t) => a + (t.breakdown?.model_api_ms ?? 0), 0);
    return {
      head: `合计 ${fmt(total)} · ${rows.length} 轮有测量`,
      rows,
      note: "思考与回复在源记录中整条落盘、不可再分，统一计入本维度；轮内 ≤2 分钟的响应间隙计入此处，更长间隙归「中途停了」",
    };
  }

  if (key === "wait") {
    const rows = [];
    turns.forEach((t, i) => {
      for (const [ws, we] of reviewWaitIntervals(t)) {
        rows.push({ label: `轮次 #${i + 1}`, value: fmt(we - ws), sub: `${tstamp(ws)} → ${tstamp(we)}`, slow: false });
      }
    });
    return {
      head: rows.length ? `${rows.length} 次确认 · 合计 ${fmt(session.review_wait_ms || 0)}` : "本会话没有等待确认记录",
      rows,
      note: "等待确认 = 工具授权与方案确认的挂起时长；来源不落盘审批事件时该维度如实为空",
    };
  }

  if (key === "idle") {
    const rows = [];
    turns.forEach((t, i) => {
      for (const [a, b] of turnIdleIntervals(t)) {
        rows.push({ label: `轮次 #${i + 1}`, value: fmt(b - a), sub: `${tstamp(a)} → ${tstamp(b)}`, slow: b - a >= 3600000 });
      }
    });
    rows.sort((a, b) => 0);
    const total = turns.reduce((acc, t) => acc + (t.breakdown?.idle_gap_ms ?? 0), 0);
    return {
      head: rows.length ? `${rows.length} 段 · 合计 ${fmt(total)}` : "本会话没有 ≥2 分钟的无事件空白",
      rows,
      note: "停摆的具体原因（网络阻塞、设备休眠、忙上一条）源记录不写，只能按两端记录类型推断，故不做定性",
    };
  }

  if (key === "standby") {
    const rows = [];
    turns.forEach((t, i) => {
      if (t.standby_ms != null && t.standby_ms > 0) {
        const prev = turns[i - 1];
        const start = prev && prev.end_ms != null ? tstamp(prev.end_ms) : "—";
        rows.push({
          label: `轮次 #${i + 1}`,
          value: fmt(t.standby_ms),
          sub: `上轮 ${start} 交卷 → 你 ${t.start_ms != null ? tstamp(t.start_ms) : "—"} 才发下一条`,
          slow: t.standby_ms >= 3600000,
        });
      }
      if ((t.queue_wait_ms ?? 0) > 0) {
        rows.push({
          label: `轮次 #${i + 1} 排队`,
          value: fmt(t.queue_wait_ms),
          sub: "发出时上一轮还没答完——消息排队，它收尾后即接手",
          slow: false,
        });
      }
    });
    return {
      head: rows.length ? `${rows.length} 段轮间间隔 · 合计 ${fmt(session.standby_ms || 0)}` : "本会话没有轮间间隔",
      rows,
      note: "轮间间隔是你的时间（阅读、离开、睡觉），AI 零消耗；排队条目表示你提前发了下一条",
    };
  }

  return { head: "未知维度", rows: [], note: null };
}

// 慢操作阈值：单次工具调用超过 15 秒即视为慢操作（用户可见文案统一写作「超 15s 慢操作」）
const SLOW_OP_THRESHOLD_MS = 15000;

// 慢操作（单次超过 15 秒）跨轮收集，按耗时倒序
function slowToolCalls(s, threshold = SLOW_OP_THRESHOLD_MS) {
  const calls = [];
  s.turns.forEach((t, i) => {
    for (const c of perCallToolTimings(t)) {
      if (c.duration_ms > threshold) calls.push({ ...c, turnIndex: i + 1 });
    }
  });
  return calls.sort((a, b) => b.duration_ms - a.duration_ms);
}
// ==== PURE HELPERS END ====

// 自动完成度（autonomy_rate）：AI 工作 work_ms ÷ (AI 工作 + 等待确认) × 100%
// 人工确认次数 = 成对闭合的 review_wait_start/end（Claude 独有；Pi/Codex 优雅降级）
function sessionAutonomy(s) {
  let work = 0;
  let wait = 0;
  let hasWork = false;
  let confirmations = 0;
  for (const t of s.turns) {
    if (t.work_ms !== null && t.work_ms !== undefined) {
      work += t.work_ms;
      hasWork = true;
    }
    if (t.review_wait_ms !== null && t.review_wait_ms !== undefined) {
      wait += t.review_wait_ms;
    }
    let open = 0;
    for (const e of t.events || []) {
      if (e.kind === "review_wait_start") open++;
      else if (e.kind === "review_wait_end" && open > 0) {
        confirmations++;
        open--;
      }
    }
  }
  if (!hasWork) return { rate: null, workSum: null, confirmations };
  const denom = work + wait;
  return {
    rate: denom > 0 ? (work / denom) * 100 : 100,
    workSum: work,
    confirmations,
  };
}

// 系统瓶颈归因诊断：只输出由真实数据推导的规则结论，不编造
function attributionLines(s) {
  const b = sessionBreakdown(s);
  if (b.total <= 0) {
    return [
      "该会话暂无细分数据（Codex 会话不提供细分数据），无法进行瓶颈归因。",
    ];
  }
  // 维度短标签沿用 BREAKDOWN_DIMENSIONS，仅归因句式在此处维护
  const verdicts = {
    tool: "瓶颈为本地工具或脚本执行",
    model: "瓶颈为模型响应等待",
    wait: "瓶颈为等待确认",
    idle: "瓶颈为中途停了（网络阻塞、设备休眠或忙上一条——源记录不写原因）",
    standby: "会话大部分时间处于轮间间隔",
  };
  const dims = BREAKDOWN_DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    verdict: verdicts[d.key],
    pct: (b[d.key] / b.total) * 100,
  }));
  const top = dims.slice().sort((a, b) => b.pct - a.pct)[0];
  const lines = [
    `主要耗时源：${top.label} 占 ${top.pct.toFixed(1)}%，${top.verdict}。`,
  ];
  const waitPct = (b.wait / b.total) * 100;
  lines.push(
    waitPct >= 25
      ? `等待确认占比 ${waitPct.toFixed(1)}%，建议提升自动化（预设工具权限白名单，减少授权确认）。`
      : `等待确认占比仅 ${waitPct.toFixed(1)}%，人机交付流转紧凑。`,
  );
  const slow = slowToolCalls(s);
  lines.push(
    slow.length
      ? `检测到 ${slow.length} 项超 15s 慢操作，最慢为 ${toolLabel(slow[0].name)}（${fmt(slow[0].duration_ms)}，轮次 #${slow[0].turnIndex}）。`
      : "未检测到超 15s 的慢操作，执行节奏平稳。",
  );
  return lines;
}

function detailKpiCard(label, val, sub, tone = "", hint = "") {
  return `
    <div class="kpi-card${tone ? ` ${tone}` : ""}"${hint ? ` title="${h(hint)}"` : ""}>
      <div class="kpi-label">${h(label)}</div>
      <div class="kpi-val">${h(val)}</div>
      <div class="kpi-sub">${h(sub)}</div>
    </div>`;
}

// 详情页四维明细行：直接别名 BREAKDOWN_DIMENSIONS，标签、颜色与口径提示同源
const DETAIL_BREAKDOWN_ROWS = BREAKDOWN_DIMENSIONS;

function sessionDetail() {
  const s = detailSession();
  if (!s) return sessionDetailFallback();

  const b = sessionBreakdown(s);
  const wall = sessionWallSpan(s);
  const autonomy = sessionAutonomy(s);
  const slow = slowToolCalls(s);
  const status = sessionStatus(s);

  // 首屏第一视觉：8px 全宽分段占比条 + 4 行百分比明细
  const segHtml =
    b.total > 0
      ? DETAIL_BREAKDOWN_ROWS.map((r) => {
          const pct = (b[r.key] / b.total) * 100;
          return pct > 0
            ? `<div style="width:${pct.toFixed(1)}%; background:${r.color};" data-dim-row="${h(r.key)}" role="button" tabindex="0" aria-label="下钻查看${h(r.label)}细分" title="${h(r.label)}: ${pct.toFixed(1)}% · 点击下钻"></div>`
            : "";
        }).join("")
      : "";
  const breakdownBody =
    b.total > 0
      ? `
        <div class="multi-seg-bar tall">${segHtml}</div>
        ${DETAIL_BREAKDOWN_ROWS.map((r) => {
          const ms = b[r.key];
          const pct = ((ms / b.total) * 100).toFixed(1);
          return `
            <div class="breakdown-row" data-dim-row="${h(r.key)}" role="button" tabindex="0" aria-label="下钻查看${h(r.label)}细分" title="口径：${h(r.hint)} · 点击查看全会话细分">
              <div class="breakdown-label">
                <span class="seg-legend-swatch" style="background:${r.color};"></span>
                <span>${h(r.label)}</span>
              </div>
              <div class="breakdown-val">
                <span>${ms > 0 ? fmt(ms) : "—"}</span>
                <strong>${pct}%</strong>
              </div>
            </div>`;
        }).join("")}`
      : `<div class="s1-empty">该会话暂无细分耗时数据 — 当前接入的 Codex 会话不提供细分数据，不做任何伪造拆分。</div>`;

  const workPct =
    b.total > 0 ? (((b.tool + b.model) / b.total) * 100).toFixed(1) : null;

  const slowRows = slow.slice(0, 3).map(
    (c, i) => `
      <div class="slow-tool-row" data-turn-capsule="${h(c.turnId)}" role="button" tabindex="0" aria-label="在抽屉中检视轮次 #${c.turnIndex} 的 ${h(toolLabel(c.name))}">
        <span class="slow-tool-name"><strong class="slow-tool-rank">${i + 1}.</strong> <span class="slow-tool-label" title="${h(c.name)}">${h(toolLabel(c.name))}</span><span class="slow-tool-turn">轮次 #${c.turnIndex}</span></span>
        <span class="slow-tool-time">${fmt(c.duration_ms)}</span>
      </div>`,
  );

  return `
    <div class="detail-nav">
      <button class="btn-back-home" data-action="back-overview" aria-label="返回总览">
        <span>← 返回总览</span>
      </button>
      <span class="detail-id-mono">${agentMark(s.agent)}<span>${h(s.agent)} · ${h(s.id)}</span></span>
      <span class="detail-status-pill ${status.cls}">${h(status.label)}</span>
    </div>
    <h2 class="detail-title">${h(s.title || projectLabel(s.project))}</h2>

    <section class="session-breakdown-full">
      <div class="breakdown-head">
        <strong>本会话操作与耗时分布</strong>
        <span class="breakdown-head-val">${b.tool + b.model > 0 ? `AI 工作 ${fmt(b.tool + b.model)}（${workPct}%）` : "无 AI 工作耗时证据"}</span>
      </div>
      ${breakdownBody}
    </section>

    <div class="detail-kpis">
      ${detailKpiCard(
        "总时长",
        wall.wallMs !== null ? fmt(wall.wallMs) : "—",
        "开始至完结绝对跨度（当前统计范围内）",
        "",
        "口径：总时长 sessionWallSpan = 首末轮次首尾跨度",
      )}
      ${detailKpiCard(
        "AI 工作",
        autonomy.workSum !== null ? fmt(autonomy.workSum) : "—",
        autonomy.workSum !== null ? "模型想和写 + 本地工具" : "该会话未提供三态切分",
        "work",
        "口径：AI 工作 work_ms = 模型推理 + 本地工具",
      )}
      ${detailKpiCard(
        "自动完成度",
        autonomy.rate !== null ? `${autonomy.rate.toFixed(1)}%` : "—",
        autonomy.rate !== null
          ? `${autonomy.confirmations} 次人工确认`
          : "该会话未提供三态切分",
        "",
        "口径：自动完成度 autonomy_rate = work_ms ÷ (work_ms + review_wait_ms) × 100%",
      )}
      ${detailKpiCard(
        "超 15s 慢操作",
        `${slow.length} 项`,
        "单次调用超过 15 秒",
        slow.length ? "alert" : "",
        "口径：超 15s 慢操作 slow_ops = 单次工具调用 > 15000ms",
      )}
      ${(s.queue_count ?? 0) > 0
        ? detailKpiCard(
            "排队输入",
            `${s.queue_count} 次`,
            `累计排队 ${fmt(s.queue_wait_ms || 0)}（发出时上一轮还没答完）`,
            "",
            "口径：排队输入 = 发出时上一轮尚未答复完毕的轮次；排队时长 queue_wait_ms = 上轮答复完毕 − 本条发出",
          )
        : ""}
      ${s.last_done_ms
        ? detailKpiCard(
            "收尾空档",
            fmt(Math.max(0, Date.now() - s.last_done_ms)),
            `最后答复完毕 ${new Date(s.last_done_ms).toLocaleString("zh-CN", { hour12: false })} · 你还没发下一条，空档逐秒增长`,
            "alert",
            "口径：收尾空档 = 当前时刻 − 末轮答复完毕（last_done_ms）。与轮间间隔不同：没有下一条锚点，直到你发消息或关闭会话",
          )
        : ""}
    </div>

    <div class="detail-diag-grid">
      <div class="diag-card">
        <div class="diag-head">
          <span>最慢操作</span>
          <span class="diag-head-sub">单次调用超过 15 秒 · 倒序</span>
        </div>
        ${
          slowRows.length
            ? slowRows.join("")
            : `<div class="s1-empty">未检测到超 15s 的慢操作。</div>`
        }
      </div>
      <div class="diag-card">
        <div class="diag-head">
          <span>效率归因</span>
          <span class="diag-head-sub ok">系统自检结论</span>
        </div>
        <div class="diag-attribution">
          ${attributionLines(s).map((l) => `<p>• ${h(l)}</p>`).join("")}
        </div>
      </div>
    </div>
    <!-- 切片 3：轮次时序流胶囊 -->
    ${turnCapsuleSection(s)}
  `;
}

// ========================================================
// 切片 3：轮次时序流胶囊 + 右侧轮次抽屉联动
// ========================================================

// 单轮 260px 迷你占比条：模型推理 / 本地工具 / 等待确认 / 待命，
// 标签、颜色与口径提示全部来自 BREAKDOWN_DIMENSIONS（保持既有视觉顺序）。
// Codex 会话 turn.breakdown 为 null → 不伪造分段，诚实退化为单色总时长条。
function capsuleBarHtml(t) {
  // 先按固定维度键取毫秒值，再与维度配置合并：
  // 避免 breakdownDimension(undefined) 产出 {} 让渲染侧读到空颜色/空提示
  const msByKey = {
    model: t.breakdown?.model_api_ms ?? 0,
    tool: t.breakdown?.tool_execution_ms ?? 0,
    wait: t.review_wait_ms ?? 0,
    idle: t.breakdown?.idle_gap_ms ?? 0,
    standby: t.standby_ms ?? 0,
  };
  const known = Object.values(msByKey).reduce((sum, ms) => sum + ms, 0);
  // 顺序沿用原视觉：模型想和写 → 本地工具 → 等待确认 → 中途停了 → 轮间间隔
  const segs = ["model", "tool", "wait", "idle", "standby"]
    .filter((key) => msByKey[key] > 0)
    .map((key) => ({ key, ms: msByKey[key], dim: breakdownDimension(key) }))
    .filter((x) => x.dim);
  if (known > 0 && segs.length) {
    return segs
      .map(
        (x) =>
          `<div style="width:${((x.ms / known) * 100).toFixed(1)}%; background:${x.dim.color};" title="${h(dimensionHint(x.key))} · ${fmt(x.ms)}"></div>`,
      )
      .join("");
  }
  const total = t.elapsed_ms ?? t.period_ms ?? null;
  const why = total
    ? "该轮无细分耗时数据（该来源不提供细分数据），仅按本轮时长展示"
    : "该轮无细分耗时数据，且缺少可测量时长";
  return `<div style="width:100%; background:var(--state-standby);" title="${why}"></div>`;
}

// 胶囊标题：逐轮状态 + 首个模型（来源没有轮次级任务标题，不编造）
function capsuleTitle(t) {
  const statusLabel = statuses[t.status] || t.status;
  return t.models && t.models.length
    ? `${statusLabel} · ${t.models[0]}`
    : statusLabel;
}

function turnCapsuleSection(s) {
  const rows = s.turns.map((t, i) => {
    const hasSlow = perCallToolTimings(t).some(
      (c) => c.duration_ms > SLOW_OP_THRESHOLD_MS,
    );
    return `
      <div class="turn-capsule${state.selectedTurnId === t.id ? " active" : ""}" data-turn-capsule="${h(t.id)}" role="button" tabindex="0" aria-label="检视轮次 #${i + 1}">
        ${agentMark(s.agent)}
        <span class="capsule-no">轮次 #${i + 1}</span>
        <span class="capsule-title">${h(capsuleTitle(t))}${hasSlow ? '<em class="capsule-slow-flag">含超 15s 慢操作</em>' : ""}</span>
        <div class="capsule-bar">${capsuleBarHtml(t)}</div>
        <span class="capsule-duration">${fmt(t.elapsed_ms ?? t.period_ms ?? null)}</span>
      </div>`;
  });
  return `
    <section class="turn-capsule-list">
      <div class="capsule-head">
        <strong>轮次时序流 (点击胶囊呼出右侧抽屉)</strong>
        <span class="capsule-head-sub">共 ${s.turns.length} 轮交互</span>
      </div>
      ${rows.join("") || `<div class="s1-empty">该会话在当前统计范围内没有轮次记录。</div>`}
    </section>`;
}

function bindBrushEvents() {
  const vp = $("#brushViewport");
  const track = $("#brushTrack");
  if (!vp || !track) return;

  // 重置视口按钮（时间轴头部与双列榜空态共用，class 委托避免重复 id）
  document.querySelectorAll(".js-reset-zoom").forEach((btn) => {
    btn.onclick = () => {
      state.zoomStartPct = 0;
      state.zoomEndPct = 100;
      render();
    };
  });

  let isDragging = false;
  let dragType = "move";
  let startX = 0;
  let startLeft = state.zoomStartPct;
  let startWidth = state.zoomEndPct - state.zoomStartPct;

  const onMouseDown = (e) => {
    isDragging = true;
    startX = e.clientX;
    startLeft = state.zoomStartPct;
    startWidth = state.zoomEndPct - state.zoomStartPct;

    if (e.target.dataset.handle === "left") dragType = "left";
    else if (e.target.dataset.handle === "right") dragType = "right";
    else dragType = "move";

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    e.preventDefault();
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const trackWidth = track.clientWidth || 1;
    const deltaPct = ((e.clientX - startX) / trackWidth) * 100;

    if (dragType === "move") {
      let newLeft = Math.max(0, Math.min(100 - startWidth, startLeft + deltaPct));
      state.zoomStartPct = Math.round(newLeft);
      state.zoomEndPct = Math.round(newLeft + startWidth);
    } else if (dragType === "left") {
      let newLeft = Math.max(0, Math.min(state.zoomEndPct - 5, startLeft + deltaPct));
      state.zoomStartPct = Math.round(newLeft);
    } else if (dragType === "right") {
      let newRight = Math.min(100, Math.max(state.zoomStartPct + 5, startLeft + startWidth + deltaPct));
      state.zoomEndPct = Math.round(newRight);
    }

    vp.style.left = `${state.zoomStartPct}%`;
    vp.style.width = `${Math.max(5, state.zoomEndPct - state.zoomStartPct)}%`;
  };

  const onMouseUp = () => {
    if (!isDragging) return;
    isDragging = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    render();
  };

  vp.onmousedown = onMouseDown;
}

// ========================================================
// 模块 4：两段式弹性下钻抽屉（480px，上总账 + 下慢工具清单）
// 真实消费 API 暴露数据，严禁假数据伪造
// ========================================================
function openDrawer(turn, session) {
  state.selectedTurnId = turn.id;
  state.activeSessionId = session.id;

  const d = $("#detailDrawer");
  if (!d) return;

  const turnIndex = session.turns.findIndex((t) => t.id === turn.id);
  // 抽屉标题旁的接入工具徽标：一眼可见这一轮来自哪个接入工具
  const markEl = $("#drawerAgentMark");
  if (markEl) markEl.innerHTML = agentMark(session.agent);
  const titleEl = $("#drawerTurnTitle");
  if (titleEl) {
    titleEl.textContent =
      turnIndex === -1
        ? session.title
          ? `${session.title} · 轮次详情`
          : `会话 ${projectLabel(session.project)} · 轮次详情`
        : `轮次 #${turnIndex + 1} 深度检视 · ${session.title || projectLabel(session.project)}`;
    titleEl.title = titleEl.textContent;
  }

  // 上/下一轮按钮：处于首/末轮时禁用
  const prevBtn = $("#drawerPrevTurn");
  const nextBtn = $("#drawerNextTurn");
  if (prevBtn) prevBtn.disabled = turnIndex <= 0;
  if (nextBtn)
    nextBtn.disabled =
      turnIndex === -1 || turnIndex >= session.turns.length - 1;

  // 胶囊高亮与抽屉选中轮次保持同步（.turn-capsule.active）
  $$(".turn-capsule").forEach((c) =>
    c.classList.toggle("active", c.dataset.turnCapsule === turn.id),
  );

  state.dimensionDrawerKey = null;
  // 总账四卡统一走 resolveRollup：breakdown 缺失时可推导指标回填，
  // 推导不出的维度由 rollupEvidenceNote 给出诚实一行原因
  const rollup = resolveRollup(turn);
  const work = rollup.workMs;
  const wait = rollup.waitMs;
  const wall = rollup.wallMs;
  const workRate = rollup.workRate;

  // 真实消费分解数据：有 breakdown 消费 breakdown，没有则如实呈现
  const apiMs = rollup.apiMs;
  const toolMs = rollup.toolMs;

  // 提取真实的工具清单（供 KPI 汇总口径使用）
  let toolsList = [];
  if (turn.breakdown?.tools && turn.breakdown.tools.length) {
    toolsList = turn.breakdown.tools.map(t => ({
      name: t.name,
      count: t.count,
      duration_ms: t.duration_ms,
    }));
  } else {
    // 从 turn.events 中真实提取已配对的 tool_use
    const toolEvents = turn.events.filter(e => e.kind === "tool_use" || e.tool_name);
    if (toolEvents.length) {
      const grouped = new Map();
      for (const te of toolEvents) {
        const name = te.tool_name || "本地工具";
        const cur = grouped.get(name) || { count: 0, duration_ms: 0 };
        cur.count++;
        grouped.set(name, cur);
      }
      for (const [name, val] of grouped.entries()) {
        toolsList.push({
          name,
          count: val.count,
          duration_ms: toolMs ? Math.round(toolMs / grouped.size) : 0,
        });
      }
    }
  }

  // 逐次调用粒度的工具调用栈（与慢操作榜单同一口径），超过 15 秒标红
  const perCallStack = perCallToolTimings(turn).sort(
    (a, b) => b.duration_ms - a.duration_ms,
  );

  // 耗时倒序排序
  toolsList.sort((a, b) => b.duration_ms - a.duration_ms);

  // 按工具聚合（用户视角：先看哪类工具吃了多少时间，逐次明细按需展开）
  const toolAgg = (() => {
    const map = new Map();
    for (const c of perCallStack) {
      const cur = map.get(c.name) ?? { name: c.name, count: 0, total: 0, max: 0, slow: 0 };
      cur.count += 1;
      cur.total += c.duration_ms;
      cur.max = Math.max(cur.max, c.duration_ms);
      if (c.duration_ms > SLOW_OP_THRESHOLD_MS) cur.slow += 1;
      map.set(c.name, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  })();
  const slowCallCount = perCallStack.filter((c) => c.duration_ms > SLOW_OP_THRESHOLD_MS).length;

  // 可选分项（如 Pi 的事件流切分）：仅在数据落盘存在时渲染该小节
  const unclassifiedMs = turn.breakdown?.unclassified_delay_ms ?? null;
  const waitCaption = unclassifiedMs !== null
    ? "来源未落盘审批事件 · 无法归因"
    : "授权审批与决策对齐";
  const modelBreakdown = (turn.breakdown?.model_api_breakdown ?? [])
    .slice()
    .sort((a, b) => b.duration_ms - a.duration_ms);
  const thinkingBreakdown = (turn.breakdown?.thinking_breakdown ?? [])
    .slice()
    .sort((a, b) => b.duration_ms - a.duration_ms);
  const breakdownRow = (label, ms) => `
    <div style="display:flex; justify-content:space-between; align-items:center; padding:7px 12px; border-top:1px solid var(--line-subtle);">
      <span style="font-family:var(--font-mono); font-size:var(--text-xs); color:var(--fg-title);">${h(label)}</span>
      <span class="tool-time">${fmt(ms)}</span>
    </div>
  `;
  const breakdownHtml = modelBreakdown.length || thinkingBreakdown.length
    ? `
    <div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
        <span style="font-size:var(--text-sm); font-weight:700; color:var(--fg-title);">模型与思考分项</span>
        <span style="font-size:var(--text-xs); color:var(--fg-muted);">仅统计已落盘的事件耗时</span>
      </div>
      <div style="border:1px solid var(--line); border-radius:8px; overflow:hidden;">
        ${modelBreakdown.length ? `
          <div style="padding:7px 12px; background:var(--card-muted); font-size:var(--text-xs); font-weight:600; color:var(--fg-title);">模型推理耗时分布</div>
          ${modelBreakdown.map((m) => breakdownRow(m.model, m.duration_ms)).join("")}
        ` : ""}
        ${thinkingBreakdown.length ? `
          <div style="padding:7px 12px; background:var(--card-muted); font-size:var(--text-xs); font-weight:600; color:var(--fg-title); border-top:${modelBreakdown.length ? "1" : "0"}px solid var(--line);">思考耗时分布</div>
          ${thinkingBreakdown.map((t) => breakdownRow(`思考 · ${t.level}`, t.duration_ms)).join("")}
        ` : ""}
      </div>
    </div>
  `
    : "";

  const unclassifiedHtml =
    unclassifiedMs !== null && unclassifiedMs > 0
      ? `
    <div>
      <div style="display:flex; justify-content:space-between; align-items:center; border:1px solid var(--line); border-radius:8px; padding:7px 12px;">
        <span style="font-size:var(--text-sm); font-weight:700; color:var(--fg-title);">未分类延迟</span>
        <span class="tool-time">${fmt(unclassifiedMs)}</span>
      </div>
      <div style="font-size:var(--text-xs); color:var(--fg-muted); margin-top:4px;">工具就绪至实际开始的间隔；来源未落盘审批事件，可能含审批等待、调度或限流，不计入等待确认。</div>
    </div>
  `
      : "";

  const tstampShort = (ms) =>
    ms == null
      ? ""
      : new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const toolsHtml = perCallStack.length
    ? perCallStack.map((c) => {
        const isSlow = c.duration_ms > SLOW_OP_THRESHOLD_MS;
        return `
          <div class="tool-exec-card${isSlow ? " slow" : ""}" data-tool-call="${h(c.callId || "")}" data-call-at="${c.at ?? ""}">
            <div class="tool-exec-head">
              <strong title="${h(c.name)}">${h(toolLabel(c.name))}</strong>
              <span class="tool-exec-time${isSlow ? " slow" : ""}">${fmt(c.duration_ms)}${isSlow ? "（慢操作）" : ""}</span>
            </div>
            <div class="tool-exec-detail">${c.at != null ? `${h(tstampShort(c.at))} → ${h(tstampShort(c.end))}` : h(c.name)}${c.at == null ? "" : ' · 输入/输出读取中…'}</div>
          </div>
        `;
      }).join("")
    : `<div class="empty" style="padding:16px;">本轮未调用外部工具/脚本 (纯模型推理)。</div>`;

  $("#drawerBody").innerHTML = `
    <!-- 按需读取的该轮提问与思考文本（切片 3）：加载/错误状态诚实可见 -->
    <div>
      <div class="drawer-section-label">你的提问</div>
      <div class="drawer-transcript-box" id="drawerPrompt">正在读取本机源文件…</div>
      <div class="drawer-section-label" style="margin-top:14px;">模型思考过程</div>
      <div class="drawer-transcript-box" id="drawerThinking">正在读取本机源文件…</div>
    </div>

    <!-- 顶部总账微卡 -->
    <div>
      <div style="font-size:12px; font-weight:700; margin-bottom:8px; color:var(--fg-title); display:flex; justify-content:space-between;">
        <span>本轮时间构成</span>
        <span style="font-size:11px; color:var(--state-work); font-weight:600;">一手数据核算</span>
      </div>
      ${rollup.queueWaitMs !== null ? `
      <div class="demo" style="margin:0 0 10px;">
        <strong>排队输入</strong>
        <span>你发出这条时上一轮还没答复完毕——这条消息排队了 <strong>${fmt(rollup.queueWaitMs)}</strong>，它答完上一条后才接手处理（交接通常仅数秒到一分钟）。</span>
      </div>` : ""}
      <div class="drawer-kpi-grid">
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);" title="${h(dimensionHint("model"))}">
          <div class="drawer-kpi-title">${h(dimensionTitle("model"))}</div>
          <div class="drawer-kpi-val">${apiMs !== null ? fmt(apiMs) : "—"}</div>
          <div class="drawer-kpi-sub">${h(apiMs !== null ? (session.agent === "Antigravity" ? "含思考与输出 · 源记录整条落盘不可再分" : turn.models.join(" / ") || "模型上下文未知") : rollupEvidenceNote(turn) || "模型上下文未知")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);" title="${h(dimensionHint("tool"))}">
          <div class="drawer-kpi-title">${h(dimensionTitle("tool"))}</div>
          <div class="drawer-kpi-val">${toolMs !== null ? fmt(toolMs) : "—"}</div>
          <div class="drawer-kpi-sub">${h(toolMs !== null ? `${toolsList.length} 项工具执行${rollup.toolBackfilled ? " · 逐次调用累计" : ""}` : rollupEvidenceNote(turn) || "0 项工具执行")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-wait);" title="${h(dimensionHint("wait"))}">
          <div class="drawer-kpi-title">${h(dimensionTitle("wait"))}</div>
          <div class="drawer-kpi-val">${wait !== null ? fmt(wait) : "—"}</div>
          <div class="drawer-kpi-sub">${h(wait !== null ? waitCaption : rollupEvidenceNote(turn) || waitCaption)}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-idle);" title="口径：本轮时长 elapsed_ms = 本轮起点至结束">
          <div class="drawer-kpi-title">本轮时长</div>
          <div class="drawer-kpi-val">${fmt(wall)}</div>
          <div class="drawer-kpi-sub">${rollup.idleMs !== null ? h(`守恒：干活 ${fmt((apiMs ?? 0) + (toolMs ?? 0))} + 等待确认 ${fmt(wait ?? 0)} + 停了 ${fmt(rollup.idleMs)} = 等待 ${fmt(wall)}`) : h(`AI 工作占比：${workRate !== null ? `${workRate}%` : "—"}${rollup.wallBackfilled ? " · 该轮进行中，按起点至今累计" : ""}`)}</div>
        </div>
        ${rollup.idleMs !== null ? `
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-idle-strong);" title="${h(dimensionHint("idle"))}">
          <div class="drawer-kpi-title">${h(dimensionTitle("idle"))}</div>
          <div class="drawer-kpi-val">${fmt(rollup.idleMs)}</div>
          <div class="drawer-kpi-sub">网络阻塞、设备休眠、忙上一条等 · 源记录不写原因，不编造</div>
        </div>` : ""}
      </div>
      <!-- Token / 模型下钻：与三态并排呈现；无快照如实留空，绝不 0 断言 -->
      <div class="drawer-kpi-grid" style="margin-top:10px;">
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-token);">
          <div class="drawer-kpi-title">本轮 Token 用量</div>
          <div class="drawer-kpi-val">${fmtTokens(turn.tokens ? turn.tokens.total_tokens : null)}</div>
          <div class="drawer-kpi-sub">${h(tokenSub(turn.tokens))}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-token);">
          <div class="drawer-kpi-title">会话累计 Token</div>
          <div class="drawer-kpi-val">${fmtTokens(session.tokens ? session.tokens.total_tokens : null)}</div>
          <div class="drawer-kpi-sub">${session.tokens ? "全部轮次快照差分累计" : "源记录未携带 Token 快照"}</div>
        </div>
      </div>
    </div>

    <!-- 模型与思考等级可选分项（仅数据存在时渲染） -->
    ${breakdownHtml}

    <!-- Pi 未分类延迟（工具就绪到实际开始，无法归因为人审） -->
    ${unclassifiedHtml}

    <!-- 工具调用：按工具聚合先行，逐次明细按需展开 -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
        <span style="font-size:12px; font-weight:700; color:var(--fg-title);">本轮工具调用</span>
        <span style="font-size:11px; color:var(--fg-muted);">${toolAgg.length ? `${perCallStack.length} 次调用 · ${toolAgg.length} 类工具` : "无工具调用"}</span>
      </div>
      ${toolAgg.length
        ? `<div class="tool-agg-list">
        ${toolAgg
          .map((a) => {
            // 一类工具一个可展开块：聚合行为摘要，逐次卡（起止 + 输入/输出）在下方
            const calls = perCallStack
              .filter((c) => c.name === a.name)
              .sort((x, y) => y.duration_ms - x.duration_ms);
            const cards = calls
              .map((c) => {
                const isSlow = c.duration_ms > SLOW_OP_THRESHOLD_MS;
                return `
            <div class="tool-exec-card${isSlow ? " slow" : ""}" data-tool-call="${h(c.callId || "")}" data-call-at="${c.at ?? ""}" style="padding:7px 10px;">
              <div class="tool-exec-head">
                <strong style="font-size:12px;">轮次内第 ${calls.indexOf(c) + 1} 次</strong>
                <span class="tool-exec-time${isSlow ? " slow" : ""}" style="font-size:11px;">${fmt(c.duration_ms)}${isSlow ? "（慢操作）" : ""}</span>
              </div>
              <div class="tool-exec-detail">${c.at != null ? `${h(tstampShort(c.at))} → ${h(tstampShort(c.end))}` : h(c.name)}${c.at == null ? "" : ' · 输入/输出读取中…'}</div>
            </div>`;
              })
              .join("");
            return `
          <details class="dim-drill">
            <summary><div class="tool-agg-row${a.slow ? " slow" : ""}" title="${h(a.name)}">
              <span class="tool-agg-name">${h(toolLabel(a.name))}<em>×${a.count}</em></span>
              <span class="tool-agg-total">${fmt(a.total)}</span>
              <span class="tool-agg-max${a.max > SLOW_OP_THRESHOLD_MS ? " slow" : ""}">最长 ${fmt(a.max)}</span>
            </div></summary>
            <div class="dim-drill-body">${cards}</div>
          </details>`;
          })
          .join("")}
      </div>
      <p class="sub" style="margin:6px 2px 0;">逐次时长 = 发出 → 出结果的墙钟；输入/输出按需读取本机源文件，审批等待不可拆分。</p>` : toolsHtml}
    </div>
  `;

  // 按需加载该轮提问/思考文本（缓存按 session 生效，失败时诚实提示）
  loadDrawerTranscript(session, turn);

  d.classList.remove("collapsed");
  if (window.applyI18n) window.applyI18n();
}

// 五维下钻抽屉：点击会话详情的分布行 / 色段，弹出该维度全会话聚合视图
// （总结 + 逐条细分）。复用轮次抽屉面板，不新增页面。
function openDimensionDrawer(key, session) {
  const d = $("#detailDrawer");
  if (!d) return;
  const markEl = $("#drawerAgentMark");
  if (markEl) markEl.innerHTML = agentMark(session.agent);
  const titleEl = $("#drawerTurnTitle");
  if (titleEl) {
    titleEl.textContent = `${dimensionTitle(key)} · 会话下钻 · ${session.title || projectLabel(session.project)}`;
    titleEl.title = titleEl.textContent;
  }
  const prevBtn = $("#drawerPrevTurn");
  const nextBtn = $("#drawerNextTurn");
  if (prevBtn) prevBtn.disabled = true;
  if (nextBtn) nextBtn.disabled = true;

  // 清掉轮次胶囊高亮：当前抽屉展示的是维度聚合，不是某一轮
  $$(".turn-capsule.active").forEach((c) => c.classList.remove("active"));
  state.selectedTurnId = null;
  state.dimensionDrawerKey = key;

  const dim = breakdownDimension(key);
  const data = dimensionDrilldownData(session, key);
  const rowsHtml = data.rows.length
    ? data.rows
        .map((r) => {
          const aggRow = `
      <div class="tool-exec-card${r.slow ? " slow" : ""}" style="cursor:${r.calls ? "pointer" : "default"};">
        <div class="tool-exec-head">
          <strong>${h(r.label)}</strong>
          <span class="tool-exec-time${r.slow ? " slow" : ""}">${h(r.value)}</span>
        </div>
        ${r.sub ? `<div class="tool-exec-detail">${h(r.sub)}</div>` : ""}
      </div>`;
          if (!r.calls || !r.calls.length) return aggRow;
          // 聚合行可展开：逐次调用的起止时刻与时长（按耗时倒序）；
          // 输入/输出在展开后按需从本机源文件回填（data-call-at 匹配）
          return `
      <details class="dim-drill">
        <summary>${aggRow}</summary>
        <div class="dim-drill-body">
          ${r.calls
            .map(
              (c) => `
          <div class="tool-exec-card${c.slow ? " slow" : ""}" style="padding:7px 10px;" data-call-at="${c.at ?? ""}" data-call-turn="${h(c.turnId || "")}">
            <div class="tool-exec-head">
              <strong style="font-size:12px;">${h(c.label)}</strong>
              <span class="tool-exec-time${c.slow ? " slow" : ""}" style="font-size:11px;">${h(c.value)}</span>
            </div>
            <div class="tool-exec-detail">${h(c.sub)}${c.at != null ? ' · 输入/输出读取中…' : ""}</div>
          </div>`,
            )
            .join("")}
        </div>
      </details>`;
        })
        .join("")
    : `<div class="empty" style="padding:16px;">该维度在当前会话没有任何可计量的记录。</div>`;

  $("#drawerBody").innerHTML = `
    <div>
      <div class="drawer-section-label">${h(dim ? dim.label : key)} · 全会话聚合</div>
      <div class="drawer-transcript-box" style="font-weight:700; color:var(--fg-title);">${h(data.head)}</div>
      <div style="margin-top:12px;">
        ${rowsHtml}
      </div>
      ${data.note ? `<p class="drawer-transcript-note">${h(data.note)}</p>` : ""}
    </div>
  `;
  d.classList.remove("collapsed");
  if (window.applyI18n) window.applyI18n();

  // tool 维度：按需读取本机源文件，给每次调用回填输入/输出
  if (key === "tool") {
    const sessionAtClose = session;
    fetchSessionTranscript(session).then((entry) => {
      // 抽屉已被切换/关闭时放弃回填，防止串内容
      if (state.dimensionDrawerKey !== key || state.activeSessionId !== sessionAtClose.id) return;
      if (!entry || entry.status !== "ok") return;
      const byTurnId = new Map((entry.data?.turns || []).map((x) => [x.turn_id, x]));
      $$("#drawerBody .tool-exec-card[data-call-at][data-call-turn]").forEach((card) => {
        const tt = byTurnId.get(card.dataset.callTurn);
        if (!tt) return;
        const at = Number(card.dataset.callAt);
        const call = (tt.tool_calls || []).find((x) => x.at === at);
        if (!call) return;
        const detail = card.querySelector(".tool-exec-detail");
        if (!detail) return;
        if (detail.dataset.ioFilled === "1") return;
        detail.dataset.ioFilled = "1";
        detail.textContent = detail.textContent.replace(" · 输入/输出读取中…", "");
        const lines = [];
        if (call.detail) lines.push(`<b>输入</b> ${h(String(call.detail))}`);
        if (call.result) lines.push(`<b>输出</b> ${h(String(call.result))}`);
        if (lines.length)
          detail.insertAdjacentHTML(
            "beforeend",
            `<div class="tool-exec-io">${lines.join('<div class="tool-exec-io-sep"></div>')}</div>`,
          );
      });
    });
  }
}

function closeDrawer() {
  const d = $("#detailDrawer");
  if (d) d.classList.add("collapsed");
  state.selectedTurnId = null;
  state.dimensionDrawerKey = null;
  // 同步清掉轮次胶囊高亮
  $$(".turn-capsule.active").forEach((c) => c.classList.remove("active"));
}

// 上/下一轮切换：在当前会话的轮次序列上步进，openDrawer 内部会同步胶囊高亮
function navigateTurn(dir) {
  const s = detailSession();
  if (!s || state.selectedTurnId === null) return;
  const idx = s.turns.findIndex((t) => t.id === state.selectedTurnId);
  if (idx === -1) return;
  const target = s.turns[idx + dir];
  if (target) openDrawer(target, s);
}

// 会话 transcript 的统一取数（缓存共享给维度下钻的输入/输出回填）
async function fetchSessionTranscript(session) {
  let entry = state.transcriptCache.get(session.id);
  if (!entry) {
    try {
      entry = {
        status: "ok",
        data: await api(
          `/api/session/transcript?id=${encodeURIComponent(session.id)}`,
        ),
      };
    } catch (e) {
      entry = { status: "error", message: e.message };
    }
    state.transcriptCache.set(session.id, entry);
  }
  return entry;
}

// 按需拉取该会话的轮次提问/思考文本（GET /api/session/transcript），
// 按 session_id 缓存：同会话内切换轮次不重复请求
async function loadDrawerTranscript(session, turn) {
  const entry = await fetchSessionTranscript(session);
  renderDrawerTranscript(entry, session, turn);
}

function drawerHint(text) {
  return `<span class="drawer-missing-hint">${h(text)}</span>`;
}

// 把文本写进抽屉 DOM 前先确认抽屉仍停在这一轮，防止异步竞态串轮
function renderDrawerTranscript(entry, session, turn) {
  if (state.activeSessionId !== session.id || state.selectedTurnId !== turn.id)
    return;  const promptEl = $("#drawerPrompt");
  const cotEl = $("#drawerThinking");
  if (!promptEl || !cotEl) return;

  // 缓存只存 ok/error 两种终态（loading 占位由 innerHTML 直接给出）
  if (entry.status === "error") {
    promptEl.innerHTML = drawerHint(
      `无法按需读取本机源文件（${entry.message || "未知错误"}）。原始会话文件可能已被移动或删除；耗时统计不受影响。`,
    );
    cotEl.innerHTML = drawerHint("—");
    return;
  }

  const t = (entry.data?.turns || []).find((x) => x.turn_id === turn.id);
  const notes = entry.data?.missing_fields || [];
  // 工具卡输入/输出回填：按发出时刻匹配（transcript 与事件流同一配对语义）
  if (entry.status === "ok") {
    const tcalls = (t?.tool_calls || []).slice();
    $$("#drawerBody .tool-exec-card[data-call-at]").forEach((card) => {
      const at = Number(card.dataset.callAt);
      const call = tcalls.find((x) => x.at === at) || null;
      if (!call) return;
      const detail = card.querySelector(".tool-exec-detail");
      if (!detail) return;
      if (detail.dataset.ioFilled === "1") return;
      detail.dataset.ioFilled = "1";
      detail.textContent = detail.textContent.replace(" · 输入/输出读取中…", "");
      const lines = [];
      if (call.detail) lines.push(`<b>输入</b> ${h(String(call.detail))}`);
      if (call.result) lines.push(`<b>输出</b> ${h(String(call.result))}`);
      if (lines.length)
        detail.insertAdjacentHTML(
          "beforeend",
          `<div class="tool-exec-io">${lines.join('<div class="tool-exec-io-sep"></div>')}</div>`,
        );
    });
  }
  if (!t) {
    // 来源文件整体缺失/不可读时，后端会以 turns:[] + missing_fields 说明原因；
    // missing_fields 里可能混有思考链加密等与提问无关的说明，
    // 提问槽位必须给出提问自己的诚实文案，绝不串槽。
    promptEl.innerHTML = drawerHint("本机记录未包含该轮的提问文本。");
    cotEl.innerHTML = drawerHint(
      session.agent === "Codex"
        ? "Codex 官方记录对模型思考链加密，本机无法解密展示。"
        : "该来源未记录该轮的模型思考文本。",
    );
  } else {
    if (t.prompt) promptEl.textContent = t.prompt;
    else promptEl.innerHTML = drawerHint("本机记录未包含该轮的提问文本。");
    if (t.thinking) cotEl.textContent = t.thinking;
    else
      cotEl.innerHTML = drawerHint(
        session.agent === "Codex"
          ? "Codex 官方记录对模型思考链加密，本机无法解密展示。"
          : "该来源未记录该轮的模型思考文本。",
      );
    // 截断等诚实备注（missing_fields）只在抽屉内提示一次；
    // Codex 的 ZDR 说明已由思考槽位的降级文案展示，避免同一句话出现两遍
    const extraNotes = notes.filter(
      (n) => !(session.agent === "Codex" && n.includes("ZDR")),
    );
    if (extraNotes.length && !$("#drawerTranscriptNote")) {
      cotEl.insertAdjacentHTML(
        "afterend",
        `<p class="drawer-transcript-note" id="drawerTranscriptNote">${h(extraNotes.join("；"))}</p>`,
      );
    }
    // 工具调用明细行：transcript 中的 detail（命令 / 补丁内容）按 call_id 回填
    applyDrawerToolDetails(entry, turn);
  }
  if (window.applyI18n) window.applyI18n();
}

// 用按需读取的 transcript tool_calls[].detail 回填抽屉工具栈的第二行：
// 有 detail 显示操作明细（命令、补丁内容…），没有则保留原始工具名
function applyDrawerToolDetails(entry, turn) {
  if (entry.status !== "ok") return;
  const t = (entry.data?.turns || []).find((x) => x.turn_id === turn.id);
  const calls = t?.tool_calls || [];
  const byCall = new Map(
    calls
      .filter((c) => c.call_id && c.detail)
      .map((c) => [c.call_id, c.detail]),
  );
  if (!byCall.size) return;
  $$("#drawerBody .tool-exec-card[data-tool-call]").forEach((card) => {
    const detail = byCall.get(card.dataset.toolCall);
    if (!detail) return;
    const line = card.querySelector(".tool-exec-detail");
    if (line) {
      line.textContent = detail;
      line.title = detail;
    }
  });
}

function overview() {
  const s = state.report.summary;
  if (!s.sessions) return noData();

  const model = computeTimelineModel();
  // 接入工具筛选：只收窄双列榜（TOP 3 + 操作分布）的聚合口径，
  // 在 sessionSummaries 进入视口聚合前过滤；热力图与视口拖拽不受影响
  const agent = effectiveOverviewAgent();
  const scopedModel =
    agent === "all"
      ? model
      : (() => {
          const summaries = model.sessionSummaries.filter(
            (i) => i.session.agent === agent,
          );
          return { ...model, sessionSummaries: summaries, visibleSessions: summaries };
        })();

  return `
    ${stats()}
    ${funnel()}
    ${trendCard()}
    ${timeline(model)}
    <div class="s1-grid">
      ${topSessionsCard(scopedModel)}
      ${viewportBreakdownCard(scopedModel)}
    </div>
    ${viewportAggregationCard(scopedModel)}
    ${adviceCards()}
    ${sessionStream()}
  `;
}

function table(rows) {
  if (!rows.length) return '<div class="empty">没有匹配的会话记录。</div>';
  return `<div class="tablewrap" tabindex="0" aria-label="会话明细列表">
    <table>
      <thead>
        <tr>
          <th>项目 / 会话</th>
          <th>工具接入</th>
          <th>本期累计工作时长</th>
          <th>已测量轮次</th>
          <th>最近活动</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((s) => {
            const lastAt = Math.max(...s.turns.map((t) => t.start_ms || t.end_ms || 0));
            const pName = projectLabel(s.project);
            const displayTitle = s.title ? h(s.title) : h(pName);
            const subTitle = `${h(pName)} · ${h(s.id.slice(0, 16))}`;
            return `
              <tr>
                <td>
                  <button class="textbtn" data-session="${h(s.id)}" style="text-align:left;">
                    <strong style="display:block; font-size:13px; color:var(--ink); line-height:1.4;">${displayTitle}</strong>
                    <span style="display:block; font-size:11px; color:var(--fg-muted); font-family:var(--font-mono); margin-top:2px;">${subTitle}</span>
                  </button>
                </td>
                <td class="agent-cell">${agentMark(s.agent)}<span class="tag">${h(s.agent)}</span></td>
                <td style="font-weight:700; font-family:var(--font-mono);">${fmt(s.measured_turns ? s.period_ms : null)}</td>
                <td><span class="tag ${s.measured_turns === s.turns.length ? "" : "warn"}">${s.measured_turns}/${s.turns.length}</span></td>
                <td style="color:var(--fg-muted); font-family:var(--font-mono);">${h(stamp(lastAt))}</td>
                <td>
                  <button class="btn" data-session="${h(s.id)}" aria-label="下钻会话明细">下钻明细 →</button>
                </td>
              </tr>
            `;
          })
          .join("")}
      </tbody>
    </table>
  </div>`;
}

function filtered() {
  const needle = state.query.trim().toLowerCase();
  const rows = state.report.sessions.filter((s) =>
    (s.project + " " + projectLabel(s.project) + " " + s.id + " " + s.agent + " " + (s.title || "")).toLowerCase().includes(needle),  );
  return state.sort === "duration"
    ? rows.sort((a, b) => (b.period_ms || 0) - (a.period_ms || 0))
    : rows;
}

function sessions() {
  return `
    <div class="panelhead">
      <div style="display:flex; gap:10px; align-items:center; flex:1;">
        <input id="search" type="search" aria-label="搜索会话" placeholder="搜索项目、工具或会话 ID…" style="flex:1; max-width:360px;">
        <select id="sort" aria-label="会话排序">
          <option value="recent" ${state.sort === "recent" ? "selected" : ""}>最近开始</option>
          <option value="duration" ${state.sort === "duration" ? "selected" : ""}>处理耗时最多</option>
        </select>
      </div>
      <div style="display:flex; gap:10px; align-items:center;">
        <button class="btn" data-action="export">导出当前明细 CSV</button>
        <span class="sub">${filtered().length} 个会话</span>
      </div>
    </div>
    <section class="panel">
      ${table(filtered())}
    </section>
  `;
}

function compare() {
  const groups = new Map();
  for (const s of state.report.sessions) {
    for (const t of s.turns) {
      const label =
        t.models.length === 1
          ? t.models[0]
          : t.models.length
            ? "多个模型上下文"
            : "模型未知";
      const g = groups.get(label) || { ms: 0, n: 0, unknown: 0 };
      if (t.period_ms === null) g.unknown++;
      else {
        g.ms += t.period_ms;
        g.n++;
      }
      groups.set(label, g);
    }
  }

  return `
    <div class="demo">
      <strong>口径提示</strong>
      <span>当前接入 Codex、Claude Code、Pi、Antigravity、DeepSeek Harness、OpenCode 与 Oh-My-Pi，按模型上下文分组，耗时更短不等于质量更优。</span>
    </div>
    <section class="panel">
      <div class="panelhead"><h2>按模型上下文汇总</h2></div>
      ${groups.size ? `
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>模型名称 / 上下文</th>
                <th>本期累计工作时长</th>
                <th>已测量 / 未测量轮次</th>
              </tr>
            </thead>
            <tbody>
              ${[...groups].map(([key, g]) => `
                <tr>
                  <td><strong>${h(key)}</strong></td>
                  <td style="font-family:var(--font-mono); font-weight:700;">${fmt(g.n ? g.ms : null)}</td>
                  <td>${g.n} / ${g.unknown}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty">这个时间范围还没有可分组的记录。</div>'}
    </section>
  `;
}

function directoryDraft(item) {
  return (
    state.drafts[item.agent] || {
      path: item.path || "",
      enabled: item.enabled,
      reset: false,
    }
  );
}

function directoryCards() {
  const labels = {
    directory: "目录存在",
    missing: "目录尚不存在",
    not_directory: "此位置不是目录",
    unreadable: "目录无法读取或路径无效",
    unverified: "默认位置待验证",
  };
  return `<div class="directory-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(320px, 1fr)); gap:16px; margin-bottom:20px;">
    ${state.directories
      .map((item) => {
        const draft = directoryDraft(item);
        const dirty = Boolean(state.drafts[item.agent]);
        const saving = state.saving.has(item.agent);
        return `
          <section class="panel directory-card" data-directory-card="${h(item.agent)}">
            <div class="panelhead">
              <h2>${h(item.name)}</h2>
              <span class="tag ${item.supported ? "" : "warn"}">${item.supported ? "可接入" : "尚未适配"}</span>
            </div>
            <label class="sub" for="directory-${h(item.agent)}">${item.agent === "opencode" ? "会话数据目录" : "工具数据目录"}</label>
            <div style="display:flex; gap:8px; margin:8px 0;">
              <input id="directory-${h(item.agent)}" data-directory-input="${h(item.agent)}" type="text" spellcheck="false" autocomplete="off" ${saving ? "disabled" : ""} value="${h(draft.path)}" placeholder="${h(item.default_path || "默认位置未确定")}" style="flex:1;">
              <button class="btn" ${saving ? "disabled" : ""} data-reset-directory="${h(item.agent)}">恢复默认</button>
            </div>
            <p class="sub" style="margin-bottom:12px;">${dirty ? "有未保存的更改；保存后重新检测" : h(labels[item.status]) + " · " + h({ custom: "自定义目录", environment: "来自环境变量", default: "按上游默认规则推导", unresolved: "当前环境无法确定" }[item.source])}</p>
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <label style="display:flex; align-items:center; gap:6px; font-size:12px;">
                <input type="checkbox" data-directory-enabled="${h(item.agent)}" ${draft.enabled ? "checked" : ""} ${item.supported && !saving ? "" : "disabled"}>
                从此目录读取会话
              </label>
              <button class="btn ${item.supported ? "primary" : ""}" data-save-directory="${h(item.agent)}" ${saving ? "disabled" : ""}>
                ${saving ? `${spinnerIcon()}保存中…` : draft.enabled ? "保存并同步" : "保存设置"}
              </button>
            </div>
          </section>
        `;
      })
      .join("")}
  </div>`;
}

function sources() {
  return `
    <div class="demo">
      <strong>隐私安全承诺</strong>
      <span>${h(state.sources.privacy)} 仅扫描会话历史事件，不读取凭据，不采集 Prompt 源码内容。</span>
    </div>
    ${directoryCards()}
    <section class="panel">
      <div class="panelhead">
        <h2>本地会话源同步状态</h2>
        <span class="tag">已登记 ${state.sources.registered_files} 个文件</span>
      </div>
      <p class="sub">上次成功导入：${h(state.sources.last_imported_at_utc || "尚未导入")}${state.sources.last_imported_at_utc ? " UTC" : ""}</p>
    </section>
  `;
}

// 单卡与全局同步共用同一份请求体语义：路径未编辑/已清空/显式恢复默认都回落到默认位置。
function directoryPayload(agent, draft) {
  const item = state.directories.find((x) => x.agent === agent);
  return {
    agent,
    path:
      draft.reset ||
      draft.path === "" ||
      (!draft.pathEdited && item.source !== "custom")
        ? null
        : draft.path,
    enabled: draft.enabled,
  };
}

async function persistDirectory(agent, draft) {
  await api("/api/directories", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AgentTime": "1" },
    body: JSON.stringify(directoryPayload(agent, draft)),
  });
  delete state.drafts[agent];
}

// 全局「同步记录」的先决步骤：把所有未保存的接入草稿批量落盘。勾选开关只写
// 前端草稿，而 /api/refresh 按服务端已保存配置同步——不先落盘，用户「勾完直接
// 点同步」会表现为没有任何效果（反馈轮 4 #2/#5 同根因）。
async function persistDrafts() {
  let saved = 0;
  for (const agent of Object.keys(state.drafts)) {
    if (!state.directories.some((x) => x.agent === agent)) {
      delete state.drafts[agent];
      continue;
    }
    await persistDirectory(agent, directoryDraft(state.directories.find((x) => x.agent === agent)));
    saved++;
  }
  return saved;
}

async function saveDirectory(agent) {
  if (state.saving.has(agent) || state.busy) return;
  const item = state.directories.find((x) => x.agent === agent);
  const draft = directoryDraft(item);
  state.saving.add(agent);
  if (draft.enabled) setSyncState(true, `正在保存并同步 ${item?.name || agent}…`);
  render();
  try {
    await persistDirectory(agent, draft);
    await load();
    if (draft.enabled) {
      // 交由 refresh() 接管同步状态与 finally 清理
      state.busy = false;
      await refresh();
    } else {
      toast("目录设置已保存。");
    }
  } catch (e) {
    setSyncState(false);
    error(e.message);
  } finally {
    state.saving.delete(agent);
    render();
  }
}

function editDirectory(agent, field, value) {
  const item = state.directories.find((x) => x.agent === agent);
  state.drafts[agent] = { ...directoryDraft(item), [field]: value };
  if (field === "path") {
    state.drafts[agent].reset = false;
    state.drafts[agent].pathEdited = true;
  }
  render();
}

function open(html, wide = false) {
  focusBeforeDialog = document.activeElement;
  $("#layer").innerHTML =
    `<div class="overlay" data-overlay><section class="${wide ? "modal-wide" : "modal"}" role="dialog" aria-modal="true" aria-labelledby="dialogtitle" tabindex="-1">${html}</section></div>`;
  document.body.style.overflow = "hidden";
  $("#layer [role=dialog]").focus();
  if (window.applyI18n) window.applyI18n();
}

function close() {
  const focus = focusBeforeDialog;
  $("#layer").innerHTML = "";
  document.body.style.overflow = "";
  if (focus?.isConnected) focus.focus();
}

function head(title, sub = "") {
  return `
    <div class="drawerhead">
      <div>
        <h2 id="dialogtitle">${h(title)}</h2>
        <p class="sub">${h(sub)}</p>
      </div>
      <button class="close" data-action="close" aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `;
}

// 完整会话弹窗：保留所有轮次查阅能力与无障碍支持，同时允许点击下钻抽屉
function details(id) {
  const s = state.report.sessions.find((s) => s.id === id);
  if (!s) return;

  const turnsHtml = s.turns.map((t, i) => {
    return `
      <article class="panel" style="padding:14px; margin-bottom:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <strong>第 ${i + 1} 轮</strong>
          <span class="tag ${t.elapsed_ms === null ? "warn" : ""}">${statuses[t.status]}</span>
        </div>
        <p class="sub" style="margin-bottom:8px;">${h(t.models.join(" / ") || "模型上下文未知")}</p>
        <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:10px;">
          <span>本轮时长: <strong>${fmt(t.elapsed_ms)}</strong></span>
          <span>本期分摊计入: <strong>${fmt(t.period_ms)}</strong></span>
          <span>AI 工作：<strong>${t.work_ms !== null ? fmt(t.work_ms) : "未切分"}</strong></span>
        </div>
        <div style="display:flex; justify-content:flex-end;">
          <button class="btn" data-drill-turn="${h(t.id)}" data-drill-session="${h(s.id)}">在侧边抽屉下钻明细 →</button>
        </div>
      </article>
    `;
  }).join("");

  open(
    `${head(s.title || projectLabel(s.project), `${projectLabel(s.project)} · ${s.agent} · ${s.id}`)}     <p class="sub" style="margin-bottom:16px;">仅显示当前日期范围涉及的轮次。完整轮次时长与本期分摊分别列出。</p>
     <div style="max-height:60vh; overflow-y:auto;">
       ${turnsHtml}
     </div>`,
    true,
  );
}

function definitions() {
  open(
    `${head("这些时间怎么算？")}
     <p class="sub" style="line-height:1.7; font-size:13px;">会话是同一任务的交互集合；一轮交互从你提交问题或指令到 Agent 完成答复。工具调用与等待确认均精确切分。</p>
     <div class="tablewrap" style="margin-top:12px;">
       <table style="font-size:12px;">
         <thead>
           <tr><th>展示词</th><th>口径术语</th><th>字段 / 计算式</th></tr>
         </thead>
         <tbody>
           <tr><td>累计工作时长</td><td class="sub">—</td><td><code>processing_ms</code></td></tr>
           <tr><td>并行去重时长</td><td class="sub">—</td><td><code>processing_union_ms</code></td></tr>
           <tr><td>总时长</td><td class="sub">wall time</td><td><code>sessionWallSpan</code></td></tr>
           <tr><td>本轮时长</td><td class="sub">wall time</td><td><code>elapsed_ms</code></td></tr>
           <tr><td>AI 工作</td><td class="sub">Active Work Duration</td><td><code>work_ms</code> = <code>model_ms</code> + tool execution</td></tr>
           <tr><td>等待确认</td><td class="sub">Review Wait</td><td><code>review_wait_ms</code></td></tr>
           <tr><td>中途停了</td><td class="sub">Idle Gap</td><td><code>idle_gap_ms</code>（≥2 分钟无源事件）</td></tr>
           <tr><td>轮间间隔</td><td class="sub">Standby Duration</td><td><code>standby_ms</code></td></tr>
           <tr><td>自动完成度</td><td class="sub">Autonomy Rate</td><td><code>autonomy_rate</code></td></tr>
           <tr><td>超 15s 慢操作</td><td class="sub">Slow Operation Count</td><td><code>slow_ops</code></td></tr>
           <tr><td>本地工具</td><td class="sub">Tool Execution Duration</td><td>tool execution</td></tr>
           <tr><td>模型想和写</td><td class="sub">Model API Duration</td><td><code>model_ms</code>（含思考与输出，整条落盘不可再分）</td></tr>
         </tbody>
       </table>
     </div>
     <p class="sub" style="margin-top:10px; font-size:12px;">「—」表示 GLOSSARY 无独立条目，口径以字段名为准。</p>
     <p class="sub" style="margin-top:6px; font-size:12px;">说明：「自动完成度」是同一指标的展示层说法，口径术语仍为 Autonomy Rate；GLOSSARY 本轮不变。</p>`,
    true,
  );
}

function toast(message) {
  $("#live").innerHTML = `<div class="session-pill" style="position:fixed; bottom:24px; right:24px; z-index:9999; background:#FAF9F5; box-shadow:var(--shadow-lg);">${h(message)}</div>`;
  setTimeout(() => ($("#live").innerHTML = ""), 4500);
}

function exportCSV() {
  const data = [
    [
      "session",
      "project",
      "agent",
      "period_processing_ms",
      "measured_rounds",
      "observed_rounds",
      "work_ms",
      "review_wait_ms",
      "start_date",
      "end_date",
      "timezone",
      "basis",
    ],
    ...filtered().map((s) => [
      s.id,
      s.project,
      s.agent,
      s.measured_turns ? s.period_ms : "",
      s.measured_turns,
      s.turns.length,
      s.work_ms ?? "",
      s.review_wait_ms ?? "",
      state.start,
      state.end,
      timezone,
      state.report.basis,
    ]),
  ];
  const cell = (v) => {
    let x = String(v ?? "");
    if (/^\s*[=+@-]|^[\t\r\n]/.test(x)) x = "'" + x;
    return '"' + x.replaceAll('"', '""') + '"';
  };
  const url = URL.createObjectURL(
    new Blob(["\uFEFF" + data.map((r) => r.map(cell).join(",")).join("\r\n")], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "agenttime-local-sessions.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refresh() {
  if (state.busy) return;
  setSyncState(true, state.syncPhase || "正在扫描并解析本地会话记录…");
  try {
    // 先落盘所有未保存的接入改动，再按服务端配置同步（反馈轮 4 #2/#5）
    const savedCount = await persistDrafts();
    setSyncState(true, "正在扫描并解析本地会话记录…");
    const r = await api("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentTime": "1" },
      body: "{}",
    });
    await load();
    // 失败 toast 点名具体文件（≤3 个 + 等 N 个），不再是无人格的计数
    const failNames = [
      ...new Set((r.failures || []).flatMap((f) => f.files || [])),
    ];
    const named = failNames.slice(0, 3).join("、");
    const failDetail = named
      ? `（${named}${r.failed > failNames.length ? ` 等 ${r.failed} 个` : ""}）`
      : "";
    toast(
      (savedCount ? `已保存 ${savedCount} 项接入设置，` : "") +
        `成功更新 ${r.updated} 个文件` +
        (r.excluded ? `，${r.excluded} 个分支副本按设计排除` : "") +
        (r.failed ? `，${r.failed} 个失败${failDetail}` : ""),
    );
    if (r.failed) {
      open(
        `${head("部分记录未能导入", `已更新 ${r.updated} 个文件，失败 ${r.failed} 个。`)}
         <p class="sub">首次导入失败的文件不会生成统计；此前已成功导入的记录会保留旧快照。</p>
         ${r.excluded ? `<p class="sub">另有 ${r.excluded} 个分支副本按设计排除（见下方说明），不计入失败。</p>` : ""}
         <h3>失败原因</h3>
         ${(r.failures || []).map((item) => `<p>${h(item.reason)} <strong>（${h(item.count)} 个文件）</strong></p>`).join("") || "<p>服务未提供详细失败原因。</p>"}`,
      );
    } else if (r.excluded) {
      open(
        `${head("部分记录按设计排除", `已更新 ${r.updated} 个文件，无失败。`)}
         <h3>排除原因</h3>
         ${(r.exclusions || []).map((item) => `<p>${h(item.reason)} <strong>（${h(item.count)} 个文件）</strong></p>`).join("") || "<p>服务未提供详细说明。</p>"}
         <p class="sub">这些文件是 Codex 为已导入会话生成的分叉快照：内容为父会话历史的复印件，不含子 Agent 的实际工作（子 Agent 的耗时已计入父会话）。导入它们会把同一段工作重复计时，因此保持排除。</p>`,
      );
    }
  } catch (e) {
    error(e.message);
  } finally {
    setSyncState(false);
    // 手动同步已在 load() 里拿到最新数据：重置基线，避免下一轮 pulse 把
    // 这次 revision 误判为「有新变化」再刷一遍
    lastPulse = null;
  }
}

// 全局事件监听委托
document.addEventListener("click", async (e) => {
  // 0. 方案 A 会话卡片 / TOP 榜行：写入 #session/:id 哈希进入独立详情页
  //    （路由解析由后续切片落地；id 内含 "/"，需 encodeURIComponent）
  const sessionCard = e.target.closest("[data-open-session]");
  if (sessionCard) {
    location.hash = "#session/" + encodeURIComponent(sessionCard.dataset.openSession);
    return;
  }

  // 0.4 五维分布行 / 色段：打开维度下钻抽屉（全会话聚合）
  const dimRow = e.target.closest("[data-dim-row]");
  if (dimRow) {
    const s = detailSession();
    if (s) openDimensionDrawer(dimRow.dataset.dimRow, s);
    return;
  }

  // 0.5 轮次胶囊 / 慢操作榜单行：打开右侧 Turn Inspector 抽屉
  const capsule = e.target.closest("[data-turn-capsule]");
  if (capsule) {
    const s = detailSession();
    const t = s && s.turns.find((x) => x.id === capsule.dataset.turnCapsule);
    if (s && t) openDrawer(t, s);
    return;
  }

  // 0.6 接入工具筛选芯片：收窄会话流 / TOP 3 榜 / 视口操作分布
  const chip = e.target.closest("[data-agent-chip]");
  if (chip) {
    state.overviewAgent = chip.dataset.agentChip;
    render();
    return;
  }

  // 1. 会话弹窗内下钻按钮
  const drillBtn = e.target.closest("[data-drill-turn]");
  if (drillBtn) {
    const sId = drillBtn.dataset.drillSession;
    const tId = drillBtn.dataset.drillTurn;
    close();
    const s = state.report.sessions.find((x) => x.id === sId);
    if (s) {
      const t = s.turns.find((x) => x.id === tId);
      if (t) openDrawer(t, s);
    }
    return;
  }

  const b = e.target.closest("button") || e.target.closest("[data-page]");
  if (!b) {
    if (e.target.matches("[data-overlay]")) close();
    return;
  }

  if (b.dataset.page) {
    state.page = b.dataset.page;
    // 从详情页点击侧边导航：清掉 #session/:id 哈希，避免下一次 applyRoute 又跳回详情
    if (parseSessionHash()) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    render();
    window.scrollTo(0, 0);
  }

  if (b.dataset.range) {
    if (b.dataset.range === "custom") {
      // 自选段按钮：直接打开日期选择（选中态与区段展示由下方 ranges 渲染承担）
      document.querySelector('[data-action="dates"]')?.click();
    } else {
      state.range = b.dataset.range;
      state.end = localDate();
      state.start = previous(
        state.end,
        state.range === "today" ? 0 : state.range === "week" ? 6 : 29,
      );
      saveView();
      await load();
    }
  }

  if (b.dataset.trendGran) {
    // 趋势粒度切换：纯视图状态，数据不变，重渲染即可；随视图持久化
    if (["day", "week"].includes(b.dataset.trendGran)) {
      state.trendGran = b.dataset.trendGran;
      state.trendGranManual = true; // 用户手动选粒度后不再自动切换
      saveView();
      render();
    }
  }

  if (b.dataset.session) {
    // 会话表下钻入口统一改为 #session/:id 详情页路由（旧弹窗 details() 保留但不再从此进入）
    location.hash = "#session/" + encodeURIComponent(b.dataset.session);
  }

  if (b.dataset.saveDirectory) await saveDirectory(b.dataset.saveDirectory);

  if (b.dataset.resetDirectory) {
    const agent = b.dataset.resetDirectory;
    const item = state.directories.find((x) => x.agent === agent);
    state.drafts[agent] = {
      ...directoryDraft(item),
      path: item.default_path || "",
      reset: true,
      pathEdited: false,
    };
    render();
  }

  switch (b.dataset.action) {
    case "close":
      close();
      break;
    case "back-overview":
      goOverview();
      break;
    case "close-drawer":
      closeDrawer();
      break;
    case "prev-turn":
      navigateTurn(-1);
      break;
    case "next-turn":
      navigateTurn(1);
      break;
    case "definitions":
      definitions();
      break;
    case "refresh":
      await refresh();
      break;
    case "export":
      exportCSV();
      break;
    case "export-report":
      exportWeeklyReport();
      break;
    case "share-card":
      openShareCardModal();
      break;
    case "download-share-card": {
      if (!lastShareCardUrl) break;
      const a = document.createElement("a");
      a.href = lastShareCardUrl;
      a.download = `agenttime-card-${state.start}-to-${state.end}.png`;
      a.click();
      break;
    }
    case "copy-share-card": {
      if (!lastShareCardUrl || !navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
        toast("当前环境不支持直接复制图片，请点击下载 PNG。");
        break;
      }
      try {
        const res = await fetch(lastShareCardUrl);
        const blob = await res.blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        toast("已复制分享图片到剪贴板。");
      } catch {
        toast("复制失败，请点击下载 PNG。");
      }
      break;
    }
    case "onboard-enable-all": {
      if (state.busy) break;
      const detected = (state.directories || []).filter(
        (d) => d.status === "directory" && !d.enabled,
      );
      if (!detected.length) break;
      setSyncState(true, `正在接入已检测到的 ${detected.length} 个工具…`);
      render();
      try {
        for (let i = 0; i < detected.length; i++) {
          const d = detected[i];
          setSyncState(true, `正在启用第 ${i + 1}/${detected.length} 个工具（${d.name}）…`);
          await persistDirectory(d.agent, {
            path: d.path,
            enabled: true,
            reset: false,
          });
        }
        // 交由 refresh() 触发全量扫描并统一在 finally 中清理同步态
        state.busy = false;
        state.syncPhase = "正在扫描并解析已接入工具的会话记录…";
        await refresh();
      } catch (err) {
        setSyncState(false);
        render();
        error(err.message);
      }
      break;
    }
    case "toggle-lang":
      if (window.toggleUiLang) {
        window.toggleUiLang();
        render();
        if ($("#layer [role=dialog]")) close();
      }
      break;
    case "dates":
      open(
        `${head("选择统计日期", "按浏览器时区计算；结束日期包含当天，最多 367 天。")}
         <div style="display:flex; gap:12px; margin:14px 0;">
           <label style="flex:1;">开始日期<br><input type="date" id="start" value="${h(state.start)}" style="width:100%;"></label>
           <label style="flex:1;">结束日期<br><input type="date" id="end" value="${h(state.end)}" style="width:100%;"></label>
         </div>
         <p id="dateerror" role="alert" class="sub" style="color:#B91C1C; margin-bottom:12px;"></p>
         <button class="btn primary" data-action="apply-dates">应用日期</button>`,
      );
      break;
    case "apply-dates": {
      const a = $("#start").value;
      const z = $("#end").value;
      if (!a || !z || a > z || (new Date(z) - new Date(a)) / 86400000 > 366) {
        $("#dateerror").textContent = "请选择有效日期，开始不晚于结束，最多 367 天。";
        break;
      }
      state.start = a;
      state.end = z;
      state.range = "custom";
      saveView();
      close();
      await load();
      break;
    }
  }
});

document.addEventListener("input", (e) => {
  if (e.target.dataset.directoryInput)
    editDirectory(e.target.dataset.directoryInput, "path", e.target.value);
  if (e.target.id === "search") {
    const pos = e.target.selectionStart;
    state.query = e.target.value;
    $("#content").innerHTML = sessions();
    $("#search").value = state.query;
    $("#search").focus();
    $("#search").setSelectionRange(pos, pos);
  }
});

document.addEventListener("change", (e) => {
  if (e.target.dataset.directoryEnabled)
    editDirectory(e.target.dataset.directoryEnabled, "enabled", e.target.checked);
  if (e.target.id === "sort") {
    state.sort = e.target.value;
    render();
  }
});

// ESC 键随手关闭抽屉与弹层；弹层打开时 Tab 焦点在弹层内循环
document.addEventListener("keydown", (e) => {
  // 键盘可达性：会话卡片 / 轮次胶囊 / TOP 榜行支持 Enter / Space 激活
  if ((e.key === "Enter" || e.key === " ") && e.target instanceof Element) {
    const card = e.target.closest("[data-open-session]");
    if (card) {
      e.preventDefault();
      location.hash = "#session/" + encodeURIComponent(card.dataset.openSession);
      return;
    }
    const capsule = e.target.closest("[data-turn-capsule]");
    if (capsule) {
      e.preventDefault();
      capsule.click();
      return;
    }
  }

  const dialog = $("#layer [role=dialog]");
  if (dialog) {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "Tab") {
      const els = [...dialog.querySelectorAll("button,input,select,a[href]")];
      const first = els[0];
      const last = els.at(-1);
      if (!first) {
        e.preventDefault();
        return;
      }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        e.preventDefault();
        first.focus();
      }
    }
    return;
  }

  if (e.key === "Escape") {
    const d = $("#detailDrawer");
    if (d && !d.classList.contains("collapsed")) {
      closeDrawer();
      return;
    }
  }

  // 抽屉打开时 ← / → 在轮次间步进（胶囊高亮随 openDrawer 同步）
  if (
    (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
    state.selectedTurnId !== null
  ) {
    const tag = e.target instanceof Element ? e.target.tagName : "";
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
      const d = $("#detailDrawer");
      if (d && !d.classList.contains("collapsed")) {
        e.preventDefault();
        navigateTurn(e.key === "ArrowLeft" ? -1 : 1);
      }
    }
  }
});

// #session/:id 哈希路由：deep-link、浏览器前进/后退、卡片点击统一由此驱动
window.addEventListener("hashchange", applyRoute);

// 首次引导：先恢复持久化的视图状态（日期区段），再解析地址栏深链（如
// #session/claude%2Fxxx）并拉取数据渲染
restoreView();
applyRoute();
load();
// 实时账本：源记录变化由服务端自动重导，这里只负责感知并刷新视图
setInterval(pulseLoop, 5000);
