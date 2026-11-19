"use strict";

(function () {
  const LANG_KEY = "agenttime.lang";
  const DEFAULT_TITLE = "AgentTime · 本地时间账本";

  function detectDefaultLang() {
    try {
      const saved = localStorage.getItem(LANG_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch {}
    const nav = (navigator.language || "").toLowerCase();
    return nav && !nav.startsWith("zh") ? "en" : "zh";
  }

  let currentLang = detectDefaultLang();
  const savedTexts = new Map();
  const savedAttrs = new Map();

  const EXACT = {
    "AgentTime · 本地时间账本": "AgentTime · Local Time Ledger",
    "回到首页": "Back to Overview",
    "主导航": "Main Navigation",
    "日期范围": "Date Range",
    "按接入工具筛选": "Filter by Agent",
    "本机存储 · 无遥测": "Local-First · Zero Telemetry",
    "本机存储 · 无遥测 · 只读接入": "Local-First · Zero Telemetry · Read-Only",
    "本地服务在线": "Local server online",
    "本地数据": "Local Data",
    "这些时间怎么算？": "How is this time measured?",
    "自选日期": "Custom Range",
    "自选": "Custom",
    "同步记录": "Sync Logs",
    "同步中…": "Syncing…",
    "AgentTime · 只保存统计所需元数据": "AgentTime · Metadata only, zero prompt upload",
    "正在读取本地统计记录…": "Loading local records…",
    "时间总览": "Overview",
    "先看时间花销，再沿着记录核对明细。": "See where agent time actually went, then drill down to raw events.",
    "你的本地 Agent 时间账本。": "Your local time ledger for AI coding agents.",
    "会话记录": "Sessions",
    "每次会话，都能查看到每轮的起止记录。": "Inspect every session and its turn-by-turn timing boundaries.",
    "工具与模型": "Tools & Models",
    "比较已记录时长，不把速度当作质量排名。": "Compare recorded durations without conflating speed with quality.",
    "配置与接入": "Sources & Setup",
    "默认识别常用目录，也可随时修改。": "Auto-discovers default agent directories; customize any path below.",
    "会话明细": "Session Detail",
    "单次会话的耗时分布、效率归因与工具调用明细。": "Turn breakdown, wait attribution, and per-tool execution stack.",
    "今天": "Today",
    "近 7 天": "7 Days",
    "近 30 天": "30 Days",
    "自选时段": "Custom",
    "累计工作时长": "Cumulative Work",
    "各轮可测量记录区间时间相加 ↗": "Sum of measured intervals across turns ↗",
    "已测量 / 已记录轮次": "Measured / Recorded Turns",
    "未结束或异常记录单列 ↗": "Open or incomplete turns listed separately ↗",
    "统计会话总数": "Total Sessions",
    "已接入本地工具全部记录 ↗": "Across all enabled local agents ↗",
    "时间流向": "Time Flow",
    "一屏看清时间与等待的流向": "See how recorded wall time splits across work, waiting, and idle gaps",
    "基于一手事件流真实度量 · 无伪造推算": "Measured from first-hand event streams · Never extrapolated",
    "AI 工作": "AI Work",
    "等待确认": "Review Wait",
    "中途停了": "Idle Gap",
    "轮间间隔": "Standby",
    "本地工具": "Local Tools",
    "模型想和写": "Model Thinking & Output",
    "跨日趋势": "Daily Trend",
    "按日": "Daily",
    "按周": "Weekly",
    "生成分享图": "Share Card",
    "导出报告 Markdown": "Export Markdown",
    "导出当前明细 CSV": "Export CSV",
    "全部": "All",
    "每个会话干了多久": "Session Timeline",
    "本时段结论": "Period Takeaways",
    "全景时间轴": "Session Timeline",
    "会话干活 TOP 3 榜（当前视口）": "Top 3 Sessions by AI Work (Viewport)",
    "全部会话流 (点击任一卡片跳转至独立详情页)": "All Sessions (Click any card for turn breakdown)",
    "进入会话详情页 →": "Inspect Session →",
    "柱 = 一个会话的干活合计 · 高度 ∝ √干活 · hover 看会话名与跨度": "bar = session AI work total · height ∝ √Work · hover for details",
    "仅陈述可从页面数字直接推出的观察 · 不做推测性归因": "Observations derived strictly from recorded numbers · no speculation",
    "维度聚合统计（当前视口）": "Dimension Aggregation (Viewport)",
    "按接入工具": "By Agent",
    "按项目": "By Project",
    "按工具": "By Tool",
    "会话列表": "Session List",
    "按最近": "Most Recent",
    "按总时长": "Longest Wall Time",
    "按 AI 工作": "Most AI Work",
    "搜索会话或项目…": "Search session or project…",
    "返回时间总览": "← Back to Overview",
    "总时长": "Total Span",
    "自动完成度": "Autonomy Rate",
    "超 15s 慢操作": "Slow Ops (>15s)",
    "排队输入": "Queue Wait",
    "收尾空档": "Tail Gap",
    "本会话操作与耗时分布": "Session Operations Breakdown",
    "最慢操作": "Slowest Operations",
    "效率归因": "Efficiency Attribution",
    "轮次明细抽屉": "Turn Inspector",
    "轮次耗时深度剖析": "Turn Timing Breakdown",
    "← 上一轮": "← Prev",
    "下一轮 →": "Next →",
    "关闭抽屉 (ESC)": "Close Drawer (ESC)",
    "你的提问": "Your Prompt",
    "模型思考过程": "Model Reasoning",
    "本轮时间构成": "Turn Time Composition",
    "一手数据核算": "First-hand Events",
    "本轮工具调用": "Tool Calls",
    "本轮时长": "Turn Wall Time",
    "AI 工作占比": "AI Work Share",
    "分享时间账单卡片": "Shareable Time Ledger Card",
    "已自动隐藏项目名、提问原文与本地路径，仅包含汇总统计。": "Project names, prompts, and local paths are omitted — aggregate stats only.",
    "下载 PNG": "Download PNG",
    "复制图片": "Copy Image",
    "关闭": "Close",
    "手动配置目录": "Configure Manually",
    "配置数据目录": "Configure Data Sources",
    "这个时间范围还没有会话记录": "No sessions recorded in this date range",
    "选择统计日期": "Select Date Range",
    "按浏览器时区计算；结束日期包含当天，最多 367 天。": "Browser timezone; end date inclusive, max 367 days.",
    "开始日期": "Start Date",
    "结束日期": "End Date",
    "应用日期": "Apply Range",
    "启用接入": "Enabled",
    "保存设置": "Save",
    "恢复默认": "Reset Default",
    "正常结束": "Completed",
    "已中断": "Aborted",
    "失败": "Failed",
    "进行中": "Open",
    "记录不完整": "Incomplete",
    "数据无效": "Invalid",
    "暂无数据": "N/A",
    "正在读取本机源文件…": "Reading local source file…",
    "本轮未调用外部工具/脚本 (纯模型推理)。": "No external tools called in this turn (pure model inference).",
    "本机记录未包含该轮的提问文本。": "Prompt text was not recorded in the local file for this turn.",
    "Codex 官方记录对模型思考链加密，本机无法解密展示。": "Codex encrypts reasoning traces (ZDR); cannot be decrypted locally.",
    "该来源未记录该轮的模型思考文本。": "Reasoning trace was not recorded by this source.",
    "未绑定工作区": "No Workspace",
    "该会话在来源工具中未绑定代码目录（如全局对话或启动于根目录 /），并非解析缺失": "This session has no workspace bound in the source tool (e.g., global chat or started at /), not a parser error",
    "正在扫描并解析本地会话记录…": "Scanning and parsing local session logs…",
    "正在扫描并解析已接入工具的会话记录…": "Scanning and parsing enabled agent logs…",
    "大体积日志首次解析可能需要数秒，请勿关闭页面": "Initial import of large logs may take a few seconds — keep this page open",
    "正在只读扫描并解析本机历史事件流，首次导入大体积日志可能需要数秒…": "Reading and parsing local session streams (read-only); initial import may take a few seconds…",
  };

  const PATTERNS = [
    [/^统计快照 (.+)$/, (_, t) => `Snapshot ${t}`],
    [/^正在接入已检测到的 (\d+) 个工具…$/, (_, n) => `Connecting ${n} detected local agents…`],
    [/^正在启用第 (\d+)\/(\d+) 个工具（(.+)）…$/, (_, i, n, name) => `Enabling agent ${i}/${n} (${name})…`],
    [/^正在保存并同步 (.+)…$/, (_, name) => `Saving & syncing ${name}…`],
    [/^自选 (\d{2}-\d{2}) ~ (\d{2}-\d{2})$/, (_, a, b) => `${a} ~ ${b}`],
    [/^发现本机已有 (\d+) 个编码工具的会话记录$/, (_, n) => `Detected ${n} local coding agents on this machine`],
    [/^一键接入并立即同步 \((\d+)\)$/, (_, n) => `Connect All ${n} & Sync Now`],
    [/^已登记 (\d+) 个本地文件。.*$/, (_, n) => `${n} local files registered. Enable an agent directory in Sources & Setup or adjust the date range.`],
    [/^(\d+(?:\.\d+)?)x 并发效能倍率$/, (_, x) => `${x}x Concurrency`],
    [/^展示 (\d+) 个会话（共 (\d+) 个，(\d+) 轮交互）$/, (_, v, t, r) => `Showing ${v} of ${t} sessions (${r} turns)`],
    [/^当前视口操作与耗时分布（(\d+) 个会话）$/, (_, n) => `Viewport Operations Breakdown (${n} sessions)`],
    [/^按接入工具（会话 · 轮次 · 总时长 · 当前视口）$/, () => "By Agent (Sessions · Turns · Wall · Viewport)"],
    [/^按项目 TOP 5（总时长 · 当前视口）$/, () => "Top 5 Projects (Wall · Viewport)"],
    [/^按工具 TOP 5（累计执行耗时）$/, () => "Top 5 Tools (Total Execution Time)"],
    [/^共 (\d+) 个会话$/, (_, n) => `${n} ${n === "1" ? "session" : "sessions"}`],
    [/^(\d+) 轮交互$/, (_, n) => `${n} ${n === "1" ? "turn" : "turns"}`],
    [/^(\d+) 会话 · (\d+) 轮 ·(.*)$/, (_, s, t, d) => `${s} sess · ${t} ${t === "1" ? "turn" : "turns"} ·${d}`],
    [/^(\d+) 会话 ·(.*)$/, (_, s, d) => `${s} sess ·${d}`],
    [/^基于已有细分数据的 (\d+) 个会话 · 未测量来源不计入$/, (_, n) => `Based on ${n} sessions with breakdown data · unmeasured excluded`],
    [/^(.+) 是本时段累计执行最久的工具：(\d+) 次 · (.+)（占已测量工具执行 ([\d.]+%)）$/, (_, name, c, dur, pct) => `${name} was the longest-running tool (${c}× · ${dur}, ${pct} of measured tool time)`],
    [/^(.+) 是本时段干活最久的会话：(.+)（占 AI 工作 ([\d.]+%)）$/, (_, name, dur, pct) => `${name} had the most AI work (${dur}, ${pct} of AI Work)`],
    [/^(.+) 是等待确认最集中的一天：(.+)（占本时段等待确认 ([\d.]+%)）$/, (_, day, dur, pct) => `${day} had the most review wait (${dur}, ${pct} of total Review Wait)`],
    [/^进入会话详情页：(.+)$/, (_, t) => `Inspect session: ${t}`],
    [/^已保存 (\d+) 项接入设置，成功更新 (\d+) 个文件(.*)$/, (_, s, u, rest) => `Saved ${s} sources, updated ${u} files${rest}`],
    [/^最长 (.+)$/, (_, d) => `Max ${d}`],
    [/^(\d+) 轮$/, (_, n) => `${n} turns`],
    [/^(\d+) 次$/, (_, n) => `${n} calls`],
  ];

  // Ordered composite phrase replacements for multi-clause analytical copy
  const PHRASES = [
    ["正在读取本机源文件…", "Reading local source file…"],
    ["未绑定工作区", "No Workspace"],
    ["（AI 工作 + 等待确认 + 中途停了 + 轮间间隔）", " (AI Work + Review Wait + Idle Gap + Standby)"],
    ["（AI 工作 + 等待确认 + 轮间间隔）", " (AI Work + Review Wait + Standby)"],
    ["0.0%（本时段无发生）", "0.0% (none in range)"],
    ["柱 = 一个会话的干活合计 · 高度 ∝ √干活 · hover 看会话名与跨度", "bar = session AI work total · height ∝ √Work · hover for details"],
    ["是本时段累计执行最久的工具：", "was the longest-running tool: "],
    ["是本时段干活最久的会话：", "had the most AI work: "],
    ["是等待确认最集中的一天：", "had the most Review Wait: "],
    ["占已测量工具执行 ", "of measured tool time "],
    ["占本时段等待确认 ", "of total Review Wait "],
    ["占 AI 工作 ", "of AI Work "],
    ["占记录总时长 ", "of total recorded "],
    ["按轮次开始周归属", "Grouped by turn start week"],
    ["按轮次开始日归属", "Grouped by turn start day"],
    ["跨周轮整体计入起始周", "cross-week turns attributed to start week"],
    ["跨日轮整体计入起始日", "cross-day turns attributed to start day"],
    ["柱 = 当周 AI 干活合计", "bar = weekly AI work total"],
    ["柱 = 当日 AI 干活合计", "bar = daily AI work total"],
    ["柱高按平方根缩放", "sqrt height scale"],
    ["已自动按周聚合", "auto-grouped weekly"],
    ["AI 干活（当周全部轮次合计）", "AI Work (all turns in week)"],
    ["AI 干活（当日全部轮次合计）", "AI Work (all turns in day)"],
    ["hover 任意柱：停了 / 间隔 / 轮次明细", "Hover any bar for idle / standby / turn breakdown"],
    ["hover 任意柱：详细三态", "Hover any bar for breakdown"],
    ["记录总时长", "Total Recorded"],
    ["排队输入", "Queued"],
    ["本时段无发生", "none in range"],
    ["AI 工作", "AI Work"],
    ["等待确认", "Review Wait"],
    ["中途停了", "Idle Gap"],
    ["轮间间隔", "Standby"],
    ["本地工具", "Local Tools"],
    ["模型想和写", "Model Thinking & Output"],
    ["进入会话详情页 →", "Inspect Session →"],
    ["守恒占比：", "Conservation split: "],
    ["守恒口径：", "Conservation: "],
    ["口径：", "Metric: "],
    ["干活 ", "Work "],
    ["跨度 ", "Span "],
    ["主要是你自己的时间（阅读、离开、睡觉），AI 零消耗", "mainly your own reading/away time — zero AI cost"],
    ["全部轮次", "all turns"],
    [" 会话", " sess"],
    [" 轮", " turns"],
    ["合计", "sum"],
    ["（", " ("],
    ["）", ")"],
    ["：", ": "],
    ["、", ", "],
  ];

  function translateString(str) {
    if (!str || typeof str !== "string") return str;
    const trimmed = str.trim();
    if (!trimmed) return str;
    if (EXACT[trimmed]) return str.replace(trimmed, EXACT[trimmed]);
    for (const [re, fn] of PATTERNS) {
      const m = trimmed.match(re);
      if (m) return str.replace(trimmed, fn(...m));
    }
    let out = str.replace(/(\d+)\s*次/g, "$1×");
    for (const [zh, en] of PHRASES) {
      if (out.includes(zh)) out = out.split(zh).join(en);
    }
    return out;
  }

  function restoreOriginals() {
    document.title = DEFAULT_TITLE;
    for (const [node, orig] of savedTexts.entries()) {
      if (!node.isConnected) {
        savedTexts.delete(node);
        continue;
      }
      node.nodeValue = orig;
    }
    for (const [el, map] of savedAttrs.entries()) {
      if (!el.isConnected) {
        savedAttrs.delete(el);
        continue;
      }
      for (const [attr, orig] of Object.entries(map)) {
        el.setAttribute(attr, orig);
      }
    }
  }

  function applyToNode(root) {
    if (!root || currentLang !== "en") return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let cur;
    while ((cur = walker.nextNode())) nodes.push(cur);
    for (const n of nodes) {
      const parent = n.parentElement;
      if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;
      if (n.nodeValue && /[\u4e00-\u9fff]/.test(n.nodeValue)) {
        if (!savedTexts.has(n)) savedTexts.set(n, n.nodeValue);
        n.nodeValue = translateString(n.nodeValue);
      }
    }
    if (root.querySelectorAll) {
      root.querySelectorAll("[title],[placeholder],[aria-label]").forEach((el) => {
        for (const attr of ["title", "placeholder", "aria-label"]) {
          const val = el.getAttribute(attr);
          if (val && /[\u4e00-\u9fff]/.test(val)) {
            const map = savedAttrs.get(el) || {};
            if (!(attr in map)) {
              map[attr] = val;
              savedAttrs.set(el, map);
            }
            el.setAttribute(attr, translateString(val));
          }
        }
      });
    }
  }

  window.getUiLang = () => currentLang;

  window.toggleUiLang = () => {
    currentLang = currentLang === "en" ? "zh" : "en";
    try {
      localStorage.setItem(LANG_KEY, currentLang);
    } catch {}
    if (currentLang === "zh") restoreOriginals();
    const btn = document.getElementById("langToggle");
    if (btn) btn.textContent = currentLang === "en" ? "中文" : "EN";
    return currentLang;
  };

  window.getShareCardLabels = () => {
    if (currentLang === "en") {
      return {
        brandSub: "Local-First AI Coding Time Ledger · Zero Telemetry",
        title: "Agent Time Ledger Summary",
        work: "AI Work",
        wait: "Review Wait",
        idle: "Idle Gap",
        standby: "Standby",
        autonomy: "Autonomy",
        sessions: "Sessions",
        turns: "Turns",
        topAgents: "Time by Agent",
        unknown: "N/A",
        footer: "npx @ccclucky/agent-time",
      };
    }
    return {
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
  };

  window.applyI18n = () => {
    const btn = document.getElementById("langToggle");
    if (btn) btn.textContent = currentLang === "en" ? "中文" : "EN";
    document.documentElement.lang = currentLang === "en" ? "en" : "zh-CN";
    if (currentLang === "zh") {
      restoreOriginals();
      return;
    }
    document.title = EXACT[DEFAULT_TITLE];
    applyToNode(document.querySelector(".app"));
    applyToNode(document.getElementById("layer"));
  };
})();
