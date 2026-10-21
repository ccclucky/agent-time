"use strict";
const $ = (s) => document.querySelector(s);
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
const icons = {
  overview: '<path d="M4 19V11M10 19V5M16 19V8"/>',
  sessions:
    '<rect x="4" y="3" width="13" height="17" rx="2"/><path d="M7 8h7M7 12h7M7 16h4"/>',
  compare: '<path d="m11 2 9 5v10l-9 5-9-5V7zM2 7l9 5 9-5M11 12v10"/>',
  sources:
    '<ellipse cx="11" cy="5" rx="8" ry="3"/><path d="M3 5v12c0 4 16 4 16 0V5M3 11c0 4 16 4 16 0"/>',
};
const icon = (n) =>
  `<svg class="icon" viewBox="0 0 23 23" aria-hidden="true">${icons[n]}</svg>`;
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
};
let focusBeforeDialog = null,
  requestVersion = 0;
function fmt(ms) {
  if (ms === null || ms === undefined) return "暂无数据";
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  const m = Math.floor(ms / 60000);
  return m >= 60
    ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
    : `${m}m`;
}
const stamp = (ms) =>
  ms === null
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
  $("#error").innerHTML = message ? `<div class="err">${h(message)}</div>` : "";
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
  $("#title").textContent = names[state.page][0];
  $("#subtitle").textContent = names[state.page][1];
  $("#nav").innerHTML = Object.entries(names)
    .map(
      ([key, value]) =>
        `<button data-page="${key}" class="${state.page === key ? "active" : ""}" ${state.page === key ? 'aria-current="page"' : ""}>${icon(key)}${value[0]}</button>`,
    )
    .join("");
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
  if (state.sources.failed_sources)
    error(
      `有 ${state.sources.failed_sources} 个数据源最近同步失败，当前显示其上次成功导入的快照。请检查源文件后重新同步。`,
    );
  $("#content").innerHTML = {
    overview: overview,
    sessions: sessions,
    compare: compare,
    sources: sources,
  }[state.page]();
  if ($("#search")) $("#search").value = state.query;
}
function noData() {
  return `<section class="panel empty"><h2>这个时间范围还没有会话记录</h2><p>已登记 ${state.sources.registered_files} 个本地文件。请在配置页启用 Codex 数据目录并保存，或调整日期范围。</p><button class="btn primary" data-page="sources">配置数据目录</button></section>`;
}
function stats() {
  const s = state.report.summary;
  return `<div class="stats"><div class="stat"><button class="metricbutton" data-metric="processing"><label>已记录的处理耗时</label><div class="number">${fmt(s.processing_ms)}</div><small>各轮执行开始到结束的时间相加 ↗</small></button></div><div class="stat"><button class="metricbutton" data-metric="union"><label>有任务在处理的时长</label><div class="number">${fmt(s.processing_union_ms)}</div><small>同时运行的时间仅计一次 ↗</small></button></div><div class="stat"><button class="metricbutton" data-metric="coverage"><label>已测量 / 已记录轮次</label><div class="number">${s.measured_turns} / ${s.turns}</div><small>未结束或异常记录单列 ↗</small></button></div><div class="stat"><button class="metricbutton" data-page="sessions"><label>会话数</label><div class="number">${s.sessions}</div><small>查看全部贡献会话 ↗</small></button></div></div>`;
}
function overview() {
  const s = state.report.summary;
  return `<div class="layout"><div>${stats()}${
    s.sessions
      ? `<section class="panel"><div class="panelhead"><h2>时间花销汇总</h2><button class="textbtn" data-metric="processing">展开账本 →</button></div><div class="totals"><div class="keyrow"><label>已测量轮次的处理耗时</label><b>${fmt(s.processing_ms)}</b></div><div class="keyrow"><label>其中：Agent 纯工作</label><span class="disabled">无法拆分</span></div><div class="keyrow"><label>其中：等待确认或补充</label><span class="disabled">无法拆分</span></div><div class="stack"><span style="width:100%;background:#cdd4e5"></span></div><p class="sub">总耗时可测量，内部构成未知。Codex 历史记录没有完整的确认与恢复事件，不能把整段时间当成 Agent 纯工作。</p></div></section><section class="panel"><div class="panelhead"><h2>贡献最多的会话</h2><button class="textbtn" data-page="sessions">查看全部 →</button></div>${table(
          state.report.sessions
            .slice()
            .sort((a, b) => b.period_ms - a.period_ms)
            .slice(0, 5),
        )}</section>`
      : noData()
  }</div><section class="rail"><div><h2>数字的边界</h2><p class="sub">${h(state.report.basis)}</p><div class="divider"></div><div class="keyrow"><label>已完成</label><b>${s.statuses.completed} 轮</b></div><div class="keyrow"><label>已中止（计入已测量耗时）</label><b>${s.statuses.aborted} 轮</b></div><div class="keyrow"><label>执行失败（计入已测量耗时）</label><b>${s.statuses.failed} 轮</b></div><div class="keyrow"><label>暂无结束记录</label><b>${s.statuses.open} 轮</b></div><div class="keyrow"><label>缺少起点或记录冲突</label><b>${s.statuses.incomplete + s.statuses.invalid} 轮</b></div><div class="divider"></div><h2>还不能回答的部分</h2><p class="sub">Agent 纯工作时间、等待确认时间、答复后到下次提问的真实间隔，暂时无法精确测量。未显示为零。</p><button class="textbtn" data-metric="coverage">查看数据完整性 →</button></div></section></div>`;
}
function table(rows) {
  if (!rows.length) return '<div class="empty">没有匹配的会话记录。</div>';
  return `<div class="swipehint">左右滑动查看完整表格 →</div><div class="tablewrap" tabindex="0" aria-label="会话明细，可横向滚动"><table><thead><tr><th>项目 / 会话</th><th>工具</th><th>本期处理耗时</th><th>已测量轮次</th><th>最近开始</th><th></th></tr></thead><tbody>${rows.map((s) => `<tr><td><button class="textbtn" data-session="${h(s.id)}">${h(s.project)}<span class="muted" style="display:block;font-size:10px;font-weight:400">${h(s.id.slice(0, 16))}</span></button></td><td>Codex</td><td>${fmt(s.measured_turns ? s.period_ms : null)}</td><td><span class="tag ${s.measured_turns === s.turns.length ? "" : "warn"}">${s.measured_turns}/${s.turns.length}</span></td><td class="muted">${h(stamp(Math.max(...s.turns.map((t) => t.start_ms || t.end_ms || 0))))}</td><td><button class="textbtn" data-session="${h(s.id)}" aria-label="查看会话 ${h(s.id)}">→</button></td></tr>`).join("")}</tbody></table></div>`;
}
function filtered() {
  const needle = state.query.trim().toLowerCase();
  const rows = state.report.sessions.filter((s) =>
    (s.project + " " + s.id + " " + s.agent).toLowerCase().includes(needle),
  );
  return state.sort === "duration"
    ? rows.sort((a, b) => b.period_ms - a.period_ms)
    : rows;
}
function sessions() {
  return `<div class="filters"><input id="search" type="search" aria-label="搜索会话" placeholder="搜索项目、工具或会话 ID"><select id="sort" aria-label="会话排序"><option value="recent" ${state.sort === "recent" ? "selected" : ""}>最近开始</option><option value="duration" ${state.sort === "duration" ? "selected" : ""}>处理耗时最多</option></select><button class="btn" data-action="export">导出当前明细 CSV</button><span class="sub">${filtered().length} 个会话</span></div><section class="panel">${table(filtered())}</section><p class="sub">本期耗时按所选日期截取；详情同时提供每轮的完整时长。记录没有结束事件时，不推测仍在运行或已完成。</p>`;
}
function compare() {
  const groups = new Map();
  for (const s of state.report.sessions)
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
  return `<div class="notice">首批仅接入 Codex。以下按执行记录中的模型上下文分组，不代表已经验证每次实际模型调用，也不按整轮时长重复分配给多个模型。耗时更短不等于质量更好。</div><section class="panel"><div class="panelhead"><h2>按模型上下文汇总</h2></div>${groups.size ? `<div class="tablewrap"><table><thead><tr><th>模型上下文</th><th>本期已记录处理耗时</th><th>已测量 / 未测量轮次</th></tr></thead><tbody>${[...groups].map(([key, g]) => `<tr><td>${h(key)}</td><td>${fmt(g.n ? g.ms : null)}</td><td>${g.n} / ${g.unknown}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">这个时间范围还没有可分组的记录。</div>'}</section><p class="sub">Token、金额和模型响应性能分布尚未接入，不从未知数据推算。</p>`;
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
  return `<div class="directory-grid">${state.directories
    .map((item) => {
      const draft = directoryDraft(item),
        dirty = Boolean(state.drafts[item.agent]),
        saving = state.saving.has(item.agent);
      return `<section class="panel directory-card" data-directory-card="${h(item.agent)}"><div class="directory-title"><h2>${h(item.name)}</h2><span class="tag ${item.supported ? "" : "warn"}">${item.supported ? "可接入" : "尚未适配"}</span></div><label class="directory-label" for="directory-${h(item.agent)}">${item.agent === "opencode" ? "会话数据目录" : "工具数据目录"}</label><div class="directory-input"><input id="directory-${h(item.agent)}" data-directory-input="${h(item.agent)}" type="text" spellcheck="false" autocomplete="off" ${saving ? "disabled" : ""} value="${h(draft.path)}" placeholder="${h(item.default_path || "默认位置未确定，请手动指定")}"><button class="btn" ${saving ? "disabled" : ""} data-reset-directory="${h(item.agent)}">恢复默认</button></div><p class="directory-status" data-directory-status="${h(item.agent)}" aria-live="polite">${dirty ? "有未保存的更改；保存后重新检测" : h(labels[item.status]) + " · " + h({ custom: "自定义目录", environment: "来自环境变量", default: "按上游默认规则推导", unresolved: "当前环境无法确定" }[item.source])}</p>${item.resolved_path ? `<p class="directory-resolved">展开后的目录：${h(item.resolved_path)}</p>` : ""}<details class="location-details"><summary>会话位置与依据</summary>${item.history_locations.length ? `<ul>${item.history_locations.map((path) => `<li>${h(path)}</li>`).join("")}</ul>` : ""}<p>${h(item.location_note)}</p>${item.evidence_url ? `<a href="${h(item.evidence_url)}" target="_blank" rel="noopener noreferrer">查看上游目录规则 ↗</a>` : ""}</details><div class="directory-actions"><label class="directory-toggle"><input type="checkbox" data-directory-enabled="${h(item.agent)}" ${draft.enabled ? "checked" : ""} ${item.supported && !saving ? "" : "disabled"}>从此目录读取会话</label><button class="btn ${item.supported ? "primary" : ""}" data-save-directory="${h(item.agent)}" ${state.saving.has(item.agent) ? "disabled" : ""}>${state.saving.has(item.agent) ? "保存中…" : draft.enabled ? "保存并同步" : "保存设置"}</button></div>${!item.supported ? '<p class="sourcecap">目前只能保存目录；适配器就绪前不会读取其中的记录。</p>' : ""}</section>`;
    })
    .join("")}</div>`;
}
function sources() {
  return `<div class="notice">${h(state.sources.privacy)} 预填位置根据工具上游规则与当前启动环境推导，只检测目录是否存在，不读取其中内容。勾选“从此目录读取会话”并保存后，才会同步已支持的工具。更换目录或关闭接入不会删除已导入数据。</div>${directoryCards()}<section class="panel"><div class="panelhead"><h2>本地同步</h2><span class="mutedpill">已登记 ${state.sources.registered_files} 个文件</span></div><div style="padding:0 20px 22px"><p class="sub">右上角“同步记录”会重新发现已启用目录中的新会话，并更新历史快照。仅扫描指定的会话子目录，不读取凭据或工具配置，也不把问题、答复内容保存到数据库。</p><p class="sourcecap">上次成功导入：${h(state.sources.last_imported_at_utc || "尚未导入")}${state.sources.last_imported_at_utc ? " UTC" : ""}</p><details><summary class="textbtn">高级：通过命令行导入指定文件或目录</summary><pre class="sourcecode"># 在仓库目录中运行
npm run dev -- import --agent codex /path/to/local/session.jsonl</pre><p class="sub">命令行显式导入的文件也会在同步时更新。停止该目录接入不会删除这些手动导入的来源。</p></details></div></section>${state.sources.imports.length ? `<section class="panel"><div class="panelhead"><h2>已登记的会话来源</h2></div><div class="tablewrap"><table><thead><tr><th>项目 / 会话</th><th>上次导入（UTC）</th><th>导入提示</th></tr></thead><tbody>${state.sources.imports.map((x) => `<tr><td>${h(x.project)}<br><span class="muted">${h(x.session_id.slice(0, 16))}</span></td><td>${h(x.imported_at_utc)}</td><td>${x.issues.length ? x.issues.map(h).join("<br>") : "可验证记录已导入；工作与等待拆分仍未知"}</td></tr>`).join("")}</tbody></table></div></section>` : ""}<p class="sub">目录设计参考 cc-switch 的默认位置、自定义覆盖和恢复默认模式。这里只管理 AgentTime 的读取位置，不修改其他工具的配置。默认路径取自各工具上游源码，cc-switch 仅作为交互参考。无法确定的位置留空；其他进程的环境与启动参数无法自动得知，可手动修改。</p>`;
}
async function saveDirectory(agent) {
  if (state.saving.has(agent) || state.busy) return;
  const item = state.directories.find((x) => x.agent === agent),
    draft = directoryDraft(item);
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
    else {
      toast("目录设置已保存；没有读取新的会话内容。");
    }
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
  const status = document.querySelector(`[data-directory-status="${agent}"]`);
  if (status) status.textContent = "有未保存的更改；保存后重新检测";
  const button = document.querySelector(`[data-save-directory="${agent}"]`);
  if (button)
    button.textContent = state.drafts[agent].enabled
      ? "保存并同步"
      : "保存设置";
}

function open(html, wide = false) {
  focusBeforeDialog = document.activeElement;
  $("#layer").innerHTML =
    `<div class="overlay ${wide ? "" : "modaloverlay"}" data-overlay><section class="${wide ? "drawer" : "modal"}" role="dialog" aria-modal="true" aria-labelledby="dialogtitle" tabindex="-1">${html}</section></div>`;
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
  open(
    `${head(s.project, `${s.agent} · ${s.id}`)}<p class="detailsummary">仅显示当前日期范围涉及的轮次。完整轮次时长与本期分摊分别列出。</p>${s.issues.map((x) => `<div class="notice">${h(x)}</div>`).join("")}<div class="detailstats"><div><small>本期已记录处理耗时</small><strong>${fmt(s.measured_turns ? s.period_ms : null)}</strong></div><div><small>已测量 / 当前轮次</small><strong>${s.measured_turns} / ${s.turns.length}</strong></div><div><small>工作与等待拆分</small><strong>未知</strong></div></div><h3>每轮执行的起止记录</h3><p class="sub">这里的一轮按 Codex 执行记录识别。开始事件不一定等于你点击提交的时刻，不能据此计算真实的用户响应间隔。</p>${s.turns.map((t, i) => `<article class="turn"><div class="turnhead"><b>第 ${i + 1} 轮</b><span class="tag ${t.elapsed_ms === null ? "warn" : ""}">${statuses[t.status]}</span></div><p class="sub">${h(t.models.join(" / ") || "模型上下文未知")}</p><div class="turnvalues"><span>完整处理耗时：${fmt(t.elapsed_ms)}</span><span>本期计入：${fmt(t.period_ms)}</span></div>${t.reason ? `<p class="notice">${h(t.reason)}</p>` : ""}<ul class="eventlist">${t.events.map((e) => `<li><time>${h(stamp(e.at_ms))}</time>${{ start: "开始执行", complete: "执行完成", abort: "执行中止", fail: "执行失败", model: "记录模型上下文" }[e.kind]}</li>`).join("")}</ul></article>`).join("")}<p class="sub sectionspace">这些是记录中的时间事实，不代表你实际操作或等待的时长。不展示问题和答复内容。</p>`,
    true,
  );
}
function definitions() {
  open(
    `${head("这些时间怎么算？")}<dl><dt>会话与一轮交互</dt><dd>会话是同一对话中的一组交互；一轮交互通常从你提交一次问题或指令，到 Agent 完成答复。工具调用和确认属于同一轮。首批 Codex 使用可验证的执行起止记录，未声称精确记录用户提交时刻。</dd><dt>已记录的处理耗时</dt><dd>把每轮开始执行到完成、失败或中止的时间相加。可能包含等待你确认或补充的时间；不能全部当成纯工作。</dd><dt>有任务在处理的时长</dt><dd>多个任务同时运行的一段时间只计一次。例如 A 在 10:00–10:30 运行，B 在 10:15–10:45 运行：累计 60 分钟，不重复计时为 45 分钟。此项仍可能包含等待确认的时间。</dd><dt>为什么工作和等待显示未知？</dt><dd>Codex 历史文件默认不保存完整审批等待事件。缺少记录不等于没有等待，因此不推算、不填零。</dd><dt>时间范围与未完成记录</dt><dd>时区取自浏览器。跨天轮次按与所选日期重叠的部分计入，右侧日期包含当天。没有结束或起点冲突的轮次不计入已测量耗时。</dd><dt>汇总是否等于全部真实使用？</dt><dd>不等于。只涵盖已选择导入、可支持、具有有效起止记录的本地数据。记录外的活动和未知来源不包含在内。</dd></dl>`,
  );
}
function metric(kind) {
  const s = state.report.summary;
  const titles = {
    processing: "时间花销汇总明细",
    union: "同时运行的时间，如何计算？",
    coverage: "记录完整性",
  };
  let content = "";
  if (kind === "coverage") {
    content = `<div class="notice">工作、确认等待与用户响应间隔目前均无法独立测量。已测量轮次仅表示“执行开始到结束”可测量。</div><div class="keyrow"><label>已测量起止耗时</label><b>${s.measured_turns} 轮</b></div>${Object.entries(
      s.statuses,
    )
      .map(
        ([k, v]) =>
          `<div class="keyrow"><label>${statuses[k]}</label><span>${v} 轮</span></div>`,
      )
      .join(
        "",
      )}<p class="sub">“暂无结束记录”并不证明仍在执行；可能是文件被截断或进程中断。没有导入的数据无法估算覆盖率。</p>`;
  } else {
    content = `<div class="detailstats"><div><small>累计处理耗时</small><strong>${fmt(s.processing_ms)}</strong></div><div><small>不重复计时</small><strong>${fmt(s.processing_union_ms)}</strong></div><div><small>重复累计的部分</small><strong>${fmt(s.overlap_ms)}</strong></div></div><p class="metricexplain">${h(state.report.basis)} ${kind === "union" ? "以下时间线各行代表一轮执行，重叠的部分只计算一次。三个或更多同时运行也采用同一规则；差额并非独立时间段的长度。" : "每行贡献按本期范围截取；总额中有多少是纯工作、多少是确认等待，目前均未知。"}</p>${kind === "union" ? intervalChart() : ""}`;
  }
  open(
    `${head(titles[kind], `${state.start} — ${state.end} · ${timezone}`)}${content}<h3 class="sectionspace">来源会话 · 点击继续核对</h3>${table(state.report.sessions)}`,
    true,
  );
}
function intervalChart() {
  const turns = state.report.sessions
    .flatMap((s) =>
      s.turns.filter((t) => t.period_ms !== null).map((t) => ({ s, t })),
    )
    .sort((a, b) => a.t.start_ms - b.t.start_ms)
    .slice(0, 12);
  if (!turns.length) return '<div class="empty">暂无可测量区间。</div>';
  const lo = Math.min(...turns.map((x) => x.t.start_ms)),
    hi = Math.max(...turns.map((x) => x.t.end_ms)),
    span = Math.max(hi - lo, 1);
  return `<div class="panel"><div class="panelhead"><h2>完整执行区间（前 12 轮）</h2></div><div class="recordchart"><div class="chartaxis"><span>${h(stamp(lo))}</span><span>${h(stamp(hi))}</span></div>${turns.map(({ s, t }) => `<div class="lane"><label>${h(s.project)}</label><div class="track"><button class="bar" style="left:${((t.start_ms - lo) / span) * 100}%;width:${Math.max(((t.end_ms - t.start_ms) / span) * 100, 0.5)}%;max-width:${((hi - t.start_ms) / span) * 100}%" data-session="${h(s.id)}" aria-label="查看 ${h(s.project)} 对应会话"></button></div></div>`).join("")}</div><p class="rangefoot">图中为完整轮次起止，仅帮助观察重叠。上方本期总额由全部符合范围的区间精确计算，不受图中数量限制。</p></div>`;
}
function toast(message) {
  $("#live").innerHTML = `<div class="toast">${h(message)}</div>`;
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
      "",
      "",
      state.start,
      state.end,
      timezone,
      "Codex execution start to complete/abort; pauses unknown",
    ]),
  ];
  const cell = (v) => {
    let x = String(v);
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
    toast(
      `成功更新 ${r.updated} 个文件${r.failed ? `，${r.failed} 个未更新（保留旧快照）` : ""}${r.notices?.length ? "；" + r.notices.join("；") : ""}`,
    );
  } catch (e) {
    error(e.message);
  } finally {
    state.busy = false;
    $("#refresh").disabled = false;
    $("#refresh").textContent = "同步记录";
  }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
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
    if ($("#layer [role=dialog]")) close();
    details(b.dataset.session);
  }
  if (b.dataset.metric) metric(b.dataset.metric);
  if (b.dataset.saveDirectory) await saveDirectory(b.dataset.saveDirectory);
  if (b.dataset.resetDirectory) {
    const agent = b.dataset.resetDirectory,
      item = state.directories.find((x) => x.agent === agent);
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
        `${head("选择统计日期", "按浏览器时区计算；结束日期包含当天，最多 367 天。")}<div class="formfields"><label>开始日期<br><input class="dateinput" type="date" id="start" value="${h(state.start)}"></label><label>结束日期<br><input class="dateinput" type="date" id="end" value="${h(state.end)}"></label></div><p id="dateerror" role="alert" class="sub"></p><button class="btn primary" data-action="apply-dates">应用日期</button>`,
      );
      break;
    case "apply-dates": {
      const a = $("#start").value,
        z = $("#end").value;
      if (!a || !z || a > z || (new Date(z) - new Date(a)) / 86400000 > 366) {
        $("#dateerror").textContent =
          "请选择有效日期，开始不晚于结束，最多 367 天。";
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
    editDirectory(
      e.target.dataset.directoryEnabled,
      "enabled",
      e.target.checked,
    );
  if (e.target.id === "sort") {
    state.sort = e.target.value;
    render();
  }
});
document.addEventListener("keydown", (e) => {
  const dialog = $("#layer [role=dialog]");
  if (!dialog) return;
  if (e.key === "Escape") {
    close();
    return;
  }
  if (e.key === "Tab") {
    const els = [...dialog.querySelectorAll("button,input,select,a[href]")],
      first = els[0],
      last = els.at(-1);
    if (!first) {
      e.preventDefault();
      return;
    }
    if (
      e.shiftKey &&
      (document.activeElement === first || document.activeElement === dialog)
    ) {
      e.preventDefault();
      last.focus();
    } else if (
      !e.shiftKey &&
      (document.activeElement === last || document.activeElement === dialog)
    ) {
      e.preventDefault();
      first.focus();
    }
  }
});
load();
