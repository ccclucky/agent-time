#!/usr/bin/env node
// Full-corpus silent smoke for the OpenCode adapter (ticket #8 acceptance gate).
// Copies the real OpenCode session database (plus -wal/-shm sidecars) into a
// temp dir FIRST so the source file is never opened by the adapter at all —
// the parse runs against the copy. After the batch import the source's stat
// (size + mtimeNs) and the absence of newly created sidecars are asserted.
// A missing database is an explicit skip with exit 0: CI hosts have no
// ~/.local/share/opencode and the smoke must never fail the pipeline there.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../src/store.js";

export interface OpencodeSmokeSummary {
  source: string;
  // Counts read back from the throwaway store after the import.
  sessions: number;
  turns: number;
  events: number;
  token_rows: number;
  issues: string[];
  failures: string[];
  // Source stat unchanged after the run and no new sidecars next to it.
  source_untouched: boolean;
}

export async function runSmoke(dbPath: string): Promise<OpencodeSmokeSummary> {
  const before = statSync(dbPath, { bigint: true });
  const siblingsBefore = new Set(
    readdirSync(path.dirname(dbPath)).filter((f) =>
      f.startsWith(path.basename(dbPath) + "-"),
    ),
  );
  const summary: OpencodeSmokeSummary = {
    source: dbPath,
    sessions: 0,
    turns: 0,
    events: 0,
    token_rows: 0,
    issues: [],
    failures: [],
    source_untouched: false,
  };
  // The copy carries the original basename so directory-relative checks in
  // the adapter behave exactly as they would against the real layout.
  const work = mkdtempSync(path.join(tmpdir(), "agenttime-smoke-opencode-"));
  const copy = path.join(work, path.basename(dbPath));
  try {
    copyFileSync(dbPath, copy);
    for (const suffix of ["-wal", "-shm"])
      if (siblingsBefore.has(path.basename(dbPath) + suffix))
        copyFileSync(dbPath + suffix, copy + suffix);
    const store = new Store(path.join(work, "smoke.sqlite3"));
    try {
      const result = await store.importFile(copy, null, "opencode");
      summary.issues = result.issues;
      const row = <T>(sql: string) =>
        store.db.prepare(sql).get() as unknown as T;
      summary.sessions = row<{ c: number }>("SELECT COUNT(*) c FROM source").c;
      summary.turns = row<{ c: number }>(
        "SELECT COUNT(*) c FROM (SELECT DISTINCT source_id, turn_id FROM event)",
      ).c;
      summary.events = row<{ c: number }>("SELECT COUNT(*) c FROM event").c;
      summary.token_rows = row<{ c: number }>(
        "SELECT COUNT(*) c FROM token_usage",
      ).c;
    } finally {
      store.close();
    }
  } catch (e) {
    summary.failures.push(e instanceof Error ? e.message : String(e));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const after = statSync(dbPath, { bigint: true });
  const siblingsAfter = readdirSync(path.dirname(dbPath)).filter((f) =>
    f.startsWith(path.basename(dbPath) + "-"),
  );
  summary.source_untouched =
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    siblingsAfter.every((f) => siblingsBefore.has(f));
  return summary;
}

function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  // Same discovery the directory adapter documents: XDG_DATA_HOME-aware data
  // root holding opencode.db at its top level (OPENCODE_DB renames supported
  // upstream are not followed here — the default layout is the smoke target).
  const dataRoot = process.env.OPENCODE_HOME
    ? path.resolve(process.env.OPENCODE_HOME)
    : path.join(
        process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "", ".local/share"),
        "opencode",
      );
  const dbPath = path.join(dataRoot, "opencode.db");
  if (!statSync(dbPath, { throwIfNoEntry: false })?.isFile()) {
    console.log(
      `OpenCode 会话数据库不存在：${dbPath}；跳过冒烟（CI 无该库属预期，不视为失败）`,
    );
    process.exit(0);
  }
  const summary = await runSmoke(dbPath);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode =
    summary.failures.length || !summary.source_untouched ? 1 : 0;
}
