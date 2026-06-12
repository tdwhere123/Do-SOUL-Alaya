import { afterEach, describe, expect, it } from "vitest";
import { HealthEventKind } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteHealthJournalRepo } from "../../repos/health-journal-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteHealthJournalRepo", () => {
  it("appends an entry with generated identifiers when omitted", async () => {
    const { repo } = createRepo();

    const entry = await repo.append({
      event_kind: HealthEventKind.BANKRUPTCY,
      workspace_id: "workspace-1",
      run_id: "run-1",
      summary: "Budget collapsed",
      detail_json: { severity: "high" }
    });

    expect(entry).toMatchObject({
      event_kind: HealthEventKind.BANKRUPTCY,
      workspace_id: "workspace-1",
      run_id: "run-1",
      summary: "Budget collapsed",
      detail_json: { severity: "high" }
    });
    expect(entry.entry_id).toMatch(/^[-\w]{10,}$/);
    expect(entry.created_at).toMatch(/T/);
  });

  it("lists entries in reverse chronological order", async () => {
    const { repo } = createRepo();

    await repo.append(createEntryInput({
      entry_id: "entry-1",
      created_at: "2026-03-27T00:00:01.000Z",
      summary: "first"
    }));
    await repo.append(createEntryInput({
      entry_id: "entry-2",
      created_at: "2026-03-27T00:00:03.000Z",
      summary: "third"
    }));
    await repo.append(createEntryInput({
      entry_id: "entry-3",
      created_at: "2026-03-27T00:00:02.000Z",
      summary: "second"
    }));

    const rows = await repo.findByWorkspace("workspace-1");

    expect(rows.map((row) => row.entry_id)).toEqual(["entry-2", "entry-3", "entry-1"]);
  });

  it("filters by event kind", async () => {
    const { repo } = createRepo();

    await repo.append(createEntryInput({
      entry_id: "entry-1",
      event_kind: HealthEventKind.BANKRUPTCY
    }));
    await repo.append(createEntryInput({
      entry_id: "entry-2",
      event_kind: HealthEventKind.EVIDENCE_FAILURE
    }));

    const rows = await repo.findByWorkspace("workspace-1", {
      kind: HealthEventKind.BANKRUPTCY
    });

    expect(rows.map((row) => row.entry_id)).toEqual(["entry-1"]);
  });

  it("returns an empty array when no entries exist", async () => {
    const { repo } = createRepo();

    await expect(repo.findByWorkspace("workspace-1")).resolves.toEqual([]);
  });

  it("applies the requested limit", async () => {
    const { repo } = createRepo();

    for (let index = 0; index < 6; index += 1) {
      await repo.append(createEntryInput({
        entry_id: `entry-${index}`,
        created_at: `2026-03-27T00:00:0${index}.000Z`
      }));
    }

    const rows = await repo.findByWorkspace("workspace-1", { limit: 5 });

    expect(rows).toHaveLength(5);
  });

  it("returns deeply frozen entries", async () => {
    const { repo } = createRepo();

    const entry = await repo.append(createEntryInput());

    expect(() => {
      (entry.detail_json as { severity?: string }).severity = "mutated";
    }).toThrow(TypeError);
  });
});

function createRepo() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    repo: new SqliteHealthJournalRepo(database)
  };
}

function createEntryInput(
  overrides: Partial<Parameters<SqliteHealthJournalRepo["append"]>[0]> = {}
): Parameters<SqliteHealthJournalRepo["append"]>[0] {
  return {
    entry_id: "entry-default",
    event_kind: HealthEventKind.BANKRUPTCY,
    workspace_id: "workspace-1",
    run_id: "run-1",
    summary: "Health journal entry",
    detail_json: { severity: "medium" },
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}
