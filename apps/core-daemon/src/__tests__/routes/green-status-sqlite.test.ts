import { afterEach, describe, expect, it, vi } from "vitest";
import { EventPublisher, GreenClaimStatusResolver, GreenService } from "@do-soul/alaya-core";
import {
  GreenGovernanceEventType, MemoryDimension, RunMode, RunState, VerificationBasis,
  VerifiedBy, WorkspaceKind, WorkspaceState, type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase, SqliteClaimFormRepo, SqliteEventLogRepo, SqliteGreenStatusRepo,
  SqliteMemoryEntryRepo, SqliteRunRepo, SqliteWorkspaceRepo, type StorageDatabase
} from "@do-soul/alaya-storage";
import { createApp } from "../../runtime/app.js";
import { createMemory } from "../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { workspaceServiceStub } from "../support/route-service-stubs.js";

const TARGET = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
const NOW = "2026-05-01T00:00:00.000Z";
const HEADERS = { "content-type": "application/json", "x-request-token": "green-test-token", origin: "http://localhost:5173" };
const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

describe("Green status SQLite boundary", () => {
  it("denies foreign-workspace HTTP verification without changing state or audit", async () => {
    const harness = await createHarness();
    const granted = await harness.service.grant(grantInput());
    const beforeEvents = harness.database.connection.prepare("SELECT * FROM event_log ORDER BY rowid").all();
    harness.notifyEntry.mockClear();
    const response = await harness.app.request("/workspaces/workspace-2/green-statuses/verify", {
      method: "POST", headers: HEADERS,
      body: JSON.stringify({ target_object_id: TARGET, verdict: "no_go" })
    });
    expect(response.status).toBe(404);
    const foreignRead = await harness.app.request(`/workspaces/workspace-2/green-statuses/${TARGET}`, { headers: HEADERS });
    expect(foreignRead.status).toBe(404);
    expect(harness.statusRepo.findByTargetObjectIdSync(TARGET)).toEqual(granted);
    expect(harness.database.connection.prepare("SELECT * FROM event_log ORDER BY rowid").all()).toEqual(beforeEvents);
    expect(harness.notifyEntry).not.toHaveBeenCalled();
    const allowed = await harness.app.request(`/workspaces/workspace-1/green-statuses/${TARGET}`, { headers: HEADERS });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ data: { object_id: granted.object_id } });
  });

  it("serializes overlapping grants into one stable identity with committed audit before notification", async () => {
    const harness = await createHarness();
    const readMemory = harness.memoryRepo.findById.bind(harness.memoryRepo);
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    vi.spyOn(harness.memoryRepo, "findById").mockImplementation(async (id) => {
      const memory = await readMemory(id);
      if (++reads === 2) release();
      await bothRead;
      return memory;
    });
    const [first, second] = await Promise.all([harness.service.grant(grantInput()), harness.service.grant(grantInput())]);
    expect(reads).toBe(2);
    expect(second.object_id).toBe(first.object_id);
    expect(second.created_at).toBe(first.created_at);
    expect(harness.database.connection.prepare("SELECT object_id FROM green_statuses").all()).toEqual([{ object_id: first.object_id }]);
    expect(harness.statusRepo.findByTargetObjectIdSync(TARGET)).toEqual(second);
    const events = (await harness.eventLogRepo.queryByType(GreenGovernanceEventType.SOUL_GREEN_GRANTED)).events;
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.entity_id)).toEqual([first.object_id, first.object_id]);
    expect(harness.notifyEntry.mock.calls.map(([event]) => event.event_id)).toEqual(events.map((event) => event.event_id));
    expect(harness.notificationCommitChecks).toEqual([true, true]);
  });
});

function grantInput() {
  return { targetObjectId: TARGET, workspaceId: "workspace-1", basis: VerificationBasis.ACTIVE_VERIFICATION,
    validUntil: "2026-06-01T00:00:00.000Z", verifiedBy: VerifiedBy.REVIEW };
}

async function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  for (const id of ["workspace-1", "workspace-2"]) await workspaceRepo.create({ workspace_id: id,
    name: id, root_path: `/tmp/${id}`, workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
  await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "Green verification",
    goal: null, run_mode: RunMode.CHAT, engine_binding_id: null, engine_class: null, run_state: RunState.IDLE, current_surface_id: null });
  const memoryRepo = new SqliteMemoryEntryRepo(database);
  await memoryRepo.create(createMemory({ object_id: TARGET, workspace_id: "workspace-1", run_id: "run-1",
    dimension: MemoryDimension.PREFERENCE, evidence_refs: ["evidence-1"], created_at: NOW, updated_at: NOW }));
  const eventLogRepo = new SqliteEventLogRepo(database);
  const statusRepo = new SqliteGreenStatusRepo(database);
  const notificationCommitChecks: boolean[] = [];
  const notifyEntry = vi.fn(async (event: EventLogEntry) => {
    const stored = database.connection.prepare("SELECT event_id FROM event_log WHERE event_id = ?").get(event.event_id);
    notificationCommitChecks.push(stored !== undefined && statusRepo.findByTargetObjectIdSync(TARGET)?.object_id === event.entity_id);
  });
  const runtimeNotifier = { notifyEntry, notify: async () => undefined };
  const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier, runHotStateService: { apply: async () => undefined } });
  const service = new GreenService({ memoryRepo, greenStatusRepo: statusRepo, eventLogRepo, eventPublisher,
    runtimeNotifier, statusResolver: new GreenClaimStatusResolver(new SqliteClaimFormRepo(database)), now: () => NOW });
  const app = createApp({ requestProtection: { requestToken: "green-test-token", allowedOrigin: "http://localhost:5173",
    boundWorkspaceIds: ["workspace-1", "workspace-2"] }, routes: { greenStatus: { greenService: service,
    workspaceService: workspaceServiceStub({ getById: (id: string) => workspaceRepo.getById(id) }) } } });
  return { database, eventLogRepo, memoryRepo, statusRepo, service, app, notifyEntry, notificationCommitChecks };
}
