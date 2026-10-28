import { afterEach, expect, it } from "vitest";
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import { cleanupGardenMcpHarnesses, createGardenMcpHarness, createTaskDescriptor } from "./garden-mcp-tools-fixture.js";
import { cleanupPostTurnExtractHarnesses, createRoutingHarness, createSignal } from "./post-turn-extract-task-fixture.js";

afterEach(async () => { await cleanupGardenMcpHarnesses(); cleanupPostTurnExtractHarnesses(); });

it("reports failed signal materialization separately from successful external task completion", async () => {
  const harness = await createGardenMcpHarness({ receiveSignal: async signal => ({
    signal: { ...signal, signal_state: "failed" }, materialization: { success: false, created_objects: [] }
  }) });
  harness.enqueueTask("task-signal-failure", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    payload: createTaskDescriptor({ task_id: "task-signal-failure", task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2 }) });
  await harness.callTool("garden.claim_task", { task_id: "task-signal-failure" });
  const result = await harness.callTool("garden.complete_task", { task_id: "task-signal-failure", status: "completed",
    result_envelope: { candidate_signals: [{ signal_kind: "potential_preference", object_kind: "memory_entry",
      scope_hint: "project", domain_tags: ["garden"], confidence: 0.9, evidence_refs: [], raw_payload: { observation: "preference" } }] } });
  expect(result).toMatchObject({ status: "completed", failed_candidate_signals_count: 1 });
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, candidate_signals_count: 1,
    failed_candidate_signals_count: 1 });
});

it("records failed signal materialization separately from successful in-process extraction", async () => {
  const harness = await createRoutingHarness({ provider_kind: "official_api",
    officialCompile: async () => [createSignal({ signal_id: "candidate" })],
    receiveSignal: async signal => ({ signal: { ...signal, signal_state: "failed" },
      materialization: { success: false, created_objects: [] } }) });
  harness.enqueuePostTurnTask();
  await harness.runScheduler();
  expect(harness.gardenTaskRepo.findById("post-turn-task-1")?.status).toBe("completed");
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, candidate_signals_count: 1,
    failed_candidate_signals_count: 1 });
});
