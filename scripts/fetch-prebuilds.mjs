#!/usr/bin/env node
// Fetch one better-sqlite3 native binding per supported Node ABI into prebuilds/.
//
// WHY. better-sqlite3 is not an N-API addon: each binary exports node_register_module_v<ABI> and
// refuses to load under any other Node. `mcpb pack` zips node_modules as-is, so a bundle packed on
// Node 26 crashes on a reviewer's Node 22 before any tool can run — and nothing in the bundle gets
// to choose which `node` the host launches. So the bundle carries them all and picks at startup
// (src/index/native-binding.ts).
//
// Idempotent: an already-extracted binding is left alone. Safe to re-run.
//
//   node scripts/fetch-prebuilds.mjs                    # this machine's platform/arch
//   node scripts/fetch-prebuilds.mjs --platform=darwin --arch=arm64

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The ABIs better-sqlite3 12.x actually publishes. Node 20 (ABI 115) is deliberately absent:
// it reached end-of-life in April 2026 and upstream ships no prebuild for it, so a Node 20 user
// needs a source build either way — see `engines` in package.json.
const TARGETS = [
  { abi: "127", node: "22" },
  { abi: "137", node: "24" },
  { abi: "141", node: "25" },
  { abi: "147", node: "26" },
];

const argOf = (name, fallback) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;

const platform = argOf("platform", process.platform);
const arch = argOf("arch", process.arch);
const version = JSON.parse(readFileSync(join(ROOT, "node_modules", "better-sqlite3", "package.json"), "utf8")).version;

const tmp = join(ROOT, ".prebuild-tmp");
mkdirSync(tmp, { recursive: true });

let fetched = 0;
let skipped = 0;

for (const { abi, node } of TARGETS) {
  const destDir = join(ROOT, "prebuilds", `${platform}-${arch}`, `node-v${abi}`);
  const dest = join(destDir, "better_sqlite3.node");
  if (existsSync(dest)) {
    console.log(`  = Node ${node} (ABI ${abi}) already present`);
    skipped += 1;
    continue;
  }

  const asset = `better-sqlite3-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${asset}`;
  const tarball = join(tmp, asset);

  process.stdout.write(`  ↓ Node ${node} (ABI ${abi}) … `);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));

  mkdirSync(destDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", destDir, "--strip-components=2", "build/Release/better_sqlite3.node"]);

  // Verify we got what the filename claimed. A prebuild silently carrying the wrong ABI would
  // reproduce the exact bug this script exists to prevent, only harder to see.
  const symbol = `node_register_module_v${abi}`;
  if (!readFileSync(dest).includes(symbol)) {
    rmSync(destDir, { recursive: true, force: true });
    throw new Error(`${asset} does not export ${symbol} — refusing to ship a mislabelled binding`);
  }

  console.log("ok");
  fetched += 1;
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\nprebuilds/${platform}-${arch}: ${fetched} fetched, ${skipped} already present.`);
console.log(`Supported at runtime: Node ${TARGETS.map((t) => t.node).join(", ")}.`);
