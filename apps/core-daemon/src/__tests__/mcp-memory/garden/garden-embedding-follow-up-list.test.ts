import { afterEach, expect, it } from "vitest";
import { GardenListPendingTasksResponseSchema, GardenTaskKind } from "@do-soul/alaya-protocol";
import { cleanupGardenMcpHarnesses, createGardenMcpHarness } from "./garden-mcp-tools-fixture.js";
import { createFaults, createHandoffRuntime, EVIDENCE, IDS, seedHandoffData, WORKSPACE }
  from "../../garden/embedding-backfill-follow-up-fixture.js";

afterEach(async () => { await cleanupGardenMcpHarnesses(); });

it("projects a real pending and blocked follow-up through MCP without exposing it as a claimable task", async () => {
  const harness = await createGardenMcpHarness();
  await seedHandoffData(harness.database);
  harness.setContext({ workspaceId: WORKSPACE, runId: "run-follow-up" });
  const faults = createFaults();
  faults.failAdmissionAt = 2;
  const runtime = createHandoffRuntime(harness.database, faults);
  await expect(runtime.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/follow_up_failed/);
  const initial = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", {
    role: "librarian", limit: 10
  }));
  expect(initial.tasks).toEqual([]);
  expect(initial.embedding_follow_ups).toEqual([expect.objectContaining({ state: "pending", in_flight: false,
    attempt_count: 1, reason: "operation_failed", parent_outcome: "failed" })]);
  expect(initial.embedding_follow_ups_truncated).toBe(false);
  harness.setContext({ workspaceId: "workspace-b", runId: "run-b" });
  const foreign = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", { limit: 10 }));
  expect(foreign.embedding_follow_ups).toEqual([]);
  expect(foreign.embedding_follow_ups_truncated).toBe(false);
  harness.setContext({ workspaceId: WORKSPACE, runId: "run-follow-up" });
  faults.failAdmissionAt = null;
  await runtime.hq.upsertFromEvidence({ object_id: IDS[1], workspace_id: WORKSPACE,
    hqs: ["changed private evidence"], evidence_id: EVIDENCE[1], producer_id: "fixture_hq_changed",
    created_at: "2030-01-01T00:00:00.000Z", updated_at: "2030-01-01T00:00:01.000Z" });
  await expect(runtime.runtime.runEmbeddingBackfillPass(WORKSPACE)).rejects.toThrow(/formation_changed/);
  const blocked = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", { limit: 10 }));
  expect(blocked.embedding_follow_ups).toEqual([expect.objectContaining({ state: "blocked", in_flight: false,
    attempt_count: 2, reason: "formation_changed", parent_outcome: "failed" })]);
  expect(blocked.tasks).toEqual([]);
});

it("reports bounded pages and role filtering without implying that unseen obligations are absent", async () => {
  const harness = await createGardenMcpHarness();
  for (const [taskId, workspaceId] of [["one", "workspace-a"], ["two", "workspace-a"], ["foreign", "workspace-b"]] as const) {
    harness.enqueueTask(taskId, { workspace_id: workspaceId, role: "librarian", kind: GardenTaskKind.EMBEDDING_BACKFILL });
    harness.database.connection.prepare("UPDATE garden_tasks SET status = 'failed', outcome = 'failed' WHERE id = ?").run(taskId);
    harness.database.connection.prepare(`INSERT INTO garden_embedding_backfill_runs
      (task_id, workspace_id, state, mode, updated_at) VALUES (?, ?, 'pending', 'production', ?)`)
      .run(taskId, workspaceId, "2030-01-01T00:00:00.000Z");
  }
  const page = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", { limit: 1 }));
  expect(page.embedding_follow_ups?.map(item => item.task_id)).toEqual(["one"]);
  expect(page.embedding_follow_ups_truncated).toBe(true);
  const all = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", { limit: 2 }));
  expect(all.embedding_follow_ups?.map(item => item.task_id)).toEqual(["one", "two"]);
  expect(all.embedding_follow_ups_truncated).toBe(false);
  const janitor = GardenListPendingTasksResponseSchema.parse(await harness.callTool("garden.list_pending_tasks", {
    role: "janitor", limit: 2
  }));
  expect(janitor.embedding_follow_ups).toEqual([]);
  expect(janitor.embedding_follow_ups_truncated).toBe(false);
});
