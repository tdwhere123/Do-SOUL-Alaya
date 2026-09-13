import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOfficialApiExtractionRequests,
  OFFICIAL_API_SYSTEM_PROMPT,
  stringifyOfficialApiExtractionRequest,
  transportPackIdentity
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  inspectCachedExtraction
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { inspectCachedRawExtraction } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectExtractionFillCompletion } from
  "../../../runs/extraction/fill/fill-completion.js";
import {
  classifyExtractionEnvelope,
  EMPTY_SIGNALS_ENVELOPE,
  isPlanSkippedExtraction,
  PLAN_SKIPPED_EXTRACTION_ENVELOPE
} from "../../../runs/extraction/empty-classification.js";
import { admitProviderRaw, semanticPackRequestSha256 } from
  "../../../runs/extraction/cache/semantic-artifact/admit.js";
import { currentSemanticReplayAuthority } from
  "../../../runs/extraction/cache/semantic-artifact/replay-authority.js";
import { openExtractionAttemptLedger } from
  "../../../runs/extraction/authority/attempt-ledger.js";
import { newFillStats } from "../../../runs/extraction/fill/fill-stats.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import { semanticTask } from "./semantic-artifact-fixture.js";

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
      [{ role: "user", content: "I moved to Berlin." }]
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
    expect(inspectCachedRawExtraction(
      cacheRoot, cacheKey, "test-model", "provider-default-v1"
    ).status).toBe("quarantined");
    const task = semanticTask("I moved to Berlin.");
    const semanticRoot = await mkdtemp(join(tmpdir(), "empty-semantic-"));
    roots.push(semanticRoot);
    const packIdentity = transportPackIdentity("token_aware", [task.semanticKey]);
    const [admission] = admitProviderRaw({
      root: semanticRoot,
      rawJson: EMPTY_SIGNALS_ENVELOPE,
      tasks: [task],
      replayAuthority: currentSemanticReplayAuthority(),
      rawBinding: {
        packIdentity,
        requestSha256: semanticPackRequestSha256({
          packIdentity,
          sourceCorpusIdentity: task.binding.sourceCorpusIdentity,
          sourceAuthority: task.sourceAuthority,
          members: [{
            semanticKey: task.semanticKey,
            assertionId: task.assertionId,
            text: task.text
          }]
        }),
        sourceCorpusIdentity: task.binding.sourceCorpusIdentity,
        policyKind: "token_aware",
        memberSemanticKeys: [task.semanticKey]
      }
    });
    expect(admission?.kind).toBe("quarantined");
    expect(admission && "admission" in admission ? admission.admission.state : undefined)
      .toBe("quarantined");
  });

  it("abandons a reserved live provider-empty shard without committing success", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "empty-pending-"));
    roots.push(cacheRoot);
    writeExtractionCacheTestManifest({
      cacheRoot, model: "test-model", systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const request = buildOfficialApiExtractionRequests(
      "I moved to Berlin.",
      [{ role: "user", content: "I moved to Berlin." }]
    )[0]!;
    const ledger = openExtractionAttemptLedger({
      cacheRoot,
      lineageDigest: "a".repeat(64),
      cacheIdentity: { model: "test-model", requestProfile: "provider-default-v1" },
      startingMissing: 1,
      maximumAttempts: 2,
      successfulShardCeiling: 1
    });
    const extractor = createCachingSignalExtractor({
      delegate: {
        extract: async (input) => {
          await input.onTransportAttempt?.(input.abortSignal);
          return { rawJson: EMPTY_SIGNALS_ENVELOPE };
        }
      },
      config: {
        model: "test-model",
        modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot,
      onTransportAttempt: ledger.reserveAttempt,
      onLiveProviderExtractionSucceeded: ledger.commitSuccessfulShard,
      onLiveExtractionFailed: ledger.abandonPendingShard,
      onLiveExtractionOutcome: ledger.recordTransportOutcome
    });
    await extractor.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(request)
    });
    expect(ledger.snapshot()).toMatchObject({
      attempts: 1,
      successfulShards: 0,
      pendingKeys: []
    });
  });

  it("marks out-of-allowlist keys as plan-skipped without counting cache hits", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "empty-skip-"));
    roots.push(cacheRoot);
    writeExtractionCacheTestManifest({
      cacheRoot, model: "test-model", systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const request = buildOfficialApiExtractionRequests(
      "I moved to Berlin.",
      [{ role: "user", content: "I moved to Berlin." }]
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
    expect(isPlanSkippedExtraction(result)).toBe(true);
    expect(result.rawJson).toBe(PLAN_SKIPPED_EXTRACTION_ENVELOPE);
    expect(result.rawJson).not.toBe(EMPTY_SIGNALS_ENVELOPE);
    expect(JSON.parse(result.rawJson)).toEqual({ extraction_skip: "plan_skipped" });
    expect(stats.cacheHits).toBe(0);
  });
});
