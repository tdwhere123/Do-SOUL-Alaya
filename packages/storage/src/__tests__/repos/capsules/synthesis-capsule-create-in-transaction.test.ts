import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryGovernanceEventType,
  RunMode,
  RunState,
  SynthesisStatus,
  WorkspaceKind,
  WorkspaceState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import { SqliteRunRepo } from "../../../repos/runtime/run-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../../../repos/capsules/synthesis-capsule-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    topic_key: "tooling/pnpm",
    synthesis_type: "phase_synthesis",
    summary: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    source_memory_refs: ["memory-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    synthesis_status: SynthesisStatus.WORKING,
    ...overrides
  };
}

describe("SqliteSynthesisCapsuleRepo.createInCurrentTransaction", () => {
  it("joins the caller transaction so a later throw rolls back EventLog and capsule", async () => {
    const { repo, database } = await createRepo();
    const eventLogRepo = new SqliteEventLogRepo(database);
    const capsule = createSynthesisCapsule();

    expect(() =>
      eventLogRepo.transactional(() => {
        eventLogRepo.append({
          event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
          entity_type: "synthesis_capsule",
          entity_id: capsule.object_id,
          workspace_id: capsule.workspace_id,
          run_id: capsule.run_id,
          caused_by: capsule.created_by,
          payload_json: {
            object_id: capsule.object_id,
            object_kind: capsule.object_kind,
            workspace_id: capsule.workspace_id,
            run_id: capsule.run_id
          }
        });
        repo.createInCurrentTransaction(capsule);
        throw new Error("row failed after append");
      })
    ).toThrow("row failed after append");

    await expect(repo.findById(capsule.object_id)).resolves.toBeNull();
    await expect(eventLogRepo.queryByEntity("synthesis_capsule", capsule.object_id)).resolves.toEqual([]);
  });
});

async function createRepo(): Promise<{
  readonly repo: SqliteSynthesisCapsuleRepo;
  readonly database: ReturnType<typeof initDatabase>;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return { repo: new SqliteSynthesisCapsuleRepo(database), database };
}
