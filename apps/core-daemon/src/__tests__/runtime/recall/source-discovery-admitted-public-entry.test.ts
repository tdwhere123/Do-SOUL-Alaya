import { bindNativeControl } from "./source-discovery-native-control.js";
import { aggregateAdmittedUtility, runAdmittedPublicMatrix } from "./source-discovery-admitted-matrix.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EXTRACTION_SOURCE_PACKING } from "@do-soul/alaya-protocol";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiSourceCorpus,
  buildOfficialApiSourceRequest,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from
  "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import { readCachedEntry, writeCachedExtraction } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { importExtractionResponse } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/compile-seed-cache.js";
import { acquireExtractionCacheWriteLease } from
  "../../../../../../apps/bench-runner/src/runs/extraction/fill/manifest/fill-root-guard.js";
import {
  computeCacheKey,
  EXTRACTION_CACHE_KEY_GOLDEN_VECTOR
} from "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-key.js";
import {
  EXTRACTION_CACHE_KEY_ALGO
} from "../../../../../../apps/bench-runner/src/runs/extraction/cache/extraction-cache-manifest.js";
import { EXTRACTION_REQUEST_COMPLETION_VERSION } from
  "../../../../../../apps/bench-runner/src/runs/extraction/empty-classification.js";
import {
  TEST_CACHED_PROVIDER_COMPLETION_METADATA,
  TEST_EXTRACTION_PROVIDER_URL,
  TEST_PROVIDER_COMPLETION_METADATA,
  testExtractionTransportProvenance,
  writeExtractionCacheTestManifest
} from "../../../../../../apps/bench-runner/src/__tests__/longmemeval/extraction/extraction-cache-test-fixture.js";
import { buildExtractionTransportProvenance } from
  "../../../../../../apps/bench-runner/src/runs/extraction/transport-route.js";

import { NOW, RUN, WS } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import {
  bindAdmittedActualModelShard,
  bindNativeAdmittedControlShard,
  bindReceivedExtractionShard,
  bindReceivedSourceInterpretationPayload,
  expectedExtractionCacheKey,
  publishBoundPublicSources,
  requirePartialPublicBind
} from "./source-discovery-admitted-public-publication.js";

const SHARD_MODEL = "gemini-3.1-flash-lite";
const SHARD_PROFILE = "gemini-3.1-low-v1";
const CONTEXT = { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" } as const;
const previousFetch = globalThis.fetch;
let fetches = 0;

describe("admitted public consumption entry", () => {
  assertBuiltWorker();

  beforeEach(() => {
    fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("provider forbidden in admitted public entry");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("rejects an independently supplied cache key that does not match generation identity", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-wrong-key-"));
    const corpus = officialCorpus(SOURCE_DISCOVERY_CANARY[0]!.intended);
    const request = packedRequest(corpus);
    try {
      const bind = bindReceivedExtractionShard({
        cacheRoot,
        cacheKey: "cd".repeat(32),
        model: SHARD_MODEL,
        requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        sourceCorpus: corpus,
        artifactKey: "wrong-key",
        request
      });
      expect(bind).toMatchObject({ status: "invalid", reason: "generation_identity_mismatch" });
      expect(bindAdmittedActualModelShard({
        cacheRoot,
        cacheKey: "cd".repeat(32),
        model: SHARD_MODEL,
        requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        sourceCorpus: corpus,
        artifactKey: "wrong-key",
        request
      }).status).toBe("not_exercised");
      expect(fetches).toBe(0);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("does not treat same-text foreign corpus or prompt as the selected generation", () => {
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const corpus = officialCorpus(canary.intended);
    const foreign = officialCorpus(`${canary.intended} Extra context.`);
    const request = packedRequest(corpus);
    const rawJson = canaryControlJson(corpus, canary);
    const foreignBind = bindReceivedSourceInterpretationPayload({
      rawJson, sourceCorpus: foreign, artifactKey: "foreign", request
    });
    expect(foreignBind.status).toBe("invalid");
    expect(foreignBind.status === "invalid" ? foreignBind.reason : undefined).toBe("source_assertion_mismatch");
    const actual = bindAdmittedActualModelShard({
      cacheRoot: "/tmp",
      model: SHARD_MODEL,
      requestProfile: SHARD_PROFILE,
      systemPrompt: `${OFFICIAL_API_SYSTEM_PROMPT} foreign-prompt`,
      sourceCorpus: corpus,
      artifactKey: "foreign-prompt",
      request
    });
    expect(actual.status).toBe("not_exercised");
    expect(fetches).toBe(0);
  });

  it("keeps missing, quarantined and authored cache fixtures out of actual-model results", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-actual-model-"));
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const corpus = officialCorpus(canary.intended);
    const request = packedRequest(corpus);
    const rawJson = canaryControlJson(corpus, canary);
    const cacheKey = expectedExtractionCacheKey({
      model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, request
    });
    try {
      const missing = bindAdmittedActualModelShard({
        cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
        artifactKey: "actual", request
      });
      expect(missing).toMatchObject({ status: "not_exercised", reason: "missing_admitted_shard" });

      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: rawJson, extracted_at: NOW
      });
      writeExtractionCacheTestManifest({
        cacheRoot, model: SHARD_MODEL, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requestProfile: SHARD_PROFILE
      });
      const authored = bindReceivedExtractionShard({
        cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
        artifactKey: "actual", request
      });
      expect(authored.status === "complete" ? authored.provenance : authored.status).toBe("cache-authored");
      expect(bindAdmittedActualModelShard({
        cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
        artifactKey: "actual", request
      })).toMatchObject({ status: "not_exercised", reason: "cache-authored" });

      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: '{"interpretations":[]}', extracted_at: NOW,
        empty_classification: "provider_empty_with_assertions"
      });
      expect(bindAdmittedActualModelShard({
        cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
        artifactKey: "actual", request
      })).toMatchObject({ status: "not_exercised" });
      expect(fetches).toBe(0);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("does not publish valid siblings from an incomplete request", () => {
    const corpus = officialCorpus(SOURCE_DISCOVERY_CANARY[0]!.intended);
    const request = packedRequest(corpus);
    const first = request.source_assertions[0]!;
    const needle = first.text.match(/[A-Za-z]{4,}/u)?.[0] ?? "Shadow";
    const bind = requirePartialPublicBind(bindReceivedSourceInterpretationPayload({
      rawJson: JSON.stringify({
        interpretations: [{
          assertion_id: first.assertion_id,
          relations: [
            { predicate: { text: needle }, arguments: [], qualifiers: [] },
            { predicate: { text: "invented-absent" }, arguments: [], qualifiers: [] }
          ]
        }]
      }),
      sourceCorpus: corpus,
      artifactKey: "sibling",
      request
    }));
    expect(bind.receive.located.some((row) => row.outcome === "candidates")).toBe(true);
    expect(bind.receive.status).toBe("partial");
    expect(publishBoundPublicSources({
      database: { connection: { prepare: () => ({ run: () => undefined, all: () => [] }) } } as never,
      source: { body: corpus, rootId: "root", digest: "d".repeat(64), evidenceObjectId: null },
      workspaceId: CONTEXT.workspaceId, runId: CONTEXT.runId, now: NOW, bind
    }).gist_object_ids).toEqual([]);
    expect(fetches).toBe(0);
  });

  it("pins the cache-key golden vector independently of the bind helper", () => {
    expect(computeCacheKey(
      EXTRACTION_CACHE_KEY_GOLDEN_VECTOR.model,
      EXTRACTION_CACHE_KEY_GOLDEN_VECTOR.requestProfile,
      EXTRACTION_CACHE_KEY_GOLDEN_VECTOR.systemPrompt,
      EXTRACTION_CACHE_KEY_GOLDEN_VECTOR.extractionRequest
    )).toBe(EXTRACTION_CACHE_KEY_ALGO);
    expect(fetches).toBe(0);
  });

  it("rejects actual-model binds that lack manifest, completion, or generation identity", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-actual-provenance-"));
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const corpus = officialCorpus(canary.intended);
    const request = packedRequest(corpus);
    const rawJson = canaryControlJson(corpus, canary);
    const cacheKey = expectedExtractionCacheKey({
      model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, request
    });
    const bindInput = {
      cacheRoot, model: SHARD_MODEL, modelFamily: SHARD_MODEL,
      providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      sourcePacking: DEFAULT_EXTRACTION_SOURCE_PACKING,
      requestProfile: SHARD_PROFILE,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
      artifactKey: "actual", request
    } as const;
    try {
      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: rawJson, extracted_at: NOW,
        empty_classification: "completed_signals",
        transport_provenance: testExtractionTransportProvenance(SHARD_MODEL),
        request_completion: { version: EXTRACTION_REQUEST_COMPLETION_VERSION, status: "completed_signals" },
        response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA
      });
      expect(bindAdmittedActualModelShard(bindInput)).toMatchObject({
        status: "not_exercised", reason: "missing_cache_manifest"
      });

      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: rawJson, extracted_at: NOW,
        empty_classification: "completed_signals",
        transport_provenance: testExtractionTransportProvenance(SHARD_MODEL),
        response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA
      });
      writeExtractionCacheTestManifest({
        cacheRoot, model: SHARD_MODEL, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requestProfile: SHARD_PROFILE
      });
      expect(bindAdmittedActualModelShard(bindInput)).toMatchObject({
        status: "not_exercised", reason: "unbound_transport_metadata"
      });

      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: rawJson, extracted_at: NOW,
        empty_classification: "completed_signals",
        transport_provenance: testExtractionTransportProvenance(SHARD_MODEL),
        request_completion: { version: EXTRACTION_REQUEST_COMPLETION_VERSION, status: "completed_signals" },
        response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA
      });
      writeExtractionCacheTestManifest({
        cacheRoot, model: SHARD_MODEL, systemPrompt: `${OFFICIAL_API_SYSTEM_PROMPT} drift`,
        requestProfile: SHARD_PROFILE
      });
      expect(bindAdmittedActualModelShard(bindInput)).toMatchObject({
        status: "not_exercised", reason: "cache_identity_mismatch"
      });

      writeExtractionCacheTestManifest({
        cacheRoot, model: SHARD_MODEL, systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        requestProfile: SHARD_PROFILE
      });
      expect(bindAdmittedActualModelShard({
        ...bindInput, systemPrompt: `${OFFICIAL_API_SYSTEM_PROMPT} foreign-prompt`
      })).toMatchObject({ status: "not_exercised" });
      expect(bindAdmittedActualModelShard({
        ...bindInput, requestProfile: "provider-default-v1"
      })).toMatchObject({ status: "not_exercised" });
      expect(bindAdmittedActualModelShard({
        ...bindInput, request: packedRequest(officialCorpus(`${canary.intended} Extra.`))
      }).status).toBe("not_exercised");
      expect(bindAdmittedActualModelShard(bindInput)).toMatchObject({
        status: "not_exercised", reason: "transport_generation_mismatch"
      });
      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL, request_profile: SHARD_PROFILE, cache_key: cacheKey,
        raw_json: rawJson, extracted_at: NOW,
        empty_classification: "completed_signals",
        transport_provenance: buildExtractionTransportProvenance({
          model: SHARD_MODEL, providerUrl: TEST_EXTRACTION_PROVIDER_URL
        }),
        request_completion: { version: EXTRACTION_REQUEST_COMPLETION_VERSION, status: "completed_signals" },
        response_metadata: TEST_CACHED_PROVIDER_COMPLETION_METADATA
      });
      expect(bindAdmittedActualModelShard(bindInput)).toMatchObject({
        status: "not_exercised", reason: "missing_admission_identity"
      });
      expect(fetches).toBe(0);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("keeps native imported controls separate from actual-model provider evidence", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-native-admit-"));
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const corpus = officialCorpus(canary.intended);
    const request = packedRequest(corpus);
    const rawJson = canaryControlJson(corpus, canary);
    const cacheKey = expectedExtractionCacheKey({
      model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, request
    });
    const family = "flash-lite-family";
    writeExtractionCacheTestManifest({
      cacheRoot, model: SHARD_MODEL, modelFamily: family,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, requestProfile: SHARD_PROFILE
    });
    const lease = acquireExtractionCacheWriteLease(cacheRoot);
    try {
      importExtractionResponse({
        config: {
          model: SHARD_MODEL,
          modelFamily: family,
          providerUrl: TEST_EXTRACTION_PROVIDER_URL,
          requestProfile: SHARD_PROFILE
        },
        cacheRoot,
        writeLease: lease,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        userPrompt: stringifyOfficialApiExtractionRequest(request),
        expectedCacheKey: cacheKey,
        sourceCorpus: corpus,
        result: { rawJson, responseMetadata: TEST_PROVIDER_COMPLETION_METADATA }
      });
      const bindInput = {
        cacheRoot, model: SHARD_MODEL, modelFamily: family,
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        sourcePacking: DEFAULT_EXTRACTION_SOURCE_PACKING,
        requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: corpus,
        artifactKey: "actual", request
      } as const;
      const admitted = bindAdmittedActualModelShard(bindInput);
      expect(admitted).toMatchObject({ status: "not_exercised", reason: "missing_retained_provider_evidence", cacheKey });
      expect(bindNativeAdmittedControlShard(bindInput)).toMatchObject({ status: "complete", provenance: "native-admitted-control", cacheKey });
      const alternateCorpus = officialCorpus(`${canary.intended}\n\nA different surrounding context.`);
      const alternateRequest = packedRequest(alternateCorpus);
      const alternateKey = expectedExtractionCacheKey({ ...bindInput, request: alternateRequest });
      const cached = readCachedEntry(cacheRoot, cacheKey, SHARD_MODEL, SHARD_PROFILE);
      if (cached.status !== "hit") throw new Error("native admitted control missing");
      writeCachedExtraction(cacheRoot, alternateKey, { ...cached.entry, cache_key: alternateKey });
      expect(bindNativeAdmittedControlShard({ ...bindInput, sourceCorpus: alternateCorpus, request: alternateRequest }))
        .toMatchObject({ status: "not_exercised", reason: "admission_request_mismatch" });
      const mechanism = bindReceivedExtractionShard(bindInput);
      expect(mechanism.status === "complete" ? mechanism.provenance : mechanism.status).toBe("cache-authored");
      expect(fetches).toBe(0);
    } finally {
      lease.release();
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("native-admitted three-group population runs the complete paired matrix after SQLite reopen", async () => {
    const corpus = officialCorpus(SOURCE_DISCOVERY_CANARY.map((canary) => canary.intended).join("\n\n"));
    const request = packedRequest(corpus);
    const rawJson = JSON.stringify({ interpretations: SOURCE_DISCOVERY_CANARY.flatMap((canary) =>
      JSON.parse(canaryControlJson(corpus, canary)).interpretations) });
    const bind = bindNativeControl({ rawJson, sourceCorpus: corpus, request, artifactKey: "native-control-population" });
    expect(bind).toMatchObject({ status: "complete", provenance: "native-admitted-control" });
    const matrix = await runAdmittedPublicMatrix({ bind, sourceCorpus: corpus,
      evidenceDirectory: process.env.ALAYA_ADMISSION_EVIDENCE_DIRECTORY });
    expect(matrix.file_failed).toBe(false);
    expect(matrix.failed).toEqual([]);
    expect(matrix.completed).toHaveLength(matrix.selected.length);
    expect(matrix.utility.content_scope.every((group) => group.complete)).toBe(true);
    expect(aggregateAdmittedUtility(matrix.rows.slice(1), matrix.selected.length, false).accepted).toBe(false);
    expect(aggregateAdmittedUtility(matrix.rows, matrix.selected.length, true).accepted).toBe(false);
    expect(matrix.rows.filter((row) => row.view !== "memory_only").every((row) =>
      typeof row.score?.primary_native_visits === "number")).toBe(true);
    expect(fetches).toBe(0);
  }, 120_000);
});

function officialCorpus(text: string): string {
  return buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
}

function packedRequest(corpus: string) {
  const catalog = indexOfficialApiSourceAssertions(corpus);
  return buildOfficialApiSourceRequest(corpus, catalog.map((row) => row.assertion_id));
}

function canaryControlJson(corpus: string, canary: CanaryCase): string {
  const assertion = indexOfficialApiSourceAssertions(corpus)
    .find((row) => row.text.includes(canary.sketch.predicate));
  if (assertion === undefined) throw new Error(`catalog has no ${canary.group} predicate`);
  return JSON.stringify({
    interpretations: [{
      assertion_id: assertion.assertion_id,
      relations: [{
        predicate: { text: canary.sketch.predicate },
        arguments: (canary.sketch.arguments ?? []).map((item) => ({
          role: item.role, phrase: { text: item.phrase }
        })),
        qualifiers: (canary.sketch.qualifiers ?? []).map((item) => ({
          role: item.role, phrase: { text: item.phrase }
        }))
      }]
    }]
  });
}
