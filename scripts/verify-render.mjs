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

function seedDatabase(dbPath, fixturePath) {
  const result = spawnSync(
    "npm",
    ["run", "dev", "--", "--db", dbPath, "import", "--agent", "claude", fixturePath],
    { encoding: "utf8", timeout: 120_000, cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(
      `fixture import failed:\n${result.stdout}\n${result.stderr}`,
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
  const fixturePath = path.join(dir, "verify-session.jsonl");
  writeFileSync(
    fixturePath,
    claudeFixtureRows().map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  seedDatabase(dbPath, fixturePath);

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

    // 8. Zero console errors across the whole run.
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
