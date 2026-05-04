import { WorkspaceRunEventSchema, type EventLogEntry, type WorkspaceRunEvent } from "@do-soul/alaya-protocol";

export interface EventPublisherEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  /**
   * Synchronous append for use inside `appendManyWithMutation` so MAX(revision)
   * computation and the INSERT live inside the same `connection.transaction(...)`
   * as the caller's mutation. Closes the BL-022 race window where revision was
   * selected async and the INSERT relied on the unique index for serialization.
   *
   * Optional only so legacy mocks that exercise the async `publishWithMutation`
   * path can still construct a publisher; calling `appendManyWithMutation`
   * without an implementation throws synchronously.
   */
  appendSync?(event: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry;
  deleteById(eventId: string): Promise<void>;
  deleteByIdSync?(eventId: string): void;
  /**
   * Wrap `fn` in a single SQLite transaction. `fn` must be synchronous; an
   * `await` inside the function would commit the transaction before the awaited
   * work completes, defeating atomicity. Optional for the same reason as
   * `appendSync`.
   */
  transactional?<T>(fn: () => T): T;
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

  /**
   * Append one or more EventLog rows AND run a synchronous mutation in a single
   * SQLite transaction. Closes #BL-022: previously the EventLog row was
   * appended outside the transaction and the unique index on
   * (entity_type, entity_id, revision) was load-bearing for concurrency
   * correctness. With this method the index becomes belt-and-suspenders.
   *
   * Closes #BL-021: the mutate callback receives the persisted entries with
   * their final `event_id`, so trust-state-style records can persist
   * `audit_event_id` exactly once with no divergence between the EventLog row
   * and the consumer's row.
   *
   * Constraints:
   *   - `mutate` MUST be synchronous. Any `await` inside it would commit the
   *     transaction before the awaited work resolves.
   *   - Async preparation (FS reads, network calls, queries via async-only
   *     repos) MUST happen before this call; pass results in via closure.
   *   - Notifications (runHotState + runtimeNotifier) run AFTER the
   *     transaction commits. If notification throws, the rows are already
   *     durable; the caller receives `EventPublisherPropagationError` and the
   *     final-listener pattern (existing) handles replay.
   */
  public async appendManyWithMutation<T>(
    eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at">[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T> {
    if (eventInputs.length === 0) {
      // No events to append; still run the mutation for parity with the
      // legacy `publishManyWithMutation` empty-batch behavior. There is no
      // transaction needed because there is nothing to roll back atomically.
      return mutate([]);
    }

    const repo = this.dependencies.eventLogRepo;
    if (repo.transactional === undefined || repo.appendSync === undefined) {
      throw new Error(
        "EventPublisher.appendManyWithMutation requires a repo with transactional() and appendSync(); " +
          "wire SqliteEventLogRepo or supply the equivalents in tests."
      );
    }
    const { entries, mutateResult } = repo.transactional<{
      entries: EventLogEntry[];
      mutateResult: T;
    }>(() => {
      const collected: EventLogEntry[] = [];
      for (const input of eventInputs) {
        collected.push(repo.appendSync!(input));
      }
      const result = mutate(collected);
      if (result instanceof Promise || typeof (result as { then?: unknown })?.then === "function") {
        // A Promise return means the caller used `async () => ...` or returned
        // a thenable. The transaction would commit before the promise resolves,
        // breaking the atomicity guarantee. Throwing here triggers a SQLite
        // rollback so no half-committed EventLog row escapes.
        throw new Error(
          "appendManyWithMutation: mutate callback must be synchronous. " +
            "Move any awaitable work outside of appendManyWithMutation."
        );
      }
      return { entries: collected, mutateResult: result };
    });

    for (const entry of entries) {
      try {
        await this.propagate(entry);
      } catch (propagateError) {
        throw new EventPublisherPropagationError(entry, propagateError, entries);
      }
    }

    return mutateResult;
  }

  /**
   * @deprecated Use `appendManyWithMutation` instead. See #BL-022 closure.
   *
   * Legacy async-mutate path; the append + mutation pair is not wrapped in a
   * single SQLite transaction. New producer code MUST use
   * `appendManyWithMutation`. Retained only for the `AuditorEventLogPort`
   * adapter wired in `apps/core-daemon/src/garden-runtime.ts`, pending the
   * v0.2 migration tracked as #BL-026.
   */
  public async publishWithMutation<T>(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at">,
    mutate: (entry: EventLogEntry) => Promise<T>
  ): Promise<T> {
    // The mutation receives the appended entry so durable records can store the
    // exact audit_event_id while still rolling back the unnotified EventLog row
    // if persistence rejects the mutation.
    const entry = await this.appendToEventLog(eventInput);
    let result: T;
    try {
      result = await mutate(entry);
    } catch (mutateError) {
      // The row was never notified, so replaying it later would create false
      // runtime history for in-process runtime listeners. Remove it before rethrowing.
      await this.rollbackUnnotifiedEntries([entry]);
      throw mutateError;
    }
    try {
      await this.propagate(entry);
    } catch (propagateError) {
      throw new EventPublisherPropagationError(entry, propagateError);
    }
    return result;
  }

  /**
   * @deprecated Use `appendManyWithMutation` instead. See #BL-022 closure.
   *
   * Legacy async-mutate path; the append + mutation pair is not wrapped in a
   * single SQLite transaction. New producer code MUST use
   * `appendManyWithMutation`. No in-tree caller remains; retained only as a
   * symmetric companion to `publishWithMutation` for the `AuditorEventLogPort`
   * adapter, pending the v0.2 migration tracked as #BL-026.
   */
  public async publishManyWithMutation<T>(
    eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at">[],
    mutate: () => Promise<T>
  ): Promise<T> {
    if (eventInputs.length === 0) {
      return await mutate();
    }

    const entries: EventLogEntry[] = [];
    try {
      for (const eventInput of eventInputs) {
        entries.push(await this.appendToEventLog(eventInput));
      }
    } catch (appendError) {
      if (entries.length > 0) {
        await this.rollbackUnnotifiedEntries(entries);
      }
      throw appendError;
    }

    let result: T;
    try {
      result = await mutate();
    } catch (mutateError) {
      await this.rollbackUnnotifiedEntries(entries);
      throw mutateError;
    }

    for (const entry of entries) {
      try {
        await this.propagate(entry);
      } catch (propagateError) {
        throw new EventPublisherPropagationError(entry, propagateError, entries);
      }
    }

    return result;
  }

  public async publish(eventInput: Omit<EventLogEntry, "event_id" | "created_at">): Promise<Readonly<EventLogEntry>> {
    const entry = await this.appendToEventLog(eventInput);
    try {
      await this.propagate(entry);
    } catch (propagateError) {
      throw new EventPublisherPropagationError(entry, propagateError);
    }
    return entry;
  }

  private async appendToEventLog(
    eventInput: Omit<EventLogEntry, "event_id" | "created_at">
  ): Promise<EventLogEntry> {
    return await this.dependencies.eventLogRepo.append(eventInput);
  }

  private async rollbackUnnotifiedEntries(entries: readonly EventLogEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.dependencies.eventLogRepo.deleteById(entry.event_id);
    }
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
}
