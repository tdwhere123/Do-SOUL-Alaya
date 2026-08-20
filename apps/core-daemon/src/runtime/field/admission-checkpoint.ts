import type { FieldProjectionAdmissionMode } from "./admission-mode.js";
import type { SqliteFieldProjectionLifecycle } from
  "./sqlite-field-projection-lifecycle.js";

export interface FieldProjectionCheckpointPort {
  refresh(): Promise<boolean>;
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
    drainPending() {},
    checkpoint() {
      raw.drainPending();
    }
  });
}
