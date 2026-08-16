import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forkSettledExtractionAttemptLedger,
  openExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from
  "../../../../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  interruptedFillRecoveryEvidence,
  recoverInterruptedExtractionFillManifest
} from
  "../../../../../../longmemeval/extraction/authority/attempt-ledger/interruption-manifest-recovery.js";
import type { ExtractionAuthorityReceipt } from
  "../../../../../../longmemeval/extraction/authority/receipt.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from
  "../../../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../../../../../longmemeval/extraction/content-closure.js";

const key = (digit: string): string => digit.repeat(64);
const cacheIdentity = {
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1"
} as const;
let cacheRoot = "";

afterEach(async () => {
  vi.useRealTimers();
  if (cacheRoot !== "") await rm(cacheRoot, { recursive: true, force: true });
});

describe("interrupted extraction manifest recovery", () => {
  it("repins an in-progress manifest to the settled ledger inventory", async () => {
    await prepareRoot();
    const ledger = openLedger("e".repeat(64), 2);
    await settleAndCommit(ledger, key("1"));
    writeInProgressManifest(0);

    const recovered = recoverManifest("e".repeat(64), "2026-08-15T12:30:00.000Z");

    expect(recovered).toMatchObject({
      fill_status: "in_progress", requested_turns: 2, cached_turns: 1,
      coverage: 0.5, built_at: "2026-08-15T12:30:00.000Z"
    });
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(recovered);
  });

  it("keeps the manifest artifact stable after recovery is already closed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-15T12:30:00.000Z"));
    await prepareRoot();
    const ledger = openLedger("a".repeat(64), 2);
    await settleAndCommit(ledger, key("1"));
    writeInProgressManifest(0);

    recoverManifest("a".repeat(64));
    const firstSha256 = await manifestSha256();
    const firstManifest = readExtractionCacheManifest(cacheRoot);
    vi.setSystemTime(new Date("2026-08-15T12:31:00.000Z"));
    recoverManifest("a".repeat(64));

    expect(await manifestSha256()).toBe(firstSha256);
    expect(readExtractionCacheManifest(cacheRoot)).toEqual(firstManifest);
  });

  it("adds only successor successes to the inherited preserved closure", async () => {
    await prepareRoot();
    const predecessorLineage = "1".repeat(64);
    const successorLineage = "2".repeat(64);
    await writeProviderShard(key("3"));
    const predecessor = openLedger(predecessorLineage, 2);
    await settleAndCommit(predecessor, key("1"));
    const settled = readSettled(predecessorLineage);
    forkSettledExtractionAttemptLedger({
      cacheRoot, predecessorLineageDigest: predecessorLineage,
      predecessorLedgerSha256: settled.ledgerSha256,
      successorLineageDigest: successorLineage, cacheIdentity
    });
    await settleAndCommit(openLedger(successorLineage, 2), key("2"));
    writeInProgressManifest(2, 3);

    const recovered = recoverInterruptedExtractionFillManifest({
      cacheRoot, ledger: readSettled(successorLineage),
      expected: continuationExpectation(2),
      builtAt: "2026-08-15T12:30:00.000Z"
    });

    expect(recovered).toMatchObject({ cached_turns: 3, coverage: 1 });
  });

  it("rejects a ledger ceiling that exceeds the exact continuation ancestry", async () => {
    await prepareRoot();
    const lineageDigest = "4".repeat(64);
    await writeProviderShard(key("3"));
    const ledger = openLedger(lineageDigest, 3);
    await settleAndCommit(ledger, key("1"));
    await settleAndCommit(ledger, key("2"));
    writeInProgressManifest(2, 3);

    expect(() => recoverInterruptedExtractionFillManifest({
      cacheRoot, ledger: readSettled(lineageDigest),
      expected: continuationExpectation(3)
    })).toThrow(/authority-bound ledger/u);
  });

  it("rejects a shard that is not closed by the settled ledger", async () => {
    await prepareRoot();
    const lineageDigest = "f".repeat(64);
    await settleAndCommit(openLedger(lineageDigest, 2), key("1"));
    await writeProviderShard(key("2"));
    writeInProgressManifest(0);

    expect(() => recoverManifest(lineageDigest)).toThrow(/authority inventory/u);
    expect(readExtractionCacheManifest(cacheRoot)?.cached_turns).toBe(0);
  });
});

it("retains successful-key ancestry for schema-7 interruption recovery", () => {
  const preserved = preservedClosure([key("1")]);
  const receipt = {
    limits: { successful_shard_ceiling: 2 },
    continuation: {
      schema_version: 7,
      predecessor: { successful_keys: [key("1")] },
      preserved_valid_closure: preserved
    }
  } as unknown as ExtractionAuthorityReceipt;

  expect(interruptedFillRecoveryEvidence(receipt)).toEqual({
    preservedValidClosure: preserved,
    inheritedSuccessfulKeys: [key("1")],
    authorizedNewKeys: undefined,
    ledgerSuccessfulShardCeiling: 2
  });
});

async function prepareRoot(): Promise<void> {
  cacheRoot = await mkdtemp(join(tmpdir(), "extraction-manifest-recovery-"));
}

function openLedger(lineageDigest: string, startingMissing: number) {
  return openExtractionAttemptLedger({
    cacheRoot, lineageDigest, cacheIdentity, startingMissing
  });
}

function readSettled(lineageDigest: string) {
  return readSettledExtractionAttemptLedger({ cacheRoot, lineageDigest, cacheIdentity });
}

async function settleAndCommit(
  ledger: ReturnType<typeof openExtractionAttemptLedger>, cacheKey: string
): Promise<void> {
  ledger.reserveAttempt(cacheKey);
  ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
  await writeProviderShard(cacheKey);
  ledger.commitSuccessfulShard(cacheKey);
}

async function writeProviderShard(cacheKey: string): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), JSON.stringify({
    model: cacheIdentity.model, request_profile: cacheIdentity.requestProfile,
    cache_key: cacheKey, raw_json: '{"signals":[]}',
    transport_provenance: {
      provider_url_sha256: `sha256:${key("a")}`, model: cacheIdentity.model
    }
  }), "utf8");
}

function recoverManifest(lineageDigest: string, builtAt?: string) {
  return recoverInterruptedExtractionFillManifest({
    cacheRoot, ledger: readSettled(lineageDigest), expected: manifestExpectation(2),
    ...(builtAt === undefined ? {} : { builtAt })
  });
}

async function manifestSha256(): Promise<string> {
  const raw = await readFile(join(cacheRoot, "manifest.json"));
  return createHash("sha256").update(raw).digest("hex");
}

function writeInProgressManifest(cachedTurns: number, expectedTurns = 2): void {
  writeExtractionCacheManifest(cacheRoot, {
    schema_version: 3, extraction_model: cacheIdentity.model,
    model_family: cacheIdentity.model, request_profile: cacheIdentity.requestProfile,
    provider_url: "https://example.test/v1", system_prompt_sha256: key("c"),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO, dataset: "longmemeval-s",
    dataset_revision: key("d"), requested_turns: expectedTurns,
    cached_turns: cachedTurns, coverage: cachedTurns / expectedTurns,
    fill_status: "in_progress", window_offset: 0, window_limit: expectedTurns,
    expected_turns: expectedTurns,
    expected_key_set_sha256: expectedKeySetSha256(expectedTurns),
    storage: "git-tracked", built_at: "2026-08-15T12:00:00.000Z",
    builder: "extraction-fill"
  });
}

function continuationExpectation(ledgerCeiling: number) {
  return {
    ...manifestExpectation(3),
    preservedValidClosure: preservedClosure([key("1"), key("3")]),
    inheritedSuccessfulKeys: [key("1")],
    ledgerSuccessfulShardCeiling: ledgerCeiling
  };
}

function manifestExpectation(expectedTurns: number) {
  return {
    model: cacheIdentity.model, modelFamily: cacheIdentity.model,
    requestProfile: cacheIdentity.requestProfile,
    providerUrl: "https://example.test/v1", systemPromptSha256: key("c"),
    cacheKeyAlgorithm: EXTRACTION_CACHE_KEY_ALGO, datasetVariant: "longmemeval_s",
    datasetRevisionSha256: key("d"), windowOffset: 0, windowLimit: expectedTurns,
    expectedTurns, expectedKeySetSha256: expectedKeySetSha256(expectedTurns)
  } as const;
}

function expectedKeySetSha256(expectedTurns: number): string {
  return computeExtractionKeySetSha256(
    Array.from({ length: expectedTurns }, (_, index) => key(String(index + 1)))
  );
}

function preservedClosure(keys: readonly string[]) {
  const rawJsonSha256 = createHash("sha256").update('{"signals":[]}').digest("hex");
  return {
    shard_count: keys.length,
    key_set_sha256: computeExtractionKeySetSha256(keys),
    content_closure_sha256: computeExtractionContentClosureSha256(keys.map((cacheKey) => ({
      cacheKey, model: cacheIdentity.model, requestProfile: cacheIdentity.requestProfile,
      rawJsonSha256, rawSignalCount: 0, parsedDraftCount: 0
    })))
  };
}
