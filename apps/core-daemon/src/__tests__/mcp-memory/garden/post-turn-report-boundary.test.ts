import { afterEach, expect, it } from "vitest";
import { GardenTaskKind } from "@do-soul/alaya-protocol";
import { SqliteTrustStateRepo } from "@do-soul/alaya-storage";
import { closeStatementSessionChunks } from "../../../garden/statement-session/statement-session-closure.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { TrustStateRecorder } from "../../../trust/state.js";
import {
  cleanupPostTurnExtractHarnesses, createDeliveryRecord, createHandlerHarness, createMcpDeps, createRoutingHarness,
  defaultContext, postTurnRows, reportUsage, unwrapOk,
  type GardenListPendingTasksOutput
} from "./post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("lists and claims a session request over a digest larger than the generic JSON payload limit", async () => {
  const harness = await createHandlerHarness();
  const messages = [
    { role: "user", content_excerpt: "a".repeat(9000) },
    { role: "assistant", content_excerpt: "b".repeat(9000) }
  ];
  expect((await reportUsage(harness.handler, { turn_index: 120, last_messages: messages })).ok).toBe(true);
  closeStatementSessionChunks(harness.gardenTaskRepo, { workspaceId: "workspace-1", runId: "run-1", closeTail: true,
    now: () => "2026-05-07T00:30:00.000Z" });
  const listed = unwrapOk<GardenListPendingTasksOutput>(await harness.handler.call({
    toolName: "garden.list_pending_tasks", arguments: { role: "host_worker" }, context: defaultContext()
  }));
  const sessions = listed.tasks.filter(task => task.kind === GardenTaskKind.SOURCE_STATEMENT_SESSION);
  expect(sessions).toHaveLength(1);
  const taskId = sessions[0]!.task_id;
  const claimed = await harness.handler.call({
    toolName: "garden.claim_task", arguments: { task_id: taskId }, context: defaultContext()
  });
  expect(claimed).toMatchObject({ ok: true, output: { status: "claimed", payload: {
    source_statements: { requests: [{ chunk_index: 0, session_id: "run-1", context: [],
      messages: messages.map(message => ({ role: message.role, text: message.content_excerpt, recorded_at: null })) }] }
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
