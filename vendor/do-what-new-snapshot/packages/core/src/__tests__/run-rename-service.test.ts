import { describe, expect, it, vi } from "vitest";
import type { Run } from "@do-what/protocol";
import { CoreError } from "../errors.js";
import { RunService } from "../run-service.js";

// RED: RunService#rename does not exist yet — all tests in this file will fail
// at runtime until the implementation card lands.

function createRun(overrides: Partial<Run> = {}): Run {
  return {
    run_id: "run_test_1",
    workspace_id: "ws_test_1",
    title: "original title",
    goal: null,
    run_mode: "chat",
    engine_binding_id: "binding_1",
    engine_class: "conversation_engine",
    run_state: "idle",
    current_surface_id: null,
    created_at: "2026-04-28T00:00:00.000Z",
    last_active_at: "2026-04-28T00:00:00.000Z",
    ...overrides
  } as Run;
}

function createMockDependencies(overrides: {
  readonly runRepoGetById?: (id: string) => Promise<Run | null>;
  readonly runRepoUpdate?: (id: string, data: Partial<Run>) => Promise<Run>;
} = {}) {
  const existingRun = createRun();

  const runRepo = {
    create: vi.fn(async () => existingRun),
    getById: vi.fn(async (id: string) => {
      if (overrides.runRepoGetById) {
        return overrides.runRepoGetById(id);
      }
      return id === existingRun.run_id ? existingRun : null;
    }),
    listByWorkspace: vi.fn(async () => [existingRun]),
    delete: vi.fn(async () => undefined),
    update: vi.fn(async (id: string, data: Partial<Run>) => {
      if (overrides.runRepoUpdate) {
        return overrides.runRepoUpdate(id, data);
      }
      return { ...existingRun, ...data };
    })
  };

  const publishWithMutation = vi.fn(
    async (_event: unknown, mutate: () => Promise<Run>) => mutate()
  );

  const eventPublisher = {
    publishWithMutation,
    publishManyWithMutation: vi.fn()
  } as any;

  const workspaceRepo = {
    getById: vi.fn(async () => ({
      workspace_id: "ws_test_1",
      name: "test workspace",
      root_path: "/tmp/test",
      workspace_kind: "local_repo",
      repo_path: null,
      default_engine_binding: null,
      default_engine_class: null,
      workspace_state: "active",
      created_at: "2026-04-28T00:00:00.000Z",
      archived_at: null
    }))
  };

  return { runRepo, eventPublisher, publishWithMutation, workspaceRepo };
}

describe("RunService#rename", () => {
  it("renames a run and returns the updated run with the new title", async () => {
    const { runRepo, eventPublisher, workspaceRepo } = createMockDependencies();
    const service = new RunService({ runRepo: runRepo as any, eventPublisher, workspaceRepo });

    // @ts-expect-error rename does not exist yet
    const result = await service.rename({ run_id: "run_test_1", title: "updated title" });

    expect(result.title).toBe("updated title");
  });

  it("throws CoreError(VALIDATION) for an empty title", async () => {
    const { runRepo, eventPublisher, workspaceRepo } = createMockDependencies();
    const service = new RunService({ runRepo: runRepo as any, eventPublisher, workspaceRepo });

    // @ts-expect-error rename does not exist yet
    await expect(service.rename({ run_id: "run_test_1", title: "" })).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.code === "VALIDATION"
    );
  });

  it("throws CoreError(NOT_FOUND) when run id is unknown", async () => {
    const { runRepo, eventPublisher, workspaceRepo } = createMockDependencies({
      runRepoGetById: async () => null
    });
    const service = new RunService({ runRepo: runRepo as any, eventPublisher, workspaceRepo });

    // @ts-expect-error rename does not exist yet
    await expect(service.rename({ run_id: "run_unknown", title: "valid title" })).rejects.toSatisfy(
      (e: unknown) => e instanceof CoreError && e.code === "NOT_FOUND"
    );
  });

  it("calls eventPublisher.publishWithMutation with a RUN_RENAMED event and runs the mutation inside the callback", async () => {
    const { runRepo, eventPublisher, publishWithMutation, workspaceRepo } = createMockDependencies();
    const service = new RunService({ runRepo: runRepo as any, eventPublisher, workspaceRepo });

    // @ts-expect-error rename does not exist yet
    await service.rename({ run_id: "run_test_1", title: "event-ordered title" });

    expect(publishWithMutation).toHaveBeenCalledTimes(1);

    const [eventInput, mutateCallback] = publishWithMutation.mock.calls[0] as [
      { event_type: string; payload_json: Record<string, unknown> },
      () => Promise<Run>
    ];

    expect(eventInput.event_type).toBe("run.renamed");
    expect(eventInput.payload_json).toMatchObject({
      run_id: "run_test_1",
      title: "event-ordered title"
    });

    // The mutation function (runRepo.update) should only be called inside the
    // publishWithMutation callback, not before it.
    expect(runRepo.update).not.toHaveBeenCalled();
    await mutateCallback();
    expect(runRepo.update).toHaveBeenCalledTimes(1);
  });

  it("includes the previous_title in the emitted event payload", async () => {
    const originalRun = createRun({ run_id: "run_test_1", title: "before rename" });
    const { runRepo, eventPublisher, publishWithMutation, workspaceRepo } = createMockDependencies({
      runRepoGetById: async (id) => (id === "run_test_1" ? originalRun : null)
    });
    const service = new RunService({ runRepo: runRepo as any, eventPublisher, workspaceRepo });

    // @ts-expect-error rename does not exist yet
    await service.rename({ run_id: "run_test_1", title: "after rename" });

    const [eventInput] = publishWithMutation.mock.calls[0] as [
      { payload_json: Record<string, unknown> },
      unknown
    ];
    expect(eventInput.payload_json).toMatchObject({
      previous_title: "before rename"
    });
  });
});
