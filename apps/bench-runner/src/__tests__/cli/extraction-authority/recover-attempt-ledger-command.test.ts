import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runRecoverExtractionAttemptLedgerCommand } from
  "../../../cli/extraction-authority/recover-attempt-ledger-command.js";
import {
  createExtractionAuthorityReceipt,
  type ExtractionAuthorityReceipt
} from
  "../../../longmemeval/extraction/authority/receipt.js";
import type { ExtractionAttemptLedgerSnapshot } from
  "../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  openExtractionAttemptLedger,
  readSettledExtractionAttemptLedger
} from "../../../longmemeval/extraction/authority/attempt-ledger.js";
import {
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

it("settles an interrupted authority ledger under an exclusive cache lease", async () => {
  const assertOwned = vi.fn();
  const release = vi.fn();
  const recover = vi.fn(() => recoveredSnapshot());
  const recoverManifest = vi.fn(() => inProgressManifest(7));
  const authority = receipt();
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

  const exitCode = await runRecoverExtractionAttemptLedgerCommand([
    "--extraction-cache-root", "/cache",
    "--extraction-authority", "/authority.json",
    "--recover-in-progress-manifest"
  ], {
    readReceipt: () => authority,
    acquireLease: () => ({
      cacheRoot: "/cache",
      stableRootPath: "/proc/self/fd/1",
      assertOwned,
      release
    }),
    recover,
    recoverManifest
  });

  expect(exitCode).toBe(0);
  expect(assertOwned).toHaveBeenCalledTimes(2);
  expect(release).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledWith({
    cacheRoot: "/proc/self/fd/1",
    lineageDigest: authority.lineage_digest,
    cacheIdentity: {
      model: "DeepSeek-V4-Flash",
      requestProfile: "deepseek-v4-nonthinking-v1"
    },
    startingMissing: 10,
    maximumAttempts: 50,
    successfulShardCeiling: 10
  });
  expect(recoverManifest).toHaveBeenCalledWith({
    cacheRoot: "/proc/self/fd/1",
    ledger: recoveredSnapshot(),
    expected: {
      model: "DeepSeek-V4-Flash",
      modelFamily: "deepseek-v4-flash",
      requestProfile: "deepseek-v4-nonthinking-v1",
      providerUrl: "https://example.test/v1",
      systemPromptSha256: "c".repeat(64),
      cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
      datasetVariant: "longmemeval_s",
      datasetRevisionSha256: "a".repeat(64),
      windowOffset: 0,
      windowLimit: 100,
      expectedTurns: 10,
      expectedKeySetSha256: "b".repeat(64)
    }
  });
  expect(stdout).toHaveBeenCalledWith(
    "Recovered extraction attempt ledger: attempts=12 successful_shards=7 " +
    "aborted=2 usage_unknown=3 manifest_cached=7\n"
  );
});

it("rejects an incomplete recovery invocation without acquiring a lease", async () => {
  const acquireLease = vi.fn();
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  expect(await runRecoverExtractionAttemptLedgerCommand([], { acquireLease })).toBe(2);

  expect(acquireLease).not.toHaveBeenCalled();
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
    "--extraction-cache-root <path> required"
  ));
});

it("refuses a valid authority when the selected cache has no predecessor ledger", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "attempt-ledger-recovery-empty-"));
  temporaryRoots.push(cacheRoot);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

  const exitCode = await runRecoverExtractionAttemptLedgerCommand([
    "--extraction-cache-root", cacheRoot,
    "--extraction-authority", "/authority.json"
  ], { readReceipt: () => receipt() });

  expect(exitCode).toBe(2);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining("requires an existing attempt ledger"));
  expect(await readdir(cacheRoot)).toEqual([]);
});

it("settles a real ledger through the descriptor-bound lease path", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), "attempt-ledger-recovery-real-"));
  temporaryRoots.push(cacheRoot);
  const authority = receipt();
  const identity = {
    model: authority.observation.extraction.model,
    requestProfile: authority.observation.extraction.requestProfile
  } as const;
  const ledger = openExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: authority.lineage_digest,
    cacheIdentity: identity,
    startingMissing: authority.limits.starting_missing,
    maximumAttempts: authority.limits.maximum_attempts,
    successfulShardCeiling: authority.limits.successful_shard_ceiling
  });
  const cacheKey = "b".repeat(64);
  ledger.reserveAttempt(cacheKey);
  ledger.recordTransportOutcome(cacheKey, { retryCount: 0, rateLimitRetries: 0 });
  await writeProviderShard(cacheRoot, cacheKey, identity);
  ledger.commitSuccessfulShard(cacheKey);
  ledger.reserveAttempt("a".repeat(64));
  writeExtractionCacheManifest(cacheRoot, inProgressManifest(0));
  vi.spyOn(process.stdout, "write").mockReturnValue(true);

  expect(await runRecoverExtractionAttemptLedgerCommand([
    "--extraction-cache-root", cacheRoot,
    "--extraction-authority", "/authority.json",
    "--recover-in-progress-manifest"
  ], { readReceipt: () => authority })).toBe(0);

  const recovered = readSettledExtractionAttemptLedger({
    cacheRoot,
    lineageDigest: authority.lineage_digest,
    cacheIdentity: identity
  });
  expect(recovered.pendingKeys).toEqual([]);
  expect(recovered.unresolvedAttempts).toEqual([]);
  expect(recovered.telemetry.terminalRetryClassifications.failure_aborted).toBe(1);
  expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
    fill_status: "in_progress",
    cached_turns: 1,
    coverage: 0.1
  });
});

it.each([
  ["identity", (value: ExtractionAuthorityReceipt) => ({
    ...value,
    identity_digest: "a".repeat(64)
  })],
  ["lineage", (value: ExtractionAuthorityReceipt) => ({
    ...value,
    lineage_digest: "a".repeat(64)
  })],
  ["limits", (value: ExtractionAuthorityReceipt) => ({
    ...value,
    limits: { ...value.limits, maximum_attempts: value.limits.maximum_attempts - 1 }
  })]
] as const)("rejects self-digested %s drift before acquiring a lease", async (_name, mutate) => {
  const acquireLease = vi.fn();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const drifted = resignReceipt(mutate(receipt()));

  expect(await runRecoverExtractionAttemptLedgerCommand([
    "--extraction-cache-root", "/cache",
    "--extraction-authority", "/authority.json"
  ], { readReceipt: () => drifted, acquireLease })).toBe(2);

  expect(acquireLease).not.toHaveBeenCalled();
});

function receipt(): ExtractionAuthorityReceipt {
  return createExtractionAuthorityReceipt({
    action: "fill",
    observation: {
      revision: `git-worktree-v1:${"d".repeat(40)}:${"1".repeat(64)}`,
      commandDigest: "e".repeat(64),
      selectionDigest: "f".repeat(64),
      keyDigest: "b".repeat(64),
      dataset: {
        variant: "longmemeval_s",
        revisionSha256: "a".repeat(64),
        windowOffset: 0,
        windowLimit: 100,
        windowTurnOccurrences: 20,
        windowUniqueCacheKeys: 15,
        authorizedQuestionCount: 50,
        authorizedTurnOccurrences: 12,
        authorizedUniqueCacheKeys: 10,
        expectedKeySetSha256: "b".repeat(64)
      },
      extraction: {
        model: "DeepSeek-V4-Flash",
        modelFamily: "deepseek-v4-flash",
        requestProfile: "deepseek-v4-nonthinking-v1",
        providerUrl: "https://example.test/v1",
        systemPromptSha256: "c".repeat(64),
        cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
        manifestSha256: null,
        rawContentClosureSha256: null
      },
      inventory: {
        expectedTurns: 10,
        validTurns: 0,
        missingTurns: 10,
        invalidTurns: 0,
        orphanTurns: 0
      }
    },
    outputTokenCap: { field: "max_tokens", value: 16_384 },
    priceEstimate: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: 65_536
    },
    diskFloorBytes: 1,
    inspection: {
      writerLock: "absent",
      disk: { status: "available", freeBytes: 2 },
      credentialStatus: "present",
      modelReadiness: "not_probed"
    },
    now: new Date("2026-08-15T00:00:00.000Z")
  });
}

function recoveredSnapshot(): ExtractionAttemptLedgerSnapshot {
  return {
    rawLedgerSha256: "1".repeat(64),
    ledgerSha256: "2".repeat(64),
    lineageDigest: "b".repeat(64),
    startingMissing: 10,
    maximumAttempts: 50,
    successfulShardCeiling: 10,
    attempts: 12,
    successfulShards: 7,
    successfulEntries: [],
    successfulKeys: [],
    pendingKeys: [],
    unresolvedAttempts: [],
    transportFailures: [],
    telemetry: {
      retrySuccesses: 0,
      rateLimitRetries: 0,
      terminalRetryClassifications: {
        failure_max_retries: 0,
        failure_non_retryable_4xx: 0,
        failure_timeout: 0,
        failure_aborted: 2
      },
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usageUnavailableRequests: 3,
      unresolvedTransportAttempts: 0,
      usageUnknownAttempts: 3
    }
  };
}

function inProgressManifest(cachedTurns: number) {
  return {
    schema_version: 3 as const,
    extraction_model: "DeepSeek-V4-Flash",
    model_family: "deepseek-v4-flash",
    request_profile: "deepseek-v4-nonthinking-v1" as const,
    provider_url: "https://example.test/v1",
    system_prompt_sha256: "c".repeat(64),
    cache_key_algo: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s",
    dataset_revision: "a".repeat(64),
    requested_turns: 10,
    cached_turns: cachedTurns,
    coverage: cachedTurns / 10,
    fill_status: "in_progress" as const,
    window_offset: 0,
    window_limit: 100,
    expected_turns: 10,
    expected_key_set_sha256: "b".repeat(64),
    storage: "git-tracked" as const,
    built_at: "2026-08-15T00:00:00.000Z",
    builder: "extraction-fill"
  };
}

async function writeProviderShard(
  cacheRoot: string,
  cacheKey: string,
  identity: { readonly model: string; readonly requestProfile: string }
): Promise<void> {
  const directory = join(cacheRoot, cacheKey.slice(0, 2));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${cacheKey}.json`), JSON.stringify({
    model: identity.model,
    request_profile: identity.requestProfile,
    cache_key: cacheKey,
    raw_json: '{"signals":[]}',
    transport_provenance: {
      provider_url_sha256: `sha256:${"f".repeat(64)}`,
      model: identity.model
    }
  }), "utf8");
}

function resignReceipt(receipt: ExtractionAuthorityReceipt): ExtractionAuthorityReceipt {
  const { receipt_digest: _receiptDigest, ...unsigned } = receipt;
  return {
    ...unsigned,
    receipt_digest: createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex")
  };
}
