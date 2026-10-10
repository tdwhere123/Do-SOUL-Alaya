import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSourceReferenceCatalog, sourceReferenceResolver, UNKNOWN_UTTERANCE_ATTRIBUTION,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceSemanticResourceBudget,
  type SourceSemanticQuery, type SourceSemanticWorkerRequest, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  fieldContractSha256, SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { indexSourceSemanticUnits } from "@do-soul/alaya-soul";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type RecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { deriveAddressableSpanViews } from "../../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { digestOriginalQuery } from "../../../../../../packages/core/src/recall/conditional-field/query/compile-query-identity.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_RUN_ID as RUN, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

export { WS };
export const CLOCK = "2026-09-18T00:00:00.000Z";
export const ACCESS_BUDGET = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
export type AccessFixtureSource = Readonly<{ id: string; text: string; reading?: string; person?: string;
  count?: number; scope?: "project" | "global_core"; verbatim?: boolean;
  recordedAt?: string; eventTime?: string; publicationAt?: string;
  authoredDraft?: (catalog: ReturnType<typeof buildSourceReferenceCatalog>) => unknown }>;
type Execute = NonNullable<RecallReadWorkerClient["sourceSemanticsPort"]>["execute"];
export type AccessFixtureSetup = Readonly<{
  publication_budget: SourceSemanticResourceBudget | null;
  known_publication_subtotal: SourceSemanticResourceBudget;
  admitted_source_ids: readonly string[];
} & ({ status: "complete"; exhausted: null } | { status: "resource_exhausted";
  exhausted: { source_id: string; publication_index: number; phase: string } })>;
type SetupSnapshot = { filename: string; ids: ReadonlyMap<string, readonly string[]>;
  publicationUsage: ReadonlyMap<string, readonly SourceSemanticResourceBudget[]>; setup: AccessFixtureSetup };
type PublicationProgress = { ids: Map<string, string[]>; publicationUsage: Map<string, SourceSemanticResourceBudget[]>;
  admittedSourceIds: string[]; sourceId: string; publicationIndex: number };
type Published = Awaited<ReturnType<ReturnType<typeof createSourceSemanticInterpretationPublication>["publish"]>>;
export type PublicationBoundary = Readonly<{
  source_id: string; publication_index: number; meter: SourceSemanticResourceLedger | undefined;
} & ({ kind: "begin" } | { kind: "end"; usage: SourceSemanticResourceBudget;
  outcome: { status: "published"; result: Published } | { status: "failed"; error: unknown } })>;
type PublicationObserver = (event: PublicationBoundary) => void;

export function accessQuery(original: string, reading = original): SourceSemanticQuery {
  return { contract: "source-semantic-query-v4", original_query_digest: digestOriginalQuery(original),
    approved_fixed_context: null, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_id: SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-query-v4",
    variables: [{ id: "statement", sort: "proposition" }], alternatives: [{ frames: [{ id: "qStatement", variable: "statement",
      predicate_reading: reading, role_requirements: [] }], context_obligations: [{ frame: "qStatement", kind: "asserted_at_source" }] }],
    return_variables: ["statement"], gaps: [] };
}

export async function accessCall<K extends SourceSemanticWorkerRequest["kind"]>(execute: Execute,
  request: Extract<SourceSemanticWorkerRequest, { kind: K }>, scopes: readonly string[] = ["project"]) {
  const result = await execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes }, request });
  if (result.kind !== request.kind) throw new Error("worker operation mismatch");
  return result as Extract<SourceSemanticWorkerResult, { kind: K }>;
}

export async function withAccessLibrary(sources: readonly AccessFixtureSource[], body: (input: SetupSnapshot & {
  execute: Execute;
}) => Promise<void>, options?: { publicationBudget: SourceSemanticResourceBudget;
  onPublicationBoundary?: PublicationObserver;
  onSetupExhausted?: (input: SetupSnapshot) => Promise<void> }): Promise<AccessFixtureSetup> {
  const directory = await mkdtemp(join(tmpdir(), "source-semantic-access-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  let publicationClock = CLOCK;
  const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => publicationClock });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  const publication = createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 });
  const meter = options === undefined ? undefined : new SourceSemanticResourceLedger(options.publicationBudget);
  const progress: PublicationProgress = { ids: new Map(), publicationUsage: new Map(), admittedSourceIds: [], sourceId: "", publicationIndex: 0 };
  let client: RecallReadWorkerClient | undefined, databaseOpen = true;
  const snapshot = (error?: SourceSemanticResourceExhausted): SetupSnapshot => ({ filename, ids: progress.ids,
    publicationUsage: progress.publicationUsage, setup: {
      publication_budget: options?.publicationBudget ?? null,
      known_publication_subtotal: meter === undefined ? [...progress.publicationUsage.values()].flat().reduce((sum, row) => ({
        work_units: sum.work_units + row.work_units, memory_bytes: sum.memory_bytes + row.memory_bytes }), { work_units: 0, memory_bytes: 0 })
        : { work_units: meter.spentWork, memory_bytes: meter.spentBytes },
      admitted_source_ids: [...progress.admittedSourceIds], ...(error === undefined ? { status: "complete" as const, exhausted: null }
        : { status: "resource_exhausted" as const,
          exhausted: { source_id: progress.sourceId, publication_index: progress.publicationIndex, phase: error.phase } }) } });
  try {
    try {
      for (const fixture of sources) {
        publicationClock = fixture.publicationAt ?? CLOCK;
        await admitAndPublishFixture(fixture, { admission, publication, meter,
          onPublicationBoundary: options?.onPublicationBoundary }, progress);
      }
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted) || meter === undefined) throw error;
      const partial = snapshot(error);
      await options?.onSetupExhausted?.(partial);
      return partial.setup;
    }
    const complete = snapshot();
    database.close(); databaseOpen = false; closeCachedDatabase(filename);
    client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1 })!;
    await client.ready();
    await body({ ...complete, execute: (input) => client!.sourceSemanticsPort!.execute(input) });
    return complete.setup;
  } finally {
    try { await client?.close(); }
    finally { if (databaseOpen) database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
  }
}

async function admitAndPublishFixture(fixture: AccessFixtureSource, owners: {
  admission: ReturnType<typeof createAuditedSourceAdmission>; publication: ReturnType<typeof createSourceSemanticInterpretationPublication>;
  meter: SourceSemanticResourceLedger | undefined;
  onPublicationBoundary: PublicationObserver | undefined;
}, progress: PublicationProgress) {
  progress.sourceId = fixture.id; progress.publicationIndex = 0;
  const publishedIds: string[] = [], usages: SourceSemanticResourceBudget[] = [];
  progress.ids.set(fixture.id, publishedIds); progress.publicationUsage.set(fixture.id, usages);
  if (fixture.authoredDraft !== undefined && fixture.verbatim !== true) {
    throw new Error("authored native source fixtures require verbatim original text");
  }
  const source = fixture.verbatim === true ? fixture.text : `User: ${fixture.text}`;
  await owners.admission.admit({ workspace_id: WS, source_id: fixture.id, source_version: "1", content_bytes: source,
    evidence_object_id: null, recorded_at: fixture.recordedAt ?? CLOCK, event_time: fixture.eventTime ?? null,
    valid_from: null, valid_to: null,
    speaker: "user", scope_class: fixture.scope ?? "project", spans: deriveAddressableSpanViews(source) }, { workspaceId: WS });
  progress.admittedSourceIds.push(fixture.id);
  if (fixture.reading === undefined && fixture.authoredDraft === undefined) return;
  const units = fixture.authoredDraft === undefined ? [] : indexSourceSemanticUnits(source);
  const catalog = fixture.authoredDraft === undefined
    ? buildSourceReferenceCatalog(fieldContractSha256(fixture.text), [{ assertion_id: 1, text: fixture.text }], fieldContractSha256)
    : buildSourceReferenceCatalog(fieldContractSha256(source), units.map(({ assertion_id, text }) => ({ assertion_id, text })), fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const sourceRef = fixture.authoredDraft === undefined ? resolver.referenceForSpan(1, [0, fixture.text.length]) : undefined;
  const personStart = fixture.person === undefined ? -1 : fixture.text.indexOf(fixture.person);
  if (fixture.person !== undefined && personStart < 0) throw new Error("fixture person is absent from source text");
  const personRef = fixture.person === undefined || fixture.authoredDraft !== undefined ? undefined
    : resolver.referenceForSpan(1, [personStart, personStart + fixture.person.length]);
  for (let index = 0; index < (fixture.count ?? 1); index += 1) {
    progress.publicationIndex = index;
    const authored = fixture.authoredDraft?.(catalog);
    if (fixture.authoredDraft !== undefined && authored === undefined) throw new Error("authored source fixture returned no draft");
    const before = { work_units: owners.meter?.spentWork ?? 0, memory_bytes: owners.meter?.spentBytes ?? 0 };
    const boundary = { source_id: fixture.id, publication_index: index, meter: owners.meter };
    let outcome: Extract<PublicationBoundary, { kind: "end" }>["outcome"] | undefined;
    owners.onPublicationBoundary?.({ ...boundary, kind: "begin" });
    try {
      const published = await owners.publication.publish({
        workspaceId: WS, runId: RUN, artifactKey: fixture.id, source, catalog,
        ...(owners.meter === undefined ? {} : { meter: owners.meter }),
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
        provenance: { producer_id: "access-test-author" },
        assertion_locations: fixture.authoredDraft === undefined
          ? [{ assertion_id: 1, source_utf8_span: [fixture.verbatim === true ? 0 : 6, Buffer.byteLength(source)] }]
          : units.map(unit => ({
          assertion_id: unit.assertion_id, source_utf8_span: [Buffer.byteLength(source.slice(0, unit.start)),
            Buffer.byteLength(source.slice(0, unit.end))] as const })),
        producer_version: `p${index}`, contract_version: "source-interpretation-v4", draft: authored ?? {
          contract: "source-interpretation-v4", mentions: [{ id: "mStatement", assertion_id: 1, source_ref: sourceRef! },
            ...(personRef === undefined ? [] : [{ id: "mPerson", assertion_id: 1, source_ref: personRef }])],
          referents: personRef === undefined ? [] : [{ id: "rPerson", referent_kind: "grouped", mentions: ["mPerson"] }],
          frames: [{ id: "fStatement", assertion_ids: [1], context_owner: { kind: "source_act", source_act: "assertion" },
            additional_support: [], predicate_support: { kind: "explicit", reading: fixture.reading!, mentions: ["mStatement"] },
            slots: personRef === undefined ? [] : [{ id: "person", role_reading: "person", support: [{ kind: "lexical", mentions: ["mPerson"] }] }],
            bindings: personRef === undefined ? [] : [{ slot_id: "person", target: { kind: "node", id: "rPerson" }, support: [] }] }],
          operators: [], gaps: []
        }
      });
      outcome = { status: "published", result: published };
      publishedIds.push(published.bound.interpretation_id);
      if (owners.meter === undefined) usages.push(published.resource_usage);
    } catch (error) {
      outcome = { status: "failed", error };
      throw error;
    } finally {
      if (owners.meter !== undefined) usages.push({ work_units: owners.meter.spentWork - before.work_units,
        memory_bytes: owners.meter.spentBytes - before.memory_bytes });
      if (outcome !== undefined) {
        try { owners.onPublicationBoundary?.({ ...boundary, kind: "end", outcome, usage: usages.at(-1)! }); }
        catch (error) { if (outcome.status !== "failed") throw error; }
      }
    }
  }
}
