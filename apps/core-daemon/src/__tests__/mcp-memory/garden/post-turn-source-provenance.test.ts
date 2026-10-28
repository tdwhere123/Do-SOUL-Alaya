import { afterEach, expect, it, vi } from "vitest";
import { createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import { GardenEventType, GardenRole, GardenTaskKind, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { cleanupGardenMcpHarnesses, createGardenMcpHarness } from "./garden-mcp-tools-fixture.js";
import { cleanupPostTurnExtractHarnesses, createPostTurnPayload, createRoutingHarness } from "./post-turn-extract-task-fixture.js";

afterEach(async () => {
  await cleanupGardenMcpHarnesses();
  cleanupPostTurnExtractHarnesses();
});

const secret = "unavailable-private-turn-7c91";

it.each([undefined, "unretained-source-root"])("quarantines an unavailable source binding before MCP list and claim (%s)", async rootId => {
  const harness = await createGardenMcpHarness();
  const payload = createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a",
    ...(rootId === undefined ? {} : { admitted_source_root_id: rootId }),
    turn_digest: { last_messages: [{ role: "user", content_excerpt: secret }], context_manifest: { delivered_object_ids: [] } } });
  harness.gardenTaskRepo.enqueue({ id: "private-task", workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT, payload });
  harness.database.connection.prepare("UPDATE garden_tasks SET last_error_text = ? WHERE id = ?")
    .run("previous extraction attempt unavailable", "private-task");
  expect(harness.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-a")).toEqual([]);
  expect(await harness.gardenTaskRepo.claimAtomic("private-task", "direct-worker", "2026-05-07T00:01:00.000Z"))
    .toBe("already-claimed");
  const listed = await harness.callTool("garden.list_pending_tasks", { role: "host_worker", limit: 10 });
  const claimed = await harness.callTool("garden.claim_task", { task_id: "private-task" });
  expect(listed).toEqual({ tasks: [] });
  expect(claimed).toMatchObject({ status: "already_claimed", payload: {} });
  expect(JSON.stringify([listed, claimed])).not.toContain(secret);
  const history = harness.gardenTaskRepo.findById("private-task");
  expect(history).toMatchObject({ status: "failed", claimed_by: null,
    last_error_text: expect.stringContaining("Post-turn source provenance unavailable") });
  expect(history?.payload).toEqual(payload);
  expect(history?.last_error_text).toMatch(/^previous extraction attempt unavailable\nPost-turn source provenance unavailable:/);
  const audits = harness.database.connection.prepare("SELECT payload_json FROM event_log WHERE entity_id = ? AND event_type = ?")
    .all("private-task", GardenEventType.SOUL_GARDEN_TASK_COMPLETED) as { payload_json: string }[];
  expect(audits).toHaveLength(1);
  expect(JSON.parse(audits[0]!.payload_json)).toMatchObject({ success: false, objects_affected: [] });
});

it("refuses external completion after the admitted source is replaced", async () => {
  const receiveSignal = vi.fn(async (signal: CandidateMemorySignal) => ({ signal }));
  const harness = await createGardenMcpHarness({ receiveSignal });
  harness.enqueueTask("replaced-task", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.POST_TURN_EXTRACT,
    payload: createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a" }) });
  await harness.callTool("garden.claim_task", { task_id: "replaced-task" });
  const row = harness.gardenTaskRepo.findById("replaced-task")!;
  const rootId = (row.payload as { admitted_source_root_id: string }).admitted_source_root_id;
  replaceSource(harness.database, "workspace-a", rootId);
  expect(harness.gardenTaskRepo.refreshClaim(row.id, "garden-worker", "2026-05-07T00:10:00.000Z")).toBe(false);
  expect(harness.gardenTaskRepo.beginCompletionAttempt(row.id, "garden-worker", "completion-worker",
    "2026-05-07T00:10:00.000Z")).toBe(false);
  await expect(harness.callTool("garden.complete_task", { task_id: row.id, status: "completed",
    result_envelope: { candidate_signals: [] } })).rejects.toThrow(/not in claimed state/);
  expect(receiveSignal).not.toHaveBeenCalled();
  expect(harness.getGardenTask(row.id)).toMatchObject({ status: "failed",
    last_error_text: expect.stringContaining("source binding superseded") });
});

it("rejects queued text that differs from the retained admitted root", async () => {
  const harness = await createGardenMcpHarness();
  harness.enqueueTask("bound-task", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.POST_TURN_EXTRACT,
    payload: createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a" }) });
  const payload = harness.gardenTaskRepo.findById("bound-task")!.payload as Record<string, unknown>;
  harness.gardenTaskRepo.enqueue({ id: "mismatched-task", workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT, payload: { ...payload,
      turn_digest: { last_messages: [{ role: "user", content_excerpt: secret }] } } });
  const response = await harness.callTool("garden.claim_task", { task_id: "mismatched-task" });
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(harness.getGardenTask("mismatched-task")).toMatchObject({ status: "failed",
    last_error_text: expect.stringContaining("turn digest differs from admitted source") });
  expect(harness.getGardenTask("bound-task")).toMatchObject({ status: "pending" });
});

it("keeps unavailable work private and unmodified when its quarantine audit cannot commit", async () => {
  const harness = await createGardenMcpHarness();
  harness.gardenTaskRepo.enqueue({ id: "audit-failure", workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT, payload: createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a" }) });
  harness.database.connection.exec(`CREATE TRIGGER reject_source_quarantine BEFORE INSERT ON event_log
    WHEN NEW.entity_id = 'audit-failure' AND NEW.caused_by = 'garden-source-provenance'
    BEGIN SELECT RAISE(ABORT, 'quarantine audit unavailable'); END`);
  await expect(harness.callTool("garden.list_pending_tasks", { role: "host_worker", limit: 10 })).rejects.toThrow();
  expect(harness.getGardenTask("audit-failure")).toMatchObject({ status: "pending", completed_at: null, last_error_text: null });
  expect(harness.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-a")).toEqual([]);
  expect(harness.database.connection.prepare("SELECT count(*) AS count FROM event_log WHERE entity_id = 'audit-failure'").get())
    .toEqual({ count: 0 });
});

it("does not compile unbound legacy work while a correctly admitted task still runs", async () => {
  const compile = vi.fn(async () => []);
  const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localCompile: compile });
  harness.gardenTaskRepo.enqueue({ id: "legacy-private-task", workspace_id: "workspace-1", role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT, payload: createPostTurnPayload(), created_at: "2026-05-07T00:00:00.000Z" });
  await harness.runScheduler();
  expect(compile).not.toHaveBeenCalled();
  expect(harness.gardenTaskRepo.findById("legacy-private-task")).toMatchObject({ status: "failed",
    last_error_text: expect.stringContaining("missing admitted source binding") });
  harness.enqueuePostTurnTask({ id: "admitted-task" });
  await harness.runScheduler();
  expect(compile).toHaveBeenCalledTimes(1);
  expect(harness.gardenTaskRepo.findById("admitted-task")).toMatchObject({ status: "completed" });
});

it("advances bounded quarantine past valid claimed work and exposes a later ready task", async () => {
  const harness = await createGardenMcpHarness();
  harness.enqueueTask("a-valid-000", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.POST_TURN_EXTRACT,
    payload: createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a" }) });
  const validPayload = harness.gardenTaskRepo.findById("a-valid-000")!.payload;
  for (let index = 0; index < 100; index += 1) {
    const id = `a-valid-${String(index).padStart(3, "0")}`;
    if (index > 0) harness.gardenTaskRepo.enqueue({ id, workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT, payload: validPayload });
    expect(await harness.gardenTaskRepo.claimAtomic(id, "existing-worker", "2026-05-07T00:00:00.000Z")).toBe("claimed");
  }
  for (let index = 0; index < 10; index += 1) {
    harness.gardenTaskRepo.enqueue({ id: `b-unbound-${index}`, workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT, payload: createPostTurnPayload({ workspace_id: "workspace-a", run_id: "run-a" }),
      created_at: "2026-05-07T00:00:00.000Z" });
  }
  harness.gardenTaskRepo.enqueue({ id: "z-ready", workspace_id: "workspace-a", role: GardenRole.LIBRARIAN,
    kind: GardenTaskKind.POST_TURN_EXTRACT, payload: validPayload, created_at: "2026-05-07T00:01:00.000Z" });
  expect(await harness.callTool("garden.list_pending_tasks", { role: "host_worker", limit: 10 })).toEqual({ tasks: [] });
  harness.setContext({ workspaceId: "workspace-b", runId: "run-b" });
  expect(await harness.callTool("garden.list_pending_tasks", { role: "host_worker", limit: 10 })).toEqual({ tasks: [] });
  harness.setContext({ workspaceId: "workspace-a", runId: "run-a" });
  const later = await harness.callTool<{ tasks: { task_id: string }[] }>("garden.list_pending_tasks", { role: "host_worker", limit: 10 });
  expect(later.tasks.map(task => task.task_id)).toEqual(["z-ready"]);
  for (let index = 0; index < 10; index += 1) expect(harness.getGardenTask(`b-unbound-${index}`)).toMatchObject({ status: "failed" });
  expect(await harness.callTool("garden.claim_task", { task_id: "z-ready" })).toMatchObject({ status: "claimed" });
});

it("does not compile a projection whose original source changes after dispatch audit", async () => {
  const compile = vi.fn(async () => []);
  const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localCompile: compile });
  harness.enqueuePostTurnTask();
  const row = harness.gardenTaskRepo.findById("post-turn-task-1")!;
  const rootId = (row.payload as { admitted_source_root_id: string }).admitted_source_root_id;
  const repos = createDaemonFieldRepos({ database: harness.database });
  const root = repos.records.findById("workspace-1", rootId)!;
  if (root.source_representation?.kind !== "canonical_projection") throw new Error("fixture requires a projection");
  const originalId = root.source_representation.source_record_ids[0]!;
  const publish = harness.eventPublisher.publish.bind(harness.eventPublisher);
  vi.spyOn(harness.eventPublisher, "publish").mockImplementation(async event => {
    const result = await publish(event);
    if (event.event_type === GardenEventType.SOUL_GARDEN_TASK_DISPATCHED) replaceSource(harness.database, "workspace-1", originalId);
    return result;
  });
  await harness.runScheduler();
  expect(compile).not.toHaveBeenCalled();
  expect(harness.gardenTaskRepo.findById(row.id)).toMatchObject({ status: "failed", claimed_by: null,
    last_error_text: expect.stringContaining("source projection dependency unavailable") });
  expect(harness.database.connection.prepare("SELECT count(*) AS count FROM signals").get()).toEqual({ count: 0 });
});

function replaceSource(database: Parameters<typeof createDaemonFieldRepos>[0]["database"], workspaceId: string, rootId: string): void {
  const repos = createDaemonFieldRepos({ database });
  const old = repos.records.findById(workspaceId, rootId)!;
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database, repos }) });
  admission.admit({ workspace_id: workspaceId, source_id: old.source_id, source_version: "2",
    content_bytes: "replacement source", evidence_object_id: null, recorded_at: "2026-05-07T00:11:00.000Z",
    event_time: null, valid_from: null, valid_to: null, scope_class: "project",
    source_representation: { kind: "retained_excerpt" }, spans: [] }, { workspaceId });
}
