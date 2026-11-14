import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());
import { GardenCompleteTaskResponseSchema, GardenEventType, GardenRole, GardenTaskKind, GardenTier,
  SoulGardenTaskCompletedPayloadSchema } from "@do-soul/alaya-protocol";
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
  expect(result).toMatchObject({ status: "completed", outcome: "completed", failed_candidate_signals_count: 1 });
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, outcome: "completed", candidate_signals_count: 1,
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
  expect(result).toMatchObject({ status: "completed", unknown_candidate_signals_count: 1,
    failed_candidate_signals_count: 0, inflight_candidate_signals_count: 0 });
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, unknown_candidate_signals_count: 1,
    failed_candidate_signals_count: 0, inflight_candidate_signals_count: 0 });
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
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, unknown_candidate_signals_count: 1,
    failed_candidate_signals_count: 0, inflight_candidate_signals_count: 0 });
});

it.each(["compiled", "materialized"] as const)("reports measured candidate outcomes for an MCP %s receipt", async state => {
  const harness = await createGardenMcpHarness({ receiveSignal: async signal => ({
    signal: { ...signal, signal_state: state }, triage_result: "accepted", materialization: null
  }) });
  harness.enqueueTask("task-measured", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    payload: createTaskDescriptor({ task_id: "task-measured", task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2 }) });
  await harness.callTool("garden.claim_task", { task_id: "task-measured" });
  const result = await harness.callTool("garden.complete_task", { task_id: "task-measured", status: "completed",
    result_envelope: { candidate_signals: [{ signal_kind: "potential_preference", object_kind: "memory_entry",
      scope_hint: "project", domain_tags: ["garden"], confidence: 0.9, evidence_refs: [], raw_payload: { observation: "preference" } }] } });
  const expected = { failed_candidate_signals_count: 0, unknown_candidate_signals_count: 0,
    inflight_candidate_signals_count: state === "compiled" ? 1 : 0 };
  expect(result).toMatchObject(expected);
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject(expected);
});

it("reports measured zeros when a fresh completion emits no candidates", async () => {
  const harness = await createGardenMcpHarness();
  harness.enqueueTask("task-empty", { role: GardenRole.LIBRARIAN, kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    payload: createTaskDescriptor({ task_id: "task-empty", task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
      required_tier: GardenTier.TIER_2 }) });
  await harness.callTool("garden.claim_task", { task_id: "task-empty" });
  const result = await harness.callTool("garden.complete_task", { task_id: "task-empty", status: "completed" });
  const expected = { failed_candidate_signals_count: 0, unknown_candidate_signals_count: 0, inflight_candidate_signals_count: 0 };
  expect(result).toMatchObject(expected);
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ candidate_signals_count: 0, ...expected });
});

it("reports a live attempt in in-process statement completion", async () => {
  const harness = await createRoutingHarness({ provider_kind: "official_api",
    officialExtract: recordedStatementExtract(message => message.role === "user"
      ? [{ text: "A recorded statement.", relation: "recorded" }] : []),
    receiveSignal: async signal => ({ signal: { ...signal, signal_state: "compiled" },
      triage_result: "deferred", materialization: null }) });
  await harness.captureTurn();
  harness.advance(STATEMENT_SESSION_IDLE_MS);
  await harness.runScheduler();
  const events = (await harness.eventLogRepo.queryByType(GardenEventType.SOUL_GARDEN_TASK_COMPLETED)).events;
  expect(events.at(-1)?.payload_json).toMatchObject({ success: true, inflight_candidate_signals_count: 1,
    unknown_candidate_signals_count: 0, failed_candidate_signals_count: 0 });
});

it("keeps legacy absent outcome counts absent rather than inventing zeros", () => {
  const response = GardenCompleteTaskResponseSchema.parse({ task_id: "legacy", status: "completed", events_appended: 1 });
  expect(response).not.toHaveProperty("inflight_candidate_signals_count");
  expect(response).not.toHaveProperty("failed_candidate_signals_count");
  const payload = SoulGardenTaskCompletedPayloadSchema.parse({ task_id: "legacy", task_kind: GardenTaskKind.PATH_PLASTICITY_UPDATE,
    role: GardenRole.LIBRARIAN, tier: GardenTier.TIER_2, success: true, objects_affected: [], workspace_id: "workspace-1",
    occurred_at: "2026-01-01T00:00:00.000Z" });
  expect(payload).not.toHaveProperty("inflight_candidate_signals_count");
  expect(payload).not.toHaveProperty("unknown_candidate_signals_count");
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
