// @ts-nocheck
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExtractionAttemptLimitError,
  readExtractionAttemptLedger,
  openExtractionAttemptLedger
} from "../../../../runs/extraction/authority/attempt-ledger.js";
import { inspectCachedRawExtraction } from
  "../../../../runs/compile-seed/cache/cache-shard.js";
import { providerFixtureKey, providerPartitionShardFixture,
  providerShardFixture } from "./provider-shard-fixture.js";

const key = providerFixtureKey;
const cacheIdentity = { model: "gpt-5.4-mini", requestProfile: "provider-default-v1" } as const;
let cacheRoot = "";

afterEach(async () => {
  if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
});

describe("extraction attempt ledger persistence", () => {
  it("refuses staged ordinary bytes until transport mode and physical response survive reopen", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "c".repeat(64);
    const cacheKey = key("8");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    const shard = await providerShardFixture({ label: "8", lineageDigest, attemptOrdinal: 1 });
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
      attemptResponses: [shard.provider_responses[0].witness] }, 1);
    await writeShard(cacheKey, JSON.stringify({ ...shard,
      provider_attempt: { ...shard.provider_attempt, kind: undefined } }));
    expect(() => ledger.commitSuccessfulShard(cacheKey)).toThrow(/identity validation/u);
    expect(readLedger(lineageDigest)).toMatchObject({ successfulShards: 0,
      pendingKeys: [cacheKey] });
    await writeShard(cacheKey, JSON.stringify({ ...shard,
      provider_responses: [{ ...shard.provider_responses[0],
        witness: { ...shard.provider_responses[0].witness, httpResponse: undefined } }] }));
    expect(() => ledger.commitSuccessfulShard(cacheKey)).toThrow(/identity validation/u);
    expect(readLedger(lineageDigest)).toMatchObject({ successfulShards: 0,
      pendingKeys: [cacheKey] });
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey,
      cacheIdentity.model, cacheIdentity.requestProfile).status).toBe("quarantined");
    await writeShard(cacheKey, JSON.stringify(shard));
    expect(readLedger(lineageDigest)).toMatchObject({ successfulShards: 1,
      successfulKeys: [cacheKey], pendingKeys: [] });
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey,
      cacheIdentity.model, cacheIdentity.requestProfile).status).toBe("pending");
    expect(openLedger(lineageDigest, 1).snapshot()).toMatchObject({ successfulShards: 1,
      successfulKeys: [cacheKey], pendingKeys: [] });
    expect(inspectCachedRawExtraction(cacheRoot, cacheKey,
      cacheIdentity.model, cacheIdentity.requestProfile).status).toBe("hit");
  });

  it("keeps an older unknown reservation when a later physical response settles", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "b".repeat(64);
    const cacheKey = key("9");
    openLedger(lineageDigest, 2).reserveAttempt(cacheKey);
    const resumed = openLedger(lineageDigest, 2);
    resumed.reserveAttempt(cacheKey);
    const shard = await writeValidShard(cacheKey, lineageDigest, 2,
      { inputTokens: 5, outputTokens: 2, totalTokens: 7 });
    resumed.recordTransportOutcome(cacheKey, {
      retryCount: 0, rateLimitRetries: 0,
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      attemptUsages: [{ inputTokens: 5, outputTokens: 2, totalTokens: 7 }],
      attemptResponses: [shard.provider_responses[0].witness]
    }, 2);

    expect(readLedger(lineageDigest)).toMatchObject({
      attempts: 2, successfulShards: 0,
      unresolvedAttempts: [{ attemptOrdinal: 1, cacheKey }],
      settledAttempts: [expect.objectContaining({ attemptOrdinal: 2 })],
      telemetry: { unresolvedTransportAttempts: 1, usageUnknownAttempts: 1 }
    });
    expect(() => resumed.commitSuccessfulShard(cacheKey)).toThrow(/settled provider attempt/u);
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
    const successful = await writeValidShard(key("1"), lineageDigest, 3,
      { inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    resumed.recordTransportOutcome(key("1"), {
      retryCount: 1,
      rateLimitRetries: 1,
      unknownRequestCount: 1,
      transportFailures: [failureAttempt(2, "f")],
      attemptUsages: [undefined, null, { inputTokens: 10, outputTokens: 4, totalTokens: 14 }],
      attemptResponses: [null, null, successful.provider_responses[0].witness],
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }
    });
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
});

describe("extraction attempt ledger legacy validation", () => {
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
});

describe("extraction attempt ledger response-class telemetry", () => {
  it("round-trips failure_non_retryable_response without relabeling max retries", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "7".repeat(64);
    const cacheKey = key("c");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.recordTransportOutcome(cacheKey, {
      retryCount: 0,
      rateLimitRetries: 0,
      terminalRetryClassification: "failure_non_retryable_response",
      transportFailures: [{
        kind: "response_parse_error",
        phase: "response_parse",
        httpStatus: null,
        fingerprint: key("c"),
        attempt: 1
      }]
    });
    ledger.abandonPendingShard(cacheKey);

    expect(readLedger(lineageDigest).telemetry.terminalRetryClassifications).toMatchObject({
      failure_non_retryable_response: 1,
      failure_max_retries: 0
    });
    const persisted = JSON.parse(await readFile(
      join(cacheRoot, `extraction-attempt-ledger.${lineageDigest}.json`),
      "utf8"
    )) as { telemetry: { terminal: Record<string, number> } };
    expect(Object.keys(persisted.telemetry.terminal)).toEqual([
      "failure_max_retries",
      "failure_non_retryable_4xx",
      "failure_timeout",
      "failure_aborted",
      "failure_non_retryable_response"
    ]);
    expect(persisted.telemetry.terminal.failure_non_retryable_response).toBe(1);
    expect(persisted.telemetry.terminal.failure_max_retries).toBe(0);
  });
});

describe("extraction attempt ledger transport mapping", () => {
  it("maps relative transport failures onto stable global attempt ordinals", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "1".repeat(64);
    const successfulKey = key("2");
    const terminalKey = key("3");
    const ledger = openLedger(lineageDigest, 4, 4, 2);
    ledger.reserveAttempt(successfulKey);
    ledger.reserveAttempt(successfulKey);
    const successful = await writeValidShard(successfulKey, lineageDigest, 2,
      { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    ledger.recordTransportOutcome(successfulKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: [failureAttempt(1, "a")],
      attemptUsages: [null, { inputTokens: 10, outputTokens: 2, totalTokens: 12 }],
      attemptResponses: [null, successful.provider_responses[0].witness],
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 }
    });
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
    expect(JSON.parse(persisted)).toMatchObject({ schema_version: 5 });
    expect(persisted).not.toMatch(/must-not-persist|secret\.invalid|authorization|private stack/u);
  });

  it("settles multiple successful partition requests into one durable shard", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "8".repeat(64);
    const cacheKey = key("7");
    const ledger = openLedger(lineageDigest, 4, 4, 1);
    for (let index = 0; index < 4; index += 1) ledger.reserveAttempt(cacheKey);
    const shard = await providerPartitionShardFixture({ lineageDigest,
      attemptOrdinals: [2, 4], usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } });
    await writeShard(cacheKey, JSON.stringify(shard));

    ledger.recordTransportOutcome(cacheKey, {
      retryCount: 2,
      rateLimitRetries: 0,
      successfulRequestCount: 2,
      usageRequestCount: 2,
      attemptUsages: [null, { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
        null, { inputTokens: 20, outputTokens: 6, totalTokens: 26 }],
      attemptResponses: [null, shard.provider_responses[0].witness,
        null, shard.provider_responses[1].witness],
      transportFailures: [failureAttempt(1, "d"), failureAttempt(3, "e")],
      usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 }
    });
    ledger.commitSuccessfulShard(cacheKey);

    expect(ledger.snapshot()).toMatchObject({
      attempts: 4,
      successfulShards: 1,
      pendingKeys: [],
      unresolvedAttempts: [],
      transportFailures: [
        expect.objectContaining({ attemptOrdinal: 1, cacheKey, fingerprint: key("d") }),
        expect.objectContaining({ attemptOrdinal: 3, cacheKey, fingerprint: key("e") })
      ],
      telemetry: {
        retrySuccesses: 1,
        inputTokens: 40,
        outputTokens: 12,
        totalTokens: 52,
        usageUnavailableRequests: 2
      }
    });
  });
});

describe("extraction attempt ledger transport validation", () => {
  it("rejects incomplete or out-of-order failure mappings without settling reservations", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const cacheKey = key("4");
    const ledger = openLedger("2".repeat(64), 5, 5, 1);
    ledger.reserveAttempt(cacheKey);
    ledger.reserveAttempt(cacheKey);

    expect(() => ledger.recordTransportOutcome(cacheKey, {
      retryCount: 1, rateLimitRetries: 0,
      transportFailures: [failureAttempt(1, "d")],
      attemptUsages: [null, { inputTokens: 3, outputTokens: 1, totalTokens: 4 }],
      usage: { inputTokens: 99, outputTokens: 1, totalTokens: 100 }
    })).toThrow(/telemetry is invalid/u);
    expect(() => ledger.recordTransportOutcome(cacheKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: []
    })).toThrow(/failure.*reservation|reservation.*failure/u);
    expect(() => ledger.recordTransportOutcome(cacheKey, {
      retryCount: 1,
      rateLimitRetries: 0,
      transportFailures: [failureAttempt(3, "d")]
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
});

describe("extraction attempt ledger shard limits", () => {
  it("exhausts the global attempt ceiling while successful shard slots remain", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineage = "9".repeat(64);
    const ledger = openLedger(lineage, 2, 3);
    for (const digit of ["1", "2", "3"]) {
      const cacheKey = key(digit);
      ledger.reserveAttempt(cacheKey);
      ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
        terminalRetryClassification: "failure_non_retryable_response",
        transportFailures: [{ kind: "response_parse_error", phase: "response_parse",
          httpStatus: null, fingerprint: digit.repeat(64), attempt: 1 }] });
      ledger.abandonPendingShard(cacheKey);
    }
    expect(readLedger(lineage)).toMatchObject({ attempts: 3, successfulShards: 0 });
    expect(() => ledger.reserveAttempt(key("4"))).toThrow(/attempt.*ceiling|attempt.*limit/iu);
    expect(readLedger(lineage)).toMatchObject({ attempts: 3, successfulShards: 0 });
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

  it("records a canonical deterministic shard without spending a provider attempt", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "d".repeat(64);
    const cacheKey = key("0");
    const ledger = openLedger(lineageDigest, 1);
    await writeDeterministicShard(cacheKey);

    ledger.commitDeterministicShard(cacheKey);

    expect(readLedger(lineageDigest)).toMatchObject({
      attempts: 0,
      successfulShards: 1,
      successfulKeys: [cacheKey]
    });
  });

  it("refuses to adopt provider output as a deterministic shard", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const ledger = openLedger("0".repeat(64), 1);
    const cacheKey = key("1");
    await writeShard(cacheKey, JSON.stringify({
      model: cacheIdentity.model,
      request_profile: cacheIdentity.requestProfile,
      cache_key: cacheKey,
      raw_json: '{"signals":[{}]}'
    }));

    expect(() => ledger.commitDeterministicShard(cacheKey)).toThrow(/canonical empty/u);
    expect(ledger.snapshot()).toMatchObject({ attempts: 0, successfulShards: 0 });
  });

  it("recovers only a valid identity-bound shard after raw write before commit", async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "extraction-attempt-ledger-"));
    const lineageDigest = "e".repeat(64);
    const cacheKey = key("5");
    const ledger = openLedger(lineageDigest, 1);
    ledger.reserveAttempt(cacheKey);
    const shard = await writeValidShard(cacheKey, lineageDigest, 1);
    ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
      attemptResponses: [shard.provider_responses[0].witness] }, 1);

    expect(readLedger(lineageDigest)).toMatchObject({
      attempts: 1,
      successfulShards: 1,
      successfulKeys: [cacheKey],
      pendingKeys: []
    });
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
  const snapshot = ledger.snapshot();
  const shard = await writeValidShard(cacheKey, snapshot.lineageDigest, snapshot.attempts);
  ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0,
    attemptResponses: [shard.provider_responses[0].witness] }, snapshot.attempts);
  ledger.commitSuccessfulShard(cacheKey);
}

async function writeValidShard(cacheKey: string, lineageDigest: string, attemptOrdinal: number,
  lastUsage?: { inputTokens: number; outputTokens: number; totalTokens: number }) {
  const label = [..."0123456789abcdef"].find((digit) => key(digit) === cacheKey);
  if (label === undefined) throw new Error("provider fixture key is unknown");
  const shard = await providerShardFixture({ label, lineageDigest, attemptOrdinal,
    ...(lastUsage === undefined ? {} : { usage: lastUsage }) });
  await writeShard(cacheKey, JSON.stringify(shard));
  return shard;
}

async function writeDeterministicShard(cacheKey: string): Promise<void> {
  await writeShard(cacheKey, JSON.stringify({
    model: cacheIdentity.model,
    request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey,
    raw_json: '{"signals":[]}',
    empty_classification: "deterministic_empty"
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
