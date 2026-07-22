import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { BenchSignalExtractor } from "../../../longmemeval/compile-seed.js";
import { computeExtractionTurnCacheKey } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
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
    const authorityReceiptPath = await writeFillAuthority();
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
      cacheKeyAllowlist: [cacheKey(questions[1]!, 1), cacheKey(questions[1]!, 0)],
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

  it("limits the pool exactly while incomplete completion still scans the full window", async () => {
    setCredentialFixture();
    const questions = [
      question("q001", "alpha", "decoy"),
      question("q002", "beta", "distraction")
    ];
    await writeFixtureDataset(questions);
    await prefillFirstQuestion();
    const authorityReceiptPath = await writeFillAuthority();
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) => {
      await input.onTransportAttempt?.();
      return { rawJson: '{"signals":[]}' };
    });
    const logs: string[] = [];
    const cacheKeyAllowlist = [cacheKey(questions[1]!, 0)];
    const options = {
      variant: EXTRACTION_FILL_VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      cacheKeyAllowlist,
      extractorFactory: () => ({ extract }),
      log: (message: string) => logs.push(message)
    };

    const result = await runExtractionFill(options);

    expect(extract).toHaveBeenCalledOnce();
    expect(logs).toContainEqual(expect.stringContaining("1/1"));
    expect(logs).toContainEqual(expect.stringContaining("intentional_skips=1"));
    expect(result.manifest).toMatchObject({
      fill_status: "in_progress",
      expected_turns: 4,
      cached_turns: 3,
      coverage: 0.75
    });
    expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest).toEqual(result.manifest);
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

async function writeFillAuthority(): Promise<string> {
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
