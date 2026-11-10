import { afterEach, describe, expect, it } from "vitest";
import { GardenEventType, GardenTaskKind, hostSessionStatementSessionId, hostSessionContainerKey } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import {
  ROUTING_CONTAINER,
  cleanupGardenRoutingHarnesses,
  createHandlerHarness,
  createMcpDeps,
  createRoutingHarness,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
  recall,
  recordedStatementExtract,
  routingTurn,
  unwrapOk,
  type GardenListPendingTasksOutput
} from "./garden-routing-fixture.js";

afterEach(cleanupGardenRoutingHarnesses);

const gardenTaskCount = (harness: Awaited<ReturnType<typeof createHandlerHarness>>) =>
  harness.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get();

describe("usage feedback and recall capture nothing", () => {
  it("accepts a usage report with deprecated turn fields as usage feedback only", async () => {
    const harness = await createHandlerHarness();

    const result = await harness.handler.call({ toolName: "soul.report_context_usage", arguments: {
      delivery_id: "delivery-1", usage_state: "used", used_object_ids: ["memory-b"],
      delivered_objects: [{ object_id: "memory-a", usage_status: "skipped" }, { object_id: "memory-b", usage_status: "used" }],
      turn_index: 7, source_observed_at: "1999-01-01T00:00:00.000Z",
      turn_digest: { last_messages: [{ role: "user", content_excerpt: "Remember that I prefer pnpm." }] }
    }, context: defaultContext() });

    expect(result.ok).toBe(true);
    expect(gardenTaskCount(harness)).toEqual({ count: 0 });
    expect(harness.database.connection.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 0 });
    expect(harness.database.connection.prepare("SELECT COUNT(*) AS count FROM host_session_messages").get())
      .toEqual({ count: 0 });
  });

  it("keeps recall extraction-free with or without a run and a recent turn", async () => {
    const harness = await createHandlerHarness();

    for (const context of [defaultContext(), noRunContext()]) {
      expect((await recall(harness.handler, { query: "remember that I always use pnpm for this project",
        recent_turn: "From now on always reply to me in Chinese for this project.", context })).ok).toBe(true);
    }

    expect(gardenTaskCount(harness)).toEqual({ count: 0 });
    expect(harness.database.connection.prepare("SELECT COUNT(*) AS count FROM source_records").get()).toEqual({ count: 0 });
  });

  it("captures host messages through the MCP tool and refuses capture without an attached run", async () => {
    const harness = await createHandlerHarness();
    const request = { container: ROUTING_CONTAINER, messages: routingTurn() };

    const captured = unwrapOk(await harness.handler.call({ toolName: "soul.capture_host_session", arguments: request,
      context: defaultContext() }));
    expect(captured).toMatchObject({ container_key: hostSessionContainerKey(ROUTING_CONTAINER, fieldContractSha256),
      admitted_message_count: 2, replayed_message_count: 0, pending_message_count: 0, admitted_round_count: 1, pending_round_count: 0 });
    expect(captured).toHaveProperty("message_sources", expect.arrayContaining(request.messages.map(message =>
      expect.objectContaining({ message_id: message.message_id, source: expect.objectContaining({ occurrence_id: message.message_id }) }))));
    expect(await harness.handler.call({ toolName: "soul.capture_host_session", arguments: request,
      context: noRunContext() })).toMatchObject({ ok: false });
    expect(unwrapOk(await harness.handler.call({ toolName: "soul.capture_host_session", arguments: request,
      context: defaultContext() }))).toMatchObject({ admitted_message_count: 0, replayed_message_count: 2,
      admitted_round_count: 0 });
  });
});

describe("statement session routing over captured host sessions", () => {
  it("official_api routing settles an idle container's session chunk with host message ids and host time", async () => {
    const extract = recordedStatementExtract(message => message.role === "user"
      ? [{ text: "The user prefers pnpm commands.", relation: "tooling preference" },
        { text: "The repo uses pnpm.", relation: "tooling" }] : []);
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    await harness.captureTurn({ messages: routingTurn({ hostReportedAt: "2026-05-06T09:00:00.000Z" }) });

    await harness.runScheduler();
    expect(extract).not.toHaveBeenCalled();
    expect(harness.sessionTasks()).toEqual([]);

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(extract).toHaveBeenCalledTimes(1);
    const request = extract.mock.calls[0]![0];
    expect(request.session_id).toBe(hostSessionStatementSessionId(hostSessionContainerKey(ROUTING_CONTAINER, fieldContractSha256)));
    expect(request.messages.map(message => [message.message_id, message.recorded_at])).toEqual([
      ["message-0", "2026-05-06T09:00:00.000Z"], ["message-1", "2026-05-06T09:00:00.000Z"]]);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    const completedEvents = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
    expect(completedEvents.map(event => event.payload_json)).toEqual([
      expect.objectContaining({ task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, success: true, candidate_signals_count: 2 })
    ]);
    for (const index of [0, 1]) {
      await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, index))).resolves.toMatchObject({
        workspace_id: "workspace-1", run_id: "run-1",
        // The round root's receipt time, never the host-reported message time, is the observation.
        source_observation: { observed_at: "2026-05-07T00:10:00.000Z", authority: "trusted_host_event" }
      });
    }
  });

  it("retains valid statements but fails the session task when the receipt is incomplete", async () => {
    const extract = recordedStatementExtract(() => [], request => JSON.stringify({ messages: [{
      message_id: request.messages[0]!.message_id, statements: [{ text: "Recorded event.", relation: "recorded event" }] }] }));
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toMatchObject({
      workspace_id: "workspace-1"
    });
    expect(session).toMatchObject({ status: "failed", claimed_by: "in-process" });
    const completion = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
    expect(completion.at(-1)?.payload_json).toMatchObject({ success: false, candidate_signals_count: 1 });
  });

  it("fails the session task when an unreadable receipt yields no statements", async () => {
    const harness = await createRoutingHarness({ provider_kind: "official_api",
      officialExtract: recordedStatementExtract(() => [], () => "not-json") });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "failed" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toBeNull();
  });

  it("host_worker routing leaves the session chunk for MCP workers", async () => {
    const officialExtract = recordedStatementExtract();
    const localExtract = recordedStatementExtract();
    const harness = await createRoutingHarness({ provider_kind: "host_worker", officialExtract, localExtract });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(officialExtract).not.toHaveBeenCalled();
    expect(localExtract).not.toHaveBeenCalled();
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "pending", claimed_by: null });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const listed = unwrapOk<GardenListPendingTasksOutput>(await handler.call({ toolName: "garden.list_pending_tasks",
      arguments: { role: "host_worker", limit: 10 }, context: defaultContext() }));
    expect(listed.tasks).toEqual([expect.objectContaining({ task_id: session!.id, role: "host_worker",
      kind: GardenTaskKind.SOURCE_STATEMENT_SESSION })]);
  });

  it("forms a trailing user message's round only when the idle sweep closes the container", async () => {
    const extract = recordedStatementExtract();
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    expect(await harness.captureTurn({ messages: routingTurn().slice(0, 1) }))
      .toMatchObject({ admitted_message_count: 1, pending_message_count: 1, admitted_round_count: 0 });
    expect(harness.roundRoots()).toEqual([]);

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(harness.roundRoots()).toHaveLength(1);
    expect(extract.mock.calls[0]![0].messages.map(message => message.message_id)).toEqual(["message-0"]);
    // A late reply cannot join the closed round; it forms its own.
    expect(await harness.captureTurn({ messages: routingTurn().slice(1) }))
      .toMatchObject({ admitted_message_count: 1, pending_message_count: 0, admitted_round_count: 1 });
    expect(harness.roundRoots()).toHaveLength(2);
  });
});
