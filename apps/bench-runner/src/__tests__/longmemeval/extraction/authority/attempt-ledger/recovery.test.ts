import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureForkedExtractionAttemptLedger,
  forkSettledExtractionAttemptLedger,
  openExtractionAttemptLedger,
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from "../../../../../longmemeval/extraction/authority/attempt-ledger.js";
import { recoverInterruptedExtractionAttemptLedger } from
  "../../../../../longmemeval/extraction/authority/attempt-ledger/interruption-recovery.js";
import { recoverInterruptedExtractionFillManifest } from
  "../../../../../longmemeval/extraction/authority/attempt-ledger/interruption-manifest-recovery.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../../../../longmemeval/extraction/content-closure.js";

const key = (digit: string): string => digit.repeat(64);
const cacheIdentity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
let cacheRoot = "";

afterEach(async () => {
  vi.useRealTimers();
  if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
});

describe("extraction attempt ledger lineage isolation", () => {
  it("isolates a probe ledger from the fresh post-probe fill lineage", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const probe = openLedger("c".repeat(64), 1, 1, 1);
    await settleAndCommit(probe, key("3"));
    const fill = openLedger("d".repeat(64), 2);

    expect(readLedger("c".repeat(64))).toMatchObject({ attempts: 1, successfulShards: 1 });
    expect(fill.snapshot()).toMatchObject({ attempts: 0, successfulShards: 0 });
  });

  it("forks a durably settled predecessor without resetting spend or successes", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const predecessorLineage = "5".repeat(64);
    const successorLineage = "6".repeat(64);
    const predecessor = openLedger(predecessorLineage, 2);
    await settleAndCommit(predecessor, key("1"));
    predecessor.reserveAttempt(key("2"));
    predecessor.recordTransportOutcome(key("2"), {
      retryCount: 0,
      rateLimitRetries: 0,
      terminalRetryClassification: "failure_non_retryable_4xx",
      transportFailures: [{
        kind: "http_error", phase: "response_status", httpStatus: 400,
        fingerprint: key("2"), attempt: 1
      }]
    });
    predecessor.abandonPendingShard(key("2"));
    const settled = readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest: predecessorLineage, cacheIdentity
    });

    const forked = forkSettledExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    });

    expect(forked).toMatchObject({
      lineageDigest: successorLineage, startingMissing: 2, maximumAttempts: 10,
      successfulShardCeiling: 2, attempts: 2, successfulShards: 1,
      successfulKeys: [key("1")]
    });
    expect(forked.transportFailures).toEqual(settled.transportFailures);
    expect(() => forkSettledExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    })).toThrow(/exist|exclusive|link/u);

    const resumed = openLedger(successorLineage, 2);
    await settleAndCommit(resumed, key("3"));
    expect(resumed.snapshot()).toMatchObject({ attempts: 3, successfulShards: 2 });
  });
});

describe("extraction attempt ledger fork recovery", () => {
  it("refuses a predecessor whose raw ledger still has unresolved work", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "7".repeat(64);
    openLedger(lineageDigest, 1).reserveAttempt(key("4"));

    expect(() => readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest, cacheIdentity
    })).toThrow(/not durably settled/u);
  });

  it("recovers only the exact pristine orphan fork", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const predecessorLineage = "8".repeat(64);
    const successorLineage = "9".repeat(64);
    const predecessor = openLedger(predecessorLineage, 2);
    await settleAndCommit(predecessor, key("1"));
    const settled = readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest: predecessorLineage, cacheIdentity
    });
    const forked = forkSettledExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    });

    expect(ensureForkedExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      predecessorRawLedgerSha256: settled.rawLedgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    })).toEqual(forked);

    openLedger(successorLineage, 2).reserveAttempt(key("2"));
    expect(() => ensureForkedExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      predecessorRawLedgerSha256: settled.rawLedgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    })).toThrow(/not a pristine continuation fork/u);
  });
});

describe("interrupted extraction attempt recovery", () => {
  it("settles missing in-flight requests as aborted with unknown usage", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "a".repeat(64);
    const cacheKey = key("4");
    const ledger = openLedger(lineageDigest, 2);
    ledger.reserveAttempt(cacheKey);
    ledger.reserveAttempt(cacheKey);

    const recovered = recoverInterrupted(lineageDigest);

    expect(recovered).toMatchObject({
      attempts: 2,
      successfulShards: 0,
      pendingKeys: [],
      unresolvedAttempts: [],
      telemetry: {
        usageUnavailableRequests: 2,
        usageUnknownAttempts: 2,
        terminalRetryClassifications: { failure_aborted: 1 }
      }
    });
    expect(recovered.transportFailures).toEqual([
      expect.objectContaining({ attemptOrdinal: 1, cacheKey, kind: "aborted" }),
      expect.objectContaining({ attemptOrdinal: 2, cacheKey, kind: "aborted" })
    ]);
    expect(recoverInterrupted(lineageDigest)).toEqual(recovered);
    expect(readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest, cacheIdentity
    })).toEqual(recovered);
  });

  it("recovers a written shard and marks only its unresolved usage unknown", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "b".repeat(64);
    const cacheKey = key("5");
    openLedger(lineageDigest, 1).reserveAttempt(cacheKey);
    await writeProviderShard(cacheKey);

    const recovered = recoverInterrupted(lineageDigest, 1);

    expect(recovered).toMatchObject({
      attempts: 1,
      successfulShards: 1,
      successfulKeys: [cacheKey],
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [],
      telemetry: {
        usageUnavailableRequests: 1,
        usageUnknownAttempts: 1,
        terminalRetryClassifications: { failure_aborted: 0 }
      }
    });
  });

  it("fails closed without creating a missing predecessor ledger", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "c".repeat(64);

    expect(() => recoverInterrupted(lineageDigest)).toThrow(/existing attempt ledger/u);
    expect(readLedger(lineageDigest)).toBeUndefined();
  });

  it("re-enters after outcome persistence precedes pending abandonment", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "d".repeat(64);
    const cacheKey = key("6");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.recordTransportOutcome(cacheKey, {
      retryCount: 0,
      rateLimitRetries: 0,
      terminalRetryClassification: "failure_aborted",
      transportFailures: [{
        attempt: 1,
        kind: "aborted",
        phase: "request",
        httpStatus: null,
        fingerprint: key("d")
      }]
    });
    expect(ledger.snapshot()).toMatchObject({
      pendingKeys: [cacheKey],
      unresolvedAttempts: []
    });

    const recovered = recoverInterrupted(lineageDigest, 1);

    expect(recovered).toMatchObject({
      attempts: 1,
      successfulShards: 0,
      pendingKeys: [],
      unresolvedAttempts: [],
      telemetry: {
        usageUnavailableRequests: 1,
        usageUnknownAttempts: 1,
        terminalRetryClassifications: { failure_aborted: 1 }
      }
    });
    expect(recoverInterrupted(lineageDigest, 1)).toEqual(recovered);
  });
});

describe("interrupted extraction manifest recovery", () => {
  it("repins an in-progress manifest to the settled ledger inventory", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-manifest-recovery-"));
    const lineageDigest = "e".repeat(64);
    const ledger = openLedger(lineageDigest, 2);
    await settleAndCommit(ledger, key("1"));
    writeInProgressManifest(0);

    const recovered = recoverManifest(lineageDigest, "2026-08-15T12:30:00.000Z");

    expect(recovered).toMatchObject({
      fill_status: "in_progress",
      requested_turns: 2,
      cached_turns: 1,
      coverage: 0.5,
      built_at: "2026-08-15T12:30:00.000Z"
    });
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(recovered);
  });

  it("keeps the manifest artifact stable after recovery is already closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:30:00.000Z"));
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-manifest-recovery-"));
    const lineageDigest = "a".repeat(64);
    const ledger = openLedger(lineageDigest, 2);
    await settleAndCommit(ledger, key("1"));
    writeInProgressManifest(0);

    recoverManifest(lineageDigest);
    const firstSha256 = await manifestSha256();
    const firstManifest = readExtractionCacheManifest(cacheRoot);
    vi.setSystemTime(new Date("2026-08-15T12:31:00.000Z"));
    recoverManifest(lineageDigest);

    expect(await manifestSha256()).toBe(firstSha256);
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(firstManifest);
  });

  it("rejects a shard that is not closed by the settled ledger", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-manifest-recovery-"));
    const lineageDigest = "f".repeat(64);
    const ledger = openLedger(lineageDigest, 2);
    await settleAndCommit(ledger, key("1"));
    await writeProviderShard(key("2"));
    writeInProgressManifest(0);

    expect(() => recoverManifest(lineageDigest)).toThrow(/ledger inventory/u);
    expect(readExtractionCacheManifest(cacheRoot)?.cached_turns).toBe(0);
  });
});

function openLedger(
  lineageDigest: string, startingMissing: number,
  maximumAttempts?: number, successfulShardCeiling?: number
) {
  return openExtractionAttemptLedger({
    cacheRoot, lineageDigest, cacheIdentity, startingMissing,
    ...(maximumAttempts === undefined ? {} : { maximumAttempts }),
    ...(successfulShardCeiling === undefined ? {} : { successfulShardCeiling })
  });
}

function readLedger(lineageDigest: string) {
  return readExtractionAttemptLedger({ cacheRoot, lineageDigest, cacheIdentity });
}

async function settleAndCommit(
  ledger: ReturnType<typeof openExtractionAttemptLedger>, cacheKey: string
): Promise<void> {
  ledger.reserveAttempt(cacheKey);
  ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), JSON.stringify({
    model: cacheIdentity.model, request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey, raw_json: '{"signals":[]}',
    transport_provenance: {
      provider_url_sha256: `sha256:${key("a")}`, model: cacheIdentity.model
    }
  }), "utf8");
  ledger.commitSuccessfulShard(cacheKey);
}

function recoverInterrupted(lineageDigest: string, startingMissing = 2) {
  return recoverInterruptedExtractionAttemptLedger({
    cacheRoot,
    lineageDigest,
    cacheIdentity,
    startingMissing,
    maximumAttempts: startingMissing * 5,
    successfulShardCeiling: startingMissing
  });
}

async function writeProviderShard(cacheKey: string): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), JSON.stringify({
    model: cacheIdentity.model,
    request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey,
    raw_json: '{"signals":[]}',
    transport_provenance: {
      provider_url_sha256: `sha256:${key("a")}`,
      model: cacheIdentity.model
    }
  }), "utf8");
}

function recoverManifest(lineageDigest: string, builtAt?: string) {
  return recoverInterruptedExtractionFillManifest({
    cacheRoot,
    ledger: readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest, cacheIdentity
    }),
    expected: {
      model: cacheIdentity.model,
      modelFamily: cacheIdentity.model,
      requestProfile: cacheIdentity.requestProfile,
      providerUrl: "https://example.test/v1",
      systemPromptSha256: key("c"),
      cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO,
      datasetVariant: "longmemeval_s",
      datasetRevisionSha256: key("d"),
      windowOffset: 0,
      windowLimit: 2,
      expectedTurns: 2,
      expectedKeySetSha256: computeExtractionKeySetSha256([key("1"), key("2")])
    },
    ...(builtAt === undefined ? {} : { builtAt })
  });
}

async function manifestSha256(): Promise<string> {
  const raw = await readFile(join(cacheRoot, "manifest.json"));
  return createHash("sha256").update(raw).digest("hex");
}

function writeInProgressManifest(cachedTurns: number): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: 3,
    extraction_model: cacheIdentity.model,
    model_family: cacheIdentity.model,
    request_profile: cacheIdentity.requestProfile,
    provider_url: "https://example.test/v1",
    system_prompt_sha256: key("c"),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: key("d"),
    requested_turns: 2,
    cached_turns: cachedTurns,
    coverage: cachedTurns / 2,
    fill_status: "in_progress",
    window_offset: 0,
    window_limit: 2,
    expected_turns: 2,
    expected_key_set_sha256: computeExtractionKeySetSha256([key("1"), key("2")]),
    storage: "git-tracked",
    built_at: "2026-08-15T12:00:00.000Z",
    builder: "extraction-fill"
  });
}
