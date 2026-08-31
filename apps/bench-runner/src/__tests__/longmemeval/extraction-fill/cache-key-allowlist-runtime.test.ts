// @ts-nocheck
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { BenchSignalExtractor } from "../../../runs/compile-seed.js";
import { computeExtractionTurnCacheKey } from
  "../../../runs/compile-seed/compile-seed-cache.js";
import { extractionCacheManifestPath } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../runs/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../runs/extraction/authority/receipt.js";
import {
  createFreshRetiredSourceRebuildTargetSelectionRoot,
  readExtractionTargetSelectionReceipt,
  type ExtractionTargetSelectionReceipt,
  writeExtractionTargetSelectionReceipt
} from "../../../runs/extraction/authority/target-selection/receipt.js";
import { digestExtractionTargetSelectionReceipt } from
  "../../../runs/extraction/authority/target-selection/receipt-shape.js";
import { createExtractionCatalogRefillScope } from
  "../../../runs/extraction/authority/catalog-refill/scope.js";
import { runExtractionFill } from
  "../../../runs/extraction/extraction-fill.js";
import { inspectTurnContentKeySpace } from
  "../../../runs/extraction/turn-contents.js";
import type { LongMemEvalQuestion } from
  "../../../datasets/longmemeval/ingestion/dataset.js";
import {
  buildGroundedSignalResponse,
  buildAuthorityQuestion,
  EXTRACTION_FILL_VARIANT,
  providerBackedExtractionResult,
  registerExtractionFillHooks
} from "./fixture.js";
import {
  registerCatalogRefillCrashChild,
  registerCatalogRefillRecoveryCases
} from "./cache-key-allowlist-runtime/recovery/cases.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
let targetSelectionPath: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
  targetSelectionPath = join(cacheRoot, "..", "target-selection.json");
});
const CRASH_CHILD_ENV = "ALAYA_TEST_CATALOG_REFILL_CRASH_CHILD";

afterEach(() => {
  vi.unstubAllGlobals();
});

const parentDescribe = process.env[CRASH_CHILD_ENV] === undefined ? describe : describe.skip;

parentDescribe("cache-key allowlist runtime completion", () => {
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
    const retryModes: Array<string | undefined> = [];
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      retryModes.push(input.retryMode);
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(buildGroundedSignalResponse(input.userPrompt));
    });
    const logs: string[] = [];

    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
      extractorFactory: () => ({ extract }),
      log: (message) => logs.push(message)
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(retryModes).toEqual(["disabled", "disabled"]);
    expect(logs).toContainEqual(expect.stringContaining("2/2"));
    expect(result).toMatchObject({
      requestedTurns: 4,
      cacheHits: 2,
      newlyExtracted: 2,
      authorityTelemetry: { attempts: 2, successfulShards: 2 },
      manifest: { fill_status: "complete", expected_turns: 4, cached_turns: 4 }
    });
  });

  it("returns a resumable in-progress result for a bounded catalog-refill batch", async () => {
    setCredentialFixture();
    const questions = [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ];
    await writeFixtureDataset(questions);
    await prefillFirstQuestion();
    const remainingKeys = [cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)].sort();
    const authorityReceiptPath = await writeCatalogRefillAuthority(remainingKeys);
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
      questionBatchLimit: 1,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).not.toHaveBeenCalled();
    expect(result.manifest).toMatchObject({
      fill_status: "in_progress",
      expected_turns: 4,
      cached_turns: 2,
      coverage: 0.5
    });
    expect(controlArtifacts(".catalog-refill-resume.")).toHaveLength(1);
    expect(controlArtifacts(".catalog-refill-completion.")).toEqual([]);
  });
});

parentDescribe("cache-key allowlist runtime authority", () => {
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
      return providerBackedExtractionResult(buildGroundedSignalResponse(input.userPrompt));
    });
    const logs: string[] = [];
    const options = {
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
      cacheKeyAllowlist: [remainingKeys[0]!],
      extractorFactory: () => ({ extract }),
      log: (message: string) => logs.push(message)
    };

    await expect(runExtractionFill(options)).rejects.toThrow(/runtime cache-key allowlists/u);
    expect(extract).not.toHaveBeenCalled();
    expect(logs).toContainEqual(expect.stringContaining("variant="));
  });
});

parentDescribe("cache-key allowlist runtime resume", () => {
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
      if (calls === 1) {
        return providerBackedExtractionResult(buildGroundedSignalResponse(input.userPrompt));
      }
      throw providerTimeoutFailure();
    });

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
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
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
      extractorFactory: () => ({ extract: driftedExtract }),
      log: () => undefined
    })).rejects.toThrow(/cache manifest drifted/u);
    expect(driftedExtract).not.toHaveBeenCalled();
    writeFileSync(manifestPath, partialManifest, "utf8");

    const resumedExtract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(buildGroundedSignalResponse(input.userPrompt));
    });
    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityReceiptPath.authority,
      targetSelectionReceiptPath: authorityReceiptPath.selection,
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

parentDescribe("cache-key allowlist runtime recovery", () => {
  registerCatalogRefillRecoveryCases({
    entryUrl: import.meta.url,
    variant: EXTRACTION_FILL_VARIANT,
    roots: () => ({ cacheRoot, dataDir, pinnedMetaRoot }),
    setCredentialFixture,
    questions: () => [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ],
    writeFixtureDataset,
    prefillFirstQuestion,
    remainingKeys: (questions) => [
      cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)
    ].sort(),
    writeAuthority: writeCatalogRefillAuthority,
    controlArtifacts,
    providerTimeoutFailure,
    groundedResponse: buildGroundedSignalResponse
  });
});

registerCatalogRefillCrashChild(
  EXTRACTION_FILL_VARIANT, buildGroundedSignalResponse, providerTimeoutFailure
);

async function prefillFirstQuestion(): Promise<void> {
  await createInitialTargetSelection();
  const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) =>
    providerBackedExtractionResult(buildGroundedSignalResponse(input.userPrompt))
  );
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

async function createInitialTargetSelection(): Promise<void> {
  rmSync(cacheRoot, { recursive: true });
  mkdirSync(cacheRoot);
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  rmSync(cacheRoot, { recursive: true });
  const targetRoot = createFreshRetiredSourceRebuildTargetSelectionRoot({
    cacheRoot,
    operator: "catalog-refill-test"
  });
  const unsigned = {
    schema_version: 2 as const,
    kind: "longmemeval-extraction-target-selection" as const,
    created_at: "2026-08-12T00:00:00.000Z",
    selection_basis: { kind: "retired_source_rebuild" as const, operator: "catalog-refill-test" },
    target_root: targetRoot,
    final_identity: {
      revision: inspection.observation.revision,
      dataset_variant: inspection.observation.dataset.variant,
      dataset_revision_sha256: inspection.observation.dataset.revisionSha256,
      model: inspection.observation.extraction.model,
      model_family: inspection.observation.extraction.modelFamily,
      request_profile: inspection.observation.extraction.requestProfile,
      provider_url: inspection.observation.extraction.providerUrl,
      system_prompt_sha256: inspection.observation.extraction.systemPromptSha256,
      cache_key_algorithm: inspection.observation.extraction.cacheKeyAlgorithm
    },
    initial_selection: {
      selection_digest: inspection.observation.selectionDigest,
      key_digest: inspection.observation.keyDigest,
      offset: inspection.observation.dataset.windowOffset,
      limit: inspection.observation.dataset.windowLimit,
      expected_turns: inspection.observation.inventory.expectedTurns
    }
  };
  const selection = {
    ...unsigned,
    receipt_digest: digestExtractionTargetSelectionReceipt(unsigned)
  } satisfies ExtractionTargetSelectionReceipt;
  writeExtractionTargetSelectionReceipt(targetSelectionPath, selection);
}

async function writeCatalogRefillAuthority(keys: readonly string[]): Promise<{
  readonly authority: string;
  readonly selection: string;
}> {
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
  const selection = readExtractionTargetSelectionReceipt(targetSelectionPath);
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
    catalogRefillScope,
    targetSelectionDigest: selection.receipt_digest
  });
  const authorityPath = join(cacheRoot, "authority-receipt-fill.json");
  writeExtractionAuthorityReceipt(authorityPath, receipt);
  return { authority: authorityPath, selection: targetSelectionPath };
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
  return buildAuthorityQuestion(id, fact, decoy);
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

function controlArtifacts(prefix: string): string[] {
  return readdirSync(cacheRoot).filter((name) => name.startsWith(prefix));
}
