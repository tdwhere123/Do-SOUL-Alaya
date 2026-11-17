import { CoreError, runFieldAtomicWithOutcome, type FieldAtomicOutcome, type FieldFormationStores } from "@do-soul/alaya-core";
import type { SqliteFieldProjectionLifecycle } from
  "./sqlite-field-projection-lifecycle.js";

export function createProjectionRebuildingFieldStores(input: Readonly<{
  readonly delegate: FieldFormationStores;
  readonly lifecycle: SqliteFieldProjectionLifecycle;
}>): FieldFormationStores {
  let atomicDepth = 0;
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
    if (outcome.status !== "committed" || outcome.projection === "unready") return outcome;
    try {
      // State and repair intent have committed together. Projection failure
      // cannot undo them; startup or the explicit checkpoint owns recovery.
      const projection = input.lifecycle.drainPending();
      return { status: "committed", result: outcome.result,
        projection: projection === "deferred" ? "deferred" : outcome.projection };
    } catch (cause) {
      return { status: "committed", result: outcome.result, projection: "unready", cause };
    }
  };
  const runAtomic = <T>(work: () => T): T => {
    if (atomicDepth !== 0) return input.delegate.runAtomic(() => withinAtomic(work));
    const outcome = runAtomicWithOutcome(work);
    if (outcome.status !== "committed" || outcome.projection === "unready") throw outcome.cause;
    return outcome.result;
  };
  const persistWithRebuildIntent = <T>(workspaceId: string, recordedAt: string, work: () => T): T => {
    // This savepoint also protects direct writes and rolls back their intent
    // with an enclosing transaction. An in-memory dirty set cannot survive a crash.
    const result = input.delegate.runAtomic(() => {
      const persisted = work();
      input.lifecycle.requestRebuild(workspaceId, recordedAt);
      return persisted;
    });
    if (atomicDepth === 0) input.lifecycle.drainPending();
    return result;
  };
  return {
    ...input.delegate,
    runAtomic,
    runAtomicWithOutcome,
    putRecord: (record, contentBytes) => persistWithRebuildIntent(
      record.workspace_id, record.recorded_at, () => input.delegate.putRecord(record, contentBytes)
    ),
    putIncidence: incidence => persistWithRebuildIntent(
      incidence.workspace_id, incidence.recorded_at, () => input.delegate.putIncidence(incidence)
    )
  };
}
