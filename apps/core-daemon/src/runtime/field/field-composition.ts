import type { CausalUsagePort, FieldContractSha256 } from "@do-soul/alaya-protocol";
import { fieldContractSha256, type FieldFormationStores, type RecallFieldQuerySession } from
  "@do-soul/alaya-core";
import type { SqliteEventLogRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos, type DaemonFieldRepos } from "./field-repos.js";
import { createSqliteCausalUsagePort } from "./sqlite-causal-usage-port.js";
import { createSqliteFieldFormationStores } from "./sqlite-field-formation-stores.js";
import { createSqliteFieldQuerySession } from "./sqlite-field-query-session.js";

export type DaemonFieldComposition = Readonly<{
  readonly fieldRepos: DaemonFieldRepos;
  readonly stores: FieldFormationStores;
  readonly usagePort: CausalUsagePort;
  readonly querySession: RecallFieldQuerySession;
}>;

export function createDaemonFieldComposition(input: Readonly<{
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sha256?: FieldContractSha256;
}>): DaemonFieldComposition {
  const sha256 = input.sha256 ?? fieldContractSha256;
  const fieldRepos = createDaemonFieldRepos({
    database: input.database,
    sha256
  });
  return Object.freeze({
    fieldRepos,
    stores: createSqliteFieldFormationStores({
      database: input.database,
      repos: fieldRepos
    }),
    usagePort: createSqliteCausalUsagePort({
      repo: fieldRepos.usage,
      sha256,
      eventLog: input.eventLogRepo
    }),
    querySession: createSqliteFieldQuerySession({
      generations: fieldRepos.generations,
      eventLog: input.eventLogRepo,
      sha256
    })
  });
}
