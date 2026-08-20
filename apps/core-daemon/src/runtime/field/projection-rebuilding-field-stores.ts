import type { FieldFormationStores } from "@do-soul/alaya-core";
import type { SqliteFieldProjectionLifecycle } from
  "./sqlite-field-projection-lifecycle.js";

export function createProjectionRebuildingFieldStores(input: Readonly<{
  readonly delegate: FieldFormationStores;
  readonly lifecycle: SqliteFieldProjectionLifecycle;
}>): FieldFormationStores {
  let atomicDepth = 0;
  const dirty = new Map<string, string>();
  const schedule = (workspaceId: string, recordedAt: string) => {
    if (atomicDepth > 0) {
      const previous = dirty.get(workspaceId);
      if (previous === undefined || recordedAt > previous) dirty.set(workspaceId, recordedAt);
      return;
    }
    requestAndDrain(input.lifecycle, workspaceId, recordedAt);
  };
  const runAtomic = <T>(work: () => T): T => {
    const outermost = atomicDepth === 0;
    try {
      const result = input.delegate.runAtomic(() => {
        atomicDepth += 1;
        try {
          return work();
        } finally {
          atomicDepth -= 1;
        }
      });
      if (outermost) flushRebuilds(dirty, input.lifecycle);
      return result;
    } catch (error) {
      if (outermost) dirty.clear();
      throw error;
    }
  };
  return {
    ...input.delegate,
    runAtomic,
    putRecord(record, contentBytes) {
      const persisted = input.delegate.putRecord(record, contentBytes);
      schedule(record.workspace_id, record.recorded_at);
      return persisted;
    },
    putIncidence(incidence) {
      const persisted = input.delegate.putIncidence(incidence);
      schedule(incidence.workspace_id, incidence.recorded_at);
      return persisted;
    }
  };
}

function flushRebuilds(
  dirty: Map<string, string>,
  lifecycle: SqliteFieldProjectionLifecycle
): void {
  const pending = [...dirty].sort(([left], [right]) => left.localeCompare(right));
  dirty.clear();
  for (const [workspaceId, recordedAt] of pending) {
    lifecycle.requestRebuild(workspaceId, recordedAt);
  }
  lifecycle.drainPending();
}

function requestAndDrain(
  lifecycle: SqliteFieldProjectionLifecycle,
  workspaceId: string,
  recordedAt: string
): void {
  lifecycle.requestRebuild(workspaceId, recordedAt);
  lifecycle.drainPending();
}
