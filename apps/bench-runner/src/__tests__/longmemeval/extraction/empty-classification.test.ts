import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOfficialApiExtractionRequests,
  OFFICIAL_API_SYSTEM_PROMPT,
  stringifyOfficialApiExtractionRequest,
  transportPackIdentity
} from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  computeCacheKey,
  inspectCachedExtraction
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { cacheFilePath, inspectCachedRawExtraction, writeCachedExtraction } from
  "../../../runs/compile-seed/cache/cache-shard.js";
import { inspectExtractionFillCompletion } from
  "../../../runs/extraction/fill/fill-completion.js";
import {
  catalogEligibilityOfAssertionCount,
  classifyExtractionEnvelope,
  EMPTY_SIGNALS_ENVELOPE,
  EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST,
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
  TEST_PROVIDER_COMPLETION_METADATA,
  TEST_CACHED_PROVIDER_COMPLETION_METADATA,
  testExtractionTransportProvenance,
  writeExtractionCacheTestManifest
} from "./extraction-cache-test-fixture.js";
import { semanticTask } from "./semantic-artifact-fixture.js";
import { inspectExtractionCacheInventory } from "../../../runs/extraction/cache-audit/inventory.js";
import { inspectBoundedMaterializationInventory } from
  "../../../runs/extraction/cache-audit/materialization/preflight-inventory.js";

const roots: string[] = [];

function inspectMaterialization(cacheRoot: string, cacheKey: string) {
  const input = { cacheRoot, cacheKeys: [cacheKey], model: "test-model", requestProfile: "provider-default-v1" as const };
  return inspectBoundedMaterializationInventory({ sourceRoot: cacheRoot,
    audited: inspectExtractionCacheInventory(input), model: input.model,
    requestProfile: input.requestProfile, maxShardBytes: 32_768 });
}

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

  it("does not treat request completion or an empty catalog as source semantic exhaustion", async () => {
    expect(catalogEligibilityOfAssertionCount(2)).toBe("eligible_assertions_present");
    expect(catalogEligibilityOfAssertionCount(0)).toBe("catalog_produced_no_eligible_assertion");
    expect(EXTRACTION_SEMANTIC_PRESERVATION_FROM_REQUEST).toBe("not_claimed_by_request_completion");
    expect(classifyExtractionEnvelope({
      rawSignalCount: 0, sourceAssertionCount: 2, planMembership: "in_plan",
      requestCompletion: "completed_empty"
    })).toBe("completed_empty");
    expect(classifyExtractionEnvelope({
      rawSignalCount: 0, sourceAssertionCount: 0, planMembership: "in_plan"
    })).toBe("deterministic_empty");
    const { inspectExtractionRawEnvelope, assertCoverageValidExtractionEnvelope } =
      await import("../../../runs/extraction/content-closure.js");
    const witnessedEmpty = inspectExtractionRawEnvelope(EMPTY_SIGNALS_ENVELOPE, {
      sourceAssertionCount: 2,
      planMembership: "in_plan",
      requestCompletion: "completed_empty"
    });
    expect(witnessedEmpty).toMatchObject({
      emptyClassification: "completed_empty",
      catalogEligibility: "eligible_assertions_present",
      semanticPreservation: "not_claimed_by_request_completion"
    });
    expect(assertCoverageValidExtractionEnvelope(witnessedEmpty)).toBe("completed_empty");
    const noEligible = inspectExtractionRawEnvelope(EMPTY_SIGNALS_ENVELOPE, {
      sourceAssertionCount: 0,
      planMembership: "in_plan"
    });
    expect(noEligible).toMatchObject({
      emptyClassification: "deterministic_empty",
      catalogEligibility: "catalog_produced_no_eligible_assertion",
      semanticPreservation: "not_claimed_by_request_completion"
    });
    expect(() => inspectExtractionRawEnvelope('{"signals":[')).toThrow(/not strict JSON/u);
    expect(() => inspectExtractionRawEnvelope("{}")).toThrow(/signals array missing/u);
  });

  it("classifies empty raw envelopes in content-closure when assertions are present", async () => {
    const { inspectExtractionRawEnvelope, assertCoverageValidExtractionEnvelope } =
      await import("../../../runs/extraction/content-closure.js");
    const classified = inspectExtractionRawEnvelope(EMPTY_SIGNALS_ENVELOPE, {
      sourceAssertionCount: 2,
      planMembership: "in_plan"
    });
    expect(classified).toMatchObject({
      rawSignalCount: 0,
      emptyClassification: "provider_empty_with_assertions"
    });
    expect(() => assertCoverageValidExtractionEnvelope(classified)).toThrow(
      /provider_empty_with_assertions/
    );
    const unclassified = inspectExtractionRawEnvelope(EMPTY_SIGNALS_ENVELOPE);
    expect(unclassified.emptyClassification).toBeUndefined();
    expect(unclassified.rawSignalCount).toBe(0);
  });

  it("counts witnessed request abstention without satisfying a semantic capability", async () => {
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
      delegate: { extract: async () => ({ rawJson: '{"signals":[]}', responseMetadata: TEST_PROVIDER_COMPLETION_METADATA }) },
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
    expect(inspectMaterialization(cacheRoot, cacheKey).descriptors).toHaveLength(1);
    expect(inspectCachedExtraction(
      cacheRoot, cacheKey, "test-model", "provider-default-v1"
    ).status).toBe("hit");
    const stored = JSON.parse(await readFile(cacheFilePath(cacheRoot, cacheKey), "utf8"));
    expect(stored).toMatchObject({ empty_classification: "completed_empty",
      request_completion: { version: 1, status: "completed_empty" },
      response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA,
      transport_provenance: { model: "test-model" } });
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
    expect(completion.coverage).toBe(1);
    expect(completion.validTurns).toBe(1);
    expect(inspectCachedRawExtraction(
      cacheRoot, cacheKey, "test-model", "provider-default-v1"
    ).status).toBe("hit");
    const delegate = { extract: vi.fn(async () => { throw new Error("cache reopen must not dispatch"); }) };
    const reopened = createCachingSignalExtractor({ delegate, cacheRoot, allowLiveExtraction: false,
      config: { model: "test-model", providerUrl: TEST_EXTRACTION_PROVIDER_URL, requestProfile: "provider-default-v1" } });
    expect(await reopened.extract({ systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(request) })).toMatchObject({ rawJson: EMPTY_SIGNALS_ENVELOPE });
    expect(delegate.extract).not.toHaveBeenCalled();
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

  it("settles a witnessed provider-empty request without reserving another attempt", async () => {
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
          return { rawJson: EMPTY_SIGNALS_ENVELOPE, responseMetadata: TEST_PROVIDER_COMPLETION_METADATA };
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
      successfulShards: 1,
      pendingKeys: []
    });
  });

  it.each([undefined, "provider_empty_with_assertions"] as const)(
    "preserves legacy %s empties as diagnostic quarantine and refuses extraction without dispatch", async (classification) => {
      const cacheRoot = await mkdtemp(join(tmpdir(), "legacy-empty-"));
      roots.push(cacheRoot);
      const request = buildOfficialApiExtractionRequests("I moved to Berlin.", [])[0]!;
      const userPrompt = stringifyOfficialApiExtractionRequest(request);
      const key = computeCacheKey("test-model", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, userPrompt);
      writeCachedExtraction(cacheRoot, key, { model: "test-model", request_profile: "provider-default-v1",
        cache_key: key, raw_json: EMPTY_SIGNALS_ENVELOPE, extracted_at: "2023-01-01T00:00:00.000Z",
        empty_classification: classification, response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA });
      const before = await readFile(cacheFilePath(cacheRoot, key), "utf8");
      expect(inspectCachedExtraction(cacheRoot, key, "test-model", "provider-default-v1").status).toBe("quarantined");
      expect(inspectCachedRawExtraction(cacheRoot, key, "test-model", "provider-default-v1"))
        .toMatchObject({ status: "quarantined", rawJson: EMPTY_SIGNALS_ENVELOPE });
      expect(inspectMaterialization(cacheRoot, key)).toMatchObject({ descriptors: [],
        inventory: { shards: [{ status: "invalid" }] } });
      const delegate = { extract: vi.fn(async () => { throw new Error("must not dispatch"); }) };
      const extractor = createCachingSignalExtractor({ delegate, cacheRoot,
        config: { model: "test-model", providerUrl: TEST_EXTRACTION_PROVIDER_URL, requestProfile: "provider-default-v1" } });
      await expect(extractor.extract({ systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, userPrompt })).rejects.toThrow("quarantined");
      expect(delegate.extract).not.toHaveBeenCalled();
      expect(await readFile(cacheFilePath(cacheRoot, key), "utf8")).toBe(before);
    });

  it("refuses an unwitnessed live empty response before cache publication", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "unwitnessed-empty-"));
    roots.push(cacheRoot);
    writeExtractionCacheTestManifest({ cacheRoot, model: "test-model", systemPrompt: OFFICIAL_API_SYSTEM_PROMPT });
    const request = buildOfficialApiExtractionRequests("I moved to Berlin.", [])[0]!;
    const userPrompt = stringifyOfficialApiExtractionRequest(request);
    const key = computeCacheKey("test-model", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, userPrompt);
    const extractor = createCachingSignalExtractor({ cacheRoot,
      config: { model: "test-model", providerUrl: TEST_EXTRACTION_PROVIDER_URL, requestProfile: "provider-default-v1" },
      delegate: { extract: async () => ({ rawJson: EMPTY_SIGNALS_ENVELOPE }) } });
    await expect(extractor.extract({ systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, userPrompt })).rejects.toThrow();
    await expect(stat(cacheFilePath(cacheRoot, key))).rejects.toMatchObject({ code: "ENOENT" });
    expect(inspectCachedRawExtraction(cacheRoot, key, "test-model", "provider-default-v1").status).toBe("missing");
  });

  it.each([
    { request_completion: undefined },
    { request_completion: { version: 2, status: "completed_empty" } },
    { transport_provenance: undefined },
    { response_metadata: undefined },
    { response_metadata: { finish_reason: "STOP" } },
    { response_metadata: { ...TEST_CACHED_PROVIDER_COMPLETION_METADATA, finish_reason: "length" } },
    { raw_json: '{"signals":[' },
    { raw_json: '{"signals":[{}]}' }
  ])("rejects contradictory or unwitnessed stored completion: %j", async (changes) => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "invalid-completed-empty-"));
    roots.push(cacheRoot);
    const key = "c".repeat(64);
    const entry = { model: "test-model", request_profile: "provider-default-v1" as const,
      cache_key: key, raw_json: EMPTY_SIGNALS_ENVELOPE, extracted_at: "2023-01-01T00:00:00.000Z",
      empty_classification: "completed_empty" as const, request_completion: { version: 1 as const, status: "completed_empty" as const },
      transport_provenance: testExtractionTransportProvenance("test-model"), response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA };
    // Corrupt persisted data deliberately bypasses the typed writer contract.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(cacheRoot, key.slice(0, 2)));
    await writeFile(cacheFilePath(cacheRoot, key), JSON.stringify({ ...entry, ...changes }));
    expect(inspectCachedExtraction(cacheRoot, key, "test-model", "provider-default-v1").status).toBe("invalid");
    expect(inspectCachedRawExtraction(cacheRoot, key, "test-model", "provider-default-v1").status).toBe("invalid");
    expect(inspectMaterialization(cacheRoot, key).descriptors).toEqual([]);
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
