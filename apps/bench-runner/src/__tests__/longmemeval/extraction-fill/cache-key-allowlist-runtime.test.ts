import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import { computeExtractionTurnCacheKey } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { extractionCacheManifestPath } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import { createExtractionCatalogRefillScope } from
  "../../../longmemeval/extraction/authority/catalog-refill/scope.js";
import { runExtractionFill } from
  "../../../longmemeval/extraction/extraction-fill.js";
import { inspectTurnContentKeySpace } from
  "../../../longmemeval/extraction/turn-contents.js";
import type { LongMemEvalQuestion } from
  "../../../longmemeval/ingestion/dataset.js";
import {
  buildExtractionFillQuestion,
  EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks
} from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cache-key allowlist runtime", () => {
  it("completes the full window when the allowlist is the exact remaining set", async () => {
    setCredentialFixture();
    const questions = [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ];
    await writeFixtureDataset(questions);
    await prefillFirstQuestion();
    const remainingKeys = [cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)].sort();
    const authorityReceiptPath = await writeCatalogRefillAuthority(remainingKeys);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
    });
    const logs: string[] = [];

    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: () => ({ extract }),
      log: (message) => logs.push(message)
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(logs).toContainEqual(expect.stringContaining("2/2"));
    expect(result).toMatchObject({
      requestedTurns: 4,
      cacheHits: 2,
      newlyExtracted: 2,
      authorityTelemetry: { attempts: 2, successfulShards: 2 },
      manifest: { fill_status: "complete", expected_turns: 4, cached_turns: 4 }
    });
  });

  it("rejects a programmatic runtime allowlist even with a catalog refill receipt", async () => {
    setCredentialFixture();
    const questions = [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ];
    await writeFixtureDataset(questions);
    await prefillFirstQuestion();
    const remainingKeys = [cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)].sort();
    const authorityReceiptPath = await writeCatalogRefillAuthority(remainingKeys);
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
    });
    const logs: string[] = [];
    const options = {
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      cacheKeyAllowlist: [remainingKeys[0]!],
      extractorFactory: () => ({ extract }),
      log: (message: string) => logs.push(message)
    };

    await expect(runExtractionFill(options)).rejects.toThrow(/runtime cache-key allowlists/u);
    expect(extract).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.stringContaining("variant="));
  });

  it("resumes only the remaining receipt-bound keys after a partial provider failure", async () => {
    setCredentialFixture();
    const questions = [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ];
    await writeFixtureDataset(questions);
    await prefillFirstQuestion();
    const remainingKeys = [cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)].sort();
    const authorityReceiptPath = await writeCatalogRefillAuthority(remainingKeys);
    let calls = 0;
    const failedExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      calls += 1;
      if (calls === 1) return { rawJson: '{"signals":[]}' };
      throw providerTimeoutFailure();
    });

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: () => ({ extract: failedExtract }),
      log: () => undefined
    })).rejects.toThrow(/terminal task failure.*failure_timeout/u);
    expect(failedExtract).toHaveBeenCalledTimes(2);

    const manifestPath = extractionCacheManifestPath(cacheRoot);
    const partialManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, `${partialManifest}\n`, "utf8");
    const driftedExtract = vi.fn<BenchSignalExtractor["extract"]>();
    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: () => ({ extract: driftedExtract }),
      log: () => undefined
    })).rejects.toThrow(/cache manifest drifted/u);
    expect(driftedExtract).not.toHaveBeenCalled();
    writeFileSync(manifestPath, partialManifest, "utf8");

    const resumedExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
    });
    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: () => ({ extract: resumedExtract }),
      log: () => undefined
    });

    expect(resumedExtract).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      cacheHits: 3,
      newlyExtracted: 1,
      authorityTelemetry: { attempts: 3, successfulShards: 2 },
      manifest: { fill_status: "complete", expected_turns: 4, cached_turns: 4 }
    });
  });
});

async function prefillFirstQuestion(): Promise<void> {
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async () => ({
    rawJson: '{"signals":[]}'
  }));
  await runExtractionFill({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    questionBatchLimit: 1,
    extractorFactory: () => ({ extract }),
    log: () => undefined
  });
  expect(extract).toHaveBeenCalledTimes(2);
}

async function writeCatalogRefillAuthority(keys: readonly string[]): Promise<string> {
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const catalogRefillScope = createExtractionCatalogRefillScope({
    cacheRoot,
    inspection,
    allowlist: {
      kind: "test-catalog-refill",
      expected_turns: inspection.observation.inventory.expectedTurns,
      cached_turns: inspection.observation.inventory.validTurns,
      missing_turns: inspection.observation.inventory.missingTurns,
      expected_key_set_sha256: inspection.observation.dataset.expectedKeySetSha256,
      cache_keys: keys
    }
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    },
    catalogRefillScope
  });
  const path = join(cacheRoot, "authority-receipt-fill.json");
  writeExtractionAuthorityReceipt(path, receipt);
  return path;
}

function cacheKey(questionValue: LongMemEvalQuestion, index: number): string {
  const turn = inspectTurnContentKeySpace([questionValue]).distinctExtractionTurns[index];
  if (turn === undefined) throw new Error("missing extraction turn fixture");
  return computeExtractionTurnCacheKey(
    "gpt-5.4-mini",
    "provider-default-v1",
    OFFICIAL_API_SYSTEM_PROMPT,
    turn
  );
}

function question(id: string, fact: string, decoy: string): LongMemEvalQuestion {
  return buildExtractionFillQuestion(id, `User: ${fact}`, `User: ${decoy}`);
}

function setCredentialFixture(): void {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:E0_TEST_GARDEN_KEY");
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
}

function providerTimeoutFailure(): Error {
  return Object.assign(new Error("provider timed out for this fixture"), {
    benchRetry: {
      retryCount: 0,
      rateLimitRetries: 0,
      retryClassification: "failure_timeout" as const,
      transportFailures: [{
        kind: "timeout" as const,
        phase: "request" as const,
        httpStatus: null,
        fingerprint: "f".repeat(64),
        attempt: 1
      }]
    }
  });
}
