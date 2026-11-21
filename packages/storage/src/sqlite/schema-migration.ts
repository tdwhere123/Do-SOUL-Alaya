import { deleteGardenSemanticWorkspaceRows } from "../repos/garden/semantic-artifact-schema.js";
import { pruneOrphanedLexicalDomains, rebuildSourceIndexLexicalDomains } from "../repos/source-index/lexical-domain.js";
import { StorageError } from "../shared/errors.js";
import type { SqliteConnection } from "./db.js";
import { migrateEmbeddingVectorValidity } from "./embedding-vector-validity-migration.js";
import { migrateRetainedSourceChunks } from "./retained-source-migration.js";
import {
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  migrateLegacyPathRelationsToTemporalCandidate,
  type TemporalDatabaseMode
} from "./temporal-cutover-gate.js";
import { TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION, migrateVerifiedProjectionBindKey } from "./temporal-verified-bind-key.js";

const WORKSPACE_ORPHAN_CLEANUP_VERSION = 50;
const DATA_MIGRATIONS: Readonly<Partial<Record<
  number,
  (database: SqliteConnection, temporalMode: TemporalDatabaseMode) => void
>>> = {
  [TEMPORAL_OFFLINE_MIGRATION_VERSION]: (database, temporalMode) => {
    migrateLegacyPathRelationsToTemporalCandidate(database, { selectionRequired: temporalMode === "candidate" });
  },
  [TEMPORAL_VERIFIED_BIND_KEY_MIGRATION_VERSION]: migrateVerifiedProjectionBindKey,
  13: migrateRetainedSourceChunks,
  15: migrateEmbeddingVectorValidity,
  28: rebuildSourceIndexLexicalDomains,
  [WORKSPACE_ORPHAN_CLEANUP_VERSION]: (database) => {
    deleteGardenSemanticWorkspaceRows(database, "projections");
    pruneOrphanedLexicalDomains(database);
  }
};

export function applySchemaMigration(
  database: SqliteConnection, version: number, temporalMode: TemporalDatabaseMode, sql: string
): void {
  if (version === TEMPORAL_OFFLINE_MIGRATION_VERSION && temporalMode === "runtime") {
    throw new StorageError(
      "CONFLICT",
      "Temporal relation migration is offline-only and cannot run in runtime mode."
    );
  }
  if (version === WORKSPACE_ORPHAN_CLEANUP_VERSION) {
    deleteGardenSemanticWorkspaceRows(database, "task_dependencies");
  }
  database.exec(sql);
  DATA_MIGRATIONS[version]?.(database, temporalMode);
}
