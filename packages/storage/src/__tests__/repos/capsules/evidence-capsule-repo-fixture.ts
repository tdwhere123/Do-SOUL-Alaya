import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEvidenceCapsuleRepo } from "../../../repos/capsules/evidence-capsule-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

export const evidenceCapsuleDatabases = new Set<ReturnType<typeof initDatabase>>();

export function createEvidenceCapsule(
  overrides: Partial<EvidenceCapsule> = {}
): EvidenceCapsule {
  return {
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "build output",
      keywords: ["pnpm", "build"],
      summary: "Build output from CI"
    },
    event_anchor: {
      event_type: "engine.response.received",
      event_id: "evt_1",
      occurred_at: "2026-03-20T00:00:00.000Z"
    },
    physical_anchor: {
      file_path: "packages/core/src/memory/evidence-service.ts",
      line_range: { start: 1, end: 120 },
      symbol_name: "EvidenceService",
      artifact_ref: "artifact://evidence/1"
    },
    evidence_health_state: "verified",
    gist: "Evidence gist",
    excerpt: "Detailed evidence excerpt",
    source_hash: "sha256:abc",
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null,
    ...overrides
  };
}

export async function createEvidenceCapsuleRepo(filename = ":memory:"): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteEvidenceCapsuleRepo;
}> {
  const database = initDatabase({ filename });
  evidenceCapsuleDatabases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await seedWorkspaceAndRuns(workspaceRepo, runRepo);
  return { database, repo: new SqliteEvidenceCapsuleRepo(database) };
}

async function seedWorkspaceAndRuns(
  workspaceRepo: SqliteWorkspaceRepo,
  runRepo: SqliteRunRepo
): Promise<void> {
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "workspace two",
    root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await createRun(runRepo, "run-1", "workspace-1", "run one");
  await createRun(runRepo, "run-2", "workspace-1", "run two");
  await createRun(runRepo, "run-3", "workspace-2", "run three");
}

async function createRun(
  runRepo: SqliteRunRepo,
  runId: string,
  workspaceId: string,
  title: string
): Promise<void> {
  await runRepo.create({
    run_id: runId,
    workspace_id: workspaceId,
    title,
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
}
