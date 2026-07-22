import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from
  "../../../compile-seed/compile-seed-types.js";
import {
  computeExtractionTurnCacheKey,
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
  "action" | "direct_spend" | "repair_scope"
>;

export interface CacheKeyAllowlistResolution {
  readonly turns: readonly LongMemEvalExtractionTurn[];
  readonly skippedCacheHits: number;
}

export function resolveCacheKeyAllowlistedTurns(input: {
  readonly allowlist: readonly string[] | undefined;
  readonly cacheRoot: string;
  readonly prepared: CacheKeyAllowlistPrepared;
  readonly authority: CacheKeyAllowlistAuthority | undefined;
  readonly writeLease: CacheKeyAllowlistWriteLease;
}): CacheKeyAllowlistResolution | undefined {
  if (input.allowlist === undefined) return undefined;
  assertAllowlistScope(input.prepared, input.authority);
  const keys = validatedAllowlist(input.allowlist);
  const pinnedCachedTurns = requirePinnedCachedTurns(input.prepared.pinnedCachedTurns);
  countIntentionalSkippedTurns(
    input.prepared.distinctExtractionTurns.length, pinnedCachedTurns, keys.length
  );
  input.writeLease.assertOwned();
  const expected = indexTurns(input.prepared.distinctExtractionTurns, input.prepared.config);
  const executable = indexTurns(input.prepared.executionExtractionTurns, input.prepared.config);
  return Object.freeze({
    turns: Object.freeze(keys.map((key) => selectMissingTurn(
      key, expected, executable, input.cacheRoot, input.prepared.config
    ))),
    skippedCacheHits: pinnedCachedTurns
  });
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
): void {
  if (authority === undefined || authority.action !== "fill" ||
      authority.direct_spend !== undefined || authority.repair_scope !== undefined ||
      prepared.expansion !== undefined || prepared.questionBatchLimit !== undefined) {
    throw new ExtractionCacheInvariantError(
      "cache-key allowlist requires an authority-bound normal fill"
    );
  }
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

function indexTurns(
  turns: readonly LongMemEvalExtractionTurn[],
  config: CacheKeyAllowlistPrepared["config"]
): ReadonlyMap<string, LongMemEvalExtractionTurn> {
  return new Map(turns.map((turn) => [
    computeExtractionTurnCacheKey(
      config.model, config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, turn
    ),
    turn
  ]));
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
