import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import { readExtractionAttemptLedger } from
  "../../../longmemeval/extraction/authority/attempt-ledger.js";
import { receiptExtractionCacheIdentity } from
  "../../../longmemeval/extraction/authority/receipt-cache-identity.js";
import {
  createFreshRetiredSourceRebuildTargetSelection,
  writeExtractionTargetSelectionReceipt
} from "../../../longmemeval/extraction/authority/target-selection/receipt.js";
import { readExtractionCacheManifestIdentity } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
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

describe("authority-bound provider failure isolation", () => {
  it("rejects the programmatic seam without an authority before delegation", async () => {
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      tolerateProviderTaskFailures: true,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/failure isolation.*authority/u);

    expect(extract).not.toHaveBeenCalled();
    expect(readExtractionCacheManifestIdentity(cacheRoot)).toBeUndefined();
  });

  it("rejects a fill authority that is not target-selection-bound", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const authorityPath = await writeUnboundAuthority();
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authorityPath,
      tolerateProviderTaskFailures: true,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/normal target-selection-bound fill authority/u);

    expect(extract).not.toHaveBeenCalled();
  });

  it("continues siblings after a 4xx, then fails with an honest incomplete state", async () => {
    setCredentialFixture();
    const questions = Array.from(
      { length: 100 },
      (_, index) => question(`q${index + 1}`, "provider-failure", "sibling-success")
    );
    await writeCanonicalDataset(questions);
    const authority = await writeTargetBoundAuthority();
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      const turn = readTurnContent(input.userPrompt);
      if (turn.includes("provider-failure")) throw nonRetryable4xx();
      return { rawJson: '{"signals":[]}' };
    });

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      offset: 0,
      limit: 100,
      concurrency: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: authority.authorityPath,
      targetSelectionReceiptPath: authority.targetSelectionPath,
      tolerateProviderTaskFailures: true,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/completion refused.*missing=1/u);

    expect(extract).toHaveBeenCalledTimes(2);
    expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest).toMatchObject({
      fill_status: "in_progress",
      expected_turns: 2,
      cached_turns: 1,
      coverage: 1 / 2
    });
    expect(readExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: authority.receipt.lineage_digest,
      cacheIdentity: receiptExtractionCacheIdentity(authority.receipt)
    })).toMatchObject({
      attempts: 2,
      successfulShards: 1,
      pendingKeys: [],
      telemetry: {
        terminalRetryClassifications: { failure_non_retryable_4xx: 1 },
        unresolvedTransportAttempts: 0
      }
    });
  });
});

function setCredentialFixture(): void {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:E0_TEST_GARDEN_KEY");
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
}

function question(id: string, fact: string, decoy: string): LongMemEvalQuestion {
  return buildExtractionFillQuestion(id, `User: ${fact}`, `User: ${decoy}`);
}

async function writeCanonicalDataset(questions: readonly LongMemEvalQuestion[]): Promise<void> {
  await writeFixtureDataset(questions);
  const raw = JSON.stringify(questions);
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  writeFileSync(join(dataDir, "longmemeval_s.json"), raw, "utf8");
  writeFileSync(join(pinnedMetaRoot, "longmemeval_s.meta.json"), JSON.stringify({
    name: "longmemeval_s",
    sha256,
    question_count: questions.length
  }), "utf8");
}

async function writeTargetBoundAuthority() {
  const inspection = await inspectExtractionAuthority({
    variant: "longmemeval_s",
    offset: 0,
    limit: 100,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  rmSync(cacheRoot, { recursive: true });
  const targetSelection = createFreshRetiredSourceRebuildTargetSelection({
    cacheRoot,
    operator: "provider-failure-isolation-test",
    observation: inspection.observation
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
    targetSelectionDigest: targetSelection.receipt_digest
  });
  const authorityPath = join(dirname(cacheRoot), "authority.json");
  const targetSelectionPath = join(dirname(cacheRoot), "target-selection.json");
  writeExtractionAuthorityReceipt(authorityPath, receipt);
  writeExtractionTargetSelectionReceipt(targetSelectionPath, targetSelection);
  return { authorityPath, targetSelectionPath, receipt };
}

async function writeUnboundAuthority(): Promise<string> {
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
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
    }
  });
  const authorityPath = join(dirname(cacheRoot), "unbound-authority.json");
  writeExtractionAuthorityReceipt(authorityPath, receipt);
  return authorityPath;
}

function readTurnContent(userPrompt: string): string {
  return (JSON.parse(userPrompt) as { readonly turn_content: string }).turn_content;
}

function nonRetryable4xx(): Error {
  return Object.assign(new Error("provider rejected request"), {
    benchRetry: {
      retryCount: 0,
      rateLimitRetries: 0,
      retryClassification: "failure_non_retryable_4xx" as const
    }
  });
}
