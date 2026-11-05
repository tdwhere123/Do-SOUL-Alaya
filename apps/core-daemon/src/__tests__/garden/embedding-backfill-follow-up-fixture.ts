import { AlayaError, FormationKind, MemoryDimension, RunMode, RunState, ScopeClass, SourceKind,
  StorageTier, WorkspaceKind, WorkspaceState, type EvidenceCapsule, type MemoryEntry } from "@do-soul/alaya-protocol";
import { AnswersWithEdgeProducerService, EmbeddingBackfillHandler, EventPublisher, HqAnswerOverlapPairSource,
  RelationAssertionService, type RelationAssertionAdmissionRequest } from "@do-soul/alaya-core";
import { SqliteEvidenceCapsuleRepo, SqliteEventLogRepo, SqliteMemoryEmbeddingRepo, SqliteMemoryEntryRepo,
  SqliteMemoryHqRepo, SqliteRelationAssertionRepo, SqliteRunRepo, SqliteWorkspaceRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { createGardenRuntime } from "../../garden/runtime/runtime.js";
import { createDaemonEmbeddingRuntime } from "../../ai/daemon-embedding-runtime.js";
import { createAnswersWithBackfillPort } from "../../runtime/garden-wiring/answers-with-backfill.js";
import { createRuntimeInput } from "./runtime-fixture.js";

export const WORKSPACE = "workspace-follow-up";
export const OTHER_WORKSPACE = "workspace-follow-up-other";
const RUN = "run-follow-up";
const OTHER_RUN = "run-follow-up-other";
export const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333"] as const;
export const EVIDENCE = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"] as const;
export const CLOCK = "2030-01-01T00:00:00.000Z";
export const notifier = { notify: () => undefined, notifyEntry: () => undefined };

export interface HandoffFaults {
  embedCalls: number;
  admitCalls: number;
  failAdmissionAt: number | null;
  failAfterAdmissionAt: number | null;
  failFollowUpAudit: boolean;
  failPendingAudit?: boolean;
  failRetryClaimAudit?: boolean;
  afterRetryClaimAudit?: () => void;
  pauseAdmissionAt?: number;
  pauseStarted?: () => void;
  pauseUntil?: Promise<void>;
  afterTaskDispatchAudit?: () => void;
  beforeEmbeddingResult?: () => void;
  afterEmbeddingWrite?: () => void;
  afterAssertionAdmission?: () => void;
  afterFollowUpAudit?: () => void;
  afterTaskCompletionAudit?: () => void;
  failEmbedding?: boolean;
  embeddedTexts?: string[][];
}

export function createFaults(): HandoffFaults {
  return { embedCalls: 0, admitCalls: 0, failAdmissionAt: null, failAfterAdmissionAt: null, failFollowUpAudit: false };
}

export async function seedHandoffData(database: StorageDatabase): Promise<void> {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  await workspaceRepo.create({ workspace_id: WORKSPACE, name: "follow-up", root_path: "/tmp/follow-up",
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: RUN, workspace_id: WORKSPACE, title: "follow-up", goal: null,
    run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  await seedMemories(database, IDS, EVIDENCE, 0, WORKSPACE, RUN);
}

export async function seedAdditionalHandoffData(database: StorageDatabase): Promise<void> {
  await new SqliteWorkspaceRepo(database).create({ workspace_id: OTHER_WORKSPACE, name: "other", root_path: "/tmp/follow-up-other",
    workspace_kind: WorkspaceKind.LOCAL_REPO, default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: OTHER_RUN, workspace_id: OTHER_WORKSPACE, title: "other", goal: null,
    run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  await seedMemories(database,
    ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555",
      "66666666-6666-4666-8666-666666666666"],
    ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6"], 3, OTHER_WORKSPACE, OTHER_RUN);
}

async function seedMemories(database: StorageDatabase, ids: readonly string[], evidenceIds: readonly string[],
  offset: number, workspaceId: string, runId: string): Promise<void> {
  const eventLog = new SqliteEventLogRepo(database);
  const evidence = new SqliteEvidenceCapsuleRepo(database);
  const memories = new SqliteMemoryEntryRepo(database);
  const hq = new SqliteMemoryHqRepo(database);
  for (const [position, id] of ids.entries()) {
    const index = position + offset;
    const source = await eventLog.append({ event_type: "engine.response.received", entity_type: "engine_response",
      entity_id: `source-${index}`, workspace_id: workspaceId, run_id: runId, caused_by: "fixture", payload_json: {} });
    const evidenceId = evidenceIds[position]!;
    const capsule: EvidenceCapsule = { object_id: evidenceId, object_kind: "evidence_capsule", schema_version: 1,
      lifecycle_state: "active", created_at: source.created_at, updated_at: source.created_at, created_by: "fixture",
      evidence_kind: "conversation_excerpt", semantic_anchor: { topic: "fixture", keywords: ["fixture"], summary: "fixture" },
      event_anchor: { event_type: "engine.response.received", event_id: source.event_id, occurred_at: source.created_at },
      physical_anchor: null, evidence_health_state: "verified", gist: "fixture evidence", excerpt: "fixture evidence",
      source_hash: null, run_id: runId, workspace_id: workspaceId, surface_id: null };
    await evidence.create(capsule);
    await memories.create(memory(id, evidenceId, index, workspaceId, runId));
    await hq.upsertFromEvidence({ object_id: id, workspace_id: workspaceId,
      hqs: ["cobalt deployment policy workflow"], evidence_id: evidenceId, producer_id: "fixture_hq",
      created_at: CLOCK, updated_at: CLOCK });
  }
}

export function createHandoffRuntime(database: StorageDatabase, faults: HandoffFaults,
  legacyTopologyMutationsEnabled = false, answersUnwired = false, legacyUnmeasured = false,
  useDaemonEmbedding = false) {
  const eventLog = new SqliteEventLogRepo(database);
  const publisher = new EventPublisher({ eventLogRepo: eventLog, runHotStateService: { apply: () => undefined },
    runtimeNotifier: notifier });
  const originalDecide = publisher.decideAppendThenApply.bind(publisher);
  publisher.decideAppendThenApply = async decide => {
    if (faults.failRetryClaimAudit) {
      faults.failRetryClaimAudit = false;
      throw new AlayaError("UNAVAILABLE", "injected retry claim audit failure");
    }
    const result = await originalDecide(decide);
    if (typeof result === "object" && result !== null && "ownerToken" in result) faults.afterRetryClaimAudit?.();
    return result;
  };
  const originalAppend = publisher.appendManyWithMutation.bind(publisher);
  publisher.appendManyWithMutation = async (events, mutate) => {
    if (faults.failPendingAudit && events.some(event => event.event_type === "soul.garden.embedding_follow_up" &&
        event.payload_json.disposition === "pending")) {
      faults.failPendingAudit = false;
      throw new AlayaError("UNAVAILABLE", "injected pending audit failure");
    }
    if (faults.failFollowUpAudit && events.some(event => event.event_type === "soul.garden.embedding_follow_up" &&
        event.payload_json.disposition === "completed")) {
      faults.failFollowUpAudit = false;
      throw new AlayaError("UNAVAILABLE", "injected follow-up audit failure");
    }
    const result = await originalAppend(events, mutate);
    if (events.some(event => event.event_type === "soul.garden.task_dispatched")) faults.afterTaskDispatchAudit?.();
    if (events.some(event => event.event_type === "soul.garden.embedding_follow_up" &&
        event.payload_json.disposition === "completed")) faults.afterFollowUpAudit?.();
    if (events.some(event => event.event_type === "soul.garden.task_completed")) faults.afterTaskCompletionAudit?.();
    return result;
  };
  const relationRepo = new SqliteRelationAssertionRepo(database);
  const assertionService = new RelationAssertionService({ repo: relationRepo, eventPublisher: publisher,
    eventHistory: eventLog, now: () => CLOCK });
  const assertionPort = { admit: async (request: RelationAssertionAdmissionRequest) => {
    faults.admitCalls += 1;
    if (faults.pauseAdmissionAt === faults.admitCalls) {
      faults.pauseStarted?.();
      await faults.pauseUntil;
    }
    if (faults.failAdmissionAt === faults.admitCalls) throw new AlayaError("UNAVAILABLE", "injected admission failure");
    const result = await assertionService.admit(request);
    faults.afterAssertionAdmission?.();
    if (faults.failAfterAdmissionAt === faults.admitCalls) throw new AlayaError("UNAVAILABLE", "injected post-commit failure");
    return result;
  } };
  const memories = new SqliteMemoryEntryRepo(database);
  const embeddings = new SqliteMemoryEmbeddingRepo(database);
  const writeEmbedding = embeddings.upsertForGardenBackfill.bind(embeddings);
  embeddings.upsertForGardenBackfill = async (record, claim) => {
    const result = await writeEmbedding(record, claim);
    if (result !== null) faults.afterEmbeddingWrite?.();
    return result;
  };
  const provider = { providerKind: "fixture", modelId: "fixture", schemaVersion: 1, isAvailable: true,
    embedTexts: async (texts: readonly string[]) => { faults.embedCalls += 1; faults.embeddedTexts?.push([...texts]);
      if (faults.failEmbedding === true) throw new AlayaError("UNAVAILABLE", "fixture embedding unavailable");
      faults.beforeEmbeddingResult?.();
      return texts.map(() => new Float32Array([0.1, 0.2, 0.3])); } };
  const handler = new EmbeddingBackfillHandler({ memoryRepo: memories, memoryEmbeddingRepo: embeddings,
    provider, expectedDimensions: () => 3, now: () => CLOCK, retryDelayMs: 0 });
  const daemonEmbedding = useDaemonEmbedding ? createDaemonEmbeddingRuntime({ database,
    configEnv: new Map([["ALAYA_EMBEDDING_PROVIDER", "local_onnx"], ["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"]]),
    eventLogRepo: eventLog, eventPublisher: publisher, memoryEntryRepo: memories, runtimeNotifier: notifier,
    healthJournalService: { getRecentEvents: async () => [], record: async () => undefined },
    warn: () => undefined, embeddingProviderOverride: provider, embeddingStartupProbe: "omit" }) : undefined;
  const crystallizer = new AnswersWithEdgeProducerService({ pairSource: new HqAnswerOverlapPairSource(new SqliteMemoryHqRepo(database)),
    assertionPort });
  const answersPort = createAnswersWithBackfillPort(database, memories, crystallizer)!;
  const runtime = createGardenRuntime({ ...createRuntimeInput({ databaseConnection: database.connection,
    embeddingBackfillHandler: legacyUnmeasured ? { handle: async () => ({ objectsAffected: [], auditEntries: [] }) }
      : daemonEmbedding?.embeddingBackfillHandler ?? handler,
    workspaceRepo: new SqliteWorkspaceRepo(database), now: () => CLOCK }),
    eventLogRepo: eventLog, eventPublisher: publisher, legacyTopologyMutationsEnabled,
    ...(answersUnwired ? {} : { answersWithEdgeProducerPort: answersPort }) });
  return { runtime, eventLog, publisher, relationRepo, memories, handler, answersPort,
    hq: new SqliteMemoryHqRepo(database) };
}

function memory(objectId: string, evidenceId: string, index: number, workspaceId: string, runId: string): MemoryEntry {
  return { object_id: objectId, object_kind: "memory_entry", schema_version: 1, lifecycle_state: "active",
    created_at: `2026-05-07T00:0${index}:00.000Z`, updated_at: CLOCK, created_by: "fixture",
    dimension: MemoryDimension.PREFERENCE, source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT, content: `Memory ${index} about cobalt deployment policy.`, domain_tags: ["fixture"],
    evidence_refs: [evidenceId], workspace_id: workspaceId, run_id: runId, surface_id: null, storage_tier: StorageTier.HOT,
    activation_score: 0.5, retention_score: 0.9, manifestation_state: "excerpt", retention_state: "working",
    decay_profile: "stable", confidence: 1, last_used_at: null, last_hit_at: null, reinforcement_count: 0,
    contradiction_count: 0, superseded_by: null };
}
