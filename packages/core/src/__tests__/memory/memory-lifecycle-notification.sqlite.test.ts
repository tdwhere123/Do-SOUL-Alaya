import { afterEach, expect, it } from "vitest";
import { RunMode, RunState, TransitionCausedBy, WorkspaceKind, WorkspaceState } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo, SqliteRunRepo, SqliteWorkspaceRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { MemoryLifecycleManager } from "../../memory/memory-service/memory-lifecycle-manager.js";
import { createMemoryEntry } from "./memory-service-test-fixtures.js";

const databases: StorageDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

it("returns an archived SQLite memory and its audit even when the lifecycle listener fails", async () => {
  const database = initDatabase({ filename: ":memory:" });
  databases.push(database);
  await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "Lifecycle",
    root_path: "/tmp/lifecycle", workspace_kind: WorkspaceKind.LOCAL_REPO,
    workspace_state: WorkspaceState.ACTIVE, default_engine_binding: null });
  await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "Lifecycle",
    goal: null, run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null,
    run_state: RunState.IDLE, current_surface_id: null });
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memory = createMemoryEntry({ evidence_refs: [] });
  await memoryEntryRepo.create(memory);
  const manager = new MemoryLifecycleManager({ memoryEntryRepo, eventLogRepo,
    now: () => "2026-10-13T00:00:00.000Z", runtimeNotifier: { notifyEntry: async entry => {
      if (entry.event_type.startsWith("soul.memory.")) throw new Error("lifecycle listener offline");
    } } });
  await expect(manager.archive(memory.object_id, "user_archive", TransitionCausedBy.USER))
    .resolves.toMatchObject({ object_id: memory.object_id, lifecycle_state: "archived" });
  expect(await memoryEntryRepo.findById(memory.object_id)).toMatchObject({ lifecycle_state: "archived" });
  const events = await eventLogRepo.queryByEntity("memory_entry", memory.object_id);
  expect(events.filter(row => row.event_type.startsWith("soul.memory.")).map(row => row.event_type))
    .toEqual(["soul.memory.archived", "soul.memory.state_changed"]);
  const diagnostics = events.filter(row => row.event_type === "runtime.side_effect_failed");
  expect(diagnostics).toHaveLength(2);
});
