import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceService, MemoryService, createAuditedSourceAdmission, createSourceObservationPublication,
  deriveAddressableSpanViews, fieldContractSha256 } from "@do-soul/alaya-core";
import { BoundSourceStatementSchema, SourceStatementSignalSchema, SOURCE_STATEMENTS_CONTRACT } from "@do-soul/alaya-protocol";
import { selectObservedTemporalProjection } from "@do-soul/alaya-soul";
import { initDatabase, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo, SqliteMemoryEntryRepo,
  SqliteWorkspaceRepo, SqliteRunRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";

const OBSERVED_AT = "2024-01-01T00:30:00.000Z";
const CREATED_AT = "2026-09-14T12:00:00.000Z";
const NO_TIME = { eventStart: null, eventEnd: null, validStart: null, validEnd: null };
const CASES = [
  { source: "I released the product in 2016.", ...NO_TIME,
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z" },
  { source: "This policy is valid from May 2023.", ...NO_TIME, validStart: "2023-05-01T00:00:00.000Z" },
  { source: "I own model 2016.", ...NO_TIME },
  { source: "I launched an effective product in 2016.", ...NO_TIME,
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z" },
  { source: "I launched the product in 2016 with an effective team.", ...NO_TIME,
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z" },
  { source: "I have a permit valid from 2016 to 2017.", ...NO_TIME,
    validStart: "2016-01-01T00:00:00.000Z", validEnd: "2017-12-31T23:59:59.999Z" },
  { source: "I worked from January 1, 2016 until January 3, 2016 (exclusive).", ...NO_TIME },
  { source: "I worked from January 1, 2016 to January 3, 2016 (exclusive).", ...NO_TIME },
  { source: "I worked from January 1, 2016 through January 3, 2016.", ...NO_TIME,
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-01-03T23:59:59.999Z" },
  { source: "I worked last year.", ...NO_TIME,
    eventStart: "2023-01-01T00:00:00.000Z", eventEnd: "2023-12-31T23:59:59.999Z" },
  ...[
    "I announced in 2016 a policy effective from 2017.",
    "I released the product on 2016-02/03 or in 2017.",
    "I released the product on 2016-02-03x or in 2017.",
    "I worked from 2016-02/03 to 2017.",
    "I released the product in 2016/17 or in 2017.",
    "I released the product on 2016/02/03 or in 2017.",
    "我在2016/02/03或在2017年发布产品。",
    "I released the product on Christmas or in 2017.",
    "I released the product on Christmas or maybe in 2017.",
    "I released the product on Christmas or, by and large, in 2017.",
    "I released the product on Christmas or e.g. in 2017.",
    "I released the product in an unknown year or in 2017."
  ].map(source => ({ source, ...NO_TIME })),
  { source: "I released a product or a service in 2017.", ...NO_TIME,
    eventStart: "2017-01-01T00:00:00.000Z", eventEnd: "2017-12-31T23:59:59.999Z" },
  { source: "I released the product in 2016 to help people.", ...NO_TIME,
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z" }
];

describe("source statement temporal persistence", () => {
  it("preserves source-derived inclusive windows, validity and unknowns across SQLite reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-time-")), filename = join(directory, "memory.sqlite");
    let database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "workspace",
        root_path: directory, workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
      await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "run", goal: null,
        run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle", current_surface_id: null });
      const eventLogRepo = new SqliteEventLogRepo(database), field = createDaemonFieldComposition({ database, eventLogRepo });
      const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
      const evidenceService = new EvidenceService({ evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), eventLogRepo,
        runtimeNotifier: notifier, fieldStores: field.stores, now: () => CREATED_AT });
      const memoryService = new MemoryService({ memoryEntryRepo: new SqliteMemoryEntryRepo(database), eventLogRepo,
        evidenceService, runtimeNotifier: notifier, now: () => CREATED_AT });
      const admission = createAuditedSourceAdmission({ stores: field.stores, eventLogRepo,
        sha256: fieldContractSha256, runtimeNotifier: notifier, hostCaptureBinding: request => ({
          namespace: "recorded-source", workspace_id: request.workspace_id, producer: "recorded-host", basis: "pinned_dataset" }) });
      const publication = createSourceObservationPublication({ stores: field.stores, evidenceService, memoryService,
        sha256: fieldContractSha256, deriveTemporalProjection: (text, observed) =>
          selectObservedTemporalProjection(text, undefined, observed ?? undefined) ?? {} });
      const persisted: { memoryId: string; evidenceId: string; fixture: typeof CASES[number] }[] = [];
      for (const [index, fixture] of CASES.entries()) {
        const body = `User: ${fixture.source}`, span = [6, Buffer.byteLength(body)] as const, messageId = `message-${index}`;
        const sourceId = `recorded-source-${index}`;
        const source = await admission.admit({ workspace_id: "workspace-1", source_id: sourceId, source_version: "1",
          content_bytes: body, evidence_object_id: null, recorded_at: CREATED_AT, event_time: OBSERVED_AT,
          valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: deriveAddressableSpanViews(body),
          host_occurrences: [{ occurrence_id: messageId, utf8_span: span, role: "user", channel: null,
            author_ref: null, container_ref: null, upstream_message_ref: null, upstream_position: null,
            completeness: "complete", fidelity: "original_bytes" }] }, { workspaceId: "workspace-1" });
        const signal = SourceStatementSignalSchema.parse({ signal_id: `signal-${index}`, workspace_id: "workspace-1",
          run_id: "run-1", surface_id: null, source: "garden_compile", signal_kind: "potential_semantic_observation",
          interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null,
          scope_hint: "project", domain_tags: [], evidence_refs: [], source_memory_refs: [], supersedes_refs: [],
          exception_to_refs: [], contradicts_refs: [], incompatible_with_refs: [], created_at: CREATED_AT,
          source_observation: { observed_at: OBSERVED_AT, authority: "trusted_host_event", source_event_id: sourceId },
          raw_payload: { source_statement: { contract: SOURCE_STATEMENTS_CONTRACT, session_id: sourceId, artifact_key: sourceId,
            source_root_id: source.record.identity, source_corpus_digest: fieldContractSha256(body), source_span: span,
            message: { message_id: messageId, role: "user", text: fixture.source, recorded_at: OBSERVED_AT },
            statement: { text: fixture.source, relation: "recorded event" } } } });
        const result = await publication.publish({ signal, sourceEventAnchor: null });
        persisted.push({ memoryId: result.memory.object_id, evidenceId: result.evidence.object_id, fixture });
      }
      database.close(); database = initDatabase({ filename });
      const memories = new SqliteMemoryEntryRepo(database), evidence = new SqliteEvidenceCapsuleRepo(database);
      for (const { memoryId, evidenceId, fixture } of persisted) {
        const memory = await memories.findById(memoryId), capsule = await evidence.findById(evidenceId);
        expect(memory, fixture.source).toMatchObject({ content: fixture.source, confidence: null });
        const expectedTime = { event_time_start: fixture.eventStart, event_time_end: fixture.eventEnd,
          valid_from: fixture.validStart, valid_to: fixture.validEnd };
        expect(database.connection.prepare(`SELECT event_time_start, event_time_end, valid_from, valid_to
          FROM memory_entries WHERE object_id = ?`).get(memoryId), fixture.source).toEqual(expectedTime);
        // The public row mapper omits an entirely absent projection; SQL retains NULL coordinates.
        expect({ event_time_start: memory?.event_time_start ?? null, event_time_end: memory?.event_time_end ?? null,
          valid_from: memory?.valid_from ?? null, valid_to: memory?.valid_to ?? null }, fixture.source).toEqual(expectedTime);
        expect(BoundSourceStatementSchema.parse(JSON.parse(capsule!.gist)).message.recorded_at).toBe(OBSERVED_AT);
        expect(capsule!.excerpt).toBe(fixture.source);
      }
      expect(database.connection.prepare("SELECT COUNT(*) AS n FROM source_statement_memory_bindings").get()).toEqual({ n: CASES.length });
    } finally { database.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
