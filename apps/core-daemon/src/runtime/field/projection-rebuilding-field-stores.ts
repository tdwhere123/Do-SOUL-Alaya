import { CoreError, runFieldAtomicWithOutcome, type FieldAtomicOutcome, type FieldFormationStores } from "@do-soul/alaya-core";
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
  const withinAtomic = <T>(work: () => T): T => {
    atomicDepth += 1;
    try { return work(); }
    finally { atomicDepth -= 1; }
  };
  const runAtomicWithOutcome = <T>(work: () => T): FieldAtomicOutcome<T> => {
    if (atomicDepth !== 0) {
      return { status: "not_committed", cause: new CoreError("CONFLICT", "source replacement requires a top-level transaction") };
    }
    const outcome = runFieldAtomicWithOutcome(input.delegate, () => withinAtomic(work));
    if (outcome.status !== "committed" || outcome.projection === "unready") {
      dirty.clear();
      return outcome;
    }
    try {
      // The delegate's transaction has committed. Rebuild failure cannot undo it.
      const projection = flushRebuilds(dirty, input.lifecycle);
      return { status: "committed", result: outcome.result,
        projection: projection === "deferred" ? "deferred" : outcome.projection };
    } catch (cause) {
      dirty.clear();
      return { status: "committed", result: outcome.result, projection: "unready", cause };
    }
  };
  const runAtomic = <T>(work: () => T): T => {
    if (atomicDepth !== 0) return input.delegate.runAtomic(() => withinAtomic(work));
    const outcome = runAtomicWithOutcome(work);
    if (outcome.status !== "committed" || outcome.projection === "unready") throw outcome.cause;
    return outcome.result;
  };
  return {
    ...input.delegate,
    runAtomic,
    runAtomicWithOutcome,
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
): void | "deferred" {
  const pending = [...dirty].sort(([left], [right]) => left.localeCompare(right));
  dirty.clear();
  for (const [workspaceId, recordedAt] of pending) {
    lifecycle.requestRebuild(workspaceId, recordedAt);
  }
  return lifecycle.drainPending();
}

function requestAndDrain(
  lifecycle: SqliteFieldProjectionLifecycle,
  workspaceId: string,
  recordedAt: string
): void {
  lifecycle.requestRebuild(workspaceId, recordedAt);
  lifecycle.drainPending();
}
