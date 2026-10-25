#!/usr/bin/env node
/**
 * scripts/check-cli.mjs — guards the two things a first-run user sees.
 *
 * 1. `--version` must equal package.json. It used to be a hardcoded string, so
 *    every release shipped a CLI that lied about its own version, and the
 *    release smoke test (which only ran `--help`) could never notice.
 * 2. A bare invocation must not print anything on stderr. node:sqlite emits an
 *    ExperimentalWarning on import, which used to be the first line a new user
 *    saw. `src/warnings.ts` filters exactly that one warning; this script is the
 *    regression gate for it.
 *
 * Requires `npm run build` first (dist/cli.js). Runs in test.yml and release.yml.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
// URL 的 pathname 属性保留百分号编码（中文/空格路径 → %E4%B8%AD…），spawn
// 会按字面路径找文件直接 MODULE_NOT_FOUND；必须经 fileURLToPath 解码。
const cli = fileURLToPath(new URL("dist/cli.js", root));

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const failures = [];

const version = run(["--version"]);
if (version.status !== 0)
  failures.push(`--version 退出码 ${version.status}：${version.stderr.trim()}`);
else if (version.stdout.trim() !== pkg.version)
  failures.push(
    `--version 输出 "${version.stdout.trim()}" 与 package.json 的 "${pkg.version}" 不一致`,
  );

const help = run(["--help"]);
if (help.status !== 0) failures.push(`--help 退出码 ${help.status}`);
else if (!help.stdout.includes("--no-open"))
  failures.push("--help 未提及 --no-open（serve 的浏览器行为必须可关闭）");

for (const [label, result] of [
  ["--version", version],
  ["--help", help],
]) {
  if (/ExperimentalWarning/.test(result.stderr))
    failures.push(`${label} 的 stderr 仍含 ExperimentalWarning`);
  else if (result.stderr.trim().length > 0)
    failures.push(
      `${label} 的 stderr 非空：${result.stderr.trim().split("\n")[0]}`,
    );
}

if (failures.length) {
  for (const failure of failures) console.error("FAIL: " + failure);
  process.exit(1);
}
console.log(
  `PASS: --version ${pkg.version} matches package.json, --help documents --no-open, stderr is clean`,
);
