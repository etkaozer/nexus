import { ulid } from "ulid";

/**
 * Mint a fresh note identity. ULIDs are used (over UUIDs) because they are
 * lexicographically sortable by creation time, which is handy for a growing vault.
 * Minting is the engine's job (upsert with no uid); the StorageAdapter never mints.
 */
export function newUid(): string {
  return ulid();
}
