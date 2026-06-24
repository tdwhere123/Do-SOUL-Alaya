import { describe, expect, it } from "vitest";
import {
  CandidateMemorySignalSchema,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { EvidenceService, MemoryService } from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, MaterializationRouter } from "@do-soul/alaya-soul";
import {
  SqliteEnrichPendingRepo,
  SqliteEventLogRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase
} from "@do-soul/alaya-storage";

const MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const EVIDENCE_ID = "55555555-5555-4555-8555-555555555555";

// With projectionRoutingEnabled on, a preference_profile workflow_preference lifts to memory_entry_only; off stays signal_only.
describe("projection routing daemon wiring", () => {
  it("lifts a workflow_preference projection signal to a memory_entry when projections are on", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: true });

      const result = await harness.router.materializeSignal(createPreferenceProjectionSignal());

      expect(result.success).toBe(true);
      expect(result.route_target).toBe("memory_entry_only");
      const memories = await harness.memoryRepo.findByWorkspaceId("workspace-1");
      expect(memories).toHaveLength(1);
      const memory = memories[0]!;
      expect(memory.preference_subject).toBe("operator");
      expect(memory.preference_predicate).toBe("prefers");
      expect(memory.preference_object).toBe("dark mode");
      expect(memory.preference_polarity).toBe("positive");
      expect(memory.projection_schema_version).toBe(1);
    } finally {
      database.close();
    }
  });

  it("leaves a workflow_preference projection signal as signal_only when projections are off", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = await createHarness(database, { projectionRoutingEnabled: false });

      const result = await harness.router.materializeSignal(createPreferenceProjectionSignal());

      expect(result.success).toBe(true);
      expect(result.route_target).toBe("signal_only");
      await expect(harness.memoryRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(0);
      await expect(harness.evidenceRepo.findByWorkspaceId("workspace-1")).resolves.toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

async function createHarness(
  database: ReturnType<typeof initDatabase>,
  options: { readonly projectionRoutingEnabled: boolean }
) {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  const enrichPendingRepo = new SqliteEnrichPendingRepo(database);
  const runtimeNotifier = {
    notify: async () => undefined,
    notifyEntry: async (_entry: EventLogEntry) => undefined
  };

  await seedWorkspaceRun(workspaceRepo, runRepo);

  const evidenceService = new EvidenceService({
    evidenceCapsuleRepo: evidenceRepo,
    eventLogRepo,
    runtimeNotifier,
    generateObjectId: () => EVIDENCE_ID,
    now: () => "2026-05-25T00:00:00.000Z"
  });
  const enqueueEnrichPending = (params: {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }): void =>
    enrichPendingRepo.enqueue({
      workspaceId: params.workspaceId,
      memoryId: params.memoryId,
      runId: params.runId,
      sourceSignalId: params.sourceSignalId,
      enqueuedAt: "2026-05-25T00:00:01.000Z"
    });
  const memoryService = new MemoryService({
    memoryEntryRepo: memoryRepo,
    evidenceService,
    eventLogRepo,
    runtimeNotifier,
    enrichPendingWriter: { enqueue: enqueueEnrichPending },
    generateObjectId: () => MEMORY_ID,
    now: () => "2026-05-25T00:00:00.000Z"
  });
  const router = new MaterializationRouter({
    evidenceService,
    memoryService: {
      create: async (input) => {
        const created = await memoryService.create(input);
        return {
          object_kind: created.object_kind,
          object_id: created.object_id,
          enrichmentEnqueued: input.enqueueEnrichment !== undefined
        };
      }
    },
    synthesisService: {
      create: async () => ({ object_kind: "synthesis_capsule", object_id: "synthesis-1" })
    },
    claimService: {
      create: async () => ({ object_kind: "claim_form", object_id: "claim-1" })
    },
    enrichPendingPort: { enqueue: enqueueEnrichPending },
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    projectionRoutingEnabled: options.projectionRoutingEnabled
  });

  return { router, memoryRepo, evidenceRepo };
}

async function seedWorkspaceRun(
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

function createPreferenceProjectionSignal(): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-pref-projection-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
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
