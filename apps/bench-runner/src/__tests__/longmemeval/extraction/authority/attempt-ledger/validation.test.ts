import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openExtractionAttemptLedger,
  readExtractionAttemptLedger
} from "../../../../../runs/extraction/authority/attempt-ledger.js";
import { providerFixtureKey, providerShardFixture } from "../provider-shard-fixture.js";

const key = (digit: string): string => digit.repeat(64);
const cacheIdentity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
let cacheRoot = "";

describe("extraction attempt ledger validation", () => {
  afterEach(async () => {
    if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
  });

  it("refuses a ledger symlink even when its target contains a valid ledger", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "b".repeat(64);
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
    openLedger(lineageDigest, 1);
    const original = await readFile(ledgerPath, "utf8");
    await mkdir(join(cacheRoot, "elsewhere"));
    const target = join(cacheRoot, "elsewhere", "external-ledger.json");
    await rename(ledgerPath, target);
    await symlink(target, ledgerPath);

    // Inventory refuses non-regular entries before attempting the bounded reader.
    expect(() => openLedger(lineageDigest, 1)).toThrow(/inventory exceeds retained input limit/u);
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("rejects a provider success shard without physical transport provenance", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "d".repeat(64);
    const cacheKey = key("4");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
    await writeShard(cacheKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: cacheIdentity.requestProfile,
      cache_key: cacheKey,
      raw_json: '{"signals":[]}'
    }));

    expect(() => ledger.commitSuccessfulShard(cacheKey)).toThrow(/identity validation/u);
  });

  it("does not consume a success slot for corrupt or identity-mismatched pending shards", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "f".repeat(64);
    const corruptKey = key("6");
    const wrongModelKey = key("7");
    const wrongProfileKey = key("8");
    const wrongCacheKey = key("9");
    const ledger = openLedger(lineageDigest, 4);
    for (const cacheKey of [corruptKey, wrongModelKey, wrongProfileKey, wrongCacheKey]) {
      ledger.reserveAttempt(cacheKey);
      ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
    }
    await writeShard(corruptKey, "{}\n");
    await writeShard(wrongModelKey, JSON.stringify({
      model: "wrong-model", request_profile: cacheIdentity.requestProfile,
      cache_key: wrongModelKey, raw_json: '{"signals":[]}'
    }));
    await writeShard(wrongProfileKey, JSON.stringify({
      model: cacheIdentity.model, request_profile: "deepseek-v4-nonthinking-v1",
      cache_key: wrongProfileKey, raw_json: '{"signals":[]}'
    }));
    await writeShard(wrongCacheKey, JSON.stringify({
      model: cacheIdentity.model, request_profile: cacheIdentity.requestProfile,
      cache_key: key("a"), raw_json: '{"signals":[]}'
    }));

    expect(readLedger(lineageDigest)).toMatchObject({
      successfulShards: 0,
      pendingKeys: [corruptKey, wrongModelKey, wrongProfileKey, wrongCacheKey]
    });
  });

  it("fails closed when a recorded success no longer satisfies cache identity", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "b".repeat(64);
    const cacheKey = providerFixtureKey("validation");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    const shard = await providerShardFixture({ label: "validation", lineageDigest,
      attemptOrdinal: 1 });
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
      attemptResponses: [shard.provider_responses[0]!.witness] }, 1);
    await writeShard(cacheKey, JSON.stringify(shard));
    ledger.commitSuccessfulShard(cacheKey);
    await writeShard(cacheKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: "deepseek-v4-nonthinking-v1",
      cache_key: cacheKey,
      raw_json: '{"signals":[]}'
    }));

    expect(() => readLedger(lineageDigest)).toThrow(/successful shard closure drifted/u);
  });
});

function openLedger(lineageDigest: string, startingMissing: number) {
  return openExtractionAttemptLedger({ cacheRoot, lineageDigest, cacheIdentity, startingMissing });
}

function readLedger(lineageDigest: string) {
  return readExtractionAttemptLedger({ cacheRoot, lineageDigest, cacheIdentity });
}

async function writeShard(cacheKey: string, value: string): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), value, "utf8");
}
