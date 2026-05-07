import { afterEach, describe, expect, it } from "vitest";
import {
  EventPublisher,
  WorkspaceService,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

// gate-6-delta I3/N3: a real-storage proof for the cwd workspace
// concurrent-first-registration race. The prior idempotence test in
// `packages/core/src/__tests__/workspace-service.test.ts` injects a
// hand-built "duplicate" error and runs two `ensureLocalWorkspace`
// calls sequentially; that locks the symptom, not the actual race.
// Gate-6 closeout claimed MF-B5 closed this race; this integration
// test exercises it end-to-end against `SqliteWorkspaceRepo` and a
// real `EventPublisher` with `Promise.all` of two simultaneous calls.

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createInMemoryDb(): StorageDatabase {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  return database;
}

function createWorkspaceServiceUnderTest(database: StorageDatabase) {
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);

  // Minimal stubs: the workspace_created flow never reaches runs and
  // never publishes a run_hot_state apply, so a no-op suffices here.
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });

  return {
    eventPublisher,
    eventLogRepo,
    workspaceRepo,
    service: new WorkspaceService({
      workspaceRepo,
      runRepo,
      eventPublisher
    })
  };
}

describe("WorkspaceService.ensureLocalWorkspace — real-storage concurrency", () => {
  it("two concurrent calls converge on one row, one workspace_created event", async () => {
    const database = createInMemoryDb();
    const { service, workspaceRepo, eventLogRepo } =
      createWorkspaceServiceUnderTest(database);

    const target = {
      workspaceId: "local_concurrent_001",
      name: "concurrent",
      rootPath: "/tmp/concurrent"
    };

    const [first, second] = await Promise.all([
      service.ensureLocalWorkspace(target),
      service.ensureLocalWorkspace(target)
    ]);

    expect(first.workspace_id).toBe("local_concurrent_001");
    expect(second.workspace_id).toBe("local_concurrent_001");

    const all = await workspaceRepo.list();
    const matching = all.filter(
      (workspace) => workspace.workspace_id === "local_concurrent_001"
    );
    expect(matching).toHaveLength(1);

    const events = await eventLogRepo.queryByEntity("workspace", "local_concurrent_001");
    const created = events.filter((event) => event.event_type === "workspace.created");
    expect(created).toHaveLength(1);
  });

  it("a third call after the race still returns the same row without re-emitting workspace_created", async () => {
    const database = createInMemoryDb();
    const { service, eventLogRepo } = createWorkspaceServiceUnderTest(database);

    const target = {
      workspaceId: "local_concurrent_002",
      name: "concurrent",
      rootPath: "/tmp/concurrent-2"
    };

    await Promise.all([
      service.ensureLocalWorkspace(target),
      service.ensureLocalWorkspace(target)
    ]);
    const third = await service.ensureLocalWorkspace(target);
    expect(third.workspace_id).toBe("local_concurrent_002");

    const events = await eventLogRepo.queryByEntity("workspace", "local_concurrent_002");
    const created = events.filter((event) => event.event_type === "workspace.created");
    expect(created).toHaveLength(1);
  });
});
