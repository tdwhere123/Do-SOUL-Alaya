import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeExtractionTurnCacheKey
} from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { writeCachedExtraction } from
  "../../../longmemeval/compile-seed/cache/cache-shard.js";
import { resolveCacheKeyAllowlistedTurns } from
  "../../../longmemeval/extraction/fill/policy/cache-key-allowlist.js";
import type { LongMemEvalExtractionTurn } from
  "../../../longmemeval/extraction/turn-contents.js";

const roots: string[] = [];
const config = {
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1" as const
};
const first = turn("alpha", "first");
const second = turn("beta", "second");

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache-key allowlist", () => {
  it("selects exactly the ordered full-window keys that are currently missing", () => {
    const cacheRoot = temporaryRoot();
    const writeLease = { assertOwned: vi.fn() };
    const firstKey = cacheKey(first);
    const secondKey = cacheKey(second);

    const selected = resolveCacheKeyAllowlistedTurns({
      allowlist: [secondKey, firstKey],
      cacheRoot,
      prepared: prepared(),
      authority: { action: "fill" },
      writeLease
    });

    expect(selected).toEqual({ turns: [second, first], skippedCacheHits: 0 });
    expect(writeLease.assertOwned).toHaveBeenCalledOnce();
  });

  it("is inert when no programmatic allowlist was supplied", () => {
    expect(resolveCacheKeyAllowlistedTurns({
      allowlist: undefined,
      cacheRoot: temporaryRoot(),
      prepared: prepared(),
      authority: undefined,
      writeLease: { assertOwned: vi.fn() }
    })).toBeUndefined();
  });

  it.each([
    ["without authority", undefined, prepared()],
    ["for a probe", { action: "probe" as const }, prepared()],
    ["for repair", { action: "fill" as const, repair_scope: {} as never }, prepared()],
    ["for direct spend", { action: "fill" as const, direct_spend: {} as never }, prepared()],
    ["for expansion", { action: "fill" as const }, prepared({ expansion: {} })],
    ["for a question batch", { action: "fill" as const }, prepared({ questionBatchLimit: 1 })]
  ])("rejects the allowlist %s", (_label, authority, scopedPrepared) => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: [cacheKey(first)],
      cacheRoot: temporaryRoot(),
      prepared: scopedPrepared,
      authority,
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/authority-bound normal fill/u);
  });

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
      authority: { action: "fill" },
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/non-empty|lowercase SHA-256|duplicate/u);
  });

  it("fails closed when the pinned manifest lacks a validated cached-turn count", () => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: [cacheKey(first)],
      cacheRoot: temporaryRoot(),
      prepared: { ...prepared(), pinnedCachedTurns: undefined },
      authority: { action: "fill" },
      writeLease: { assertOwned: vi.fn() }
    })).toThrow(/pinned manifest cached-turn count/u);
  });

  it("rejects stale or orphan routes outside the production full window", () => {
    expect(() => resolveCacheKeyAllowlistedTurns({
      allowlist: ["f".repeat(64)],
      cacheRoot: temporaryRoot(),
      prepared: prepared(),
      authority: { action: "fill" },
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
        authority: { action: "fill" },
        writeLease: { assertOwned: vi.fn() }
      })).toThrow(new RegExp(`status is ${status}`, "u"));
    }
  );
});

function prepared(overrides: {
  readonly expansion?: object;
  readonly questionBatchLimit?: number;
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
