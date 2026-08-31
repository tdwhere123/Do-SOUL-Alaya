import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT, OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import {
  createCachingSignalExtractor,
  createCompileSeedRunner,
  createGardenHttpExtractor,
  extractContentFromChatCompletionBody,
  resolveCompileSeedExtractionConfig,
  toSeedExtractionPathKpi,
  type BenchSignalExtractor,
  type CompileSeedExtractionConfig,
  type CompileSeedExtractionStats
} from "../../../runs/compile-seed.js";
import type { BenchSignalSeedInput, SeededMemoryResult } from "../../../harness/daemon.js";
import { createUnscoredMaterializedSeedError } from "../../../harness/seeding/seed-errors.js";
import {
  buildCompileSeedDaemon,
  CREDENTIALLED_CONFIG,
  providerBackedResult,
  OFFLINE_CONFIG,
  makeSeed,
  signalsEnvelope
} from "./compile-seed-fixture.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";
import { buildGroundedSignalResponse } from "../extraction-fill/fixture.js";
import {
  computeExtractionTurnCacheKeys,
  computeExtractionTurnCacheKey,
  computeSourceTurnCacheKeys,
  computeSourceTurnCacheKey
} from "../../../runs/compile-seed/compile-seed-cache.js";
import { writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";

describe("canonical extraction request cache identity", () => {
  let cacheRoot: string;

  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), "compile-seed-promptshape-"));
  });

  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });

  it("derives one raw cache key for each bounded assertion batch", () => {
    const source = Array.from(
      { length: 9 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");
    const input = { turnContent: source };

    const sourceKeys = computeSourceTurnCacheKeys(
      "test-model", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT, input
    );
    const turnKeys = computeExtractionTurnCacheKeys(
      "test-model", "provider-default-v1", OFFICIAL_API_SYSTEM_PROMPT,
      { ...input, turnMessages: [] }
    );

    expect(sourceKeys).toHaveLength(2);
    expect(turnKeys).toEqual(sourceKeys);
    expect(new Set(sourceKeys)).toHaveLength(2);
  });

  it("accounts and receipts every bounded shard in one seed turn", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: CREDENTIALLED_CONFIG.model,
      providerUrl: CREDENTIALLED_CONFIG.providerUrl,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const runner = createCompileSeedRunner({
      config: CREDENTIALLED_CONFIG,
      cacheRoot,
      allowLiveExtraction: true,
      extractorFactory: () => ({
        extract: vi.fn(async () => providerBackedResult('{"signals":[]}'))
      })
    });
    const source = Array.from(
      { length: 9 },
      (_, index) => `I recorded durable detail number ${index + 1}.`
    ).join(" ");

    await runner.seedTurn({
      daemon: buildCompileSeedDaemon(() => makeSeed("unexpected")),
      turnContent: source,
      evidenceRefBase: "q-1-s0-r0",
      seedIndex: 0,
      workspaceId: "workspace-1",
      runId: "run-1"
    });

    expect(runner.stats.extractionAttempts).toBe(2);
    expect(runner.stats.llmCalls).toBe(2);
    expect(runner.stats.lastExtractionShards).toHaveLength(2);
    expect(runner.stats.lastExtractionShards?.map(({ cacheKey }) => cacheKey)).toEqual(
      computeSourceTurnCacheKeys(
        CREDENTIALLED_CONFIG.model,
        CREDENTIALLED_CONFIG.requestProfile,
        OFFICIAL_API_SYSTEM_PROMPT,
        { turnContent: source }
      )
    );
  });

  it("the production provider's userPrompt carries only the canonical assertion catalog", async () => {
    let capturedUserPrompt: string | null = null;
    const capturingExtractor: BenchSignalExtractor = {
      extract: async (input) => {
        capturedUserPrompt = input.userPrompt;
        return providerBackedResult('{"signals":[]}');
      }
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: capturingExtractor
    });

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1700000000000",
      surface_id: null,
      turn_messages: []
    });

    expect(capturedUserPrompt).not.toBeNull();
    const parsed = JSON.parse(capturedUserPrompt as unknown as string) as Record<
      string,
      unknown
    >;
    expect(parsed).toEqual({
      schema_version: 2,
      source_locator_contract_version: 2,
      batch_contract_version: 1,
      source_corpus_identity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      batch_index: 0,
      batch_count: 1,
      source_assertions: [{ assertion_id: 1, text: "User: I moved to Berlin last spring." }]
    });
  });

  it("the cache hits for the same turn across a different run_id, end to end", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    // Full-chain check: run_id is absent from the canonical request and cannot
    // change a cache identity.
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) =>
        providerBackedResult(buildGroundedSignalResponse(input.userPrompt)))
    };
    const cachingExtractor = createCachingSignalExtractor({
      delegate,
      config: {
        model: "test-model", modelFamily: "test-model",
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        requestProfile: "provider-default-v1"
      },
      cacheRoot
    });
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: cachingExtractor
    });

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1700000000000",
      surface_id: null,
      turn_messages: []
    });
    expect(delegate.extract).toHaveBeenCalledOnce();

    await provider.compile("I moved to Berlin last spring.", {
      workspace_id: "ws-1",
      run_id: "run-cq-abc-1799999999999",
      surface_id: null,
      turn_messages: []
    });
    expect(delegate.extract).toHaveBeenCalledOnce();
  });

  it("passes the live semantic validator through the cache delegate boundary", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) => {
        input.validateRawJson?.('{"signals":[42]}');
        return providerBackedResult('{"signals":[]}');
      })
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({
        delegate,
        config: testCacheConfig(),
        cacheRoot,
      })
    });

    await expect(provider.compile("I moved to Berlin.", {
      workspace_id: "ws-1", run_id: "run-validator", surface_id: null,
      turn_messages: []
    })).rejects.toMatchObject({ kind: "invalid_response" });
    expect(delegate.extract).toHaveBeenCalledOnce();
  });

  it("does not reuse a shard when the User assertion catalog changes", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async (input) =>
        providerBackedResult(buildGroundedSignalResponse(input.userPrompt)))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({
        delegate,
        config: {
          model: "test-model", modelFamily: "test-model",
          providerUrl: TEST_EXTRACTION_PROVIDER_URL,
          requestProfile: "provider-default-v1"
        },
        cacheRoot
      })
    });
    const turnContent = "User: I chose A.\nAssistant: You chose B.";

    await provider.compile(turnContent, {
      workspace_id: "ws-1", run_id: "run-1", surface_id: null,
      turn_messages: [
        { message_id: "m1", role: "user", content: "I chose A." },
        { message_id: "m2", role: "assistant", content: "You chose B." }
      ]
    });
    await provider.compile(turnContent, {
      workspace_id: "ws-1", run_id: "run-2", surface_id: null,
      turn_messages: [
        { message_id: "m3", role: "assistant", content: "I chose A." },
        { message_id: "m4", role: "user", content: "You chose B." }
      ]
    });

    expect(delegate.extract).toHaveBeenCalledTimes(2);
  });

  it("replays a non-empty canonical shard against its assertion id", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const source = "I use TypeScript, but I avoid any.";
    const messages = [{ message_id: "m1", role: "user" as const, content: source }];
    const canonicalKey = computeSourceTurnCacheKey(
      "test-model",
      "provider-default-v1",
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: source, turnMessages: messages }
    );
    writeCachedExtraction(cacheRoot, canonicalKey, {
      model: "test-model",
      request_profile: "provider-default-v1",
      cache_key: canonicalKey,
      raw_json: JSON.stringify({ signals: [{
        signal_kind: "potential_claim",
        object_kind: "activity",
        confidence: 0.9,
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 3
        },
        matched_text: "I avoid any.",
        distilled_fact: "I avoid any.",
        semantic_factor_graph: {
          schema_version: 2,
          source_kind: "evidence",
          factors: [{
            factor_id: "f0",
            surface: "avoid",
            semantic_identity: "avoid"
          }, {
            factor_id: "f1",
            surface: "any",
            semantic_identity: "any"
          }],
          variables: [],
          result_variable_ids: [],
          propositions: [{
            proposition_id: "p0",
            predicate_factor_id: "f0",
            arguments: [{
              position: 0,
              binding_identity: "object",
              reference_kind: "factor",
              reference_id: "f1"
            }]
          }]
        }
      }] }),
      extracted_at: "2026-07-22T00:00:00.000Z"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedResult('{"signals":[]}'))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({ delegate, config: testCacheConfig(), cacheRoot })
    });

    const [signal] = await provider.compile(source, {
      workspace_id: "ws-1", run_id: "run-legacy-id", surface_id: null,
      turn_messages: messages
    });

    expect(delegate.extract).not.toHaveBeenCalled();
    expect(signal?.raw_payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: "I avoid any."
    });
  });

  it("uses the same changed-catalog key in preflight and the live provider", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const source = "The play I attended was actually a production of The Glass Menagerie, have you heard of it?";
    const messages = [{ message_id: "m1", role: "user" as const, content: source }];
    const cacheKey = computeExtractionTurnCacheKey(
      "test-model",
      "provider-default-v1",
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: source, turnMessages: messages }
    );
    writeCachedExtraction(cacheRoot, cacheKey, {
      model: "test-model",
      request_profile: "provider-default-v1",
      cache_key: cacheKey,
      raw_json: '{"signals":[]}',
      extracted_at: "2026-07-22T00:00:00.000Z"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedResult('{"signals":[]}'))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({
        delegate,
        config: testCacheConfig(),
        cacheRoot
      })
    });

    await provider.compile(source, {
      workspace_id: "ws-1", run_id: "run-catalog-preflight", surface_id: null,
      turn_messages: messages
    });

    expect(delegate.extract).not.toHaveBeenCalled();
  });

  it("uses the same changed-catalog key without trusted turn messages", async () => {
    writeExtractionCacheTestManifest({
      cacheRoot,
      model: "test-model",
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT
    });
    const source = "I actually redeemed a $5 coupon on coffee creamer last Sunday, which was a nice surprise.";
    const cacheKey = computeSourceTurnCacheKey(
      "test-model",
      "provider-default-v1",
      OFFICIAL_API_SYSTEM_PROMPT,
      { turnContent: source }
    );
    writeCachedExtraction(cacheRoot, cacheKey, {
      model: "test-model",
      request_profile: "provider-default-v1",
      cache_key: cacheKey,
      raw_json: '{"signals":[]}',
      extracted_at: "2026-07-22T00:00:00.000Z"
    });
    const delegate: BenchSignalExtractor = {
      extract: vi.fn(async () => providerBackedResult('{"signals":[]}'))
    };
    const provider = new OfficialApiGardenProvider({
      apiKey: "test-key",
      model: "test-model",
      extractor: createCachingSignalExtractor({
        delegate,
        config: testCacheConfig(),
        cacheRoot
      })
    });

    await provider.compile(source, {
      workspace_id: "ws-1", run_id: "run-catalog-text-only", surface_id: null,
      turn_messages: []
    });

    expect(delegate.extract).not.toHaveBeenCalled();
  });
});

function testCacheConfig(): CompileSeedExtractionConfig {
  return {
    model: "test-model",
    modelFamily: "test-model",
    providerUrl: TEST_EXTRACTION_PROVIDER_URL,
    requestProfile: "provider-default-v1",
    apiKey: "test-key"
  };
}
