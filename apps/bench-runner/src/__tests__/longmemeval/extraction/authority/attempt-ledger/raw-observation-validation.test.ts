import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCachedExtraction, writeCachedExtraction } from
  "../../../../../runs/compile-seed/cache/cache-shard.js";
import { readValidLedgerShard } from
  "../../../../../runs/extraction/authority/attempt-ledger-shards.js";
import { openExtractionAttemptLedger } from
  "../../../../../runs/extraction/authority/attempt-ledger.js";
import { providerFixtureKey, providerShardFixture } from "../provider-shard-fixture.js";

describe("attempt ledger raw observation validation", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("separates raw envelope closure from semantic projection parsing", async () => {
    root = await mkdtemp(join(tmpdir(), "alaya-ledger-raw-"));
    const cacheKey = providerFixtureKey("raw-observation");
    const lineageDigest = "b".repeat(64);
    const identity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
    const ledger = openExtractionAttemptLedger({
      cacheRoot: root, lineageDigest, cacheIdentity: identity, startingMissing: 1
    });
    ledger.reserveAttempt(cacheKey);
    const shard = await providerShardFixture({ label: "raw-observation", lineageDigest,
      attemptOrdinal: 1 });
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
      attemptResponses: [shard.provider_responses[0]!.witness] }, 1);
    writeCachedExtraction(root, cacheKey, {
      ...shard, request_profile: identity.requestProfile,
      extracted_at: new Date(0).toISOString()
    });
    ledger.commitSuccessfulShard(cacheKey);

    expect(inspectCachedExtraction(
      root, cacheKey, identity.model, identity.requestProfile
    ).status).toBe("invalid");
    expect(readValidLedgerShard(root, cacheKey, identity))
      .toMatchObject({ cacheKey, rawJsonSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  });
});
