import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFilePath } from "../../../runs/compile-seed/compile-seed-cache.js";
import {
  hashExtractionCacheInventory,
  inspectExtractionCacheInventory,
  type ExtractionCacheInventory
} from "../../../runs/extraction/cache-audit/inventory.js";
import { inspectBoundedMaterializationInventory } from
  "../../../runs/extraction/cache-audit/materialization/preflight-inventory.js";
import type { CachedExtractionEntry } from "../../../runs/compile-seed/cache/cache-shard.js";
import { TEST_CACHED_PROVIDER_COMPLETION_METADATA } from "./extraction-cache-test-fixture.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;
const legacyNonempty = JSON.stringify({ signals: [{ object_kind: "fact", confidence: 0.9,
  matched_text: "I live in Paris." }] });

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache inventory", () => {
  it("accounts for every expected shard and surfaces an orphan without reading a provider", () => {
    const root = cacheRoot();
    const [first, second] = ["a".repeat(64), "b".repeat(64)];
    writeShard(root, first);
    writeShard(root, "c".repeat(64));

    const inventory = inspectExtractionCacheInventory({
      cacheRoot: root,
      cacheKeys: [second, first],
      model,
      requestProfile
    });

    expect(inventory.shards.map((shard) => [shard.cacheKey, shard.status])).toEqual([
      [first, "hit"],
      [second, "missing"]
    ]);
    expect(inventory.orphanKeys).toEqual(["c".repeat(64)]);
    expect(inventory.counts).toEqual({ expected: 2, hit: 1, missing: 1, invalid: 0, orphan: 1 });
  });

  it("has a stable digest regardless of requested-key input order", () => {
    const root = cacheRoot();
    const [first, second] = ["a".repeat(64), "b".repeat(64)];
    writeShard(root, first);
    writeShard(root, second);

    const forward = inspectExtractionCacheInventory({
      cacheRoot: root, cacheKeys: [first, second], model, requestProfile
    });
    const reversed = inspectExtractionCacheInventory({
      cacheRoot: root, cacheKeys: [second, first], model, requestProfile
    });

    expect(hashExtractionCacheInventory(forward)).toBe(hashExtractionCacheInventory(reversed));
  });

  it("separates authority control artifacts from raw shard inventory", () => {
    const root = cacheRoot();
    const digest = "d".repeat(64);
    const controlArtifacts = [
      ".alaya-extraction-target-root.json",
      `continuation-child.${digest}.json`,
      `extraction-attempt-ledger.${digest}.json`
    ];
    for (const name of controlArtifacts) writeFileSync(join(root, name), "{}", "utf8");
    writeFileSync(join(root, "continuation-child.not-a-digest.json"), "{}", "utf8");

    const inventory = inspectExtractionCacheInventory({
      cacheRoot: root, cacheKeys: [], model, requestProfile
    });

    expect(inventory.controlArtifactPaths).toEqual(controlArtifacts.sort());
    expect(inventory.unexpectedPaths).toEqual(["continuation-child.not-a-digest.json"]);
  });

  it("marks legacy salvaged-but-malformed raw JSON invalid for repair", () => {
    const root = cacheRoot();
    const key = "d".repeat(64);
    writeShard(root, key,
      '{"signals":[{"signal_kind":"potential_preference",' +
      '"object_kind":"user_preference","confidence":0.9,' +
      '"matched_text":"tea","distilled_fact":"The user likes tea."},' +
      '{"signal_kind":"potential_preference"}'
    );

    const inventory = inspectExtractionCacheInventory({
      cacheRoot: root, cacheKeys: [key], model, requestProfile
    });

    expect(inventory.counts).toEqual({
      expected: 1, hit: 0, missing: 0, invalid: 1, orphan: 0
    });
    expect(inventory.shards[0]?.reason).toMatch(/strict JSON/u);
  });

  it("rejects cached length truncation while retaining metadata-less legacy shards", () => {
    const root = cacheRoot();
    const truncated = "d".repeat(64);
    const legacy = "e".repeat(64);
    writeShard(root, truncated, legacyNonempty, {
      finish_reason: "length",
      max_output_tokens: 2048
    });
    writeShard(root, legacy);

    const inventory = inspectExtractionCacheInventory({
      cacheRoot: root,
      cacheKeys: [truncated, legacy],
      model,
      requestProfile
    });

    expect(inventory.shards.map((shard) => [shard.cacheKey, shard.status])).toEqual([
      [truncated, "invalid"],
      [legacy, "hit"]
    ]);
    expect(inventory.shards[0]?.reason).toMatch(/finish_reason.*length/u);
    expect(inventory.counts).toEqual({
      expected: 2, hit: 1, missing: 0, invalid: 1, orphan: 0
    });
  });

  it("materialization rejects provider-backed legacy completion metadata", () => {
    const root = cacheRoot();
    const key = "f".repeat(64);
    writeShard(root, key, legacyNonempty, {
      finish_reason: "stop"
    }, true);
    const audited: ExtractionCacheInventory = {
      shards: [{ cacheKey: key, status: "hit" }],
      orphanKeys: [], retiredKeys: [], controlArtifactPaths: [], unexpectedPaths: [],
      counts: { expected: 1, hit: 1, missing: 0, invalid: 0, orphan: 0 }
    };

    const inspected = inspectBoundedMaterializationInventory({
      sourceRoot: root,
      audited,
      model,
      requestProfile,
      maxShardBytes: 1024 * 1024
    });

    expect(inspected.inventory.shards[0]).toMatchObject({
      cacheKey: key,
      status: "invalid",
      reason: expect.stringContaining("lacks versioned completion authority")
    });
    expect(inspected.descriptors).toEqual([]);
  });

  it.each(["deterministic_empty", "completed_empty", "legacy_nonempty"] as const)(
    "preserves the exact audited inventory shape for a qualified %s shard", (kind) => {
      const root = cacheRoot();
      const key = "a".repeat(64);
      const provider = kind === "completed_empty";
      writeShard(root, key, kind === "legacy_nonempty" ? legacyNonempty : '{"signals":[]}',
        provider ? TEST_CACHED_PROVIDER_COMPLETION_METADATA : undefined, provider,
        kind === "legacy_nonempty" ? {} : { empty_classification: kind,
          ...(provider ? { request_completion: { version: 1, status: "completed_empty" } } : {}) });
      const audited = inspectExtractionCacheInventory({ cacheRoot: root, cacheKeys: [key], model, requestProfile });
      const bounded = inspectBoundedMaterializationInventory({ sourceRoot: root, audited,
        model, requestProfile, maxShardBytes: 32_768 });
      expect(audited.counts.hit).toBe(1);
      expect(bounded.inventory).toEqual(audited);
      expect(bounded.descriptors).toHaveLength(1);
      expect(Object.keys(bounded.inventory.shards[0]!).sort()).toEqual([
        "cacheKey", "parsedDraftCount", "rawJsonSha256", "rawSignalCount", "status"
      ]);
    });

  it("rejects a symlinked cache root rather than following it", () => {
    const root = cacheRoot();
    const link = `${root}-link`;
    roots.push(link);
    try {
      symlinkSync(root, link, "dir");
    } catch {
      return;
    }

    expect(() => inspectExtractionCacheInventory({
      cacheRoot: link,
      cacheKeys: [],
      model,
      requestProfile
    })).toThrow(/symlink/u);
  });

  it("does not accept a cache-key filename outside its canonical shard directory", () => {
    const root = cacheRoot();
    const key = "a".repeat(64);
    mkdirSync(join(root, "wrong"), { recursive: true });
    writeFileSync(join(root, "wrong", `${key}.json`), "{}", "utf8");

    const inventory = inspectExtractionCacheInventory({
      cacheRoot: root, cacheKeys: [], model, requestProfile
    });

    expect(inventory.orphanKeys).toEqual([]);
    expect(inventory.unexpectedPaths).toEqual([`wrong/${key}.json`]);
  });
});

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-extraction-cache-inventory-"));
  roots.push(root);
  return root;
}

function writeShard(
  root: string,
  cacheKey: string,
  rawJson = legacyNonempty,
  responseMetadata?: unknown,
  providerBacked = false,
  completion: Pick<CachedExtractionEntry, "empty_classification" | "request_completion"> = {}
): void {
  const path = cacheFilePath(root, cacheKey);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: cacheKey,
    model,
    request_profile: requestProfile,
    raw_json: rawJson,
    ...completion,
    ...(responseMetadata === undefined ? {} : { response_metadata: responseMetadata }),
    ...(providerBacked ? {
      transport_provenance: {
        provider_url_sha256: `sha256:${"a".repeat(64)}`,
        model
      }
    } : {})
  }), "utf8");
}
