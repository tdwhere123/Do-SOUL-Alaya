import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  FormationKind,
  GardenRole,
  MemoryDimension,
  ScopeClass,
  SignalEventType,
  SourceKind,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { auditOfficialApiSignalFormation } from "@do-soul/alaya-soul";
import {
  digestRelationFormationEventSource,
  initializeSemanticArtifactCandidateSchema,
  SqliteGardenTaskRepo,
  SqliteIndexedRecallProjection,
  SqliteRelationAssertionRepo,
  SqliteRelationRecallReader,
  SqliteMemoryRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { RelationAssertionService } from "../../../relations/relation-assertions/relation-assertion-service.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { localTargetRecall, type LocalRecallInput } from "./target-recall.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallEmbeddingRealStorage
} from "../../shared/real-sqlite.test-support.js";
import { CONTENT, EV, MEM, NOW, RUN, WS } from "./ids.js";

export interface SliceCounters {
  write_ack_ms: number | "not_observed";
  write_provider_calls: number;
  garden_enqueue: number;
  enrich_execute_ms: number | "not_observed";
  recall_provider_calls: number;
  recall_source_writes: number;
  query_embed_count: number;
  selection_count: number;
  row_visits: number;
  source_reads: number;
  source_revision_rows: number;
  raw_bytes: number;
  assertion_rows: number;
  native_lexical_visits: number;
  native_lexical_bytes: number;
  native_assertion_visits: number;
  native_assertion_bytes: number;
  native_artifact_visits: number;
  native_artifact_bytes: number;
  artifact_validation_utf8_bytes: number;
  embedding_id_json_bytes: number;
  embedding_id_metadata_utf8_bytes: number;
  embedding_vector_payload_bytes: number;
  full_tier_scan: number;
  rss: number | "not_observed";
  phase_ms: Readonly<Record<string, number>>;
  db_bytes: number | "not_observed";
}


function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export async function createSliceHarness(register: (database: StorageDatabase) => void, filename = ":memory:") {
  const storage = await createRecallEmbeddingRealStorage(register, filename);
  storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
  initializeSemanticArtifactCandidateSchema(storage.database.connection);
  const indexProjection = new SqliteIndexedRecallProjection(storage.database.connection);
  const eventLogRepo = storage.eventLogRepo;
  const notify = { notify: async () => {}, notifyEntry: async () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: notify
  });
  const relationRepo = new SqliteRelationAssertionRepo(storage.database);
  const recallReader = new SqliteRelationRecallReader(storage.database);
  recallReader.prepareIndex();
  const memoryReader = new SqliteMemoryRecallReader(storage.database);
  memoryReader.prepareIndex();
  const garden = new SqliteGardenTaskRepo(storage.database.connection, eventPublisher);
  const counters: SliceCounters = {
    write_ack_ms: "not_observed",
    write_provider_calls: 0,
    garden_enqueue: 0,
    enrich_execute_ms: "not_observed",
    recall_provider_calls: 0,
    recall_source_writes: 0,
    query_embed_count: 0,
    selection_count: 0,
    row_visits: 0,
    source_reads: 0, source_revision_rows: 0,
    raw_bytes: 0,
    assertion_rows: 0,
    native_lexical_visits: 0,
    native_lexical_bytes: 0,
    native_assertion_visits: 0,
    native_assertion_bytes: 0,
    native_artifact_visits: 0,
    native_artifact_bytes: 0,
    artifact_validation_utf8_bytes: 0,
    embedding_id_json_bytes: 0,
    embedding_id_metadata_utf8_bytes: 0,
    embedding_vector_payload_bytes: 0,
    full_tier_scan: 0,
    rss: "not_observed",
    phase_ms: {},
    db_bytes: "not_observed"
  };
  const memoryIds: string[] = [];
  const evidenceIds: string[] = [];
  let inRecall = false;
  const memory = new MemoryService({
    now: () => NOW,
    generateObjectId: () => {
      const id = memoryIds.shift();
      if (id === undefined) throw new Error("memory id queue empty");
      return id;
    },
    evidenceService: {
      findById: async (id) => storage.evidenceCapsuleRepo.findById(id),
      findByIds: async (workspaceId, ids) => storage.evidenceCapsuleRepo.findByIds?.(workspaceId, ids) ?? []
    },
    eventLogRepo,
    memoryEntryRepo: storage.memoryEntryRepo,
    gardenIntentPort: garden,
    runtimeNotifier: notify
  });
  const evidence = new EvidenceService({
    now: () => NOW,
    generateObjectId: () => {
      const id = evidenceIds.shift();
      if (id === undefined) throw new Error("evidence id queue empty");
      return id;
    },
    eventLogRepo,
    evidenceCapsuleRepo: storage.evidenceCapsuleRepo,
    runtimeNotifier: notify
  });
  const relations = new RelationAssertionService({
    repo: relationRepo,
    eventPublisher,
    eventHistory: eventLogRepo,
    now: () => NOW
  });

  async function writeMemory(id: string, content: string, dimension: MemoryDimension, enrich: boolean) {
    memoryIds.push(id);
    const started = performance.now();
    const created = await memory.create({
      created_by: "user_action",
      dimension,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content,
      domain_tags: [],
      evidence_refs: [],
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      run_id: REAL_SQLITE_TEST_RUN_ID,
      surface_id: null,
      ...(enrich ? { enqueueEnrichment: { runId: RUN, sourceSignalId: null } } : {})
    });
    counters.write_ack_ms = performance.now() - started;
    if (inRecall) counters.recall_source_writes += 1;
    if (enrich) {
      counters.garden_enqueue = garden.peekPending(GardenRole.LIBRARIAN, REAL_SQLITE_TEST_WORKSPACE_ID, 128)
        .length;
    }
    return created;
  }

  async function admitRelation(input: {
    readonly evidenceId: string;
    readonly assertionId: string;
    readonly sourceId: string;
    readonly targetId: string;
    readonly resultObjectId: string;
    readonly relationKind: string;
    readonly assignmentKey: string;
    readonly validity: RelationValidity;
    readonly gist: string;
  }) {
    const sourceEvent = await eventLogRepo.append({
      event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
      entity_type: "candidate_memory_signal",
      entity_id: input.assertionId,
      workspace_id: WS,
      run_id: RUN,
      caused_by: "garden",
      payload_json: { source: input.gist }
    });
    evidenceIds.push(input.evidenceId);
    await evidence.create({
      created_by: "garden",
      evidence_kind: "conversation_excerpt",
      semantic_anchor: { topic: input.relationKind, keywords: [input.relationKind], summary: input.gist },
      event_anchor: {
        event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
        event_id: sourceEvent.event_id,
        occurred_at: NOW
      },
      physical_anchor: null,
      evidence_health_state: "verified",
      gist: input.gist,
      excerpt: input.gist,
      source_hash: null,
      run_id: RUN,
      workspace_id: WS,
      surface_id: null
    });
    const boundSource = await storage.memoryEntryRepo.findById(input.resultObjectId);
    if (!boundSource || boundSource.workspace_id !== WS) throw new Error("relation source belongs to another workspace or is missing");
    await memory.updateScoped(boundSource.object_id, WS,
      { evidence_refs: [...new Set([...boundSource.evidence_refs, input.evidenceId])] },
      "Attach admitted relation evidence to its public source");
    const parameters = {
      relation_kind: input.relationKind,
      assignment_key: input.assignmentKey,
      result_object_id: input.resultObjectId
    };
    const decision = { source_event_ids: [sourceEvent.event_id] };
    await relations.admit({
      assertionId: input.assertionId,
      workspaceId: WS,
      runId: RUN,
      causedBy: "garden",
      evidenceReceipts: [{
        evidence_id: input.evidenceId,
        source_event_anchor: {
          event_type: SignalEventType.SOUL_SIGNAL_EMITTED,
          event_id: sourceEvent.event_id,
          occurred_at: NOW
        }
      }],
      formationReceipt: {
        operator_id: "c02_typed_join_v1",
        operator_sha256: "a".repeat(64),
        parameters,
        parameter_sha256: sha256(parameters),
        source_observations: [{
          source_kind: "event_log_entry",
          source_id: sourceEvent.event_id,
          source_sha256: digestRelationFormationEventSource(sourceEvent)
        }],
        decision,
        decision_sha256: sha256(decision)
      },
      anchors: {
        source_anchor: { kind: "object", object_id: input.sourceId },
        target_anchor: { kind: "object", object_id: input.targetId }
      },
      relationKind: input.relationKind,
      validity: input.validity,
      admittedAt: NOW
    });
  }

  async function plantLaunchCorpus(options: {
    readonly plantVectors?: boolean;
    readonly includeChannel?: boolean;
    readonly includeCharlie?: boolean;
    readonly includeTemporalOwners?: boolean;
    readonly enrich?: boolean;
    readonly joinOwner?: boolean;
  } = {}) {
    await writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, options.enrich === true);
    await writeMemory(MEM.remote, CONTENT.remote, MemoryDimension.EPISODE, options.enrich === true);
    await writeMemory(MEM.orion, options.joinOwner ? "Platform owns Orion" : CONTENT.orion, MemoryDimension.FACT, false);
    await writeMemory(MEM.channel, CONTENT.channel, MemoryDimension.FACT, false);
    if (options.includeCharlie === true) await writeMemory(MEM.charlie, CONTENT.charlie, MemoryDimension.FACT, false);
    await writeMemory(MEM.bob, CONTENT.bob, MemoryDimension.FACT, false);
    if (options.includeTemporalOwners === true) {
      await admitRelation({
        evidenceId: EV.orionOwnerOld,
        assertionId: "assert-orion-alice-old",
        sourceId: "orion",
        targetId: "alice",
        resultObjectId: MEM.orion,
        relationKind: "owns",
        assignmentKey: "Platform",
        validity: { kind: "bounded", valid_from: "2025-01-01T00:00:00.000Z", valid_to: "2026-06-01T00:00:00.000Z" },
        gist: "Alice owned Orion"
      });
      await admitRelation({
        evidenceId: EV.orionOwnerNew,
        assertionId: "assert-orion-bob-new",
        sourceId: "orion",
        targetId: "bob",
        resultObjectId: MEM.bob,
        relationKind: "owns",
        assignmentKey: "Platform",
        validity: { kind: "open", valid_from: "2026-06-01T00:00:00.000Z" },
        gist: "Bob owns Orion"
      });
    } else {
      await admitRelation({
        evidenceId: EV.orionOwner,
        assertionId: "assert-orion-alice",
        sourceId: "orion",
        targetId: options.joinOwner ? "platform" : "alice",
        resultObjectId: MEM.orion,
        relationKind: "owns",
        assignmentKey: "Platform",
        validity: { kind: "open", valid_from: "2025-01-01T00:00:00.000Z" },
        gist: options.joinOwner ? "Platform owns Orion" : "Alice owns Orion"
      });
    }
    if (options.includeChannel !== false) {
      await admitRelation({
        evidenceId: EV.platformChannel,
        assertionId: "assert-platform-pager",
        sourceId: "platform",
        targetId: "pager",
        resultObjectId: MEM.channel,
        relationKind: "escalation_channel",
        assignmentKey: "Platform",
        validity: { kind: "open", valid_from: "2025-01-01T00:00:00.000Z" },
        gist: "Platform pager channel"
      });
    }
    if (options.includeCharlie === true) {
      await admitRelation({
        evidenceId: EV.orionOwnerCharlie,
        assertionId: "assert-orion-charlie",
        sourceId: "orion",
        targetId: "charlie",
        resultObjectId: MEM.charlie,
        relationKind: "owns",
        assignmentKey: "CharlieLineage",
        validity: { kind: "open", valid_from: "2025-01-01T00:00:00.000Z" },
        gist: "Charlie owns Orion"
      });
    }
  }

  let revoked = false;

  async function runRecall(input: LocalRecallInput, signal?: AbortSignal) {
    if (revoked) throw new Error("query snapshot revoked");
    const before = storage.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number };
    const result = localTargetRecall(input, { memoryReader, recallReader, indexProjection }, signal?.aborted);
    const after = storage.database.connection.prepare("SELECT COUNT(*) AS n FROM event_log").get() as { n: number };
    return { ...result, counters: { ...counters,
      recall_source_writes: after.n - before.n,
      recall_provider_calls: 0,
      row_visits: result.observation.nativeVisits,
      source_reads: result.observation.sourceReads,
      raw_bytes: result.observation.bytesRead,
      phase_ms: { total: result.observation.elapsedMs },
      rss: process.memoryUsage().rss
    } };
  }

  function fakeTransportAdmit(turn: string) {
    const started = performance.now();
    const result = auditOfficialApiSignalFormation({
      raw_json: JSON.stringify({
        signals: [{
          signal_kind: "potential_claim",
          object_kind: "decision",
          confidence: 0.7,
          matched_text: turn,
          semantic_factor_graph: {
            schema_version: 2,
            source_kind: "evidence",
            factors: [{ factor_id: "f0", surface: turn.slice(0, 64), semantic_identity: turn.toLowerCase() }],
            variables: [],
            result_variable_ids: [],
            propositions: [{
              proposition_id: "p0",
              predicate_factor_id: "f0",
              arguments: [{
                position: 0,
                binding_identity: "assertion",
                reference_kind: "factor",
                reference_id: "f0"
              }]
            }]
          }
        }]
      }),
      turn_content: turn,
      allow_legacy_single_user_source: true,
      workspace_id: WS,
      run_id: RUN,
      surface_id: null,
      created_at: NOW,
      source_observed_at: NOW,
      signal_id_for: (index) => `c02-fake-${index}`
    });
    counters.enrich_execute_ms = performance.now() - started;
    return result;
  }


  return {
    indexProjection,
    recallReader,
    memoryService: memory,
    database: storage.database,
    revokeSession: () => { revoked = true; },
    memoryEntryRepo: storage.memoryEntryRepo,
    garden,
    counters,
    writeMemory,
    plantLaunchCorpus,
    admitRelation,
    relationService: relations,
    runRecall,
    fakeTransportAdmit,
    pendingGarden: () => garden.peekPending(GardenRole.LIBRARIAN, WS, 32)
  };
}

export { CONTENT, EV, MEM, NOW, WS };
