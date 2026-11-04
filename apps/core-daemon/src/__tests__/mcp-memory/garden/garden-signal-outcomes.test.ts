import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());
import { GardenEventType, GardenRole, GardenTaskKind, GardenTier } from "@do-soul/alaya-protocol";
import { cleanupGardenMcpHarnesses, createGardenMcpHarness, createTaskDescriptor } from "./garden-mcp-tools-fixture.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../../garden/statement-session/statement-session-closure.js";
import { cleanupGardenRoutingHarnesses, createRoutingHarness, recordedStatementExtract } from "./garden-routing-fixture.js";

afterEach(async () => { await cleanupGardenMcpHarnesses(); cleanupGardenRoutingHarnesses(); });

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

it("reports unknown candidate effects separately from failed candidates through MCP task completion", async () => {
  const harness = await createGardenMcpHarness({ receiveSignal: async signal => ({
    signal: { ...signal, signal_state: "materialization_unknown" }, triage_result: "unknown", materialization: null
  }) });
  harness.enqueueTask("task-signal-unknown", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    payload: createTaskDescriptor({ task_id: "task-signal-unknown", task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2 }) });
  await harness.callTool("garden.claim_task", { task_id: "task-signal-unknown" });
  const result = await harness.callTool("garden.complete_task", { task_id: "task-signal-unknown", status: "completed",
    result_envelope: { candidate_signals: [{ signal_kind: "potential_preference", object_kind: "memory_entry",
      scope_hint: "project", domain_tags: ["garden"], confidence: 0.9, evidence_refs: [], raw_payload: { observation: "preference" } }] } });
  expect(result).toMatchObject({ status: "completed", unknown_candidate_signals_count: 1 });
  expect(result).not.toHaveProperty("failed_candidate_signals_count");
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, unknown_candidate_signals_count: 1 });
  expect(events.at(-1)?.payload_json).not.toHaveProperty("failed_candidate_signals_count");
});

it("reports unknown candidate effects in the in-process statement completion audit", async () => {
  const harness = await createRoutingHarness({ provider_kind: "official_api",
    officialExtract: recordedStatementExtract(message => message.role === "user"
      ? [{ text: "A recorded statement.", relation: "recorded" }] : []),
    receiveSignal: async signal => ({ signal: { ...signal, signal_state: "materialization_unknown" },
      triage_result: "unknown", materialization: null }) });
  await harness.captureTurn();
  harness.advance(STATEMENT_SESSION_IDLE_MS);
  await harness.runScheduler();
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, unknown_candidate_signals_count: 1 });
  expect(events.at(-1)?.payload_json).not.toHaveProperty("failed_candidate_signals_count");
});

it("records failed signal materialization separately from successful in-process statement extraction", async () => {
  const harness = await createRoutingHarness({ provider_kind: "official_api",
    officialExtract: recordedStatementExtract(message => message.role === "user"
      ? [{ text: "A recorded statement.", relation: "recorded" }] : []),
    receiveSignal: async signal => ({ signal: { ...signal, signal_state: "failed" },
      materialization: { success: false, created_objects: [] } }) });
  await harness.captureTurn();
  harness.advance(STATEMENT_SESSION_IDLE_MS);
  await harness.runScheduler();
  expect(harness.sessionTasks()[0]?.status).toBe("completed");
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, candidate_signals_count: 1,
    failed_candidate_signals_count: 1 });
});
