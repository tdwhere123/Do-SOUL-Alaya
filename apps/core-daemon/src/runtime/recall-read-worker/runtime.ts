import {
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo,
  type StorageDatabase,
  type initDatabase
} from "@do-soul/alaya-storage";
import { verifyOfficialApiSourceLocatorBinding } from "@do-soul/alaya-soul";
import { createBoundRecallPathReadPorts, type RecallPathReadBind } from "../recall/recall-path-read-bind.js";

export interface RecallReadWorkerRuntime {
  readonly database: ReturnType<typeof initDatabase>;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  readonly synthesisCapsuleRepo: SqliteSynthesisCapsuleRepo;
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
    evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database, verifyOfficialApiSourceLocatorBinding),
    synthesisCapsuleRepo: new SqliteSynthesisCapsuleRepo(database),
    claimFormRepo: new SqliteClaimFormRepo(database),
    recallPathReadPorts: createBoundRecallPathReadPorts({ database, pathReadBind }),
    closed: false
  };
}
