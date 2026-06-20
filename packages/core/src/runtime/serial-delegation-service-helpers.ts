import {
  DelegatedWorkerRunSchema,
  type DelegatedWorkerRun,
  type WorkerBaselineLock
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { type IntegrationGatePublicationError } from "../security/integration-gate.js";
import type { PreDispatchFreezeIntent } from "./serial-delegation-recovery.js";

interface DirtyStatePanicServicePort {
  triggerPanic(input: {
    readonly workerRunId: string;
    readonly trigger: "safety_gate_failure" | "state_inconsistency";
    readonly panicSource: string;
    readonly summary: string;
    readonly affectedScope: readonly { entity_type: string; entity_id: string }[];
  }): unknown | Promise<unknown>;
}

export interface PreparedWorkerRunState {
  runtimePrompt: string;
  effectiveWorkerRun: DelegatedWorkerRun;
  insertedWorkerRun: boolean;
  preDispatchConflict: CoreError | null;
  preDispatchFreezeIntent: PreDispatchFreezeIntent | null;
}

export interface WorkerSessionState {
  sessionId: string | null;
  unsubscribe: (() => void) | null;
}

export function applyAugmentedLockToWorkerRun(
  workerRun: Readonly<DelegatedWorkerRun>,
  lock: Readonly<WorkerBaselineLock>
): DelegatedWorkerRun {
  return DelegatedWorkerRunSchema.parse({
    ...workerRun,
    principal_security_snapshot: {
      ...workerRun.principal_security_snapshot,
      hard_constraint_refs: mergeUniqueStrings(
        workerRun.principal_security_snapshot.hard_constraint_refs,
        lock.hard_constraint_refs
      ),
      denied_tool_categories: mergeUniqueStrings(
        workerRun.principal_security_snapshot.denied_tool_categories,
        lock.denied_tool_categories
      )
    }
  });
}

export function requireWorkerBaselineLock(
  lock: WorkerBaselineLock | null | undefined,
  lockName: string
): WorkerBaselineLock {
  if (lock == null) {
    throw new CoreError("VALIDATION", `Serial delegation requires a non-null ${lockName}.`);
  }

  return lock;
}

export function isConflictError(error: unknown): error is Error & { readonly code: "CONFLICT" } {
  return (
    error instanceof Error &&
    error.name === "StorageError" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "CONFLICT"
  );
}

export function isObligationViolationError(error: unknown): error is CoreError {
  return error instanceof CoreError && error.code === "OBLIGATION_VIOLATION";
}

export function createPreparedWorkerRunState(
  runtimePrompt: string,
  workerRun: DelegatedWorkerRun
): PreparedWorkerRunState {
  return {
    runtimePrompt,
    effectiveWorkerRun: workerRun,
    insertedWorkerRun: false,
    preDispatchConflict: null,
    preDispatchFreezeIntent: null
  };
}

export function createWorkerSessionState(): WorkerSessionState {
  return {
    sessionId: null,
    unsubscribe: null
  };
}

export async function triggerPreDispatchPanic(
  dirtyStatePanicService: DirtyStatePanicServicePort,
  state: PreparedWorkerRunState,
  panicSource: string,
  blockerLabel: string,
  summary: string,
  trigger: "safety_gate_failure" | "state_inconsistency",
  affectedScope: readonly { entity_type: string; entity_id: string }[]
): Promise<void> {
  state.preDispatchFreezeIntent = { panicSource, summary };
  state.preDispatchConflict = new CoreError(
    "CONFLICT",
    `Serial delegation blocked by ${blockerLabel}: ${summary}`
  );
  await dirtyStatePanicService.triggerPanic({
    workerRunId: state.effectiveWorkerRun.worker_run_id,
    trigger,
    panicSource,
    summary,
    affectedScope
  });
}

export function captureIntegrationGateFailure(
  state: PreparedWorkerRunState,
  error: unknown
): void {
  const publicationError = error as IntegrationGatePublicationError | null;
  if (
    publicationError === null ||
    typeof publicationError !== "object" ||
    !("decision" in publicationError) ||
    !("durableDecisionCommitted" in publicationError)
  ) {
    return;
  }

  if (publicationError.decision.level === "hard_stale") {
    state.preDispatchConflict ??= new CoreError(
      "CONFLICT",
      `Serial delegation blocked by integration gate: ${publicationError.decision.reason}`
    );
  }

  if (
    publicationError.decision.level === "hard_stale" ||
    publicationError.durableDecisionCommitted
  ) {
    state.preDispatchFreezeIntent ??= {
      panicSource: "integration_gate",
      summary: publicationError.decision.reason
    };
  }
}

function mergeUniqueStrings(
  existing: readonly string[],
  additions: readonly string[]
): readonly string[] {
  return [...new Set([...existing, ...additions])];
}
