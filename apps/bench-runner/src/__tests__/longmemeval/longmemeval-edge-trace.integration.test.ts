import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RecallService,
  resetCoreConfigForTests,
  type RecallServiceDependencies
} from "@do-soul/alaya-core";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  RetentionPolicy,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

import { BenchRecallDiagnosticsSchema } from "../../harness/recall-diagnostics-schema.js";
import { buildQuestionDiagnostic } from "../../longmemeval/diagnostics.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";

const WORKSPACE_ID = "workspace-edge-trace";
const RUN_ID = "run-edge-trace";
const SEED_ID = "00000000-0000-4000-8000-000000000101";
const TARGET_ID = "00000000-0000-4000-8000-000000000102";
const PATH_ID = "path-edge-trace";
const SLICE_ENV = "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY";
const CAP_ENV = "ALAYA_RECALL_CONF_FLOOD_CAP";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  delete process.env[SLICE_ENV];
  delete process.env[CAP_ENV];
  resetCoreConfigForTests();
});

describe("LongMemEval edge trace integration", () => {
  it("parses a capped typed-anchor match from SQLite through both strict schemas", async () => {
    process.env[SLICE_ENV] = "on";
    process.env[CAP_ENV] = "0.001";
    resetCoreConfigForTests();
    const storage = await createStorage();
    await storage.memoryRepo.create(memory(SEED_ID, "deploy staging database edge trace"));
    await storage.memoryRepo.create(memory(
      TARGET_ID,
      "Paris deploy staging database target answer",
      [{ facet: "location_place", value: "Paris" }]
    ));
    storage.pathRepo.create(answerPath("location_place"));

    const service = createRecallService(storage.memoryRepo, storage.pathRepo);
    const result = await service.recall({
      taskSurface: taskSurface(),
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      strategy: "build",
      diagnosticCapture: "answer_features"
    });
    const parsed = BenchRecallDiagnosticsSchema.parse(result.diagnostics);
    expect(parsed.query_probes.normalized_query).toBe(taskSurface().display_name);
    expect(parsed.query_sought_facets).toContain("location_place");
    const targetCandidate = parsed.candidates.find((row) => row.object_id === TARGET_ID);
    expect(targetCandidate).toMatchObject({
      answer_features: {
        content: "Paris deploy staging database target answer",
        evidence_gist: null,
        evidence_gist_truncated: false,
        facet_tags: [{ facet: "location_place", value: "Paris" }],
        projection_schema_version: 1
      },
      path_suppression_score: 0
    });
    const target = parsed.fusion_breakdown.find((row) => row.object_id === TARGET_ID);
    expect(target?.flood_potential?.edge_traces).toEqual([
      expect.objectContaining({
        schema_version: 1,
        path_id: PATH_ID,
        relation_kind: "answers_with",
        seed_object_id: SEED_ID,
        target_object_id: TARGET_ID,
        slice_compatibility: "slice_match",
        capped_transfer: 0.001,
        decision: "transferred",
        reason: "capped"
      })
    ]);

    const strictQuestion = buildStrictQuestion(result);
    expect(strictQuestion).toMatchObject({
      query_probes: { normalized_query: taskSurface().display_name },
      query_sought_facets: ["location_place"]
    });
    expect(strictQuestion.candidates.find((row) => row.object_id === TARGET_ID)).toMatchObject({
      answer_features: targetCandidate?.answer_features,
      path_suppression_score: 0
    });
    expect(strictQuestion.gold[0]?.flood_potential?.edge_traces?.[0]).toEqual(
      expect.objectContaining({ path_id: PATH_ID, slice_compatibility: "slice_match" })
    );
  });

  it("passes an unavailable target projection through both strict schemas", async () => {
    process.env[SLICE_ENV] = "on";
    resetCoreConfigForTests();
    const storage = await createStorage();
    await storage.memoryRepo.create(memory(SEED_ID, "deploy staging database edge trace"));
    await storage.memoryRepo.create(memory(
      TARGET_ID,
      "Paris deploy staging database target answer"
    ));
    storage.pathRepo.create(answerPath("location_place"));

    const result = await createRecallService(storage.memoryRepo, storage.pathRepo).recall({
      taskSurface: taskSurface(),
      workspaceId: WORKSPACE_ID,
      runId: RUN_ID,
      strategy: "build"
    });
    const parsed = BenchRecallDiagnosticsSchema.parse(result.diagnostics);
    const target = parsed.fusion_breakdown.find((row) => row.object_id === TARGET_ID);
    expect(target?.flood_potential?.edge_traces?.[0]).toEqual(expect.objectContaining({
      slice_compatibility: "missing_target_key",
      decision: "transferred",
      reason: "transferred"
    }));

    const strictQuestion = buildStrictQuestion(result);
    expect(strictQuestion.gold[0]?.flood_potential?.edge_traces?.[0]).toEqual(
      expect.objectContaining({
        slice_compatibility: "missing_target_key",
        decision: "transferred"
      })
    );
  });

  it("keeps default and env-off scores identical, then rejects a typed mismatch on env-on", async () => {
    const storage = await createStorage();
    await storage.memoryRepo.create(memory(SEED_ID, "deploy staging database edge trace"));
    await storage.memoryRepo.create(memory(
      TARGET_ID,
      "Paris deploy staging database target answer",
      [{ facet: "location_place", value: "Paris" }]
    ));
    storage.pathRepo.create(answerPath("food_dining"));
    const service = createRecallService(storage.memoryRepo, storage.pathRepo);

    const defaultResult = await service.recall(recallInput());
    process.env[SLICE_ENV] = "off";
    resetCoreConfigForTests();
    const envOffResult = await service.recall(recallInput());
    process.env[SLICE_ENV] = "on";
    resetCoreConfigForTests();
    const envOnResult = await service.recall(recallInput());

    const defaultFlood = targetFlood(defaultResult.diagnostics);
    const envOffFlood = targetFlood(envOffResult.diagnostics);
    const envOnFlood = targetFlood(envOnResult.diagnostics);
    expect(defaultFlood.edge_traces?.[0]).toEqual(expect.objectContaining({
      slice_compatibility: "no_slice_match",
      decision: "transferred"
    }));
    expect(Object.is(defaultFlood.A_path, envOffFlood.A_path)).toBe(true);
    expect(Object.is(defaultFlood.final_score, envOffFlood.final_score)).toBe(true);
    expect(envOnFlood).toEqual(expect.objectContaining({ A_path: 0 }));
    expect(envOnFlood.edge_traces?.[0]).toEqual(expect.objectContaining({
      slice_compatibility: "no_slice_match",
      decision: "rejected",
      reason: "no_slice_match"
    }));
  });
});

function buildStrictQuestion(result: Awaited<ReturnType<RecallService["recall"]>>) {
  const question = buildQuestionDiagnostic({
    questionId: "q-edge-trace",
    goldMemoryIds: [TARGET_ID],
    answerSessionIds: [],
    deliveredResults: result.candidates.map((candidate, index) => ({
      object_id: candidate.object_id,
      object_kind: candidate.object_kind,
      rank: index + 1,
      relevance_score: candidate.relevance_score
    })),
    hitAt1: result.candidates[0]?.object_id === TARGET_ID,
    hitAt5: result.candidates.slice(0, 5).some((row) => row.object_id === TARGET_ID),
    hitAt10: result.candidates.slice(0, 10).some((row) => row.object_id === TARGET_ID),
    degradationReason: result.degradation_reason,
    embeddingMode: "disabled",
    recallResult: result
  });
  return LongMemEvalQuestionDiagnosticSchema.parse(question);
}

function recallInput() {
  return {
    taskSurface: taskSurface(),
    workspaceId: WORKSPACE_ID,
    runId: RUN_ID,
    strategy: "build" as const
  };
}

function targetFlood(diagnostics: unknown) {
  const parsed = BenchRecallDiagnosticsSchema.parse(diagnostics);
  const flood = parsed.fusion_breakdown.find((row) => row.object_id === TARGET_ID)?.flood_potential;
  if (flood === undefined) throw new Error("target flood diagnostics missing");
  return flood;
}

async function createStorage(): Promise<Readonly<{
  database: StorageDatabase;
  memoryRepo: SqliteMemoryEntryRepo;
  pathRepo: SqlitePathRelationRepo;
}>> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  await new SqliteWorkspaceRepo(database).create({
    workspace_id: WORKSPACE_ID,
    name: "edge trace workspace",
    root_path: "/tmp/edge-trace",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(database).create({
    run_id: RUN_ID,
    workspace_id: WORKSPACE_ID,
    title: "edge trace run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return Object.freeze({
    database,
    memoryRepo: new SqliteMemoryEntryRepo(database),
    pathRepo: new SqlitePathRelationRepo(database)
  });
}

function createRecallService(
  memoryRepo: SqliteMemoryEntryRepo,
  pathRepo: SqlitePathRelationRepo
): RecallService {
  const append = vi.fn(async (
    event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): Promise<EventLogEntry> => ({
    event_id: `event-${event.event_type}`,
    created_at: "2026-07-10T00:00:00.000Z",
    revision: 0,
    ...event
  }));
  const dependencies: RecallServiceDependencies = {
    now: () => "2026-07-10T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: memoryRepo.findByWorkspaceId.bind(memoryRepo),
      findByDimension: memoryRepo.findByDimension.bind(memoryRepo),
      findByScopeClass: memoryRepo.findByScopeClass.bind(memoryRepo),
      searchByKeyword: memoryRepo.searchByKeyword.bind(memoryRepo),
      searchByKeywordWithinObjectIds: memoryRepo.searchByKeywordWithinObjectIds.bind(memoryRepo),
      findByEvidenceRefs: memoryRepo.findByEvidenceRefs.bind(memoryRepo)
    },
    slotRepo: { findByWorkspace: vi.fn(async () => []) },
    eventLogRepo: { append, queryByEntity: vi.fn(async () => []) },
    pathExpansionPort: {
      findByAnchors: pathRepo.findByAnchors.bind(pathRepo)
    }
  };
  return new RecallService(dependencies);
}

function memory(
  objectId: string,
  content: string,
  facetTags: MemoryEntry["facet_tags"] = null
): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z",
    created_by: "edge-trace-test",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content,
    domain_tags: ["database"],
    evidence_refs: [],
    facet_tags: facetTags,
    canonical_entities: null,
    projection_schema_version: 1,
    workspace_id: WORKSPACE_ID,
    run_id: RUN_ID,
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.8,
    retention_score: 0.8,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function answerPath(sourceFacet: string): PathRelation {
  return {
    path_id: PATH_ID,
    workspace_id: WORKSPACE_ID,
    anchors: {
      source_anchor: {
        kind: "object_facet",
        object_id: SEED_ID,
        facet_key: sourceFacet
      },
      target_anchor: { kind: "object", object_id: TARGET_ID }
    },
    constitution: {
      relation_kind: "answers_with",
      why_this_relation_exists: ["integration evidence"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "stable",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: { status: "active", retirement_rule: "manual" },
    legitimacy: {
      evidence_basis: ["integration evidence"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-07-10T00:00:00.000Z",
    updated_at: "2026-07-10T00:00:00.000Z"
  };
}

function taskSurface(): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-07-10T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: "where was the deploy staging database",
    context_refs: []
  };
}
