#!/usr/bin/env node
/**
 * scripts/verify-render.mjs — headless render verification (slice-4 geometry
 * + review-fix behavior checks). NOT wired into `npm test`: run manually via
 * `node scripts/verify-render.mjs`.
 *
 * What it does:
 *   1. Builds an isolated throwaway SQLite db under a temp dir and seeds a
 *      minimal Claude fixture (two turns: prompt + thinking + one 60s tool
 *      call + one plain answer), mirroring how tests/slice7_transcript.test.ts
 *      seeds via store.importFile — here through the CLI
 *      (`npm run dev -- --db <tmp> import --agent claude <fixture>`).
 *   2. Boots `npm run dev -- --db <tmp> serve --port <port>` on an isolated
 *      port (default 8826, auto-increments if busy, override: --port=N).
 *   3. Drives headless Chromium via playwright (resolved from the ambient
 *      environment; never a project dependency) at 1440x900 and asserts:
 *        - heatmap brush track height ≈ 140px
 *        - no horizontal page overflow
 *        - no `.turn-row` elements on the homepage
 *        - `.s1-grid` renders its two boxes side-by-side at 1440
 *        - after clicking a turn capsule, the drawer is fully in viewport
 *        - homepage TOP 3 rank value equals the session detail WALL TIME KPI
 *        - stream cards show the mini duration bar
 *        - zero console errors / page errors
 *
 * If playwright is not installed in the environment, prints a SKIP notice and
 * exits 0 so CI environments without a browser are unaffected.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith("--port="));
const BASE_PORT = portArg ? Number(portArg.split("=")[1]) : 8826;
// Always run npm from the repo root so `npm run dev` resolves this checkout's
// package.json and assets no matter where the script is invoked from.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const PREFIX = "agenttime-verify-render-";

const cleanupPaths = [];
const servers = [];
let failed = false;
const failures = [];

function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failed = true;
    failures.push(name);
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function loadPlaywright() {
  const candidates = ["playwright", "playwright-core"];
  for (const name of candidates) {
    try {
      return { name, mod: await import(name) };
    } catch {
      /* try next */
    }
  }
  // Last resort: a globally installed playwright (npm root -g).
  try {
    const root = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
    const globalRoot = root.stdout?.trim();
    if (globalRoot) {
      return { name: "playwright (global)", mod: await import(path.join(globalRoot, "playwright", "index.mjs")) };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function claudeFixtureRows() {
  // Timestamps are generated relative to "now" so the sessions always fall
  // inside the frontend's default 近 7 天 range, whatever day this runs.
  const at = (minutesAgo) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const row = (type, uuid, minutesAgo, extra = {}) => ({
    type,
    uuid,
    sessionId: "verify-render-demo",
    timestamp: at(minutesAgo),
    cwd: "/work/verify-render",
    parentUuid: null,
    ...extra,
  });
  return [
    row("user", "u1", 50, {
      message: { role: "user", content: "修复登录页的布局问题" },
    }),
    row("assistant", "a1", 48, {
      parentUuid: "u1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "先查看样式文件，定位溢出原因。" },
          { type: "tool_use", id: "toolu-1", name: "Bash", input: {} },
        ],
      },
    }),
    row("user", "tr1", 46, {
      parentUuid: "a1",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu-1", content: "ok" },
        ],
      },
    }),
    row("assistant", "a2", 30, {
      parentUuid: "tr1",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "已修复" }],
      },
    }),
    row("user", "u2", 20, {
      parentUuid: "a2",
      message: { role: "user", content: [{ type: "text", text: "请再检查移动端" }] },
    }),
    row("assistant", "a3", 18, {
      parentUuid: "u2",
      message: {
        role: "assistant",
        model: "claude-opus-4-1",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "完成" }],
      },
    }),
    // 未完结第三轮：用户提问 + 模型发起工具调用后戛然而止（无 tool_result、
    // 无 end_turn）→ open 轮次（无结束记录），用于验证总账回填与诚实原因行
    row("user", "u3", 10, {
      parentUuid: "a3",
      message: { role: "user", content: [{ type: "text", text: "再顺手把平板端也修一下" }] },
    }),
    row("assistant", "a4", 9, {
      parentUuid: "u3",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "平板端可能是同一处断点。" },
          { type: "tool_use", id: "toolu-2", name: "Bash", input: {} },
        ],
      },
    }),
    // 工具结果落盘（可配对出逐次调用时长），但之后再无 end_turn → 该轮仍为 open
    row("user", "tr2", 8, {
      parentUuid: "a4",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu-2", content: "ok" },
        ],
      },
    }),
  ];
}

function codexVerifyRows() {
  // Codex rollout whose user prompt exists ONLY as response_item/message rows
  // (no event_msg/user_message): exercises the response_item extraction path,
  // the wrapper exclusion, the ZDR reasoning shape and exec tool calls.
  const at = (minutesAgo) =>
    new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return [
    {
      type: "session_meta",
      timestamp: at(70),
      payload: { id: "codex-verify-demo", source: "cli", cwd: "/work/verify-codex" },
    },
    {
      type: "response_item",
      timestamp: at(69),
      payload: {
        type: "message",
        role: "user",
        id: "msg-env",
        content: [{ type: "text", text: "<user_instructions>\n# AGENTS.md instructions\n PRIVATE\n</user_instructions>" }],
      },
    },
    {
      type: "event_msg",
      timestamp: at(68),
      payload: { type: "task_started", turn_id: "v1" },
    },
    {
      type: "turn_context",
      timestamp: at(68),
      payload: { turn_id: "v1", model: "gpt-5.3" },
    },
    {
      type: "response_item",
      timestamp: at(67),
      payload: {
        type: "message",
        role: "user",
        id: "msg-real",
        content: [{ type: "text", text: "帮我把 Codex 抽屉的提示修好" }],
      },
    },
    {
      type: "response_item",
      timestamp: at(66),
      payload: { type: "reasoning", summary: [], encrypted_content: "ZDR-encrypted-blob" },
    },
    {
      type: "response_item",
      timestamp: at(65),
      payload: {
        type: "function_call",
        name: "exec",
        call_id: "call-1",
        arguments: JSON.stringify({ cmd: "npm run build", timeout: 30000 }),
      },
    },
    {
      type: "response_item",
      timestamp: at(64),
      payload: { type: "function_call_output", call_id: "call-1", output: "ok" },
    },
    {
      type: "event_msg",
      timestamp: at(60),
      payload: { type: "task_complete", turn_id: "v1" },
    },
  ];
}

function piVerifyRows() {
  // Minimal Pi session so the Pi filter chip and its badge are exercisable.
  const B = Date.now() - 40 * 60_000;
  const iso = (ms) => new Date(ms).toISOString();
  return [
    {
      type: "session",
      version: 3,
      id: "pi-verify-0000-0000-000000000001",
      timestamp: iso(B),
      cwd: "/work/verify-pi",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: iso(B),
      message: { role: "user", content: [{ type: "text", text: "跑一遍验证脚本" }], timestamp: B },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: iso(B + 3001),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        model: "z-ai/glm-5.3",
        stopReason: "stop",
        timestamp: B + 1000,
        durationMs: 2000,
        thinkingLevel: "high",
      },
    },
  ];
}

async function startServer(port, dbPath) {
  const child = spawn(
    "npm",
    ["run", "dev", "--", "--db", dbPath, "serve", "--port", String(port)],
    { stdio: ["ignore", "pipe", "pipe"], detached: true, cwd: REPO_ROOT },
  );
  servers.push(child);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server did not become ready on port ${port}`)),
      30_000,
    );
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes(`http://127.0.0.1:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
  await ready;
  // Poll the API until it answers (tsx startup can lag the log line).
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sources`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API on port ${port} never answered /api/sources`);
}

function seedDatabase(dbPath, fixturePath, agent) {
  const result = spawnSync(
    "npm",
    ["run", "dev", "--", "--db", dbPath, "import", "--agent", agent, fixturePath],
    { encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(
      `fixture import failed (${agent}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function main() {
  const pw = await loadPlaywright();
  if (!pw) {
    console.log(
      "SKIP  playwright is not installed in this environment; headless render verification skipped (exit 0). Install playwright to enable it.",
    );
    return;
  }
  console.log(`Using ${pw.name} for headless verification.`);

  const dir = mkdtempSync(path.join(tmpdir(), PREFIX));
  cleanupPaths.push(dir);
  const dbPath = path.join(dir, "verify.sqlite3");
  const fixtures = [
    ["verify-claude.jsonl", claudeFixtureRows(), "claude"],
    ["verify-codex.jsonl", codexVerifyRows(), "codex"],
    ["verify-pi.jsonl", piVerifyRows(), "pi"],
  ];
  for (const [name, rows, agent] of fixtures) {
    const fixturePath = path.join(dir, name);
    writeFileSync(
      fixturePath,
      rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    seedDatabase(dbPath, fixturePath, agent);
  }

  let port = BASE_PORT;
  for (;;) {
    if (await isFree(port)) break;
    if (portArg) throw new Error(`requested port ${port} is busy`);
    port += 1;
  }
  await startServer(port, dbPath);
  const base = `http://127.0.0.1:${port}`;

  const { chromium } = pw.mod;
  const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      // Pre-existing, unrelated noise: browsers request /favicon.ico on their
      // own and the static whitelist (5 paths) intentionally returns 404.
      if (/favicon/i.test(msg.location()?.url || "")) return;
      consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push(String(err)));

    await page.goto(base + "/", { waitUntil: "networkidle" });

    // 1. Heatmap track keeps its 140px golden height (±5px).
    const trackHeight = await page.evaluate(() => {
      const el = document.querySelector(".brush-strip-track");
      return el ? el.getBoundingClientRect().height : 0;
    });
    check(
      "heatmap track height ≈ 140px",
      trackHeight >= 135 && trackHeight <= 145,
      `actual ${trackHeight}px`,
    );

    // 2. No horizontal overflow.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check("no horizontal overflow at 1440", overflow <= 0, `scrollWidth - innerWidth = ${overflow}`);

    // 3. Homepage must not flatten per-turn rows.
    const turnRows = await page.evaluate(
      () => document.querySelectorAll(".turn-row").length,
    );
    check("no .turn-row on homepage", turnRows === 0, `found ${turnRows}`);

    // 4. s1-grid renders side-by-side at 1440.
    const s1 = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".s1-grid .s1-box")];
      if (boxes.length < 2) return { count: boxes.length, sameRow: false };
      const tops = boxes.map((b) => b.getBoundingClientRect().top);
      return {
        count: boxes.length,
        sameRow: Math.abs(tops[0] - tops[1]) < 2,
      };
    });
    check(
      "s1-grid side-by-side at 1440",
      s1.count === 2 && s1.sameRow,
      `boxes=${s1.count} sameRow=${s1.sameRow}`,
    );

    // 5. Stream cards show the mini duration bar.
    const miniBars = await page.evaluate(() => {
      const cards = [...document.querySelectorAll(".session-stream-card")];
      return {
        cards: cards.length,
        bars: cards.filter((c) => c.querySelector(".stream-mini-bar")).length,
      };
    });
    check(
      "stream cards show the mini duration bar",
      miniBars.cards > 0 && miniBars.bars === miniBars.cards,
      `${miniBars.bars}/${miniBars.cards} cards carry a mini bar`,
    );

    // 6. TOP 3 rank value equals the detail page WALL TIME KPI for the same session.
    const top = page.locator(".rank-mini-item").first();
    const rankDuration = (await top.locator(".rank-duration").textContent())?.trim();
    const sessionId = await top.getAttribute("data-open-session");
    await page.goto(`${base}/#session/${encodeURIComponent(sessionId)}`, {
      waitUntil: "networkidle",
    });
    const wallTime = (
      await page
        .locator(".kpi-card", { hasText: "WALL TIME" })
        .locator(".kpi-val")
        .textContent()
    )?.trim();
    check(
      "homepage TOP3 value equals detail WALL TIME KPI",
      rankDuration === wallTime,
      `rank="${rankDuration}" wall="${wallTime}"`,
    );

    // 7. Drawer fully in viewport after capsule click.
    await page.locator(".turn-capsule").first().click();
    await page.waitForTimeout(400); // drawer slide-in transition
    const drawer = await page.evaluate(() => {
      const d = document.querySelector("#detailDrawer");
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return {
        inViewport:
          r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
        visible: !d.classList.contains("collapsed"),
        right: r.right,
        innerWidth: window.innerWidth,
      };
    });
    check(
      "drawer fully in viewport after capsule click",
      !!drawer && drawer.visible && drawer.inViewport,
      drawer ? `right=${drawer.right} innerWidth=${drawer.innerWidth}` : "drawer missing",
    );

    // 8. Vertical rhythm: consecutive homepage modules keep a real, generous
    //    gap and no two module boxes intersect (bounding-box audit).
    // Checks 6/7 navigated to the detail page — return to the overview first.
    await page.goto(base + "/", { waitUntil: "networkidle" });
    const rhythm = await page.evaluate(() => {
      const sels = [".stats", ".funnel-card", ".timeline-card", ".s1-grid", ".session-stream-head"];
      const mods = sels
        .map((s) => document.querySelector(s))
        .filter(Boolean)
        .map((el) => el.getBoundingClientRect());
      const gaps = [];
      let overlaps = 0;
      for (let i = 1; i < mods.length; i++) {
        gaps.push(Math.round(mods[i].top - mods[i - 1].bottom));
        // Vertical stack audit: a later module must start below the previous
        // one's bottom edge (1px tolerance for border rounding).
        if (mods[i].top < mods[i - 1].bottom - 1) overlaps++;
      }
      const minGap = Math.min(...gaps);
      return { gaps, minGap, overlaps, count: mods.length };
    });
    check(
      "homepage module gaps ≥ 16px with zero overlaps",
      rhythm.count === 5 && rhythm.overlaps === 0 && rhythm.minGap >= 16,
      `gaps=${rhythm.gaps.join(",")}px overlaps=${rhythm.overlaps}`,
    );

    // 9. Agent filter chips: present for every seeded harness and the stream
    //    re-filters (stream cards, badges) when a chip is clicked.
    const chips = await page.evaluate(() =>
      [...document.querySelectorAll("[data-agent-chip]")].map((b) => b.dataset.agentChip),
    );
    check(
      "agent chips list 全部 + every seeded agent",
      chips.length === 4 &&
        chips.includes("all") &&
        chips.includes("Codex") &&
        chips.includes("Claude Code") &&
        chips.includes("Pi"),
      chips.join(","),
    );
    const clickChip = async (key) => {
      await page.locator(`[data-agent-chip="${key}"]`).first().click();
      await page.waitForTimeout(150);
    };
    const streamMarks = () =>
      page.evaluate(() => {
        const cards = [...document.querySelectorAll(".session-stream-card")];
        const marks = new Set(
          cards.map((c) =>
            c.querySelector(".agent-mark")?.classList.contains("agent-mark-codex")
              ? "Codex"
              : c.querySelector(".agent-mark")?.classList.contains("agent-mark-claude")
                ? "Claude Code"
                : c.querySelector(".agent-mark")?.classList.contains("agent-mark-pi")
                  ? "Pi"
                  : "none",
          ),
        );
        const count = document.querySelector(".session-stream-head .sub")?.textContent || "";
        return { cards: cards.length, marks: [...marks], count: count.trim() };
      });
    await clickChip("Codex");
    const codexStream = await streamMarks();
    check(
      "Codex chip narrows the stream to Codex-only cards",
      codexStream.marks.length === 1 && codexStream.marks[0] === "Codex" && codexStream.cards > 0,
      `${codexStream.cards} cards, marks=${codexStream.marks.join("/")} (${codexStream.count})`,
    );
    await clickChip("Pi");
    const piStream = await streamMarks();
    check(
      "Pi chip narrows the stream to Pi-only cards",
      piStream.marks.length === 1 && piStream.marks[0] === "Pi" && piStream.cards > 0,
      `${piStream.cards} cards, marks=${piStream.marks.join("/")} (${piStream.count})`,
    );
    await clickChip("all");
    const allStream = await streamMarks();
    check(
      "全部 chip restores the full stream",
      allStream.marks.length === 3 && allStream.cards === codexStream.cards + piStream.cards + 1,
      `${allStream.cards} cards, marks=${allStream.marks.join("/")}`,
    );

    // 10. Badges land in TOP 3 rows, stream cards, and the sessions table.
    const badgeSpread = await page.evaluate(() => {
      const q = (s) => document.querySelectorAll(s).length;
      return {
        top: q(".rank-mini-item .agent-mark"),
        stream: q(".session-stream-card .agent-mark"),
      };
    });
    check(
      "agent badges present in TOP3 rows and stream cards",
      badgeSpread.top > 0 && badgeSpread.stream > 0,
      `top=${badgeSpread.top} stream=${badgeSpread.stream}`,
    );
    await page.evaluate(() => {
      document.querySelector('[data-page="sessions"]')?.click();
    });
    await page.waitForTimeout(200);
    const tableBadges = await page.evaluate(
      () => document.querySelectorAll(".agent-cell .agent-mark").length,
    );
    check("sessions table rows carry agent badges", tableBadges > 0, `rows=${tableBadges}`);

    // 10b. Feedback round 3 Fix 1: 工具接入列徽标不得自成边框盒、不得撑破行。
    //     bbox 审计：每个 agent-cell 内容必须完整落在行框内，且同一行内
    //     所有 td 的上/下边缘对齐（行边框端到端平直）。
    const tableAudit = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".tablewrap tbody tr")];
      const shot = (r) => r.getBoundingClientRect();
      let outOfRow = 0;
      let misaligned = 0;
      let checked = 0;
      for (const tr of rows) {
        const row = shot(tr);
        const cell = tr.querySelector(".agent-cell");
        if (!cell) continue;
        checked += 1;
        const c = shot(cell);
        // td 自身的框就是行框的一部分 —— 旧病灶是 display:flex 让 td 变成
        // 匿名单元格里的一块，徽标盒高出行、行边框断裂
        if (c.top < row.top - 0.5 || c.bottom > row.bottom + 0.5) outOfRow += 1;
        const mark = tr.querySelector(".agent-mark");
        if (mark) {
          const m = shot(mark);
          if (m.top < row.top - 0.5 || m.bottom > row.bottom + 0.5) outOfRow += 1;
        }
        const tops = [...tr.querySelectorAll("td")].map((td) => shot(td).top);
        const bottoms = [...tr.querySelectorAll("td")].map((td) => shot(td).bottom);
        if (Math.max(...tops) - Math.min(...tops) > 1 || Math.max(...bottoms) - Math.min(...bottoms) > 1) {
          misaligned += 1;
        }
      }
      return { rows: rows.length, checked, outOfRow, misaligned };
    });
    check(
      "sessions table: agent badges stay inside row bounds and row edges stay straight",
      tableAudit.checked > 0 && tableAudit.outOfRow === 0 && tableAudit.misaligned === 0,
      `rows=${tableAudit.rows} checked=${tableAudit.checked} outOfRow=${tableAudit.outOfRow} misaligned=${tableAudit.misaligned}`,
    );
    if (process.env.SHOTS_DIR) {
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/02-sessions-table.png` });
    }

    // 10c. Feedback round 3 Fix 3: 首页维度聚合统计模块（聚合而非过滤）。
    await page.evaluate(() => {
      document.querySelector('[data-page="overview"]')?.click();
    });
    await page.waitForTimeout(250);
    const agg = await page.evaluate(() => {
      const grid = document.querySelector(".agg-grid");
      if (!grid) return null;
      const boxes = [...grid.querySelectorAll(".s1-box")];
      const sharesOf = (box) =>
        [...box.querySelectorAll(".agg-share-fill")].map((f) =>
          parseFloat(f.style.width),
        );
      const agentBox = boxes[0];
      const projectBox = boxes[1];
      const toolBox = boxes[2];
      const agentShares = sharesOf(agentBox);
      const projectShares = sharesOf(projectBox);
      return {
        boxes: boxes.length,
        agentRows: agentBox.querySelectorAll(".agg-row").length,
        projectRows: projectBox.querySelectorAll(".agg-row").length,
        toolRows: toolBox.querySelectorAll(".agg-row").length,
        agentSharesSum: agentShares.reduce((s, x) => s + x, 0),
        agentShares,
        agentSharesEveryGT2: agentShares.every((x) => x >= 2),
        projectSharesSum: projectShares.reduce((s, x) => s + x, 0),
        basisLine: toolBox.querySelector(".agg-basis")?.textContent?.trim() || "",
        tail: projectBox.querySelector(".agg-tail")?.textContent?.trim() || "",
        marks: agentBox.querySelectorAll(".agent-mark").length,
      };
    });
    check(
      "aggregation module renders three groupings",
      !!agg && agg.boxes === 3 && agg.agentRows > 0 && agg.projectRows > 0 && agg.toolRows > 0,
      agg ? `boxes=${agg.boxes} agent=${agg.agentRows} project=${agg.projectRows} tool=${agg.toolRows}` : "no .agg-grid",
    );
    check(
      "aggregation agent shares sum ≈100% (linear, ≥2% visible floor)",
      !!agg && Math.abs(agg.agentSharesSum - 100) <= 5 && agg.agentSharesEveryGT2,
      agg ? `sum=${agg.agentSharesSum.toFixed(1)}% widths=[${(agg.agentShares || []).map((x) => (Math.round(x * 10) / 10).toFixed(1)).join(", ")}]` : "no data",
    );
    check(
      "aggregation tool box states its evidence basis and project box its tail",
      !!agg && agg.basisLine.includes("已测量 breakdown") && (agg.projectRows < 5 || agg.tail.includes("个项目")),
      agg ? `basis="${agg.basisLine.slice(0, 30)}" tail="${agg.tail}"` : "no data",
    );
    check(
      "aggregation agent rows carry harness badges",
      !!agg && agg.marks === agg.agentRows,
      agg ? `marks=${agg.marks}` : "no data",
    );

    // 10d. Feedback round 3 Fix 4: 徽标内嵌真实标志（OpenAI mark / Pi 像素标）。
    const badgeMarks = await page.evaluate(() => {
      const piBadges = document.querySelectorAll('.agent-mark-pi > svg').length;
      const piPixelSvgs = document.querySelectorAll('.agent-mark-pi svg[viewBox="0 0 4 4"]').length;
      return {
        openai: document.querySelectorAll('.agent-mark-codex path[d^="M22.2819 9.8211"]').length,
        piBadges,
        piPixelSvgs,
        piRects: document.querySelectorAll('.agent-mark-pi svg[viewBox="0 0 4 4"] rect').length,
        crisp: piPixelSvgs,
        fakeMono: [...document.querySelectorAll(".agent-mark text")].length,
      };
    });
    check(
      "Codex badge embeds the official OpenAI mark path",
      badgeMarks.openai > 0,
      `openai paths=${badgeMarks.openai}`,
    );
    check(
      "Pi badge embeds the new 4x4 pixel mark (10 rects per badge, crispEdges, no text glyph)",
      badgeMarks.piBadges > 0 &&
        badgeMarks.piPixelSvgs === badgeMarks.piBadges &&
        badgeMarks.piRects === badgeMarks.piBadges * 10 &&
        badgeMarks.fakeMono === 0,
      `badges=${badgeMarks.piBadges} pixelSvgs=${badgeMarks.piPixelSvgs} rects=${badgeMarks.piRects} text=${badgeMarks.fakeMono}`,
    );
    if (process.env.SHOTS_DIR) {
      await page.screenshot({ path: `${process.env.SHOTS_DIR}/01-homepage.png`, fullPage: true });
      await page.locator(".agg-grid").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await page.locator(".agg-grid").screenshot({ path: `${process.env.SHOTS_DIR}/05-aggregation.png` });
    }

    // 11. Codex drawer: real prompt from response_item rows, ZDR thinking copy,
    //     friendly exec label + detail line from arguments JSON.
    const report = await (await fetch(`${base}/api/report?start=${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}&end=${new Date().toISOString().slice(0, 10)}&timezone=UTC`)).json();
    const codexSession = (report.sessions || []).find((s) => s.agent === "Codex");
    check("seeded Codex session visible in report", !!codexSession, codexSession?.id || "missing");
    if (codexSession) {
      await page.goto(`${base}/#session/${encodeURIComponent(codexSession.id)}`, {
        waitUntil: "networkidle",
      });
      await page.locator(".turn-capsule").first().click();
      await page.waitForTimeout(600); // drawer slide-in + transcript fetch
      const drawer = await page.evaluate(() => ({
        open: !document.querySelector("#detailDrawer")?.classList.contains("collapsed"),
        mark: !!document.querySelector("#drawerAgentMark .agent-mark-codex"),
        prompt: document.querySelector("#drawerPrompt")?.textContent?.trim() || "",
        thinking: document.querySelector("#drawerThinking")?.textContent?.trim() || "",
        toolLabel: document.querySelector(".tool-exec-card strong")?.textContent?.trim() || "",
        toolDetail: document.querySelector(".tool-exec-card .tool-exec-detail")?.textContent?.trim() || "",
      }));
      check(
        "Codex drawer shows the real prompt (response_item extraction)",
        drawer.open && drawer.prompt === "帮我把 Codex 抽屉的提示修好",
        `prompt="${drawer.prompt.slice(0, 40)}"`,
      );
      check(
        "Codex drawer thinking slot explains ZDR encryption",
        drawer.thinking.includes("ZDR") || drawer.thinking.includes("加密"),
        `thinking="${drawer.thinking.slice(0, 50)}"`,
      );
      check(
        "Codex tool stack shows friendly label + detail line",
        drawer.toolLabel === "执行命令" && drawer.toolDetail === "npm run build",
        `label="${drawer.toolLabel}" detail="${drawer.toolDetail}"`,
      );
      check("drawer header carries the Codex badge", drawer.mark, "agent-mark-codex");
      const detailBadges = await page.evaluate(
        () => ({
          nav: document.querySelectorAll(".detail-nav .agent-mark").length,
          capsules: document.querySelectorAll(".turn-capsule .agent-mark").length,
        }),
      );
      check(
        "detail nav and turn capsules carry agent badges",
        detailBadges.nav === 1 && detailBadges.capsules > 0,
        `nav=${detailBadges.nav} capsules=${detailBadges.capsules}`,
      );
      await page.evaluate(() => document.querySelector("[data-action='back-overview']")?.click());
      await page.waitForTimeout(200);
    }

    // 11b. Feedback round 3 Fix 2: 抽屉总账 —— 已完结轮显示真实数字；
    //      未完结（open）轮回填可推导数据 + 诚实原因行。
    const claudeSession = (report.sessions || []).find((s) => s.agent === "Claude Code");
    check("seeded Claude session has an open turn", !!claudeSession && claudeSession.turns.some((t) => t.status === "open" || t.end_ms == null),
      claudeSession ? `turns=${claudeSession.turns.length}` : "missing");
    if (claudeSession) {
      await page.goto(`${base}/#session/${encodeURIComponent(claudeSession.id)}`, {
        waitUntil: "networkidle",
      });
      const readRollup = () =>
        page.evaluate(() => {
          const card = (title) => {
            const boxes = [...document.querySelectorAll(".drawer-kpi-box")];
            const box = boxes.find((b) => b.querySelector(".drawer-kpi-title")?.textContent?.includes(title));
            if (!box) return null;
            return {
              val: box.querySelector(".drawer-kpi-val")?.textContent?.trim(),
              sub: box.querySelector(".drawer-kpi-sub")?.textContent?.trim(),
            };
          };
          return {
            api: card("模型推理耗时"),
            tools: card("工具执行耗时"),
            wait: card("等待人审阅"),
            wall: card("单轮壁钟时长"),
          };
        });

      // 已完结轮（第 1 轮）：breakdown 一手数字，无回填后缀、无原因行
      await page.locator(".turn-capsule").first().click();
      await page.waitForTimeout(500);
      const doneRollup = await readRollup();
      check(
        "completed turn shows REAL model/tool/review/wall numbers",
        !!doneRollup &&
          doneRollup.api.val !== "—" &&
          doneRollup.tools.val !== "—" &&
          doneRollup.wait.val !== "—" &&
          doneRollup.wall.val !== "—",
        `api=${doneRollup?.api.val} tools=${doneRollup?.tools.val} wait=${doneRollup?.wait.val} wall=${doneRollup?.wall.val}`,
      );
      check(
        "completed turn tools card keeps the 一手 breakdown basis (no backfill suffix)",
        !!doneRollup && !(doneRollup.tools.sub || "").includes("逐次调用累计"),
        `tools sub="${doneRollup?.tools.sub}"`,
      );
      if (process.env.SHOTS_DIR) {
        await page.screenshot({ path: `${process.env.SHOTS_DIR}/04-drawer-completed-turn.png` });
      }

      // 未完结轮（最后一轮）：工具总账从逐次调用回填，API/Review Wait 给出原因行
      await page.locator(".turn-capsule").last().click();
      await page.waitForTimeout(500);
      const openRollup = await readRollup();
      check(
        "open turn backfills Tools total from per-call durations",
        !!openRollup && openRollup.tools.val !== "—" && (openRollup.tools.sub || "").includes("逐次调用累计") && (openRollup.tools.sub || "").includes("项工具执行"),
        `tools=${openRollup?.tools.val} sub="${openRollup?.tools.sub}"`,
      );
      check(
        "open turn shows the honest no-end-record reason under API and Review Wait dashes",
        !!openRollup &&
          openRollup.api.sub?.includes("该轮未正常结束") &&
          openRollup.wait.sub?.includes("该轮未正常结束"),
        `api sub="${openRollup?.api.sub}" wait sub="${openRollup?.wait.sub}"`,
      );
      check(
        "open turn wall time backfills from first start (running span) and work rate stays —",
        !!openRollup && openRollup.wall.val !== "—" && openRollup.wall.sub?.includes("有效工作率: —"),
        `wall=${openRollup?.wall.val} sub="${openRollup?.wall.sub}"`,
      );
      if (process.env.SHOTS_DIR) {
        await page.screenshot({ path: `${process.env.SHOTS_DIR}/03-drawer-open-turn.png` });
      }
      await page.evaluate(() => document.querySelector("[data-action='back-overview']")?.click());
      await page.waitForTimeout(200);
    }

    // 12. Zero console errors across the whole run.
    check(
      "zero console errors",
      consoleErrors.length === 0,
      consoleErrors.slice(0, 3).join(" | "),
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .catch((e) => {
    failed = true;
    console.error("ERROR", e?.message || e);
  })
  .finally(() => {
    for (const s of servers) {
      // npm wraps tsx wraps node: kill the whole detached process group.
      try {
        process.kill(-s.pid, "SIGTERM");
      } catch {
        s.kill("SIGTERM");
      }
    }
    for (const p of cleanupPaths) rmSync(p, { recursive: true, force: true });
    if (failed) {
      console.error(
        failures.length
          ? `FAILED checks: ${failures.join("; ")}`
          : "FAILED (see ERROR above)",
      );
      process.exitCode = 1;
    } else {
      console.log("All render checks passed.");
    }
  });
