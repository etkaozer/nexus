// Tests for vault-path resolution — the first thing that can go wrong on a fresh install.
//
// Run: npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVaultPath } from "./config.js";

test("prefers NEXUS_VAULT over a positional argument", () => {
  assert.equal(resolveVaultPath({ NEXUS_VAULT: "/vaults/env" }, "/vaults/argv"), "/vaults/env");
});

test("falls back to the positional argument when the env var is unset", () => {
  assert.equal(resolveVaultPath({}, "/vaults/argv"), "/vaults/argv");
});

test("treats an empty NEXUS_VAULT as unset rather than as the current directory", () => {
  // A user_config field left blank arrives as "", and resolve("") is the CWD — which for a host-
  // launched server is somewhere arbitrary. Silently indexing it would be worse than refusing.
  assert.equal(resolveVaultPath({ NEXUS_VAULT: "  " }, "/vaults/argv"), "/vaults/argv");
  assert.throws(() => resolveVaultPath({ NEXUS_VAULT: "" }, undefined), /no vault path/i);
});

test("refuses an unresolved MCPB config template instead of creating a folder named after it", () => {
  // The failure this prevents: if the host does not substitute ${user_config.vault_path}, the
  // literal string arrives as a path, and Nexus's own mkdir(recursive) would happily CREATE a
  // directory called "${user_config.vault_path}" and index it. The user then sees an empty vault
  // and no error at all. Fail loudly, and name the setting the user has to fix.
  assert.throws(
    () => resolveVaultPath({ NEXUS_VAULT: "${user_config.vault_path}" }, undefined),
    (e: Error) => {
      assert.match(e.message, /vault/i, "names what is misconfigured");
      assert.match(e.message, /Nexus/, "identifies the source");
      return true;
    },
  );
});

test("explains what to do when no vault path is given at all", () => {
  assert.throws(() => resolveVaultPath({}, undefined), /NEXUS_VAULT/);
});
