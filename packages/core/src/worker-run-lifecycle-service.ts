import {
  ToolWorkerEventType,
  WorkerStateChangedPayloadSchema,
  WorkerStateChangedSuspendReasonSchema,
  type DelegatedWorkerRun,
  type EventLogEntry,
  type WorkerRunState,
  type WorkerStateChangedPayload,
  type WorkerStateChangedState,
  type WorkerStateChangedSuspendReason
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import { assertWorkerTransition } from "./worker-run-state-machine.js";

type WorkerStatePayloadExtras = Omit<WorkerStateChangedPayload, "workerId" | "state" | "previousState">;

export interface WorkerRunRepoPort {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  updateState(
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): Promise<Readonly<DelegatedWorkerRun>>;
}

export interface WorkerRunLifecycleServiceDependencies {
  readonly repo: WorkerRunRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
}

export class WorkerRunLifecycleService {
  public constructor(private readonly dependencies: WorkerRunLifecycleServiceDependencies) {}

  public async dispatch(workerRunId: string): Promise<Readonly<DelegatedWorkerRun>> {
    return this.transition(workerRunId, "active");
  }

  public async complete(
    workerRunId: string,
    returnedObjectRefs: readonly string[]
  ): Promise<Readonly<DelegatedWorkerRun>> {
    return this.transition(workerRunId, "completed", {
      returnedObjectRefs: parseStringArray("returnedObjectRefs", returnedObjectRefs)
    });
  }

  public async suspend(
    workerRunId: string,
    reason: WorkerStateChangedSuspendReason
  ): Promise<Readonly<DelegatedWorkerRun>> {
    return this.transition(workerRunId, "suspended", {
      suspendReason: WorkerStateChangedSuspendReasonSchema.parse(reason)
    });
  }

  public async resume(workerRunId: string): Promise<Readonly<DelegatedWorkerRun>> {
    return this.transition(workerRunId, "active");
  }

  public async abort(
    workerRunId: string,
    params: { readonly reason: string; readonly rollbackAttempted: boolean }
  ): Promise<Readonly<DelegatedWorkerRun>> {
    const parsed = parseAbortParams(params);

    return this.transition(workerRunId, "aborted", {
      abortReason: parsed.reason,
      rollbackAttempted: parsed.rollbackAttempted
    });
  }

  public async freeze(
    workerRunId: string,
    panicSource: string,
    summary: string
  ): Promise<Readonly<DelegatedWorkerRun>> {
    return this.transition(workerRunId, "frozen", {
      panicSource: requireNonEmptyString("panicSource", panicSource),
      panicSummary: requireNonEmptyString("summary", summary)
    });
  }

  private async transition(
    workerRunId: string,
    nextState: WorkerStateChangedState,
    extras: WorkerStatePayloadExtras = {}
  ): Promise<Readonly<DelegatedWorkerRun>> {
    const snapshot = await this.requireWorkerRun(workerRunId);
    assertWorkerTransition(snapshot.state, nextState);

    const updatedAt = this.resolveNow();
    const payload = WorkerStateChangedPayloadSchema.parse({
      workerId: snapshot.worker_run_id,
      state: nextState,
      previousState: snapshot.state,
      ...extras
    });

    return this.dependencies.eventPublisher.publishWithMutation(
      this.buildStateChangedEvent(snapshot, payload),
      async () =>
        this.dependencies.repo.updateState(snapshot.worker_run_id, snapshot.state, nextState, updatedAt)
    );
  }

  private async requireWorkerRun(workerRunId: string): Promise<Readonly<DelegatedWorkerRun>> {
    const parsedWorkerRunId = requireNonEmptyString("workerRunId", workerRunId);
    const workerRun = await this.dependencies.repo.getById(parsedWorkerRunId);

    if (workerRun === null) {
      throw new CoreError("NOT_FOUND", "Worker run not found");
    }

    return workerRun;
  }

  private buildStateChangedEvent(
    workerRun: Readonly<DelegatedWorkerRun>,
    payload: WorkerStateChangedPayload
  ): Omit<EventLogEntry, "event_id" | "created_at"> {
    return {
      event_type: ToolWorkerEventType.WORKER_STATE_CHANGED,
      entity_type: "worker_run",
      entity_id: workerRun.worker_run_id,
      workspace_id: workerRun.workspace_id,
      run_id: workerRun.principal_run_id,
      caused_by: "worker_lifecycle",
      revision: 0,
      payload_json: payload
    };
  }

  private resolveNow(): string {
    const now = this.dependencies.now?.() ?? new Date().toISOString();
    assertIsoDatetime("now", now);
    return now;
  }
}

function parseAbortParams(params: {
  readonly reason: string;
  readonly rollbackAttempted: boolean;
}): {
  readonly reason: string;
  readonly rollbackAttempted: boolean;
} {
  const reason = requireNonEmptyString("reason", params.reason);

  if (typeof params.rollbackAttempted !== "boolean") {
    throw new CoreError("VALIDATION", "rollbackAttempted must be boolean");
  }

  return {
    reason,
    rollbackAttempted: params.rollbackAttempted
  };
}

function requireNonEmptyString(field: string, value: string): string {
  if (typeof value !== "string") {
    throw new CoreError("VALIDATION", `${field} must be a non-empty string`);
  }

  const normalized = value.trim();

  if (normalized.length === 0) {
    throw new CoreError("VALIDATION", `${field} must be a non-empty string`);
  }

  return normalized;
}

function parseStringArray(field: string, values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) {
    throw new CoreError("VALIDATION", `${field} must be an array`);
  }

  return values.map((value, index) => requireNonEmptyString(`${field}[${index}]`, value));
}

function assertIsoDatetime(field: string, value: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CoreError("VALIDATION", `${field} must return a valid ISO timestamp`);
  }
}
