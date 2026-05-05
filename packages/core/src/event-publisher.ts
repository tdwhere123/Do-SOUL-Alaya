import { WorkspaceRunEventSchema, type EventLogEntry, type WorkspaceRunEvent } from "@do-soul/alaya-protocol";

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
    eventInputs: readonly EventPublisherInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T> {
    const { entries, mutateResult } = this.appendManyInTransaction(eventInputs, mutate);

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
      void this.propagate(entry).catch(() => undefined);
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
}

function assertSynchronousMutationResult(result: unknown): void {
  if (result instanceof Promise || typeof (result as { readonly then?: unknown })?.then === "function") {
    throw new Error(
      "appendManyWithMutation: mutate callback must be synchronous. " +
        "Move any awaitable work outside of appendManyWithMutation."
    );
  }
}
