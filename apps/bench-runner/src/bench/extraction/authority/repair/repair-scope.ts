import { createHash } from "node:crypto";
import {
  assertExtractionPreservedValidClosure,
  type ExtractionPreservedValidClosure
} from "./preserved-valid-closure.js";

export interface ExtractionRepairShard {
  readonly cache_key: string;
  readonly raw_json_sha256: string;
}

export interface ExtractionRepairScope {
  readonly kind: "strict-json-invalid-shards";
  readonly shard_count: number;
  readonly key_set_sha256: string;
  readonly source_content_sha256: string;
  readonly preserved_valid_closure: ExtractionPreservedValidClosure;
  readonly shards: readonly ExtractionRepairShard[];
}

export function createExtractionRepairScope(
  shards: readonly ExtractionRepairShard[],
  preservedValidClosure: ExtractionPreservedValidClosure
): ExtractionRepairScope {
  const sorted = [...shards].sort((left, right) =>
    left.cache_key.localeCompare(right.cache_key)
  );
  const scope = {
    kind: "strict-json-invalid-shards" as const,
    shard_count: sorted.length,
    key_set_sha256: digest(sorted.map((shard) => shard.cache_key).join("\n")),
    source_content_sha256: digest(sorted.map((shard) =>
      `${shard.cache_key}\0${shard.raw_json_sha256}`
    ).join("\n")),
    preserved_valid_closure: Object.freeze({ ...preservedValidClosure }),
    shards: Object.freeze(sorted.map((shard) => Object.freeze({ ...shard })))
  };
  assertExtractionRepairScope(scope);
  return Object.freeze(scope);
}

export function assertExtractionRepairScope(
  value: unknown
): asserts value is ExtractionRepairScope {
  if (typeof value !== "object" || value === null) throw invalidScope();
  const scope = value as Partial<ExtractionRepairScope>;
  if (scope.kind !== "strict-json-invalid-shards" ||
      !Number.isSafeInteger(scope.shard_count) || (scope.shard_count ?? 0) < 1 ||
      !isDigest(scope.key_set_sha256) || !isDigest(scope.source_content_sha256) ||
      !Array.isArray(scope.shards) || scope.shards.length !== scope.shard_count) {
    throw invalidScope();
  }
  assertExtractionPreservedValidClosure(scope.preserved_valid_closure);
  const rebuilt = createUncheckedScope(scope.shards);
  if (rebuilt.key_set_sha256 !== scope.key_set_sha256 ||
      rebuilt.source_content_sha256 !== scope.source_content_sha256) {
    throw invalidScope();
  }
}

export function isExtractionRepairScope(value: unknown): value is ExtractionRepairScope {
  try {
    assertExtractionRepairScope(value);
    return true;
  } catch {
    return false;
  }
}

export function assertRepairInventoryProgress(
  authorized: {
    readonly expectedTurns: number;
    readonly validTurns: number;
    readonly missingTurns: number;
    readonly invalidTurns: number;
    readonly orphanTurns: number;
  },
  current: typeof authorized
): void {
  const repaired = authorized.invalidTurns - current.invalidTurns;
  if (authorized.orphanTurns !== 0 || current.orphanTurns !== 0 || repaired < 0 ||
      current.expectedTurns !== authorized.expectedTurns ||
      current.missingTurns !== authorized.missingTurns ||
      current.validTurns !== authorized.validTurns + repaired) {
    throw new Error("extraction repair authority inventory drifted outside its bounded scope");
  }
}

export function repairScopeKeys(scope: ExtractionRepairScope): ReadonlySet<string> {
  assertExtractionRepairScope(scope);
  return new Set(scope.shards.map((shard) => shard.cache_key));
}

export function assertRemainingRepairShards(
  scope: ExtractionRepairScope,
  shards: readonly ExtractionRepairShard[]
): void {
  assertExtractionRepairScope(scope);
  const authorized = new Map(scope.shards.map((shard) => [
    shard.cache_key, shard.raw_json_sha256
  ] as const));
  for (const shard of shards) {
    if (authorized.get(shard.cache_key) !== shard.raw_json_sha256) {
      throw new Error("extraction repair scope no longer matches an invalid shard");
    }
  }
}

function createUncheckedScope(shards: readonly unknown[]) {
  const normalized = shards.map((shard) => {
    if (typeof shard !== "object" || shard === null) throw invalidScope();
    const entry = shard as Partial<ExtractionRepairShard>;
    if (!isDigest(entry.cache_key) || !isDigest(entry.raw_json_sha256)) throw invalidScope();
    return { cache_key: entry.cache_key, raw_json_sha256: entry.raw_json_sha256 };
  }).sort((left, right) => left.cache_key.localeCompare(right.cache_key));
  if (new Set(normalized.map((entry) => entry.cache_key)).size !== normalized.length) {
    throw invalidScope();
  }
  return {
    key_set_sha256: digest(normalized.map((entry) => entry.cache_key).join("\n")),
    source_content_sha256: digest(normalized.map((entry) =>
      `${entry.cache_key}\0${entry.raw_json_sha256}`
    ).join("\n"))
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function invalidScope(): Error {
  return new Error("extraction repair scope is invalid");
}
