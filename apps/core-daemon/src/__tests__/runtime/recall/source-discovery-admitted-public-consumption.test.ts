import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiSourceCorpus,
  buildOfficialApiSourceRequest
} from "@do-soul/alaya-soul";
import { indexOfficialApiSourceAssertions } from
  "../../../../../../packages/soul/src/garden/triage/grounding/source-locator.js";
import { closeCachedDatabase, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { parseBoundInterpretationGist } from
  "../../../../../../packages/core/src/recall/conditional-field/observers/source-proposal-match.js";
import { writeCachedExtraction } from
  "../../../../../../apps/bench-runner/src/runs/compile-seed/cache/cache-shard.js";
import { fieldSha256, hashedRecord } from
  "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import {
  NOW, RUN, WS, openSourceSlice
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  SOURCE_DISCOVERY_CANARY
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
  observePlantedDiscovery,
  publicSearchRequest
} from "./source-discovery-public-consumption.js";
import {
  withBoundPublicWorker,
  withPlantedSourceWorker,
  type PlantedBound
} from "./source-discovery-public-consumption-plant.js";
import {
  bindReceivedExtractionShard,
  bindReceivedSourceInterpretationPayload,
  expectedExtractionCacheKey,
  publishBoundPublicSources,
  requireCompletePublicBind,
  requirePartialPublicBind
} from "./source-discovery-admitted-public-publication.js";

const CANARY = SOURCE_DISCOVERY_CANARY[0]!;
const SHARD_MODEL = "gemini-3.1-flash-lite";
const SHARD_PROFILE = "gemini-3.1-low-v1";
const CONTEXT = { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" } as const;
const previousFetch = globalThis.fetch;
let fetches = 0;

describe("bound source interpretation public consumption", () => {
  assertBuiltWorker();

  beforeEach(() => {
    fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("provider forbidden in bound public consumption");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("requires a packed request and locates a packed 8-member slice of a larger catalog", () => {
    const corpus = packedCatalogCorpus();
    const catalog = indexOfficialApiSourceAssertions(corpus);
    expect(catalog.length).toBeGreaterThan(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH);
    const request = packedRequest(corpus);
    expect(request.source_assertions).toHaveLength(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH);
    const rawJson = packedRecordedJson(request);
    const bind = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({
      rawJson, sourceCorpus: corpus, artifactKey: "packed-slice", request
    }));
    expect(bind.receive.located).toHaveLength(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH);
    expect(bind.receive.located.every((row) => row.outcome === "candidates")).toBe(true);

    const omitted = bindReceivedSourceInterpretationPayload({
      rawJson, sourceCorpus: corpus, artifactKey: "packed-slice"
    });
    expect(omitted).toEqual({ status: "invalid", reason: "packed_request_required" });
    expect(omitted.status).not.toBe("complete");
    expect(omitted.status).not.toBe("partial");
    expect(fetches).toBe(0);
  });

  it("consumes a faithful payload control through public proposal attribution", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const request = packedRequest(corpus);
    const rawJson = faithfulPayloadControl(corpus);
    await withBoundPublicWorker({
      sourceBody: corpus, distractorBody: CANARY.distractor, rawJson, request
    }, async (planted, handler, receipts, client) => {
      expectProposalUsedPublishedGists(planted);
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      await expectPublicProposal(handler, planted.sourceId, true);
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("does not replace omitted model relations with authored sketches", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const request = packedRequest(corpus);
    const rawJson = interpretationJson(request.source_assertions.map((row) => ({
      assertion_id: row.assertion_id, relations: []
    })));
    await withBoundPublicWorker({
      sourceBody: corpus, distractorBody: CANARY.distractor, rawJson, request
    }, async (planted, handler, receipts, client) => {
      expect(planted.bind.receive.located.length).toBe(request.source_assertions.length);
      expect(planted.bind.receive.located.length).toBeGreaterThan(0);
      expect(planted.bind.receive.located.every((row) => row.outcome === "empty")).toBe(true);
      expect(planted.gistObjectIds).toEqual([]);
      expect(readGists(planted.database)).toEqual([]);
      const native = observePlantedDiscovery(
        planted.database, WS, CANARY, "proposal", "source_only", "canonical"
      );
      expect(native.lookup_kind).not.toBe("proposal");
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      await expectPublicProposal(handler, planted.sourceId, false);
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it.each([
    { label: "malformed envelope", rawJson: '{"signals":[]}' },
    { label: "absent model relation", rawJson: absentRelationRawJson() }
  ])("keeps $label locate outcomes explicit without minting completion", async ({ rawJson }) => {
    const corpus = officialCorpus(CANARY.intended);
    const request = packedRequest(corpus);
    await withPlantedSourceWorker(corpus, CANARY.distractor, (planted) => {
      const received = requirePartialPublicBind(bindReceivedSourceInterpretationPayload({
        rawJson, sourceCorpus: corpus, artifactKey: `bound-${planted.sourceId}`, request
      }));
      expect(received.receive.located.length).toBe(request.source_assertions.length);
      expect(received.receive.located.length).toBeGreaterThan(0);
      expect(received.receive.located.every((row) => row.outcome === "failed")).toBe(true);
      expect(received.receive.located.every((row) => row.diagnostics.length > 0)).toBe(true);
      const published = publishBoundPublicSources({
        database: planted.database, source: planted.source,
        workspaceId: WS, runId: RUN, now: NOW, bind: received
      });
      expect(published.gist_object_ids).toEqual([]);
      expect(readGists(planted.database)).toEqual([]);
      return {};
    }, async (planted, handler, receipts, client) => {
      const native = observePlantedDiscovery(
        planted.database, WS, CANARY, "proposal", "source_only", "canonical"
      );
      expect(native.lookup_kind).not.toBe("proposal");
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      await expectPublicProposal(handler, planted.sourceId, false);
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("does not treat a missing shard as an empty payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-bound-missing-"));
    const filename = join(directory, "alaya.db");
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-bound-cache-"));
    const corpus = officialCorpus(CANARY.intended);
    const slice = await openSourceSlice(() => {}, filename);
    try {
      const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
      const source = records.insert(hashedRecord(WS, corpus, "bound-source"));
      const bind = bindReceivedExtractionShard({
        cacheRoot,
        model: SHARD_MODEL,
        requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        sourceCorpus: corpus,
        artifactKey: "missing-shard",
        request: packedRequest(corpus)
      });
      expect(bind.status).toBe("missing");
      const published = publishBoundPublicSources({
        database: slice.database,
        source: {
          body: corpus,
          rootId: source.record_id,
          digest: source.content_digest,
          evidenceObjectId: source.evidence_object_id
        },
        workspaceId: WS,
        runId: RUN,
        now: NOW,
        bind
      });
      expect(published.gist_object_ids).toEqual([]);
      expect(readGists(slice.database)).toEqual([]);
      expect(fetches).toBe(0);
    } finally {
      try { slice.database.close(); } catch { /* closed */ }
      closeCachedDatabase(filename);
      await rm(directory, { recursive: true, force: true });
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });

  it("publishes a cache shard through the packed request and consumes proposal gists", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-bound-shard-"));
    const corpus = officialCorpus(CANARY.intended);
    const request = packedRequest(corpus);
    const rawJson = faithfulPayloadControl(corpus);
    const cacheKey = expectedExtractionCacheKey({
      model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, request
    });
    try {
      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL,
        request_profile: SHARD_PROFILE,
        cache_key: cacheKey,
        raw_json: rawJson,
        extracted_at: NOW
      });
      const omitted = bindReceivedExtractionShard({
        cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
        systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
        sourceCorpus: corpus, artifactKey: "shard-bind"
      });
      expect(omitted).toEqual({ status: "invalid", reason: "packed_request_required" });
      await withPlantedSourceWorker(corpus, CANARY.distractor, (planted) => {
        const bind = requireCompletePublicBind(bindReceivedExtractionShard({
          cacheRoot, model: SHARD_MODEL, requestProfile: SHARD_PROFILE,
          systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
          sourceCorpus: corpus, artifactKey: "shard-bind", request
        }));
        expect(bind.rawJson).toBe(rawJson);
        const published = publishBoundPublicSources({
          database: planted.database, source: planted.source,
          workspaceId: WS, runId: RUN, now: NOW, bind
        });
        return { bind, gistObjectIds: published.gist_object_ids };
      }, async (planted, handler, receipts, client) => {
        expectProposalUsedPublishedGists(planted);
        planted.database.close();
        closeCachedDatabase(planted.filename);
        await client.ready();
        await consumePublic(handler, receipts, "proposal");
        await expectPublicProposal(handler, planted.sourceId, true);
        expect(fetches).toBe(0);
      });
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  }, 90_000);

  it("locates independently specified relations without a frozen-sketch proposal hit", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const request = packedRequest(corpus);
    const rawJson = independentPayloadControl(corpus);
    await withBoundPublicWorker({
      sourceBody: corpus, distractorBody: CANARY.distractor, rawJson, request
    }, async (planted, handler, receipts, client) => {
      expect(planted.bind.receive.located.length).toBe(request.source_assertions.length);
      expect(planted.gistObjectIds.length).toBeGreaterThan(0);
      expect(readGists(planted.database).every((gist) => gist?.outcome === "candidates")).toBe(true);
      const native = observePlantedDiscovery(
        planted.database, WS, CANARY, "proposal", "source_only", "canonical"
      );
      expect(native.lookup_kind).not.toBe("proposal");
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      await expectPublicProposal(handler, planted.sourceId, false);
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("fails closed when publishing a located shard onto a mismatched corpus", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const foreign = officialCorpus("Alice uses tools.");
    const directory = await mkdtemp(join(tmpdir(), "alaya-bound-mismatch-"));
    const filename = join(directory, "alaya.db");
    const slice = await openSourceSlice(() => {}, filename);
    try {
      const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
      const source = records.insert(hashedRecord(WS, foreign, "foreign-source"));
      const bind = requireCompletePublicBind(bindReceivedSourceInterpretationPayload({
        rawJson: faithfulPayloadControl(corpus),
        sourceCorpus: corpus,
        artifactKey: "mismatch",
        request: packedRequest(corpus)
      }));
      expect(bind.receive.located.some((row) => row.outcome === "candidates")).toBe(true);
      expect(() => publishBoundPublicSources({
        database: slice.database,
        source: {
          body: foreign,
          rootId: source.record_id,
          digest: source.content_digest,
          evidenceObjectId: source.evidence_object_id
        },
        workspaceId: WS,
        runId: RUN,
        now: NOW,
        bind
      })).toThrow(/source identity|assertion slice/);
      expect(readGists(slice.database)).toEqual([]);
      expect(fetches).toBe(0);
    } finally {
      try { slice.database.close(); } catch { /* closed */ }
      closeCachedDatabase(filename);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function officialCorpus(text: string): string {
  return buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
}

function packedCatalogCorpus(): string {
  const source = Array.from(
    { length: OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH + 2 },
    (_, index) => `I recorded durable detail number ${index + 1}.`
  ).join(" ");
  return buildOfficialApiSourceCorpus(source, []);
}

function packedRequest(corpus: string) {
  const catalog = indexOfficialApiSourceAssertions(corpus);
  const ids = catalog
    .slice(0, Math.min(OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH, catalog.length))
    .map((row) => row.assertion_id);
  return buildOfficialApiSourceRequest(corpus, ids);
}

function packedRecordedJson(request: ReturnType<typeof packedRequest>): string {
  return interpretationJson(request.source_assertions.map((row) => ({
    assertion_id: row.assertion_id,
    relations: [{ predicate: { text: "recorded" }, arguments: [], qualifiers: [] }]
  })));
}

function faithfulPayloadControl(corpus: string): string {
  const assertion = assertionContaining(corpus, "strives");
  return interpretationJson([{
    assertion_id: assertion.assertion_id,
    relations: [{
      predicate: { text: "strives" },
      arguments: [{ role: "aim", phrase: { text: "definitive cloud platform" } }],
      qualifiers: [
        { role: "audience", phrase: { text: "gamers, creatives, and businesses" } },
        { role: "scope", phrase: { text: "potential to bring technological freedom to all" } }
      ]
    }]
  }]);
}

function independentPayloadControl(corpus: string): string {
  const assertion = assertionContaining(corpus, "believe");
  return interpretationJson([{
    assertion_id: assertion.assertion_id,
    relations: [{
      predicate: { text: "believe" },
      arguments: [],
      qualifiers: []
    }]
  }]);
}

function absentRelationRawJson(): string {
  const corpus = officialCorpus(CANARY.intended);
  const assertion = packedRequest(corpus).source_assertions[0];
  if (assertion === undefined) throw new Error("official catalog produced no assertions");
  return interpretationJson([{
    assertion_id: assertion.assertion_id,
    relations: [{ predicate: { text: "invented-absent-predicate" }, arguments: [], qualifiers: [] }]
  }]);
}

function assertionContaining(corpus: string, needle: string) {
  const assertion = indexOfficialApiSourceAssertions(corpus).find((row) => row.text.includes(needle));
  if (assertion === undefined) throw new Error(`catalog has no assertion containing ${needle}`);
  return assertion;
}

function interpretationJson(interpretations: readonly Readonly<{
  readonly assertion_id: number;
  readonly relations: readonly unknown[];
}>[]): string {
  return JSON.stringify({ interpretations });
}

function readGists(database: { connection: { prepare: (sql: string) => { all: () => unknown } } }) {
  const rows = database.connection.prepare("SELECT gist FROM evidence_capsules").all() as { gist: string }[];
  return rows.map((row) => parseBoundInterpretationGist(row.gist));
}

function candidateKeys(
  rows: readonly { readonly candidates: readonly Readonly<{
    readonly predicate: { readonly lookup_key: string };
    readonly arguments: readonly { readonly phrase: { readonly lookup_key: string } }[];
    readonly qualifiers: readonly { readonly phrase: { readonly lookup_key: string } }[];
  }>[] }[]
): readonly string[] {
  return rows.flatMap((row) => row.candidates.map((candidate) => [
    candidate.predicate.lookup_key,
    ...candidate.arguments.map((item) => item.phrase.lookup_key),
    ...candidate.qualifiers.map((item) => item.phrase.lookup_key)
  ].join("|")));
}

function expectProposalUsedPublishedGists(planted: PlantedBound): void {
  const located = planted.bind.receive.located;
  expect(located.length).toBeGreaterThan(0);
  const published = located.filter((row) => row.outcome === "candidates");
  expect(published.length).toBeGreaterThan(0);
  const gists = readGists(planted.database);
  expect(gists.length).toBe(planted.gistObjectIds.length);
  expect(gists.length).toBeGreaterThan(0);
  expect(gists.every((gist) => gist?.outcome === "candidates")).toBe(true);
  expect(candidateKeys(gists.filter((gist) => gist !== null))).toEqual(candidateKeys(published));
  const native = observePlantedDiscovery(
    planted.database, WS, CANARY, "proposal", "source_only", "canonical"
  );
  expect(native.lookup_kind).toBe("proposal");
  expect(native.ids).toContain(planted.sourceId);
}

async function expectPublicProposal(
  handler: Parameters<typeof consumePublicSources>[0]["handler"],
  sourceId: string,
  required: boolean
): Promise<void> {
  const first = await handler(
    publicSearchRequest(CANARY, "proposal", "source_only", "canonical"),
    CONTEXT
  );
  const row = first.results.find((result) => result.target?.kind === "source_evidence"
    && result.target.root_id === sourceId);
  const hasProposal = (row?.source_lookup_reasons ?? []).some((reason) => reason.kind === "proposal");
  expect(hasProposal).toBe(required);
}

function consumePublic(
  handler: Parameters<typeof consumePublicSources>[0]["handler"],
  receipts: Parameters<typeof consumePublicSources>[0]["receipts"],
  lookup: "proposal" | "source_text"
) {
  return consumePublicSources({
    handler,
    context: CONTEXT,
    request: publicSearchRequest(CANARY, lookup, "source_only", "canonical"),
    receipts
  });
}
