import { createHash } from "node:crypto";
import {
  FormationKind,
  GardenRole,
  MemoryDimension,
  ScopeClass,
  SignalEventType,
  SourceKind,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import {
  digestRelationFormationEventSource,
  prepareIndexedRecallProjection,
  SqliteGardenTaskRepo,
  SqliteIndexedRecallProjection,
  SqliteMemoryRecallReader,
  SqliteRelationAssertionRepo,
  SqliteRelationRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../../memory/evidence-service.js";
import { MemoryService } from "../../../../memory/memory-service.js";
import { RelationAssertionService } from "../../../../relations/relation-assertions/relation-assertion-service.js";
import { EventPublisher } from "../../../../runtime/event-publisher.js";
import { stableStringify } from "../../../../shared/stable-stringify.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallEmbeddingRealStorage
} from "../../../shared/real-sqlite.test-support.js";

export const WS = REAL_SQLITE_TEST_WORKSPACE_ID;
export const RUN = REAL_SQLITE_TEST_RUN_ID;
export const NOW = "2026-09-06T12:00:00.000Z";

export const MEM = Object.freeze({
  r: "aaaaaaaa-aaaa-4aaa-8aaa-000000000201",
  l: "aaaaaaaa-aaaa-4aaa-8aaa-000000000202",
  c: "aaaaaaaa-aaaa-4aaa-8aaa-000000000203",
  s: "aaaaaaaa-aaaa-4aaa-8aaa-000000000204",
  h: "aaaaaaaa-aaaa-4aaa-8aaa-000000000205",
  u: "aaaaaaaa-aaaa-4aaa-8aaa-000000000206",
  p: "aaaaaaaa-aaaa-4aaa-8aaa-000000000207",
  sb: "aaaaaaaa-aaaa-4aaa-8aaa-000000000208",
  hb: "aaaaaaaa-aaaa-4aaa-8aaa-000000000209"
});

export const STRENGTH_BY_KIND: Readonly<Record<string, number>> = Object.freeze({
  observed_log: 1000,
  config_via_log: 1000,
  config_direct: 1000,
  uses_service: 1000,
  service_history: 1000
});

export const INAPPLICABLE_KIND = "unrelated";

export async function openSourceSlice(
  register: (database: StorageDatabase) => void,
  filename = ":memory:",
  permittedTimelessPolicyIds?: ReadonlySet<string>
) {
  const storage = await createRecallEmbeddingRealStorage(register, filename);
  prepareIndexedRecallProjection(storage.database);
  const indexProjection = new SqliteIndexedRecallProjection(storage.database.connection);
  const notify = { notify: async () => {}, notifyEntry: async () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo: storage.eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: notify
  });
  const garden = new SqliteGardenTaskRepo(storage.database.connection, eventPublisher);
  const relationRepo = new SqliteRelationAssertionRepo(storage.database);
  const relationReader = new SqliteRelationRecallReader(storage.database);
  relationReader.prepareIndex();
  const memoryReader = new SqliteMemoryRecallReader(storage.database);
  memoryReader.prepareIndex();
  const memoryIds: string[] = [];
  const evidenceIds: string[] = [];
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
    eventLogRepo: storage.eventLogRepo,
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
    eventLogRepo: storage.eventLogRepo,
    evidenceCapsuleRepo: storage.evidenceCapsuleRepo,
    runtimeNotifier: notify
  });
  const relations = new RelationAssertionService({
    permittedTimelessPolicyIds,
    repo: relationRepo,
    eventPublisher,
    eventHistory: storage.eventLogRepo,
    now: () => NOW
  });

  async function writeMemory(id: string, content: string, dimension: MemoryDimension) {
    memoryIds.push(id);
    return memory.create({
      created_by: "user_action",
      dimension,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content,
      domain_tags: [],
      evidence_refs: [],
      workspace_id: WS,
      run_id: RUN,
      surface_id: null
    });
  }

  async function admitRelation(input: {
    readonly evidenceId: string;
    readonly assertionId: string;
    readonly sourceId: string;
    readonly targetId: string;
    readonly resultObjectId: string;
    readonly relationKind: string;
    readonly validity: RelationValidity;
    readonly gist: string;
  }) {
    const sourceEvent = await storage.eventLogRepo.append({
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
    if (!boundSource || boundSource.workspace_id !== WS) {
      throw new Error("relation source belongs to another workspace or is missing");
    }
    await memory.updateScoped(boundSource.object_id, WS, {
      evidence_refs: [...new Set([...boundSource.evidence_refs, input.evidenceId])]
    }, "Attach admitted relation evidence to its public source");
    const parameters = {
      relation_kind: input.relationKind,
      assignment_key: input.relationKind,
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
        operator_id: "conditional_field_source_slice_v1",
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

  return {
    storage,
    database: storage.database,
    memoryEntryRepo: storage.memoryEntryRepo,
    garden,
    indexProjection,
    memoryReader,
    relationReader,
    relations,
    writeMemory,
    admitRelation,
    pendingGarden: () => garden.peekPending(GardenRole.LIBRARIAN, WS, 128)
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}
