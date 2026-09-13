import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialApiExtractionRequests,
  OFFICIAL_API_SYSTEM_PROMPT,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  inspectCachedExtraction
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { inspectExtractionFillCompletion } from
  "../../../runs/extraction/fill/fill-completion.js";
import {
  classifyExtractionEnvelope
} from "../../../runs/extraction/empty-classification.js";
import { SEMANTIC_ARTIFACT_KIND } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import { newFillStats } from "../../../runs/extraction/fill/fill-stats.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("extraction empty envelope classification", () => {
  it("separates provider-empty, deterministic-empty, and plan-skipped", () => {
    expect(classifyExtractionEnvelope({
      rawSignalCount: 0, sourceAssertionCount: 2, planMembership: "in_plan"
    })).toBe("provider_empty_with_assertions");
    expect(classifyExtractionEnvelope({
      rawSignalCount: 0, sourceAssertionCount: 0, planMembership: "in_plan"
    })).toBe("deterministic_empty");
    expect(classifyExtractionEnvelope({
      rawSignalCount: 0, sourceAssertionCount: 2, planMembership: "skipped"
    })).toBe("plan_skipped");
    expect(classifyExtractionEnvelope({
      rawSignalCount: 1, sourceAssertionCount: 2, planMembership: "in_plan"
    })).toBe("completed_signals");
  });

  it("quarantines provider-empty shards with assertions out of coverage", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "empty-class-"));
    roots.push(cacheRoot);
    writeExtractionCacheTestManifest({
      cacheRoot, model: "test-model", systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const request = buildOfficialApiExtractionRequests(
      "I moved to Berlin.",
      [{ message_id: "m0", role: "user", content: "I moved to Berlin." }]
    )[0]!;
    const stats = newFillStats();
    const extractor = createCachingSignalExtractor({
      delegate: { extract: async () => ({ rawJson: '{"signals":[]}' }) },
      config: {
        model: "test-model",
        modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      stats
    });
    await extractor.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(request)
    });
    const cacheKey = stats.lastCacheKey!;
    expect(inspectCachedExtraction(
      cacheRoot, cacheKey, "test-model", "provider-default-v1"
    ).status).toBe("quarantined");
    const completion = inspectExtractionFillCompletion({
      cacheRoot,
      model: "test-model",
      requestProfile: "provider-default-v1",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      extractionTurns: [{
        turnContent: "I moved to Berlin.",
        turnMessages: [{ message_id: "m0", role: "user", content: "I moved to Berlin." }]
      }]
    });
    expect(completion.coverage).toBeLessThan(1);
    expect(completion.validTurns).toBe(0);
    expect(SEMANTIC_ARTIFACT_KIND).toBe("assertion_semantic_artifact_v1");
  });

  it("marks out-of-allowlist keys as plan-skipped without counting cache hits", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "empty-skip-"));
    roots.push(cacheRoot);
    writeExtractionCacheTestManifest({
      cacheRoot, model: "test-model", systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const request = buildOfficialApiExtractionRequests(
      "I moved to Berlin.",
      [{ message_id: "m0", role: "user", content: "I moved to Berlin." }]
    )[0]!;
    const stats = newFillStats();
    const extractor = createCachingSignalExtractor({
      delegate: { extract: async () => ({ rawJson: '{"signals":[{"x":1}]}' }) },
      config: {
        model: "test-model",
        modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      stats,
      executionCacheKeys: new Set()
    });
    const result = await extractor.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(request)
    });
    expect(result.extractionSkip).toBe("plan_skipped");
    expect(stats.cacheHits).toBe(0);
  });
});
