import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  FormationKind,
  GardenRole,
  GardenTaskKind,
  MemoryDimension,
  ScopeClass,
  SignalEventType,
  SourceKind,
  isRelationValidityActiveAt,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { auditOfficialApiSignalFormation } from "@do-soul/alaya-soul";
import {
  digestRelationFormationEventSource,
  SqliteGardenTaskRepo,
  SqliteRelationAssertionRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { EvidenceService } from "../../../memory/evidence-service.js";
import { MemoryService } from "../../../memory/memory-service.js";
import { RelationAssertionService } from "../../../relations/relation-assertions/relation-assertion-service.js";
import { EventPublisher } from "../../../runtime/event-publisher.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { finalizeClaims, packDecision, withClaims } from "../../../recall/decision/budget-aware-q/claims.js";
import { admitField, emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import {
  framedByteLength,
  type EvidenceUnit,
  type FamilyProbeResult,
  type PackedRecall,
  type QuerySpecDraft,
  type TypedSupportEdge
} from "../../../recall/decision/budget-aware-q/types.js";
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
  full_tier_scan: number;
  rss: "not_observed";
  db_bytes: number | "not_observed";
}

export interface SliceRecallResult {
  readonly pack: PackedRecall;
  readonly membership: readonly string[];
  readonly querySpecDigest: string;
  readonly selectionCount: number;
  readonly counters: SliceCounters;
}

const REMOTE_VECTOR = new Float32Array([1, 0]);

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value), "utf8").digest("hex");
}

function contentHash(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

export async function createSliceHarness(register: (database: StorageDatabase) => void) {
  const storage = await createRecallEmbeddingRealStorage(register);
  const eventLogRepo = storage.eventLogRepo;
  const notify = { notify: async () => {}, notifyEntry: async () => {} };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier: notify
  });
  const relationRepo = new SqliteRelationAssertionRepo(storage.database);
  const garden = new SqliteGardenTaskRepo(storage.database.connection, {
    appendManyWithMutation: async (_events, mutate) => mutate([])
  });
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
    full_tier_scan: 0,
    rss: "not_observed",
    db_bytes: "not_observed"
  };
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
      surface_id: null
    });
    counters.write_ack_ms = performance.now() - started;
    if (enrich) {
      garden.enqueue({
        id: `enrich:${WS}:${id}:v1`,
        workspace_id: WS,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.BULK_ENRICH,
        payload: { source_object_id: id, source_revision: 1 },
        created_at: NOW
      });
      counters.garden_enqueue += 1;
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
  } = {}) {
    await writeMemory(MEM.checklist, CONTENT.checklist, MemoryDimension.PROCEDURE, options.enrich === true);
    await writeMemory(MEM.remote, CONTENT.remote, MemoryDimension.EPISODE, options.enrich === true);
    await writeMemory(MEM.orion, CONTENT.orion, MemoryDimension.FACT, false);
    await writeMemory(MEM.channel, CONTENT.channel, MemoryDimension.FACT, false);
    await writeMemory(MEM.charlie, CONTENT.charlie, MemoryDimension.FACT, false);
    await writeMemory(MEM.bob, CONTENT.bob, MemoryDimension.FACT, false);
    if (options.plantVectors === true) {
      await storage.memoryEmbeddingRepo.upsert({
        object_id: MEM.remote,
        workspace_id: WS,
        content_hash: contentHash(CONTENT.remote),
        provider_kind: "local_c02",
        model_id: "planted",
        schema_version: 1,
        dimensions: 2,
        embedding: REMOTE_VECTOR,
        created_at: NOW,
        updated_at: NOW
      });
    }
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
        targetId: "alice",
        resultObjectId: MEM.orion,
        relationKind: "owns",
        assignmentKey: "Platform",
        validity: { kind: "open", valid_from: "2025-01-01T00:00:00.000Z" },
        gist: "Alice owns Orion"
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

  function typedEdges(asOf: string): TypedSupportEdge[] {
    return relationRepo.listAssertionsInCurrentTransaction()
      .filter((assertion) => isRelationValidityActiveAt(assertion.validity, asOf, new Set()))
      .map((assertion) => {
        const parameters = assertion.formation_receipt.parameters as Readonly<Record<string, unknown>>;
        const source = assertion.anchors.source_anchor;
        const target = assertion.anchors.target_anchor;
        return {
          predicate: assertion.relation_kind,
          assignmentKey: String(parameters.assignment_key ?? "default"),
          sourceObjectId: source.kind === "object" ? source.object_id : "",
          targetObjectId: target.kind === "object" ? target.object_id : "",
          resultObjectId: String(parameters.result_object_id ?? "")
        };
      })
      .filter((edge) => edge.resultObjectId.length > 0);
  }

  async function runRecall(draft: QuerySpecDraft): Promise<SliceRecallResult> {
    const captured = captureQuerySpec({ workspaceId: WS, asOf: NOW, ...draft }, fieldContractSha256, () => NOW);
    const probes: FamilyProbeResult[] = [];
    const compiled = compileRecallQueryProbes(captured.spec.text);
    const lexicalQuery = compiled.lexical_terms.length > 0
      ? compiled.lexical_terms.join(" ")
      : captured.spec.text;
    const lexical = await storage.memoryEntryRepo.searchByKeyword(
      WS, lexicalQuery, captured.spec.nBase
    );
    counters.row_visits += lexical.length;
    probes.push({
      family: "lexical",
      probeId: "fts",
      hits: lexical.map((hit, index) => ({ id: hit.object_id, rank: index + 1 }))
    });
    const edges = captured.spec.familyCaps.typed_relation === "ready"
      ? typedEdges(captured.spec.asOf)
      : [];
    if (captured.spec.familyCaps.typed_relation === "ready") {
      const typedIds = [...new Set(edges.map((edge) => edge.resultObjectId))].sort();
      probes.push({
        family: "typed_relation",
        probeId: "assertions",
        hits: typedIds.map((id, index) => ({ id, rank: index + 1 }))
      });
    }
    if (captured.spec.familyCaps.embedding === "ready") {
      counters.query_embed_count += 1;
      const queryVector = REMOTE_VECTOR;
      const records = await storage.memoryEmbeddingRepo.listByObjectIds(WS, [MEM.remote, MEM.checklist, MEM.orion]);
      const ranked = [...records].sort((left, right) =>
        cosine(right.embedding, queryVector) - cosine(left.embedding, queryVector)
      );
      counters.row_visits += ranked.length;
      probes.push({
        family: "embedding",
        probeId: "planted",
        hits: ranked.map((record, index) => ({ id: record.object_id, rank: index + 1 }))
      });
    }
    const field = admitField(captured.spec, probes);
    counters.row_visits = Math.max(counters.row_visits, field.rowVisits);
    const activeResults = new Set(edges.map((edge) => edge.resultObjectId));
    const inactiveResults = new Set(
      relationRepo.listAssertionsInCurrentTransaction()
        .filter((assertion) => !isRelationValidityActiveAt(assertion.validity, captured.spec.asOf, new Set()))
        .map((assertion) => {
          const parameters = assertion.formation_receipt.parameters as Readonly<Record<string, unknown>>;
          return String(parameters.result_object_id ?? "");
        })
        .filter((id) => id.length > 0 && !activeResults.has(id))
    );
    const admittedIds = field.e1.filter((id) => !inactiveResults.has(id));
    const units: EvidenceUnit[] = [];
    for (const id of admittedIds) {
      const row = await storage.memoryEntryRepo.findById(id);
      if (row === null) continue;
      const framed = framedByteLength(id, row.content);
      units.push({
        id,
        content: row.content,
        framedBytes: framed,
        chargedTokens: framed,
        familyRanks: field.ranks.get(id) ?? {},
        answerBindings: captured.spec.enumeration ? [id] : [],
        assignmentKey: edges.find((edge) => edge.resultObjectId === id)?.assignmentKey ?? null
      });
    }
    const packets = emitPackets(captured.spec, units.map((unit) => unit.id), edges);
    const decision = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges,
      packets
    });
    counters.selection_count += decision.selectionCount;
    const withClaim = withClaims(decision, finalizeClaims({
      spec: captured.spec,
      decision,
      edges,
      fieldTruncated: field.truncated
    }));
    return {
      pack: packDecision(withClaim, units),
      membership: withClaim.membership,
      querySpecDigest: captured.digest,
      selectionCount: decision.selectionCount,
      counters: { ...counters }
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

  return {
    database: storage.database,
    memoryEntryRepo: storage.memoryEntryRepo,
    garden,
    counters,
    writeMemory,
    plantLaunchCorpus,
    admitRelation,
    typedEdges,
    runRecall,
    fakeTransportAdmit,
    pendingGarden: () => garden.peekPending(GardenRole.LIBRARIAN, WS, 32)
  };
}

export const JOIN_OBLIGATION = Object.freeze({
  kind: "conjunction",
  bindingSlot: "owner_and_channel",
  assignmentKey: "Platform",
  requiredPredicates: Object.freeze(["owns", "escalation_channel"])
});

export { CONTENT, EV, MEM, NOW, WS };
