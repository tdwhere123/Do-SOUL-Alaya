import { afterEach, describe, expect, it } from "vitest";
import type { KarmaEvent } from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { SqliteKarmaEventRepo } from "../repos/karma-event-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createKarmaEvent(overrides: Partial<KarmaEvent> = {}): KarmaEvent {
  return {
    event_id: "87f18e36-06bc-4a0e-b149-27bcfb6a5bbd",
    kind: "accept_gain",
    object_id: "memory-1",
    amount: 0.15,
    created_at: "2026-03-23T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteKarmaEventRepo", () => {
  it("applies migration 014", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 14 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(14);
  });

  it("creates and lists events by object id", async () => {
    const { repo } = await createRepo();
    const event = createKarmaEvent();

    await expect(repo.create(event)).resolves.toEqual(event);
    await expect(repo.findByObjectId(event.object_id)).resolves.toEqual([event]);
  });

  it("returns zero sum when no events exist", async () => {
    const { repo } = await createRepo();

    await expect(repo.sumByObjectId("missing-memory")).resolves.toBe(0);
  });

  it("sums positive and negative karma amounts", async () => {
    const { repo } = await createRepo();

    await repo.create(createKarmaEvent({ event_id: "event-1", amount: 0.15 }));
    await repo.create(
      createKarmaEvent({
        event_id: "event-2",
        kind: "reject_penalty",
        amount: -0.3,
        created_at: "2026-03-23T00:01:00.000Z"
      })
    );

    await expect(repo.sumByObjectId("memory-1")).resolves.toBeCloseTo(-0.15, 10);
  });

  it("sums karma amounts in batch by object ids", async () => {
    const { repo } = await createRepo();

    await repo.create(createKarmaEvent({ event_id: "event-a1", object_id: "memory-a", amount: 0.2 }));
    await repo.create(createKarmaEvent({ event_id: "event-a2", object_id: "memory-a", amount: -0.05 }));
    await repo.create(createKarmaEvent({ event_id: "event-b1", object_id: "memory-b", amount: 0.1 }));

    const totals = await repo.sumByObjectIds(["memory-a", "memory-b", "memory-c"]);

    expect(totals["memory-a"]).toBeCloseTo(0.15, 10);
    expect(totals["memory-b"]).toBeCloseTo(0.1, 10);
    expect(totals["memory-c"]).toBe(0);
  });

  it("enforces kind CHECK constraint", async () => {
    const { database } = await createRepo();

    expect(() => {
      database.connection
        .prepare(
          `
            INSERT INTO karma_events (event_id, kind, object_id, amount, created_at, workspace_id)
            VALUES (?, ?, ?, ?, ?, ?)
          `
        )
        .run("bad-event", "invalid_kind", "memory-1", 0.1, "2026-03-23T00:00:00.000Z", "workspace-1");
    }).toThrow();
  });

  it("finds events by workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createKarmaEvent({ event_id: "event-w1", workspace_id: "workspace-1" }));
    await repo.create(
      createKarmaEvent({
        event_id: "event-w2",
        workspace_id: "workspace-2",
        object_id: "memory-2"
      })
    );

    const events = await repo.findByWorkspaceId("workspace-1");
    expect(events).toHaveLength(1);
    expect(events[0].workspace_id).toBe("workspace-1");
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteKarmaEventRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    database,
    repo: new SqliteKarmaEventRepo(database)
  };
}