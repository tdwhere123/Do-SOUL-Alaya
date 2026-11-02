import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  SignalSource,
} from "@do-soul/alaya-protocol";
import type { GardenComputeProvider } from "@do-soul/alaya-soul";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";

import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

import {
  cleanupGardenRoutingHarnesses,
  createMcpDeps,
  createRoutingHarness,
  recordedSessionResponses,
  recordedStatementExtract,
  defaultContext,
  gardenTaskSignalId,
  pageWorkspaceSourceRoots,
  retainedSourceBody,
  routingTurn,
  seedRun,
  unwrapOk
} from "./garden-routing-fixture.js";

afterEach(cleanupGardenRoutingHarnesses);

describe("statement session routing over captured host sessions", () => {
  it("processes session work behind more than fifty unrelated librarian tasks", async () => {
    const extract = recordedStatementExtract(message => message.role === "user" ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : []);
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: extract });
    for (let index = 0; index < 51; index += 1) {
      harness.gardenTaskRepo.enqueue({ id: `unrelated-${index}`, workspace_id: "workspace-1",
        role: GardenRole.LIBRARIAN, kind: GardenTaskKind.EDGE_CLASSIFY,
        payload: { task_id: `unrelated-${index}`, task_kind: GardenTaskKind.EDGE_CLASSIFY, required_tier: GardenTier.TIER_2,
          workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [`edge-${index}`], priority: 20,
          created_at: "2026-05-07T00:00:00.000Z" },
        created_at: "2026-05-07T00:00:00.000Z" });
    }
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(harness.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, "workspace-1", 64, GardenTaskKind.EDGE_CLASSIFY)).toHaveLength(51);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.not.toBeNull();
  });

  it("retains the admitted round when the session model returns no statements", async () => {
    const harness = await createRoutingHarness({ provider_kind: "official_api", officialExtract: recordedStatementExtract() });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(harness.sessionTasks()).toEqual([expect.objectContaining({ status: "completed" })]);
    expect(await harness.signalService.listByRun("run-1")).toHaveLength(0);
    expect(retainedSourceBody(harness.database, harness.roundRoots()[0]!)).toContain("I prefer pnpm commands in this repo.");
  });

  it("host_worker routing falls back to the local provider after an unclaimed session chunk waits out the window", async () => {
    const officialExtract = recordedStatementExtract();
    const localExtract = recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]);
    const harness = await createRoutingHarness({ provider_kind: "host_worker", officialExtract, localExtract });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({ status: "pending" })]);
    expect(localExtract).not.toHaveBeenCalled();

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(officialExtract).not.toHaveBeenCalled();
    expect(localExtract).toHaveBeenCalledTimes(1);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toMatchObject({
      workspace_id: "workspace-1"
    });
  });

  it("local_heuristics routing settles an idle session chunk inline", async () => {
    const localExtract = recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]);
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    expect(localExtract).toHaveBeenCalledTimes(1);
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "completed", claimed_by: "in-process" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 1))).resolves.toMatchObject({
      signal_id: gardenTaskSignalId(session!.id, 1)
    });
  });

  it("local_heuristics routing attributes session signals to the capturing attached session run", async () => {
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics",
      localExtract: recordedStatementExtract(() => [{ text: "A recorded statement.", relation: "recorded" }]) });
    await seedRun(harness.runRepo, "mcp-session-run-1");
    await harness.captureTurn({ runId: "mcp-session-run-1" });

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    expect(session?.payload).toMatchObject({ run_id: "mcp-session-run-1" });
    await expect(harness.signalRepo.getById(gardenTaskSignalId(session!.id, 0))).resolves.toMatchObject({
      run_id: "mcp-session-run-1"
    });
  });

  it("a failing statement provider fails the session chunk without aborting the background pass", async () => {
    const extract = vi.fn<NonNullable<GardenComputeProvider["extractSourceStatementRequest"]>>(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract: extract });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await expect(harness.runScheduler()).resolves.toBeUndefined();

    expect(extract).toHaveBeenCalledTimes(1);
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    })]);
    const completedEvents = (await harness.eventLogRepo.queryByType(
      GardenEventType.SOUL_GARDEN_TASK_COMPLETED
    )).events;
    expect(completedEvents.at(-1)?.payload_json).toMatchObject({
      task_kind: GardenTaskKind.SOURCE_STATEMENT_SESSION,
      success: false,
      candidate_signals_count: 0
    });
    const roots = pageWorkspaceSourceRoots(harness.database);
    expect(roots.rows.some((row) =>
      row.kind === "source_record"
      && (row.content ?? "").includes("I prefer pnpm commands")
    )).toBe(true);
  });

  it("keeps the unsliced round root of a message longer than 800 chars after a throwing provider", async () => {
    const tail = "BEYOND_EIGHT_HUNDRED_MARKER";
    const excerpt = `${"a".repeat(800)}${tail}`;
    const extract = vi.fn<NonNullable<GardenComputeProvider["extractSourceStatementRequest"]>>(async () => {
      throw new Error("provider blew up");
    });
    const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract: extract });
    const handler = createMcpMemoryToolHandler(createMcpDeps(harness, { hostSessionCapture: harness.hostSessionCapture }));

    expect((await handler.call({ toolName: "soul.capture_host_session", arguments: { container: { scope: "routing-host",
      id: "conversation-1" }, messages: routingTurn({ user: excerpt }).slice(0, 1), closes_tail: true },
      context: defaultContext() })).ok).toBe(true);
    expect(harness.roundRoots()).toHaveLength(1);

    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await expect(harness.runScheduler()).resolves.toBeUndefined();
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].messages[0]!.text).toBe(excerpt);
    expect(harness.sessionTasks()).toEqual([expect.objectContaining({
      status: "failed",
      last_error_text: expect.stringContaining("provider blew up")
    })]);

    const roots = pageWorkspaceSourceRoots(harness.database);
    expect(roots.rows.some((row) =>
      row.kind === "source_record"
      && row.root_id === harness.roundRoots()[0]
      && row.content_complete === true
      && (row.content ?? "").includes(tail)
      && (row.content ?? "").length > 800
    )).toBe(true);
    expect(roots.rows.some((row) =>
      row.content_complete === true
      && (row.content ?? "").length > 0
      && !(row.content ?? "").includes(tail)
    )).toBe(false);
    expect(
      (harness.database.connection.prepare("SELECT COUNT(*) AS count FROM memory_entries").get() as {
        count: number;
      }).count
    ).toBe(0);
  });

  it("host_worker claim and completion bind session statement responses to the captured host messages", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();
    const [session] = harness.sessionTasks();
    expect(session).toMatchObject({ status: "pending", claimed_by: null });

    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    const claimResult = unwrapOk<{ readonly status: string; readonly payload: unknown }>(
      await handler.call({
        toolName: "garden.claim_task",
        arguments: { task_id: session!.id },
        context: defaultContext()
      })
    );
    expect(claimResult.status).toBe("claimed");
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({
      status: "claimed",
      claimed_by: defaultContext().agentTarget
    });

    const completeResult = unwrapOk<{ readonly status: string }>(
      await handler.call({
        toolName: "garden.complete_task",
        arguments: {
          task_id: session!.id,
          status: "completed",
          result_envelope: {
            source_statement_responses: recordedSessionResponses(claimResult.payload, message => message.role === "user"
              ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : [])
          }
        },
        context: defaultContext()
      })
    );
    expect(completeResult.status).toBe("completed");
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({ status: "completed" });
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ source: SignalSource.GARDEN_COMPILE, signal_state: "triaged",
      interpretation_contract: "source-statements-v1", object_kind: null, confidence: null,
      source_memory_refs: [], incompatible_with_refs: [],
      raw_payload: { source_statement: {
        source_root_id: harness.roundRoots()[0],
        message: { message_id: "message-0", role: "user" },
        statement: { text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" } } } });
    expect(retainedSourceBody(harness.database, harness.roundRoots()[0]!)).toContain("I prefer pnpm commands in this repo.");
  });

  it("preserves explicit graph refs on non-extraction tasks without promoting raw-payload arrays", async () => {
    const harness = await createRoutingHarness({ provider_kind: "host_worker" });
    harness.gardenTaskRepo.enqueue({ id: "ttl-cleanup-task-1", workspace_id: "workspace-1",
      role: GardenRole.JANITOR, kind: GardenTaskKind.TTL_CLEANUP, created_at: "2026-05-07T00:10:00.000Z",
      payload: { task_id: "ttl-cleanup-task-1", task_kind: GardenTaskKind.TTL_CLEANUP, required_tier: GardenTier.TIER_1,
        workspace_id: "workspace-1", run_id: "run-1", target_object_refs: [], priority: 20,
        created_at: "2026-05-07T00:10:00.000Z" } });

    const handler = createMcpMemoryToolHandler(createMcpDeps(harness));
    await handler.call({
      toolName: "garden.claim_task",
      arguments: { task_id: "ttl-cleanup-task-1" },
      context: defaultContext()
    });

    const completeResult = unwrapOk<{
      readonly status: string;
      readonly events_appended: number;
    }>(
      await handler.call({
        toolName: "garden.complete_task",
        arguments: {
          task_id: "ttl-cleanup-task-1",
          status: "completed",
          result_envelope: {
            candidate_signals: [
              {
                signal_kind: "potential_preference",
                object_kind: "memory_entry",
                scope_hint: "project",
                domain_tags: ["preference"],
                confidence: 0.78,
                evidence_refs: ["evidence-1"],
                source_memory_refs: ["memory-a"],
                raw_payload: {
                  observation: "user prefers vitest watch mode",
                  source_memory_refs: ["raw-memory"],
                  incompatible_with_refs: ["raw-conflict"]
                }
              }
            ]
          }
        },
        context: defaultContext()
      })
    );

    expect(completeResult.status).toBe("completed");
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toHaveLength(1);
    expect(signals.find((signal) => signal.object_kind === "memory_entry")).toMatchObject({
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged",
      source_memory_refs: ["memory-a"],
      incompatible_with_refs: [],
      raw_payload: {
        observation: "user prefers vitest watch mode",
        source_memory_refs: ["raw-memory"],
        incompatible_with_refs: ["raw-conflict"]
      }
    });
  });

  it("scheduler reclaims abandoned claims (status=claimed older than stale TTL) for another claimant", async () => {
    const now = "2026-05-07T00:10:00.000Z";
    const harness = await createRoutingHarness({
      provider_kind: "host_worker",
      now: () => now
    });
    await harness.captureTurn({ closesTail: true });
    const [session] = harness.sessionTasks();
    // An attached agent claimed but never completed, past GARDEN_CLAIM_STALE_AFTER_MS (10 min).
    const staleClaimedAt = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
    await harness.gardenTaskRepo.claimAtomic(session!.id, "abandoned-agent", staleClaimedAt, "workspace-1");
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({ status: "claimed", claimed_by: "abandoned-agent" });

    await harness.runScheduler();

    // A reclaimed host-worker chunk returns to MCP workers.
    expect(harness.gardenTaskRepo.findById(session!.id)).toMatchObject({ status: "pending", claimed_by: null });
    await expect(
      harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED)
    ).resolves.toEqual({
      truncated: false,
      events: [
      expect.objectContaining({
        entity_id: session!.id,
        payload_json: expect.objectContaining({
          previous_claimed_by: "abandoned-agent",
          stale_after_ms: 10 * 60 * 1000
        })
      })
      ]
    });
  });

  it("records session statement signals in the signal review queue", async () => {
    const harness = await createRoutingHarness({ provider_kind: "official_api",
      officialExtract: recordedStatementExtract(message => message.role === "user"
        ? [{ text: "The user prefers pnpm commands in this repo.", relation: "tooling preference" }] : []) });
    await harness.captureTurn();
    harness.advance(STATEMENT_SESSION_IDLE_MS);
    await harness.runScheduler();

    const [session] = harness.sessionTasks();
    const signals = await harness.signalService.listByRun("run-1");
    expect(signals).toEqual([expect.objectContaining({
      signal_id: gardenTaskSignalId(session!.id, 0),
      source: SignalSource.GARDEN_COMPILE,
      signal_state: "triaged"
    })]);
  });

});
