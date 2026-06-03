import { randomUUID } from "node:crypto";
import {
  AffectedDataScopeEntrySchema,
  DirtyStateDossierSchema,
  DirtyStatePanicPayloadSchema,
  DirtyStatePanicTriggerSchema,
  ObligationTrustNarrativeEventType,
  ToolWorkerEventType,
  WorkerStateChangedPayloadSchema,
  type AffectedDataScopeEntry,
  type DelegatedWorkerRun,
  type DirtyStateDossier,
  type DirtyStatePanicTrigger,
  type EventLogEntry,
  type WorkerRunState
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher } from "./event-publisher.js";
import { assertWorkerTransition } from "./worker-run-state-machine.js";

export interface DirtyStateDossierRepoPort {
  /** Sync sibling for atomic publish + mutation. */
  create(dossier: DirtyStateDossier): Readonly<DirtyStateDossier>;
  deleteById(dossierId: string): Promise<void>;
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<DirtyStateDossier>[]>;
  findByWorkerRun(workerRunId: string): Promise<readonly Readonly<DirtyStateDossier>[]>;
}

export interface DirtyStatePanicWorkerRunRepoPort {
  getById(workerRunId: string): Promise<Readonly<DelegatedWorkerRun> | null>;
  /**
   * Sync sibling for atomic publish + mutation. The dirty-state panic
   * transitions the worker_run to `frozen` inside the same SQLite
   * transaction as the dossier insert and both EventLog rows
   * (panic + worker.state_changed).
   */
  updateState(
    workerRunId: string,
    expectedState: WorkerRunState,
    nextState: WorkerRunState,
    updatedAt: string
  ): Readonly<DelegatedWorkerRun>;
}

export interface DirtyStatePanicServiceDependencies {
  readonly workerRunRepo: DirtyStatePanicWorkerRunRepoPort;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  readonly dossierRepo: DirtyStateDossierRepoPort;
  readonly generateDossierId?: () => string;
  readonly now?: () => string;
}

export class DirtyStatePanicService {
  public constructor(private readonly deps: DirtyStatePanicServiceDependencies) {}

  public async triggerPanic(params: {
    readonly workerRunId: string;
    readonly trigger: DirtyStatePanicTrigger;
    readonly panicSource: string;
    readonly summary: string;
    readonly affectedScope: readonly AffectedDataScopeEntry[];
  }): Promise<Readonly<DirtyStateDossier>> {
    const workerRun = await this.requireWorkerRun(params.workerRunId);
    const dossier = this.buildDossier(workerRun, params);
    // Validate the worker_run -> frozen transition before opening the
    // transaction so a dossier is never inserted for a transition that
    // worker-run-state-machine would refuse.
    assertWorkerTransition(workerRun.state, "frozen");
    const panicEvent = this.buildPanicEvent(dossier);
    const stateChangedEvent = this.buildWorkerStateChangedEvent(workerRun, dossier);
    const updatedAt = dossier.created_at;

    // invariant: panic + worker.state_changed EventLog rows, dossier
    // INSERT, and worker_run state UPDATE all commit (or roll back) as
    // one SQLite transaction. A nested-publish shape would break the
    // single-transaction guarantee, so callers MUST keep all mutations
    // inside the appendManyWithMutation callback.
    return await this.deps.eventPublisher.appendManyWithMutation(
      [panicEvent, stateChangedEvent],
      () => {
        const persisted = this.deps.dossierRepo.create(dossier);
        this.deps.workerRunRepo.updateState(
          workerRun.worker_run_id,
          workerRun.state,
          "frozen",
          updatedAt
        );
        return persisted;
      }
    );
  }

  private async requireWorkerRun(workerRunId: string): Promise<Readonly<DelegatedWorkerRun>> {
    const parsedWorkerRunId = requireNonEmptyString("workerRunId", workerRunId);
    const workerRun = await this.deps.workerRunRepo.getById(parsedWorkerRunId);

    if (workerRun === null) {
      throw new CoreError("NOT_FOUND", "Worker run not found");
    }

    return workerRun;
  }

  private buildDossier(
    workerRun: Readonly<DelegatedWorkerRun>,
    params: {
      readonly trigger: DirtyStatePanicTrigger;
      readonly panicSource: string;
      readonly summary: string;
      readonly affectedScope: readonly AffectedDataScopeEntry[];
    }
  ): DirtyStateDossier {
    return DirtyStateDossierSchema.parse({
      dossier_id: this.resolveDossierId(),
      worker_run_id: workerRun.worker_run_id,
      principal_run_id: workerRun.principal_run_id,
      workspace_id: workerRun.workspace_id,
      trigger: DirtyStatePanicTriggerSchema.parse(params.trigger),
      panic_source: requireNonEmptyString("panicSource", params.panicSource),
      panic_summary: requireNonEmptyString("summary", params.summary),
      affected_data_scope: parseAffectedScope(params.affectedScope),
      created_at: this.resolveNow()
    });
  }

  private buildWorkerStateChangedEvent(
    workerRun: Readonly<DelegatedWorkerRun>,
    dossier: Readonly<DirtyStateDossier>
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    const payload = WorkerStateChangedPayloadSchema.parse({
      workerId: workerRun.worker_run_id,
      state: "frozen",
      previousState: workerRun.state,
      panicSource: dossier.panic_source,
      panicSummary: dossier.panic_summary
    });

    return {
      event_type: ToolWorkerEventType.WORKER_STATE_CHANGED,
      entity_type: "worker_run",
      entity_id: workerRun.worker_run_id,
      workspace_id: workerRun.workspace_id,
      run_id: workerRun.principal_run_id,
      caused_by: "worker_lifecycle",
      payload_json: payload
    };
  }

  private buildPanicEvent(
    dossier: Readonly<DirtyStateDossier>
  ): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
    const payload = DirtyStatePanicPayloadSchema.parse({
      dossier_id: dossier.dossier_id,
      worker_run_id: dossier.worker_run_id,
      principal_run_id: dossier.principal_run_id,
      trigger: dossier.trigger,
      panic_source: dossier.panic_source,
      panic_summary: dossier.panic_summary,
      affected_entity_count: dossier.affected_data_scope.length
    });

    return {
      event_type: ObligationTrustNarrativeEventType.DIRTY_STATE_PANIC,
      entity_type: "worker_run",
      entity_id: dossier.worker_run_id,
      workspace_id: dossier.workspace_id,
      run_id: dossier.principal_run_id,
      caused_by: "dirty_state_panic",
      payload_json: payload
    };
  }

  private resolveDossierId(): string {
    return this.deps.generateDossierId?.() ?? randomUUID();
  }

  private resolveNow(): string {
    const now = this.deps.now?.() ?? new Date().toISOString();

    if (typeof now !== "string" || Number.isNaN(Date.parse(now))) {
      throw new CoreError("VALIDATION", "now must return a valid ISO timestamp");
    }

    return now;
  }
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

function parseAffectedScope(
  affectedScope: readonly AffectedDataScopeEntry[]
): readonly AffectedDataScopeEntry[] {
  if (!Array.isArray(affectedScope)) {
    throw new CoreError("VALIDATION", "affectedScope must be an array");
  }

  return affectedScope.map((entry) => AffectedDataScopeEntrySchema.parse(entry));
}
