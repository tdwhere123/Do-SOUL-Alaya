import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtractionAttemptLimitError,
  readExtractionAttemptLedger,
  openExtractionAttemptLedger
} from "../../../../longmemeval/extraction/authority/attempt-ledger.js";

const key = (digit: string): string => digit.repeat(64);
const cacheIdentity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
let cacheRoot = "";

describe("extraction attempt ledger", () => {
  afterEach(async () => {
    if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
  });

  it("persists cumulative attempts and marks a pre-callback crash as usage-unknown", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "a".repeat(64);
    const initial = openLedger(lineageDigest, 3);
    initial.reserveAttempt(key("1"));

    expect(readLedger(lineageDigest)).toMatchObject({
      attempts: 1,
      telemetry: { unresolvedTransportAttempts: 1, usageUnknownAttempts: 1 }
    });

    const resumed = openLedger(lineageDigest, 3);
    resumed.reserveAttempt(key("1"));
    resumed.recordTransportOutcome(key("1"), {
      retryCount: 1,
      rateLimitRetries: 1,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
    });
    await writeValidShard(key("1"));
    resumed.commitSuccessfulShard(key("1"));

    expect(resumed.snapshot()).toMatchObject({
      attempts: 2,
      successfulShards: 1,
      telemetry: {
        retrySuccesses: 1,
        rateLimitRetries: 1,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        usageUnavailableRequests: 1,
        unresolvedTransportAttempts: 0,
        usageUnknownAttempts: 1
      }
    });
    expect(() => openLedger(lineageDigest, 2)).toThrow(/cannot reset|bound to/u);
  });

  it("enforces both the exact success ceiling and the ten-percent attempt ceiling", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const ledger = openLedger("b".repeat(64), 2);
    await settleAndCommit(ledger, key("1"));
    ledger.commitSuccessfulShard(key("1"));
    await settleAndCommit(ledger, key("2"));

    expect(() => ledger.reserveAttempt(key("3"))).toThrow(ExtractionAttemptLimitError);
    expect(() => ledger.reserveAttempt(key("4"))).toThrow(ExtractionAttemptLimitError);
  });

  it("isolates a probe ledger from the fresh post-probe fill lineage", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const probe = openLedger("c".repeat(64), 1, 1, 1);
    await settleAndCommit(probe, key("3"));
    const fill = openLedger("d".repeat(64), 2);

    expect(readLedger("c".repeat(64))).toMatchObject({ attempts: 1, successfulShards: 1 });
    expect(fill.snapshot()).toMatchObject({ attempts: 0, successfulShards: 0 });
  });

  it("recovers only a valid identity-bound shard after raw write before commit", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "e".repeat(64);
    const cacheKey = key("5");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
    await writeValidShard(cacheKey);

    expect(readLedger(lineageDigest)).toMatchObject({
      attempts: 1,
      successfulShards: 1,
      successfulKeys: [cacheKey],
      pendingKeys: []
    });
  });

  it("does not consume a success slot for corrupt or identity-mismatched pending shards", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "f".repeat(64);
    const corruptKey = key("6");
    const wrongModelKey = key("7");
    const wrongProfileKey = key("8");
    const wrongCacheKey = key("9");
    const ledger = openLedger(lineageDigest, 4);
    ledger.reserveAttempt(corruptKey);
    ledger.recordTransportOutcome(corruptKey, { retryCount: 0, rateLimitRetries: 0 });
    ledger.reserveAttempt(wrongModelKey);
    ledger.recordTransportOutcome(wrongModelKey, { retryCount: 0, rateLimitRetries: 0 });
    ledger.reserveAttempt(wrongProfileKey);
    ledger.recordTransportOutcome(wrongProfileKey, { retryCount: 0, rateLimitRetries: 0 });
    ledger.reserveAttempt(wrongCacheKey);
    ledger.recordTransportOutcome(wrongCacheKey, { retryCount: 0, rateLimitRetries: 0 });
    await writeShard(corruptKey, "{}\n");
    await writeShard(wrongModelKey, JSON.stringify({
      model: "wrong-model",
      request_profile: cacheIdentity.requestProfile,
      cache_key: wrongModelKey,
      raw_json: '{"signals":[]}'
    }));
    await writeShard(wrongProfileKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: "deepseek-v4-nonthinking-v1",
      cache_key: wrongProfileKey,
      raw_json: '{"signals":[]}'
    }));
    await writeShard(wrongCacheKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: cacheIdentity.requestProfile,
      cache_key: key("a"),
      raw_json: '{"signals":[]}'
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
    await settleAndCommit(ledger, cacheKey);
    await writeShard(cacheKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: "deepseek-v4-nonthinking-v1",
      cache_key: cacheKey,
      raw_json: '{"signals":[]}'
    }));

    expect(() => readLedger(lineageDigest)).toThrow(/successful shard closure drifted/u);
  });
});

function openLedger(
  lineageDigest: string,
  startingMissing: number,
  maximumAttempts?: number,
  successfulShardCeiling?: number
) {
  return openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest,
    cacheIdentity,
    startingMissing,
    ...(maximumAttempts === undefined ? {} : { maximumAttempts }),
    ...(successfulShardCeiling === undefined ? {} : { successfulShardCeiling })
  });
}

function readLedger(lineageDigest: string) {
  return readExtractionAttemptLedger({ cacheRoot, lineageDigest, cacheIdentity });
}

async function settleAndCommit(
  ledger: ReturnType<typeof openExtractionAttemptLedger>,
  cacheKey: string
): Promise<void> {
  ledger.reserveAttempt(cacheKey);
  ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
  await writeValidShard(cacheKey);
  ledger.commitSuccessfulShard(cacheKey);
}

async function writeValidShard(cacheKey: string): Promise<void> {
  await writeShard(cacheKey, JSON.stringify({
    model: cacheIdentity.model,
    request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey,
    raw_json: '{"signals":[]}'
  }));
}

async function writeShard(cacheKey: string, value: string): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), value, "utf8");
}
