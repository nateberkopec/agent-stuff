import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url)));
test("production lock retains diff and leaves Pi peers to the host", () => {
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[""].version, manifest.version);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/diff"]);
  assert.equal(lock.packages["node_modules/diff"].version, "8.0.3");
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path) assert.match(entry.integrity ?? "", /^sha(?:256|384|512)-/);
  }
});
