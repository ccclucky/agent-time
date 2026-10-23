#!/usr/bin/env node
// Full-corpus silent smoke for the Codex adapter (spec #5 acceptance gate).
// Batch-imports every local .jsonl.zst session through the REAL parse/import
// path into a throwaway database and classifies the outcome. Classification
// uses stable discriminators (ExcludedSessionError subclass + the
// external_import_only flag), never Chinese message substrings, so the
// human-readable copy stays free to change. Any unexpected parse failure
// exits non-zero; empty stubs and by-design exclusions are reported but do
// not fail the run.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Store } from "../src/store.js";
import { ExcludedSessionError } from "../src/codex.js";

export function collectCodexFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (depth > 8 || files.length > 20000) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && p.endsWith(".jsonl.zst")) files.push(p);
    }
  };
  for (const sub of ["sessions", "archived_sessions"]) walk(path.join(root, sub));
  return files;
}

export interface SmokeSummary {
  root: string;
  total: number;
  imported: number;
  // Metadata-only files: parsed fine, but carried no turn content at all.
  empty_stubs: number;
  // Sessions whose only turns are external-agent imports: timing events are
  // deliberately stripped (import-moment timestamps), so 0 events is expected.
  external_import_only: number;
  excluded_by_design: number;
  failures: { file: string; reason: string }[];
}

export async function runSmoke(codexHome: string): Promise<SmokeSummary> {
  const summary: SmokeSummary = {
    root: codexHome,
    total: 0,
    imported: 0,
    empty_stubs: 0,
    external_import_only: 0,
    excluded_by_design: 0,
    failures: [],
  };
  const work = mkdtempSync(path.join(tmpdir(), "agenttime-smoke-db-"));
  const store = new Store(path.join(work, "smoke.sqlite3"));
  try {
    for (const p of collectCodexFiles(codexHome)) {
      summary.total++;
      try {
        const result = await store.importFile(p, codexHome);
        if (result.events > 0) summary.imported++;
        else if (result.external_import_only)
          summary.external_import_only++;
        else summary.empty_stubs++;
      } catch (e) {
        if (e instanceof ExcludedSessionError) summary.excluded_by_design++;
        else
          summary.failures.push({
            file: path.basename(p),
            reason: e instanceof Error ? e.message : String(e),
          });
      }
    }
  } finally {
    store.close();
    rmSync(work, { recursive: true, force: true });
  }
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
  const root = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(process.env.HOME ?? "", ".codex");
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Codex 数据目录不存在：${root}`);
    process.exit(2);
  }
  const summary = await runSmoke(root);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.failures.length ? 1 : 0;
}
