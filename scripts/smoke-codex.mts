#!/usr/bin/env node
// Full-corpus silent smoke for the Codex adapter (spec #5 acceptance gate).
// Batch-imports every local .jsonl.zst session through the REAL parse/import
// path into a throwaway database and classifies the outcome. Any unexpected
// parse failure exits non-zero; empty stubs and by-design exclusions are
// reported but do not fail the run.
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { Store } from "../src/store.js";
import { ValidationError } from "../src/types.js";

const EXCLUDED_MARKER = "暂不支持；未导入";
const EXTERNAL_MARKER = "外部导入轮次时间戳为导入时刻，不参与计时";

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

export function runSmoke(codexHome: string): SmokeSummary {
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
        const result = store.importFile(p, codexHome);
        if (result.events > 0) summary.imported++;
        else if (result.issues.some((i) => i.includes(EXTERNAL_MARKER)))
          summary.external_import_only++;
        else summary.empty_stubs++;
      } catch (e) {
        if (e instanceof ValidationError && e.message.includes(EXCLUDED_MARKER))
          summary.excluded_by_design++;
        else
          summary.failures.push({
            file: path.basename(p),
            reason: e instanceof ValidationError ? e.message : String(e),
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
  const summary = runSmoke(root);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.failures.length ? 1 : 0;
}
