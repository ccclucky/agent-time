import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { Directories } from "../src/directories.js";

const resources: { dir: string; store: Store }[] = [];
function setup() {
  const dir = realpathSync(
    mkdtempSync(path.join(tmpdir(), "agenttime-pi-surface-")),
  );
  const store = new Store(path.join(dir, "data.sqlite3")),
    home = path.join(dir, "home");
  mkdirSync(home);
  resources.push({ dir, store });
  return { dir, store, home, dirs: new Directories(store, home, {}, "linux") };
}
afterEach(() => {
  for (const { dir, store } of resources.splice(0)) {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function file(dir: string, rows: unknown[], name = "a.jsonl") {
  const p = path.join(dir, name);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return p;
}

test("Pi directory metadata is supported and points at sessions history", () => {
  const { dirs } = setup();
  const item = dirs.get("pi");
  assert.equal(item.supported, true);
  assert.equal(item.name, "Pi");
  assert.equal(item.default_path, "~/.pi/agent");
  assert.deepEqual(item.history_subdirectories, ["sessions"]);
});
