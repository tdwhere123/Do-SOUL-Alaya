import { createHash } from "node:crypto";

import { stableStringify } from "../../shared/stable-stringify.js";

export type RecallFieldDigest = `sha256:${string}`;

export function digestRecallFieldIdentity(value: unknown): RecallFieldDigest {
  return `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;
}
