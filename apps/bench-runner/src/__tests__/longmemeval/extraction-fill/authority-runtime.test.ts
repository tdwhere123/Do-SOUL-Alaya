import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import type { BenchSignalExtractor } from "../../../runs/compile-seed.js";
import {
  buildAuthorityQuestion as question,
  buildExtractionFillQuestion,
  buildGroundedSignalResponse as signalResponse,
  EXTRACTION_FILL_VARIANT,
  providerBackedExtractionResult,
  registerExtractionFillHooks,
  setExtractionCredentialFixture as setCredentialFixture
} from "./fixture.js";
import {
  batchedFact,
  mutateFirstRawShard as mutateFirstRawShardAt,
  singleSessionBatchedQuestion,
  writeAuthorityReceipt as writeAuthorityReceiptAt,
  writeCanonicalSFixtureDataset as writeCanonicalSFixtureDatasetAt,
  writeFixtureData as writeFixtureDataAt
} from "./authority-runtime/fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extraction authority runtime", () => {
  it("fails closed before the built-in provider when no authority receipt exists", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      log: () => undefined
    })).rejects.toThrow(/terminal task failure/u);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a target selection before canonical normal LongMemEval-S can reach the built-in provider", async () => {
    setCredentialFixture();
    const canonicalQuestions = Array.from(
      { length: 100 },
      (_, index) => question(`q${index + 1}`, "alpha", "decoy")
    );
    await writeCanonicalSFixtureDataset(canonicalQuestions);
    const receiptPath = await writeAuthorityReceipt({ variant: "longmemeval_s", limit: 100 });
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(runExtractionFill({
      variant: "longmemeval_s",
      limit: 100,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      log: () => undefined
    })).rejects.toThrow(/target selection/u);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(cacheRoot, ".extraction-fill.lock"))).toBe(false);
  });

  it("resumes provider and deterministic shards under one authority closure", async () => {
    setCredentialFixture();
    await writeFixtureDataset([buildExtractionFillQuestion(
      "q001", "I completed alpha.", "Hello."
    )]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(signalResponse(input.userPrompt), {
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      });
    });

    const result = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledOnce();
    expect(result.authorityTelemetry).toMatchObject({
      attempts: 1,
      successfulShards: 2,
      telemetry: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        usageUnavailableRequests: 0
      }
    });

    const resumed = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledOnce();
    expect(resumed.authorityTelemetry).toMatchObject({
      attempts: 1,
      successfulShards: 2,
      telemetry: { totalTokens: 5 }
    });
  });

  it("runs a bounded question prefix without narrowing or finalizing its authority window", async () => {
    setCredentialFixture();
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", batchedFact(), "I completed decoy."),
      question("q002", "beta", "distraction")
    ]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(signalResponse(input.userPrompt));
    });

    const batch = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      questionBatchLimit: 1,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(3);
    expect(batch).toMatchObject({
      requestedTurns: 3,
      newlyExtracted: 3,
      coverage: 1,
      manifest: {
        fill_status: "in_progress",
        expected_turns: 5,
        cached_turns: 3,
        coverage: 0.6
      }
    });

    const completed = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(5);
    expect(completed.manifest.fill_status).toBe("complete");
  });

  it("limits a one-key probe to its target inside a multi-key source turn", async () => {
    setCredentialFixture();
    await writeFixtureDataset([singleSessionBatchedQuestion("q001")]);
    const probePath = await writeAuthorityReceipt({ action: "probe" });
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(signalResponse(input.userPrompt));
    });

    const probe = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: probePath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledOnce();
    expect(probe).toMatchObject({
      requestedTurns: 1,
      newlyExtracted: 1,
      manifest: { expected_turns: 2, cached_turns: 1, coverage: 0.5 }
    });
  });

  it("keeps the one-key probe ledger separate from its fresh fill lineage", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const probePath = await writeAuthorityReceipt({ action: "probe" });
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(signalResponse(input.userPrompt));
    });

    const probe = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: probePath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    const fillPath = await writeAuthorityReceipt({ action: "fill" });
    const fill = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: fillPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledTimes(2);
    expect(probe).toMatchObject({ requestedTurns: 1, newlyExtracted: 1 });
    expect(fill).toMatchObject({ requestedTurns: 2, cacheHits: 1, newlyExtracted: 1 });
    expect(probe.authorityTelemetry?.lineageDigest)
      .not.toBe(fill.authorityTelemetry?.lineageDigest);
    expect(fill.authorityTelemetry).toMatchObject({
      attempts: 1,
      successfulShards: 1,
      telemetry: { usageUnavailableRequests: 1 }
    });
  });

  it("persists one strict-empty probe with a non-empty assertion catalog", async () => {
    setCredentialFixture();
    await writeFixtureDataset([buildExtractionFillQuestion(
      "q001", "I moved to Berlin last spring.", "I stayed home last spring."
    )]);
    const probePath = await writeAuthorityReceipt({ action: "probe" });
    const observedRequests: { retryMode: string | undefined; assertionCount: number }[] = [];
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      const prompt = JSON.parse(input.userPrompt) as { source_assertions?: readonly unknown[] };
      observedRequests.push({
        retryMode: input.retryMode,
        assertionCount: prompt.source_assertions?.length ?? 0
      });
      return providerBackedExtractionResult('{"signals":[]}');
    });

    const probe = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: probePath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });

    expect(extract).toHaveBeenCalledOnce();
    expect(observedRequests).toEqual([{ retryMode: "disabled", assertionCount: 1 }]);
    expect(probe).toMatchObject({ requestedTurns: 1, newlyExtracted: 1 });
    expect(probe.authorityTelemetry).toMatchObject({ attempts: 1, successfulShards: 1 });
  });

  it("rejects a question batch on a one-key probe before delegation", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const receiptPath = await writeAuthorityReceipt({ action: "probe" });
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      questionBatchLimit: 1,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/question batch.*probe/u);

    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects a mutation of a provider-backed shard before any resumed delegate", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return providerBackedExtractionResult(signalResponse(input.userPrompt));
    });
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    mutateFirstRawShard();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/successful shard closure drifted/u);

    expect(extract).toHaveBeenCalledTimes(2);
  });

  it("rejects a changed selection before any delegate", async () => {
    setCredentialFixture();
    await writeFixtureDataset([
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ]);
    const receiptPath = await writeAuthorityReceipt({ limit: 1 });
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/identity drift|does not match/u);

    expect(extract).not.toHaveBeenCalled();
  });

  it("rechecks authority after preparation and stops dataset drift before delegation", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: (message) => {
        if (message.startsWith("[extraction-fill] variant=")) {
          writeFixtureData([
            question("q001", "alpha", "decoy"),
            question("q002", "beta", "distraction")
          ]);
        }
      }
    })).rejects.toThrow(/identity drift|does not match/u);

    expect(extract).not.toHaveBeenCalled();
    expect(existsSync(join(cacheRoot, "manifest.json"))).toBe(false);
  });

  it("restores the exact pinned manifest when post-pin authority revalidation drifts", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({
        extract: async () => providerBackedExtractionResult('{"signals":[]}')
      }),
      log: () => undefined
    });
    const receiptPath = await writeAuthorityReceipt({});
    const beforeManifest = readFileSync(join(cacheRoot, "manifest.json"), "utf8");
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: (message) => {
        if (message.startsWith("[extraction-fill] variant=")) {
          writeFixtureData([
            question("q001", "alpha", "decoy"),
            question("q002", "beta", "distraction")
          ]);
        }
      }
    })).rejects.toThrow(/identity drift|does not match/u);

    expect(readFileSync(join(cacheRoot, "manifest.json"), "utf8")).toBe(beforeManifest);
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects a mutated preexisting raw shard before it can reach the delegate", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    let interrupted = false;
    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({
        extract: async () => providerBackedExtractionResult('{"signals":[]}')
      }),
      log: (message) => {
        if (!interrupted && message.includes("1/2")) {
          interrupted = true;
          throw new Error("stop after one shard");
        }
      }
    })).rejects.toThrow("stop after one shard");
    const receiptPath = await writeAuthorityReceipt({});
    mutateFirstRawShard();
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/raw cache closure drifted/u);

    expect(extract).not.toHaveBeenCalled();
  });
});

async function writeAuthorityReceipt(input: {
  readonly limit?: number;
  readonly action?: "probe" | "fill";
  readonly variant?: typeof EXTRACTION_FILL_VARIANT | "longmemeval_s";
}): Promise<string> {
  return writeAuthorityReceiptAt({ cacheRoot, dataDir, pinnedMetaRoot }, input);
}

async function writeCanonicalSFixtureDataset(
  questions: readonly LongMemEvalQuestion[]
): Promise<void> {
  await writeCanonicalSFixtureDatasetAt(
    { cacheRoot, dataDir, pinnedMetaRoot },
    writeFixtureDataset,
    questions
  );
}

function writeFixtureData(
  questions: readonly LongMemEvalQuestion[],
  variant = EXTRACTION_FILL_VARIANT
): void {
  writeFixtureDataAt({ dataDir, pinnedMetaRoot }, questions, variant);
}

function mutateFirstRawShard(): void {
  mutateFirstRawShardAt(cacheRoot);
}
