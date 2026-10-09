import { readFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test } from "node:test";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
test("complete peer lock has verified bytes and preserves production diff", () => {
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  assert.equal(lock.packages["node_modules/diff"].version, "8.0.3");
  for (const name of Object.keys(manifest.peerDependencies)) assert.ok(lock.packages["node_modules/" + name]);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.integrity ?? "", /^sha(?:256|384|512)-/);
    if (path.includes("@earendil-works/pi-")) assert.equal(entry.version, "1.1.0");
  }
});
test("Aube frozen production install", { skip: process.env.AUBE_LOCK_INTEGRATION !== "1" }, () => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-stuff-frozen-"));
  for (const name of ["package.json", "package-lock.json"]) copyFileSync(new URL("../" + name, import.meta.url), join(cwd, name));
  const result = spawnSync("aube", ["install", "--prod", "--frozen-lockfile", "--config.auto-install-peers=false", "--config.strict-peer-dependencies=false"], { cwd, encoding: "utf8", env: { ...process.env, CI: "true", AUBE_STORE_DIR: join(cwd, "store") } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
