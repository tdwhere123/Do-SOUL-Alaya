import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key];
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network forbidden"); }));
});
import {
  buildSourceReferenceCatalog,
  hashLabeledIdentity,
  normalizeSourceSemantics,
  sourceReferenceResolver,
  sourceSemanticInterpretationIdentity,
  SourceSemanticPublishedInterpretationSchema,
  UNKNOWN_UTTERANCE_ATTRIBUTION, WorkspaceKind, WorkspaceState, RunMode, RunState,
  type SourceReferenceCatalog, type UtteranceAttribution
} from "@do-soul/alaya-protocol";
import {
  SqliteWorkspaceRepo, SqliteRunRepo, SqliteSourceHintReader, SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteKarmaEventRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { DynamicsService } from "../../../dynamics/dynamics-service.js";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { createAuditedSourceAdmission } from "../../../memory/evidence-create/audited-source-admission.js";
import { createInMemoryFieldStores } from "../../../memory/evidence-create/field-stores.js";
import {
  createSourceSemanticInterpretationPublication,
  verifyPublishedSourceSemanticInterpretation
} from "../../../memory/evidence-create/source-interpretation-packet-publication.js";
import { semanticInterpretationEvidenceId } from "../../../memory/evidence-create/source-semantic-capsule.js";
import { deriveAddressableSpanViews } from "../../../memory/evidence-create/source-span-views.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../../shared/real-sqlite.test-support.js";

const CLOCK = "2026-09-14T00:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}`;
const generationTask = { contract: "source-semantic-generation-task-v1" as const, context: "complete_original_source" as const,
  original_query: "What does Alice use?", responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

async function openFixture(filename = ":memory:") {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(
    (db) => databases.add(db),
    filename
  );
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createInMemoryFieldStores();
  const notify = { notifyEntry: vi.fn(async () => undefined) };
  const sourceAdmission = createAuditedSourceAdmission({
    stores, eventLogRepo, sha256: fieldContractSha256, runtimeNotifier: notify
  });
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo, eventLogRepo, runtimeNotifier: notify
  });
  const memoryService = new MemoryService({
    memoryEntryRepo, eventLogRepo, evidenceService, runtimeNotifier: notify,
    dynamicsService: new DynamicsService({
      memoryRepo: memoryEntryRepo,
      karmaEventRepo: new SqliteKarmaEventRepo(database),
      eventLogRepo, runtimeNotifier: notify
    })
  });
  const owner = { stores, sha256: fieldContractSha256, evidenceService };
  return {
    database, stores, sourceAdmission, evidenceService, memoryService, owner,
    publication: createSourceSemanticInterpretationPublication(owner)
  };
}

async function admitSource(
  fixture: Awaited<ReturnType<typeof openFixture>>,
  content = SOURCE,
  sourceVersion = "1",
  recordedAt = CLOCK,
  evidenceObjectId: string | null = null,
  sourceId = "artifact-1",
  attribution: UtteranceAttribution = UNKNOWN_UTTERANCE_ATTRIBUTION,
  workspaceId = REAL_SQLITE_TEST_WORKSPACE_ID
) {
  return await fixture.sourceAdmission.admit({
    workspace_id: workspaceId,
    source_id: sourceId,
    source_version: sourceVersion,
    attribution_context: attribution,
    content_bytes: content,
    evidence_object_id: evidenceObjectId,
    recorded_at: recordedAt,
    event_time: null,
    valid_from: null,
    valid_to: null,
    speaker: "user",
    scope_class: "project",
    spans: deriveAddressableSpanViews(content)
  }, { workspaceId });
}

function catalogFor(text: string): SourceReferenceCatalog {
  return buildSourceReferenceCatalog(fieldContractSha256(text), [{ assertion_id: 1, text }], fieldContractSha256);
}

function usesDraft(catalog: SourceReferenceCatalog, assertion: string) {
  const references = sourceReferenceResolver(catalog, fieldContractSha256);
  const sourceRef = (text: string) => references.referenceForSpan(1, [
    assertion.indexOf(text), assertion.indexOf(text) + text.length
  ]);
  return {
    contract: "source-interpretation-v4" as const,
    mentions: [
      { id: "mAlice", assertion_id: 1, source_ref: sourceRef("Alice") },
      { id: "mUses", assertion_id: 1, source_ref: sourceRef("uses") },
      { id: "mTools", assertion_id: 1, source_ref: sourceRef("tools") }
    ],
    referents: [
      { id: "rAlice", referent_kind: "grouped" as const, mentions: ["mAlice"] },
      { id: "rTools", referent_kind: "grouped" as const, mentions: ["mTools"] }
    ],
    frames: [{
      id: "fUse", assertion_ids: [1],
      context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      additional_support: [],
      predicate_support: { kind: "explicit" as const, reading: "use", mentions: ["mUses"] },
      slots: [
        { id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["mAlice"] }] },
        { id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["mTools"] }] }
      ],
      bindings: [
        { slot_id: "agent", target: { kind: "node" as const, id: "rAlice" }, support: [] },
        { slot_id: "theme", target: { kind: "node" as const, id: "rTools" }, support: [] }
      ]
    }],
    operators: [],
    gaps: []
  };
}

function publicationInput(
  catalog: SourceReferenceCatalog,
  extra: Record<string, unknown> = {},
  source = SOURCE,
  assertion = ASSERTION
) {
  return {
    workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
    runId: REAL_SQLITE_TEST_RUN_ID,
    artifactKey: "artifact-1",
    source,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    catalog,
    provenance: { producer_id: "test-author", request_key: "req-1", raw_response_id: "raw-1" },
    draft: usesDraft(catalog, assertion),
    producer_version: "p1",
    contract_version: "source-interpretation-v4",
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [Buffer.byteLength(source.slice(0, source.indexOf(assertion))),
      Buffer.byteLength(source.slice(0, source.indexOf(assertion) + assertion.length))] as const }],
    ...extra
  };
}

function countRows(database: StorageDatabase, sql: string): number {
  return (database.connection.prepare(sql).get() as { n: number }).n;
}

it("separates equal H publications by workspace and preserves replay through SQLite reopen", async () => {
  const filename = join(mkdtempSync(join(tmpdir(), "alaya-workspace-interpretation-")), "memory.sqlite");
  const fixture = await openFixture(filename);
  const foreign = "workspace-two", foreignRun = "run-two";
  await new SqliteWorkspaceRepo(fixture.database).create({ workspace_id: foreign, name: "two", root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO, workspace_state: WorkspaceState.ACTIVE, default_engine_binding: null });
  await new SqliteRunRepo(fixture.database).create({ run_id: foreignRun, workspace_id: foreign, title: "two", goal: null,
    run_mode: RunMode.CHAT, run_state: RunState.IDLE, engine_binding_id: null, engine_class: null, current_surface_id: null });
  await admitSource(fixture);
  await admitSource(fixture, SOURCE, "1", CLOCK, null, "artifact-1", UNKNOWN_UTTERANCE_ATTRIBUTION, foreign);
  const input = publicationInput(catalogFor(ASSERTION));
  const first = await fixture.publication.publish(input);
  const second = await fixture.publication.publish({ ...input, workspaceId: foreign, runId: foreignRun });
  expect(second.bound.interpretation_id).toBe(first.bound.interpretation_id);
  expect(second.evidence.object_id).not.toBe(first.evidence.object_id);
  expect(second.evidence.workspace_id).toBe(foreign);
  expect(await fixture.evidenceService.findByIdScoped(first.evidence.object_id, foreign)).toBeNull();
  fixture.database.close(); databases.delete(fixture.database);
  const reopened = await openFixture(filename);
  await admitSource(reopened);
  await admitSource(reopened, SOURCE, "1", CLOCK, null, "artifact-1", UNKNOWN_UTTERANCE_ATTRIBUTION, foreign);
  expect((await reopened.publication.publish(input)).evidence.object_id).toBe(first.evidence.object_id);
  expect((await reopened.publication.publish({ ...input, workspaceId: foreign, runId: foreignRun })).evidence.object_id).toBe(second.evidence.object_id);
  expect(countRows(reopened.database, "SELECT count(*) AS n FROM evidence_capsules")).toBe(2);
});

it("reads a retained workspace-free key only in its workspace and fails closed on ambiguity", async () => {
  const fixture = await openFixture();
  await admitSource(fixture);
  const input = publicationInput(catalogFor(ASSERTION));
  // Seed the recorded old writer format without changing an existing ID or disabling FKs.
  const created = await createSourceSemanticInterpretationPublication({ ...fixture.owner,
    evidenceService: {
      findByIdScoped: (id, workspace) => fixture.evidenceService.findByIdScoped(id, workspace),
      create: (value, ...rest) => fixture.evidenceService.create({ ...value, object_id:
        semanticInterpretationEvidenceId(JSON.parse(value.gist).interpretation_id, fieldContractSha256) }, ...rest)
    }
  }).publish(input);
  const legacy = created.evidence.object_id;
  const scoped = semanticInterpretationEvidenceId(created.bound.interpretation_id, fieldContractSha256, REAL_SQLITE_TEST_WORKSPACE_ID);
  const bytes = created.evidence.gist;
  const replay = await fixture.publication.publish(input);
  expect(replay.evidence.object_id).toBe(legacy);
  expect(replay.evidence.gist).toBe(bytes);
  expect(countRows(fixture.database, "SELECT count(*) AS n FROM evidence_capsules")).toBe(1);
  const keys = [scoped, legacy];
  const reader = new SqliteSourceHintReader(fixture.database.connection);
  expect(reader.readBoundInterpretationCompatible(REAL_SQLITE_TEST_WORKSPACE_ID, keys, 1_000_000))
    .toMatchObject({ status: "complete", gist: bytes, objectId: legacy });
  expect(reader.readBoundInterpretationCompatible("foreign", keys, 1_000_000))
    .toMatchObject({ status: "absent", gist: null });
  await new SqliteEvidenceCapsuleRepo(fixture.database).create({ ...created.evidence, object_id: scoped });
  expect(reader.readBoundInterpretationCompatible(REAL_SQLITE_TEST_WORKSPACE_ID, keys, 1_000_000))
    .toMatchObject({ status: "ambiguous", gist: null });
  await expect(fixture.publication.publish(input)).rejects.toThrow(/ambiguous/u);
  expect((await fixture.evidenceService.findByIdScoped(legacy, REAL_SQLITE_TEST_WORKSPACE_ID))?.gist).toBe(bytes);
});

describe("source semantic interpretation publication", () => {
  it("persists structural gaps across SQLite reopen and rejects normalized inputs that erase them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-accounting-"));
    const filename = join(directory, "memory.sqlite");
    const fixture = await openFixture(filename);
    await admitSource(fixture);
    const catalog = catalogFor(ASSERTION);
    const draft = usesDraft(catalog, ASSERTION);
    draft.frames[0]!.bindings = [];
    const published = await fixture.publication.publish(publicationInput(catalog, { draft }));
    expect(published.bound.interpretation.gaps).toContainEqual(expect.objectContaining({
      kind: "missing_binding", affected_ids: ["fUse"]
    }));
    const { draft: _draft, ...normalizedInput } = publicationInput(catalog);
    const stripped = { ...published.bound.interpretation, gaps: [] };
    await expect(fixture.publication.publish({ ...normalizedInput, interpretation: stripped }))
      .rejects.toThrow(/accounting gaps/u);
    await expect(fixture.publication.publish({ ...normalizedInput,
      interpretation: { ...stripped, normalizer_version: "source-semantic-normalizer-v3" } }))
      .rejects.toThrow(/current normalizer/u);
    fixture.database.close(); databases.delete(fixture.database);
    const reopened = await openFixture(filename);
    await admitSource(reopened);
    const stored = await reopened.evidenceService.findById(published.evidence.object_id);
    const rebound = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(stored!.gist));
    const checked = verifyPublishedSourceSemanticInterpretation(reopened.owner, rebound, REAL_SQLITE_TEST_WORKSPACE_ID);
    expect(checked.bound.interpretation.gaps).toEqual(published.bound.interpretation.gaps);
    const forged = { ...rebound, interpretation: stripped,
      interpretation_id: sourceSemanticInterpretationIdentity(stripped, fieldContractSha256) };
    expect(() => verifyPublishedSourceSemanticInterpretation(reopened.owner, forged, REAL_SQLITE_TEST_WORKSPACE_ID))
      .toThrow(/accounting gaps/u);
  });

  it("publishes a draft, reopens the same source interpretation/source, and does not mint memory or relations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-semantic-"));
    const filename = join(directory, "memory.sqlite");
    const fixture = await openFixture(filename);
    const admitted = await admitSource(fixture);
    const beforeMemory = countRows(fixture.database, "SELECT COUNT(*) AS n FROM memory_entries");
    const beforeRelations = countRows(fixture.database, "SELECT COUNT(*) AS n FROM relation_assertions");
    const catalog = catalogFor(ASSERTION);
    const [first, raced] = await Promise.all([
      fixture.publication.publish(publicationInput(catalog, { draft: { ...usesDraft(catalog, ASSERTION), generation_task: generationTask } })),
      fixture.publication.publish(publicationInput(catalog, { draft: { ...usesDraft(catalog, ASSERTION), generation_task: generationTask } }))
    ]);
    expect(raced.evidence.object_id).toBe(first.evidence.object_id);
    const again = await fixture.publication.publish(publicationInput(catalog, { draft: { ...usesDraft(catalog, ASSERTION), generation_task: generationTask } }));
    expect(again.bound).toEqual(first.bound);
    expect(first.bound.semantic_status).toBe("unreviewed");
    expect(first.bound.interpretation.generation_task).toEqual(generationTask);
    expect(first.bound.contract).toBe("published-source-interpretation-v5");
    expect(first.bound.source_target.root_id).toBe(admitted.record.identity);
    expect(first.bound.source_target.evidence_object_id).toBeNull();
    expect(first.bound.interpretation.source).toEqual({
      source_id: "artifact-1",
      source_version: "1",
      content_digest: admitted.record.content_digest,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }]
    });
    expect(first.bound.interpretation_id).toBe(
      sourceSemanticInterpretationIdentity(first.bound.interpretation, fieldContractSha256)
    );
    expect(first.evidence.object_id).toBe(
      semanticInterpretationEvidenceId(first.bound.interpretation_id, fieldContractSha256, REAL_SQLITE_TEST_WORKSPACE_ID)
    );
    expect(first.evidence.object_id).not.toBe(first.bound.source_target.root_id);
    expect(first.bound.interpretation_id).not.toBe(first.bound.source_target.root_id);
    expect(first.evidence.evidence_health_state).toBe("questionable");
    const aliceAt = Buffer.byteLength(SOURCE.slice(0, SOURCE.indexOf("Alice")), "utf8");
    expect(first.bound.interpretation.mentions.find((row) => row.text === "Alice")?.utf8_span)
      .toEqual([aliceAt, aliceAt + Buffer.byteLength("Alice", "utf8")]);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM memory_entries")).toBe(beforeMemory);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM relation_assertions")).toBe(beforeRelations);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM evidence_capsules")).toBe(1);
    const evidenceId = first.evidence.object_id;
    const sourceInterpretationId = first.bound.interpretation_id;
    const rootId = first.bound.source_target.root_id;
    fixture.database.close();
    databases.delete(fixture.database);

    const reopened = await openFixture(filename);
    await admitSource(reopened);
    const evidence = await reopened.evidenceService.findById(evidenceId);
    expect(evidence?.object_id).toBe(evidenceId);
    const rebound = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(evidence!.gist));
    expect(rebound.interpretation_id).toBe(sourceInterpretationId);
    expect(rebound.source_target.root_id).toBe(rootId);
    expect(rebound.source_target.evidence_object_id).toBeNull();
    const checked = verifyPublishedSourceSemanticInterpretation(
      reopened.owner, rebound, REAL_SQLITE_TEST_WORKSPACE_ID
    );
    expect(checked.bound.interpretation.generation_task).toEqual(generationTask);
    expect(checked.bound.interpretation_id).toBe(sourceInterpretationId);
    expect(checked.stored.record.identity).toBe(rootId);
    expect(countRows(reopened.database, "SELECT COUNT(*) AS n FROM memory_entries")).toBe(beforeMemory);
    expect(countRows(reopened.database, "SELECT COUNT(*) AS n FROM relation_assertions")).toBe(beforeRelations);
  });

  it("publishes an already-normalized IR and converts catalog code-unit spans to UTF-8", async () => {
    const source = "A café sent mail.";
    const fixture = await openFixture();
    const admitted = await admitSource(fixture, source);
    const catalog = catalogFor(source);
    const references = sourceReferenceResolver(catalog, fieldContractSha256);
    const cafe = "café";
    const draft = {
      contract: "source-interpretation-v4" as const,
      mentions: [{
        id: "mCafe", assertion_id: 1,
        source_ref: references.referenceForSpan(1, [source.indexOf(cafe), source.indexOf(cafe) + cafe.length])
      }],
      referents: [{ id: "rCafe", referent_kind: "grouped" as const, mentions: ["mCafe"] }],
      frames: [{
        id: "fSend", assertion_ids: [1],
        context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
        additional_support: [],
        predicate_support: { kind: "explicit" as const, reading: "send", mentions: ["mCafe"] },
        slots: [{ id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["mCafe"] }] }],
        bindings: [{ slot_id: "theme", target: { kind: "node" as const, id: "rCafe" }, support: [] }]
      }],
      operators: [],
      gaps: []
    };
    const normalized = normalizeSourceSemantics({
      draft, catalog, sha256: fieldContractSha256,
      source: {
        source_id: admitted.record.source_id,
        source_version: admitted.record.source_version,
        content_digest: admitted.record.content_digest,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
        assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(source)] }]
      },
      producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
    });
    expect(normalized.status).toBe("normalized");
    if (normalized.status !== "normalized") throw new Error("expected normalized IR");
    expect(source.slice(...normalized.interpretation.mentions[0]!.utf8_span)).toBe(cafe);
    expect(normalized.interpretation.mentions[0]!.utf8_span[1] - normalized.interpretation.mentions[0]!.utf8_span[0])
      .toBe(cafe.length);
    const published = await fixture.publication.publish({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      runId: REAL_SQLITE_TEST_RUN_ID,
      artifactKey: "artifact-1",
      source,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      catalog,
      provenance: { producer_id: "test-author" },
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(source)] }],
      interpretation: normalized.interpretation
    });
    const start = Buffer.byteLength(source.slice(0, source.indexOf(cafe)), "utf8");
    expect(published.bound.interpretation.mentions[0]?.utf8_span)
      .toEqual([start, start + Buffer.byteLength(cafe, "utf8")]);
    expect(published.bound.interpretation.mentions[0]!.utf8_span[1] - published.bound.interpretation.mentions[0]!.utf8_span[0])
      .toBe(cafe.length + 1);
    expect(published.bound.interpretation_id).toBe(
      sourceSemanticInterpretationIdentity(normalized.interpretation, fieldContractSha256)
    );
    expect(verifyPublishedSourceSemanticInterpretation(
      fixture.owner, published.bound, REAL_SQLITE_TEST_WORKSPACE_ID
    ).bound.interpretation_id).toBe(published.bound.interpretation_id);
  });

  it("rejects changed digest, foreign workspace, impersonating alias, and gist mismatch", async () => {
    const fixture = await openFixture();
    await admitSource(fixture, SOURCE, "1", CLOCK, "source-evidence-alias");
    const catalog = catalogFor(ASSERTION);
    const published = await fixture.publication.publish(publicationInput(catalog));
    expect(published.bound.source_target.evidence_object_id).toBe("source-evidence-alias");
    await expect(fixture.publication.publish(publicationInput(catalog, {
      workspaceId: "workspace-other"
    }))).rejects.toThrow(/not currently admitted|workspace/);
    await admitSource(fixture, "User: Alice uses apps.", "2", "2026-09-15T00:00:00.000Z");
    await expect(fixture.publication.publish(publicationInput(catalog)))
      .rejects.toThrow(/digest is not current/);
    expect(() => verifyPublishedSourceSemanticInterpretation(
      fixture.owner, published.bound, REAL_SQLITE_TEST_WORKSPACE_ID
    )).toThrow(/digest is not current/);

    const other = await openFixture();
    await other.sourceAdmission.admit({
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      source_id: "artifact-other",
      source_version: "1",
      content_bytes: SOURCE,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      evidence_object_id: "other-source-alias",
      recorded_at: CLOCK,
      event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project",
      spans: deriveAddressableSpanViews(SOURCE)
    }, { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID });
    await expect(other.publication.publish(publicationInput(catalog)))
      .rejects.toThrow(/not currently admitted/);

    const aliased = await openFixture();
    await admitSource(aliased, SOURCE, "1", CLOCK, "source-evidence-alias");
    const honest = await aliased.publication.publish(publicationInput(catalog));
    const forged = {
      ...honest.bound,
      source_target: { ...honest.bound.source_target, evidence_object_id: honest.evidence.object_id }
    };
    aliased.database.connection.prepare("UPDATE evidence_capsules SET gist=? WHERE object_id=?")
      .run(JSON.stringify(forged), honest.evidence.object_id);
    await expect(aliased.publication.publish(publicationInput(catalog)))
      .rejects.toMatchObject({ code: "VALIDATION", message: "published interpretation differs from its source binding" });
    expect(() => verifyPublishedSourceSemanticInterpretation(
      aliased.owner, forged, REAL_SQLITE_TEST_WORKSPACE_ID
    )).toThrow(/no longer current|differs from source/);
  });

  it("does not drop the source when source-interpretation publication fails, and erasure still finds a damaged body", async () => {
    const fixture = await openFixture();
    const admitted = await admitSource(fixture);
    const catalog = catalogFor(ASSERTION);
    await expect(fixture.publication.publish(publicationInput(catalog, {
      draft: { contract: "source-interpretation-v4", mentions: [{ id: "mX", assertion_id: 1, source_ref: { first: "a1s0", last: "missing" } }], referents: [], frames: [], operators: [], gaps: [] }
    }))).rejects.toThrow();
    expect(fixture.stores.getStoredRecord(REAL_SQLITE_TEST_WORKSPACE_ID, admitted.record.identity)?.content_bytes)
      .toBe(SOURCE);
    expect(countRows(fixture.database, "SELECT COUNT(*) AS n FROM evidence_capsules")).toBe(0);

    const published = await fixture.publication.publish(publicationInput(catalog));
    const damaged = JSON.stringify({
      contract: "published-source-interpretation-v5",
      source_target: published.bound.source_target,
      broken: true
    });
    fixture.database.connection.prepare("UPDATE evidence_capsules SET gist=? WHERE object_id=?")
      .run(damaged, published.evidence.object_id);
    const erase = new SqliteFieldEraseBarrierRepo(fixture.database, fieldContractSha256);
    erase.apply({
      identity: hashLabeledIdentity(
        "erase_barrier",
        [REAL_SQLITE_TEST_WORKSPACE_ID, "source_record", published.bound.source_target.root_id, ""],
        fieldContractSha256
      ),
      barrier_id: "barrier-semantic-h",
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      generation_id: null,
      subject_kind: "source_record",
      subject_id: published.bound.source_target.root_id,
      erased_at: CLOCK
    });
    const capsule = fixture.database.connection.prepare(
      "SELECT lifecycle_state, gist FROM evidence_capsules WHERE object_id = ?"
    ).get(published.evidence.object_id) as { lifecycle_state: string; gist: string };
    expect(capsule).toEqual({ lifecycle_state: "tombstone", gist: "erased" });
    expect(fixture.stores.getStoredRecord(REAL_SQLITE_TEST_WORKSPACE_ID, admitted.record.identity)?.content_bytes)
      .toBe(SOURCE);
  });

  it("keeps source-interpretation id across span rewrite, ignores envelope-only provenance, and rejects forged stance", async () => {
    const fixture = await openFixture();
    const admitted = await admitSource(fixture);
    const catalog = catalogFor(ASSERTION);
    const first = await fixture.publication.publish(publicationInput(catalog));
    const second = await fixture.publication.publish(publicationInput(catalog, {
      provenance: { producer_id: "test-author", request_key: "req-2", raw_response_id: "raw-2" }
    }));
    expect(second.evidence.object_id).toBe(first.evidence.object_id);
    expect(second.bound.interpretation_id).toBe(first.bound.interpretation_id);
    const normalized = normalizeSourceSemantics({
      draft: usesDraft(catalog, ASSERTION), catalog, sha256: fieldContractSha256,
      source: {
        source_id: admitted.record.source_id,
        source_version: admitted.record.source_version,
        content_digest: admitted.record.content_digest,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
        assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }]
      },
      producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
    });
    expect(normalized.status).toBe("normalized");
    if (normalized.status !== "normalized") throw new Error("expected normalized IR");
    expect(first.bound.interpretation_id).toBe(
      sourceSemanticInterpretationIdentity(normalized.interpretation, fieldContractSha256)
    );
    await expect(fixture.publication.publish({
      workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID,
      runId: REAL_SQLITE_TEST_RUN_ID,
      artifactKey: "artifact-1",
      source: SOURCE,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      catalog,
      provenance: { producer_id: "test-author" },
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }],
      interpretation: { ...normalized.interpretation, asserted_at_scope: [] }
    })).rejects.toThrow(/host-derived/);
  });
});

it("rejects forged selectors on already-normalized interpretations and re-verification", async () => {
  const fixture = await openFixture();
  const admitted = await admitSource(fixture);
  const catalog = catalogFor(ASSERTION);
  const normalized = normalizeSourceSemantics({ draft: usesDraft(catalog, ASSERTION), catalog, sha256: fieldContractSha256,
    source: { source_id: admitted.record.source_id, source_version: admitted.record.source_version,
      content_digest: admitted.record.content_digest, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }] },
    producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4" });
  if (normalized.status !== "normalized") throw new Error("normalization should pass");
  const wrong = { ...normalized.interpretation, mentions: normalized.interpretation.mentions.map((row, index) => index === 0
    ? { ...row, source_ref: normalized.interpretation.mentions[1]!.source_ref } : row) };
  const base = { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID, runId: REAL_SQLITE_TEST_RUN_ID, artifactKey: "artifact-1",
    source: SOURCE, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    catalog, provenance: { producer_id: "test-author" },
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] as const }] };
  await expect(fixture.publication.publish({ ...base, interpretation: wrong })).rejects.toThrow(/source reference/);
  const good = await fixture.publication.publish({ ...base, interpretation: normalized.interpretation });
  const damaged = { ...good.bound.interpretation, mentions: good.bound.interpretation.mentions.map((row, index) => index === 0
    ? { ...row, source_ref: good.bound.interpretation.mentions[1]!.source_ref } : row) };
  expect(() => verifyPublishedSourceSemanticInterpretation(fixture.owner, { ...good.bound, interpretation: damaged,
    interpretation_id: sourceSemanticInterpretationIdentity(damaged, fieldContractSha256) }, REAL_SQLITE_TEST_WORKSPACE_ID)).toThrow(/source reference/);
});

it("publishes repeated identical assertions only with distinct exact host locations", async () => {
  const fixture = await openFixture(), sentence = ASSERTION, source = `${sentence} ${sentence}`;
  await admitSource(fixture, source);
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(source), [
    { assertion_id: 1, text: sentence }, { assertion_id: 2, text: sentence }
  ], fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const first = usesDraft(catalog, sentence);
  const second = { ...first, mentions: first.mentions.map((row) => {
    const located = resolver.resolve(catalog.catalog_id, row.assertion_id, row.source_ref);
    return { ...row, assertion_id: 2, source_ref: resolver.referenceForSpan(2, located.span) };
  }), frames: first.frames.map((row) => ({ ...row, assertion_ids: [2] })) };
  const locations = [{ assertion_id: 1, source_utf8_span: [0, sentence.length] as const },
    { assertion_id: 2, source_utf8_span: [sentence.length + 1, source.length] as const }];
  const input = { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID, runId: REAL_SQLITE_TEST_RUN_ID, artifactKey: "artifact-1",
    source, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, catalog,
    provenance: { producer_id: "test-author" }, producer_version: "p1", contract_version: "source-interpretation-v4" };
  await expect(fixture.publication.publish({ ...input, draft: second } as Parameters<typeof fixture.publication.publish>[0]))
    .rejects.toThrow(/host-owned assertion locations/);
  const a = await fixture.publication.publish({ ...input, draft: first, assertion_locations: locations });
  const b = await fixture.publication.publish({ ...input, draft: second, assertion_locations: locations });
  expect(a.bound.interpretation_id).not.toBe(b.bound.interpretation_id);
  expect(b.bound.interpretation.mentions[0]!.utf8_span[0] - a.bound.interpretation.mentions[0]!.utf8_span[0]).toBe(sentence.length + 1);
  expect(verifyPublishedSourceSemanticInterpretation(fixture.owner, b.bound, REAL_SQLITE_TEST_WORKSPACE_ID).bound).toEqual(b.bound);
});

it("retains exact old source bytes after replacement while current interpretation execution rejects it", async () => {
  const fixture = await openFixture();
  const captured = (author_ref: string): UtteranceAttribution => ({
    contract: "utterance-attribution-v1", status: "captured", issuer_scope: "test-issuer",
    utterances: [{ occurrence_id: "source", utf8_span: [0, Buffer.byteLength(SOURCE)],
      conversation_ref: "conversation", author_ref }]
  });
  const original = captured("author-a"), corrected = captured("author-b");
  await admitSource(fixture, SOURCE, "1", CLOCK, null, "artifact-1", original);
  const { bound } = await fixture.publication.publish(publicationInput(catalogFor(ASSERTION), {
    attribution_context: original, draft: { ...usesDraft(catalogFor(ASSERTION), ASSERTION), generation_task: generationTask }
  }));
  expect(bound.interpretation.generation_task).toEqual(generationTask);
  expect(bound.interpretation.source.attribution_context).toEqual(original);
  const originalRecord = fixture.stores.getStoredRecord(REAL_SQLITE_TEST_WORKSPACE_ID, bound.source_target.root_id);
  expect(originalRecord?.content_bytes).toBe(SOURCE);
  expect(originalRecord?.record.attribution_context).toEqual(original);
  await admitSource(fixture, SOURCE, "2", "2026-09-15T00:00:00.000Z", null, "artifact-1", corrected);
  expect(fixture.stores.getStoredRecord(REAL_SQLITE_TEST_WORKSPACE_ID, bound.source_target.root_id))
    .toEqual(originalRecord);
  expect(() => verifyPublishedSourceSemanticInterpretation(fixture.owner, bound, REAL_SQLITE_TEST_WORKSPACE_ID))
    .toThrow(/source binding/u);
  const changedInterpretation = { ...bound.interpretation,
    source: { ...bound.interpretation.source, attribution_context: corrected } };
  expect(() => verifyPublishedSourceSemanticInterpretation(fixture.owner, { ...bound,
    interpretation: changedInterpretation,
    interpretation_id: sourceSemanticInterpretationIdentity(changedInterpretation, fieldContractSha256)
  }, REAL_SQLITE_TEST_WORKSPACE_ID)).toThrow(/source binding/u);
});

it("publishes only an explicitly unbound normalized interpretation with matching captured attribution", async () => {
  const fixture = await openFixture();
  const admitted = await admitSource(fixture);
  const catalog = catalogFor(ASSERTION);
  const normalized = normalizeSourceSemantics({
    draft: { ...usesDraft(catalog, ASSERTION), generation_task: generationTask }, catalog, sha256: fieldContractSha256,
    source: { source_id: "unbound", source_version: "unbound", content_digest: admitted.record.content_digest,
      attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
    producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4"
  });
  if (normalized.status !== "normalized") throw new Error("normalization should pass");
  const { draft: _draft, ...base } = publicationInput(catalog);
  const published = await fixture.publication.publish({ ...base, interpretation: normalized.interpretation });
  expect(published.bound.interpretation.source.source_id).toBe(admitted.record.source_id);
  expect(published.bound.interpretation.generation_task).toEqual(generationTask);
  expect(published.bound.interpretation.source.attribution_context).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  await expect(fixture.publication.publish({ ...base, interpretation: {
    ...normalized.interpretation,
    source: { ...normalized.interpretation.source, source_id: "older-artifact", source_version: "1" }
  } })).rejects.toThrow(/normalized interpretation source binding/u);
  await expect(fixture.publication.publish({ ...base, interpretation: {
    ...normalized.interpretation,
    source: { ...normalized.interpretation.source, attribution_context: {
      contract: "utterance-attribution-v1", status: "captured", issuer_scope: "fixture",
      utterances: [{ occurrence_id: "turn-1", utf8_span: [0, 4], conversation_ref: "c", author_ref: "a" }]
    } }
  } })).rejects.toThrow(/normalized interpretation source binding/u);
});
