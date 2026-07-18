import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BenchSignalExtractor } from
  "../../../longmemeval/compile-seed.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from
  "../../../longmemeval/extraction/authority/inspection.js";
import { createExtractionRepairScope } from
  "../../../longmemeval/extraction/authority/repair/repair-scope.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import { runExtractionFill } from
  "../../../longmemeval/extraction/extraction-fill.js";
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

describe("strict JSON repair authority runtime", () => {
  it("overwrites only the bound invalid shard and preserves the valid sibling", async () => {
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:REPAIR_TEST_KEY");
    vi.stubEnv("REPAIR_TEST_KEY", "test-key");
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy")
    ]);
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    });
    const [mutatedPath, untouchedPath] = shardPaths();
    mutateRawJson(mutatedPath!, '{"signals":[{"signal_kind":"potential_preference"}');
    const untouchedBefore = readFileSync(untouchedPath!, "utf8");
    const receiptPath = await writeRepairReceipt();
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return {
        rawJson: '{"signals":[]}',
        responseMetadata: { finishReason: "stop", maxOutputTokens: 2048 }
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

    expect(extract).toHaveBeenCalledTimes(1);
    expect(readFileSync(untouchedPath!, "utf8")).toBe(untouchedBefore);
    expect(result).toMatchObject({
      cacheHits: 0,
      newlyExtracted: 1,
      coverage: 1,
      authorityTelemetry: { startingMissing: 1, successfulShards: 1 }
    });

    const resumedExtract = vi.fn<BenchSignalExtractor["extract"]>(async () => {
      throw new Error("resume must use the repaired cache shard");
    });
    const resumed = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract: resumedExtract }),
      log: () => undefined
    });

    expect(resumedExtract).not.toHaveBeenCalled();
    expect(resumed).toMatchObject({
      cacheHits: 1,
      newlyExtracted: 0,
      authorityTelemetry: { startingMissing: 1, successfulShards: 1 }
    });
  });

  it("rejects strict-valid sibling drift before an authorized repair reaches transport", async () => {
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:REPAIR_TEST_KEY");
    vi.stubEnv("REPAIR_TEST_KEY", "test-key");
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy")
    ]);
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    });
    const [invalidPath, preservedPath] = shardPaths();
    mutateRawJson(invalidPath!, '{"signals":[{"signal_kind":"potential_preference"}');
    const receiptPath = await writeRepairReceipt();
    mutateRawJson(preservedPath!, '{"signals":[ ]}');
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    })).rejects.toThrow(/preserved.*closure|strict-valid.*drift/iu);
    expect(extract).not.toHaveBeenCalled();
  });

  it("rejects a lost repair write lease before calling the extraction delegate", async () => {
    vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:REPAIR_TEST_KEY");
    vi.stubEnv("REPAIR_TEST_KEY", "test-key");
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy")
    ]);
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
      log: () => undefined
    });
    const [invalidPath] = shardPaths();
    mutateRawJson(invalidPath!, '{"signals":[{"signal_kind":"potential_preference"}');
    const receiptPath = await writeRepairReceipt();
    const extract = vi.fn<BenchSignalExtractor["extract"]>();

    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath: receiptPath,
      extractorFactory: () => {
        rmSync(join(cacheRoot, ".extraction-fill.lock"), { recursive: true, force: true });
        return { extract };
      },
      log: () => undefined
    })).rejects.toThrow(/writer lock|lock owner|cannot verify/iu);
    expect(extract).not.toHaveBeenCalled();
  });
});

async function writeRepairReceipt(): Promise<string> {
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill",
    repairInvalidShards: true
  });
  const repairScope = createExtractionRepairScope(
    inspection.invalidShards,
    inspection.preservedValidClosure
  );
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    repairScope,
    cumulativeLimits: {
      startingMissing: repairScope.shard_count,
      maximumAttempts: 2,
      successfulShardCeiling: repairScope.shard_count
    },
    outputTokenCap: { field: "max_tokens", value: 4096 },
    priceEstimate: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: 1024
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    }
  });
  const receiptPath = join(cacheRoot, "strict-json-repair-authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return receiptPath;
}

function shardPaths(): readonly string[] {
  return readdirSync(cacheRoot).filter((entry) => /^[a-f0-9]{2}$/u.test(entry))
    .flatMap((prefix) => readdirSync(join(cacheRoot, prefix))
      .filter((file) => file.endsWith(".json"))
      .map((file) => join(cacheRoot, prefix, file)))
    .sort();
}

function mutateRawJson(path: string, rawJson: string): void {
  const shard = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...shard, raw_json: rawJson }), "utf8");
}
