// Test the actual distributable through npm exec, outside the repository.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
const archive = path.resolve(
  process.argv[2] ?? "ccclucky-agent-time-0.1.0.tgz",
);
const dir = mkdtempSync(path.join(tmpdir(), "agenttime-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, npm_config_cache: path.join(dir, "cache") };
const db = path.join(dir, "stats.sqlite3"),
  source = path.join(dir, "selected.jsonl");
writeFileSync(
  source,
  [
    {
      type: "session_meta",
      payload: {
        id: "package-session",
        source: "cli",
        cwd: "/synthetic/package",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-21T00:00:00Z",
      payload: { type: "task_started", turn_id: "package-turn" },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-21T00:10:00Z",
      payload: { type: "task_complete", turn_id: "package-turn" },
    },
  ]
    .map(JSON.stringify)
    .join("\n"),
);
const args = ["exec", "--yes", "--package", archive, "--", "agenttime"];
let child;
try {
  const imported = spawnSync(
    npm,
    [...args, "--db", db, "import", "--agent", "codex", source],
    {
      cwd: dir,
      env,
      encoding: "utf8",
      timeout: 120000,
      shell: process.platform === "win32",
    },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout.trim()).imported_files, 1);
  child = spawn(npm, [...args, "--db", db, "--port", "0"], {
    cwd: dir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    shell: process.platform === "win32",
  });
  let output = "",
    stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("No server address: " + stderr)),
      30000,
    );
    child.stdout.on("data", (d) => {
      output += d;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Server exited " + code + ": " + stderr));
    });
  });
  const page = await fetch(address);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /AgentTime/);
  for (const asset of ["/app.js", "/style.css"])
    assert.equal((await fetch(address + asset)).status, 200);
  const report = await (
    await fetch(
      address + "/api/report?start=2026-10-21&end=2026-10-21&timezone=UTC",
    )
  ).json();
  assert.equal(report.summary.processing_ms, 600000);
  assert.equal(report.summary.sessions, 1);
  const directories = await (await fetch(address + "/api/directories")).json();
  assert.equal(directories.directories.length, 6);
  assert(directories.directories.every((d) => !d.enabled));
  console.log(
    "PASS: clean-directory npm exec, CLI import, default server, assets, report and disabled sources",
  );
} finally {
  // npm exec wraps the server process. Terminate its child first on POSIX.
  if (child?.pid) {
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
    } else {
      try {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
      } catch {}
    }
    await new Promise((resolve) =>
      child.exitCode !== null ? resolve() : child.once("exit", resolve),
    );
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}
