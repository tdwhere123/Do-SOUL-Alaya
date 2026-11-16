import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  EvidenceService, MemoryService, SynthesisService, createAuditedSourceAdmission,
  createSourceObservationPublication, deriveAddressableSpanViews, fieldContractSha256
} from "@do-soul/alaya-core";
import {
  GardenTaskKind, GardenTier, SOURCE_STATEMENTS_CONTRACT, SourceStatementSignalSchema,
  type EventLogEntry, type GardenTaskDescriptor, type SourceStatementContextSource
} from "@do-soul/alaya-protocol";
import { Janitor } from "@do-soul/alaya-soul";
import {
  initDatabase, createGardenBackgroundDataPorts, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo,
  SqliteMemoryEntryRepo, SqliteRunRepo, SqliteSynthesisCapsuleRepo, SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from "../../runtime/field/field-composition.js";
import { createTombstoneDispositionSweepPort, createTombstoneGcPort } from "../../garden/support/forget-disposition-ports.js";

export const PRESERVATION_WORKSPACE = "workspace-preservation";
export const PRESERVATION_RUN = "run-preservation";
export const PRESERVATION_CLOCK = "2020-01-01T00:00:00.000Z";
export const EXACT_MEMBER_TEXT = `Historical material, not a capsule summary: ${"αβ中文🙂 retained detail; ".repeat(60)}`;

/** Real publication, real capsule producer and real daemon ports. No proof/quarantine SQL shortcuts. */
export async function createPreservationFixture() {
  const directory = await mkdtemp(join(tmpdir(), "alaya-independent-preservation-"));
  const filename = join(directory, "memory.sqlite");
  const openDatabases = new Set<StorageDatabase>();
  const open = () => {
    const database = initDatabase({ filename });
    openDatabases.add(database);
    return createRuntime(database);
  };
  const runtime = open();
  await new SqliteWorkspaceRepo(runtime.database).create({ workspace_id: PRESERVATION_WORKSPACE,
    name: "Preservation", root_path: directory, workspace_kind: "local_repo", default_engine_binding: null,
    workspace_state: "active" });
  await new SqliteRunRepo(runtime.database).create({ run_id: PRESERVATION_RUN, workspace_id: PRESERVATION_WORKSPACE,
    title: "Preservation", goal: null, run_mode: "chat", engine_binding_id: null, engine_class: null,
    run_state: "idle", current_surface_id: null });
  return {
    ...runtime,
    reopen() {
      for (const database of openDatabases) database.close();
      openDatabases.clear();
      return open();
    },
    async dispose() {
      for (const database of openDatabases) database.close();
      openDatabases.clear();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

function createRuntime(database: StorageDatabase) {
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const synthesisCapsuleRepo = new SqliteSynthesisCapsuleRepo(database);
  const field = createDaemonFieldComposition({ database, eventLogRepo });
  const notifications: { event: EventLogEntry; committed: boolean }[] = [];
  const notifier = { notifyEntry: vi.fn(async (event: EventLogEntry) => {
    const persisted = database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
    notifications.push({ event, committed: !database.connection.inTransaction && persisted !== undefined });
  }) };
  const evidenceService = new EvidenceService({ evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo, runtimeNotifier: notifier, fieldStores: field.stores, now: () => PRESERVATION_CLOCK });
  const memoryService = new MemoryService({ memoryEntryRepo, eventLogRepo, evidenceService,
    synthesisCapsuleLookup: synthesisCapsuleRepo, runtimeNotifier: notifier, now: () => PRESERVATION_CLOCK });
  const synthesisService = new SynthesisService({ synthesisCapsuleRepo, evidenceService, memoryService,
    eventLogRepo, runtimeNotifier: notifier, now: () => PRESERVATION_CLOCK });
  const admission = createAuditedSourceAdmission({ stores: field.stores, eventLogRepo,
    sha256: fieldContractSha256, runtimeNotifier: notifier, hostCaptureBinding: request => ({
      namespace: "recorded-source", workspace_id: request.workspace_id, producer: "recorded-host", basis: "pinned_dataset" }) });
  const publication = createSourceObservationPublication({ stores: field.stores, evidenceService,
    memoryService, sha256: fieldContractSha256, deriveTemporalProjection: () => ({}) });
  const scheduler = { reportCompletion: vi.fn(async () => undefined) };
  const ports = createGardenBackgroundDataPorts(database, { now: () => PRESERVATION_CLOCK });
  const tombstoneAuthority = {
    autonomousTombstone: memoryService.autonomousTombstone.bind(memoryService),
    autonomousHardDeleteTombstoned: memoryService.autonomousHardDeleteTombstoned.bind(memoryService),
    findTombstonedMemoriesWithDisposition: memoryEntryRepo.findTombstonedMemoriesWithDisposition.bind(memoryEntryRepo)
  };
  const task: GardenTaskDescriptor = { task_id: "preservation-sweep", task_kind: GardenTaskKind.TOMBSTONE_GC,
    required_tier: GardenTier.TIER_0, workspace_id: PRESERVATION_WORKSPACE, run_id: PRESERVATION_RUN,
    target_object_refs: [], priority: 10, created_at: PRESERVATION_CLOCK };
  function sweep(physicalGc = false) {
    const janitor = new Janitor({ cleanupPort: { findExpiredObjects: async () => [], removeExpiredObjects: () => undefined },
      tieringPort: ports.tieringPort, scheduler, now: () => PRESERVATION_CLOCK,
      dispositionSweepPort: createTombstoneDispositionSweepPort({ memoryLookup: memoryEntryRepo,
        capsuleLookup: synthesisCapsuleRepo, tombstoneAuthority }),
      tombstoneGcPort: createTombstoneGcPort({ tombstoneAuthority }),
      ...(physicalGc ? {} : { tombstoneGcDeferredReason: "temporal_assertion_provenance_required" }) });
    return janitor.run(task);
  }
  async function admit(sourceId: string, text: string, version = "1", originIds: readonly string[] = []) {
    const body = `User: ${text}`;
    return admission.admit({ workspace_id: PRESERVATION_WORKSPACE, source_id: sourceId,
      source_version: version, content_bytes: body, evidence_object_id: null,
      recorded_at: version === "1" ? PRESERVATION_CLOCK : "2020-01-02T00:00:00.000Z",
      source_representation: originIds.length === 0 ? { kind: "original_body" as const }
        : { kind: "canonical_projection" as const, source_record_ids: originIds },
      event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project",
      spans: deriveAddressableSpanViews(body), host_occurrences: [{ occurrence_id: sourceId,
        utf8_span: [6, Buffer.byteLength(body)], role: "user", channel: null, author_ref: null,
        container_ref: null, upstream_message_ref: null, upstream_position: null,
        completeness: "complete", fidelity: "original_bytes" }] }, { workspaceId: PRESERVATION_WORKSPACE });
  }
  async function publishMember(sourceId: string, text = EXACT_MEMBER_TEXT,
    context: readonly SourceStatementContextSource[] = [], originIds: readonly string[] = []) {
    const source = await admit(sourceId, text, "1", originIds);
    const body = `User: ${text}`;
    const signal = SourceStatementSignalSchema.parse({ signal_id: `signal-${sourceId}`,
      workspace_id: PRESERVATION_WORKSPACE, run_id: PRESERVATION_RUN, surface_id: null,
      source: "garden_compile", signal_kind: "potential_semantic_observation",
      interpretation_contract: SOURCE_STATEMENTS_CONTRACT, object_kind: null, confidence: null,
      scope_hint: "project", domain_tags: [], evidence_refs: [], source_memory_refs: [],
      supersedes_refs: [], exception_to_refs: [], contradicts_refs: [], incompatible_with_refs: [],
      created_at: PRESERVATION_CLOCK,
      source_observation: { observed_at: PRESERVATION_CLOCK, authority: "trusted_host_event", source_event_id: sourceId },
      raw_payload: { source_statement: { contract: SOURCE_STATEMENTS_CONTRACT, session_id: sourceId,
        artifact_key: sourceId, source_root_id: source.record.identity, source_corpus_digest: fieldContractSha256(body),
        source_context: context, source_span: [6, Buffer.byteLength(body)],
        message: { message_id: sourceId, role: "user", text, recorded_at: null },
        statement: { text, relation: "historical observation" } } } });
    const published = await publication.publish({ signal, sourceEventAnchor: null });
    await memoryService.transitionLifecycle(published.memory.object_id, "dormant", "eligible maintenance fixture", "deterministic_rule");
    return { source, ...published };
  }
  async function createCapsule(memoryIds: readonly string[]) {
    return synthesisService.create({ created_by: "deterministic_rule", topic_key: "historical organization",
      synthesis_type: "cross_evidence", summary: "A deliberately incomplete organizing summary.", evidence_refs: [],
      source_memory_refs: memoryIds, workspace_id: PRESERVATION_WORKSPACE, run_id: PRESERVATION_RUN });
  }
  return { database, field, eventLogRepo, memoryEntryRepo, synthesisCapsuleRepo, memoryService,
    evidenceService, synthesisService, notifications, notifier, scheduler, admit, publishMember, createCapsule, sweep };
}
