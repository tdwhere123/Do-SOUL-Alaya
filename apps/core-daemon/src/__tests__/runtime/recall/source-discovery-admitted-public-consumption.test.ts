import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus
} from "@do-soul/alaya-soul";
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
  SOURCE_DISCOVERY_CANARY,
  type CanaryCase
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import { assertBuiltWorker } from "./recall-read-worker-client-fixture.js";
import { consumePublicSources } from "./source-discovery-public-consumer.js";
import {
  observePlantedDiscovery,
  publicSearchRequest,
  scoreConsumption
} from "./source-discovery-public-consumption.js";
import { withAdmittedPublicWorker } from "./source-discovery-public-consumption-plant.js";
import {
  bindAdmittedExtractionShard,
  publishAdmittedPublicSources
} from "./source-discovery-admitted-public-publication.js";

const CANARY = SOURCE_DISCOVERY_CANARY[0]!;
const SHARD_MODEL = "gemini-3.1-flash-lite";
const SHARD_PROFILE = "gemini-3.1-low-v1";
const previousFetch = globalThis.fetch;
let fetches = 0;

describe("admitted source interpretation public consumption", () => {
  assertBuiltWorker();

  beforeEach(() => {
    fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      throw new Error("provider forbidden in admitted public consumption");
    };
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
  });

  it("consumes a nonempty admitted interpretation through public sources", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const rawJson = admittedRawJson(CANARY, corpus, sketchRelations(CANARY));
    await withAdmittedPublicWorker(corpus, rawJson, async (planted, handler, receipts, client) => {
      expect(planted.bind.receive.located.some((row) => row.outcome === "candidates")).toBe(true);
      expect(readGists(planted.database).every((gist) => gist?.outcome === "candidates")).toBe(true);
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      const trace = await consumePublic(handler, receipts, "proposal");
      const score = scoreConsumption(CANARY, planted.sourceId, trace, "source_only");
      expect(score.first_page_includes_intended).toBe(true);
      expect(score.content.has_full_intended).toBe(true);
      expect(score.primary_native_visits).not.toBe("miss");
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("does not replace omitted model relations with authored sketches", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const rawJson = admittedRawJson(CANARY, corpus, []);
    await withAdmittedPublicWorker(corpus, rawJson, async (planted, handler, receipts, client) => {
      const gists = readGists(planted.database);
      expect(gists.length).toBeGreaterThan(0);
      expect(gists.every((gist) => gist?.outcome === "empty")).toBe(true);
      expect(gists.every((gist) => (gist?.candidates.length ?? 0) === 0)).toBe(true);
      expect(gists.some((gist) => gist?.candidates.some((candidate) =>
        candidate.predicate.text === CANARY.sketch.predicate))).toBe(false);
      const native = observePlantedDiscovery(
        planted.database, WS, CANARY, "proposal", "source_only", "canonical"
      );
      expect(native.lookup_kind).not.toBe("proposal");
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it.each([
    { label: "malformed envelope", rawJson: '{"signals":[]}' },
    { label: "absent model relation", rawJson: absentRelationRawJson() }
  ])("keeps $label locate outcomes explicit without minting completion", async ({ rawJson }) => {
    const corpus = officialCorpus(CANARY.intended);
    await withAdmittedPublicWorker(corpus, rawJson, async (planted, handler, receipts, client) => {
      expect(planted.bind.receive.located.every((row) => row.outcome === "failed")).toBe(true);
      expect(planted.bind.receive.located.every((row) => row.diagnostics.length > 0)).toBe(true);
      const gists = readGists(planted.database);
      expect(gists.every((gist) => gist?.outcome === "failed")).toBe(true);
      expect(gists.every((gist) => (gist?.candidates.length ?? 0) === 0)).toBe(true);
      const native = observePlantedDiscovery(
        planted.database, WS, CANARY, "proposal", "source_only", "canonical"
      );
      expect(native.lookup_kind).not.toBe("proposal");
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      await consumePublic(handler, receipts, "proposal");
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("uses the same admitted population for proposal and source_text", async () => {
    const corpus = officialCorpus(CANARY.intended);
    const rawJson = admittedRawJson(CANARY, corpus, sketchRelations(CANARY));
    await withAdmittedPublicWorker(corpus, rawJson, async (planted, handler, receipts, client) => {
      const native = {
        proposal: observePlantedDiscovery(planted.database, WS, CANARY, "proposal", "source_only", "canonical"),
        source_text: observePlantedDiscovery(planted.database, WS, CANARY, "source_text", "source_only", "canonical")
      };
      expect(native.proposal.ids).toContain(planted.sourceId);
      expect(native.source_text.ids).toContain(planted.sourceId);
      expect([...native.proposal.ids].sort()).toEqual([...native.source_text.ids].sort());
      planted.database.close();
      closeCachedDatabase(planted.filename);
      await client.ready();
      const proposal = await consumePublic(handler, receipts, "proposal");
      const sourceText = await consumePublic(handler, receipts, "source_text");
      expect([...proposal.first_page_identities].sort()).toEqual([...sourceText.first_page_identities].sort());
      expect(proposal.first_page_identities).toContain(planted.sourceId);
      expect(fetches).toBe(0);
    });
  }, 90_000);

  it("does not treat a missing shard as an empty admitted payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-admitted-missing-"));
    const filename = join(directory, "alaya.db");
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-admitted-cache-"));
    const corpus = officialCorpus(CANARY.intended);
    const slice = await openSourceSlice(() => {}, filename);
    try {
      const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
      const source = records.insert(hashedRecord(WS, corpus, "admitted-source"));
      const bind = bindAdmittedExtractionShard({
        cacheRoot,
        cacheKey: "ab".repeat(32),
        model: SHARD_MODEL,
        requestProfile: SHARD_PROFILE,
        sourceCorpus: corpus,
        artifactKey: "missing-shard"
      });
      expect(bind.status).toBe("missing");
      const published = publishAdmittedPublicSources({
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

  it("reads an admitted cache shard and binds against the source corpus", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "alaya-admitted-shard-"));
    try {
      const corpus = officialCorpus(CANARY.intended);
      const rawJson = admittedRawJson(CANARY, corpus, sketchRelations(CANARY));
      const cacheKey = "cd".repeat(32);
      writeCachedExtraction(cacheRoot, cacheKey, {
        model: SHARD_MODEL,
        request_profile: SHARD_PROFILE,
        cache_key: cacheKey,
        raw_json: rawJson,
        extracted_at: NOW
      });
      const bind = bindAdmittedExtractionShard({
        cacheRoot,
        cacheKey,
        model: SHARD_MODEL,
        requestProfile: SHARD_PROFILE,
        sourceCorpus: corpus,
        artifactKey: "shard-bind"
      });
      expect(bind.status).toBe("received");
      if (bind.status !== "received") return;
      expect(bind.rawJson).toBe(rawJson);
      expect(bind.receive.located.some((row) => row.outcome === "candidates")).toBe(true);
      expect(fetches).toBe(0);
    } finally {
      await rm(cacheRoot, { recursive: true, force: true });
    }
  });
});

function officialCorpus(text: string): string {
  return buildOfficialApiSourceCorpus(text, [{ role: "user", content: text }]);
}

function sketchRelations(canary: CanaryCase) {
  return [{
    predicate: { text: canary.sketch.predicate },
    arguments: (canary.sketch.arguments ?? []).map((item) => ({
      role: item.role, phrase: { text: item.phrase }
    })),
    qualifiers: (canary.sketch.qualifiers ?? []).map((item) => ({
      role: item.role, phrase: { text: item.phrase }
    }))
  }];
}

function admittedRawJson(
  canary: CanaryCase,
  corpus: string,
  relations: readonly Readonly<{
    readonly predicate: { readonly text: string };
    readonly arguments: readonly Readonly<{ readonly role: string; readonly phrase: { readonly text: string } }>[];
    readonly qualifiers: readonly Readonly<{ readonly role: string; readonly phrase: { readonly text: string } }>[];
  }>[]
): string {
  const assertions = buildOfficialApiSourceAssertions(corpus);
  const assertion = assertions.find((row) =>
    row.text.includes(canary.sketch.predicate)
    && (canary.sketch.arguments ?? []).every((item) => row.text.includes(item.phrase))
  ) ?? assertions[0];
  if (assertion === undefined) throw new Error("official catalog produced no assertions");
  return JSON.stringify({
    interpretations: [{ assertion_id: assertion.assertion_id, relations }]
  });
}

function absentRelationRawJson(): string {
  const corpus = officialCorpus(CANARY.intended);
  return admittedRawJson(CANARY, corpus, [{
    predicate: { text: "invented-absent-predicate" },
    arguments: [],
    qualifiers: []
  }]);
}

function readGists(database: { connection: { prepare: (sql: string) => { all: () => unknown } } }) {
  const rows = database.connection.prepare("SELECT gist FROM evidence_capsules").all() as { gist: string }[];
  return rows.map((row) => parseBoundInterpretationGist(row.gist));
}

function consumePublic(
  handler: Parameters<typeof consumePublicSources>[0]["handler"],
  receipts: Parameters<typeof consumePublicSources>[0]["receipts"],
  lookup: "proposal" | "source_text"
) {
  return consumePublicSources({
    handler,
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    request: publicSearchRequest(CANARY, lookup, "source_only", "canonical"),
    receipts
  });
}
