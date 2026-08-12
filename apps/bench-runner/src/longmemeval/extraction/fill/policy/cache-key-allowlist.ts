import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from
  "../../../compile-seed/compile-seed-types.js";
import {
  computeExtractionTurnCacheKeys,
  inspectCachedExtraction
} from "../../../compile-seed/compile-seed-cache.js";
import type { ExtractionAuthorityReceipt } from "../../authority/receipt.js";
import { ExtractionCacheInvariantError } from "../../cache/cache-invariant-error.js";
import type { LongMemEvalExtractionTurn } from "../../turn-contents.js";

interface CacheKeyAllowlistPrepared {
  readonly config: Pick<CompileSeedExtractionConfig, "model" | "requestProfile">;
  readonly pinnedCachedTurns: number | undefined;
  readonly distinctExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly executionExtractionTurns: readonly LongMemEvalExtractionTurn[];
  readonly questionBatchLimit?: number;
  readonly expansion?: unknown;
}

interface CacheKeyAllowlistWriteLease {
  readonly assertOwned: () => void;
}

type CacheKeyAllowlistAuthority = Pick<
  ExtractionAuthorityReceipt,
  "action" | "direct_spend" | "repair_scope" | "catalog_refill" | "continuation"
>;

export interface CacheKeyAllowlistResolution {
  readonly turns: readonly LongMemEvalExtractionTurn[];
  readonly skippedCacheHits: number;
  readonly executionCacheKeys?: ReadonlySet<string>;
}

export function resolveCacheKeyAllowlistedTurns(input: {
  readonly allowlist: readonly string[] | undefined;
  readonly cacheRoot: string;
  readonly prepared: CacheKeyAllowlistPrepared;
  readonly authority: CacheKeyAllowlistAuthority | undefined;
  readonly writeLease: CacheKeyAllowlistWriteLease;
  readonly completedKeys?: readonly string[];
}): CacheKeyAllowlistResolution | undefined {
  if (input.allowlist === undefined) {
    if (input.authority?.catalog_refill !== undefined) {
      throw new ExtractionCacheInvariantError(
        "catalog refill authority requires its receipt-bound key set"
      );
    }
    return undefined;
  }
  const scope = assertAllowlistScope(input.prepared, input.authority);
  const keys = validatedAllowlist(input.allowlist);
  if (!sameOrderedKeys(keys, scope.keys)) {
    throw new ExtractionCacheInvariantError(
      "runtime cache-key allowlist does not match the catalog refill authority"
    );
  }
  const completed = completedScopeKeys(input.completedKeys, scope.keys);
  const remainingKeys = keys.filter((key) => !completed.has(key));
  if (remainingKeys.length === 0) {
    throw new ExtractionCacheInvariantError(
      "catalog refill authority has no remaining missing cache keys"
    );
  }
  const pinnedCachedTurns = requirePinnedCachedTurns(input.prepared.pinnedCachedTurns);
  const expected = indexTurns(input.prepared.distinctExtractionTurns, input.prepared.config);
  countIntentionalSkippedTurns(
    expected.size, pinnedCachedTurns, remainingKeys.length
  );
  input.writeLease.assertOwned();
  const executable = indexTurns(input.prepared.executionExtractionTurns, input.prepared.config);
  const executionKeys = input.prepared.questionBatchLimit === undefined
    ? remainingKeys
    : remainingKeys.filter((key) => executable.has(key));
  return Object.freeze({
    turns: selectUniqueMissingTurns(
      executionKeys, expected, executable, input.cacheRoot, input.prepared.config
    ),
    skippedCacheHits: pinnedCachedTurns,
    executionCacheKeys: new Set(executionKeys)
  });
}

export function resolveContinuationMissingTurns(input: {
  readonly cacheRoot: string;
  readonly prepared: CacheKeyAllowlistPrepared;
  readonly authority: CacheKeyAllowlistAuthority | undefined;
  readonly successfulKeys: readonly string[] | undefined;
  readonly writeLease: CacheKeyAllowlistWriteLease;
}): CacheKeyAllowlistResolution | undefined {
  if (input.authority?.continuation === undefined) return undefined;
  assertContinuationScope(input.prepared, input.authority);
  const successfulKeys = validatedCompletedKeys(input.successfulKeys);
  const pinnedCachedTurns = requirePinnedCachedTurns(input.prepared.pinnedCachedTurns);
  if (successfulKeys.length !== pinnedCachedTurns) {
    throw new ExtractionCacheInvariantError(
      "continuation ledger success count does not match the pinned manifest"
    );
  }
  const expected = indexTurns(input.prepared.distinctExtractionTurns, input.prepared.config);
  if (successfulKeys.some((key) => !expected.has(key))) {
    throw new ExtractionCacheInvariantError(
      "continuation ledger contains a success outside the production full window"
    );
  }
  const completed = new Set(successfulKeys);
  const remainingKeys = [...expected.keys()].filter((key) => !completed.has(key));
  if (remainingKeys.length === 0) {
    throw new ExtractionCacheInvariantError(
      "continuation authority has no remaining missing cache keys"
    );
  }
  input.writeLease.assertOwned();
  const executable = indexTurns(
    input.prepared.executionExtractionTurns, input.prepared.config
  );
  return Object.freeze({
    turns: selectUniqueMissingTurns(
      remainingKeys, expected, executable, input.cacheRoot, input.prepared.config
    ),
    skippedCacheHits: successfulKeys.length,
    executionCacheKeys: new Set(remainingKeys)
  });
}

function completedScopeKeys(
  completedKeys: readonly string[] | undefined,
  scopeKeys: readonly string[]
): ReadonlySet<string> {
  const completed = completedKeys ?? [];
  if (completed.some((key) => !/^[a-f0-9]{64}$/u.test(key)) ||
      new Set(completed).size !== completed.length ||
      completed.some((key) => !scopeKeys.includes(key))) {
    throw new ExtractionCacheInvariantError(
      "catalog refill attempt ledger contains an out-of-scope success"
    );
  }
  return new Set(completed);
}

export function countIntentionalSkippedTurns(
  fullWindowTurns: number,
  pinnedCachedTurns: number | undefined,
  allowlistedTurns: number | undefined
): number {
  if (allowlistedTurns === undefined) return 0;
  const skipped = fullWindowTurns - requirePinnedCachedTurns(pinnedCachedTurns) - allowlistedTurns;
  if (!Number.isSafeInteger(skipped) || skipped < 0) {
    throw new ExtractionCacheInvariantError(
      "cache-key allowlist exceeds the pinned full-window missing set"
    );
  }
  return skipped;
}

function requirePinnedCachedTurns(value: number | undefined): number {
  if (value === undefined) {
    throw new ExtractionCacheInvariantError(
      "cache-key allowlist requires a validated pinned manifest cached-turn count"
    );
  }
  return value;
}

function assertAllowlistScope(
  prepared: CacheKeyAllowlistPrepared,
  authority: CacheKeyAllowlistAuthority | undefined
): NonNullable<CacheKeyAllowlistAuthority["catalog_refill"]> {
  if (authority === undefined || authority.action !== "fill" ||
      authority.direct_spend !== undefined || authority.repair_scope !== undefined ||
      authority.catalog_refill === undefined || prepared.expansion !== undefined) {
    throw new ExtractionCacheInvariantError(
      "cache-key allowlist requires an authority-bound catalog refill"
    );
  }
  return authority.catalog_refill;
}

function validatedAllowlist(allowlist: readonly string[]): readonly string[] {
  if (allowlist.length === 0) {
    throw new ExtractionCacheInvariantError("cache-key allowlist must be non-empty");
  }
  if (allowlist.some((key) => !/^[a-f0-9]{64}$/u.test(key))) {
    throw new ExtractionCacheInvariantError(
      "cache-key allowlist entries must be lowercase SHA-256 digests"
    );
  }
  if (new Set(allowlist).size !== allowlist.length) {
    throw new ExtractionCacheInvariantError("cache-key allowlist cannot contain duplicate keys");
  }
  return allowlist;
}

function validatedCompletedKeys(
  keys: readonly string[] | undefined
): readonly string[] {
  if (keys === undefined) {
    throw new ExtractionCacheInvariantError(
      "continuation authority requires a settled attempt ledger"
    );
  }
  if (keys.some((key) => !/^[a-f0-9]{64}$/u.test(key)) ||
      new Set(keys).size !== keys.length) {
    throw new ExtractionCacheInvariantError(
      "continuation ledger successes must be unique lowercase SHA-256 digests"
    );
  }
  return keys;
}

function assertContinuationScope(
  prepared: CacheKeyAllowlistPrepared,
  authority: CacheKeyAllowlistAuthority
): void {
  if (authority.action !== "fill" || authority.continuation === undefined ||
      authority.direct_spend !== undefined || authority.repair_scope !== undefined ||
      authority.catalog_refill !== undefined || prepared.expansion !== undefined ||
      prepared.questionBatchLimit !== undefined) {
    throw new ExtractionCacheInvariantError(
      "sparse continuation requires a normal settled continuation authority"
    );
  }
}

function indexTurns(
  turns: readonly LongMemEvalExtractionTurn[],
  config: CacheKeyAllowlistPrepared["config"]
): ReadonlyMap<string, LongMemEvalExtractionTurn> {
  return new Map(turns.flatMap((turn) =>
    computeExtractionTurnCacheKeys(
      config.model, config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, turn
    ).map((cacheKey) => [cacheKey, turn] as const)
  ));
}

function selectMissingTurn(
  key: string,
  expected: ReadonlyMap<string, LongMemEvalExtractionTurn>,
  executable: ReadonlyMap<string, LongMemEvalExtractionTurn>,
  cacheRoot: string,
  config: CacheKeyAllowlistPrepared["config"]
): LongMemEvalExtractionTurn {
  if (!expected.has(key)) {
    throw new ExtractionCacheInvariantError(
      `cache-key allowlist entry is outside the production full window: ${key}`
    );
  }
  const turn = executable.get(key);
  if (turn === undefined) {
    throw new ExtractionCacheInvariantError(
      `cache-key allowlist entry is outside the executable fill scope: ${key}`
    );
  }
  const status = inspectCachedExtraction(
    cacheRoot, key, config.model, config.requestProfile
  ).status;
  if (status !== "missing") {
    throw new ExtractionCacheInvariantError(
      `cache-key allowlist entry current status is ${status}: ${key}`
    );
  }
  return turn;
}

function selectUniqueMissingTurns(
  keys: readonly string[],
  expected: ReadonlyMap<string, LongMemEvalExtractionTurn>,
  executable: ReadonlyMap<string, LongMemEvalExtractionTurn>,
  cacheRoot: string,
  config: CacheKeyAllowlistPrepared["config"]
): readonly LongMemEvalExtractionTurn[] {
  const turns = keys.map((key) => selectMissingTurn(
    key, expected, executable, cacheRoot, config
  ));
  return Object.freeze([...new Set(turns)]);
}

function sameOrderedKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}
