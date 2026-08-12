import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  openExtractionAttemptLedger,
  readExtractionAttemptLedger
} from "../../../../../longmemeval/extraction/authority/attempt-ledger.js";

const key = (digit: string): string => digit.repeat(64);
const cacheIdentity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
let cacheRoot = "";

describe("extraction attempt ledger validation", () => {
  afterEach(async () => {
    if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
  });

  it("fails closed when the ledger path is a dangling symlink", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "b".repeat(64);
    const ledgerPath = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
    await symlink(join(cacheRoot, "missing-ledger.json"), ledgerPath);

    expect(() => openLedger(lineageDigest, 1)).toThrow();
    await expect(readFile(ledgerPath, "utf8")).rejects.toThrow();
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
    const cacheKey = key("a");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
    await writeValidShard(cacheKey);
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

async function writeValidShard(cacheKey: string): Promise<void> {
  await writeShard(cacheKey, JSON.stringify({
    model: cacheIdentity.model, request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey, raw_json: '{"signals":[]}',
    transport_provenance: {
      provider_url_sha256: `sha256:${key("a")}`, model: cacheIdentity.model
    }
  }));
}

async function writeShard(cacheKey: string, value: string): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), value, "utf8");
}
