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
  // 首页接入工具筛选（"all" 或当前报告中实际存在的 agent 名）
  overviewAgent: "all",
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
      JSON.stringify({ range: state.range, start: state.start, end: state.end }),
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
  completed: "已完成",
  aborted: "已中止",
  failed: "执行失败",
  open: "暂无结束记录",
  incomplete: "缺少起点",
  invalid: "记录冲突",
};

// Codex 内建工具的友好显示名与 toolLabel() 定义已并入下方 PURE HELPERS 纯函数块，
// 与总账回填 / 维度聚合助手共用同一块零浏览器依赖代码（node:vm 整块提取做行为级单测）

// 首页/抽屉统一使用的接入工具徽标（内联 SVG，见 agentMark 定义处）
// 徽标内容为各 harness 的真实标志（反馈轮 3）：
// - Codex：OpenAI 官方 mark（simple-icons 单 path，viewBox 0 0 24 24），
//   沿用单色 currentColor 底 + paper 反白，不再使用拼错的 "Cx" 字母
// - Claude Code：日光纹 sunburst（用户已接受，保持不动）
// - Pi：Pi-agent 新版像素标（4×4 像素网格，crispEdges，三色像素），
//   不再使用旧版 π 字母（pi.dev favicon 是旧 logo，勿引用）
// - Antigravity：Google Antigravity 官方 mark 单色剪影（lobe-icons 收录的
//   官方 path，viewBox 0 0 24 24；simple-icons 尚未收录，勿自绘臆造。
//   官方 svg 带 fill-rule="evenodd"，漏写会把镂空填成实心色块）
// - Oh-My-Pi：官方主视觉 π 标（can1357/oh-my-pi assets/hero.png 几何实测：
//   横梁 178×37、左腿 x25 宽 37 高 125、右腿 x121 宽 37 全高 169，右腿更长；
//   粉→紫→蓝垂直渐变采样自 hero 原像素。仓库 assets/icon.svg 的细腿 π+插件头
//   是另一版图形，12px 下不可辨，品牌认知以 hero 为准）
const OMP_PI_GRADIENT =
  '<defs><linearGradient id="omp-g" x1="0" y1="0" x2="0" y2="1">' +
  '<stop offset="0" stop-color="#C758D9"/><stop offset="0.5" stop-color="#B364E5"/>' +
  '<stop offset="1" stop-color="#859CE8"/></linearGradient></defs>';
const OMP_PI_SHAPES =
  '<rect x="25" y="0" width="37" height="125" rx="10" fill="url(#omp-g)"/>' +
  '<rect x="121" y="0" width="37" height="169" rx="10" fill="url(#omp-g)"/>' +
  '<rect x="0" y="0" width="178" height="37" rx="8" fill="url(#omp-g)"/>';
const OPENAI_MARK_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

// Pi 新版像素标：4×4 网格（viewBox 0 0 4 4），每个非空像素一个 1×1 rect
const PI_PIXEL_RECTS = [
  ["#E48A7A", 0, 0],
  ["#E48A7A", 1, 0],
  ["#E48A7A", 2, 0],
  ["#E48A7A", 2, 1],
  ["#4F8EB3", 0, 1],
  ["#4F8EB3", 0, 2],
  ["#4F8EB3", 1, 2],
  ["#4F8EB3", 0, 3],
  ["#EAB65D", 3, 2],
  ["#EAB65D", 3, 3],
]
  .map(([fill, x, y]) => `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}"/>`)
  .join("");

// Antigravity 官方 mark 单色剪影（lobe-icons antigravity.svg，官方 path）
const ANTIGRAVITY_MARK_PATH =
  "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z";
// OpenCode 官方方环标（simple-icons 单 path，viewBox 0 0 24 24，evenodd 镂空，勿自绘）
const OPENCODE_MARK_PATH = "M22 24H2V0h20zM17 4.8H7v14.4h10z";
// DeepSeek 官方鲸鱼标（simple-icons 单 path，viewBox 0 0 24 24，勿自绘）
const DEEPSEEK_MARK_PATH =
  "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45";

function agentMark(agent) {
  const marks = {
    Codex: {
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="${OPENAI_MARK_PATH}" fill="#FAF9F5"/></svg>`,
      cls: "codex",
      label: "Codex",
    },
    "Claude Code": {
      glyph:
        '<path d="M8 2.2v11.6M2.2 8h11.6M3.9 3.9l8.2 8.2M12.1 3.9l-8.2 8.2" stroke="#FAF9F5" stroke-width="1.9" stroke-linecap="round" fill="none"/>',
      cls: "claude",
      label: "Claude Code",
    },
    Pi: {
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 4 4" shape-rendering="crispEdges" aria-hidden="true">${PI_PIXEL_RECTS}</svg>`,
      cls: "pi",
      label: "Pi",
    },
    Antigravity: {
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="${ANTIGRAVITY_MARK_PATH}" fill-rule="evenodd" fill="#FAF9F5"/></svg>`,
      cls: "antigravity",
      label: "Antigravity",
    },
    "DeepSeek Harness": {
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="${DEEPSEEK_MARK_PATH}" fill="#FAF9F5"/></svg>`,
      cls: "dsh",
      label: "DeepSeek Harness",
    },
    "Oh-My-Pi": {
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 178 169" aria-hidden="true">${OMP_PI_GRADIENT}${OMP_PI_SHAPES}</svg>`,
      cls: "omp",
      label: "Oh-My-Pi",
    },
    OpenCode: {
      // simple-icons 已收录官方方环标（evenodd 镂空），不再用自绘尖括号
      glyph: `<svg x="2" y="2" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="${OPENCODE_MARK_PATH}" fill-rule="evenodd" fill="#FAF9F5"/></svg>`,
      cls: "opencode",
      label: "OpenCode",
    },
  };
  const m = marks[agent];
  if (!m) return "";
  return `<span class="agent-mark agent-mark-${m.cls}" title="${h(m.label)}" aria-label="${h(m.label)}"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="0" y="0" width="16" height="16" rx="4.5" fill="currentColor"/>${m.glyph}</svg></span>`;
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
}

function noData() {
  return `<section class="panel empty"><h2>这个时间范围还没有会话记录</h2><p>已登记 ${state.sources.registered_files} 个本地文件。请在配置页启用 Codex、Claude Code、Pi、Antigravity、DeepSeek Harness、OpenCode 或 Oh-My-Pi 数据目录并保存，或调整日期范围。</p><button class="btn primary" data-page="sources">配置数据目录</button></section>`;
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

function renderFunnelStageTrack(pct, color, fullText, isGlow = false) {
  if (pct <= 0) {
    return `
      <div class="funnel-fill" style="width: 0%; padding:0; min-width:0;"></div>
      <span class="funnel-outside-hint">0.0% (无卡点损耗)</span>
    `;
  }
  if (pct < 25) {
    return `
      <div class="funnel-fill" style="width: ${pct}%; background: ${color}; padding: 0; min-width:0; ${isGlow ? "box-shadow: 0 0 10px rgba(204,120,92,0.35);" : ""}"></div>
      <span class="funnel-outside-label" style="color: ${color};">
        ${fullText}
      </span>
    `;
  }
  return `
    <div class="funnel-fill" style="width: ${pct}%; background: ${color}; padding: 0 12px; ${isGlow ? "box-shadow: 0 0 10px rgba(204,120,92,0.35);" : ""}">
      <span class="funnel-text-inside">${fullText}</span>
    </div>
  `;
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
      <!-- 阶段 1: 原始挂载机时基准 -->
      <div class="funnel-bar-row">
        <div class="stage-label">
          <span style="color:#7A7268;">●</span>
          <span>1. 原始挂载机时总计</span>
        </div>
        <div class="funnel-track">
          <div class="funnel-fill" style="width: 100%; background: #9E968B; padding: 0 12px;">
            <span class="funnel-text-inside">100% 原始机时基准 (自然壁钟基底)</span>
          </div>
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
          ${renderFunnelStageTrack(waitPct, "var(--state-wait)", `-${waitPct}% 工具权限审批与方案决策`)}
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
          ${renderFunnelStageTrack(standbyPct, "#7A7268", `-${standbyPct}% 答复完毕至人类再次唤醒`)}
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
          ${renderFunnelStageTrack(workPct, "var(--state-work)", `${workPct}% AI 模型推理与本地工具执行`, true)}
        </div>
        <div class="stage-val" style="color:var(--state-work);">${fmt(work)}</div>
      </div>
    </div>
  </section>`;
}

// ========================================================
// 模块 3：Brush & Zoom 全景画卷带与无级拖拽视口滑块
// 采用完整三态高饱和高对比拼接，消除 Primitive Obsession
// 视口会话聚合数学由 computeTimelineModel() 抽出，
// 供首页双列组合榜 (TOP 3 榜 + 视口操作分布) 复用
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

  // 严格按选定物理时间范围过滤可视会话与轮次
  const rangeStartMs = minTime + (state.zoomStartPct / 100) * totalTimelineSpan;
  const rangeEndMs = minTime + (state.zoomEndPct / 100) * totalTimelineSpan;

  // 方案 A：以会话为一级主体聚合 (Session-First)
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

  // 按物理时间范围过滤可见会话
  const visibleSessions = sessionSummaries.filter((item) => {
    if (state.zoomStartPct <= 0 && state.zoomEndPct >= 100) return true;
    return item.maxTime >= rangeStartMs && item.minTime <= rangeEndMs;
  });

  return {
    sessions,
    allTurns,
    totalTurns,
    minTime,
    maxTime,
    totalTimelineSpan,
    sessionSummaries,
    visibleSessions,
  };
}

function timeline(model) {
  const { sessions, allTurns, totalTurns, minTime, maxTime, totalTimelineSpan } = model;
  if (!sessions.length || !allTurns.length) return "";

  // 140px 全景时间热力带：48 个等长聚合时间桶
  const BUCKETS = 48;
  const bucketDuration = Math.max(1, totalTimelineSpan / BUCKETS);
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({
    start: minTime + i * bucketDuration,
    end: minTime + (i + 1) * bucketDuration,
    workMs: 0,
    waitMs: 0,
    standbyMs: 0,
    turnsCount: 0,
  }));

  for (const { turn } of allTurns) {
    const tStart = turn.start_ms || minTime;
    const tEnd = turn.end_ms || tStart + 1000;
    const work = turn.work_ms || 0;
    const wait = turn.review_wait_ms || 0;
    const standby = turn.standby_ms || 0;

    for (let i = 0; i < BUCKETS; i++) {
      const b = buckets[i];
      const overlapStart = Math.max(b.start, tStart);
      const overlapEnd = Math.min(b.end, tEnd);
      if (overlapEnd > overlapStart) {
        const overlapRatio = (overlapEnd - overlapStart) / Math.max(1, tEnd - tStart);
        b.workMs += work * overlapRatio;
        b.waitMs += wait * overlapRatio;
        b.standbyMs += standby * overlapRatio;
        b.turnsCount += 1;
      }
    }
  }

  const maxBucketActivity = Math.max(1, ...buckets.map((b) => b.workMs + b.waitMs));

  const stripBlocks = buckets
    .map((b, idx) => {
      const totalActivity = b.workMs + b.waitMs;
      // 使用次方根非线性缩放 (power scale)，避免单个超长会话峰值把其余中短活跃期压成贴地平线
      const activityRatio = totalActivity > 0 ? Math.pow(totalActivity / maxBucketActivity, 0.42) : 0;
      const heightPct = totalActivity > 0 ? Math.max(18, Math.min(100, Math.round(activityRatio * 100))) : 4;
      const workRatio = totalActivity > 0 ? Math.round((b.workMs / totalActivity) * 100) : 0;
      const waitRatio = totalActivity > 0 ? 100 - workRatio : 0;
      const isMuted = totalActivity === 0;

      const bStartPct = (idx / BUCKETS) * 100;
      const bEndPct = ((idx + 1) / BUCKETS) * 100;
      const isInViewport = bEndPct >= state.zoomStartPct && bStartPct <= state.zoomEndPct;

      return `
        <div class="brush-bucket-col" title="${stamp(b.start)}: 纯工作 ${fmt(b.workMs)}, 等待人审阅 ${fmt(b.waitMs)}, 包含 ${b.turnsCount} 轮交互">
          <div class="brush-bucket-bar ${isInViewport ? "in-viewport" : "out-viewport"}" style="height:${heightPct}%; background:${isMuted ? "#DFD8CE" : "#FAF9F5"};">
            ${!isMuted ? `
              <div style="width:100%; height:${workRatio}%; background:var(--state-work);"></div>
              <div style="width:100%; height:${waitRatio}%; background:var(--state-wait);"></div>
            ` : ""}
          </div>
        </div>
      `;
    })
    .join("");

  // 方案 A：以会话为一级主体聚合 (Session-First) —— 模型已在 computeTimelineModel() 计算
  const { visibleSessions } = model;

  return `
  <section class="timeline-card">
    <div class="section-header">
      <div>
        <span class="section-title">全景时间轴与微缩视口 (Brush & Zoom Timeline)</span>
        <span class="section-subtitle">140px 黄金高度 · 指数非线性波峰 · 拖动滑块聚焦下方榜单与操作分布</span>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        ${(state.zoomStartPct > 0 || state.zoomEndPct < 100) ? `
          <button class="filter-chip js-reset-zoom" style="padding: 2px 8px; font-size: var(--text-xs);">重置全时间段</button>
        ` : ""}
        <span class="brush-scope-pill" id="brushScopeText">展示 ${visibleSessions.length} 个会话 (共 ${sessions.length} 个会话, ${totalTurns} 轮交互)</span>
      </div>
    </div>

    <!-- 140px 全景热力画卷 -->
    <div class="brush-section">
      <div class="brush-strip-track" id="brushTrack">
        ${stripBlocks}
        <!-- 悬浮双向可拖拽温和半透明选区 -->
        <div class="brush-viewport" id="brushViewport" style="left: ${state.zoomStartPct}%; width: ${Math.max(6, state.zoomEndPct - state.zoomStartPct)}%;">
          <div class="brush-handle-bar" data-handle="left" title="向左拖拽调整开始时间"></div>
          <div class="brush-handle-bar" data-handle="right" title="向右拖拽调整结束时间"></div>
        </div>
      </div>
      <div class="brush-ticks">
        <span>${h(stamp(minTime))}</span>
        <span>${h(stamp(Math.round((minTime + maxTime) / 2)))}</span>
        <span>${h(stamp(maxTime))}</span>
      </div>
    </div>
  </section>`;
}

// ========================================================
// 方案 A 替换模块 1：双列组合榜
// 左：会话耗时 TOP 3 榜 · 右：当前视口 Operations Breakdown
// 聚合口径：仅统计当前热力图视口 (zoomStartPct..zoomEndPct) 内可见的会话
// ========================================================
// 本期分摊口径：period_ms 是逐轮"裁剪到统计日期范围"的时长相加
// （/api/report 对越界轮次做裁剪）。命名必须暴露"裁剪分摊"语义，
// 与详情页的首末轮次物理壁钟跨度 (sessionWallSpan) 严格区分，不得混用。
function sessionClippedPeriodMs(s) {
  return s.measured_turns ? s.period_ms || 0 : 0;
}

function zoomedViewport() {
  return state.zoomStartPct > 0 || state.zoomEndPct < 100;
}

function topSessionsCard(model) {
  // 口径对齐：榜值与详情页「总壁钟时长 (WALL TIME)」KPI 同源 ——
  // 均为会话首末轮次的物理壁钟跨度 (sessionWallSpan)，
  // 保证任一会话的首页 TOP 3 榜值恒等于其详情页 WALL TIME
  const top = model.visibleSessions
    .map((item) => item.session)
    .map((s) => ({ s, duration: sessionWallSpan(s).wallMs || 0 }))
    .filter((x) => x.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3);

  const rows = top
    .map(({ s, duration }, idx) => {
      return `
        <div class="rank-mini-item" data-open-session="${h(s.id)}" role="button" tabindex="0" aria-label="进入会话详情页：${h(s.title || s.project)}">
          <span class="rank-num">${String(idx + 1).padStart(2, "0")}</span>
          <div class="rank-main">
            <span class="rank-title">${h(s.title || s.project)}</span>
            <span class="rank-subline">${agentMark(s.agent)}<span class="rank-subline-text">${h(s.project)} · ${h(s.id.slice(0, 16))}</span></span>
          </div>
          <span class="rank-duration">${fmt(duration)}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div class="s1-box">
      <div class="s1-title">会话耗时 TOP 3 榜 (Top Sessions · 当前视口)</div>
      ${rows || `
        <div class="s1-empty">
          当前视口内没有已测量耗时的会话${zoomedViewport() ? "，可点击" : ""}
          ${zoomedViewport() ? '<button class="filter-chip js-reset-zoom" style="margin-left: 6px; padding: 2px 8px; font-size: var(--text-xs);">重置查看全部</button>' : "。"}
        </div>
      `}
    </div>
  `;
}

// Operations Breakdown 四维配置（维度键 + 短标签 + 分段色）的唯一真理源：
// 首页视口分段条 (VIEWPORT_SEGMENTS)、详情页明细行 (DETAIL_BREAKDOWN_ROWS)、
// 轮次胶囊条与会话流迷你条均由此派生，杜绝同一维度在多个视图漂移出两种颜色
const BREAKDOWN_DIMENSIONS = [
  { key: "tool", label: "本地工具", color: "var(--color-mcp)" },
  { key: "model", label: "模型推理", color: "var(--color-system)" },
  { key: "wait", label: "等待人审阅", color: "var(--color-skills)" },
  { key: "standby", label: "待命", color: "var(--state-standby)" },
];

const breakdownColor = (key) =>
  BREAKDOWN_DIMENSIONS.find((d) => d.key === key)?.color ??
  "var(--state-standby)";

// 四维耗时累加器（键序与 BREAKDOWN_DIMENSIONS 一致）：
// Codex 会话 breakdown 为 null，天然按 0 贡献并优雅降级
function addTurnBreakdown(agg, t) {
  agg.tool += t.breakdown?.tool_execution_ms ?? 0;
  agg.model += t.breakdown?.model_api_ms ?? 0;
  agg.wait += t.review_wait_ms ?? 0;
  agg.standby += t.standby_ms ?? 0;
}

function sumBreakdown(agg) {
  return { ...agg, total: agg.tool + agg.model + agg.wait + agg.standby };
}

// 多维操作分段条 (Operations Breakdown Sparkline) 的四个维度
const VIEWPORT_SEGMENTS = [
  { key: "tool", label: "本地代码工具执行 (Bash / Edit / 其他本地操作)", color: breakdownColor("tool") },
  { key: "model", label: "AI 模型推理耗时", color: breakdownColor("model") },
  { key: "wait", label: "等待人类审阅卡点 (Review Wait)", color: breakdownColor("wait") },
  { key: "standby", label: "静默就绪与待命 (Standby)", color: breakdownColor("standby") },
];

function aggregateViewportBreakdown(visibleSessions) {
  const agg = { tool: 0, model: 0, wait: 0, standby: 0 };
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
            ? `<div style="width:${pct.toFixed(1)}%; background:${seg.color};" title="${h(seg.label)}: ${pct.toFixed(1)}%"></div>`
            : "";
        }).join("")
      : "";

  const legendHtml = VIEWPORT_SEGMENTS.map((seg) => {
    const ms = agg[seg.key];
    const pct = total > 0 ? ((ms / total) * 100).toFixed(1) : "0.0";
    return `
      <div class="seg-legend-row">
        <span class="seg-legend-label">
          <span class="seg-legend-swatch" style="background:${seg.color};"></span>
          ${h(seg.label)}
        </span>
        <span class="seg-legend-val">${ms > 0 ? fmt(ms) : "—"} · <strong>${pct}%</strong></span>
      </div>
    `;
  }).join("");

  return `
    <div class="s1-box">
      <div class="s1-title">当前视口操作与耗时分布 (Operations Breakdown · ${model.visibleSessions.length} 个会话)</div>
      ${total > 0 ? `
        <div class="multi-seg-bar">${segHtml}</div>
        <div class="seg-legend">${legendHtml}</div>
      ` : `
        <div class="s1-empty">
          当前视口内的会话暂无细粒度操作拆分 (Codex 会话不提供 breakdown 事件)${zoomedViewport() ? "，可点击" : ""}
          ${zoomedViewport() ? '<button class="filter-chip js-reset-zoom" style="margin-left: 6px; padding: 2px 8px; font-size: var(--text-xs);">重置查看全部</button>' : "。"}
        </div>
      `}
    </div>
  `;
}

// ========================================================
// 首页维度聚合统计（反馈轮 3 Fix 3）：用户要的是聚合、统计，不是过滤。
// 与双列榜共用 scopedModel.visibleSessions（当前视口 + 接入工具筛选同口径），
// 在筛选芯片之外叠加三个只读聚合维度：按 Harness / 按项目 TOP 5 / 按工具 TOP 5。
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
        ${aggShareBar(pct, "var(--state-work)", `${r.agent} 的总壁钟时长占比`)}
      </div>
    `;
    })
    .join("");

  const projectRows =
    byProject.top
      .map((r) => {
        const pct =
          byProject.totalWallMs > 0 ? (r.wallMs / byProject.totalWallMs) * 100 : 0;
        return `
      <div class="agg-row">
        <div class="agg-row-top">
          <span class="agg-agent"><span class="agg-agent-name" title="${h(r.project)}">${h(r.project)}</span></span>
          <span class="agg-nums">${r.sessions} 会话 · <strong>${fmt(r.wallMs)}</strong></span>
        </div>
        ${aggShareBar(pct, "var(--state-work)", `${r.project} 的总壁钟时长占比`)}
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
        <div class="s1-title">按 Harness (会话 · 轮次 · 总壁钟时长 · 当前视口)</div>
        ${agentRows || emptyRow}
      </div>
      <div class="s1-box">
        <div class="s1-title">按项目 TOP 5 (总壁钟时长 · 当前视口)</div>
        ${projectRows || emptyRow}
      </div>
      <div class="s1-box">
        <div class="s1-title">按工具 TOP 5 (累计执行耗时)</div>
        <div class="agg-basis">基于已测量 breakdown 的 ${byTool.basisSessions} 个会话 · 未测量来源不计入</div>
        ${toolRows || `<div class="s1-empty">当前视口内没有已测量 breakdown 的会话（Codex 会话不提供 breakdown 事件）。</div>`}
      </div>
    </div>
  `;
}

// ========================================================
// 方案 A 替换模块 2：纯会话流列表
// 首页最小原子是会话 (Session)，绝不在首页平铺每一轮次；
// 点击卡片写入 #session/:id 哈希，独立详情页由后续切片落地
// ========================================================
// 迷你条：以列表内最长会话为基准的相对时长占比条（原型 SSOT 的 迷你条），
// 分段色沿用 BREAKDOWN_DIMENSIONS 四维令牌，与首页/详情页同一套颜色；
// 无 breakdown 的来源（Codex）诚实退化为单色待命条
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
      : `<div style="width:100%; background:var(--state-standby);" title="该会话无细分耗时数据（来源不提供 breakdown）"></div>`;
  // 最短可见宽度 2%：避免极短会话被压成不可感知的 0px 细线
  const widthPct = Math.max(2, (duration / maxDuration) * 100);
  return `
    <div class="stream-mini-bar" role="img" aria-label="相对最长会话的耗时迷你条">
      <div class="stream-mini-bar-fill" style="width:${widthPct.toFixed(1)}%;">${fill}</div>
    </div>`;
}

// ========================================================
// 接入工具筛选 (Fix: "首页展示的内容都不知道是哪个 harness 的")
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
      .map(
        (s) => `
      <div class="session-stream-card" data-open-session="${h(s.id)}" role="button" tabindex="0" aria-label="进入会话详情页：${h(s.title || s.project)}">
        <div class="stream-left">
          ${agentMark(s.agent)}
          <span class="stream-project-pill" title="${h(s.project)}">${h(s.project)}</span>
          <strong class="stream-title">${h(s.title || s.project)}</strong>
          <span class="stream-turns-pill">${s.turns.length} 轮交互</span>
        </div>
        <div class="stream-right">
          <span class="stream-duration">${fmt(sessionClippedPeriodMs(s) || null)}</span>
          <span class="stream-enter-chip">进入会话详情页 →</span>
        </div>
        ${streamMiniBarHtml(s, maxDuration)}
      </div>
    `,
      )
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
  if (done === total) return { label: "已完结 (Completed)", cls: "ok" };
  return { label: `存在未完结轮次 (${done}/${total} 轮完结)`, cls: "warn" };
}

// 会话专属 Operations Breakdown 聚合：本地工具 / 模型推理 / 等待人审阅 / 待命
// （sessionWallSpan 已并入上方 PURE HELPERS 纯函数块）
function sessionBreakdown(s) {
  const agg = { tool: 0, model: 0, wait: 0, standby: 0 };
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
// - Claude：tool_result 只有记录时刻 → duration = result.at_ms − use.at_ms − 区间内等待人审阅重叠
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
    if (r.end_ms != null && r.end_ms >= r.at_ms) {
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
    });
  }
  return calls;
}

// ------------------------------------------------------------------
// 抽屉总账回填（反馈轮 3 Fix 2）：breakdown 为 null 的轮次（未完结轮、
// Codex 等不落盘分解的来源）凡是可从一手事件推导的指标都要回填，
// 推导不出来的维度给出诚实的一行原因，而不是孤零零一个 "—"
// ------------------------------------------------------------------
// 总壁钟时长 (WALL TIME)：当前范围内该会话轮次的首尾物理跨度
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

  // 壁钟时长：elapsed_ms 优先；open 轮次回退为 起点→当前时刻 的已进行跨度
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

// 会话 WALL TIME 口径（与 TOP 3 榜、详情页 KPI 同源）：首末轮次的物理壁钟跨度
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

// 按项目：全部行按总壁钟时长排序，上层取 TOP 5 并对剩余数量诚实披露
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

// 慢操作阈值：单次工具调用超过 15 秒即视为慢瓶颈（用户可见文案统一写作 "15s"）
const SLOW_OP_THRESHOLD_MS = 15000;

// 慢操作（单次 >15s）跨轮收集，按耗时倒序
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

// 自动化自治率 (AUTONOMY)：纯工作耗时 ÷ (纯工作 + 等待人审阅) × 100%
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
      "该会话暂无细分耗时数据（Codex 会话不提供 breakdown 事件），无法进行瓶颈归因。",
    ];
  }
  const dims = [
    { key: "tool", label: "本地工具执行", verdict: "瓶颈为本地工具/脚本执行" },
    { key: "model", label: "AI 模型推理", verdict: "瓶颈为模型推理等待" },
    { key: "wait", label: "等待人审阅", verdict: "瓶颈为等待人审阅卡点" },
    { key: "standby", label: "静默待命", verdict: "会话大部分时间处于静默待命" },
  ].map((d) => ({ ...d, pct: (b[d.key] / b.total) * 100 }));
  const top = dims.slice().sort((a, b) => b.pct - a.pct)[0];
  const lines = [
    `主要耗时源：${top.label} 占 ${top.pct.toFixed(1)}%，${top.verdict}。`,
  ];
  const waitPct = (b.wait / b.total) * 100;
  lines.push(
    waitPct >= 25
      ? `等待人审阅占比 ${waitPct.toFixed(1)}%，建议提升自动化（预设工具权限白名单，减少授权卡点）。`
      : `等待人审阅占比仅 ${waitPct.toFixed(1)}%，人机交付流转紧凑。`,
  );
  const slow = slowToolCalls(s);
  lines.push(
    slow.length
      ? `检测到 ${slow.length} 项 >15s 慢操作，最慢为 ${toolLabel(slow[0].name)}（${fmt(slow[0].duration_ms)}，轮次 #${slow[0].turnIndex}）。`
      : "未检测到 >15s 的慢操作，执行节奏平稳。",
  );
  return lines;
}

function detailKpiCard(label, val, sub, tone = "") {
  return `
    <div class="kpi-card${tone ? ` ${tone}` : ""}">
      <div class="kpi-label">${h(label)}</div>
      <div class="kpi-val">${h(val)}</div>
      <div class="kpi-sub">${h(sub)}</div>
    </div>`;
}

const DETAIL_BREAKDOWN_ROWS = [
  { key: "tool", label: "本地工具 (Tool Execution)", color: breakdownColor("tool") },
  { key: "model", label: "模型推理 (Model API)", color: breakdownColor("model") },
  { key: "wait", label: "等待人审阅 (Review Wait)", color: breakdownColor("wait") },
  { key: "standby", label: "待命 (Standby)", color: breakdownColor("standby") },
];

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
            ? `<div style="width:${pct.toFixed(1)}%; background:${r.color};" title="${h(r.label)}: ${pct.toFixed(1)}%"></div>`
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
            <div class="breakdown-row">
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
      : `<div class="s1-empty">该会话暂无细分耗时数据 — 当前接入的 Codex 会话不提供 breakdown 事件，不做任何伪造拆分。</div>`;

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
    <h2 class="detail-title">${h(s.title || s.project)}</h2>

    <section class="session-breakdown-full">
      <div class="breakdown-head">
        <strong>本会话操作与耗时分布 (Session Operations Breakdown)</strong>
        <span class="breakdown-head-val">${b.tool + b.model > 0 ? `纯工作净值 ${fmt(b.tool + b.model)} (${workPct}%)` : "无纯工作耗时证据"}</span>
      </div>
      ${breakdownBody}
    </section>

    <div class="detail-kpis">
      ${detailKpiCard(
        "总壁钟时长 (WALL TIME)",
        wall.wallMs !== null ? fmt(wall.wallMs) : "—",
        "开始至完结绝对跨度（当前统计范围内）",
      )}
      ${detailKpiCard(
        "纯工作有效净值 (ACTIVE WORK)",
        autonomy.workSum !== null ? fmt(autonomy.workSum) : "—",
        autonomy.workSum !== null ? "模型推理 + 本地工具执行" : "该会话未提供三态切分",
        "work",
      )}
      ${detailKpiCard(
        "自动化自治率 (AUTONOMY)",
        autonomy.rate !== null ? `${autonomy.rate.toFixed(1)}%` : "—",
        autonomy.rate !== null
          ? `${autonomy.confirmations} 次人工确认卡点`
          : "该会话未提供三态切分",
      )}
      ${detailKpiCard(
        "慢操作瓶颈数",
        `${slow.length} 项`,
        ">15s 慢本地操作",
        slow.length ? "alert" : "",
      )}
    </div>

    <div class="detail-diag-grid">
      <div class="diag-card">
        <div class="diag-head">
          <span>慢操作 TOP 榜 (Slowest Operations)</span>
          <span class="diag-head-sub">单次调用耗时 > 15s · 倒序</span>
        </div>
        ${
          slowRows.length
            ? slowRows.join("")
            : `<div class="s1-empty">未检测到 >15s 的慢操作。</div>`
        }
      </div>
      <div class="diag-card">
        <div class="diag-head">
          <span>瓶颈诊断与效率归因 (Attribution)</span>
          <span class="diag-head-sub ok">系统自检结论</span>
        </div>
        <div class="diag-attribution">
          ${attributionLines(s).map((l) => `<p>• ${h(l)}</p>`).join("")}
        </div>
      </div>
    </div>
    <!-- 切片 3：轮次时序流胶囊 (Turn Capsules) -->
    ${turnCapsuleSection(s)}
  `;
}

// ========================================================
// 切片 3：轮次时序流胶囊 (Turn Capsules) + 右侧 Turn Inspector 抽屉联动
// ========================================================

// 单轮 260px 迷你占比条：模型推理 / 本地工具 / 等待人审阅 / 待命，
// 全部来自 slice-1 色彩令牌。Codex 会话 breakdown 为 null →
// 不伪造分段，诚实退化为单色总时长条。
function capsuleBarHtml(t) {
  const tool = t.breakdown?.tool_execution_ms ?? 0;
  const model = t.breakdown?.model_api_ms ?? 0;
  const wait = t.review_wait_ms ?? 0;
  const standby = t.standby_ms ?? 0;
  const known = tool + model + wait + standby;
  const segs = [
    { ms: model, color: "var(--color-system)", label: "模型推理" },
    { ms: tool, color: "var(--color-mcp)", label: "本地工具" },
    { ms: wait, color: "var(--color-skills)", label: "等待人审阅" },
    { ms: standby, color: "var(--state-standby)", label: "待命" },
  ].filter((x) => x.ms > 0);
  if (known > 0 && segs.length) {
    return segs
      .map(
        (x) =>
          `<div style="width:${((x.ms / known) * 100).toFixed(1)}%; background:${x.color};" title="${x.label}: ${fmt(x.ms)}"></div>`,
      )
      .join("");
  }
  const total = t.elapsed_ms ?? t.period_ms ?? null;
  const why = total
    ? "该轮无细分耗时数据（该来源不提供 breakdown），仅按总时长展示"
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
        <span class="capsule-title">${h(capsuleTitle(t))}${hasSlow ? '<em class="capsule-slow-flag">含 &gt;15s 慢操作</em>' : ""}</span>
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
// 模块 4：两段式弹性下钻抽屉 (480px, 上总账 + 下慢工具清单)
// 真实消费 API 暴露数据，严禁假数据伪造
// ========================================================
function openDrawer(turn, session) {
  state.selectedTurnId = turn.id;
  state.activeSessionId = session.id;

  const d = $("#detailDrawer");
  if (!d) return;

  const turnIndex = session.turns.findIndex((t) => t.id === turn.id);
  // 抽屉标题旁的接入工具徽标：一眼可见这一轮来自哪个 harness
  const markEl = $("#drawerAgentMark");
  if (markEl) markEl.innerHTML = agentMark(session.agent);
  const titleEl = $("#drawerTurnTitle");
  if (titleEl) {
    titleEl.textContent =
      turnIndex === -1
        ? session.title
          ? `${session.title} · 轮次详情`
          : `会话 ${session.project} · 轮次详情`
        : `轮次 #${turnIndex + 1} 深度检视 · ${session.title || session.project}`;
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

  // 逐次调用粒度的工具调用栈（与慢操作榜单同一口径），>15s 标红
  const perCallStack = perCallToolTimings(turn).sort(
    (a, b) => b.duration_ms - a.duration_ms,
  );

  // 耗时倒序排序
  toolsList.sort((a, b) => b.duration_ms - a.duration_ms);

  // 可选分项（如 Pi 的事件流切分）：仅在数据落盘存在时渲染该小节
  const unclassifiedMs = turn.breakdown?.unclassified_delay_ms ?? null;
  const waitCaption = unclassifiedMs !== null
    ? "来源未落盘审批事件 · 无法归因"
    : "授权审批与决策对齐卡点";
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
        <span style="font-size:var(--text-sm); font-weight:700; color:var(--fg-title);">未分类延迟 (Unclassified)</span>
        <span class="tool-time">${fmt(unclassifiedMs)}</span>
      </div>
      <div style="font-size:var(--text-xs); color:var(--fg-muted); margin-top:4px;">工具就绪至实际开始的间隔；来源未落盘审批事件，可能含审批等待、调度或限流，不计入等待人审阅。</div>
    </div>
  `
      : "";

  const toolsHtml = perCallStack.length
    ? perCallStack.map((c) => {
        const isSlow = c.duration_ms > SLOW_OP_THRESHOLD_MS;
        return `
          <div class="tool-exec-card${isSlow ? " slow" : ""}" data-tool-call="${h(c.callId || "")}">
            <div class="tool-exec-head">
              <strong title="${h(c.name)}">${h(toolLabel(c.name))}</strong>
              <span class="tool-exec-time${isSlow ? " slow" : ""}">${fmt(c.duration_ms)}${isSlow ? " (慢瓶颈)" : ""}</span>
            </div>
            <div class="tool-exec-detail">${h(c.name)}</div>
          </div>
        `;
      }).join("")
    : `<div class="empty" style="padding:16px;">本轮未调用外部工具/脚本 (纯模型推理)。</div>`;

  $("#drawerBody").innerHTML = `
    <!-- 按需读取的该轮提问与思考文本（切片 3）：加载/错误状态诚实可见 -->
    <div>
      <div class="drawer-section-label">用户输入 (User Prompt)</div>
      <div class="drawer-transcript-box" id="drawerPrompt">正在读取本机源文件…</div>
      <div class="drawer-section-label" style="margin-top:14px;">模型思考与推理 (CoT & Reasoning)</div>
      <div class="drawer-transcript-box" id="drawerThinking">正在读取本机源文件…</div>
    </div>

    <!-- 顶部总账微卡 -->
    <div>
      <div style="font-size:12px; font-weight:700; margin-bottom:8px; color:var(--fg-title); display:flex; justify-content:space-between;">
        <span>耗时构成总账 (Rollup Summary)</span>
        <span style="font-size:11px; color:var(--state-work); font-weight:600;">一手数据核算</span>
      </div>
      <div class="drawer-kpi-grid">
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">模型推理耗时 (API)</div>
          <div class="drawer-kpi-val">${apiMs !== null ? fmt(apiMs) : "—"}</div>
          <div class="drawer-kpi-sub">${h(apiMs !== null ? turn.models.join(" / ") || "模型上下文未知" : rollupEvidenceNote(turn) || "模型上下文未知")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-work);">
          <div class="drawer-kpi-title">工具执行耗时 (Tools)</div>
          <div class="drawer-kpi-val">${toolMs !== null ? fmt(toolMs) : "—"}</div>
          <div class="drawer-kpi-sub">${h(toolMs !== null ? `${toolsList.length} 项工具执行${rollup.toolBackfilled ? " · 逐次调用累计" : ""}` : rollupEvidenceNote(turn) || "0 项工具执行")}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-wait);">
          <div class="drawer-kpi-title">等待人审阅 (Review Wait)</div>
          <div class="drawer-kpi-val">${wait !== null ? fmt(wait) : "—"}</div>
          <div class="drawer-kpi-sub">${h(wait !== null ? waitCaption : rollupEvidenceNote(turn) || waitCaption)}</div>
        </div>
        <div class="drawer-kpi-box" style="border-top:3px solid var(--state-idle);">
          <div class="drawer-kpi-title">单轮壁钟时长 (Wall Time)</div>
          <div class="drawer-kpi-val">${fmt(wall)}</div>
          <div class="drawer-kpi-sub">有效工作率: ${workRate !== null ? `${workRate}%` : "—"}${rollup.wallBackfilled ? " · 该轮进行中，按起点至今累计" : ""}</div>
        </div>
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

    <!-- 详细脚本与慢工具清单 -->
    <div>
      <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:8px;">
        <span style="font-size:12px; font-weight:700; color:var(--fg-title);">本轮工具调用栈 (Operations Stack)</span>
        <span style="font-size:11px; color:var(--fg-muted);">单次调用粒度 · 按耗时倒序 · &gt;15s 标红</span>
      </div>
      <div class="tool-list-container">
        ${toolsHtml}
      </div>
    </div>
  `;

  // 按需加载该轮提问/思考文本（缓存按 session 生效，失败时诚实提示）
  loadDrawerTranscript(session, turn);

  d.classList.remove("collapsed");
}

function closeDrawer() {
  const d = $("#detailDrawer");
  if (d) d.classList.add("collapsed");
  state.selectedTurnId = null;
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

// 按需拉取该会话的轮次提问/思考文本（GET /api/session/transcript），
// 按 session_id 缓存：同会话内切换轮次不重复请求
async function loadDrawerTranscript(session, turn) {
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
  if (!t) {
    // 来源文件整体缺失/不可读时，后端会以 turns:[] + missing_fields 说明原因；
    // missing_fields 里可能混有思考链加密等与提问无关的说明，
    // 提问槽位必须给出提问自己的诚实文案，绝不串槽。
    promptEl.innerHTML = drawerHint("本机记录未包含该轮的用户输入文本。");
    cotEl.innerHTML = drawerHint(
      session.agent === "Codex"
        ? "Codex 官方记录对模型思考链加密（ZDR），本机无法解密展示。"
        : "该来源未记录该轮的模型思考文本。",
    );
  } else {
    if (t.prompt) promptEl.textContent = t.prompt;
    else promptEl.innerHTML = drawerHint("本机记录未包含该轮的用户输入文本。");
    if (t.thinking) cotEl.textContent = t.thinking;
    else
      cotEl.innerHTML = drawerHint(
        session.agent === "Codex"
          ? "Codex 官方记录对模型思考链加密（ZDR），本机无法解密展示。"
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
    ${timeline(model)}
    <div class="s1-grid">
      ${topSessionsCard(scopedModel)}
      ${viewportBreakdownCard(scopedModel)}
    </div>
    ${viewportAggregationCard(scopedModel)}
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
            const displayTitle = s.title ? h(s.title) : h(s.project);
            const subTitle = `${h(s.project)} · ${h(s.id.slice(0, 16))}`;
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
    (s.project + " " + s.id + " " + s.agent + " " + (s.title || "")).toLowerCase().includes(needle),  );
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
  render();
  try {
    await persistDirectory(agent, draft);
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
    `${head(s.title || s.project, `${s.project} · ${s.agent} · ${s.id}`)}     <p class="sub" style="margin-bottom:16px;">仅显示当前日期范围涉及的轮次。完整轮次时长与本期分摊分别列出。</p>
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
    // 先落盘所有未保存的接入改动，再按服务端配置同步（反馈轮 4 #2/#5）
    const savedCount = await persistDrafts();
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
         <p class="sub">这些文件是 Codex 为已导入会话生成的分叉快照：内容为父会话历史的复印件，不含子 Agent 的实际工作（子 Agent 机时已在父会话中计入）。导入它们会把同一段工作重复计时，因此保持排除。</p>`,
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
  // 0. 方案 A 会话卡片 / TOP 榜行：写入 #session/:id 哈希进入独立详情页
  //    （路由解析由后续切片落地；id 内含 "/"，需 encodeURIComponent）
  const sessionCard = e.target.closest("[data-open-session]");
  if (sessionCard) {
    location.hash = "#session/" + encodeURIComponent(sessionCard.dataset.openSession);
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

// ESC 键随手关闭抽屉与弹层，支持 Tab 焦点陷阱 (Focus Trap)
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
