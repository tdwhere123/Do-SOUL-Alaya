import { WorkspaceRunEventSchema, type EventLogEntry, type WorkspaceRunEvent } from "@do-soul/alaya-protocol";
import { reportAsyncSideEffectFailure, scheduleAuditedAsyncSideEffect } from "./async-side-effect-auditor.js";

export type EventPublisherInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface EventPublisherEventLogRepoPort {
  append(event: EventPublisherInput): EventLogEntry;
  deleteById(eventId: string): void;
  /**
   * Wrap `fn` in a single SQLite transaction. `fn` must be synchronous; an
   * `await` inside the function would commit the transaction before the awaited
   * work completes, defeating atomicity.
   */
  transactional<T>(fn: () => T): T;
  // Optional wiring-time identity of the backing connection; absent on test fakes.
  getStorageConnectionIdentity?(): object;
}

export interface RuntimeNotifier {
  notify(runId: string, event: WorkspaceRunEvent): void | Promise<void>;
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface RunHotStateApplierPort {
  apply(event: WorkspaceRunEvent): void | Promise<void>;
}

export interface EventPublisherDependencies {
  readonly eventLogRepo: EventPublisherEventLogRepoPort;
  readonly runHotStateService: RunHotStateApplierPort;
  readonly runtimeNotifier: RuntimeNotifier;
}

export class EventPublisherPropagationError extends Error {
  public readonly entry: EventLogEntry;
  public readonly entries: readonly EventLogEntry[];

  public constructor(entry: EventLogEntry, cause: unknown, entries: readonly EventLogEntry[] = [entry]) {
    super(`Event ${entry.event_type} was appended but propagation failed.`, {
      cause: cause instanceof Error ? cause : undefined
    });
    this.name = "EventPublisherPropagationError";
    this.entry = entry;
    this.entries = entries;
  }
}

export class EventPublisher {
  public constructor(private readonly dependencies: EventPublisherDependencies) {}

  // Exposes the eventLogRepo's connection identity so a daemon guard can prove
  // the karma repos share this transaction boundary; undefined on test fakes.
  public getStorageConnectionIdentity(): object | undefined {
    return this.dependencies.eventLogRepo.getStorageConnectionIdentity?.();
  }

  /**
   * Append one or more EventLog rows AND run a synchronous mutation in a single
   * SQLite transaction. The EventLog row and the mutation commit atomically, so
   * the unique index on (entity_type, entity_id, revision) is belt-and-suspenders
   * rather than the sole concurrency-correctness guard.
   *
   * The mutate callback receives the persisted entries with their final
   * `event_id`, so trust-state-style records can persist `audit_event_id`
   * exactly once with no divergence between the EventLog row and the
   * consumer's row.
   *
   * Constraints:
   *   - `mutate` MUST be synchronous. Any `await` inside it would commit the
   *     transaction before the awaited work resolves.
   *   - Async preparation (FS reads, network calls, queries via async-only
   *     repos) MUST happen before this call; pass results in via closure.
   *   - Notifications (runHotState + runtimeNotifier) run AFTER the
   *     transaction commits. If notification throws, the rows are already
   *     durable; the failure is recorded as a propagation diagnostic so callers
   *     do not retry the committed mutation.
   */
  public async appendManyWithMutation<T>(
    eventInputs: readonly EventPublisherInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T> {
    const { entries, mutateResult } = this.appendManyInTransaction(eventInputs, mutate);

    for (const entry of entries) {
      try {
        await this.propagate(entry);
      } catch (propagateError) {
        await this.reportPostCommitPropagationFailure(entry, propagateError, entries);
      }
    }

    return mutateResult;
  }

  /**
   * Run `mutate` — a synchronous read-modify-write — inside one SQLite
   * transaction, then append the EventLog rows it returns in the SAME
   * transaction. Unlike appendManyWithMutation (which fixes its rows BEFORE the
   * mutation and hands the persisted entries to the callback), this derives the
   * rows FROM the mutation result, so a guarded mutation (e.g. a dormant->active
   * revival that only fires when the row was actually dormant) appends exactly
   * the audit rows that match what was persisted.
   *
   * Constraints mirror appendManyWithMutation: `mutate` MUST be synchronous, and
   * async preparation must happen before this call. If the mutation or an append
   * throws, the transaction rolls back and nothing is persisted (no half-commit).
   * Propagation runs after commit; a propagation failure is diagnostic-only
   * because the durable rows are already committed.
   */
  public async mutateThenAppendMany<T>(
    mutate: () => {
      readonly events: readonly EventPublisherInput[];
      readonly result: T;
      /** Runs after pre-apply appends; may return additional rows to append in the same transaction. */
      apply?(): void | readonly EventPublisherInput[];
    }
  ): Promise<{ readonly result: T; readonly entries: readonly EventLogEntry[] }> {
    const repo = this.dependencies.eventLogRepo;
    const { entries, result } = repo.transactional<{
      entries: EventLogEntry[];
      result: T;
    }>(() => {
      const produced = mutate();
      assertSynchronousMutationResult(produced);
      const collected: EventLogEntry[] = [];
      for (const input of produced.events) {
        collected.push(repo.append(input));
      }
      if (produced.apply) {
        const postApplyEvents = produced.apply();
        if (postApplyEvents !== undefined && postApplyEvents.length > 0) {
          for (const input of postApplyEvents) {
            collected.push(repo.append(input));
          }
        }
      }
      return { entries: collected, result: produced.result };
    });

    for (const entry of entries) {
      try {
        await this.propagate(entry);
      } catch (propagateError) {
        await this.reportPostCommitPropagationFailure(entry, propagateError, entries);
      }
    }

    return { result, entries };
  }

  /**
   * Append + mutate atomically, return immediately after the transaction
   * commits, and run propagation as detached best-effort work.
   *
   * This is intentionally separate from `appendManyWithMutation`: most callers
   * need propagation errors to surface. Background durable-repair tasks such
   * as path plasticity need the opposite post-commit behavior: once rows are
   * durable, caller-side progress markers must be allowed to advance even if
   * in-process listeners are slow, reject, or never settle.
   */
  public appendManyWithMutationAndDetachPropagation<T>(
    eventInputs: readonly EventPublisherInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): T {
    const { entries, mutateResult } = this.appendManyInTransaction(eventInputs, mutate);
    for (const entry of entries) {
      scheduleAuditedAsyncSideEffect(this.propagate(entry), {
        source: "EventPublisher",
        operation: "detached_propagation",
        subjectType: entry.entity_type,
        subjectId: entry.entity_id,
        workspaceId: entry.workspace_id,
        runId: entry.run_id,
        causedBy: entry.caused_by,
        committedEventId: entry.event_id,
        warningCode: "ALAYA_EVENT_PROPAGATION_DETACHED_FAILED",
        warningMessage: "[EventPublisher] Detached propagation failed after commit",
        eventLogRepo: this.dependencies.eventLogRepo,
        runtimeNotifier: this.dependencies.runtimeNotifier
      });
    }
    return mutateResult;
  }

  public async publish(eventInput: EventPublisherInput): Promise<Readonly<EventLogEntry>> {
    const entry = await this.appendToEventLog(eventInput);
    try {
      await this.propagate(entry);
    } catch (propagateError) {
      throw new EventPublisherPropagationError(entry, propagateError);
    }
    return entry;
  }

  private async appendToEventLog(
    eventInput: EventPublisherInput
  ): Promise<EventLogEntry> {
    return this.dependencies.eventLogRepo.append(eventInput);
  }

  private appendManyInTransaction<T>(
    eventInputs: readonly EventPublisherInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): { readonly entries: readonly EventLogEntry[]; readonly mutateResult: T } {
    if (eventInputs.length === 0) {
      // No events to append; still run the mutation for parity with the
      // prior empty-batch behavior. There is no transaction needed because
      // there is nothing to roll back atomically.
      const result = mutate([]);
      assertSynchronousMutationResult(result);
      return { entries: [], mutateResult: result };
    }

    const repo = this.dependencies.eventLogRepo;
    return repo.transactional<{
      entries: EventLogEntry[];
      mutateResult: T;
    }>(() => {
      const collected: EventLogEntry[] = [];
      for (const input of eventInputs) {
        collected.push(repo.append(input));
      }
      const result = mutate(collected);
      assertSynchronousMutationResult(result);
      return { entries: collected, mutateResult: result };
    });
  }

  private async propagate(entry: EventLogEntry): Promise<void> {
    const workspaceRunCandidate = WorkspaceRunEventSchema.safeParse({
      event_id: entry.event_id,
      event_type: entry.event_type,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      workspace_id: entry.workspace_id,
      run_id: entry.run_id,
      caused_by: entry.caused_by,
      revision: entry.revision,
      created_at: entry.created_at,
      payload: entry.payload_json
    });

    if (workspaceRunCandidate.success) {
      await this.dependencies.runHotStateService.apply(workspaceRunCandidate.data);
    }

    // notifyEntry handles both run-scoped and workspace-scoped in-process listeners.
    await this.dependencies.runtimeNotifier.notifyEntry(entry);
  }

  private async reportPostCommitPropagationFailure(
    entry: EventLogEntry,
    error: unknown,
    entries: readonly EventLogEntry[]
  ): Promise<void> {
    await reportAsyncSideEffectFailure(
      {
        source: "EventPublisher",
        operation: "post_commit_propagation",
        subjectType: entry.entity_type,
        subjectId: entry.entity_id,
        workspaceId: entry.workspace_id,
        runId: entry.run_id,
        causedBy: entry.caused_by,
        committedEventId: entry.event_id,
        severity: "warning",
        warningCode: "ALAYA_EVENT_PROPAGATION_FAILED_AFTER_COMMIT",
        warningMessage: "[EventPublisher] Propagation failed after commit",
        eventLogRepo: this.dependencies.eventLogRepo,
        runtimeNotifier: this.dependencies.runtimeNotifier
      },
      new EventPublisherPropagationError(entry, error, entries)
    );
  }
}

function assertSynchronousMutationResult(result: unknown): void {
  if (result instanceof Promise || typeof (result as { readonly then?: unknown })?.then === "function") {
    throw new Error(
      "appendManyWithMutation: mutate callback must be synchronous. " +
        "Move any awaitable work outside of appendManyWithMutation."
    );
  }
}
