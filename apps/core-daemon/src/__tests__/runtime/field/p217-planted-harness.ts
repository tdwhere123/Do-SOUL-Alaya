import { afterEach, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  RetentionPolicy,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  hashEffectGovernanceFrontier,
  hashEffectRequestDigest,
  type EffectDecisionReceipt,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  EvidenceService,
  RecallService,
  fieldContractSha256,
  type RecallServiceDependencies
} from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

export const CLOCK = "2026-08-16T00:00:00.000Z";
export const WORKSPACE_ID = "workspace-1";
export const RUN_ID = "run-1";
export const EVIDENCE_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";
export const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
export const RUNTIME_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";

export type PlantedField = ReturnType<typeof createDaemonFieldComposition>;

export function createPlantedHarness() {
  const tracked = new Set<StorageDatabase>();
  const trackedRoots = new Set<string>();
  afterEach(() => {
    for (const database of tracked) database.close();
    tracked.clear();
    for (const root of trackedRoots) rmSync(root, { recursive: true, force: true });
    trackedRoots.clear();
  });
  return {
    openMemoryDatabase(): StorageDatabase {
      return this.openDatabase(":memory:", { seed: true });
    },
    createTempFilename(): string {
      const root = mkdtempSync(join(tmpdir(), "alaya-p217-"));
      trackedRoots.add(root);
      return join(root, "alaya.db");
    },
    openDatabase(
      filename: string,
      options: Readonly<{ readonly seed?: boolean }> = {}
    ): StorageDatabase {
      const database = initDatabase({ filename });
      tracked.add(database);
      if (options.seed === true) {
        seedWorkspace(database);
        seedRun(database);
      }
      return database;
    },
    close(database: StorageDatabase): void {
      database.close();
      tracked.delete(database);
    }
  };
}

export function composeField(database: StorageDatabase): PlantedField {
  return createDaemonFieldComposition({
    database,
    eventLogRepo: new SqliteEventLogRepo(database),
    sha256: fieldContractSha256
  });
}

export function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(WORKSPACE_ID, "Field workspace", "/tmp/workspace-1", "local_repo",
    null, "active", CLOCK, null, null);
}

export function seedRun(database: StorageDatabase, runId = RUN_ID): void {
  new SqliteRunRepo(database).create({
    run_id: runId,
    workspace_id: WORKSPACE_ID,
    title: "planted run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

export async function persistMemory(
  database: StorageDatabase,
  entry: MemoryEntry
): Promise<Readonly<MemoryEntry>> {
  return await new SqliteMemoryEntryRepo(database).create(entry);
}

export function createPlantedRecall(input: Readonly<{
  readonly database: StorageDatabase;
  readonly field: PlantedField;
  readonly memoryRepo: RecallServiceDependencies["memoryRepo"];
  readonly extra?: Partial<RecallServiceDependencies>;
}>): RecallService {
  return new RecallService({
    now: () => CLOCK,
    generateRuntimeId: () => RUNTIME_ID,
    fieldQuerySession: input.field.querySession,
    memoryRepo: input.memoryRepo,
    slotRepo: { findByWorkspace: async () => [] },
    eventLogRepo: new SqliteEventLogRepo(input.database),
    ...input.extra
  });
}

export async function produceAdaSource(
  database: StorageDatabase,
  stores: PlantedField["stores"],
  factorValue: string
): Promise<void> {
  const extract = vi.fn(async () => {
    throw new Error("provider must not run during source formation");
  });
  const service = new EvidenceService({
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo: new SqliteEventLogRepo(database),
    runtimeNotifier: { notifyEntry: vi.fn() },
    generateObjectId: () => EVIDENCE_ID,
    now: () => CLOCK,
    sha256: fieldContractSha256,
    fieldStores: stores,
    semanticExtractor: {
      operator_id: "structured_open_semantic_factor_v1",
      extract
    }
  });
  await service.create({
    created_by: "system",
    evidence_kind: "user_statement",
    semantic_anchor: {
      topic: "notes",
      keywords: [factorValue],
      summary: `${factorValue} notes`
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: `${factorValue} notes`,
    excerpt: `${factorValue} wrote notes.`,
    source_hash: null,
    run_id: "run-1",
    workspace_id: WORKSPACE_ID,
    surface_id: null
  });
  expect(extract).not.toHaveBeenCalled();
}

export function plantRevoke(
  field: PlantedField,
  evidenceId: string,
  effectiveAsOf: string
): EffectDecisionReceipt {
  const witnesses = [{
    receipt_id: "receipt-revoke-1",
    kind: "actor_authority",
    authority_event_id: "delivery-event-1",
    source_record_id: null,
    source_content_digest: null
  }] as const;
  const request = {
    schema_version: 2 as const,
    workspace_id: WORKSPACE_ID,
    actor_id: "actor-1",
    run_id: "run-1",
    delivery_id: "delivery-1",
    action: "revoke",
    target: evidenceId,
    scope: WORKSPACE_ID,
    effective_as_of: effectiveAsOf,
    supporting_receipt_ids: witnesses.map((item) => item.receipt_id),
    supporting_proof_witnesses: witnesses,
    governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
    policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
    policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
  };
  const digest = hashEffectRequestDigest(request, fieldContractSha256);
  return field.effectDecisionStore.insert({
    ...request,
    producer: PROOF_EFFECT_OPERATOR_ID,
    consumer: "governance",
    identity: digest,
    replay_rule: "idempotent_same_identity",
    failure_disposition: "fail_closed",
    governance_effect: "policy_decision",
    deletion_behavior: "retain_identity",
    request_digest: digest,
    decision: "allow",
    recorded_at: effectiveAsOf
  });
}

export function memoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: CLOCK,
    updated_at: CLOCK,
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Sealed procedural binder.",
    domain_tags: [],
    evidence_refs: [EVIDENCE_ID],
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

export function recallRequest(
  displayName: string,
  extra: Readonly<Record<string, unknown>> = {}
) {
  return {
    taskSurface: taskSurface(displayName),
    workspaceId: WORKSPACE_ID,
    strategy: "build" as const,
    ...extra
  };
}

export function taskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: RUNTIME_ID,
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-08-16T01:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

export function readProjectionPinReleases(database: StorageDatabase): readonly string[] {
  return database.connection.prepare(`
    SELECT released_at FROM projection_pins ORDER BY reader_id ASC
  `).all().map((row) => (row as { released_at: string }).released_at);
}

export function readArtifactCount(database: StorageDatabase): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS count FROM projection_generation_artifacts
  `).get() as { count: number };
  return row.count;
}

export function realMemoryRepo(database: StorageDatabase): SqliteMemoryEntryRepo {
  return new SqliteMemoryEntryRepo(database);
}
