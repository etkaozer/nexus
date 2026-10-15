// Tests for the ABI-correct native binding resolver.
//
// The problem it exists for: `mcpb pack` zips node_modules verbatim, and better-sqlite3 is NOT an
// N-API addon — its prebuild exports `node_register_module_v<ABI>` and refuses to load under any
// other Node. Packing on Node 26 (ABI 147) therefore produces a bundle that crashes on a
// reviewer's Node 22 (ABI 127) before a single tool can run. So the bundle ships one prebuild per
// supported ABI and picks at startup.
//
// Run: npm test

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNativeBinding, type NativeRuntime } from "./native-binding.js";

const NODE_22: NativeRuntime = { platform: "darwin", arch: "arm64", abi: "127", version: "v22.20.0" };

/** A prebuilds/ tree containing exactly the given `<platform>-<arch>/node-v<abi>` slots. */
async function prebuildsRoot(t: TestContext, slots: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nexus-prebuilds-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  for (const slot of slots) {
    await mkdir(join(dir, "prebuilds", slot), { recursive: true });
    await writeFile(join(dir, "prebuilds", slot, "better_sqlite3.node"), "not a real addon");
  }
  return dir;
}

test("resolves the prebuild matching the running Node ABI", async (t) => {
  const root = await prebuildsRoot(t, ["darwin-arm64/node-v115", "darwin-arm64/node-v127", "darwin-arm64/node-v147"]);
  assert.equal(
    resolveNativeBinding(root, NODE_22),
    join(root, "prebuilds", "darwin-arm64", "node-v127", "better_sqlite3.node"),
  );
});

test("returns null when no prebuilds ship at all, so a dev install is untouched", async (t) => {
  // `npm install` builds/downloads better-sqlite3 for the local Node already. Returning null means
  // "say nothing", and better-sqlite3's own bindings() lookup handles it exactly as before — this
  // shim must be invisible outside a packed bundle.
  const dir = await mkdtemp(join(tmpdir(), "nexus-noprebuilds-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  assert.equal(resolveNativeBinding(dir, NODE_22), null);
});

test("throws a legible error when the bundle ships prebuilds but none for this ABI", async (t) => {
  // The alternative is falling through to bindings(), which finds the packer's ABI-147 binary and
  // dies with ERR_DLOPEN_FAILED — a message that names neither the cause nor the fix. A reviewer
  // hitting this must be told which Node they are on and which ones work.
  const root = await prebuildsRoot(t, ["darwin-arm64/node-v137", "darwin-arm64/node-v147"]);

  assert.throws(
    () => resolveNativeBinding(root, NODE_22),
    (e: Error) => {
      assert.match(e.message, /v22\.20\.0/, "names the Node actually running");
      assert.match(e.message, /137|24/, "names a Node that would work");
      assert.match(e.message, /Nexus/, "identifies the source of the error");
      return true;
    },
  );
});

test("a prebuild for a different platform or arch does not count as a match", async (t) => {
  // An arm64 dylib on an x64 machine fails just as hard as the wrong ABI, and silently picking it
  // would turn a clear error into a confusing one.
  const root = await prebuildsRoot(t, ["linux-x64/node-v127", "darwin-x64/node-v127"]);
  assert.throws(() => resolveNativeBinding(root, NODE_22), /darwin-arm64|not supported|no prebuilt/i);
});
