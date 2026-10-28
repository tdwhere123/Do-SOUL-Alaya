import { afterEach, expect, it } from "vitest";
import { SqliteTrustStateRepo } from "@do-soul/alaya-storage";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { TrustStateRecorder } from "../../../trust/state.js";
import {
  cleanupPostTurnExtractHarnesses, createDeliveryRecord, createHandlerHarness, createMcpDeps, createRoutingHarness,
  defaultContext, postTurnRows, reportUsage, unwrapOk,
  type GardenListPendingTasksOutput
} from "./post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("lists and claims a valid digest larger than the generic JSON payload limit", async () => {
  const harness = await createHandlerHarness();
  const messages = [
    { role: "user", content_excerpt: "a".repeat(9000) },
    { role: "assistant", content_excerpt: "b".repeat(9000) }
  ];
  expect((await reportUsage(harness.handler, { turn_index: 120, last_messages: messages })).ok).toBe(true);
  const listed = unwrapOk<GardenListPendingTasksOutput>(await harness.handler.call({
    toolName: "garden.list_pending_tasks", arguments: { role: "host_worker" }, context: defaultContext()
  }));
  expect(listed.tasks).toHaveLength(1);
  const taskId = listed.tasks[0]!.task_id;
  const claimed = await harness.handler.call({
    toolName: "garden.claim_task", arguments: { task_id: taskId }, context: defaultContext()
  });
  expect(claimed).toMatchObject({ ok: true, output: { status: "claimed", payload: {
    turn_digest: { last_messages: messages }
  } } });
  expect(harness.gardenTaskRepo.findById(taskId)?.status).toBe("claimed");
});

it("recovers the same report after source audit failure with the real usage writer", async () => {
  const harness = await createRoutingHarness({ provider_kind: "local_heuristics" });
  const trust = new TrustStateRecorder({ eventPublisher: harness.eventPublisher,
    repo: new SqliteTrustStateRepo(harness.database), ready: true });
  const { audit_event_id: _eventId, ...delivery } = createDeliveryRecord();
  await trust.recordDelivery(delivery);
  let failAudit = true;
  const deps = createMcpDeps(harness, { beforeSourceAudit: () => {
    if (failAudit) throw new Error("source audit unavailable");
  } });
  const handler = createMcpMemoryToolHandler({ ...deps, trustStateRecorder: trust });
  const input = { turn_index: 122, last_messages: [{ role: "user", content_excerpt: "recover me" }] };
  expect((await reportUsage(handler, input)).ok).toBe(false);
  expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  failAudit = false;
  expect((await reportUsage(handler, input)).ok).toBe(true);
  expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
  expect(harness.database.connection.prepare(
    "SELECT COUNT(*) AS count FROM trust_usage_proof WHERE delivery_id = ?"
  ).get("delivery-1")).toEqual({ count: 1 });
  expect((await harness.eventLogRepo.queryByEntity("trust_usage_proof", "delivery-1"))).toHaveLength(1);
});

it("coalesces an exact turn replay and rejects changed content under the same turn", async () => {
  const harness = await createHandlerHarness();
  const input = { turn_index: 121, last_messages: [{ role: "user", content_excerpt: "first" }] };
  expect((await reportUsage(harness.handler, input)).ok).toBe(true);
  expect((await reportUsage(harness.handler, input)).ok).toBe(true);
  expect((await reportUsage(harness.handler, { ...input,
    last_messages: [{ role: "user", content_excerpt: "changed" }] })).ok).toBe(false);
  expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
});
