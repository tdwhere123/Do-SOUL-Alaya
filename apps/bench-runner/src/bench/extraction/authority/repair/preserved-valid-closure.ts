import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  type ExtractionContentClosureEntry
} from "../../content-closure.js";

export interface ExtractionPreservedValidClosure {
  readonly shard_count: number;
  readonly key_set_sha256: string;
  readonly content_closure_sha256: string;
}

export function createExtractionPreservedValidClosure(
  entries: readonly ExtractionContentClosureEntry[]
): ExtractionPreservedValidClosure {
  const closure = {
    shard_count: entries.length,
    key_set_sha256: computeExtractionKeySetSha256(entries.map((entry) => entry.cacheKey)),
    content_closure_sha256: computeExtractionContentClosureSha256(entries)
  };
  assertExtractionPreservedValidClosure(closure);
  return Object.freeze(closure);
}

export function assertExtractionPreservedValidClosure(
  value: unknown
): asserts value is ExtractionPreservedValidClosure {
  if (typeof value !== "object" || value === null) throw invalidClosure();
  const closure = value as Partial<ExtractionPreservedValidClosure>;
  if (!Number.isSafeInteger(closure.shard_count) || (closure.shard_count ?? -1) < 0 ||
      !isDigest(closure.key_set_sha256) || !isDigest(closure.content_closure_sha256)) {
    throw invalidClosure();
  }
}

export function assertPreservedValidClosureUnchanged(
  authorized: ExtractionPreservedValidClosure,
  current: ExtractionPreservedValidClosure
): void {
  assertExtractionPreservedValidClosure(authorized);
  assertExtractionPreservedValidClosure(current);
  if (authorized.shard_count !== current.shard_count ||
      authorized.key_set_sha256 !== current.key_set_sha256 ||
      authorized.content_closure_sha256 !== current.content_closure_sha256) {
    throw new Error("extraction repair preserved strict-valid closure drifted");
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function invalidClosure(): Error {
  return new Error("extraction repair preserved strict-valid closure is invalid");
}
