import { describe, expect, it } from "vitest";
import {
  buildSupplementalSourceReceiptExtension,
  createSupplementalSourceReceipt,
  parseSupplementalSourceReceipt
} from "../../../runs/extraction/cache/supplemental-source-receipt.js";

describe("supplemental source receipt extension", () => {
  it("proves an exact same-source shard-set extension", () => {
    const source = receipt([
      shard("1", "a"),
      shard("2", "b")
    ]);
    const target = receipt([
      shard("1", "a"),
      shard("2", "b"),
      shard("3", "c")
    ], "2026-07-24T01:00:00.000Z");

    const extension = buildSupplementalSourceReceiptExtension(
      source,
      target,
      source.logical_cache_identity
    );

    expect(extension.source_binding.receipt_sha256).toBe(source.receipt_sha256);
    expect(extension.target_binding.receipt_sha256).toBe(target.receipt_sha256);
    expect(extension.source_shards).toHaveLength(2);
    expect(extension.added_shards).toEqual([shard("3", "c")]);
  });

  it("rejects replacement, deletion, duplicate, and source identity drift", () => {
    const source = receipt([shard("1", "a"), shard("2", "b")]);

    expect(() => buildSupplementalSourceReceiptExtension(
      source,
      receipt([shard("1", "d"), shard("2", "b"), shard("3", "c")]),
      source.logical_cache_identity
    )).toThrow(/extend|contain/u);
    expect(() => buildSupplementalSourceReceiptExtension(
      source,
      receipt([shard("1", "a")]),
      source.logical_cache_identity
    )).toThrow(/extend|contain/u);
    expect(() => buildSupplementalSourceReceiptExtension(
      source,
      receipt([shard("1", "a"), shard("2", "b")], undefined, "other-model"),
      source.logical_cache_identity
    )).toThrow(/identity|source/u);
    expect(() => buildSupplementalSourceReceiptExtension(
      source,
      receipt([shard("1", "a"), shard("2", "b"), shard("3", "c")]),
      { ...source.logical_cache_identity, model: "other-logical-model" }
    )).toThrow(/logical cache identity/u);
    expect(() => parseSupplementalSourceReceipt({
      ...source,
      shards: [source.shards[0], source.shards[0]],
      shard_count: 2
    }, "duplicate.json")).toThrow(/invalid|duplicate/u);
  });

  it("rejects receipt self-digest and inventory drift", () => {
    const source = receipt([shard("1", "a"), shard("2", "b")]);

    expect(() => parseSupplementalSourceReceipt({
      ...source,
      receipt_sha256: "f".repeat(64)
    }, "receipt.json")).toThrow(/invalid|digest/u);
    expect(() => parseSupplementalSourceReceipt({
      ...source,
      key_set_sha256: "e".repeat(64)
    }, "receipt.json")).toThrow(/invalid|digest/u);
  });
});

function receipt(
  shards: readonly { readonly cache_key: string; readonly raw_json_sha256: string }[],
  createdAt = "2026-07-24T00:00:00.000Z",
  physicalModel = "deepseek-v4-flash"
) {
  return createSupplementalSourceReceipt({
    createdAt,
    physicalProviderUrl: "https://supplement.example/v1",
    physicalModel,
    logicalProviderUrl: "https://canonical.example/v1",
    logicalModel: "deepseek-v4-flash",
    requestProfile: "deepseek-v4-nonthinking-v1",
    systemPromptSha256: "9".repeat(64),
    shards
  });
}

function shard(key: string, raw: string) {
  return {
    cache_key: key.repeat(64),
    raw_json_sha256: raw.repeat(64)
  };
}
