import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { runExtractionFill } from "../../../longmemeval/extraction/extraction-fill.js";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
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

  it("executes only the matching authority and persists exact usage telemetry", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      input.onTransportAttempt?.();
      return {
        rawJson: '{"signals":[]}',
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
      };
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

    expect(extract).toHaveBeenCalledTimes(2);
    expect(result.authorityTelemetry).toMatchObject({
      attempts: 2,
      successfulShards: 2,
      telemetry: {
        inputTokens: 6,
        outputTokens: 4,
        totalTokens: 10,
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

    expect(extract).toHaveBeenCalledTimes(2);
    expect(resumed.authorityTelemetry).toMatchObject({
      attempts: 2,
      successfulShards: 2,
      telemetry: { totalTokens: 10 }
    });
  });

  it("keeps the one-key probe ledger separate from its fresh fill lineage", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const probePath = await writeAuthorityReceipt({ action: "probe" });
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
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

  it("rejects a mutation of a ledger-recorded success before any resumed delegate", async () => {
    setCredentialFixture();
    await writeFixtureDataset([question("q001", "alpha", "decoy")]);
    const receiptPath = await writeAuthorityReceipt({});
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
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
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
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
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
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

function setCredentialFixture(): void {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:E0_TEST_GARDEN_KEY");
  vi.stubEnv("E0_TEST_GARDEN_KEY", "test-key");
}

function question(id: string, fact: string, decoy: string): LongMemEvalQuestion {
  return buildExtractionFillQuestion(id, `User: ${fact}`, `User: ${decoy}`);
}

async function writeAuthorityReceipt(input: {
  readonly limit?: number;
  readonly action?: "probe" | "fill";
}): Promise<string> {
  const action = input.action ?? "fill";
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action
  });
  const receipt = createExtractionAuthorityReceipt({
    action,
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: inspectionSummary(inspection),
    ...(action === "probe" ? { probeKey: inspection.missingKeys[0] } : {})
  });
  const path = join(cacheRoot, `authority-receipt-${action}.json`);
  writeExtractionAuthorityReceipt(path, receipt);
  return path;
}

function inspectionSummary(inspection: Awaited<ReturnType<typeof inspectExtractionAuthority>>) {
  return {
    writerLock: inspection.writerLock,
    disk: inspection.disk,
    credentialStatus: inspection.credentialStatus,
    modelReadiness: inspection.modelReadiness
  };
}

function writeFixtureData(questions: readonly LongMemEvalQuestion[]): void {
  const raw = JSON.stringify(questions);
  const sha256 = createHash("sha256").update(raw, "utf8").digest("hex");
  writeFileSync(join(dataDir, `${EXTRACTION_FILL_VARIANT}.json`), raw, "utf8");
  writeFileSync(join(pinnedMetaRoot, `${EXTRACTION_FILL_VARIANT}.meta.json`), JSON.stringify({
    name: EXTRACTION_FILL_VARIANT,
    sha256,
    question_count: questions.length
  }), "utf8");
}

function mutateFirstRawShard(): void {
  const prefix = readdirSync(cacheRoot).find((entry) => /^[0-9a-f]{2}$/u.test(entry));
  if (prefix === undefined) throw new Error("expected a cached extraction shard");
  const file = readdirSync(join(cacheRoot, prefix)).find((entry) => entry.endsWith(".json"));
  if (file === undefined) throw new Error("expected a cached extraction shard file");
  const path = join(cacheRoot, prefix, file);
  const shard = JSON.parse(readFileSync(path, "utf8")) as { raw_json: string };
  writeFileSync(path, JSON.stringify({ ...shard, raw_json: '{"signals":[],"mutated":true}' }), "utf8");
}
