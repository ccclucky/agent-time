import test from "node:test";
import assert from "node:assert/strict";
import {
  extractReleaseNotes,
  nextPatch,
  planDraft,
} from "../scripts/draft-release.mjs";

// The release pipeline used to always tag the pending draft with
// `v<package.json version>`. Right after a publish, main still carried the
// released version, so the next push created a second draft on an
// already-published tag ("v0.2.1" + "v0.2.1 (Pending Release)").

test("nextPatch 递增补丁位并忽略预发布后缀", () => {
  assert.equal(nextPatch("0.2.1"), "0.2.2");
  assert.equal(nextPatch("1.9.9"), "1.9.10");
  assert.equal(nextPatch("0.3.0-beta.2"), "0.3.1");
  assert.throws(() => nextPatch("not-a-version"));
});

test("Release Notes 只取列表项，None 视为无说明", () => {
  const body = [
    "## Summary",
    "some words",
    "### Release Notes",
    "- feat: 时间流向改为三态占比条",
    "- fix: 修正术语",
    "",
    "### SemVer Recommendation",
    "minor",
  ].join("\n");
  assert.deepEqual(extractReleaseNotes(body), [
    "- feat: 时间流向改为三态占比条",
    "- fix: 修正术语",
  ]);
  assert.deepEqual(extractReleaseNotes("### Release Notes\nNone"), []);
  assert.deepEqual(extractReleaseNotes("no section here"), []);
  assert.deepEqual(extractReleaseNotes(undefined), []);
});

const release = (tag, draft = false) => ({ id: tag.length + (draft ? 1 : 0), tag_name: tag, draft });

test("没有草稿时按当前版本新建", () => {
  const plan = planDraft({
    releases: [release("v0.2.0")],
    packageVersion: "0.2.1",
  });
  assert.equal(plan.action, "create");
  assert.equal(plan.tag, "v0.2.1");
});

test("草稿已挂在未发布的同版本 tag 上时直接追加", () => {
  const plan = planDraft({
    releases: [release("v0.2.2", true), release("v0.2.1")],
    packageVersion: "0.2.2",
  });
  assert.equal(plan.action, "append");
  assert.equal(plan.tag, "v0.2.2");
});

test("草稿指向已发布的 tag 时改挂到下一个补丁版本", () => {
  const plan = planDraft({
    releases: [release("v0.2.1", true), release("v0.2.1"), release("v0.2.0")],
    packageVersion: "0.2.1",
  });
  assert.equal(plan.action, "retag");
  assert.equal(plan.from, "v0.2.1");
  assert.equal(plan.tag, "v0.2.2");
});

test("草稿挂着人工指定的其他 tag 时尊重原 tag", () => {
  const plan = planDraft({
    releases: [release("v0.3.0", true), release("v0.2.1")],
    packageVersion: "0.2.1",
  });
  assert.equal(plan.action, "append");
  assert.equal(plan.tag, "v0.3.0");
});
