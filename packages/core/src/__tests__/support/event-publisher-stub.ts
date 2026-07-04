import { vi, type Mock } from "vitest";
import type { EventLogEntry } from "@do-soul/alaya-protocol";
import {
  EventPublisher,
  type EventPublisherDependencies,
  type EventPublisherInput
} from "../../runtime/event-publisher.js";

// vi.fn cannot express the generic <T> call signature of
// appendManyWithMutation, so the stub records calls against this erased
// shape and StubEventPublisher re-applies T at the typed boundary.
export type AppendManyWithMutationErased = (
  eventInputs: readonly EventPublisherInput[],
  mutate: (entries: readonly EventLogEntry[]) => unknown
) => Promise<unknown>;

export type AppendManyWithMutationMock = Mock<AppendManyWithMutationErased>;

const noopEventPublisherDependencies: EventPublisherDependencies = {
  eventLogRepo: {
    append: (event) => ({
      ...event,
      event_id: "evt_stub",
      created_at: "2026-01-01T00:00:00.000Z",
      revision: 0
    }),
    deleteById: () => undefined,
    transactional: (fn) => fn()
  },
  runHotStateService: { apply: async () => undefined },
  runtimeNotifier: { notify: async () => undefined, notifyEntry: async () => undefined }
};

export class StubEventPublisher extends EventPublisher {
  public constructor(
    public readonly appendManyWithMutationImpl: AppendManyWithMutationMock = vi.fn(
      async (
        _eventInputs: readonly EventPublisherInput[],
        mutate: (entries: readonly EventLogEntry[]) => unknown
      ) => mutate([])
    )
  ) {
    super(noopEventPublisherDependencies);
  }

  public override async appendManyWithMutation<T>(
    eventInputs: readonly EventPublisherInput[],
    mutate: (entries: readonly EventLogEntry[]) => T
  ): Promise<T> {
    // vi.fn erases the generic result; at runtime the impl returns mutate(entries).
    return (await this.appendManyWithMutationImpl(eventInputs, mutate)) as T;
  }
}

export function fakeAppendManyWithMutation(
  publishedEvents?: EventPublisherInput[]
): AppendManyWithMutationMock {
  return vi.fn(
    async (
      events: readonly EventPublisherInput[],
      mutate: (entries: readonly EventLogEntry[]) => unknown
    ) => {
      if (publishedEvents !== undefined) {
        for (const event of events) {
          publishedEvents.push(event);
        }
      }
      const persisted = events.map((event, index) => ({
        ...event,
        event_id: `evt_${index}`,
        created_at: "2026-03-18T00:00:00.000Z",
        revision: index
      }));
      return mutate(persisted);
    }
  );
}
