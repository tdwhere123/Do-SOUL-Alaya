import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFilePath } from "../../longmemeval/compile-seed-cache.js";
import {
  inspectC0RawShardInventory,
  hashC0RawShardInventory
} from "../../longmemeval/extraction/c0/raw-inventory.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("C0 raw shard inventory", () => {
  it("accounts for every expected shard and surfaces an orphan without reading a provider", () => {
    const root = cacheRoot();
    const [first, second] = ["a".repeat(64), "b".repeat(64)];
    writeShard(root, first);
    writeShard(root, "c".repeat(64));

    const inventory = inspectC0RawShardInventory({
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

    const forward = inspectC0RawShardInventory({ cacheRoot: root, cacheKeys: [first, second], model, requestProfile });
    const reversed = inspectC0RawShardInventory({ cacheRoot: root, cacheKeys: [second, first], model, requestProfile });

    expect(hashC0RawShardInventory(forward)).toBe(hashC0RawShardInventory(reversed));
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

    expect(() => inspectC0RawShardInventory({
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

    const inventory = inspectC0RawShardInventory({
      cacheRoot: root, cacheKeys: [], model, requestProfile
    });

    expect(inventory.orphanKeys).toEqual([]);
    expect(inventory.unexpectedPaths).toEqual([`wrong/${key}.json`]);
  });
});

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-c0-raw-inventory-"));
  roots.push(root);
  return root;
}

function writeShard(root: string, cacheKey: string): void {
  const path = cacheFilePath(root, cacheKey);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({
    cache_key: cacheKey,
    model,
    request_profile: requestProfile,
    raw_json: JSON.stringify({ signals: [] })
  }), "utf8");
}
