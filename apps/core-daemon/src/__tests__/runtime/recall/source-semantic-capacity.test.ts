import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SourceSemanticPublishedInterpretationSchema, type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, EvidenceService, fieldContractSha256,
  verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { buildSourceSemanticRequest, prepareSourceSemanticRequest, receiveSourceSemantics, sourceSemanticRequestCatalog } from "@do-soul/alaya-soul";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createSourceSemanticPublication } from "../../../runtime/field/source-semantic-publication.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS
} from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

const CLOCK = "2026-10-11T00:00:00.000Z";
const SOURCE_ID = "bounded-source";
const BUDGET = { schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 };

async function withSource(count: number, run: (fixture: Awaited<ReturnType<typeof openSource>>) => Promise<void>) {
  const fixture = await openSource(count);
  try { await run(fixture); }
  finally {
    if (fixture.database.connection.open) fixture.database.close();
    closeCachedDatabase(fixture.filename);
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

async function openSource(count: number) {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-capacity-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const source = Array.from({ length: count }, (_, index) => index === 0 ? "Alice runs." : `Unit ${index + 1}.`).join(" ");
  await createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 }).admit({
    workspace_id: WS, source_id: SOURCE_ID, source_version: "1", content_bytes: source,
    evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
    speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(source)
  }, { workspaceId: WS });
  return { directory, filename, database, source, stores, eventLogRepo, runtimeNotifier };
}

it.each([128, 129, 383, 386])("preserves preparation and capacity outcomes for %i units through the native read worker", async count => {
  await withSource(count, async ({ database, filename, source }) => {
    database.close(); closeCachedDatabase(filename);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
    try {
      await client.ready();
      const execute = (request: SourceSemanticWorkerRequest) => client.sourceSemanticsPort!.execute({
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request
      });
      const request = { kind: "prepare_source" as const, source_id: SOURCE_ID, budget: BUDGET };
      if (count > 128) {
        expect(prepareSourceSemanticRequest({ sourceCorpus: source, sourceScope: "complete-source",
          assertionIds: Array.from({ length: count }, (_, i) => i + 1), sourceRole: "user",
          source_id: SOURCE_ID, source_version: "1", producer_id: "capacity-control", producer_version: "1" }))
          .toMatchObject({ status: "unsupported_source", assertion_count: count,
            reason: { dimension: "assertions", actual: count, limit: 128 } });
        await expect(execute(request)).rejects.toMatchObject({ code: "VALIDATION", details: {
          admission: "unsupported_source", capacity: { dimension: "assertions", actual: count, limit: 128 }
        } });
      } else {
        const prepared = await execute(request);
        if (prepared.kind !== "prepare_source") throw new Error("source preparation expected");
        expect(prepared.catalog.assertions.map(row => row.assertion_id)).toEqual(Array.from({ length: 128 }, (_, i) => i + 1));
        const validated = await execute({ kind: "validate_source", source_handle: prepared.source_handle, budget: BUDGET });
        if (validated.kind !== "validate_source") throw new Error("source validation expected");
        expect(validated.source).toBe(source);
        expect(validated.catalog).toEqual(prepared.catalog);
        expect(validated.assertion_locations).toHaveLength(128);
        await expect(execute({ ...request, budget: { ...BUDGET, work_units: 1 } }))
          .rejects.toMatchObject({ code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE" });
      }
    } finally { await client.close(); }
  });
}, 30000);

it.each([4, 128])("publishes %i source units with exact omissions and verifies them after SQLite reopen", async count => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("provider forbidden"); });
  try {
    await withSource(count, async ({ database, filename, source, eventLogRepo, runtimeNotifier }) => {
      const input = { sourceCorpus: source, assertionIds: Array.from({ length: count }, (_, i) => i + 1),
        sourceScope: "complete-source" as const, source_id: SOURCE_ID, source_version: "1",
        producer_id: "authored-capacity", producer_version: "1" };
      const request = buildSourceSemanticRequest(input);
      const represented = count === 4 ? [1, 3, 4] : [1];
      const received = receiveSourceSemantics(JSON.stringify({ contract: "source-semantic-proposal-v8",
        outcome: { status: "interpreted" }, content: {
          roots: represented.map(id => ({ act: "assertion", expression: { kind: "content_ref", key: `unit${id}` } })), entities: [],
          nodes: represented.map(id => ({ kind: "statement", key: `unit${id}`, predicate: {
            kind: "explicit", reading: "recorded", support: { assertion_id: id, text: id === 1 ? "runs" : `Unit ${id}` }
          }, arguments: [], qualifications: [] })), gaps: []
        }
      }), request, input);
      expect(received.outcome.status).toBe("interpreted");
      if (received.draft === undefined) throw new Error("source draft required");
      const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
        evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
      const published = await createSourceSemanticPublication({ database, evidenceService }).publish({
        workspaceId: WS, runId: RUN, artifactKey: SOURCE_ID, source,
        attribution_context: request.source_request.attribution_context!, catalog: sourceSemanticRequestCatalog(request),
        assertion_locations: request.source_request.assertion_locations!, provenance: { producer_id: input.producer_id },
        producer_version: "1", contract_version: "source-interpretation-v4", draft: received.draft, budget: BUDGET
      });
      expect(published.bound.interpretation.source.assertion_locations).toHaveLength(count);
      expect(published.bound.interpretation.mentions).toHaveLength(count);
      expect(published.bound.interpretation.gaps).toHaveLength(count - represented.length);
      const gapIds = new Set(published.bound.interpretation.gaps.flatMap(gap => gap.affected_ids));
      expect(published.bound.interpretation.mentions.filter(mention => gapIds.has(mention.id)).map(mention => mention.assertion_id))
        .toEqual(input.assertionIds.filter(id => !represented.includes(id)));
      expect(published.resource_usage!.work_units).toBeLessThanOrEqual(BUDGET.work_units);
      expect(published.resource_usage!.memory_bytes).toBeLessThanOrEqual(BUDGET.memory_bytes);
      database.close(); closeCachedDatabase(filename);
      const reopened = await createRecallRealStorage(() => undefined, filename);
      try {
        const repos = createDaemonFieldRepos({ database: reopened.database });
        const stores = createSqliteFieldFormationStores({ database: reopened.database, repos });
        const evidence = await new SqliteEvidenceCapsuleRepo(reopened.database).findById(published.evidence.object_id);
        expect(evidence).not.toBeNull();
        const stored = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(evidence!.gist));
        const verified = verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256 }, stored, WS);
        expect(verified.bound).toEqual(published.bound);
        expect(verified.stored.content_bytes).toBe(source);
      } finally { reopened.database.close(); closeCachedDatabase(filename); }
    });
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
}, 30000);
