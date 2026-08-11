import {
  CandidateMemorySignalSchema,
  ControlPlaneObjectKind,
  RetentionPolicy,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";

export async function seedHigherRankedFillers(
  memoryRepo: SqliteMemoryEntryRepo,
  answer: Readonly<MemoryEntry>
): Promise<void> {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "40000000-0000-4000-8000-000000000000",
    "41111111-1111-4111-8111-111111111111"
  ];
  for (const [index, objectId] of ids.entries()) {
    await memoryRepo.create({
      ...answer,
      object_id: objectId,
      content: `I bought my new bookshelf from Store${index + 1}.`,
      activation_score: 1,
      retention_score: 1,
      confidence: 1
    });
  }
}

export function recallSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "77777777-7777-4777-8777-777777777777",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-25T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

export async function seedWorkspaceRun(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace-1",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run-1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}

export function createPreferenceProjectionSignal(): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-pref-projection-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "model_tool",
    signal_kind: "potential_preference",
    signal_state: "triaged",
    object_kind: "workflow_preference",
    scope_hint: ScopeClass.PROJECT,
    domain_tags: ["ui"],
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: {
      matched_text: "The operator prefers dark mode.",
      distilled_fact: "The operator prefers dark mode.",
      preference_profile: {
        projection_schema_version: 1,
        preference_subject: "operator",
        preference_predicate: "prefers",
        preference_object: "dark mode",
        preference_category: "ui",
        preference_polarity: "positive"
      }
    },
    created_at: "2026-05-25T00:00:00.000Z"
  });
}
