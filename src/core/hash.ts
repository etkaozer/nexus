import { createHash } from "node:crypto";

/** Stable content hash used for chunk diffing and the write guard. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
