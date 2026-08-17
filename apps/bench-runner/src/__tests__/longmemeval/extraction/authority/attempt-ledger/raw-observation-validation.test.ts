import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCachedExtraction, writeCachedExtraction } from
  "../../../../../bench/compile-seed/cache/cache-shard.js";
import { readValidLedgerShard } from
  "../../../../../bench/extraction/authority/attempt-ledger-shards.js";
import { buildExtractionTransportProvenance } from
  "../../../../../bench/extraction/transport-route.js";

describe("attempt ledger raw observation validation", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("separates raw envelope closure from semantic projection parsing", async () => {
    root = await mkdtemp(join(tmpdir(), "alaya-ledger-raw-"));
    const cacheKey = "a".repeat(64);
    writeCachedExtraction(root, cacheKey, {
      model: "model",
      request_profile: "deepseek-v4-nonthinking-v1",
      cache_key: cacheKey,
      raw_json: JSON.stringify({ signals: [{
        signal_kind: "potential_possession",
        object_kind: "physical_item",
        confidence: 2,
        matched_text: "I own Atlas."
      }] }),
      extracted_at: new Date(0).toISOString(),
      transport_provenance: buildExtractionTransportProvenance({
        providerUrl: "https://example.test/v1", model: "model"
      })
    });

    expect(inspectCachedExtraction(
      root, cacheKey, "model", "deepseek-v4-nonthinking-v1"
    ).status).toBe("invalid");
    expect(readValidLedgerShard(root, cacheKey, {
      model: "model",
      requestProfile: "deepseek-v4-nonthinking-v1"
    })).toMatchObject({ cacheKey, rawJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});
