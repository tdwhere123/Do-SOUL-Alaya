import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFilePath } from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  hashExtractionCacheInventory,
  inspectExtractionCacheInventory
} from "../../../longmemeval/extraction/cache-audit/inventory.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;

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
    writeShard(root, truncated, JSON.stringify({ signals: [] }), {
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
  rawJson = JSON.stringify({ signals: [] }),
  responseMetadata?: unknown
): void {
  const path = cacheFilePath(root, cacheKey);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: cacheKey,
    model,
    request_profile: requestProfile,
    raw_json: rawJson,
    ...(responseMetadata === undefined ? {} : { response_metadata: responseMetadata })
  }), "utf8");
}
