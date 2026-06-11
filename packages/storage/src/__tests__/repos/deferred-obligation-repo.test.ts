import { afterEach, describe, expect, it } from "vitest";
import { RunMode, RunState, WorkspaceKind, WorkspaceState, type DeferredObligation } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../db.js";
import { SqliteDeferredObligationRepo } from "../../repos/deferred-obligation-repo.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteDeferredObligationRepo", () => {
  it("creates and reads deferred obligations as frozen protocol values", async () => {
    const { repo } = await createRepos();
    const obligation = createObligation();

    expect(repo.create(obligation)).toEqual(obligation);

    const found = await repo.getById(obligation.obligation_id);
    expect(found).toEqual(obligation);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it("updates state with compare-and-swap semantics", async () => {
    const { repo } = await createRepos();
    const obligation = createObligation();
    await repo.create(obligation);

    const fulfilled = await repo.updateState(obligation.obligation_id, "pending", "fulfilled", {
      fulfilledAt: "2026-04-15T10:30:00.000Z"
    });
    expect(fulfilled.state).toBe("fulfilled");
    expect(fulfilled.fulfilled_at).toBe("2026-04-15T10:30:00.000Z");

    expect(() =>
      repo.updateState(obligation.obligation_id, "pending", "expired")
    ).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("returns run/workspace active sets and expired pending obligations", async () => {
    const { repo } = await createRepos();
    await repo.create(
      createObligation({
        obligation_id: "pending-run-1",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        state: "pending",
        expires_at: "2026-04-15T11:59:00.000Z"
      })
    );
    await repo.create(
      createObligation({
        obligation_id: "pending-run-2",
        source_run_id: "run-2",
        workspace_id: "workspace-1",
        state: "pending",
        expires_at: "2026-04-16T12:00:00.000Z"
      })
    );
    await repo.create(
      createObligation({
        obligation_id: "fulfilled-run-1",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        state: "fulfilled",
        fulfilled_at: "2026-04-15T11:00:00.000Z"
      })
    );

    await expect(repo.findActiveByRun("run-1")).resolves.toEqual([
      createObligation({
        obligation_id: "pending-run-1",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        state: "pending",
        expires_at: "2026-04-15T11:59:00.000Z"
      })
    ]);
    await expect(repo.findActiveByWorkspace("workspace-1")).resolves.toHaveLength(2);
    await expect(repo.findExpired("2026-04-15T12:00:00.000Z")).resolves.toEqual([
      createObligation({
        obligation_id: "pending-run-1",
        source_run_id: "run-1",
        workspace_id: "workspace-1",
        state: "pending",
        expires_at: "2026-04-15T11:59:00.000Z"
      })
    ]);
  });
});

async function createRepos(): Promise<{
  readonly repo: SqliteDeferredObligationRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const repo = new SqliteDeferredObligationRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "Workspace One",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "Run 1",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "Run 2",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { repo };
}

function createObligation(overrides: Partial<DeferredObligation> = {}): DeferredObligation {
  return {
    obligation_id: overrides.obligation_id ?? "obligation-1",
    kind: overrides.kind ?? "safety_finding",
    state: overrides.state ?? "pending",
    description: overrides.description ?? "Resolve safety finding before completion.",
    source_run_id: overrides.source_run_id ?? "run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    target_entity_id: overrides.target_entity_id,
    created_at: overrides.created_at ?? "2026-04-15T10:00:00.000Z",
    expires_at: overrides.expires_at ?? "2026-04-16T10:00:00.000Z",
    fulfilled_at: overrides.fulfilled_at
  };
}
