// Startup configuration — kept out of main.ts so it can be tested without booting a server.

/**
 * Decide which vault to open, from the environment and an optional positional argument.
 *
 * Both paths into Nexus lead here: `NEXUS_VAULT` (how every MCP host configures it, including the
 * MCPB bundle) and `nexus-brain-mcp <vault>` (the CLI). Throws rather than guessing — every alternative
 * to throwing produces a server that starts fine and then quietly indexes the wrong directory,
 * which is the failure a user is least equipped to diagnose.
 */
export function resolveVaultPath(env: Record<string, string | undefined>, positional: string | undefined): string {
  const fromEnv = env["NEXUS_VAULT"]?.trim();
  const candidate = fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : positional?.trim();

  if (candidate === undefined || candidate.length === 0) {
    throw new Error(
      "Nexus: no vault path. Set NEXUS_VAULT to the folder holding your Markdown notes, " +
        "or pass it as an argument: nexus-brain-mcp <vault>.",
    );
  }

  // An unsubstituted config template. Left alone this is treated as a relative path and Nexus's
  // own mkdir(recursive) CREATES a directory literally named "${user_config.vault_path}" — the
  // user then sees an empty vault, working tools, and no error anywhere.
  if (candidate.includes("${")) {
    throw new Error(
      `Nexus: the vault path is still an unsubstituted config template (${candidate}). ` +
        "Open the extension's settings and choose your vault folder, then restart the host.",
    );
  }

  return candidate;
}
