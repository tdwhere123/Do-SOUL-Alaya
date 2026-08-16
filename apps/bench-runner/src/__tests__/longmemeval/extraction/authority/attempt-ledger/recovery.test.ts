import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { computeExtractionFillAttemptCeiling } from
  "../../../../../longmemeval/extraction/authority/receipt-limits.js";

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
      lineageDigest: successorLineage, startingMissing: 2,
      maximumAttempts: computeExtractionFillAttemptCeiling(2),
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

  it("expands a legacy fork ceiling while preserving consumed attempts and successes", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const predecessorLineage = "1".repeat(64);
    const successorLineage = "2".repeat(64);
    const predecessor = openLedger(predecessorLineage, 2, 8, 2);
    await settleAndCommit(predecessor, key("3"));
    const settled = readSettledExtractionAttemptLedger({
      cacheRoot, lineageDigest: predecessorLineage, cacheIdentity
    });

    const forked = forkSettledExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage,
      successorMaximumAttempts: computeExtractionFillAttemptCeiling(2),
      cacheIdentity
    });

    expect(forked).toMatchObject({
      maximumAttempts: computeExtractionFillAttemptCeiling(2),
      attempts: 1,
      successfulShards: 1,
      successfulKeys: [key("3")]
    });
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
  it("settles interrupted requests as unknown without fabricating provider failures", async () => {
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
        terminalRetryClassifications: { failure_aborted: 0 }
      }
    });
    expect(recovered.transportFailures).toEqual([]);
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
    maximumAttempts: computeExtractionFillAttemptCeiling(startingMissing),
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
