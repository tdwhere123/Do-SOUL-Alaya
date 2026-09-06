import type { EmbeddingProviderPort } from "../../../embedding-recall/types.js";
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
  SqliteGardenTaskRepo,
  SqliteRelationAssertionRepo,
  SqliteRelationRecallReader,
  SqliteMemoryRecallReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { RelationAssertionService } from "../../../relations/relation-assertions/relation-assertion-service.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { detachInput } from "../../../recall/decision/budget-aware-q/capture-data.js";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { finalizeClaims, packDecision, withClaims } from "../../../recall/decision/budget-aware-q/claims.js";
import { admitField, emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import {
  framedByteLength,
  type EvidenceUnit,
  type DecisionResult,
  type PackedRecall,
  type QuerySpec,
  type PacketProposal,
  type QuerySpecDraft,
  type TypedSupportEdge
} from "../../../recall/decision/budget-aware-q/types.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallEmbeddingRealStorage
} from "../../shared/real-sqlite.test-support.js";
import { retrieveSources, type ReadyArtifactReader } from "./bounded-retrieval.js";
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

export interface SliceRecallResult {
  readonly referenceInput: { readonly spec: QuerySpec; readonly units: readonly EvidenceUnit[];
    readonly edges: readonly TypedSupportEdge[]; readonly packets: readonly PacketProposal[] };
  readonly pack: PackedRecall;
  readonly membership: readonly string[];
  readonly querySpecDigest: string;
  readonly selectionCount: number;
  readonly counters: SliceCounters;
  readonly decisionDiagnostics: Pick<DecisionResult, "phaseWork" | "workUsed" | "formationWork">;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

export async function createSliceHarness(register: (database: StorageDatabase) => void, filename = ":memory:", embeddingProvider?: EmbeddingProviderPort) {
  const storage = await createRecallEmbeddingRealStorage(register, filename);
  storage.memoryEmbeddingRepo.prepareBoundedRecallIndex();
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
  let artifactReader: ReadyArtifactReader | undefined;
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
  const sourceIds: string[] = [];
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
    if (enrich) counters.garden_enqueue += 1;
    sourceIds.push(created.object_id);
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

  async function runRecall(draft: QuerySpecDraft, signal?: AbortSignal): Promise<SliceRecallResult> {
    const started = performance.now();
    let phaseStarted = started;
    const phaseMs: Record<string, number> = {};
    const phase = (name: string) => { const now = performance.now(); phaseMs[name] = now - phaseStarted; phaseStarted = now; };
    const revision = () => storage.database.connection.prepare("SELECT MAX(rowid) AS revision FROM event_log").get() as { revision: number | null };
    const pinnedRevision = revision().revision;
    counters.query_embed_count = 0; counters.selection_count = 0;
    counters.artifact_validation_utf8_bytes = 0; counters.embedding_id_json_bytes = 0; counters.embedding_vector_payload_bytes = 0;
    counters.embedding_id_metadata_utf8_bytes = 0;
    counters.native_artifact_visits = 0; counters.native_artifact_bytes = 0;
    counters.native_assertion_visits = 0; counters.native_assertion_bytes = 0;
    counters.native_lexical_visits = 0; counters.native_lexical_bytes = 0;
    counters.row_visits = 0; counters.raw_bytes = 0; counters.source_reads = 0; counters.source_revision_rows = 0; counters.assertion_rows = 0;
    const assertLease = () => {
      if (revoked || signal?.aborted || revision().revision !== pinnedRevision) throw new Error("query snapshot revoked, cancelled or stale");
    };
    assertLease();
    const captured = captureQuerySpec(draft, fieldContractSha256, () => NOW, { embedding: embeddingProvider !== undefined });
    if (captured.spec.workspaceId !== WS || captured.spec.principal !== "agent" ||
        captured.spec.authorizedScopes.some((scope) => scope !== WS)) {
      throw new Error("query authority does not match trusted session");
    }
    phase("capture_and_lease");
    const { probes, edges, inactiveResults, contradictions, sourceCache, rawTruncated } = await retrieveSources({
      captured, storage, memoryReader, recallReader, embeddingProvider, artifactReader, counters });
    phase("retrieval");
    const field = admitField(captured.spec, probes);
    const activeResults = new Set(edges.map((edge) => edge.resultObjectId));
    const admittedIds = field.e1.filter((id) => !inactiveResults.has(id) || activeResults.has(id));
    const units: EvidenceUnit[] = [];
    for (const id of admittedIds) {
      const row = sourceCache.get(id) ?? null;
      if (row === null || row.workspace_id !== captured.spec.workspaceId || row.lifecycle_state !== "active" || row.retention_state === "tombstoned") continue;
      const framed = framedByteLength(id, row.content);
      units.push({
        id,
        dimension: row.dimension,
        source: { workspaceId: row.workspace_id, sourceObjectId: id,
          sourceRevision: row.sourceRevision,
          evidenceRefs: [...row.evidence_refs] },
        content: row.content,
        framedBytes: framed,
        chargedTokens: framed,
        familyRanks: field.ranks.get(id) ?? {},
        answerBindings: captured.spec.enumeration ? edges.filter((edge) => edge.resultObjectId === id)
          .map((edge) => `${captured.spec.workspaceId}:${edge.sourceObjectId}:${edge.predicate}:${edge.targetObjectId}`) : [],
        assignmentKey: edges.find((edge) => edge.resultObjectId === id)?.assignmentKey ?? null
      });
    }
    const packets = emitPackets({ ...captured.spec, packetM: units.length + captured.spec.obligations.length }, units.map((unit) => unit.id), edges);
    phase("field_and_source_binding");
    const decision = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges
    });
    phase("decision_including_setup_order_and_prerender");
    counters.selection_count += decision.selectionCount;
    const deliveredDecision = { ...decision, truncated: decision.truncated || field.truncated || rawTruncated };
    const withClaim = withClaims(deliveredDecision, finalizeClaims({
      spec: captured.spec,
      decision: deliveredDecision,
      edges,
      contradictions,
      fieldTruncated: field.truncated || rawTruncated
    }));
    assertLease();
    const pack = packDecision(withClaim, units);
    phase("claims_and_delivery");
    const referenceInput = detachInput({ spec: captured.spec, units, edges, packets });
    phase("fixture_reference_capture");
    phaseMs.total = performance.now() - started;
    counters.phase_ms = Object.freeze(phaseMs);
    counters.rss = process.memoryUsage().rss;
    return {
      referenceInput,
      pack,
      membership: withClaim.membership,
      querySpecDigest: captured.digest,
      selectionCount: decision.selectionCount,
      counters: { ...counters },
      decisionDiagnostics: { phaseWork: decision.phaseWork, workUsed: decision.workUsed, formationWork: decision.formationWork }
    };
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

  async function plantLocalVectors() {
    if (!embeddingProvider) throw new Error("local embedding provider unavailable");
    const rows = await Promise.all(sourceIds.map((id) => storage.memoryEntryRepo.findById(id)));
    const admitted = rows.filter((row) => row !== null);
    const vectors = await embeddingProvider.embedTexts(admitted.map((row) => row.content), { timeoutMs: 30000 });
    for (const [index, row] of admitted.entries()) {
      await storage.memoryEmbeddingRepo.upsert({ object_id: row.object_id, workspace_id: WS,
        content_hash: `sha256:${createHash("sha256").update(row.content).digest("hex")}`,
        provider_kind: embeddingProvider.providerKind, model_id: embeddingProvider.modelId,
        schema_version: embeddingProvider.schemaVersion, dimensions: vectors[index]!.length,
        embedding: vectors[index]!, created_at: NOW, updated_at: NOW });
    }
  }

  return {
    bindReadyArtifactReader: (reader: NonNullable<typeof artifactReader>) => { artifactReader = reader; },
    recallReader,
    plantLocalVectors,
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

export const JOIN_OBLIGATION = Object.freeze({
  supportForm: "endpoint_path" as const,
  kind: "conjunction",
  bindingSlot: "owner_and_channel",
  assignmentKey: "owner:orion",
  requiredPredicates: Object.freeze(["owns", "escalation_channel"])
});

export { CONTENT, EV, MEM, NOW, WS };
