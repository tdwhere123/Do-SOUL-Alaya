import { describe, expect, it, vi } from "vitest";
import type { KarmaEvent } from "@do-soul/alaya-protocol";
import {
  InMemoryKarmaEventStore,
  SqliteKarmaEventStore,
  type KarmaEventStoreRepoPort
} from "../../dynamics/karma-event-store.js";

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

  it("emits an operator-visible warning when async persistence fails", async () => {
    const warn = { warn: vi.fn() };
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const store = new SqliteKarmaEventStore(
      {
        create: vi.fn(async () => {
          throw new Error("sqlite busy");
        }),
        findByObjectIdSync: vi.fn(() => [])
      },
      warn
    );

    store.record(makeEvent("obj-fail", "evt-fail"));
    await Promise.resolve();

    expect(warn.warn).toHaveBeenCalledWith(
      "[SqliteKarmaEventStore] Failed to persist karma event",
      expect.objectContaining({
        error: expect.any(Error)
      })
    );
    expect(emitWarning).toHaveBeenCalledWith(
      "[SqliteKarmaEventStore] Failed to persist karma event",
      expect.objectContaining({
        code: "ALAYA_KARMA_EVENT_PERSIST_FAILED"
      })
    );

    emitWarning.mockRestore();
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

  it("InMemoryKarmaEventStore caps retained events, evicting oldest-first", () => {
    const store = new InMemoryKarmaEventStore();
    const cap = (store as unknown as { events: KarmaEvent[] }).events;
    // Push well past the 10000-event cap.
    for (let i = 0; i < 10005; i++) {
      store.record(makeEvent("obj-cap", `evt-${i}`));
    }
    expect(cap).toHaveLength(10000);
    // Oldest five (evt-0..evt-4) evicted; newest retained.
    const ids = store.findByObjectId("obj-cap").map((event) => event.event_id);
    expect(ids).toHaveLength(10000);
    expect(ids[0]).toBe("evt-5");
    expect(ids[ids.length - 1]).toBe("evt-10004");
    expect(ids).not.toContain("evt-0");
    expect(ids).not.toContain("evt-4");
  });
});
