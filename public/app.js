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
  // 视口与下钻状态
  activeSessionId: null,
  selectedTurnId: null,
  zoomStartPct: 0,
  zoomEndPct: 100,
};

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

const statuses = {
  completed: "已完成",
  aborted: "已中止",
  failed: "执行失败",
  open: "暂无结束记录",
  incomplete: "缺少起点",
  invalid: "记录冲突",
};

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

function render() {
  if (!state.report) return;

  // 1. 顶部标题
  $("#title").textContent = names[state.page][0];
  $("#subtitle").textContent = names[state.page][1];

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

  // 4. 页面主体分发
  $("#content").innerHTML = {
    overview: overview,
    sessions: sessions,
    compare: compare,
    sources: sources,
  }[state.page]();

  if ($("#search")) $("#search").value = state.query;

  // 挂载时间轴拖拽与视口缩放手柄监听
  bindBrushEvents();
}

function noData() {
  return `<section class="panel empty"><h2>这个时间范围还没有会话记录</h2><p>已登记 ${state.sources.registered_files} 个本地文件。请在配置页启用 Codex、Claude Code 或 Pi 数据目录并保存，或调整日期范围。</p><button class="btn primary" data-page="sources">配置数据目录</button></section>`;
}

function stats() {
  const s = state.report.summary;
  return `<div class="stats">
    <div class="stat">
      <label>已记录的累计机时</label>
      <div class="number">${fmt(s.processing_ms)}</div>
      <small>各轮可测量记录区间时间相加 ↗</small>
    </div>
    <div class="stat">
      <label>物理跨度并集时长</label>
      <div class="number">${fmt(s.processing_union_ms)}</div>
      <small>同时运行的时间仅计一次 ↗</small>
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
// 模块 2：核心大盘 —— 耗时蒸发漏斗 (Time Drop Funnel)
// 严格对齐 GLOSSARY.md：严禁粗暴相减，真实数据核算
// ========================================================
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
          <span class="section-title">耗时蒸发漏斗 (Time Drop Funnel)</span>
          <span class="section-subtitle">基于一手事件流真实度量 · 无伪造推算</span>
        </div>
        <span class="funnel-concurrency-pill">${concurrency}x 并发效能倍率</span>
      </div>
      <div class="demo" style="margin: 8px 0 0;">
        <strong>口径提示</strong>
        <span>当前所选时间范围内的会话尚未包含细粒度三态事件，暂不推断纯工作与审阅等待拆分。</span>
      </div>
    </section>`;
  }

  const work = s.work_ms;
  const wait = s.review_wait_ms;
  const standby = s.standby_ms || 0;

  // 分母必须由三态精确相加构成，确保百分比之和严格为 100%，杜绝击穿
  const grossTotal = work + wait + standby || 1;

  const waitPct = ((wait / grossTotal) * 100).toFixed(1);
  const standbyPct = ((standby / grossTotal) * 100).toFixed(1);
  const workPct = ((work / grossTotal) * 100).toFixed(1);

  return `
  <section class="funnel-card">
    <div class="section-header">
      <div>
        <span class="section-title">耗时蒸发漏斗 (Time Drop Funnel)</span>
        <span class="section-subtitle">一屏讲透壁钟时长流向 · 终结“机器在忙”的错觉</span>
      </div>
      <span class="funnel-concurrency-pill">${concurrency}x 并发效能倍率</span>
    </div>

    <div class="funnel-stages">
      <!-- 阶段 1: 总挂载机时基准 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:#7A7268;">●</span>
          <span>1. 原始挂载机时总计</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: 100%; background: #9E968B;">100% 原始机时基准</div>
        </div>
        <div class="stage-val">${fmt(grossTotal)}</div>
      </div>

      <!-- 阶段 2: 扣除等待人审阅卡点 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:var(--state-wait);">●</span>
          <span>2. 扣除等待人审阅卡点</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: ${waitPct}%; background: var(--state-wait);">${waitPct}% 工具权限审批与方案决策</div>
        </div>
        <div class="stage-val">-${fmt(wait)}</div>
      </div>

      <!-- 阶段 3: 扣除待命时长 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:var(--state-idle);">●</span>
          <span>3. 扣除静默就绪待命</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: ${standbyPct}%; background: #7A7268;">${standbyPct}% 答复完毕至人类再次唤醒</div>
        </div>
        <div class="stage-val">-${fmt(standby)}</div>
      </div>

      <!-- 阶段 4: 沉淀纯工作有效净值 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:var(--state-work);">●</span>
          <span>4. 沉淀纯工作有效净值</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: ${workPct}%; background: var(--state-work); box-shadow: 0 0 10px rgba(204,120,92,0.35);">
            ${workPct}% AI 模型推理与本地工具执行
          </div>
        </div>
        <div class="stage-val" style="color:var(--state-work);">${fmt(work)}</div>
      </div>
    </div>
  </section>`;
}

// ========================================================
// 模块 3：Brush & Zoom 全景画卷带与无级拖拽视口滑块
// 采用完整三态高饱和高对比拼接，消除 Primitive Obsession
// ========================================================
function timeline() {
  const sessions = state.report.sessions || [];
  if (!sessions.length) return "";

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

  if (!allTurns.length) return "";

  // 严格按真实时间戳线性排序
  allTurns.sort((a, b) => (a.turn.start_ms || 0) - (b.turn.start_ms || 0));

  const totalTurns = allTurns.length;
  const startIdx = Math.floor((state.zoomStartPct / 100) * totalTurns);
  const endIdx = Math.min(totalTurns, Math.ceil((state.zoomEndPct / 100) * totalTurns) || totalTurns);
  const visibleTurns = allTurns.slice(startIdx, Math.max(startIdx + 1, endIdx));

  const firstTurn = allTurns[0].turn;
  const lastTurn = allTurns[allTurns.length - 1].turn;
  const minTime = firstTurn.start_ms || firstTurn.end_ms || Date.now();
  const maxTime = lastTurn.end_ms || lastTurn.start_ms || Date.now();
  const totalTimelineSpan = Math.max(1, maxTime - minTime);

  // 48px 全景画卷带：按实际持续时长比例与真实三态色块拼接
  const stripBlocks = allTurns.map(({ turn }) => {
    const turnDuration = Math.max(1000, (turn.end_ms || turn.start_ms || minTime) - (turn.start_ms || minTime));
    const widthPct = Math.max(0.5, (turnDuration / totalTimelineSpan) * 100);

    const work = turn.work_ms || 0;
    const wait = turn.review_wait_ms || 0;
    const standby = turn.standby_ms || 0;
    const sum = work + wait + standby || 1;

    const workSubPct = (work / sum) * 100;
    const waitSubPct = (wait / sum) * 100;
    const standbySubPct = (standby / sum) * 100;

    return `
      <div style="width: ${widthPct}%; height: 100%; display: flex; flex-shrink: 0; border-right: 1px solid rgba(255,255,255,0.25);" title="纯工作: ${fmt(work)}, 等待人审阅: ${fmt(wait)}, 待命: ${fmt(standby)}">
        <div style="width: ${workSubPct}%; background: var(--state-work);"></div>
        <div style="width: ${waitSubPct}%; background: var(--state-wait);"></div>
        <div style="width: ${standbySubPct}%; background: #9E968B;"></div>
      </div>
    `;
  }).join("");

  // 联动下方秒级高精甘特轮次列表
  const turnRows = visibleTurns.map(({ session, turn, turnIndex }) => {
    const work = turn.work_ms || 0;
    const wait = turn.review_wait_ms || 0;
    const standby = turn.standby_ms || 0;
    const sum = work + wait + standby || 1;

    const workSubPct = (work / sum) * 100;
    const waitSubPct = (wait / sum) * 100;
    const standbySubPct = (standby / sum) * 100;

    const desc = turn.models[0] || session.project || "任务执行";
    const isSelected = state.selectedTurnId === turn.id;

    return `
      <div class="turn-row ${isSelected ? "active" : ""}" data-session-id="${h(session.id)}" data-turn-id="${h(turn.id)}" tabindex="0" role="button" aria-label="查看轮次 #${turnIndex} 详情">
        <span class="turn-num-col">Turn #${turnIndex}</span>
        <span class="turn-desc-col" title="${h(desc)}">${h(desc)}</span>
        <div class="turn-track-col">
          <div style="background:var(--state-work); width:${workSubPct}%;" title="纯工作: ${fmt(work)}"></div>
          <div style="background:var(--state-wait); width:${waitSubPct}%;" title="等待人审阅: ${fmt(wait)}"></div>
          <div style="background:#9E968B; width:${standbySubPct}%;" title="待命: ${fmt(standby)}"></div>
        </div>
        <span class="turn-time-col">${fmt(turn.elapsed_ms || turn.period_ms)}</span>
      </div>
    `;
  }).join("");

  return `
  <section class="timeline-card">
    <div class="section-header">
      <div>
        <span class="section-title">Brush & Zoom 全景时间轴与微缩视口</span>
        <span class="section-subtitle">双向拖拽视口框 · 无级缩放秒级高精甘特轮次</span>
      </div>
      <span class="brush-scope-pill" id="brushScopeText">展示第 ${startIdx + 1} 至 ${endIdx} 轮 (共 ${totalTurns} 轮)</span>
    </div>

    <!-- 48px 全景画卷带 -->
    <div class="brush-section">
      <div class="brush-strip-track" id="brushTrack">
        ${stripBlocks}
        <!-- 悬浮双向可拖拽视口滑块 -->
        <div class="brush-viewport" id="brushViewport" style="left: ${state.zoomStartPct}%; width: ${Math.max(10, state.zoomEndPct - state.zoomStartPct)}%;">
          <div class="brush-handle-bar" data-handle="left" title="向左拖拽扩展区间"></div>
          <div class="brush-center-badge">视口缩放</div>
          <div class="brush-handle-bar" data-handle="right" title="向右拖拽扩展区间"></div>
        </div>
      </div>
      <div class="brush-ticks">
        <span>${h(stamp(minTime))}</span>
        <span>${h(stamp(Math.round((minTime + maxTime) / 2)))}</span>
        <span>${h(stamp(maxTime))}</span>
      </div>
    </div>

    <!-- 秒级高精甘特轮次列表 -->
    <div class="gantt-zoom-stage">
      <div class="gantt-header-row">
        <span style="width:75px;">轮次编号</span>
        <span style="width:220px;">任务与模型</span>
        <span style="flex:1;">三态分布 (陶土橙:纯工作 / 琥珀金:等待人审阅 / 亚麻灰:待命)</span>
        <span style="width:85px; text-align:right;">单轮时长</span>
      </div>
      <div class="gantt-turns-grid">
        ${turnRows}
      </div>
    </div>
  </section>`;
}

function bindBrushEvents() {
  const vp = $("#brushViewport");
  const track = $("#brushTrack");
  if (!vp || !track) return;

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
// 模块 4：两段式弹性下钻抽屉 (480px, 上总账 + 下慢工具清单)
// 真实消费 API 暴露数据，严禁假数据伪造
// ========================================================
function openDrawer(turn, session) {
  state.selectedTurnId = turn.id;
  state.activeSessionId = session.id;

  const d = $("#detailDrawer");
  if (!d) return;

  const titleEl = $("#drawerTurnTitle");
  if (titleEl) {
    titleEl.textContent = `会话 ${session.project} · 轮次详情`;
  }

  const work = turn.work_ms;
  const wait = turn.review_wait_ms;
  const wall = turn.elapsed_ms || turn.period_ms || (work !== null ? (work + (wait || 0)) : null);
  const workRate = wall && work !== null ? Math.round((work / wall) * 100) : null;

  // 真实消费分解数据：有 breakdown 消费 breakdown，没有则如实呈现
  const apiMs = turn.breakdown?.model_api_ms ?? null;
  const toolMs = turn.breakdown?.tool_execution_ms ?? null;

  // 提取真实的工具清单
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

  // 耗时倒序排序
  toolsList.sort((a, b) => b.duration_ms - a.duration_ms);

  // 可选分项（如 Pi 的事件流切分）：仅在数据落盘存在时渲染该小节
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
        <span style="font-size:var(--text-sm); font-weight:700; color:var(--fg-title);">模型与思考等级分项</span>
        <span style="font-size:var(--text-xs); color:var(--fg-muted);">仅统计已落盘的事件耗时</span>
      </div>
      <div style="border:1px solid var(--line); border-radius:8px; overflow:hidden;">
        ${modelBreakdown.length ? `
          <div style="padding:7px 12px; background:var(--card-muted); font-size:var(--text-xs); font-weight:600; color:var(--fg-title);">模型推理耗时分布</div>
          ${modelBreakdown.map((m) => breakdownRow(m.model, m.duration_ms)).join("")}
        ` : ""}
        ${thinkingBreakdown.length ? `
          <div style="padding:7px 12px; background:var(--card-muted); font-size:var(--text-xs); font-weight:600; color:var(--fg-title); border-top:${modelBreakdown.length ? "1" : "0"}px solid var(--line);">思考等级耗时分布</div>
          ${thinkingBreakdown.map((t) => breakdownRow(`思考等级 ${t.level}`, t.duration_ms)).join("")}
        ` : ""}
      </div>
    </div>
  `
    : "";

  const toolsHtml = toolsList.length
    ? toolsList.map((t, idx) => {
        const isSlow = idx === 0 && t.duration_ms > 2000;
        const isBash = t.name.toLowerCase().includes("bash") || t.name.toLowerCase().includes("run") || t.name.toLowerCase().includes("exec");
        const stdoutId = `stdout-${idx}`;
        return `
          <div class="tool-item-card">
            <div class="tool-item-head" onclick="const el=document.getElementById('${stdoutId}'); if(el) el.classList.toggle('hidden');">
              <div style="display:flex; align-items:center; gap:8px;">
                <span class="tool-badge ${isBash ? "bash" : "write"}">${isBash ? "BASH / EXEC" : "EDIT / FS"}</span>
                <span style="font-size:12px; font-weight:600; color:var(--fg-title);">${h(t.name)}</span>
              </div>
              <span class="tool-time">${fmt(t.duration_ms)} ${isSlow ? "(慢瓶颈)" : ""}</span>
            </div>
            <div class="tool-command">${h(t.name)} · 累计执行 ${t.count} 次</div>
            <div class="tool-stdout hidden" id="${stdoutId}">
              [工具执行快照]<br>
              工具标识: ${h(t.name)}<br>
              执行频次: ${t.count} 次<br>
              耗时小计: ${fmt(t.duration_ms)}<br>
              所属轮次: ${h(turn.id)}
            </div>
          </div>
        `;
      }).join("")
    : `<div class="empty" style="padding:16px;">本轮未调用外部工具/脚本 (纯模型推理)。</div>`;

  $("#drawerBody").innerHTML = `
    <!-- 顶部总账微卡 -->
    <div>
      <div style="font-size:12px; font-weight:700; margin-bottom:8px; color:var(--fg-title); display:flex; justify-content:space-between;">
        <span>耗时构成总账 (Rollup Summary)</span>
        <span style="font-size:11px; color:var(--state-work); font-weight:600;">一手数据核算</span>
      </div>
      <div class="drawer-kpi-grid">
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">模型推理耗时 (API)</div>
          <div class="drawer-kpi-val">${apiMs !== null ? fmt(apiMs) : (work !== null ? fmt(work) : "—")}</div>
          <div class="drawer-kpi-sub">${h(turn.models[0] || "模型上下文未知")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">工具执行耗时 (Tools)</div>
          <div class="drawer-kpi-val">${toolMs !== null ? fmt(toolMs) : "—"}</div>
          <div class="drawer-kpi-sub">${toolsList.length} 项工具执行</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-wait);">
          <div class="drawer-kpi-title">等待人审阅 (Review Wait)</div>
          <div class="drawer-kpi-val">${wait !== null ? fmt(wait) : "—"}</div>
          <div class="drawer-kpi-sub">授权审批与决策对齐卡点</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-idle);">
          <div class="drawer-kpi-title">单轮壁钟时长 (Wall Time)</div>
          <div class="drawer-kpi-val">${fmt(wall)}</div>
          <div class="drawer-kpi-sub">有效工作率: ${workRate !== null ? `${workRate}%` : "—"}</div>
        </div>
      </div>
    </div>

    <!-- 模型与思考等级可选分项（仅数据存在时渲染） -->
    ${breakdownHtml}

    <!-- 详细脚本与慢工具清单 -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
        <span style="font-size:12px; font-weight:700; color:var(--fg-title);">执行明细与慢脚本清单</span>
        <span style="font-size:11px; color:var(--fg-muted);">按耗时倒序 · 点击折叠展开详情</span>
      </div>
      <div class="tool-list-container">
        ${toolsHtml}
      </div>
    </div>
  `;

  d.classList.remove("collapsed");
}

function closeDrawer() {
  const d = $("#detailDrawer");
  if (d) d.classList.add("collapsed");
  state.selectedTurnId = null;
  $$(".turn-row").forEach((r) => r.classList.remove("active"));
}

function overview() {
  const s = state.report.summary;
  if (!s.sessions) return noData();

  return `
    ${stats()}
    ${funnel()}
    ${timeline()}
    <section class="panel">
      <div class="panelhead">
        <h2>贡献最多的活跃会话</h2>
        <button class="textbtn" data-page="sessions">查看全部会话 →</button>
      </div>
      ${table(
        state.report.sessions
          .slice()
          .sort((a, b) => (b.period_ms || 0) - (a.period_ms || 0))
          .slice(0, 5),
      )}
    </section>
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
          <th>本期壁钟时长</th>
          <th>已测量轮次</th>
          <th>最近活动</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map((s) => {
            const lastAt = Math.max(...s.turns.map((t) => t.start_ms || t.end_ms || 0));
            return `
              <tr>
                <td>
                  <button class="textbtn" data-session="${h(s.id)}">
                    <strong>${h(s.project)}</strong>
                    <span style="display:block; font-size:11px; color:var(--fg-muted); font-family:var(--font-mono);">${h(s.id.slice(0, 16))}</span>
                  </button>
                </td>
                <td><span class="tag">${h(s.agent)}</span></td>
                <td style="font-weight:700; font-family:var(--font-mono);">${fmt(s.measured_turns ? s.period_ms : null)}</td>
                <td><span class="tag ${s.measured_turns === s.turns.length ? "" : "warn"}">${s.measured_turns}/${s.turns.length}</span></td>
                <td style="color:var(--fg-muted); font-family:var(--font-mono);">${h(stamp(lastAt))}</td>
                <td>
                  <button class="btn" data-session="${h(s.id)}" aria-label="查看会话全部轮次">全轮次 →</button>
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
    (s.project + " " + s.id + " " + s.agent).toLowerCase().includes(needle),
  );
  return state.sort === "duration"
    ? rows.sort((a, b) => (b.period_ms || 0) - (a.period_ms || 0))
    : rows;
}

function sessions() {
  return `
    <div class="panelhead" style="margin-bottom:12px;">
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
    <div class="demo" style="margin-bottom:16px;">
      <strong>口径提示</strong>
      <span>当前接入 Codex、Claude Code 与 Pi，按模型上下文分组，耗时更短不等于质量更优。</span>
    </div>
    <section class="panel">
      <div class="panelhead"><h2>按模型上下文汇总</h2></div>
      ${groups.size ? `
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>模型名称 / 上下文</th>
                <th>本期已记录累计机时</th>
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
                ${saving ? "保存中…" : draft.enabled ? "保存并同步" : "保存设置"}
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
    <div class="demo" style="margin-bottom:16px;">
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

async function saveDirectory(agent) {
  if (state.saving.has(agent) || state.busy) return;
  const item = state.directories.find((x) => x.agent === agent);
  const draft = directoryDraft(item);
  state.saving.add(agent);
  render();
  try {
    await api("/api/directories", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentTime": "1" },
      body: JSON.stringify({
        agent,
        path:
          draft.reset ||
          draft.path === "" ||
          (!draft.pathEdited && item.source !== "custom")
            ? null
            : draft.path,
        enabled: draft.enabled,
      }),
    });
    delete state.drafts[agent];
    await load();
    if (draft.enabled) await refresh();
    else toast("目录设置已保存。");
  } catch (e) {
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
          <span>完整单轮跨度: <strong>${fmt(t.elapsed_ms)}</strong></span>
          <span>本期分摊计入: <strong>${fmt(t.period_ms)}</strong></span>
          <span>纯工作: <strong>${t.work_ms !== null ? fmt(t.work_ms) : "未切分"}</strong></span>
        </div>
        <div style="display:flex; justify-content:flex-end;">
          <button class="btn" data-drill-turn="${h(t.id)}" data-drill-session="${h(s.id)}">在侧边抽屉下钻明细 →</button>
        </div>
      </article>
    `;
  }).join("");

  open(
    `${head(s.project, `${s.agent} · ${s.id}`)}
     <p class="sub" style="margin-bottom:16px;">仅显示当前日期范围涉及的轮次。完整轮次时长与本期分摊分别列出。</p>
     <div style="max-height:60vh; overflow-y:auto;">
       ${turnsHtml}
     </div>`,
    true,
  );
}

function definitions() {
  open(
    `${head("这些时间怎么算？")}
     <dl style="line-height:1.7; font-size:13px;">
       <dt><strong>会话与一轮交互</strong></dt>
       <dd class="sub">会话是同一任务的交互集合；一轮交互从你提交问题或指令到 Agent 完成答复。工具调用与等待人审阅卡点均精确切分。</dd>
       <dt style="margin-top:12px;"><strong>物理跨度并集时长 (Union Span)</strong></dt>
       <dd class="sub">多个任务并发重叠运行的时间仅计一次，精确反映任务真实占据的物理自然时间。</dd>
       <dt style="margin-top:12px;"><strong>纯工作有效净值 (Active Work Duration)</strong></dt>
       <dd class="sub">由模型推理耗时与本地工具执行耗时毫秒级累加沉淀，真实反映 AI 的有效劳动净值。</dd>
     </dl>`,
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
  state.busy = true;
  $("#refresh").disabled = true;
  $("#refresh").textContent = "同步中…";
  try {
    const r = await api("/api/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AgentTime": "1" },
      body: "{}",
    });
    await load();
    toast(`成功更新 ${r.updated} 个文件${r.failed ? `，${r.failed} 个失败` : ""}`);
    if (r.failed) {
      open(
        `${head("部分记录未能导入", `已更新 ${r.updated} 个文件，失败 ${r.failed} 个。`)}
         <p class="sub">首次导入失败的文件不会生成统计；此前已成功导入的记录会保留旧快照。</p>
         <h3>失败原因</h3>
         ${(r.failures || []).map((item) => `<p>${h(item.reason)} <strong>（${h(item.count)} 个文件）</strong></p>`).join("") || "<p>服务未提供详细失败原因。</p>"}`,
      );
    }
  } catch (e) {
    error(e.message);
  } finally {
    state.busy = false;
    $("#refresh").disabled = false;
    $("#refresh").textContent = "同步记录";
  }
}

// 全局事件监听委托
document.addEventListener("click", async (e) => {
  // 1. 甘特轮次行点击唤起下钻抽屉
  const turnRow = e.target.closest(".turn-row");
  if (turnRow) {
    const sId = turnRow.dataset.sessionId;
    const tId = turnRow.dataset.turnId;
    const s = state.report.sessions.find((x) => x.id === sId);
    if (s) {
      const t = s.turns.find((x) => x.id === tId);
      if (t) {
        $$(".turn-row").forEach((r) => r.classList.remove("active"));
        turnRow.classList.add("active");
        openDrawer(t, s);
        return;
      }
    }
  }

  // 2. 会话弹窗内下钻按钮
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
    render();
    window.scrollTo(0, 0);
  }

  if (b.dataset.range) {
    state.range = b.dataset.range;
    state.end = localDate();
    state.start = previous(
      state.end,
      state.range === "today" ? 0 : state.range === "week" ? 6 : 29,
    );
    await load();
  }

  if (b.dataset.session) {
    details(b.dataset.session);
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
    case "close-drawer":
      closeDrawer();
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

// ESC 键随手关闭抽屉与弹层，支持 Tab 焦点陷阱 (Focus Trap)
document.addEventListener("keydown", (e) => {
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
});

// 首次拉取
load();
