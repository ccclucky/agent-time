import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { packageVersion } from "../src/version.js";
import { silenceExperimentalSqliteWarning } from "../src/warnings.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

// Launch-readiness slice: the CLI used to print a hardcoded "0.1.0" while the
// package was on 0.2.1, and every run opened with a node:sqlite
// ExperimentalWarning. Both are now covered end-to-end by
// scripts/check-cli.mjs; these are the cheap unit-level guards.

test("--version 的取值来源与 package.json 一致", () => {
  assert.equal(packageVersion(), pkg.version);
  assert.match(packageVersion(), /^\d+\.\d+\.\d+(?:[-+].+)?$/);
});

test("版本号不来自硬编码字符串", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert(source.includes("packageVersion()"), "cli.ts 必须调用 packageVersion()");
  assert(
    !/console\.log\(\s*"\d+\.\d+\.\d+"/.test(source),
    "cli.ts 不得再硬编码版本号",
  );
});

// URL.pathname 保留百分号编码：中文/空格路径（如 /Users/张三/…）下 spawn 会按
// 字面路径找文件直接 MODULE_NOT_FOUND。CI 路径是纯 ASCII 所以永远测不出来，
// 必须从源头禁掉 .pathname 派生进程路径的写法。
test("check-cli 派生 CLI 路径必须经 fileURLToPath 解码", () => {
  const source = readFileSync(
    new URL("../scripts/check-cli.mjs", import.meta.url),
    "utf8",
  );
  assert(
    source.includes("fileURLToPath"),
    "check-cli.mjs 必须用 fileURLToPath 而非 URL.pathname",
  );
  assert(
    !/\.pathname/.test(source),
    "check-cli.mjs 不得用 .pathname 派生子进程路径（percent-编码路径下必挂）",
  );
});

test("SQLite 实验警告被过滤，其余警告照常上抛", () => {
  const seen: string[] = [];
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error) => {
    seen.push(typeof warning === "string" ? warning : warning.message);
  }) as typeof process.emitWarning;
  try {
    silenceExperimentalSqliteWarning();
    process.emitWarning(
      "SQLite is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
    process.emitWarning("another experimental thing", "ExperimentalWarning");
    process.emitWarning(new Error("disk is on fire"));
  } finally {
    process.emitWarning = original;
  }
  assert.deepEqual(seen, ["another experimental thing", "disk is on fire"]);
});
