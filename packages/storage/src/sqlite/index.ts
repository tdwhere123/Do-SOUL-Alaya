export {
  initDatabase,
  closeCachedDatabase,
  StorageDatabase,
  getCurrentSchemaSummary,
  configureSqliteWriteQueuePort,
  getSqliteWriteQueuePort,
  TEMPORAL_OFFLINE_MIGRATION_VERSION,
  type InitDatabaseOptions
} from "./db.js";
export {
  EMBEDDING_OVERLAY_ALIAS,
  EMBEDDING_OVERLAY_BIND_FILENAME,
  bindEmbeddingOverlay,
  bindEmbeddingOverlayIfPresent,
  detachEmbeddingOverlay,
  embeddingOverlayBindPath,
  hasEmbeddingOverlayBind,
  writeEmbeddingOverlayBind,
  type EmbeddingOverlayBindConnection,
  type EmbeddingOverlayBindDocument
} from "./embedding-overlay-bind.js";
export {
  createInMemorySqliteWriteQueuePort,
  createSerialSqliteWriteQueuePort,
  type SqliteWriteJob,
  type SqliteWriteJobKind,
  type SqliteWriteQueuePort,
  type SqliteWriteStatement
} from "./write-queue/port.js";
export {
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl,
  type WorkerThreadSqliteWriteQueueOptions
} from "./write-queue/worker-port.js";
export {
  ALAYA_SQLITE_WRITE_QUEUE_ENV,
  installDefaultSqliteWriteQueue,
  isSqliteWriteQueueDisabled
} from "./write-queue/install.js";
export {
  prepareTemporalCandidate,
  type TemporalCandidateFileDigest,
  type TemporalCandidatePreparation
} from "./temporal-offline-candidate.js";
export {
  inspectTemporalProjectionSelection,
  isTemporalProjectionSelected,
  selectTemporalProjection,
  rollbackTemporalProjection,
  type RollbackTemporalProjectionInput,
  type SelectTemporalProjectionInput,
  type TemporalProjectionSelectionAuditEntry,
  type TemporalProjectionSelectionState
} from "./temporal-projection-selection.js";
export {
  acquireTemporalMaintenanceLease,
  type TemporalMaintenanceLease
} from "./temporal-maintenance-lease.js";
