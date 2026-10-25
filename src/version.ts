import { readFileSync } from "node:fs";

/**
 * The published version, read from the package root.
 *
 * `--version` used to be a hardcoded string, so every release shipped a CLI
 * that lied about its own version — and the release pipeline could not notice,
 * because the smoke test only exercised `--help`. Resolve it from package.json
 * instead: the URL below is valid both from `src/version.ts` (tsx) and from
 * `dist/version.js` (published tarball), because both sit one level under the
 * package root.
 */
export function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(raw);
  const version =
    parsed && typeof parsed === "object"
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string" || version.length === 0)
    throw new Error("package.json 缺少可用的 version 字段");
  return version;
}
