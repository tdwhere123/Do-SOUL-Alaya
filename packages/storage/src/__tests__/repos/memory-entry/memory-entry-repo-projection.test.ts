import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteMemoryEntryRepo projection fields", () => {
  it("persists event-time and valid-time projection fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      valid_to: null,
      time_precision: "day",
      time_source: "relative_resolved"
    });

    await repo.create(entry);

    await expect(repo.findById(entry.object_id)).resolves.toMatchObject({
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      valid_to: null,
      time_precision: "day",
      time_source: "relative_resolved"
    });
  });

  it("persists preference profile projection fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      dimension: MemoryDimension.PREFERENCE,
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "avoid",
      preference_object: "tabs for indentation",
      preference_category: "formatting",
      preference_polarity: "negative"
    });

    await repo.create(entry);

    await expect(repo.findById(entry.object_id)).resolves.toMatchObject({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_predicate: "avoid",
      preference_object: "tabs for indentation",
      preference_category: "formatting",
      preference_polarity: "negative"
    });
  });

  it("round-trips facet_tags through create and read", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      facet_tags: [
        { facet: "occupation_work", value: "software engineer" },
        { facet: "location_place" }
      ]
    });

    await repo.create(entry);

    await expect(repo.findById(entry.object_id)).resolves.toMatchObject({
      facet_tags: [
        { facet: "occupation_work", value: "software engineer" },
        { facet: "location_place" }
      ]
    });
  });

  it("updates and clears facet_tags on an existing memory entry", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      facet_tags: [{ facet: "preference_like", value: "spicy food" }],
      updated_at: "2026-03-21T00:00:00.000Z"
    });
    expect(updated).toMatchObject({
      facet_tags: [{ facet: "preference_like", value: "spicy food" }]
    });

    const cleared = await repo.update(entry.object_id, {
      facet_tags: null,
      updated_at: "2026-03-22T00:00:00.000Z"
    });
    expect(cleared.facet_tags ?? null).toBeNull();
  });

  it("updates projection fields on an existing memory entry", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit",
      updated_at: "2026-03-21T00:00:00.000Z"
    });

    expect(updated).toMatchObject({
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      event_time_end: "2026-03-19T23:59:59.999Z",
      valid_from: "2026-03-19T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit"
    });
  });

  it("clears nullable projection fields when update explicitly supplies null", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      projection_schema_version: 1,
      event_time_start: "2026-03-19T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit"
    });
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      event_time_start: null,
      time_source: null,
      updated_at: "2026-03-22T00:00:00.000Z"
    });

    expect(updated).toMatchObject({
      projection_schema_version: 1,
      event_time_start: null,
      time_precision: "day",
      time_source: null
    });
  });

  it("rejects invalid projection update fields before mutating durable rows", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    await expect(
      repo.update(entry.object_id, {
        event_time_start: "not-a-date",
        updated_at: "2026-03-21T00:00:00.000Z"
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
  });
});
