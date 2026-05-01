import { Phase0EventSchema, type EventLogEntry, type Phase0Event } from "@do-soul/alaya-protocol";

export interface EventPublisherEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  deleteById(eventId: string): Promise<void>;
}

export interface RuntimeNotifier {
  notify(runId: string, event: Phase0Event): void | Promise<void>;
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface RunHotStateApplierPort {
  apply(event: Phase0Event): void | Promise<void>;
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
    const phase0Candidate = Phase0EventSchema.safeParse({
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

    if (phase0Candidate.success) {
      await this.dependencies.runHotStateService.apply(phase0Candidate.data);
    }

    // notifyEntry handles both run-scoped and workspace-scoped in-process listeners.
    await this.dependencies.runtimeNotifier.notifyEntry(entry);
  }
}
