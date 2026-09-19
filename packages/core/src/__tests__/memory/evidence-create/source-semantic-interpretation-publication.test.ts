import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSourceReferenceCatalog,
  hashLabeledIdentity,
  normalizeSourceSemantics,
  sourceReferenceResolver,
  sourceSemanticInterpretationIdentity,
  SourceSemanticPublishedInterpretationSchema,
  SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION,
  type SourceReferenceCatalog
} from "@do-soul/alaya-protocol";
import {
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
  semanticInterpretationEvidenceId,
  verifyPublishedSourceSemanticInterpretation
} from "../../../memory/evidence-create/source-interpretation-packet-publication.js";
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
  sourceId = "artifact-1"
) {
  return await fixture.sourceAdmission.admit({
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    source_id: sourceId,
    source_version: sourceVersion,
    content_bytes: content,
    evidence_object_id: evidenceObjectId,
    recorded_at: recordedAt,
    event_time: null,
    valid_from: null,
    valid_to: null,
    speaker: "user",
    scope_class: "project",
    spans: deriveAddressableSpanViews(content)
  }, { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID });
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
    catalog,
    provenance: { producer_id: "test-author", request_key: "req-1", raw_response_id: "raw-1" },
    draft: usesDraft(catalog, assertion),
    producer_version: "p1",
    contract_version: "source-interpretation-v4",
    ...extra
  };
}

function countRows(database: StorageDatabase, sql: string): number {
  return (database.connection.prepare(sql).get() as { n: number }).n;
}

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
      interpretation: { ...stripped, normalizer_version: SOURCE_SEMANTIC_LEGACY_NORMALIZER_VERSION } }))
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

  it("publishes a draft, reopens the same H/source, and does not mint memory or relations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-source-semantic-"));
    const filename = join(directory, "memory.sqlite");
    const fixture = await openFixture(filename);
    const admitted = await admitSource(fixture);
    const beforeMemory = countRows(fixture.database, "SELECT COUNT(*) AS n FROM memory_entries");
    const beforeRelations = countRows(fixture.database, "SELECT COUNT(*) AS n FROM relation_assertions");
    const catalog = catalogFor(ASSERTION);
    const [first, raced] = await Promise.all([
      fixture.publication.publish(publicationInput(catalog)),
      fixture.publication.publish(publicationInput(catalog))
    ]);
    expect(raced.evidence.object_id).toBe(first.evidence.object_id);
    const again = await fixture.publication.publish(publicationInput(catalog));
    expect(again.bound).toEqual(first.bound);
    expect(first.bound.semantic_status).toBe("unreviewed");
    expect(first.bound.contract).toBe("published-source-interpretation-v4");
    expect(first.bound.source_target.root_id).toBe(admitted.record.identity);
    expect(first.bound.source_target.evidence_object_id).toBeNull();
    expect(first.bound.interpretation.source).toEqual({
      source_id: "artifact-1",
      source_version: "1",
      content_digest: admitted.record.content_digest,
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }]
    });
    expect(first.bound.interpretation_id).toBe(
      sourceSemanticInterpretationIdentity(first.bound.interpretation, fieldContractSha256)
    );
    expect(first.evidence.object_id).toBe(
      semanticInterpretationEvidenceId(first.bound.interpretation_id, fieldContractSha256)
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
    const hid = first.bound.interpretation_id;
    const rootId = first.bound.source_target.root_id;
    fixture.database.close();
    databases.delete(fixture.database);

    const reopened = await openFixture(filename);
    await admitSource(reopened);
    const evidence = await reopened.evidenceService.findById(evidenceId);
    expect(evidence?.object_id).toBe(evidenceId);
    const rebound = SourceSemanticPublishedInterpretationSchema.parse(JSON.parse(evidence!.gist));
    expect(rebound.interpretation_id).toBe(hid);
    expect(rebound.source_target.root_id).toBe(rootId);
    expect(rebound.source_target.evidence_object_id).toBeNull();
    const checked = verifyPublishedSourceSemanticInterpretation(
      reopened.owner, rebound, REAL_SQLITE_TEST_WORKSPACE_ID
    );
    expect(checked.bound.interpretation_id).toBe(hid);
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
      catalog,
      provenance: { producer_id: "test-author" },
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

  it("does not drop the source when H publication fails, and erasure still finds a damaged body", async () => {
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
      contract: "published-source-interpretation-v4",
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

  it("keeps H id across span rewrite, ignores envelope-only provenance, and rejects forged stance", async () => {
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
      catalog,
      provenance: { producer_id: "test-author" },
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
      content_digest: admitted.record.content_digest, assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 23] }] },
    producer_id: "test-author", producer_version: "p1", contract_version: "source-interpretation-v4" });
  if (normalized.status !== "normalized") throw new Error("normalization should pass");
  const wrong = { ...normalized.interpretation, mentions: normalized.interpretation.mentions.map((row, index) => index === 0
    ? { ...row, source_ref: normalized.interpretation.mentions[1]!.source_ref } : row) };
  const base = { workspaceId: REAL_SQLITE_TEST_WORKSPACE_ID, runId: REAL_SQLITE_TEST_RUN_ID, artifactKey: "artifact-1",
    source: SOURCE, catalog, provenance: { producer_id: "test-author" } };
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
    source, catalog, provenance: { producer_id: "test-author" }, producer_version: "p1", contract_version: "source-interpretation-v4" };
  await expect(fixture.publication.publish({ ...input, draft: second })).rejects.toThrow(/host-owned source location/);
  const a = await fixture.publication.publish({ ...input, draft: first, assertion_locations: locations });
  const b = await fixture.publication.publish({ ...input, draft: second, assertion_locations: locations });
  expect(a.bound.interpretation_id).not.toBe(b.bound.interpretation_id);
  expect(b.bound.interpretation.mentions[0]!.utf8_span[0] - a.bound.interpretation.mentions[0]!.utf8_span[0]).toBe(sentence.length + 1);
  expect(verifyPublishedSourceSemanticInterpretation(fixture.owner, b.bound, REAL_SQLITE_TEST_WORKSPACE_ID).bound).toEqual(b.bound);
});
