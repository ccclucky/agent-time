#!/usr/bin/env node
// Offline, explicit-file-only export. Never enumerate agent directories.
import { parseArgs } from "node:util";
import { createHmac, randomBytes } from "node:crypto";
import { open, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function redactor() {
  const salt = randomBytes(32),
    id = (value) =>
      typeof value === "string"
        ? "id-" +
          createHmac("sha256", salt).update(value).digest("hex").slice(0, 24)
        : null;
  const finite = (value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const enums = (value) =>
    typeof value === "string"
      ? new Set([
          "cli",
          "vscode",
          "exec",
          "mcp",
          "unknown",
          "user",
          "subagent",
          "guardian_review",
          "memory_consolidation",
          "legacy",
          "paginated",
          "end_turn",
          "stop_sequence",
          "tool_use",
          "max_tokens",
          "turn_duration",
          "compact_boundary",
          "local_command",
          "stop",
          "length",
          "toolUse",
          "aborted",
          "error",
        ]).has(value)
        ? value
        : "other"
      : value === null
        ? null
        : typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .filter((k) => ["subagent", "custom", "internal"].includes(k))
                .map((k) => [k, { redacted: true }]),
            )
          : value === undefined
            ? undefined
            : "invalid";
  const flags = (from, to, keys) => {
    for (const k of keys)
      if (Object.hasOwn(from, k)) to[k] = from[k] === null ? null : !!from[k];
  };
  const content = (value) =>
    typeof value === "string"
      ? "[redacted]"
      : Array.isArray(value)
        ? value.map((b) => ({
            type: [
              "text",
              "tool_result",
              "tool_use",
              "image",
              "thinking",
              "toolCall",
            ].includes(b?.type)
              ? b.type
              : "redacted",
            ...(b?.tool_use_id ? { tool_use_id: id(b.tool_use_id) } : {}),
            ...(b?.id ? { id: id(b.id) } : {}),
            ...(b?.type === "text" ? { text: "[redacted]" } : {}),
          }))
        : null;
  return (r, agent) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) return null;
    if (agent === "codex") {
      if (
        !["session_meta", "turn_context", "event_msg"].includes(r.type) ||
        !r.payload ||
        typeof r.payload !== "object"
      )
        return null;
      const p = r.payload,
        out = {
          type: r.type,
          timestamp:
            typeof r.timestamp === "string" &&
            /^\d{4}-\d\d-\d\dT[\d:.+Z-]{5,50}$/.test(r.timestamp)
              ? r.timestamp
              : null,
          payload: {},
        };
      if (r.type === "session_meta") {
        for (const k of [
          "id",
          "session_id",
          "forked_from_id",
          "parent_thread_id",
        ])
          if (Object.hasOwn(p, k)) out.payload[k] = id(p[k]);
        for (const k of ["source", "thread_source", "history_mode"])
          if (Object.hasOwn(p, k)) out.payload[k] = enums(p[k]);
        if (Object.hasOwn(p, "originator"))
          out.payload.originator =
            typeof p.originator === "string" &&
            /cloud|remote/i.test(p.originator)
              ? "remote"
              : p.originator === null
                ? null
                : "redacted-local-client";
        for (const k of ["history_base", "subagent_history_start_ordinal"])
          if (Object.hasOwn(p, k))
            out.payload[k] =
              p[k] === null
                ? null
                : typeof p[k] === "number"
                  ? finite(p[k])
                  : { redacted: true };
        if (
          typeof p.cli_version === "string" &&
          /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(p.cli_version)
        )
          out.payload.cli_version = p.cli_version;
        out.payload.cwd = "/redacted/project";
      } else if (r.type === "turn_context") {
        if (Object.hasOwn(p, "turn_id")) out.payload.turn_id = id(p.turn_id);
        if (Object.hasOwn(p, "model")) out.payload.model = id(p.model);
      } else {
        if (
          ![
            "task_started",
            "turn_started",
            "task_complete",
            "turn_complete",
            "turn_aborted",
            "thread_rolled_back",
          ].includes(p.type)
        )
          return null;
        out.payload.type = p.type;
        if (Object.hasOwn(p, "turn_id")) out.payload.turn_id = id(p.turn_id);
        if (Object.hasOwn(p, "error"))
          out.payload.error = p.error === null ? null : { redacted: true };
        for (const k of ["num_turns", "turns"])
          if (Object.hasOwn(p, k)) out.payload[k] = finite(p[k]);
      }
      return out;
    }
    if (
      !["user", "assistant", "system", "progress", "attachment"].includes(
        r.type,
      )
    )
      return null;
    const out = {
      type: r.type,
      timestamp:
        typeof r.timestamp === "string" &&
        /^\d{4}-\d\d-\d\dT[\d:.+Z-]{5,50}$/.test(r.timestamp)
          ? r.timestamp
          : null,
    };
    if (
      typeof r.version === "string" &&
      /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(r.version)
    )
      out.version = r.version;
    for (const k of [
      "uuid",
      "sessionId",
      "parentUuid",
      "sourceToolAssistantUUID",
    ])
      if (Object.hasOwn(r, k)) out[k] = id(r[k]);
    if (Object.hasOwn(r, "cwd")) out.cwd = "/redacted/project";
    for (const k of ["teamName", "agentId"])
      if (Object.hasOwn(r, k))
        out[k] = r[k] ? id(r[k]) : r[k] === null ? null : "";
    flags(r, out, [
      "isSidechain",
      "isMeta",
      "isCompactSummary",
      "isSynthetic",
      "toolUseResult",
    ]);
    if (Object.hasOwn(r, "subtype")) out.subtype = enums(r.subtype);
    if (Object.hasOwn(r, "durationMs")) out.durationMs = finite(r.durationMs);
    if (r.message && typeof r.message === "object") {
      out.message = {};
      const m = r.message;
      if (Object.hasOwn(m, "id")) out.message.id = id(m.id);
      if (Object.hasOwn(m, "model")) out.message.model = id(m.model);
      if (Object.hasOwn(m, "role"))
        out.message.role =
          enums(m.role) === "other" && m.role === "assistant"
            ? "assistant"
            : enums(m.role);
      if (Object.hasOwn(m, "stop_reason"))
        out.message.stop_reason = enums(m.stop_reason);
      if (Object.hasOwn(m, "content")) out.message.content = content(m.content);
    }
    return out;
  };
}
export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      agent: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(
      "node scripts/export-diagnostics.mjs --agent codex|claude --out NEW_FOLDER SELECTED_FILE [MORE_FILES]\nOffline only. Keeps exact timestamps and metadata structure; pseudonymizes IDs and models, removes prompts, replies, tool inputs/results and local paths. Review generated files before sharing.",
    );
    return;
  }
  if (
    !["codex", "claude"].includes(values.agent) ||
    !values.out ||
    !positionals.length
  )
    throw Error(
      "Specify --agent codex or claude, --out NEW_FOLDER and selected JSONL files.",
    );
  // Check all selected inputs before creating output; never overwrite any path.
  for (const input of positionals) {
    const info = await stat(input);
    if (
      !info.isFile() ||
      !input.endsWith(".jsonl") ||
      info.size > 512 * 1024 * 1024
    )
      throw Error("Select JSONL files smaller than 512 MiB.");
  }
  await mkdir(values.out, { mode: 0o700 });
  const redact = redactor();
  const manifest = {
    format: "agenttime-diagnostic-v1",
    agent: values.agent,
    note: "Pseudonymized IDs/models; exact timestamps retained. Content removed. Files are selected inputs, not a device scan.",
    files: [],
  };
  for (let i = 0; i < positionals.length; i++) {
    const output = path.join(values.out, `sample-${i + 1}.jsonl`),
      dest = await open(output, "wx", 0o600);
    let kept = 0,
      ignored = 0,
      invalid = 0;
    const input = createReadStream(positionals[i]),
      reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (Buffer.byteLength(line) > 16 * 1024 * 1024)
          throw Error(
            "Record exceeds 16 MiB; selected file was not fully exported.",
          );
        if (!line.trim()) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          invalid++;
          continue;
        }
        const safe = redact(row, values.agent);
        if (safe) {
          await dest.write(JSON.stringify(safe) + "\n");
          kept++;
        } else ignored++;
      }
    } finally {
      reader.close();
      input.destroy();
      await dest.close();
    }
    manifest.files.push({
      file: `sample-${i + 1}.jsonl`,
      kept,
      ignored,
      invalid,
    });
  }
  await writeFile(
    path.join(values.out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    "Created diagnostic files. Review the output folder before sharing. Original files were not modified.",
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Diagnostic export failed. Check selected JSONL files, permissions, and use a new output folder. No original files were modified.",
    );
    process.exitCode = 1;
  });
