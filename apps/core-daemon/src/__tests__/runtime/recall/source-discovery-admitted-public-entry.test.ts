import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiSourceCorpus,
  buildOfficialApiSourceRequest
} from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from
  "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { writeCachedExtraction } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { NOW, RUN, WS } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY,
  canaryContentScopeCheck,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
  publicSearchRequest,
  scoreConsumption
} from "./source-discovery-public-consumption.js";
import { withBoundPublicWorker } from "./source-discovery-public-consumption-plant.js";
import {
  bindAdmittedActualModelShard,
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

      const ambiguousCorpus = officialCorpus("we planned work because we needed time.");
      const ambiguousRequest = packedRequest(ambiguousCorpus);
      expect(ambiguousRequest.source_assertions.length).toBeGreaterThan(0);
      const ambiguous = bindReceivedSourceInterpretationPayload({
        rawJson: JSON.stringify({
          interpretations: [{
            assertion_id: ambiguousRequest.source_assertions[0]!.assertion_id,
            relations: [{ predicate: { text: "we" }, arguments: [], qualifiers: [] }]
          }]
        }),
        sourceCorpus: ambiguousCorpus,
        artifactKey: "quarantine",
        request: ambiguousRequest
      });
      expect(ambiguous.status).toBe("partial");
      expect(requirePartialPublicBind(ambiguous).receive.rejections[0]?.diagnostic_reason).toBe("ambiguous");
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

  it.each(SOURCE_DISCOVERY_CANARY)("native-admitted $group control runs both lookup arms with complete context", async (canary) => {
    const corpus = officialCorpus(canary.intended);
    const request = packedRequest(corpus);
    const rawJson = canaryControlJson(corpus, canary);
    await withBoundPublicWorker({
      sourceBody: corpus, distractorBody: canary.distractor, rawJson, request,
      provenance: "native-admitted-control"
    }, async (planted, handler, receipts, client) => {
      expect(planted.bind.provenance).toBe("native-admitted-control");
      expect(planted.gistObjectIds.length).toBeGreaterThan(0);
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      for (const lookup of ["proposal", "source_text"] as const) {
        const started = receipts.length;
        const trace = await consumePublicSources({
          handler, context: CONTEXT,
          request: publicSearchRequest(canary, lookup, "source_only", "canonical"),
          receipts
        });
        const scored = scoreConsumption(canary, planted.sourceId, trace, "source_only");
        expect(scored.content.has_full_intended).toBe(true);
        expect(scored.content.has_all_required_phrases).toBe(true);
        expect(scored.content.has_forbidden_distractor).toBe(false);
        expect(scored.primary_native_visits).not.toBe("miss");
        expect(canaryContentScopeCheck(trace.termination.source_bodies[planted.sourceId] ?? "", canary)
          .has_all_required_phrases).toBe(true);
        expect(receipts.length).toBeGreaterThan(started);
        expect(trace.steps.length).toBeGreaterThan(0);
      }
      expect(fetches).toBe(0);
    });
  }, 90_000);
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
        arguments: canary.sketch.arguments.map((item) => ({
          role: item.role, phrase: { text: item.phrase }
        })),
        qualifiers: (canary.sketch.qualifiers ?? []).map((item) => ({
          role: item.role, phrase: { text: item.phrase }
        }))
      }]
    }]
  });
}
