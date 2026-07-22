import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureForkedExtractionAttemptLedger,
  forkSettledExtractionAttemptLedger,
  ExtractionAttemptLimitError,
  readExtractionAttemptLedger,
  readSettledExtractionAttemptLedger,
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
    resumed.reserveAttempt(key("1"));
    resumed.recordTransportOutcome(key("1"), {
      retryCount: 1,
      rateLimitRetries: 1,
      transportFailures: [failureAttempt(1, "f")],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
    });
    await writeValidShard(key("1"));
    resumed.commitSuccessfulShard(key("1"));

    expect(resumed.snapshot()).toMatchObject({
      attempts: 3,
      successfulShards: 1,
      unresolvedAttempts: [],
      transportFailures: [{
        attemptOrdinal: 2,
        cacheKey: key("1"),
        kind: "http_error",
        phase: "response_status",
        httpStatus: 400,
        fingerprint: key("f")
      }],
      telemetry: {
        retrySuccesses: 1,
        rateLimitRetries: 1,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        usageUnavailableRequests: 2,
        unresolvedTransportAttempts: 0,
        usageUnknownAttempts: 2
      }
    });
    expect(readLedger(lineageDigest)).toMatchObject(resumed.snapshot());
    expect(() => openLedger(lineageDigest, 2)).toThrow(/cannot reset|bound to/u);
  });

  it("rejects a v3 unresolved reservation instead of inventing its ordinal", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "0".repeat(64);
    const cacheKey = key("e");
    const path = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
    await writeFile(path, JSON.stringify({
      schema_version: 3,
      lineage_digest: lineageDigest,
      cache_identity: cacheIdentity,
      starting_missing: 1,
      maximum_attempts: 5,
      successful_shard_ceiling: 1,
      attempts: 1,
      successful_shards: [],
      pending_keys: [cacheKey],
      unresolved_attempts: [cacheKey],
      telemetry: {
        retry_successes: 0,
        rate_limit_retries: 0,
        terminal: {
          failure_max_retries: 0,
          failure_non_retryable_4xx: 0,
          failure_timeout: 0,
          failure_aborted: 0
        },
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        usage_unavailable_requests: 0
      }
    }), "utf8");

    expect(() => openLedger(lineageDigest, 1)).toThrow(/legacy.*unresolved|ordinal/u);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schema_version: 3 });
  });

  it("rejects an interleaved v3 reservation whose global ordinal is ambiguous", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "9".repeat(64);
    const unresolvedKey = key("a");
    const path = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
    await writeFile(path, JSON.stringify({
      schema_version: 3,
      lineage_digest: lineageDigest,
      cache_identity: cacheIdentity,
      starting_missing: 2,
      maximum_attempts: 10,
      successful_shard_ceiling: 2,
      attempts: 2,
      successful_shards: [],
      pending_keys: [unresolvedKey],
      unresolved_attempts: [unresolvedKey],
      telemetry: {
        retry_successes: 0,
        rate_limit_retries: 0,
        terminal: {
          failure_max_retries: 0,
          failure_non_retryable_4xx: 1,
          failure_timeout: 0,
          failure_aborted: 0
        },
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        usage_unavailable_requests: 1
      }
    }), "utf8");

    expect(() => openLedger(lineageDigest, 2)).toThrow(/legacy.*unresolved|ordinal/u);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ schema_version: 3 });
  });

  it("maps relative transport failures onto stable global attempt ordinals", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "1".repeat(64);
    const successfulKey = key("2");
    const terminalKey = key("3");
    const ledger = openLedger(lineageDigest, 4, 4, 2);
    ledger.reserveAttempt(successfulKey);
    ledger.reserveAttempt(successfulKey);
    ledger.recordTransportOutcome(successfulKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: [failureAttempt(1, "a")],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    });
    await writeValidShard(successfulKey);
    ledger.commitSuccessfulShard(successfulKey);

    ledger.reserveAttempt(terminalKey);
    ledger.reserveAttempt(terminalKey);
    ledger.recordTransportOutcome(terminalKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      terminalRetryClassification: "failure_non_retryable_4xx",
      transportFailures: [
        failureAttempt(1, "b"),
        {
          ...failureAttempt(2, "c"),
          message: "must-not-persist",
          url: "https://secret.invalid/path",
          headers: { authorization: "Bearer secret" },
          stack: "private stack"
        }
      ]
    });
    ledger.abandonPendingShard(terminalKey);

    const expected = {
      attempts: 4,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [
        expect.objectContaining({ attemptOrdinal: 1, cacheKey: successfulKey, fingerprint: key("a") }),
        expect.objectContaining({ attemptOrdinal: 3, cacheKey: terminalKey, fingerprint: key("b") }),
        expect.objectContaining({ attemptOrdinal: 4, cacheKey: terminalKey, fingerprint: key("c") })
      ]
    };
    expect(ledger.snapshot()).toMatchObject(expected);
    expect(readLedger(lineageDigest)).toMatchObject(expected);

    const persisted = await readFile(
      join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`),
      "utf8"
    );
    expect(JSON.parse(persisted)).toMatchObject({ schema_version: 4 });
    expect(persisted).not.toMatch(/must-not-persist|secret\.invalid|authorization|private stack/u);
  });

  it("rejects incomplete or out-of-order failure mappings without settling reservations", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const cacheKey = key("4");
    const ledger = openLedger("2".repeat(64), 5, 5, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.reserveAttempt(cacheKey);

    expect(() => ledger.recordTransportOutcome(cacheKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: []
    })).toThrow(/failure.*reservation|reservation.*failure/u);
    expect(() => ledger.recordTransportOutcome(cacheKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: [failureAttempt(2, "d")]
    })).toThrow(/ordered|attempt/u);
    expect(ledger.snapshot()).toMatchObject({
      attempts: 2,
      transportFailures: [],
      unresolvedAttempts: [
        { attemptOrdinal: 1, cacheKey },
        { attemptOrdinal: 2, cacheKey }
      ],
      telemetry: { unresolvedTransportAttempts: 2 }
    });
  });

  it("rejects persisted reservation and failure ordinals beyond cumulative attempts", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const unresolvedLineage = "3".repeat(64);
    const failureLineage = "4".repeat(64);
    const unresolved = openLedger(unresolvedLineage, 1);
    unresolved.reserveAttempt(key("5"));
    const settled = openLedger(failureLineage, 1);
    settled.reserveAttempt(key("6"));
    settled.recordTransportOutcome(key("6"), {
      retryCount: 0,
      rateLimitRetries: 0,
      terminalRetryClassification: "failure_non_retryable_4xx",
      transportFailures: [failureAttempt(1, "7")]
    });
    settled.abandonPendingShard(key("6"));

    await tamperFirstOrdinal(unresolvedLineage, "unresolved_attempts");
    await tamperFirstOrdinal(failureLineage, "transport_failures");

    expect(() => readLedger(unresolvedLineage)).toThrow(/invalid|authority/u);
    expect(() => readLedger(failureLineage)).toThrow(/invalid|authority/u);
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
      transportFailures: [failureAttempt(1, "2")]
    });
    predecessor.abandonPendingShard(key("2"));
    const settled = readSettledExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: predecessorLineage,
      cacheIdentity
    });

    const forked = forkSettledExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage,
      cacheIdentity
    });

    expect(forked).toMatchObject({
      lineageDigest: successorLineage,
      startingMissing: 2,
      maximumAttempts: 10,
      successfulShardCeiling: 2,
      attempts: 2,
      successfulShards: 1,
      successfulKeys: [key("1")]
    });
    expect(forked.transportFailures).toEqual(settled.transportFailures);
    expect(() => forkSettledExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage,
      cacheIdentity
    })).toThrow(/exist|exclusive|link/u);

    const resumed = openLedger(successorLineage, 2);
    await settleAndCommit(resumed, key("3"));
    expect(resumed.snapshot()).toMatchObject({ attempts: 3, successfulShards: 2 });
  });

  it("refuses a predecessor whose raw ledger still has unresolved work", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "7".repeat(64);
    openLedger(lineageDigest, 1).reserveAttempt(key("4"));

    expect(() => readSettledExtractionAttemptLedger({
      cacheRoot,
      lineageDigest,
      cacheIdentity
    })).toThrow(/not durably settled/u);
  });

  it("recovers only the exact pristine orphan fork", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const predecessorLineage = "8".repeat(64);
    const successorLineage = "9".repeat(64);
    const predecessor = openLedger(predecessorLineage, 2);
    await settleAndCommit(predecessor, key("1"));
    const settled = readSettledExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: predecessorLineage,
      cacheIdentity
    });
    const forked = forkSettledExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage,
      cacheIdentity
    });

    expect(ensureForkedExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      predecessorRawLedgerSha256: settled.rawLedgerSha256,
      successorLineageDigest: successorLineage,
      cacheIdentity
    })).toEqual(forked);

    const resumed = openLedger(successorLineage, 2);
    resumed.reserveAttempt(key("2"));
    expect(() => ensureForkedExtractionAttemptLedger({
      cacheRoot,
      predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      predecessorRawLedgerSha256: settled.rawLedgerSha256,
      successorLineageDigest: successorLineage,
      cacheIdentity
    })).toThrow(/not a pristine continuation fork/u);
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

async function tamperFirstOrdinal(
  lineageDigest: string,
  field: "unresolved_attempts" | "transport_failures"
): Promise<void> {
  const path = join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`);
  const record = JSON.parse(await readFile(path, "utf8")) as Record<
    typeof field,
    Array<{ attempt_ordinal: number }>
  >;
  record[field][0]!.attempt_ordinal = 999;
  await writeFile(path, JSON.stringify(record), "utf8");
}

function failureAttempt(attempt: number, fingerprintDigit: string) {
  return {
    kind: "http_error" as const,
    phase: "response_status" as const,
    httpStatus: 400,
    fingerprint: key(fingerprintDigit),
    attempt
  };
}
