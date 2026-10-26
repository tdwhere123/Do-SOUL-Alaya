import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../bench-runner/src/__tests__/support/provider-free-boundary.js"
  );
  return installProviderFreeBoundary();
});
import {
  buildSourceReferenceCatalog,
  sourceInterpretationProfileIdentity,
  sourceReferenceResolver,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EvidenceService, createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import {
  createSourceInterpretationPacketPublication,
  createSourceSemanticInterpretationPublication,
  verifyPublishedSourceInterpretation
} from "../../../../../packages/core/src/memory/evidence-create/source-interpretation-packet-publication.js";
import { deriveAddressableSpanViews } from
  "../../../../../packages/core/src/memory/evidence-create/source-span-views.js";
import { createEvidenceInput } from
  "../../../../../packages/core/src/__tests__/memory/evidence-service-fixture.js";
import {
  createRecallRealStorage,
  REAL_SQLITE_TEST_RUN_ID as RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID as WORKSPACE_ID
} from "../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createDaemonFieldRepos } from "../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../runtime/field/sqlite-field-formation-stores.js";

const CLOCK = "2026-09-14T00:00:00.000Z";
const ASSERTION = "Alice uses tools.";
const SOURCE = `User: ${ASSERTION}\nAdditional original context remains here.`;
const directories: string[] = [];
const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  expect(isolation.violations).toEqual([]);
});

async function openFixture(filename: string) {
  const { database, evidenceCapsuleRepo } = await createRecallRealStorage(db => databases.add(db), filename);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
  const notifications: EventLogEntry[] = [];
  const runtimeNotifier = { notifyEntry: (event: EventLogEntry) => {
    const audited = database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
    expect(audited).toEqual({ event_id: event.event_id });
    if (event.event_type === "soul.evidence.created") {
      expect(database.connection.prepare("SELECT object_id FROM evidence_capsules WHERE object_id = ?")
        .get(event.entity_id)).toEqual({ object_id: event.entity_id });
    }
    notifications.push(event);
  } };
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo, eventLogRepo, runtimeNotifier, fieldStores: stores, now: () => CLOCK
  });
  const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
  return { database, stores, evidenceService, admission, notifications,
    owner: { stores, evidenceService, sha256: fieldContractSha256 } };
}

function sourceRequest(content = SOURCE, version = "1", recordedAt = CLOCK) {
  return {
    workspace_id: WORKSPACE_ID, source_id: "artifact-1", source_version: version, content_bytes: content,
    evidence_object_id: null, recorded_at: recordedAt, event_time: null, valid_from: null, valid_to: null,
    attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION, speaker: "user" as const, scope_class: "project" as const,
    spans: deriveAddressableSpanViews(content)
  };
}

function publicationInputs() {
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(SOURCE),
    [{ assertion_id: 1, text: ASSERTION }], fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const mention = (id: string, text: string) => ({ id, assertion_id: 1,
    source_ref: resolver.referenceForSpan(1, [ASSERTION.indexOf(text), ASSERTION.indexOf(text) + text.length]) });
  const mentions = [mention("aliceMention", "Alice"), mention("usesMention", "uses"), mention("toolsMention", "tools")];
  const provenance = { producer_id: "test-author", request_key: "authored", raw_response_id: "authored-response" };
  const base = { workspaceId: WORKSPACE_ID, runId: RUN_ID, artifactKey: "artifact-1", source: SOURCE, provenance };
  const semantic = { ...base, catalog, attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION,
    producer_version: "p1", contract_version: "source-interpretation-v4",
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [6, 6 + ASSERTION.length] as const }],
    draft: { contract: "source-interpretation-v4" as const, mentions,
      referents: [{ id: "alice", referent_kind: "grouped" as const, mentions: ["aliceMention"] },
        { id: "tools", referent_kind: "grouped" as const, mentions: ["toolsMention"] }],
      frames: [{ id: "use", assertion_ids: [1],
        context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
        predicate_support: { kind: "explicit" as const, reading: "uses", mentions: ["usesMention"] },
        slots: [{ id: "agent", role_reading: "agent", support: [{ kind: "lexical" as const, mentions: ["aliceMention"] }] },
          { id: "theme", role_reading: "theme", support: [{ kind: "lexical" as const, mentions: ["toolsMention"] }] }],
        bindings: [{ slot_id: "agent", target: { kind: "node" as const, id: "alice" }, support: [] },
          { slot_id: "theme", target: { kind: "node" as const, id: "tools" }, support: [] }] }],
      operators: [], gaps: [] } };
  const profile = { contract: "source-interpretation-profile-v1" as const, description: "Literal use relations",
    predicates: [{ symbol: "uses", governing_roles: [], meaning: "An agent uses a theme." }],
    roles: [{ symbol: "agent", meaning: "Actor of the event." }, { symbol: "theme", meaning: "Object involved." }] };
  const packet = { ...base, profile,
    assertions: [{ assertion_id: 1, text: ASSERTION, source_span: [6, 6 + ASSERTION.length] as const }],
    packet: { contract: "source-interpretation-v2" as const,
      profile_id: sourceInterpretationProfileIdentity(profile, fieldContractSha256), source_catalog_id: catalog.catalog_id,
      mentions, referents: [{ id: "alice", mentions: ["aliceMention"] }, { id: "tools", mentions: ["toolsMention"] }],
      propositions: [{ id: "use", predicate: "uses", implicit: false, predicate_mentions: ["usesMention"], assertion_ids: [1],
        arguments: [{ role: "agent", target: "alice" }, { role: "theme", target: "tools" }] }],
      operators: [], roots: ["use"] } };
  return { semantic, packet };
}

it.each(["semantic", "packet"] as const)("persists %s provenance without admitting its excerpt as another source through SQLite reopen", async kind => {
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-provenance-"));
  directories.push(directory);
  const filename = join(directory, "memory.sqlite");
  const fixture = await openFixture(filename);
  const original = await fixture.admission.admit(sourceRequest(), { workspaceId: WORKSPACE_ID });
  const records = fixture.stores.listStoredRecords(WORKSPACE_ID);
  const spans = fixture.stores.listSpans(WORKSPACE_ID);
  const inputs = publicationInputs();
  const publication = kind === "semantic"
    ? await createSourceSemanticInterpretationPublication(fixture.owner).publish(inputs.semantic)
    : await createSourceInterpretationPacketPublication(fixture.owner).publish(inputs.packet);
  expect(publication.evidence.excerpt).toBe(kind === "semantic" ? "Alice\nuses\ntools" : ASSERTION);
  expect(publication.bound.source_target.root_id).toBe(original.record.identity);
  expect(publication.bound.source_target.evidence_object_id).toBeNull();
  if ("source_record" in publication) expect(publication.source_record).toEqual(original.record);
  else expect(verifyPublishedSourceInterpretation(fixture.owner, publication.bound, WORKSPACE_ID).stored.record)
    .toEqual(original.record);
  expect(fixture.stores.listStoredRecords(WORKSPACE_ID)).toEqual(records);
  expect(fixture.stores.listSpans(WORKSPACE_ID)).toEqual(spans);
  expect(fixture.stores.getCurrentRecord(WORKSPACE_ID, original.record.content_digest)).toBeNull();
  expect(fixture.stores.getStoredRecord(WORKSPACE_ID, original.record.identity)?.content_bytes).toBe(SOURCE);
  expect(fixture.stores.listFactors(WORKSPACE_ID)).toEqual([]);
  expect(fixture.stores.listIncidences(WORKSPACE_ID)).toEqual([]);
  expect(fixture.notifications.map(row => row.event_type)).toEqual([
    "soul.field.source_record.admitted", "soul.evidence.created"
  ]);
  expect(fixture.database.connection.prepare(
    "SELECT source_provenance FROM evidence_capsules WHERE object_id = ?")
    .get(publication.evidence.object_id)).toEqual({ source_provenance: 1 });
  for (const table of ["evidence_fact_frame_formations", "evidence_semantic_factor_formations"]) {
    expect(fixture.database.connection.prepare(`SELECT evidence_object_id FROM ${table} WHERE evidence_object_id = ?`)
      .get(publication.evidence.object_id)).toEqual({ evidence_object_id: publication.evidence.object_id });
  }
  fixture.database.close();
  databases.delete(fixture.database);
  const reopened = await openFixture(filename);
  expect(await reopened.evidenceService.findById(publication.evidence.object_id)).toEqual(publication.evidence);
  expect(reopened.stores.listStoredRecords(WORKSPACE_ID)).toEqual(records);
  expect(reopened.stores.getCurrentRecord(WORKSPACE_ID, "artifact-1")).toEqual(original.record);
  const replay = kind === "semantic"
    ? await createSourceSemanticInterpretationPublication(reopened.owner).publish(inputs.semantic)
    : await createSourceInterpretationPacketPublication(reopened.owner).publish(inputs.packet);
  expect(replay.evidence).toEqual(publication.evidence);
  expect(reopened.notifications).toEqual([]);

  const ordinary = await reopened.evidenceService.create(createEvidenceInput({
    source_hash: "ordinary-source", excerpt: "Ordinary evidence body.",
    semantic_anchor: publication.evidence.semantic_anchor
  }), [], undefined, undefined, undefined, () => {
    expect(reopened.database.connection.inTransaction).toBe(true);
  });
  expect(reopened.stores.listStoredRecords(WORKSPACE_ID)).toHaveLength(2);
  const ordinaryRecord = reopened.stores.getCurrentRecord(WORKSPACE_ID, "ordinary-source");
  expect(ordinaryRecord?.evidence_object_id).toBe(ordinary.object_id);
  expect(reopened.database.connection.prepare(
    "SELECT source_provenance FROM evidence_capsules WHERE object_id = ?")
    .get(ordinary.object_id)).toEqual({ source_provenance: 0 });
  expect(reopened.stores.getStoredRecord(WORKSPACE_ID, ordinaryRecord!.identity)?.content_bytes)
    .toBe("Ordinary evidence body.");
  expect(reopened.stores.getCurrentRecord(WORKSPACE_ID, "artifact-1")).toEqual(original.record);
  expect(reopened.notifications.map(row => row.event_type)).toEqual([
    "soul.field.source_record.admitted", "soul.evidence.created"
  ]);
});

it.each(["semantic", "packet"] as const)("rejects %s publication when its source changes before the SQLite create transaction", async kind => {
  const fixture = await openFixture(":memory:");
  const original = await fixture.admission.admit(sourceRequest(), { workspaceId: WORKSPACE_ID });
  const evidenceService: Pick<EvidenceService, "create" | "findByIdScoped"> = {
    findByIdScoped: fixture.evidenceService.findByIdScoped.bind(fixture.evidenceService),
    async create(...args) {
      await fixture.admission.admit(sourceRequest("User: Alice uses apps.", "2", "2026-09-15T00:00:00.000Z"),
        { workspaceId: WORKSPACE_ID });
      const current = args[5];
      expect(current).toBeTypeOf("function");
      args[5] = () => {
        expect(fixture.database.connection.inTransaction).toBe(true);
        current?.();
      };
      return await fixture.evidenceService.create(...args);
    }
  };
  const owner = { ...fixture.owner, evidenceService };
  const inputs = publicationInputs();
  const publication = kind === "semantic"
    ? createSourceSemanticInterpretationPublication(owner).publish(inputs.semantic)
    : createSourceInterpretationPacketPublication(owner).publish(inputs.packet);
  await expect(publication).rejects.toThrow(/digest is not current/u);
  expect(fixture.stores.getStoredRecord(WORKSPACE_ID, original.record.identity)?.content_bytes).toBe(SOURCE);
  expect(fixture.stores.listStoredRecords(WORKSPACE_ID)).toHaveLength(2);
  expect(fixture.stores.getCurrentRecord(WORKSPACE_ID, original.record.content_digest)).toBeNull();
  expect(await fixture.evidenceService.findByWorkspaceId(WORKSPACE_ID)).toEqual([]);
  expect(fixture.notifications.map(row => row.event_type)).toEqual([
    "soul.field.source_record.admitted", "soul.field.source_record.admitted"
  ]);
  expect(fixture.database.connection.prepare("SELECT count(*) AS n FROM event_log WHERE event_type = 'soul.evidence.created'")
    .get()).toEqual({ n: 0 });
});
