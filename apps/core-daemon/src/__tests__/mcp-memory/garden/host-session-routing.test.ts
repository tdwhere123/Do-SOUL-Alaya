import { afterEach, describe, expect, it } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
} from "@do-soul/alaya-protocol";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";

import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

import {
  cleanupPostTurnExtractHarnesses,
  createMcpDeps,
  createDeliveryRecord,
  createHandlerHarness,
  createPostTurnPayload,
  createRoutingHarness,
  recordedStatementExtract,
  defaultContext,
  gardenTaskSignalId,
  noRunContext,
  postTurnRows,
  recall,
  reportUsage,
  sessionRunContext,
  pageWorkspaceSourceRoots,
  unwrapOk,
  type GardenListPendingTasksOutput,
  type PostTurnPayload
} from "./post-turn-extract-task-fixture.js";

afterEach(() => {
  cleanupPostTurnExtractHarnesses();
});

describe("post-turn extract Garden task", () => {

  it("used context usage enqueues one in-process POST_TURN_EXTRACT task", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      turn_index: 7,
      delivered_objects: [
        { object_id: "memory-a", usage_status: "skipped" },
        { object_id: "memory-b", usage_status: "used" }
      ],
      last_messages: [
        { role: "user", content_excerpt: "x".repeat(900) },
        { role: "assistant", content_excerpt: "Used memory-b in the answer." }
      ]
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: GardenTaskKind.POST_TURN_EXTRACT,
      status: "pending"
    });
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(payload).toMatchObject({
      run_id: "run-1",
      turn_index: 7,
      workspace_id: "workspace-1",
      source_observed_at: "2026-05-07T00:10:00.000Z"
    });
    expect(payload).not.toHaveProperty("source_observation");
    expect(payload.turn_digest.context_manifest.delivered_object_ids).toEqual([
      "memory-a",
      "memory-b"
    ]);
    expect(payload.turn_digest.last_messages[0]!.content_excerpt).toHaveLength(900);
    expect(payload.admitted_source_root_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(pageWorkspaceSourceRoots(harness.database).rows.some((row) =>
      row.kind === "source_record"
      && row.original_complete === false
      && row.root_id === payload.admitted_source_root_id
      && row.scope_class === "project"
      && row.event_time === null
      && row.role === undefined
      && (row.content ?? "").includes("x".repeat(800))
      && (row.content ?? "").includes("x".repeat(900))
    )).toBe(true);

    const listed = unwrapOk<GardenListPendingTasksOutput>(
      await harness.handler.call({
        toolName: "garden.list_pending_tasks",
        arguments: { role: "host_worker", limit: 10 },
        context: defaultContext()
      })
    );
    expect(listed.tasks).toHaveLength(1);
    expect(listed.tasks[0]).toMatchObject({
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.POST_TURN_EXTRACT
    });
  });

  it("observes reported text at receipt, never at a public timestamp or delivery time", async () => {
    const harness = await createHandlerHarness();

    const result = await reportUsage(harness.handler, {
      turn_index: 11,
      source_observed_at: "1999-01-01T00:00:00.000Z"
    });

    expect(result.ok).toBe(true);
    const payload = postTurnRows(harness.gardenTaskRepo)[0]!.payload as PostTurnPayload;
    expect(payload.source_observed_at).toBe("2026-05-07T00:10:00.000Z");
    expect(payload).not.toHaveProperty("source_observation");
  });

  it("usage report with no run id and no linked delivery enqueues no extract work", async () => {
    const harness = await createHandlerHarness({ delivery: null });

    const result = await reportUsage(harness.handler, {
      turn_index: 8,
      context: noRunContext()
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("usage report with an attached session run enqueues extract work scoped to the linked delivery run", async () => {
    const harness = await createHandlerHarness({
      delivery: createDeliveryRecord({ run_id: "mcp-session-run-1" })
    });

    const result = await reportUsage(harness.handler, {
      turn_index: 8,
      context: sessionRunContext()
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as PostTurnPayload).run_id).toBe("mcp-session-run-1");
  });

  it("delayed usage reports enqueue extract work under the linked delivery run", async () => {
    const harness = await createHandlerHarness({
      delivery: createDeliveryRecord({ run_id: "run-original" })
    });

    const result = await reportUsage(harness.handler, {
      turn_index: 9,
      context: {
        ...defaultContext(),
        runId: "run-reporter",
        sessionId: "later-session"
      }
    });

    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as PostTurnPayload;
    expect(payload.run_id).toBe("run-original");
  });

  it("skipped and not_applicable usage still enqueue extract work when a turn_digest is present", async () => {
    const harness = await createHandlerHarness();

    await reportUsage(harness.handler, {
      turn_index: 1,
      usage_state: "skipped",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-a", usage_status: "skipped" }]
    });
    await reportUsage(harness.handler, {
      turn_index: 2,
      usage_state: "not_applicable",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-b", usage_status: "not_applicable" }]
    });

    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT && row.status === "pending"
      )
    ).toBe(true);
  });

  it("a report with an empty turn_digest enqueues no extract work", async () => {
    const harness = await createHandlerHarness();

    await reportUsage(harness.handler, {
      turn_index: 1,
      usage_state: "skipped",
      used_object_ids: [],
      delivered_objects: [{ object_id: "memory-a", usage_status: "skipped" }],
      last_messages: []
    });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("dedupes concurrent reports for the same workspace run and turn", async () => {
    const harness = await createHandlerHarness();

    const calls = await Promise.all([
      reportUsage(harness.handler, { turn_index: 42 }),
      reportUsage(harness.handler, { turn_index: 42 })
    ]);

    expect(calls.every((result) => result.ok)).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toHaveLength(1);
  });

  it("a recall with a long query does not enqueue extraction", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "remember that I always use pnpm for this project"
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("does not persist a public recall timestamp without a verified delivery", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, {
      query: "remember that I always use pnpm for this project",
      source_observed_at: "1999-01-01T00:00:00.000Z"
    });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("ignores recent_turn for extraction and accepts the later explicit turn digest", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "From now on always reply to me in Chinese for this project."
    });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
    const result = await reportUsage(harness.handler, {
      turn_index: 15,
      last_messages: [{ role: "user", content_excerpt: "Explicit completed-turn digest." }]
    });
    expect(result.ok).toBe(true);
    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect((rows[0]!.payload as PostTurnPayload).turn_digest.last_messages).toEqual([
      { role: "user", content_excerpt: "Explicit completed-turn digest." }
    ]);
  });

  it("recall with no run id enqueues no extract work", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "Please remember that I do not want fixable issues parked in backlog.",
      context: noRunContext()
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("recall with an attached session run still does not enqueue extraction", async () => {
    const harness = await createHandlerHarness();

    const result = await recall(harness.handler, {
      query: "pnpm",
      recent_turn: "Please remember that I do not want fixable issues parked in backlog.",
      context: sessionRunContext()
    });

    expect(result.ok).toBe(true);
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("does not enqueue a recall-driven extract task for a short query and no recent_turn", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "pnpm" });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("repeated recalls remain extraction-free within a run", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });
    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });

    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
  });

  it("a report after Recall owns the extraction task and repeated reports remain idempotent", async () => {
    const harness = await createHandlerHarness();

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });
    expect(postTurnRows(harness.gardenTaskRepo)).toEqual([]);
    const report = {
      turn_index: 3,
      last_messages: [
        { role: "user", content_excerpt: "remember that I always use pnpm for this project" },
        { role: "assistant", content_excerpt: "I used the project preference." }
      ]
    } as const;
    expect((await reportUsage(harness.handler, report)).ok).toBe(true);
    expect((await reportUsage(harness.handler, report)).ok).toBe(true);

    const rows = postTurnRows(harness.gardenTaskRepo);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id.startsWith("post_turn_extract_")).toBe(true);
    expect((rows[0]!.payload as PostTurnPayload).turn_digest.last_messages).toEqual(report.last_messages);
  });

  it("keeps Recall extraction-free while an explicit report remains observable at high queue depth", async () => {
    const harness = await createHandlerHarness();
    for (let i = 0; i < 128; i += 1) {
      harness.gardenTaskRepo.enqueue({
        id: `seed-extract-${i}`,
        workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: createPostTurnPayload(),
        created_at: "2026-05-07T00:00:00.000Z"
      });
    }

    await recall(harness.handler, { query: "remember that I always use pnpm for this project" });
    expect(harness.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get()).toEqual({ count: 128 });
    const reported = await reportUsage(harness.handler, { turn_index: 129 });
    expect(reported.ok).toBe(true);
    expect(harness.database.connection.prepare("SELECT COUNT(*) AS count FROM garden_tasks").get()).toEqual({ count: 129 });

    expect(harness.gardenTaskRepo.findById("seed-extract-0")).not.toBeNull();
    expect(
      harness.gardenTaskRepo
        .peekPending(GardenRole.LIBRARIAN, "workspace-1", 256)
        .filter((row) => row.kind === GardenTaskKind.POST_TURN_EXTRACT && row.id.startsWith("recall_extract_"))
    ).toEqual([]);
  });

  it("official_api routing completes post-turn work without a model and settles its closed session chunk", async () => {
    const extract = recordedStatementExtract(message => message.role === "user"
      ? [{ text: "The user prefers pnpm commands.", relation: "tooling preference" },
        { text: "The repo uses pnpm.", relation: "tooling" }] : []);
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    harness.enqueuePostTurnTask({
      payload: createPostTurnPayload({
        source_observation: {
          observed_at: "2026-05-07T00:00:00.000Z",
          authority: "verified_delivery_observation",
          source_event_id: "event-delivery"
        }
      })
    });

    await harness.runScheduler();
    expect(extract).not.toHaveBeenCalled();
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed", claimed_by: "in-process" });
    expect(harness.sessionTasks()).toEqual([]);

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].messages.map(message => [message.message_id, message.recorded_at])).toEqual([
      ["post-turn:post-turn-task-1:message:0", null], ["post-turn:post-turn-task-1:message:1", null]]);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    const completedEvents = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
    expect(completedEvents.map(event => event.payload_json)).toEqual([
      expect.objectContaining({ task_kind: GardenTaskKind.POST_TURN_EXTRACT, success: true }),
      expect.objectContaining({ task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION, success: true, candidate_signals_count: 2 })
    ]);
    for (const index of [0, 1]) {
      await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, index))).resolves.toMatchObject({
        workspace_id: "workspace-1", source_observation: null
      });
    }
  });

  it("retains valid statements but fails the session task when the receipt is incomplete", async () => {
    const extract = recordedStatementExtract(() => [], request => JSON.stringify({ messages: [{
      message_id: request.messages[0]!.message_id, statements: [{ text: "Recorded event.", relation: "recorded event" }] }] }));
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
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
    harness.enqueuePostTurnTask();
    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "failed" });
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toBeNull();
  });

  it("host_worker routing completes post-turn work in process and leaves the session chunk for MCP workers", async () => {
    const officialExtract = recordedStatementExtract();
    const localExtract = recordedStatementExtract();
    const harness = await createRoutingHarness({ provider_kind: "host_worker", officialExtract, localExtract });
    harness.enqueuePostTurnTask();

    await harness.runScheduler();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(officialExtract).not.toHaveBeenCalled();
    expect(localExtract).not.toHaveBeenCalled();
    expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "completed" });
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "pending", claimed_by: null });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const listed = unwrapOk<GardenListPendingTasksOutput>(
      await handler.call({
        toolName: "garden.list_pending_tasks",
        arguments: { role: "host_worker", limit: 10 },
        context: defaultContext()
      })
    );
    expect(listed.tasks).toEqual([
      expect.objectContaining({
        task_id: session!.id,
        role: "host_worker",
        kind: GardenTaskKind.SOURCE_STATEMENT_SESSION
      })
    ]);
  });
});
