import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventPublisher,
  WorkspaceService,
  type RuntimeNotifier
} from "@do-soul/alaya-core";
import {
  WorkspaceKind,
  WorkspaceRunEventType,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  closeCachedDatabase,
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { prepareBenchWorkspaceBinding } from "../../../harness/daemon/workspace/daemon-workspace-seed.js";

const tempDirs = new Set<string>();
const databases = new Set<StorageDatabase>();

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  await Promise.all([...tempDirs].map(async (dir) => {
    closeCachedDatabase(join(dir, "alaya.db"));
    await rm(dir, { recursive: true, force: true });
  }));
  tempDirs.clear();
});

describe("bench workspace bind ordering", () => {
  it("ordinary first bind emits workspace.created then seeds the run", async () => {
    const { dataDir, service, eventLogRepo, runRepo } = await openHarness();

    await prepareBenchWorkspaceBinding({
      dataDir,
      workspaceId: "ordinary-ws",
      runId: "ordinary-run",
      workspaceRoot: join(dataDir, "ordinary-ws"),
      workspaceService: service
    });

    const created = (await eventLogRepo.queryByEntity("workspace", "ordinary-ws"))
      .filter((event) => event.event_type === WorkspaceRunEventType.WORKSPACE_CREATED);
    expect(created).toHaveLength(1);
    expect(await runRepo.getById("ordinary-run")).not.toBeNull();
  });

  it("invokes ensureLocalWorkspace before the run row exists", async () => {
    const { dataDir, service, runRepo } = await openHarness();
    const order: string[] = [];
    const workspaceService = {
      ensureLocalWorkspace: async (
        input: Parameters<typeof service.ensureLocalWorkspace>[0]
      ) => {
        order.push("ensure");
        expect(await runRepo.getById("order-run")).toBeNull();
        return await service.ensureLocalWorkspace(input);
      }
    };

    await prepareBenchWorkspaceBinding({
      dataDir,
      workspaceId: "order-ws",
      runId: "order-run",
      workspaceRoot: join(dataDir, "order-ws"),
      workspaceService
    });

    expect(order).toEqual(["ensure"]);
    expect(await runRepo.getById("order-run")).not.toBeNull();
  });

  it("restored existing workspace does not mint workspace.created and still seeds the run", async () => {
    const { dataDir, service, eventLogRepo, runRepo, workspaceRepo } = await openHarness();
    workspaceRepo.create({
      workspace_id: "restored-ws",
      name: "restored-ws",
      root_path: join(dataDir, "restored-ws"),
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });

    await prepareBenchWorkspaceBinding({
      dataDir,
      workspaceId: "restored-ws",
      runId: "restored-run",
      workspaceRoot: join(dataDir, "restored-ws"),
      workspaceService: service
    });

    const created = (await eventLogRepo.queryByEntity("workspace", "restored-ws"))
      .filter((event) => event.event_type === WorkspaceRunEventType.WORKSPACE_CREATED);
    expect(created).toHaveLength(0);
    expect(await runRepo.getById("restored-run")).not.toBeNull();
  });
});

async function openHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), "bench-ws-bind-"));
  tempDirs.add(dataDir);
  const database = initDatabase({ filename: join(dataDir, "alaya.db") });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const runtimeNotifier: RuntimeNotifier = {
    notify: () => {},
    notifyEntry: () => {}
  };
  const service = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher: new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: () => {} },
      runtimeNotifier
    })
  });
  return { dataDir, database, service, eventLogRepo, runRepo, workspaceRepo };
}
