import { parseKarmaEvent as parseProtocolKarmaEvent, type KarmaEvent } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";

export type { KarmaEvent, KarmaEventKind } from "@do-soul/alaya-protocol";

export interface KarmaEventStore {
  record(event: KarmaEvent): Promise<void>;
  findByObjectId(objectId: string): readonly KarmaEvent[];
}

export interface KarmaEventStoreRepoPort {
  create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>>;
  // Synchronous read keeps SqliteKarmaEventStore.findByObjectId honoring the
  // sync KarmaEventStore contract without retaining an in-memory event mirror.
  findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[];
}

export interface KarmaEventStoreWarnPort {
  warn(message: string, meta: Record<string, unknown>): void;
}

const KARMA_EVENT_PERSIST_WARNING_CODE = "ALAYA_KARMA_EVENT_PERSIST_FAILED";

// Hard cap so a long-lived in-memory store cannot grow without bound; it
// retains only the most recent MAX_RETAINED_EVENTS, evicting oldest-first.
const MAX_RETAINED_EVENTS = 10000;

export class InMemoryKarmaEventStore implements KarmaEventStore {
  protected readonly events: KarmaEvent[] = [];

  public async record(event: KarmaEvent): Promise<void> {
    const parsed = parseKarmaEvent(event);
    if (this.events.length >= MAX_RETAINED_EVENTS) {
      this.events.shift();
    }
    this.events.push(parsed);
  }

  public findByObjectId(objectId: string): readonly KarmaEvent[] {
    const parsedObjectId = parseNonEmptyString(objectId, "object_id");

    return this.events
      .filter((storedEvent) => storedEvent.object_id === parsedObjectId)
      .map((storedEvent) => Object.freeze({ ...storedEvent }));
  }
}

// invariant: the SQLite-backed store is the source of truth and must not
// retain an in-memory mirror of every event (that mirror grows unbounded for
// a long-lived daemon). Reads go straight to the repo; writes persist.
export class SqliteKarmaEventStore implements KarmaEventStore {
  public constructor(
    private readonly repo: KarmaEventStoreRepoPort,
    private readonly warn?: KarmaEventStoreWarnPort
  ) {}

  public async record(event: KarmaEvent): Promise<void> {
    const parsed = parseKarmaEvent(event);

    try {
      await this.repo.create(parsed);
    } catch (error) {
      this.warn?.warn("[SqliteKarmaEventStore] Failed to persist karma event", {
        error
      });
      process.emitWarning("[SqliteKarmaEventStore] Failed to persist karma event", {
        code: KARMA_EVENT_PERSIST_WARNING_CODE,
        detail: JSON.stringify({
          object_id: parsed.object_id,
          workspace_id: parsed.workspace_id,
          run_id: parsed.run_id,
          kind: parsed.kind,
          error: error instanceof Error ? error.message : String(error)
        })
      });
      throw error;
    }
  }

  public findByObjectId(objectId: string): readonly KarmaEvent[] {
    const parsedObjectId = parseNonEmptyString(objectId, "object_id");
    return this.repo.findByObjectIdSync(parsedObjectId);
  }
}

function parseKarmaEvent(event: KarmaEvent): KarmaEvent {
  try {
    return Object.freeze(parseProtocolKarmaEvent(event));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid karma event payload", { cause: error });
  }
}
