import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { createCachingSignalExtractor, preflightExtractionCache, type BenchSignalExtractor } from "../../../runs/compile-seed.js";
import { readExtractionCacheManifest, writeExtractionCacheManifest } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { inspectTurnContentKeySpace, type LongMemEvalExtractionTurn } from "../../../runs/extraction/turn-contents.js";
import { buildLongMemEvalFixtureQuestion } from "../longmemeval-fixture.js";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import { groundedExtractionResult } from "../extraction-fill/fixture.js";
import { writeAuthorizedFixtureReceipt } from "../extraction-fill/authority-runtime/fixture.js";
import { fixtureAttemptAuthority, TEST_EXTRACTION_PROVIDER_URL, writeExtractionCacheTestManifest } from "./extraction-cache-test-fixture.js";

const config = { providerUrl: TEST_EXTRACTION_PROVIDER_URL, model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1" as const, sourcePacking: "session-statements" as const, apiKey: "test-key" };
function offlineExtractorFactory(): BenchSignalExtractor {
  return { extract: vi.fn(input => groundedExtractionResult(input)) };
}

async function fillTurns(cacheRoot: string, turns: readonly LongMemEvalExtractionTurn[]): Promise<void> {
  writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
    systemPrompt: SOURCE_STATEMENTS_PROMPT });
  const requests = turns.flatMap(turn => sourceStatementRequests(turn.turnMessages));
  const extractor = createCachingSignalExtractor({ cacheRoot, config, delegate: offlineExtractorFactory(),
    ...fixtureAttemptAuthority({ cacheRoot, model: config.model, requestProfile: config.requestProfile,
      startingMissing: requests.length }) });
  for (const request of requests) await extractor.extract({ systemPrompt: SOURCE_STATEMENTS_PROMPT, userPrompt: request.userPrompt });
  // Progress may advance without replacing the captured generation or widening its target window.
  writeExtractionCacheManifest(cacheRoot, { ...readExtractionCacheManifest(cacheRoot)!,
    requested_turns: requests.length, cached_turns: requests.length, coverage: 1 });
}

let cacheRoot: string;
beforeEach(async () => {
  cacheRoot = await mkdtemp(join(tmpdir(), "window-containment-"));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", config.model);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", config.requestProfile);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", config.providerUrl);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(cacheRoot, { recursive: true, force: true }); });

function windows() {
  const questions = [buildLongMemEvalFixtureQuestion("q001", "s-001"), buildLongMemEvalFixtureQuestion("q002", "s-002")];
  return { questions, narrow: inspectTurnContentKeySpace(questions.slice(0, 1)), wide: inspectTurnContentKeySpace(questions) };
}
function preflight(keySpace: ReturnType<typeof inspectTurnContentKeySpace>) {
  return { cacheRoot, config, systemPrompt: SOURCE_STATEMENTS_PROMPT,
    requiredTurnContents: keySpace.distinctTurnContents, requiredExtractionTurns: keySpace.distinctExtractionTurns };
}

describe("extraction window-containment preflight", () => {
  it("accepts the filled window but refuses an uncovered wider window unless live extraction is explicit", async () => {
    const { narrow, wide } = windows();
    expect(wide.distinctExtractionTurns.length).toBeGreaterThan(narrow.distinctExtractionTurns.length);
    await fillTurns(cacheRoot, narrow.distinctExtractionTurns);
    expect(() => preflightExtractionCache(preflight(narrow))).not.toThrow();
    expect(() => preflightExtractionCache(preflight(wide))).toThrow(/covers only part of this run's question window/su);
    expect(() => preflightExtractionCache({ ...preflight(wide), allowLiveExtraction: true })).not.toThrow();
  });

  it("fills a narrow window completely without certifying the wider question window", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "wc-data-"));
    const pinnedMetaRoot = await mkdtemp(join(tmpdir(), "wc-pinned-"));
    try {
      const { questions, narrow, wide } = windows();
      const raw = JSON.stringify(questions), sha = createHash("sha256").update(raw, "utf8").digest("hex");
      await writeFile(join(dataDir, "longmemeval_oracle.json"), raw, "utf8");
      await writeFile(join(pinnedMetaRoot, "longmemeval_oracle.meta.json"), JSON.stringify({
        name: "longmemeval_oracle", sha256: sha, size_bytes: Buffer.byteLength(raw, "utf8"), question_count: 2
      }), "utf8");
      const fill = await runExtractionFill({ variant: "longmemeval_oracle", limit: 1, sourcePacking: config.sourcePacking,
        cacheRoot, dataDir, pinnedMetaRoot,
        authorityReceiptPath: await writeAuthorizedFixtureReceipt({ cacheRoot, dataDir, pinnedMetaRoot }, { limit: 1 }),
        extractorFactory: offlineExtractorFactory, log: () => undefined });
      expect(fill.coverage).toBe(1);
      expect(readExtractionCacheManifest(cacheRoot)?.coverage).toBe(1);
      expect(() => preflightExtractionCache({ ...preflight(narrow), requiredQuestionWindow: { offset: 0, limit: 1 } })).not.toThrow();
      expect(() => preflightExtractionCache({ ...preflight(wide), requiredQuestionWindow: { offset: 0, limit: 2 } }))
        .toThrow(/complete fill question window.*contain.*offset\/limit/su);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(pinnedMetaRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("allows credentialless raw-only fallback without relaxing the live spending guard", async () => {
    const { narrow, wide } = windows();
    await fillTurns(cacheRoot, narrow.distinctExtractionTurns);
    expect(() => preflightExtractionCache({ ...preflight(wide), config: { ...config, apiKey: null } })).not.toThrow();
    expect(() => preflightExtractionCache({ ...preflight(wide), liveExtractionPossible: false })).not.toThrow();
    expect(() => preflightExtractionCache(preflight(wide))).toThrow(/covers only part of this run's question window/su);
    expect(() => preflightExtractionCache({ ...preflight(wide), liveExtractionPossible: true }))
      .toThrow(/covers only part of this run's question window/su);
  });
});
