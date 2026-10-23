#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "./store.js";
import { makeServer } from "./server.js";
import { expand } from "./locations.js";
import { ValidationError } from "./types.js";
export function defaultDb() {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
    "agenttime",
    "agenttime.sqlite3",
  );
}
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      db: { type: "string" },
      port: { type: "string" },
      agent: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      "AgentTime — 本地 Agent 时间账本\n\nagent-time [serve] [--port 8765] [--db PATH]\nagent-time import --agent codex|claude FILE_OR_DIRECTORY [--db PATH]\nagent-time refresh [--db PATH]\n\n（兼容别名：亦可直接使用 agenttime 命令；codex 支持 .jsonl 与 .jsonl.zst，claude 支持 .jsonl）\n默认启动本地网页；在配置页启用接入后再同步。",
    );
    return;
  }
  if (values.version) {
    console.log("0.1.0");
    return;
  }
  const command = positionals[0] ?? "serve";
  if (!["serve", "import", "refresh"].includes(command))
    throw new ValidationError("未知命令；使用 --help 查看用法");
  const port = Number(values.port ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new ValidationError("端口应在 0–65535 之间");
  if (
    command === "import" &&
    (!["codex", "claude"].includes(values.agent ?? "") ||
      positionals.length !== 2)
  )
    throw new ValidationError(
      "使用 import --agent codex|claude FILE_OR_DIRECTORY",
    );
  if (command !== "import" && positionals.length > 1)
    throw new ValidationError("参数过多；使用 --help 查看用法");
  const store = new Store(values.db ?? defaultDb());
  if (command === "serve") {
    const server = makeServer(store);
    server.on("error", () => {
      console.error("无法启动本地网页，请检查端口及权限。");
      store.close();
      process.exitCode = 1;
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      console.log(
        `AgentTime 已启动：http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}\n仅绑定本机地址，无遥测。Ctrl+C 停止。`,
      );
    });
    const stop = () =>
      server.close(() => {
        store.close();
      });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return;
  }
  try {
    if (command === "refresh") {
      const result = store.refresh();
      console.log(JSON.stringify(result));
      process.exitCode = result.failed ? 1 : 0;
      return;
    }
    const selected = path.resolve(expand(positionals[1], os.homedir())),
      paths: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (
          e.isFile() &&
          (p.endsWith(".jsonl") ||
            (values.agent === "codex" && p.endsWith(".jsonl.zst")))
        ) {
          paths.push(p);
          if (paths.length > 5000)
            throw new ValidationError(
              "单次最多导入 5000 个文件，请选择更小的目录",
            );
        }
      }
    };
    if (statSync(selected).isFile()) paths.push(selected);
    else walk(selected);
    if (!paths.length)
      throw new ValidationError("指定目录没有 .jsonl 或 .jsonl.zst 文件");
    let good = 0,
      failed = 0,
      warnings = 0;
    for (const p of paths.sort()) {
      try {
        const result = store.importFile(
          p,
          null,
          values.agent as "codex" | "claude",
        );
        good++;
        warnings += result.issues.length;
        for (const issue of result.issues) console.error("记录提示：" + issue);
      } catch (e) {
        failed++;
        console.error(
          "跳过文件：" +
            (e instanceof ValidationError ? e.message : "文件无法读取"),
        );
      }
    }
    console.log(
      JSON.stringify({
        imported_files: good,
        failed_files: failed,
        warnings,
        note: "只保存统计元数据；未修改源记录",
      }),
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(
    e instanceof ValidationError
      ? e.message
      : "无法启动或读取本地数据，请检查参数、路径、权限及端口。",
  );
  process.exitCode = 1;
});
