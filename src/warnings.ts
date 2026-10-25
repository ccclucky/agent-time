/**
 * `node:sqlite` is still flagged experimental on Node 22/24 and prints
 *
 *   ExperimentalWarning: SQLite is an experimental feature and might change…
 *
 * on first import. For a tool people run with `npx`, that is the very first
 * line a new user sees — it reads like a half-finished build.
 *
 * The warning is emitted *during module evaluation*, so a filter installed in
 * the entry module body is already too late. `cli.ts` therefore installs this
 * filter first and only then imports the sqlite-backed modules dynamically.
 * Only this one warning is dropped; everything else still reaches stderr.
 */
export function silenceExperimentalSqliteWarning(): void {
  const emit = process.emitWarning.bind(process) as (
    warning: string | Error,
    ...rest: unknown[]
  ) => void;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const message =
      typeof warning === "string" ? warning : (warning?.message ?? "");
    const type =
      typeof warning === "string"
        ? typeof rest[0] === "string"
          ? rest[0]
          : "Warning"
        : warning?.name ?? "Warning";
    if (
      type === "ExperimentalWarning" &&
      message.includes("SQLite is an experimental feature")
    )
      return;
    emit(warning, ...rest);
  }) as typeof process.emitWarning;
}
