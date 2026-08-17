import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { EvidenceService, RecallService, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createDaemonFieldComposition } from
  "../../../runtime/field/field-composition.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const EVIDENCE_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const tracked = new Set<StorageDatabase>();
const trackedRoots = new Set<string>();

afterEach(() => {
  for (const database of tracked) database.close();
  tracked.clear();
  for (const root of trackedRoots) rmSync(root, { recursive: true, force: true });
  trackedRoots.clear();
});

describe("source to recall live path", () => {
  it("continues recall with a verified sealed empty generation", async () => {
    const empty = openEmptyRecall();
    const result = await empty.recall.recall(recallRequest("Ada"));

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics?.field_projection_trace).toMatchObject({
      candidate_keys: []
    });
    expect(readArtifactCount(empty.database)).toBe(1);
    expect(readProjectionPinReleases(empty.database)).toEqual([CLOCK]);
  });

  it("changes final membership when the sealed source factor changes", async () => {
    const treatment = await openRecall("ada");
    const control = await openRecall("grace");

    const treatmentResult = await treatment.recall.recall(recallRequest("Ada"));
    const controlResult = await control.recall.recall(recallRequest("Ada"));

    expect(treatmentResult.candidates.map((candidate) => candidate.object_id))
      .toContain(MEMORY_ID);
    expect(treatmentResult.candidates.find((candidate) => candidate.object_id === MEMORY_ID)
      ?.source_channels).toContain("field_projection");
    const fieldTrace = treatmentResult.diagnostics?.field_projection_trace;
    expect(fieldTrace?.candidate_keys).toEqual([EVIDENCE_ID]);
    expect(fieldTrace?.candidate_receipts[EVIDENCE_ID]).not.toHaveLength(0);
    expect(fieldTrace?.activation).toMatchObject({
      generation_id: fieldTrace?.generation_id,
      condition_digest: fieldTrace?.condition_digest,
      opened_candidate_keys: expect.arrayContaining([EVIDENCE_ID])
    });
    expect(fieldTrace?.stop).toMatchObject({
      generation_id: fieldTrace?.generation_id,
      condition_digest: fieldTrace?.condition_digest,
      selected_candidate_keys: [EVIDENCE_ID]
    });
    expect(controlResult.candidates.map((candidate) => candidate.object_id))
      .not.toContain(MEMORY_ID);
    expect(readArtifactCount(treatment.database)).toBe(1);
    expect(readProjectionPinReleases(treatment.database)).toEqual([CLOCK]);
    expect(readProjectionPinReleases(control.database)).toEqual([CLOCK]);
  });

  it("evaluates evidence health at the query reference time", async () => {
    const runtime = await openRecall("ada");
    await runtime.evidenceService.transitionHealth(
      EVIDENCE_ID, "broken", "test_transition", "system"
    );

    const before = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:00:30.000Z"
    });
    const after = await runtime.recall.recall({
      ...recallRequest("Ada"),
      referenceTime: "2026-08-16T00:02:00.000Z"
    });
    expect(before.candidates.map((candidate) => candidate.object_id)).toContain(MEMORY_ID);
    expect(after.candidates.map((candidate) => candidate.object_id)).not.toContain(MEMORY_ID);
  });
});

function openEmptyRecall(): Readonly<{
  recall: RecallService;
  database: StorageDatabase;
}> {
  const database = initDatabase({ filename: ":memory:" });
  tracked.add(database);
  seedWorkspace(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({
    database,
    eventLogRepo,
    sha256: fieldContractSha256
  });
  field.projectionLifecycle.rebuild("workspace-1", CLOCK);
  return {
    database,
    recall: new RecallService({
      now: () => CLOCK,
      generateRuntimeId: () => "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      fieldQuerySession: field.querySession,
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => []),
        findByDimension: vi.fn(async () => []),
        findByScopeClass: vi.fn(async () => []),
        findByEvidenceRefs: vi.fn(async () => [])
      },
      slotRepo: { findByWorkspace: vi.fn(async () => []) },
      eventLogRepo
    })
  };
}

async function openRecall(factorValue: string): Promise<Readonly<{
  recall: RecallService;
  database: StorageDatabase;
  eventLogRepo: SqliteEventLogRepo;
  projectionLifecycle: ReturnType<typeof createDaemonFieldComposition>["projectionLifecycle"];
  evidenceService: EvidenceService;
}>> {
  const root = mkdtempSync(join(tmpdir(), "alaya-source-recall-"));
  trackedRoots.add(root);
  const filename = join(root, "alaya.db");
  const formationDatabase = initDatabase({ filename });
  seedWorkspace(formationDatabase);
  const formationEventLog = new SqliteEventLogRepo(formationDatabase);
  const formationField = createDaemonFieldComposition({
    database: formationDatabase,
    eventLogRepo: formationEventLog,
    sha256: fieldContractSha256
  });
  await produceSourceFormation(
    formationDatabase,
    formationEventLog,
    formationField.stores,
    factorValue
  );
  formationDatabase.close();

  const database = initDatabase({ filename });
  tracked.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const field = createDaemonFieldComposition({
    database,
    eventLogRepo,
    sha256: fieldContractSha256
  });
  const memory = memoryEntry();
  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo,
    runtimeNotifier: { notifyEntry: vi.fn() },
    now: () => "2026-08-16T00:01:00.000Z",
    projectionLifecycle: field.projectionLifecycle
  });
  const recall = new RecallService({
    now: () => CLOCK,
    generateRuntimeId: () => "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    fieldQuerySession: field.querySession,
    memoryRepo: {
      findByWorkspaceId: vi.fn(async () => []),
      findByDimension: vi.fn(async () => []),
      findByScopeClass: vi.fn(async () => []),
      findByEvidenceRefs: vi.fn(async (_workspaceId, ids) =>
        ids.includes(EVIDENCE_ID) ? [memory] : [])
    },
    slotRepo: { findByWorkspace: vi.fn(async () => []) },
    eventLogRepo
  });
  return {
    recall,
    database,
    eventLogRepo,
    projectionLifecycle: field.projectionLifecycle,
    evidenceService
  };
}

async function produceSourceFormation(
  database: StorageDatabase,
  eventLogRepo: SqliteEventLogRepo,
  stores: ReturnType<typeof createDaemonFieldComposition>["stores"],
  factorValue: string
): Promise<void> {
  const extract = vi.fn(async () => {
    throw new Error("provider must not run during source formation");
  });
  const service = new EvidenceService({
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database),
    eventLogRepo,
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
    workspace_id: "workspace-1",
    surface_id: null
  });
  expect(extract).not.toHaveBeenCalled();
}

function readProjectionPinReleases(database: StorageDatabase): readonly string[] {
  return database.connection.prepare(`
    SELECT released_at FROM projection_pins ORDER BY reader_id ASC
  `).all().map((row) => (row as { released_at: string }).released_at);
}

function readArtifactCount(database: StorageDatabase): number {
  const row = database.connection.prepare(`
    SELECT COUNT(*) AS count FROM projection_generation_artifacts
  `).get() as { count: number };
  return row.count;
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection.prepare(`
    INSERT INTO workspaces (
      workspace_id, name, root_path, workspace_kind, default_engine_binding,
      workspace_state, created_at, archived_at, default_engine_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("workspace-1", "Field workspace", "/tmp/workspace-1", "local_repo",
    null, "active", CLOCK, null, null);
}

function memoryEntry(): MemoryEntry {
  return {
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: CLOCK,
    updated_at: CLOCK,
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use the Ada source note.",
    domain_tags: [],
    evidence_refs: [EVIDENCE_ID],
    workspace_id: "workspace-1",
    run_id: null,
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.8,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function recallRequest(displayName: string) {
  return {
    taskSurface: taskSurface(displayName),
    workspaceId: "workspace-1",
    strategy: "build" as const
  };
}

function taskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
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
