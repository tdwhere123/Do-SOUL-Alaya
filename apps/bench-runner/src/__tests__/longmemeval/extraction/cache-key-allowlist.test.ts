import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeExtractionTurnCacheKey
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { writeCachedExtraction } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import {
  resolveCacheKeyAllowlistedTurns,
  resolveContinuationMissingTurns
} from
  "../../../runs/extraction/fill/policy/cache-key-allowlist.js";
import type { LongMemEvalExtractionTurn } from
  "../../../runs/extraction/turn-contents.js";

const roots: string[] = [];
const config = {
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1" as const
};
const first = turn("alpha", "first");
const second = turn("beta", "second");
const third = turn("gamma", "third");

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache-key allowlist selection", () => {
  it("selects exactly the receipt-bound full-window keys that are currently missing", () => {
    const cacheRoot = temporaryRoot();
    const writeLease = { assertOwned: vi.fn() };
    const firstKey = cacheKey(first);
    const secondKey = cacheKey(second);

    const keys = [secondKey, firstKey].sort();
    const selected = resolveCacheKeyAllowlistedTurns({
      allowlist: keys,
      cacheRoot,
      prepared: prepared(),
      authority: catalogAuthority(keys),
      writeLease
    });

    expect(selected).toEqual({
      turns: keys.map((key) => key === firstKey ? first : second),
      skippedCacheHits: 0,
      executionCacheKeys: new Set(keys)
    });
    expect(writeLease.assertOwned).toHaveBeenCalledOnce();
  });

  it("bounds a catalog question batch without narrowing its receipt allowlist", () => {
    const cacheRoot = temporaryRoot();
    const writeLease = { assertOwned: vi.fn() };
    const firstKey = cacheKey(first);
    const keys = [firstKey, cacheKey(second)].sort();
    const authority = catalogAuthority(keys);

    const selected = resolveCacheKeyAllowlistedTurns({
      allowlist: keys,
      cacheRoot,
      prepared: prepared({
        questionBatchLimit: 1,
        executionExtractionTurns: [first]
      }),
      authority,
      writeLease
    });
    const emptyBatch = resolveCacheKeyAllowlistedTurns({
      allowlist: keys,
      cacheRoot,
      prepared: prepared({
        questionBatchLimit: 1,
        executionExtractionTurns: []
      }),
      authority,
      writeLease
    });

    expect(selected).toEqual({
      turns: [first],
      skippedCacheHits: 0,
      executionCacheKeys: new Set([firstKey])
    });
    expect(emptyBatch).toEqual({
      turns: [],
      skippedCacheHits: 0,
      executionCacheKeys: new Set()
    });
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: [firstKey],
      cacheRoot,
      prepared: prepared({ questionBatchLimit: 1 }),
      authority,
      writeLease
    })).toThrow(/does not match the catalog refill authority/u);
    expect(writeLease.assertOwned).toHaveBeenCalledTimes(2);
  });
});

describe("extraction cache-key allowlist continuation", () => {
  it("is inert when no programmatic allowlist was supplied", () => {
    expect(resolveCacheKeyAllowlistedTurns({
      allowlist: undefined,
      cacheRoot: temporaryRoot(),
      prepared: prepared(),
      authority: undefined,
      writeLease: { assertOwned: vi.fn() }
    })).toBeUndefined();
  });

  it("derives a sparse continuation scope from settled ledger successes", () => {
    const cacheRoot = temporaryRoot();
    const firstKey = cacheKey(first);
    const secondKey = cacheKey(second);
    writeCachedExtraction(cacheRoot, firstKey, {
      model: config.model,
      request_profile: config.requestProfile,
      cache_key: firstKey,
      raw_json: '{"signals":[]}',
      extracted_at: "2026-08-09T00:00:00.000Z"
    });

    const selected = resolveContinuationMissingTurns({
      cacheRoot,
      prepared: prepared({ pinnedCachedTurns: 1 }),
      authority: continuationAuthority(),
      successfulKeys: [firstKey],
      writeLease: { assertOwned: vi.fn() }
    });

    expect(selected).toEqual({
      turns: [second],
      skippedCacheHits: 1,
      executionCacheKeys: new Set([secondKey])
    });
  });

  it("keeps audited predecessor hits outside the continuation ledger", () => {
    const cacheRoot = temporaryRoot();
    const firstKey = cacheKey(first);
    const secondKey = cacheKey(second);
    writeCachedExtraction(cacheRoot, firstKey, {
      model: config.model,
      request_profile: config.requestProfile,
      cache_key: firstKey,
      raw_json: '{"signals":[]}',
      extracted_at: "2026-08-09T00:00:00.000Z"
    });

    const selected = resolveContinuationMissingTurns({
      cacheRoot,
      prepared: prepared({ pinnedCachedTurns: 1 }),
      authority: continuationAuthority(1),
      successfulKeys: [],
      writeLease: { assertOwned: vi.fn() }
    });

    expect(selected).toEqual({
      turns: [second],
      skippedCacheHits: 1,
      executionCacheKeys: new Set([secondKey])
    });
  });

  it("preserves canonical turn order across a continuation", () => {
    const cacheRoot = temporaryRoot();
    const firstKey = cacheKey(first);
    const secondKey = cacheKey(second);
    const thirdKey = cacheKey(third);
    writeCachedExtraction(cacheRoot, firstKey, {
      model: config.model,
      request_profile: config.requestProfile,
      cache_key: firstKey,
      raw_json: '{"signals":[]}',
      extracted_at: "2026-08-09T00:00:00.000Z"
    });

    const selected = resolveContinuationMissingTurns({
      cacheRoot,
      prepared: prepared({
        pinnedCachedTurns: 1,
        distinctExtractionTurns: [first, second, third],
        executionExtractionTurns: [first, second, third]
      }),
      authority: continuationAuthority(),
      successfulKeys: [firstKey],
      writeLease: { assertOwned: vi.fn() }
    });

    expect(selected).toEqual({
      turns: [second, third],
      skippedCacheHits: 1,
      executionCacheKeys: new Set([secondKey, thirdKey])
    });
  });

  it.each([
    ["without authority", undefined, prepared()],
    ["for a probe", { ...catalogAuthority([cacheKey(first)]), action: "probe" as const }, prepared()],
    ["for repair", {
      ...catalogAuthority([cacheKey(first)]), repair_scope: {} as never
    }, prepared()],
    ["for direct spend", {
      ...catalogAuthority([cacheKey(first)]), direct_spend: {} as never
    }, prepared()],
    ["for expansion", catalogAuthority([cacheKey(first)]), prepared({ expansion: {} })]
  ])("rejects the allowlist %s", (_label, authority, scopedPrepared) => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: [cacheKey(first)],
      cacheRoot: temporaryRoot(),
      prepared: scopedPrepared,
      authority,
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/authority-bound catalog refill/u);
  });
});

describe("extraction cache-key allowlist validation", () => {
  it.each([
    ["empty", []],
    ["uppercase", ["A".repeat(64)]],
    ["short", ["a".repeat(63)]],
    ["duplicate", [cacheKey(first), cacheKey(first)]]
  ])("rejects a %s allowlist", (_label, allowlist) => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist,
      cacheRoot: temporaryRoot(),
      prepared: prepared(),
      authority: catalogAuthority([cacheKey(first)]),
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/non-empty|lowercase SHA-256|duplicate/u);
  });

  it("fails closed when the pinned manifest lacks a validated cached-turn count", () => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: [cacheKey(first)],
      cacheRoot: temporaryRoot(),
      prepared: { ...prepared(), pinnedCachedTurns: undefined },
      authority: catalogAuthority([cacheKey(first)]),
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/pinned manifest cached-turn count/u);
  });
});

describe("extraction cache-key allowlist production window", () => {
  it("rejects stale or orphan routes outside the production full window", () => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: ["f".repeat(64)],
      cacheRoot: temporaryRoot(),
      prepared: prepared(),
      authority: catalogAuthority(["f".repeat(64)]),
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/outside the production full window/u);
  });

  it.each(["hit", "invalid"] as const)(
    "rejects a production key whose current shard status is %s",
    (status) => {
      const cacheRoot = temporaryRoot();
      const key = cacheKey(first);
      writeCachedExtraction(cacheRoot, key, {
        model: config.model,
        request_profile: config.requestProfile,
        cache_key: key,
        raw_json: status === "hit" ? '{"signals":[]}' : "not-json",
        extracted_at: "2026-07-22T00:00:00.000Z"
      });

      expect(() => resolveCacheKeyAllowlistedTurns({
        allowlist: [key],
        cacheRoot,
        prepared: prepared(),
        authority: catalogAuthority([key]),
        writeLease: { assertOwned: vi.fn() }
      })).toThrow(new RegExp(`status is ${status}`, "u"));
    }
  );
});

function catalogAuthority(keys: readonly string[]) {
  return {
    action: "fill" as const,
    catalog_refill: { keys } as never
  };
}

function continuationAuthority(initialPreservedShards = 0) {
  return {
    action: "fill" as const,
    continuation: {
      predecessor: { initial_preserved_shards: initialPreservedShards }
    } as never
  };
}

function prepared(overrides: {
  readonly expansion?: object;
  readonly questionBatchLimit?: number;
  readonly pinnedCachedTurns?: number;
  readonly distinctExtractionTurns?: readonly LongMemEvalExtractionTurn[];
  readonly executionExtractionTurns?: readonly LongMemEvalExtractionTurn[];
} = {}) {
  return {
    config,
    pinnedCachedTurns: 0,
    distinctExtractionTurns: [first, second],
    executionExtractionTurns: [first, second],
    ...overrides
  };
}

function cacheKey(value: LongMemEvalExtractionTurn): string {
  return computeExtractionTurnCacheKey(
    config.model,
    config.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    value
  );
}

function turn(turnContent: string, messageId: string): LongMemEvalExtractionTurn {
  return Object.freeze({
    turnContent,
    turnMessages: Object.freeze([{
      message_id: messageId,
      role: "user" as const,
      content: turnContent
    }])
  });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-cache-key-allowlist-"));
  roots.push(root);
  return root;
}
