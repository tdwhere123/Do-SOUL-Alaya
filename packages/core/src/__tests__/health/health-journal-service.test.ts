import { describe, expect, it, vi } from "vitest";
import { HealthEventKind, GardenEventType, type EventLogEntry, type HealthJournalEntry } from "@do-soul/alaya-protocol";
import { HealthJournalService } from "../../health/health-journal-service.js";

describe("HealthJournalService", () => {
  it("appends the event before writing to the repo", async () => {
    const calls: string[] = [];
    const service = new HealthJournalService({
      generateEntryId: () => "entry-1",
      now: () => "2026-03-27T00:00:00.000Z",
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
          calls.push(`event:${entry.entity_id}`);
          return createEventLogEntry(entry);
        }),
        queryByEntity: vi.fn(async () => [])
      },
      repo: {
        append: vi.fn(async (entry: HealthJournalEntry) => {
          calls.push(`repo:${entry.entry_id}`);
          return createHealthEntry(entry);
        }),
        findByWorkspace: vi.fn(async () => [])
      }
    });

    await service.record({
      event_kind: HealthEventKind.BANKRUPTCY,
      workspace_id: "workspace-1",
      run_id: "run-1",
      summary: "Budget collapsed",
      detail_json: { severity: "high" }
    });

    expect(calls).toEqual(["event:entry-1", "repo:entry-1"]);
  });

  it("writes the expected event and repo payload", async () => {
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)),
      queryByEntity: vi.fn(async () => [])
    };
    const repo = {
      append: vi.fn(async (entry: Partial<HealthJournalEntry>) => createHealthEntry(entry)),
      findByWorkspace: vi.fn(async () => [])
    };
    const runtimeNotifier = {
      notifyEntry: vi.fn(async () => {})
    };
    const service = new HealthJournalService({
      generateEntryId: () => "entry-1",
      now: () => "2026-03-27T00:00:00.000Z",
      eventLogRepo,
      repo,
      runtimeNotifier
    });

    await service.record({
      event_kind: HealthEventKind.EVIDENCE_FAILURE,
      workspace_id: "workspace-1",
      run_id: null,
      summary: "Evidence chain broken",
      detail_json: { object_id: "memory-1" }
    });

    expect(eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: GardenEventType.SOUL_HEALTH_JOURNAL_RECORDED,
        entity_type: "health_journal",
        entity_id: "entry-1",
        workspace_id: "workspace-1",
        run_id: null,
        payload_json: expect.objectContaining({
          entry_id: "entry-1",
          event_kind: HealthEventKind.EVIDENCE_FAILURE
        })
      })
    );
    expect(repo.append).toHaveBeenCalledWith({
      entry_id: "entry-1",
      event_kind: HealthEventKind.EVIDENCE_FAILURE,
      workspace_id: "workspace-1",
      run_id: null,
      summary: "Evidence chain broken",
      detail_json: { object_id: "memory-1" },
      created_at: "2026-03-27T00:00:00.000Z"
    });
    expect(runtimeNotifier.notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("delegates recent queries to the repo", async () => {
    const repo = {
      append: vi.fn(async (entry: { entry_id?: string; created_at?: string }) =>
        createHealthEntry({
          entry_id: entry.entry_id ?? "entry-1",
          created_at: entry.created_at ?? "2026-03-27T00:00:00.000Z"
        })
      ),
      findByWorkspace: vi.fn(async () => [])
    };
    const service = new HealthJournalService({
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)),
        queryByEntity: vi.fn(async () => [])
      },
      repo
    });

    await service.getRecentEvents("workspace-1", {
      kind: HealthEventKind.BANKRUPTCY,
      limit: 5
    });

    expect(repo.findByWorkspace).toHaveBeenCalledWith("workspace-1", {
      kind: HealthEventKind.BANKRUPTCY,
      limit: 5
    });
  });

  it("caps direct service queries to the shared maximum limit", async () => {
    const repo = {
      append: vi.fn(async (entry: { entry_id?: string; created_at?: string }) =>
        createHealthEntry({
          entry_id: entry.entry_id ?? "entry-1",
          created_at: entry.created_at ?? "2026-03-27T00:00:00.000Z"
        })
      ),
      findByWorkspace: vi.fn(async () => [])
    };
    const service = new HealthJournalService({
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)),
        queryByEntity: vi.fn(async () => [])
      },
      repo
    });

    await service.getRecentEvents("workspace-1", { limit: 999 });

    expect(repo.findByWorkspace).toHaveBeenCalledWith("workspace-1", { limit: 200 });
  });

  it("propagates repo errors", async () => {
    const service = new HealthJournalService({
      generateEntryId: () => "entry-1",
      now: () => "2026-03-27T00:00:00.000Z",
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => createEventLogEntry(entry)),
        queryByEntity: vi.fn(async () => [])
      },
      repo: {
        append: vi.fn(async () => {
          throw new Error("repo failed");
        }),
        findByWorkspace: vi.fn(async () => [])
      }
    });

    await expect(
      service.record({
        event_kind: HealthEventKind.BANKRUPTCY,
        workspace_id: "workspace-1",
        run_id: "run-1",
        summary: "Budget collapsed",
        detail_json: { severity: "high" }
      })
    ).rejects.toThrow("repo failed");
  });
});

function createEventLogEntry(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry {
  return {
    event_id: `event-${event.entity_id}`,
    created_at: "2026-03-27T00:00:00.000Z",
    revision: 0,
    ...event
  };
}

function createHealthEntry(
  overrides: Partial<HealthJournalEntry> = {}
): HealthJournalEntry {
  return {
    entry_id: "entry-1",
    event_kind: HealthEventKind.BANKRUPTCY,
    workspace_id: "workspace-1",
    run_id: "run-1",
    summary: "Health journal entry",
    detail_json: {},
    created_at: "2026-03-27T00:00:00.000Z",
    ...overrides
  };
}
