import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Temporal } from "@js-temporal/polyfill";
import { createDemoStore } from "../src/demo.js";
import { report } from "../src/metrics.js";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("createDemoStore seeds synthetic sessions across 5 harnesses and cleans up", async () => {
  const { store, cleanup } = await createDemoStore();
  try {
    const tz = "UTC";
    const end = Temporal.Now.plainDateISO(tz);
    const start = end.subtract({ days: 6 });
    const rep = report(store.sessions(), start.toString(), end.toString(), tz, "all");
    assert.equal(rep.summary.sessions, 5);
    assert.ok(rep.summary.measured_turns >= 5);
    assert.ok((rep.summary.work_ms ?? 0) > 0);
    const agents = new Set(rep.sessions.map((s) => s.agent));
    assert.deepEqual(
      [...agents].sort(),
      ["Antigravity", "Claude Code", "Codex", "DeepSeek Harness", "Pi"],
    );
  } finally {
    cleanup();
  }
});

test("CLI --demo serves live HTTP report and summary --json prints valid digest", async () => {
  const build = spawnSync("npm", ["run", "build"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, build.stderr);

  const cli = path.join(root, "dist", "cli.js");
  const child = spawn(process.execPath, [cli, "serve", "--demo", "--port", "0", "--no-open"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout: " + stderr)), 15000);
      child.stdout.on("data", (d) => {
        stdout += d;
        const m = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (m) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      });
    });

    const i18nRes = await fetch(`${url}/i18n-en.js`);
    assert.equal(i18nRes.status, 200);
    assert.match(await i18nRes.text(), /window\.applyI18n/);

    for (const icon of ["claude.svg", "codex.svg", "antigravity.svg", "opencode.svg", "pi.svg", "omp.svg", "deepseek.svg"]) {
      const res = await fetch(`${url}/icons/${icon}`);
      assert.equal(res.status, 200, `/icons/${icon} must return 200`);
      assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
    }

    const end = Temporal.Now.plainDateISO("UTC");
    const start = end.subtract({ days: 6 });
    const repRes = await fetch(
      `${url}/api/report?start=${start}&end=${end}&timezone=UTC`,
    );
    assert.equal(repRes.status, 200);
    const repJson = (await repRes.json()) as { summary: { sessions: number } };
    assert.equal(repJson.summary.sessions, 5);
  } finally {
    child.kill("SIGTERM");
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "agenttime-sum-"));
  try {
    const db = path.join(tmp, "empty.sqlite3");
    const res = spawnSync(
      process.execPath,
      [cli, "summary", "--days", "7", "--json", "--db", db],
      { cwd: root, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.summary.sessions, 0);
    assert.ok(parsed.range.start && parsed.range.end);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("Frontend assets include onboarding CTA, sync indicators, projectLabel, share card modal, and i18n toggle", () => {
  const html = readFileSync(path.join(root, "public", "index.html"), "utf8");
  const js = readFileSync(path.join(root, "public", "app.js"), "utf8");
  const i18n = readFileSync(path.join(root, "public", "i18n-en.js"), "utf8");

  assert.ok(html.includes('src="/i18n-en.js?v=20261119-1"'));
  assert.ok(html.includes('id="syncBar"'));
  assert.ok(html.includes('id="syncBanner"'));
  assert.ok(html.includes('data-action="toggle-lang"'));
  assert.ok(js.includes('data-action="onboard-enable-all"'));
  assert.ok(js.includes("function setSyncState("));
  assert.ok(js.includes("function projectLabel("));
  assert.ok(js.includes('data-action="share-card"'));
  assert.ok(js.includes("function openShareCardModal()"));
  assert.ok(i18n.includes("window.getShareCardLabels"));
  assert.ok(i18n.includes("未绑定工作区"));
});
