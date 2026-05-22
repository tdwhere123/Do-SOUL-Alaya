import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  RuntimeGovernanceEventType,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type SoulMemorySearchResponse,
  type SoulReportContextUsageResponse
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteTrustStateRepo,
  SqliteWorkspaceRepo
} from "@do-soul/alaya-storage";
import { EventPublisher } from "@do-soul/alaya-core";
import { createAlayaDaemonRuntime, type AlayaDaemonRuntime } from "../index.js";
import { createPathPlasticityService } from "../path-plasticity-runtime.js";
import { createTrustStateRecorder } from "../trust-state.js";

const tempDirs: string[] = [];
const originalDataDir = process.env.DATA_DIR;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAlayaOpenAiSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
const originalEmbeddingSupplementOptIn = process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT;
const originalAlayaConfigDir = process.env.ALAYA_CONFIG_DIR;
const originalCodexHome = process.env.CODEX_HOME;
const originalHome = process.env.HOME;
const INTEGRATION_TEST_TIMEOUT_MS = 30_000;
const SOURCE_MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_MEMORY_ID = "22222222-2222-4222-8222-222222222222";

afterEach(async () => {
  restoreProcessEnv();

  for (const directory of tempDirs.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("path plasticity daemon wiring", () => {
  it("translates soul usage proof into strength and direction-bias redirection via the Librarian plasticity service (integration)", async () => {
    // This test seeds the daemon database with a PathRelation and a
    // real trust-state delivery+usage receipt, then directly invokes the
    // wired PathPlasticityService (the same service the Garden Librarian's
    // path_plasticity_update task dispatches). It proves the full chain
    //   TrustStateRecorder.recordUsage → MEMORY_USAGE_REPORTED in event_log
    //     → UsageProofReader.listRecentUsage returns the record
    //       → PathRelation strength delta + PATH_RELATION_REDIRECTED audit row
    //         + PATH_RELATION_REINFORCED audit row
    // without going through the Garden scheduler timer (which is covered by
    // the Librarian task tests).
    const dataDir = await createTempDataDir();
    const dbPath = join(dataDir, "alaya.db");
    const database = initDatabase({ filename: dbPath });

    try {
      const eventLogRepo = new SqliteEventLogRepo(database);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const trustStateRepo = new SqliteTrustStateRepo(database);
      const workspaceRepo = new SqliteWorkspaceRepo(database);

      // Workspace FK target.
      await workspaceRepo.create({
        workspace_id: "workspace-1",
        name: "integration workspace",
        root_path: "/tmp/alaya-integration",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });

      // Minimal EventPublisher (no-op runtime notifier / hot state).
      const eventPublisher = new EventPublisher({
        eventLogRepo,
        runHotStateService: { apply: async () => undefined },
        runtimeNotifier: { notify: () => undefined, notifyEntry: () => undefined }
      });

      // 1. Seed a PathRelation anchored on memory M.
      const pathSeed: PathRelation = {
        path_id: "path-integration-1",
        workspace_id: "workspace-1",
        anchors: {
          source_anchor: { kind: "object", object_id: "memory-source" },
          target_anchor: { kind: "object", object_id: "memory-target" }
        },
        constitution: {
          relation_kind: "supports",
          why_this_relation_exists: ["integration-seed"]
        },
        effect_vector: {
          salience: 0.5,
          recall_bias: 0,
          verification_bias: 0,
          unfinishedness_bias: 0,
          default_manifestation_preference: "stance_bias"
        },
        plasticity_state: {
          strength: 0.4,
          direction_bias: "target_to_source",
          stability_class: "normal",
          support_events_count: 0,
          contradiction_events_count: 0
        },
        lifecycle: { retirement_rule: "default" },
        legitimacy: {
          evidence_basis: ["evidence-integration-1"],
          governance_class: "recall_allowed"
        },
        created_at: "2026-04-01T00:00:00.000Z",
        updated_at: "2026-04-01T00:00:00.000Z"
      };
      await pathRelationRepo.create(pathSeed);

      // 2. Persist a delivery + per-anchor usage receipt through the same
      //    trust-state recorder used by soul.report_context_usage.
      const trustStateRecorder = createTrustStateRecorder({
        eventPublisher,
        repo: trustStateRepo,
        ready: true,
        clock: () => "2026-05-04T11:30:00.000Z"
      });
      await trustStateRecorder.recordDelivery({
        delivery_id: "delivery-integration-1",
        agent_target: "integration-test",
        workspace_id: "workspace-1",
        run_id: null,
        delivered_object_ids: ["memory-target"],
        delivered_at: "2026-05-04T10:00:00.000Z"
      });
      await trustStateRecorder.recordUsage(
        {
          delivery_id: "delivery-integration-1",
          usage_state: "used",
          used_object_ids: ["memory-target"],
          per_anchor_usage: [{ object_id: "memory-target", anchor_role: "target" }],
          // Explicit `manual` to exercise the full-reinforcement weight:
          // a usage proof with no trust_mode now fail-safes to `automatic`
          // (lower weight). This test asserts the full 0.10 increment.
          trust_mode: "manual",
          reason: "integration use",
          reported_at: "2026-05-04T11:00:00.000Z"
        },
        { expectedWorkspaceId: "workspace-1" }
      );

      // 3. Build the path plasticity service exactly as the daemon does
      //    in apps/core-daemon/src/index.ts.
      const pathPlasticityService = createPathPlasticityService({
        eventLogRepo,
        trustStateRepo,
        pathRelationRepo,
        eventPublisher,
        now: () => "2026-05-04T12:00:00.000Z"
      });

      // 4. Execute the auditor-equivalent dispatch (sinceIso a few hours
      //    before the receipt's reported_at).
      const result = await pathPlasticityService.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-04T09:00:00.000Z"
      });

      // 5. Assert the loop closed: one reinforcement, the targeted path
      //    is in the affected list, the durable row strength advanced.
      expect(result.reinforced).toBe(1);
      expect(result.weakened).toBe(0);
      expect(result.retired).toBe(0);
      expect(result.affectedPathIds).toEqual(["path-integration-1"]);

      const updatedPath = await pathRelationRepo.findById("path-integration-1");
      expect(updatedPath).not.toBeNull();
      // Expected strength: 0.4 + reinforcement_increment (0.10 from the
      // DYNAMICS_CONSTANTS.path_plasticity authoritative values).
      expect(updatedPath?.plasticity_state.strength).toBeCloseTo(0.5, 10);
      expect(updatedPath?.plasticity_state.direction_bias).toBe("source_to_target");
      expect(updatedPath?.plasticity_state.support_events_count).toBe(1);
      expect(updatedPath?.plasticity_state.last_reinforced_at).toBe(
        "2026-05-04T12:00:00.000Z"
      );

      // 6. Audit rows exist in event log.
      const reinforcementEvents = await eventLogRepo.queryByEntity(
        "path_relation",
        "path-integration-1"
      );
      const redirected = reinforcementEvents.filter(
        (event: EventLogEntry) =>
          event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED
      );
      const reinforced = reinforcementEvents.filter(
        (event: EventLogEntry) =>
          event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
      );
      expect(redirected).toHaveLength(1);
      expect(redirected[0]?.payload_json).toMatchObject({
        path_id: "path-integration-1",
        previous_direction_bias: "target_to_source",
        new_direction_bias: "source_to_target",
        source_usage_count: 0,
        target_usage_count: 1
      });
      expect(reinforced).toHaveLength(1);
      expect(reinforced[0]?.payload_json).toMatchObject({
        path_id: "path-integration-1",
        previous_strength: 0.4,
        new_strength: 0.5,
        support_events_count: 1
      });

      // 7. Sanity: a second tick with sinceIso AFTER the receipt's
      //    reported_at must be a no-op (exclusive watermark per Q4).
      const secondResult = await pathPlasticityService.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-04T11:00:00.000Z"
      });
      expect(secondResult.reinforced).toBe(0);
      expect(secondResult.affectedPathIds).toEqual([]);
    } finally {
      database.close();
    }
  });

  it(
    "drives recall usage through Garden into a redirected later recall",
    async () => {
      const dataDir = await createTempDataDir();
      setRuntimeEnv(dataDir);
      await seedRuntimeRedirectionFixture(dataDir);

      const runtime = await createAlayaDaemonRuntime();
      try {
        const firstRecall = await callRuntimeMemoryTool<SoulMemorySearchResponse>(
          runtime,
          "soul.recall",
          {
            query: "shared direction bias redirection",
            scope_class: ScopeClass.PROJECT,
            dimension: MemoryDimension.PREFERENCE,
            domain_tags: null,
            max_results: 2
          }
        );
        const firstRecallIds = firstRecall.results.map((result) => result.object_id);
        expect(firstRecallIds).toEqual(
          expect.arrayContaining([SOURCE_MEMORY_ID, TARGET_MEMORY_ID])
        );
        expect(firstRecallIds.indexOf(SOURCE_MEMORY_ID)).toBeLessThan(
          firstRecallIds.indexOf(TARGET_MEMORY_ID)
        );

        const usage = await callRuntimeMemoryTool<SoulReportContextUsageResponse>(
          runtime,
          "soul.report_context_usage",
          {
            delivery_id: firstRecall.delivery_id,
            usage_state: "used",
            used_object_ids: [TARGET_MEMORY_ID],
            per_anchor_usage: [{ object_id: TARGET_MEMORY_ID, anchor_role: "target" }],
            reason: "Target anchor carried the useful context."
          }
        );
        expect(usage).toEqual({
          delivery_id: firstRecall.delivery_id,
          status: "recorded"
        });

        await runGardenPassesUntilPathRedirected(runtime, dataDir);

        // initDatabase returns the daemon's cached connection for this file;
        // runtime.shutdown owns closing it while the live recall proof continues.
        const database = initDatabase({ filename: join(dataDir, "alaya.db") });
        const pathRelationRepo = new SqlitePathRelationRepo(database);
        const eventLogRepo = new SqliteEventLogRepo(database);

        const updatedPath = await pathRelationRepo.findById("path-redirection-live");
        expect(updatedPath).not.toBeNull();
        expect(updatedPath?.plasticity_state.direction_bias).toBe("source_to_target");
        // Expected strength: 0.6 + reinforcement_increment * automatic
        // weight (0.10 * AUTOMATIC_TRUST_USED_MULTIPLIER 0.5 = 0.05). The
        // MCP soul.report_context_usage surface records every self-report
        // as `automatic` (server-derived trust_mode), so it carries the
        // lower path-plasticity weight.
        expect(updatedPath?.plasticity_state.strength).toBeCloseTo(0.65, 10);
        expect(updatedPath?.plasticity_state.support_events_count).toBe(1);

        const pathEvents = await eventLogRepo.queryByEntity(
          "path_relation",
          "path-redirection-live"
        );
        expect(
          pathEvents.some(
            (event) =>
              event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED &&
              event.payload_json.previous_direction_bias === "target_to_source" &&
              event.payload_json.new_direction_bias === "source_to_target"
          )
        ).toBe(true);
        expect(
          pathEvents.some(
            (event) =>
              event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED &&
              event.payload_json.new_strength === 0.65
          )
        ).toBe(true);

        const laterRecall = await callRuntimeMemoryTool<SoulMemorySearchResponse>(
          runtime,
          "soul.recall",
          {
            query: "shared direction bias redirection",
            scope_class: ScopeClass.PROJECT,
            dimension: MemoryDimension.PREFERENCE,
            domain_tags: null,
            max_results: 2
          }
        );
        const laterRecallIds = laterRecall.results.map((result) => result.object_id);
        expect(laterRecallIds).toEqual(
          expect.arrayContaining([SOURCE_MEMORY_ID, TARGET_MEMORY_ID])
        );
        expect(laterRecallIds.indexOf(TARGET_MEMORY_ID)).toBeLessThan(
          laterRecallIds.indexOf(SOURCE_MEMORY_ID)
        );
      } finally {
        await runtime.shutdown();
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );
});

async function runGardenPassesUntilPathRedirected(
  runtime: AlayaDaemonRuntime,
  dataDir: string
): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    await runtime.runGardenBackgroundPass();

    // Reuse the daemon's cached connection here; closing it would stop the
    // runtime before the test can issue the later recall.
    const database = initDatabase({ filename: join(dataDir, "alaya.db") });
    const pathRelationRepo = new SqlitePathRelationRepo(database);
    const path = await pathRelationRepo.findById("path-redirection-live");
    if (path?.plasticity_state.direction_bias === "source_to_target") {
      return;
    }
  }
}

async function callRuntimeMemoryTool<TOutput = unknown>(
  runtime: AlayaDaemonRuntime,
  toolName: string,
  args: unknown
): Promise<TOutput> {
  const result = await runtime.services.mcpMemoryToolHandler.call({
    toolName,
    arguments: args,
    context: {
      workspaceId: "workspace-1",
      runId: "run-1",
      agentTarget: "codex",
      sessionId: "path-plasticity-integration-session",
      surfaceId: "gate-5f-e-redirection-proof"
    }
  });

  expect(result).toMatchObject({ ok: true, tool_name: toolName });
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.output as TOutput;
}

async function seedRuntimeRedirectionFixture(dataDir: string): Promise<void> {
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  try {
    const workspaceRepo = new SqliteWorkspaceRepo(database);
    const runRepo = new SqliteRunRepo(database);
    const memoryRepo = new SqliteMemoryEntryRepo(database);
    const pathRelationRepo = new SqlitePathRelationRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "workspace one",
      root_path: "/tmp/alaya-workspace-1",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await runRepo.create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "Gate-5F-E redirection proof run",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    await memoryRepo.create(
      createMemoryEntry({
        object_id: SOURCE_MEMORY_ID,
        content: "shared direction bias redirection source anchor memory"
      })
    );
    await memoryRepo.create(
      createMemoryEntry({
        object_id: TARGET_MEMORY_ID,
        content: "shared direction bias redirection target anchor memory"
      })
    );
    await pathRelationRepo.create({
      path_id: "path-redirection-live",
      workspace_id: "workspace-1",
      anchors: {
        source_anchor: { kind: "object", object_id: SOURCE_MEMORY_ID },
        target_anchor: { kind: "object", object_id: TARGET_MEMORY_ID }
      },
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["gate-5f-e-live-proof"]
      },
      effect_vector: {
        salience: 0.5,
        recall_bias: 0,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.6,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      },
      lifecycle: { retirement_rule: "default" },
      legitimacy: {
        evidence_basis: ["gate-5f-e-live-proof"],
        governance_class: "recall_allowed"
      },
      created_at: "2026-05-04T00:00:00.000Z",
      updated_at: "2026-05-04T00:00:00.000Z"
    });
  } finally {
    database.close();
  }
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: SOURCE_MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-04T00:00:00.000Z",
    updated_at: "2026-05-04T00:00:00.000Z",
    created_by: "gate-5f-e-proof",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "shared direction bias redirection anchor memory",
    domain_tags: ["path-plasticity", "redirection"],
    evidence_refs: ["gate-5f-e-proof"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.5,
    retention_score: 0.5,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

async function createTempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alaya-a3-integration-"));
  tempDirs.push(dir);
  return dir;
}

function setRuntimeEnv(dataDir: string): void {
  process.env.DATA_DIR = dataDir;
  process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ALAYA_ENABLE_EMBEDDING_SUPPLEMENT = "false";
  process.env.ALAYA_CONFIG_DIR = join(dataDir, "config");
  process.env.CODEX_HOME = join(dataDir, "codex-home");
  process.env.HOME = join(dataDir, "home");
}

function restoreProcessEnv(): void {
  restoreEnvVar("DATA_DIR", originalDataDir);
  restoreEnvVar("OPENAI_API_KEY", originalOpenAiApiKey);
  restoreEnvVar("ALAYA_OPENAI_SECRET_REF", originalAlayaOpenAiSecretRef);
  restoreEnvVar("ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", originalEmbeddingSupplementOptIn);
  restoreEnvVar("ALAYA_CONFIG_DIR", originalAlayaConfigDir);
  restoreEnvVar("CODEX_HOME", originalCodexHome);
  restoreEnvVar("HOME", originalHome);
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
