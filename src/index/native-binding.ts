// Picks an ABI-correct better-sqlite3 binding when Nexus runs from a packed MCPB bundle.
//
// WHY THIS EXISTS. `mcpb pack` zips node_modules exactly as it finds it, and better-sqlite3 is not
// an N-API addon — its prebuild exports `node_register_module_v<ABI>` and refuses to load under a
// Node with any other ABI. So a bundle packed on Node 26 (ABI 147) dies on a reviewer's Node 22
// (ABI 127) before a single tool can run, with an ERR_DLOPEN_FAILED that names neither the cause
// nor the fix. Nothing in the bundle gets to choose which `node` the host launches it with.
//
// The fix is to stop assuming. `npm run prebuilds` puts one binding per supported ABI under
// prebuilds/<platform>-<arch>/node-v<abi>/, and this resolves the right one at startup, passing it
// to better-sqlite3's own `nativeBinding` option — a supported hook, not a monkey-patch.
//
// Outside a bundle this is INVISIBLE: a dev checkout has no prebuilds/ directory, so it returns
// null and better-sqlite3's normal bindings() lookup runs exactly as it did before.
//
// (The durable fix is to stop needing prebuilds at all — see the node:sqlite item in the README
// roadmap. This shim buys a working bundle without an engine rewrite.)

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The parts of the running process that decide which binding can be loaded. */
export interface NativeRuntime {
  platform: string;
  arch: string;
  /** process.versions.modules — the ABI number the addon must have been built against. */
  abi: string;
  /** process.version, carried only so the error message can name what is actually running. */
  version: string;
}

/** ABI → Node major. Only used to make errors readable; an unknown ABI degrades to the raw number. */
const NODE_MAJOR_BY_ABI: Record<string, string> = {
  "108": "18",
  "115": "20",
  "127": "22",
  "137": "24",
  "147": "26",
};

export function currentRuntime(): NativeRuntime {
  return {
    platform: process.platform,
    arch: process.arch,
    abi: process.versions.modules,
    version: process.version,
  };
}

/** The package root — dist/index/native-binding.js sits two levels below it. */
export function defaultRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Resolve the better-sqlite3 binding for `rt`, looking under `<root>/prebuilds`.
 *
 * Three outcomes, and the third is the point:
 *   • no prebuilds/ directory  → null. A dev install; say nothing and let bindings() do its job.
 *   • a matching prebuild      → its absolute path.
 *   • prebuilds but no match   → THROW. Falling through would let bindings() find the packer's own
 *     binary and fail with an opaque dlopen error; a reviewer needs to be told which Node they are
 *     on and which ones this bundle supports.
 */
export function resolveNativeBinding(root: string, rt: NativeRuntime = currentRuntime()): string | null {
  const prebuilds = join(root, "prebuilds");
  if (!isDirectory(prebuilds)) return null;

  const match = join(prebuilds, `${rt.platform}-${rt.arch}`, `node-v${rt.abi}`, "better_sqlite3.node");
  if (existsSync(match)) return match;

  throw new Error(
    [
      "Nexus: this bundle has no SQLite binding for the Node.js it was started with.",
      `  running: Node ${rt.version} — ${rt.platform}-${rt.arch}, ABI ${rt.abi}`,
      `  bundled: ${describeAvailable(prebuilds)}`,
      "Install a supported Node.js version and restart the host, or run Nexus from source",
      "(git clone … && npm install && npm run build).",
    ].join("\n"),
  );
}

/** better-sqlite3 constructor options, ready to spread. Empty outside a bundle. */
export function nativeBindingOption(root: string = defaultRoot()): { nativeBinding?: string } {
  const path = resolveNativeBinding(root);
  return path === null ? {} : { nativeBinding: path };
}

/** e.g. "darwin-arm64 Node 22 (ABI 127), darwin-arm64 Node 24 (ABI 137)" */
function describeAvailable(prebuilds: string): string {
  const found: string[] = [];
  for (const target of safeReadDir(prebuilds)) {
    for (const slot of safeReadDir(join(prebuilds, target))) {
      const abi = slot.startsWith("node-v") ? slot.slice("node-v".length) : slot;
      const major = NODE_MAJOR_BY_ABI[abi];
      found.push(`${target} ${major ? `Node ${major} ` : ""}(ABI ${abi})`);
    }
  }
  return found.length > 0 ? found.sort().join(", ") : "nothing usable";
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => isDirectory(join(dir, name)));
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
