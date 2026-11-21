import { CoreError, type AuditedSourceReplacement } from "@do-soul/alaya-core";
import type { SourceRecordIdentity } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import type { FieldProjectionAdmissionMode } from "./admission-mode.js";
import type { SqliteFieldProjectionLifecycle } from
  "./sqlite-field-projection-lifecycle.js";

export interface FieldProjectionCheckpointPort {
  refresh(): Promise<boolean>;
}

export function createSourceReplacementAdmissionIntents(database: StorageDatabase) {
  const connection = database.connection;
  return {
    retain(record: SourceRecordIdentity): void {
      connection.prepare(`INSERT INTO source_replacement_admission_pending (workspace_id, record_id)
        VALUES (?, ?) ON CONFLICT DO NOTHING`).run(record.workspace_id, record.identity);
    },
    clear(record: SourceRecordIdentity): void {
      connection.prepare(`DELETE FROM source_replacement_admission_pending
        WHERE workspace_id = ? AND record_id = ?`).run(record.workspace_id, record.identity);
    },
    list() {
      return connection.prepare(`SELECT workspace_id, record_id FROM source_replacement_admission_pending
        ORDER BY workspace_id, record_id`).all() as { workspace_id: string; record_id: string }[];
    }
  };
}

export function withSourceReplacementAdmissionRecovery(
  projection: FieldProjectionCheckpointPort,
  sourceReplacement: AuditedSourceReplacement,
  intents: ReturnType<typeof createSourceReplacementAdmissionIntents>
): FieldProjectionCheckpointPort {
  return {
    async refresh() {
      const refreshed = await projection.refresh();
      const pending = intents.list();
      for (const intent of pending) {
        const recovered = await sourceReplacement.recoverAdmission(intent.record_id, { workspaceId: intent.workspace_id });
        if (recovered.status !== "projection_settled") throw recovered.cause;
        if (recovered.audit.status === "audit_incomplete") {
          throw new CoreError("CONFLICT", "Pending source replacement admission audit could not be recovered.", {
            cause: recovered.audit.cause
          });
        }
      }
      return refreshed || pending.length > 0;
    }
  };
}

export function admitFieldProjectionLifecycle(
  raw: SqliteFieldProjectionLifecycle,
  mode: FieldProjectionAdmissionMode
): Readonly<{
  readonly projectionLifecycle: SqliteFieldProjectionLifecycle;
  readonly fieldProjectionCheckpoint: FieldProjectionCheckpointPort;
}> {
  // Leftover queue rows from a crashed seed must rebuild before drainPending
  // can be wrapped as a no-op.
  raw.drainPending();
  if (mode === "immediate") {
    return Object.freeze({
      projectionLifecycle: raw,
      fieldProjectionCheckpoint: { refresh: async () => false }
    });
  }
  return Object.freeze({
    projectionLifecycle: wrapExplicitCheckpointLifecycle(raw),
    fieldProjectionCheckpoint: {
      refresh: async () => {
        raw.drainPending();
        return true;
      }
    }
  });
}

function wrapExplicitCheckpointLifecycle(
  raw: SqliteFieldProjectionLifecycle
): SqliteFieldProjectionLifecycle {
  return Object.freeze({
    rebuild: (workspaceId, recordedAt) => raw.rebuild(workspaceId, recordedAt),
    requestRebuild: (workspaceId, requestedAt) =>
      raw.requestRebuild(workspaceId, requestedAt),
    drainPending() { return "deferred" as const; },
    checkpoint() {
      raw.drainPending();
    }
  });
}
