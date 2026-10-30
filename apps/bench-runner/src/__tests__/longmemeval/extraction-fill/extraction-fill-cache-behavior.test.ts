import { mkdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import {
  createCachingSignalExtractor,
  type BenchSignalExtractor
} from "../../../runs/compile-seed.js";
import { cacheFilePath, computeCacheKey } from "../../../runs/compile-seed/compile-seed-cache.js";
import { providerBackedResponseResult, fixtureAttemptAuthority, writeExtractionCacheTestManifest } from
  "../extraction/extraction-cache-test-fixture.js";
import { writeAuthorizedFixtureReceipt } from "./authority-runtime/fixture.js";

import {
  buildExtractionFillQuestion as buildQuestion,
  buildGroundedInterpretationResponse,
  EXTRACTION_FILL_VARIANT as VARIANT,
  groundedExtractionResult,
  registerExtractionFillHooks
} from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

function extractionPrompt(turnContent: string): string {
  return sourceStatementRequests([{ message_id: "recorded-user", role: "user", content: turnContent }])[0]!.userPrompt;
}

describe("runExtractionFill", () => {

  it("serves a second fill entirely from cache (zero new extractions)", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.")
    ]);
    const authorityReceiptPath = await writeAuthorizedFixtureReceipt({ cacheRoot, dataDir, pinnedMetaRoot });
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) =>
      providerBackedResponseResult(input, buildGroundedInterpretationResponse(input.userPrompt))
    );
    const factory = (): BenchSignalExtractor => ({ extract });

    const first = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: factory,
      log: () => undefined
    });
    expect(first.newlyExtracted).toBe(2);
    expect(first.cacheHits).toBe(0);

    const second = await runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: factory,
      log: () => undefined
    });
    // Same content -> every key is a hit, no new delegate calls beyond the
    // first run's 2.
    expect(second.cacheHits).toBe(2);
    expect(second.newlyExtracted).toBe(0);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(second.coverage).toBe(1);
  });

  it("rejects an existing provider identity before invoking the live delegate", async () => {
    vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://other-provider.invalid/v1");
    await writeFixtureDataset([
      buildQuestion("q001", "I moved to Berlin.", "I prefer TypeScript.")
    ]);
    writeExtractionCacheTestManifest({ cacheRoot, model: "gpt-5.4-mini",
      providerUrl: "https://provider.invalid/v1", systemPrompt: SOURCE_STATEMENTS_PROMPT });
    const extractorFactory = vi.fn(() => ({
      extract: vi.fn(async (input) => groundedExtractionResult(input))
    }));
    await expect(runExtractionFill({
      variant: VARIANT,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      extractorFactory,
      log: () => undefined
    })).rejects.toThrow(/provider URL mismatch/u);
    expect(extractorFactory).not.toHaveBeenCalled();
  });

  it("treats shard persistence failure as a fatal cache invariant", async () => {
    writeExtractionCacheTestManifest({ cacheRoot, model: "gpt-5.4-mini",
      providerUrl: "https://fixture-provider.invalid/v1", systemPrompt: SOURCE_STATEMENTS_PROMPT });
    const turn = "unwritable shard turn";
    const key = computeCacheKey(
      "gpt-5.4-mini", "provider-default-v1", SOURCE_STATEMENTS_PROMPT, extractionPrompt(turn)
    );
    mkdirSync(cacheFilePath(cacheRoot, key), { recursive: true });
    const liveWriter = createCachingSignalExtractor({
      delegate: { extract: async (input) => groundedExtractionResult(input) },
      config: {
        model: "gpt-5.4-mini", modelFamily: "gpt-5.4-mini",
        providerUrl: "https://fixture-provider.invalid/v1",
        requestProfile: "provider-default-v1", sourcePacking: "session-statements"
      },
      cacheRoot,
      ...fixtureAttemptAuthority({ cacheRoot, model: "gpt-5.4-mini", requestProfile: "provider-default-v1" })
    });
    await expect(liveWriter.extract({
      systemPrompt: SOURCE_STATEMENTS_PROMPT,
      userPrompt: extractionPrompt(turn)
    })).rejects.toThrow(/failed to persist extraction cache shard/u);
  });

  it("honours --limit by staging the first N questions only", async () => {
    await writeFixtureDataset([
      buildQuestion("q001", "I remember one.", "I prefer decoy one."),
      buildQuestion("q002", "I remember two.", "I prefer decoy two."),
      buildQuestion("q003", "I remember three.", "I prefer decoy three.")
    ]);
    const authorityReceiptPath = await writeAuthorizedFixtureReceipt({ cacheRoot, dataDir, pinnedMetaRoot }, { limit: 1 });
    const extract = vi.fn<BenchSignalExtractor["extract"]>(async (input) =>
      providerBackedResponseResult(input, buildGroundedInterpretationResponse(input.userPrompt))
    );
    const result = await runExtractionFill({
      variant: VARIANT,
      limit: 1,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      authorityReceiptPath,
      extractorFactory: () => ({ extract }),
      log: () => undefined
    });
    // Only q001 -> answer round + decoy = 2 distinct turns.
    expect(result.requestedTurns).toBe(2);
    expect(extract).toHaveBeenCalledTimes(2);
  });

});
