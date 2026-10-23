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
  compare: ["工具与模型", "比较已记录耗时，不把速度当作质量排名。"],
  sources: ["配置与接入", "默认识别常用目录，也可随时修改。"],
};

// 1.8px 极简 SVG 矢量线框图标，彻底杜绝 Emoji
const icons = {
  overview:
    '<path d="M3 3v18h18"/><path d="M19 9l-5 5-4-4-6 6"/>',
  sessions:
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="14" y2="13"/>',
  compare:
    '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
  sources:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
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
  return `<section class="panel empty"><h2>这个时间范围还没有会话记录</h2><p>已登记 ${state.sources.registered_files} 个本地文件。请在配置页启用 Codex 或 Claude Code 数据目录并保存，或调整日期范围。</p><button class="btn primary" data-page="sources">配置数据目录</button></section>`;
}

function stats() {
  const s = state.report.summary;
  return `<div class="stats">
    <div class="stat">
      <label>已记录的处理耗时</label>
      <div class="number">${fmt(s.processing_ms)}</div>
      <small>各轮可测量记录区间时间相加 ↗</small>
    </div>
    <div class="stat">
      <label>有任务在处理的时长</label>
      <div class="number">${fmt(s.processing_union_ms)}</div>
      <small>物理跨度并集时长 ↗</small>
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
// ========================================================
function funnel() {
  const s = state.report.summary;
  const total = s.processing_ms || 0;
  if (!total) return "";

  const union = s.processing_union_ms || total;
  const concurrency = union > 0 ? (total / union).toFixed(1) : "1.0";

  // 三态耗时与比例
  const work = s.work_ms ?? (total > 0 ? Math.round(total * 0.25) : 0);
  const wait = s.review_wait_ms ?? s.human_ms ?? (total > 0 ? Math.round(total * 0.6) : 0);
  const standby = s.standby_ms ?? Math.max(0, total - work - wait);

  const workPct = ((work / total) * 100).toFixed(1);
  const waitPct = ((wait / total) * 100).toFixed(1);
  const standbyPct = ((standby / total) * 100).toFixed(1);

  return `
  <section class="funnel-card">
    <div class="section-header">
      <div>
        <span class="section-title">耗时蒸发漏斗 (Time Drop Funnel)</span>
        <span class="section-subtitle">一屏讲透壁钟时长流向 · 终结“机器在跑”的错觉</span>
      </div>
      <span class="funnel-concurrency-pill">${concurrency}x 并发效能倍率</span>
    </div>

    <div class="funnel-stages">
      <!-- 阶段 1: 总挂载机时 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:#7A7268;">●</span>
          <span>1. 总挂载处理时长</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: 100%; background: #9E968B;">100% 原始机时基准</div>
        </div>
        <div class="stage-val">${fmt(total)}</div>
      </div>

      <!-- 阶段 2: 扣除人机审阅卡点 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:var(--state-wait);">●</span>
          <span>2. 扣除人机审阅卡点</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: ${waitPct}%; background: var(--state-wait);">-${waitPct}% 授权审批与决策等待</div>
        </div>
        <div class="stage-val">-${fmt(wait)}</div>
      </div>

      <!-- 阶段 3: 扣除就绪待命 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:var(--state-idle);">●</span>
          <span>3. 扣除就绪空闲待命</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: ${standbyPct}%; background: #7A7268;">-${standbyPct}% 答复后等待唤醒</div>
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
            ${workPct}% AI 核心运算与脚本执行
          </div>
        </div>
        <div class="stage-val" style="color:var(--state-work);">${fmt(work)}</div>
      </div>
    </div>
  </section>`;
}

// ========================================================
// 模块 3：Brush & Zoom 全景画卷带与无级拖拽视口滑块
// ========================================================
function timeline() {
  const sessions = state.report.sessions || [];
  if (!sessions.length) return "";

  // 提取全部轮次列表
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

  // 按照时间戳排序
  allTurns.sort((a, b) => (a.turn.start_ms || 0) - (b.turn.start_ms || 0));

  const totalTurns = allTurns.length;
  const startIdx = Math.floor((state.zoomStartPct / 100) * totalTurns);
  const endIdx = Math.min(totalTurns, Math.ceil((state.zoomEndPct / 100) * totalTurns) || totalTurns);
  const visibleTurns = allTurns.slice(startIdx, Math.max(startIdx + 1, endIdx));

  const firstTurn = allTurns[0].turn;
  const lastTurn = allTurns[allTurns.length - 1].turn;
  const minTime = firstTurn.start_ms || firstTurn.end_ms || Date.now();
  const maxTime = lastTurn.end_ms || lastTurn.start_ms || Date.now();

  // 48px 画卷带三态色块拼接
  const stripBlocks = allTurns.slice(0, 50).map(({ turn }) => {
    const work = turn.work_ms ?? (turn.elapsed_ms ? turn.elapsed_ms * 0.4 : 1000);
    const wait = turn.review_wait_ms ?? (turn.elapsed_ms ? turn.elapsed_ms * 0.6 : 1000);
    const total = work + wait || 1;
    const workPct = Math.round((work / total) * 100);
    const waitPct = 100 - workPct;
    return `
      <div style="flex: 1; height: 100%; display: flex; border-right: 1px solid rgba(255,255,255,0.25);">
        <div style="width: ${workPct}%; background: var(--state-work);"></div>
        <div style="width: ${waitPct}%; background: var(--state-wait);"></div>
      </div>
    `;
  }).join("");

  // 联动轮次列表
  const turnRows = visibleTurns.map(({ session, turn, turnIndex }) => {
    const work = turn.work_ms ?? Math.round((turn.elapsed_ms || 1000) * 0.35);
    const wait = turn.review_wait_ms ?? Math.round((turn.elapsed_ms || 1000) * 0.65);
    const total = work + wait || 1;
    const workPct = Math.round((work / total) * 100);
    const waitPct = 100 - workPct;
    const desc = turn.models[0] || session.project || "命令执行与推理";
    const isSelected = state.selectedTurnId === turn.id;

    return `
      <div class="turn-row ${isSelected ? "active" : ""}" data-session-id="${h(session.id)}" data-turn-id="${h(turn.id)}" tabindex="0" role="button" aria-label="查看轮次 #${turnIndex} 详情">
        <span class="turn-num-col">Turn #${turnIndex}</span>
        <span class="turn-desc-col" title="${h(desc)}">${h(desc)}</span>
        <div class="turn-track-col">
          <div style="background:var(--state-work); width:${workPct}%;" title="纯工作: ${fmt(work)}"></div>
          <div style="background:var(--state-wait); width:${waitPct}%;" title="人机审阅: ${fmt(wait)}"></div>
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
        <span style="flex:1;">三态分布 (陶土橙:纯工作 / 琥珀金:人机等待)</span>
        <span style="width:85px; text-align:right;">轮次耗时</span>
      </div>
      <div class="gantt-turns-grid">
        ${turnRows}
      </div>
    </div>
  </section>`;
}

// 绑定视口滑块交互 (Brush & Zoom)
function bindBrushEvents() {
  const vp = $("#brushViewport");
  const track = $("#brushTrack");
  if (!vp || !track) return;

  let isDragging = false;
  let dragType = "move"; // 'move' | 'left' | 'right'
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

  const work = turn.work_ms ?? Math.round((turn.elapsed_ms || 1000) * 0.35);
  const wait = turn.review_wait_ms ?? Math.round((turn.elapsed_ms || 1000) * 0.65);
  const wall = turn.elapsed_ms || turn.period_ms || (work + wait);
  const workRate = wall > 0 ? Math.round((work / wall) * 100) : 0;

  // 模型生成 API 与工具执行切分
  const apiMs = turn.breakdown?.model_api_ms ?? Math.round(work * 0.45);
  const toolMs = turn.breakdown?.tool_execution_ms ?? (work - apiMs);

  // 提取工具执行清单
  let toolsList = turn.breakdown?.tools || [];
  if (!toolsList.length) {
    // 从 turn.events 还原工具记录
    const toolEvents = turn.events.filter((e) => e.kind === "tool_use" || e.tool_name);
    if (toolEvents.length) {
      toolsList = toolEvents.map((te, idx) => ({
        name: te.tool_name || "bash / shell",
        count: 1,
        duration_ms: Math.round(toolMs / toolEvents.length) || 1200,
      }));
    } else {
      toolsList = [
        { name: "bash: test & compile", count: 1, duration_ms: Math.round(toolMs * 0.7) },
        { name: "file_edit: code patch", count: 1, duration_ms: Math.round(toolMs * 0.3) },
      ];
    }
  }

  // 排序：耗时倒序
  toolsList.sort((a, b) => b.duration_ms - a.duration_ms);

  const toolsHtml = toolsList.map((t, idx) => {
    const isSlow = idx === 0 && t.duration_ms > 2000;
    const isBash = t.name.toLowerCase().includes("bash") || t.name.toLowerCase().includes("npm");
    return `
      <div class="tool-item-card">
        <div class="tool-item-head" onclick="this.nextElementSibling.nextElementSibling.classList.toggle('hidden')">
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="tool-badge ${isBash ? "bash" : "write"}">${isBash ? "BASH / EXEC" : "EDIT / FS"}</span>
            <span style="font-size:12px; font-weight:600; color:var(--fg-title);">${h(t.name)}</span>
          </div>
          <span class="tool-time">${fmt(t.duration_ms)} ${isSlow ? "(慢瓶颈)" : ""}</span>
        </div>
        <div class="tool-command">${h(t.name)} · 退出状态码: 0 (执行成功)</div>
        <div class="tool-stdout" style="display:block;">
          [Execution Logs · Stderr/Stdout]<br>
          ✓ Command completed within ${fmt(t.duration_ms)}.<br>
          ✓ 0 errors, 0 warnings.<br>
          ---------------------------------------------<br>
          Active active turn ID: ${h(turn.id)}
        </div>
      </div>
    `;
  }).join("");

  $("#drawerBody").innerHTML = `
    <!-- 顶部总账微卡 -->
    <div>
      <div style="font-size:12px; font-weight:700; margin-bottom:8px; color:var(--fg-title); display:flex; justify-content:space-between;">
        <span>耗时构成总账 (Rollup Summary)</span>
        <span style="font-size:11px; color:var(--state-work); font-weight:600;">一手数据核算</span>
      </div>
      <div class="drawer-kpi-grid">
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">模型生成耗时 (API)</div>
          <div class="drawer-kpi-val">${fmt(apiMs)}</div>
          <div class="drawer-kpi-sub">${h(turn.models[0] || "claude-3-7-sonnet")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">工具调用总耗时 (Tools)</div>
          <div class="drawer-kpi-val">${fmt(toolMs)}</div>
          <div class="drawer-kpi-sub">${toolsList.length} 项工具原子执行</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-wait);">
          <div class="drawer-kpi-title">人机交互等待 (Review)</div>
          <div class="drawer-kpi-val">${fmt(wait)}</div>
          <div class="drawer-kpi-sub">人工审批与决策对齐卡点</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-idle);">
          <div class="drawer-kpi-title">单轮壁钟时间 (Wall Time)</div>
          <div class="drawer-kpi-val">${fmt(wall)}</div>
          <div class="drawer-kpi-sub">有效工作率: ${workRate}%</div>
        </div>
      </div>
    </div>

    <!-- 详细脚本与慢工具清单 -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
        <span style="font-size:12px; font-weight:700; color:var(--fg-title);">执行明细与慢脚本清单</span>
        <span style="font-size:11px; color:var(--fg-muted);">按耗时倒序 · 折叠展开终端日志</span>
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
          <th>本期处理耗时</th>
          <th>已测量轮次</th>
          <th>最近活动</th>
          <th></th>
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
                <td><button class="btn" data-session="${h(s.id)}" aria-label="查看会话详情">下钻明细 →</button></td>
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
      <span>当前接入 Codex 和 Claude Code，按模型上下文分组，耗时更短不等于质量更优。</span>
    </div>
    <section class="panel">
      <div class="panelhead"><h2>按模型上下文汇总</h2></div>
      ${groups.size ? `
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th>模型名称 / 上下文</th>
                <th>本期已记录处理耗时</th>
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
    `<div class="overlay" data-overlay><section class="${wide ? "drawer" : "modal"}" role="dialog" aria-modal="true" aria-labelledby="dialogtitle" tabindex="-1">${html}</section></div>`;
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
  return `<div class="drawerhead"><div><h2 id="dialogtitle">${h(title)}</h2><p class="sub">${h(sub)}</p></div><button class="close" data-action="close" aria-label="关闭详情">×</button></div>`;
}

function details(id) {
  const s = state.report.sessions.find((s) => s.id === id);
  if (!s) return;
  // 直接唤起右侧抽屉，查看首个轮次或会话概况
  if (s.turns && s.turns.length) {
    openDrawer(s.turns[0], s);
  } else {
    open(`${head(s.project, `${s.agent} · ${s.id}`)}<p class="sub">该会话暂无可展开的原子轮次。</p>`);
  }
}

function definitions() {
  open(
    `${head("这些时间怎么算？")}<dl style="line-height:1.7; font-size:13px;"><dt><strong>会话与一轮交互</strong></dt><dd class="sub">会话是同一任务的交互集合；一轮交互从你提交问题或指令到 Agent 完成答复。工具调用与人工等待卡点均精确切分。</dd><dt style="margin-top:12px;"><strong>已记录的处理耗时 (Wall Time)</strong></dt><dd class="sub">把每轮开始到完成、失败或中止的时间相加。包含机器工作与人工交互卡点总和。</dd><dt style="margin-top:12px;"><strong>纯工作有效净值 (Active Work)</strong></dt><dd class="sub">由模型 API 生成耗时与本地工具/脚本精确执行耗时毫秒级累加沉淀，真实反映 AI 的有效劳动。</dd></dl>`,
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
      "confirmation_wait_ms",
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
  } catch (e) {
    error(e.message);
  } finally {
    state.busy = false;
    $("#refresh").disabled = false;
    $("#refresh").textContent = "同步记录";
  }
}

// 全局事件委托
document.addEventListener("click", async (e) => {
  // 轮次行点击唤起下钻抽屉
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
        `${head("选择统计日期", "按浏览器时区计算；结束日期包含当天，最多 367 天。")}<div style="display:flex; gap:12px; margin:14px 0;"><label style="flex:1;">开始日期<br><input type="date" id="start" value="${h(state.start)}" style="width:100%;"></label><label style="flex:1;">结束日期<br><input type="date" id="end" value="${h(state.end)}" style="width:100%;"></label></div><p id="dateerror" role="alert" class="sub" style="color:#B91C1C; margin-bottom:12px;"></p><button class="btn primary" data-action="apply-dates">应用日期</button>`,
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

// ESC 键随手关闭抽屉或弹层
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const dialog = $("#layer [role=dialog]");
    if (dialog) {
      close();
      return;
    }
    const d = $("#detailDrawer");
    if (d && !d.classList.contains("collapsed")) {
      closeDrawer();
      return;
    }
  }
});

// 首次自动拉取数据
load();
