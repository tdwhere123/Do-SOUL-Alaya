import type {
  initDatabase,
  SqliteClaimFormRepo,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteSynthesisCapsuleRepo
} from "@do-soul/alaya-storage";
import type { createBoundRecallPathReadPorts } from "../recall/recall-path-read-bind.js";

export interface RecallReadWorkerRuntime {
  readonly database: ReturnType<typeof initDatabase>;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  readonly synthesisCapsuleRepo: SqliteSynthesisCapsuleRepo;
  readonly claimFormRepo: SqliteClaimFormRepo;
  readonly recallPathReadPorts: ReturnType<typeof createBoundRecallPathReadPorts>;
  closed: boolean;
}
