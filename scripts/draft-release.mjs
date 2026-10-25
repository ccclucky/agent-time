#!/usr/bin/env node
/**
 * scripts/draft-release.mjs — accumulate PR release notes into the pending
 * GitHub Draft Release.
 *
 * Extracted from the inline `github-script` block so the tag-selection rules are
 * testable (tests/draft_release.test.ts) instead of being YAML-only logic.
 *
 * The bug this fixes: the draft tag was always `v<package.json version>`. After
 * v0.2.1 was published, `main` still carried version 0.2.1, so the next push
 * created a second draft for an already-published tag — the maintainer ended up
 * with "v0.2.1" and "v0.2.1 (Pending Release)" side by side. Now a draft that
 * points at a published tag is retagged onto the next patch version instead, so
 * notes keep accumulating toward the *next* release.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_EVENT_PATH.
 * Flags: --dry-run (read-only; prints the plan).
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const API = process.env.GITHUB_API_URL || "https://api.github.com";

/** "0.2.1" → "0.2.2"; pre-release suffixes are dropped before bumping. */
export function nextPatch(version) {
  const base = version.split("-")[0].split("+")[0];
  const parts = base.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part)))
    throw new Error(`无法从 "${version}" 推导下一个补丁版本`);
  parts[2] += 1;
  return parts.join(".");
}

/** Pull the `### Release Notes` bullets out of a PR body. */
export function extractReleaseNotes(body) {
  const match = (body || "").match(/###\s*Release Notes\s*([\s\S]*?)(?=###|$)/i);
  if (!match) return [];
  const raw = match[1].trim();
  if (!raw || raw.toLowerCase() === "none") return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("-"));
}

/**
 * Decide what to do with the pending draft.
 *
 * - no draft                        → create one for the target tag
 * - draft already on target tag     → append
 * - draft on a published tag        → retag onto the next *unpublished* patch
 * - draft on some other open tag    → append (respect a manually chosen tag)
 */
export function planDraft({ releases, packageVersion }) {
  const publishedTags = new Set(
    releases.filter((release) => !release.draft).map((release) => release.tag_name),
  );
  const draft = releases.find((release) => release.draft) ?? null;

  // main 的版本追平常滞后于已发布 tag（可连续多个补丁，例如 v0.2.1 与 v0.2.2
  // 均已发布而 main 仍是 0.2.1）。只顺延一次会把草稿再次挂到已发布 tag 上，
  // 即 #44 的原样复现，因此循环顺延到第一个未发布的补丁位。
  let targetTag = `v${packageVersion}`;
  while (publishedTags.has(targetTag)) targetTag = `v${nextPatch(targetTag.slice(1))}`;

  if (!draft) return { action: "create", tag: targetTag, releaseId: null };
  if (draft.tag_name === targetTag)
    return { action: "append", tag: targetTag, releaseId: draft.id };
  if (publishedTags.has(draft.tag_name))
    return {
      action: "retag",
      tag: targetTag,
      releaseId: draft.id,
      from: draft.tag_name,
    };
  return { action: "append", tag: draft.tag_name, releaseId: draft.id };
}

async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${init.method || "GET"} ${path} → ${response.status} ${detail.slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

function eventPayload() {
  try {
    return JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    return {};
  }
}

/** Which PR (or bare commit) produced this push, and what notes it carries. */
export async function collectNotes({ repo, sha, payload }) {
  const pulls = await api(`/repos/${repo}/commits/${sha}/pulls`);
  if (pulls.length > 0) {
    const pr = pulls[0];
    const notes = extractReleaseNotes(pr.body).map(
      (line) => `${line} (by @${pr.user.login} in #${pr.number})`,
    );
    if (notes.length > 0) return notes;
    return [`- ${pr.title} (#${pr.number}) by @${pr.user.login}`];
  }
  const title = payload.head_commit?.message?.split("\n")[0]?.trim();
  if (title && !title.startsWith("Merge ")) return [`- ${title} (${sha.slice(0, 7)})`];
  return [];
}

/** Paginate through /releases so publishedTags is complete, not a 30-item window. */
async function listAllReleases(repo) {
  const releases = [];
  // 上限 10 页（1000 条）防御性收口；正常仓库远达不到。
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${repo}/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
  return releases;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  if (!repo || !sha) throw new Error("缺少 GITHUB_REPOSITORY / GITHUB_SHA");
  if (!process.env.GITHUB_TOKEN) throw new Error("缺少 GITHUB_TOKEN");

  const packageVersion = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ).version;
  const notes = await collectNotes({ repo, sha, payload: eventPayload() });
  if (notes.length === 0) {
    console.log("本次推送没有可用的发布说明，跳过。");
    return;
  }
  const newContent = notes.join("\n");

  const releases = await listAllReleases(repo);
  const plan = planDraft({ releases, packageVersion });

  console.log(`目标 tag：${plan.tag}（动作：${plan.action}）`);
  console.log("新增说明：\n" + newContent);

  const draft = plan.releaseId
    ? releases.find((release) => release.id === plan.releaseId)
    : null;
  const existingBody = draft?.body || "";
  if (existingBody.includes(newContent)) {
    console.log("草稿中已包含同样的说明，跳过。");
    return;
  }
  const body = existingBody
    ? `${existingBody}\n${newContent}`
    : `## What's Changed\n\n${newContent}\n\n---\n*Click 'Publish release' when ready to deploy this version to npm.*`;

  if (dryRun) {
    console.log(`[dry-run] 将写入草稿 ${plan.tag}，正文长度 ${body.length}`);
    return;
  }

  if (plan.action === "create") {
    const created = await api(`/repos/${repo}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: plan.tag,
        name: `${plan.tag} (Pending Release)`,
        draft: true,
        prerelease: false,
        body,
      }),
    });
    console.log(`已创建草稿 #${created.id}（${plan.tag}）`);
    return;
  }

  const patch = { body };
  if (plan.action === "retag") {
    patch.tag_name = plan.tag;
    patch.name = `${plan.tag} (Pending Release)`;
    console.log(`草稿原 tag ${plan.from} 已发布，改挂到 ${plan.tag}`);
  }
  await api(`/repos/${repo}/releases/${plan.releaseId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  console.log(`已更新草稿 #${plan.releaseId}（${plan.tag}）`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
