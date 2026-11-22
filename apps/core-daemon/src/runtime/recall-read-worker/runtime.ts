import {
  SqliteClaimFormRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase,
  type initDatabase
} from "@do-soul/alaya-storage";
import { createBoundRecallPathReadPorts, type RecallPathReadBind } from "../recall/recall-path-read-bind.js";

export interface RecallReadWorkerRuntime {
  readonly database: ReturnType<typeof initDatabase>;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly recallPathReadPorts: ReturnType<typeof createBoundRecallPathReadPorts>;
  closed: boolean;
}

/** Source-semantic read owners need only the pinned SQLite population. */
export type SourceSemanticReadRuntime = Pick<RecallReadWorkerRuntime, "database">;

export function createRecallReadWorkerRuntime(database: StorageDatabase,
  pathReadBind?: RecallPathReadBind): RecallReadWorkerRuntime {
  return {
    database,
    memoryEntryRepo: new SqliteMemoryEntryRepo(database),
    claimFormRepo: new SqliteClaimFormRepo(database),
    recallPathReadPorts: createBoundRecallPathReadPorts({ database, pathReadBind }),
    closed: false
  };
}
