import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

export const REAL_SQLITE_TEST_WORKSPACE_ID = "workspace-1";
export const REAL_SQLITE_TEST_RUN_ID = "run-1";

type RealSqliteFixture = {
  readonly database: StorageDatabase;
};

type RegisterDatabase = (database: StorageDatabase) => void;

async function createBaseRealSqliteDatabase(registerDatabase: RegisterDatabase): Promise<StorageDatabase> {
  const database = initDatabase({ filename: ":memory:" });
  registerDatabase(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  await workspaceRepo.create({
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  return database;
}

export async function createResolutionServiceRealStorage(
  registerDatabase: RegisterDatabase
): Promise<
  RealSqliteFixture & {
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly claimFormRepo: SqliteClaimFormRepo;
  }
> {
  const database = await createBaseRealSqliteDatabase(registerDatabase);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const claimFormRepo = new SqliteClaimFormRepo(database);
  return { database, eventLogRepo, claimFormRepo };
}

export async function createRecallRealStorage(
  registerDatabase: RegisterDatabase
): Promise<
  RealSqliteFixture & {
    readonly memoryEntryRepo: SqliteMemoryEntryRepo;
    readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  }
> {
  const database = await createBaseRealSqliteDatabase(registerDatabase);
  const runRepo = new SqliteRunRepo(database);

  await runRepo.create({
    run_id: REAL_SQLITE_TEST_RUN_ID,
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database)
  };
}
