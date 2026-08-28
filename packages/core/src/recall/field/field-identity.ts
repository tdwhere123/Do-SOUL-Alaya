import { createHash } from "node:crypto";

import { stableStringify } from "../../shared/stable-stringify.js";

export type RecallFieldDigest = `sha256:${string}`;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;

export function isRecallFieldDigest(value: string): value is RecallFieldDigest {
  return SHA256.test(value);
}

export function digestRecallFieldIdentity(value: unknown): RecallFieldDigest {
  return `sha256:${createHash("sha256").update(stableStringify(value), "utf8").digest("hex")}`;
}
