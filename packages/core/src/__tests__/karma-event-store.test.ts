import { describe, expect, it } from "vitest";
import type { KarmaEvent } from "@do-soul/alaya-protocol";
import {
  InMemoryKarmaEventStore,
  SqliteKarmaEventStore,
  type KarmaEventStoreRepoPort
} from "../karma-event-store.js";

function makeEvent(objectId: string, eventId: string): KarmaEvent {
  return {
    event_id: eventId,
    kind: "accept_gain",
    object_id: objectId,
    amount: 1,
    created_at: "2026-01-01T00:00:00.000Z",
    workspace_id: "ws-1",
    run_id: null
  };
}

// Fake repo backing SqliteKarmaEventStore. Holds rows so the test can assert
// reads resolve from the repo (the durable source) rather than an in-memory
// mirror inside the store.
class FakeKarmaEventRepo implements KarmaEventStoreRepoPort {
  public readonly rows: KarmaEvent[] = [];

  public async create(event: Readonly<KarmaEvent>): Promise<Readonly<KarmaEvent>> {
    this.rows.push(event);
    return event;
  }

  public findByObjectIdSync(objectId: string): readonly Readonly<KarmaEvent>[] {
    return this.rows.filter((row) => row.object_id === objectId);
  }
}

describe("SqliteKarmaEventStore", () => {
  it("does not grow an in-memory event array across many records", () => {
    const repo = new FakeKarmaEventRepo();
    const store = new SqliteKarmaEventStore(repo);

    for (let i = 0; i < 1000; i++) {
      store.record(makeEvent(`obj-${i}`, `evt-${i}`));
    }

    // No `events` field should exist on the production store, and no own
    // enumerable array property should accumulate per record.
    const ownArrays = Object.values(store as unknown as Record<string, unknown>).filter(
      (value) => Array.isArray(value)
    );
    expect(ownArrays).toHaveLength(0);
    expect((store as unknown as { events?: unknown }).events).toBeUndefined();
  });

  it("reads return correct rows resolved from the repo", () => {
    const repo = new FakeKarmaEventRepo();
    const store = new SqliteKarmaEventStore(repo);

    store.record(makeEvent("obj-a", "evt-a1"));
    store.record(makeEvent("obj-b", "evt-b1"));
    store.record(makeEvent("obj-a", "evt-a2"));

    const found = store.findByObjectId("obj-a");
    expect(found.map((event) => event.event_id)).toEqual(["evt-a1", "evt-a2"]);

    // The store holds no copy; clearing the repo empties the read.
    repo.rows.length = 0;
    expect(store.findByObjectId("obj-a")).toHaveLength(0);
  });

  it("InMemoryKarmaEventStore remains the explicit in-memory test double", () => {
    const store = new InMemoryKarmaEventStore();
    store.record(makeEvent("obj-x", "evt-x1"));
    store.record(makeEvent("obj-x", "evt-x2"));
    expect(store.findByObjectId("obj-x").map((event) => event.event_id)).toEqual([
      "evt-x1",
      "evt-x2"
    ]);
  });
});
