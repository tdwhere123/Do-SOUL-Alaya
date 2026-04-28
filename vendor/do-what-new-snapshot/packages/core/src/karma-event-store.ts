import { parseKarmaEvent as parseProtocolKarmaEvent, type KarmaEvent, type KarmaEventKind } from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { parseNonEmptyString } from "./shared/validators.js";

export type { KarmaEvent, KarmaEventKind } from "@do-what/protocol";

export interface KarmaEventStore {
  record(event: KarmaEvent): void;
  findByObjectId(objectId: string): readonly KarmaEvent[];
}

export interface KarmaEventStoreRepoPort {
  create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>>;
}

export interface KarmaEventStoreWarnPort {
  warn(message: string, meta: Record<string, unknown>): void;
}

export class InMemoryKarmaEventStore implements KarmaEventStore {
  protected readonly events: KarmaEvent[] = [];

  public record(event: KarmaEvent): void {
    const parsed = parseKarmaEvent(event);
    this.events.push(parsed);
  }

  public findByObjectId(objectId: string): readonly KarmaEvent[] {
    const parsedObjectId = parseNonEmptyString(objectId, "object_id");

    return this.events
      .filter((storedEvent) => storedEvent.object_id === parsedObjectId)
      .map((storedEvent) => Object.freeze({ ...storedEvent }));
  }
}

export class SqliteKarmaEventStore extends InMemoryKarmaEventStore {
  public constructor(
    private readonly repo: KarmaEventStoreRepoPort,
    private readonly warn?: KarmaEventStoreWarnPort
  ) {
    super();
  }

  public override record(event: KarmaEvent): void {
    const parsed = parseKarmaEvent(event);
    this.events.push(parsed);

    void this.repo.create(parsed).catch((error) => {
      this.warn?.warn("[SqliteKarmaEventStore] Failed to persist karma event", {
        error
      });
    });
  }
}

function parseKarmaEvent(event: KarmaEvent): KarmaEvent {
  try {
    return Object.freeze(parseProtocolKarmaEvent(event));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid karma event payload", { cause: error });
  }
}
