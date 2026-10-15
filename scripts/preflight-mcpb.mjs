#!/usr/bin/env node
// Refuse to build a bundle that would fail review for a reason we can check here.
//
// Each check below corresponds to something that is invisible at pack time and obvious to a
// reviewer: a bundle with no ABI-correct binding crashes on their Node, a placeholder privacy URL
// 404s, and a version that disagrees with package.json looks unmaintained. `mcpb pack` validates
// the manifest against its schema already — this covers what a schema cannot know.
//
//   node scripts/preflight-mcpb.mjs

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const problems = [];
const check = (ok, message) => void (ok || problems.push(message));

const manifest = read("manifest.json");
const pkg = read("package.json");

// 1. The entry point the manifest promises must actually be there.
check(existsSync(join(ROOT, manifest.server.entry_point)), `missing ${manifest.server.entry_point} — run: npm run build`);

// 2. At least one ABI-correct SQLite binding, for a platform the manifest claims to support.
for (const platform of manifest.compatibility?.platforms ?? []) {
  const targets = readdirSync(join(ROOT, "prebuilds"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(`${platform}-`))
    .map((e) => e.name);
  check(
    targets.length > 0,
    `manifest claims platform "${platform}" but prebuilds/ has no ${platform}-* binding — run: npm run prebuilds`,
  );
  for (const target of targets) {
    const abis = readdirSync(join(ROOT, "prebuilds", target)).filter((n) => n.startsWith("node-v"));
    check(abis.length > 0, `prebuilds/${target} is empty — run: npm run prebuilds`);
  }
}

// 3. A privacy policy URL that is still a placeholder is worse than none: it 404s under review.
for (const url of manifest.privacy_policies ?? []) {
  check(
    !/example\.com|REPLACE|TODO|localhost/i.test(url),
    `privacy_policies still contains a placeholder (${url}) — host PRIVACY.md and put its real HTTPS URL here`,
  );
  check(url.startsWith("https://"), `privacy policy URL must be HTTPS: ${url}`);
}
check((manifest.privacy_policies ?? []).length > 0, "manifest has no privacy_policies entry");

// 4. Version drift between the manifest, the package, and what the server reports over MCP.
check(
  manifest.version === pkg.version,
  `manifest.json version (${manifest.version}) !== package.json version (${pkg.version})`,
);
const serverVersion = readFileSync(join(ROOT, "src/mcp/server.ts"), "utf8").match(/version:\s*"([^"]+)"/)?.[1];
check(
  serverVersion === pkg.version,
  `src/mcp/server.ts reports version ${serverVersion} over MCP but package.json says ${pkg.version}`,
);

if (problems.length > 0) {
  console.error("Not ready to pack:\n");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}
console.log(`Preflight OK — nexus ${manifest.version}, platforms: ${(manifest.compatibility?.platforms ?? []).join(", ")}.`);
