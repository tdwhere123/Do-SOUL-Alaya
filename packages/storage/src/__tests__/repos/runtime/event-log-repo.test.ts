import { expect, it } from "vitest";
import {
GreenGovernanceEventType,
RevokeReason,
StreamingEventType,
WorkspaceRunEventType,
RunMode} from "@do-soul/alaya-protocol";
import {
appendAppliedOverride,
appendEngineResponseEvent,
appendMalformedAppliedOverride,
appendNarrativeConsolidationTrigger,
appendPromotedOverride,
appendRunCreatedEvent,
appendRunMessageEvent,
appendWorkspaceLifecycleEvent,
createEventLogRepos,
registerEventLogRepoCleanup
} from "./event-log-repo.test-support.js";

registerEventLogRepoCleanup();

it("append generates a unique event_id and created_at", async () => {
  const { eventLogRepo } = await createEventLogRepos();

  const event = await appendWorkspaceLifecycleEvent(eventLogRepo, {
    workspaceId: "ws_events",
    name: "events"
  });

  expect(event.event_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  expect(event.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

it("queryByRun returns only matching run events", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendRunCreatedEvent(eventLogRepo, {
    entityId: "run_target",
    title: "target"
  });
  await appendRunCreatedEvent(eventLogRepo, {
    entityId: "run_other",
    runMode: RunMode.BUILD,
    title: "other"
  });

  const events = await eventLogRepo.queryByRun("run_target");

  expect(events).toHaveLength(1);
  expect(events[0]?.run_id).toBe("run_target");
});

it("queryByRunPage preserves full-history ordering while allowing bounded windows", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  for (const suffix of ["a", "b", "c"]) {
    await appendRunCreatedEvent(eventLogRepo, {
      entityId: `run-${suffix}`,
      runId: "run_target",
      title: suffix
    });
  }

  await expect(eventLogRepo.queryByRun("run_target")).resolves.toHaveLength(3);
  await expect(eventLogRepo.queryByRunPage?.("run_target", { limit: 1, offset: 1 })).resolves.toMatchObject([
    { entity_id: "run-b" }
  ]);
});

it("queryByRun defaults to the repository page cap and queryByRunAll is the explicit full-history path", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  for (let index = 0; index < 501; index += 1) {
    await appendRunCreatedEvent(eventLogRepo, {
      entityId: `run-cap-${index}`,
      runId: "run_cap",
      title: `run ${index}`
    });
  }

  await expect(eventLogRepo.queryByRun("run_cap")).resolves.toHaveLength(500);
  await expect(eventLogRepo.queryByRunAll("run_cap")).resolves.toHaveLength(501);
  await expect(eventLogRepo.queryByRunPage("run_cap", { limit: 501, offset: 0 })).rejects.toMatchObject({
    code: "VALIDATION_FAILED"
  });
});

it("paginates conversation message events by run with a separate count", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendRunMessageEvent(eventLogRepo, {
    entityId: "msg-1",
    runId: "run_target",
    messageId: "msg-1",
    content: "hello",
    entityType: "message"
  });
  await appendRunCreatedEvent(eventLogRepo, {
    entityId: "run_target",
    title: "target"
  });
  await appendEngineResponseEvent(eventLogRepo, {
    entityId: "msg-2",
    runId: "run_target",
    messageId: "msg-2",
    content: "hi",
    entityType: "message",
    causedBy: "assistant"
  });
  await eventLogRepo.append({
    event_type: StreamingEventType.MESSAGE_COMPLETED,
    entity_type: "message",
    entity_id: "msg-3",
    workspace_id: "ws_events",
    run_id: "run_target",
    caused_by: "assistant",
    payload_json: {
      type: StreamingEventType.MESSAGE_COMPLETED,
      runId: "run_target",
      messageId: "msg-3",
      content: "streamed",
      finishReason: "stop",
      timestamp: "2026-03-21T00:00:03.000Z"
    }
  });

  const page = await eventLogRepo.queryConversationMessageEventsByRun("run_target", {
    limit: 1,
    offset: 1
  });

  expect(page.map((event) => event.entity_id)).toEqual(["msg-2"]);
  await expect(eventLogRepo.countConversationMessageEventsByRun("run_target")).resolves.toBe(3);
});

it("answers narrative and override live predicates without full-history reads", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendNarrativeConsolidationTrigger(eventLogRepo, "run_narrative", 7);
  await appendAppliedOverride(eventLogRepo, "override-a", "run-1");
  await appendAppliedOverride(eventLogRepo, "override-b", "run-2");
  await appendMalformedAppliedOverride(eventLogRepo, "override-malformed", "run-3");
  await appendPromotedOverride(eventLogRepo, "override-complete");

  await expect(eventLogRepo.hasNarrativeConsolidationTrigger("run_narrative", 7)).resolves.toBe(true);
  await expect(eventLogRepo.hasNarrativeConsolidationTrigger("run_narrative", 8)).resolves.toBe(false);
  await expect(eventLogRepo.hasSessionOverridePromotion("override-complete")).resolves.toBe(true);
  await expect(
    eventLogRepo.countDistinctAppliedSessionOverrideRuns({
      workspaceId: "ws_events",
      targetObject: " memory:BUILD-style ",
      correction: " use PNPM instead of NPM. "
    })
  ).resolves.toBe(2);
});

it("answers Green open-correction and security-hit predicates from SQL", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendAppliedOverride(eventLogRepo, "override-open", "run-1");
  await eventLogRepo.append({
    event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
    entity_type: "green_status",
    entity_id: "green-security",
    workspace_id: "ws_events",
    run_id: "run-1",
    caused_by: "system",
    payload_json: {
      object_id: "green-security",
      target_object_id: "memory:build-style",
      revoke_reason: RevokeReason.SECURITY_HIT,
      workspace_id: "ws_events",
      occurred_at: "2026-03-24T00:00:00.000Z"
    }
  });

  await expect(
    eventLogRepo.hasOpenSessionOverrideCorrection({
      workspaceId: "ws_events",
      targetObjectId: "memory:build-style",
      nowIso: "2026-03-24T00:30:00.000Z"
    })
  ).resolves.toBe(true);
  await expect(
    eventLogRepo.hasSecurityHitForTarget({
      workspaceId: "ws_events",
      targetObjectId: "memory:build-style"
    })
  ).resolves.toBe(true);
});

it("queryByEntity returns only matching entity events", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendWorkspaceLifecycleEvent(eventLogRepo, {
    workspaceId: "ws_match",
    name: "match"
  });
  await appendWorkspaceLifecycleEvent(eventLogRepo, {
    workspaceId: "ws_other",
    name: "other"
  });

  const events = await eventLogRepo.queryByEntity("workspace", "ws_match");

  expect(events).toHaveLength(1);
  expect(events[0]?.entity_id).toBe("ws_match");
});

it("queryByEntityPage preserves full history while exposing a bounded entity slice", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  for (const eventType of [
    WorkspaceRunEventType.WORKSPACE_CREATED,
    WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED,
    WorkspaceRunEventType.WORKSPACE_DELETED
  ]) {
    await appendWorkspaceLifecycleEvent(eventLogRepo, {
      workspaceId: "ws_paged",
      eventType,
      name: "paged"
    });
  }

  await expect(eventLogRepo.queryByEntity("workspace", "ws_paged")).resolves.toHaveLength(3);
  await expect(eventLogRepo.queryByEntityPage?.("workspace", "ws_paged", { limit: 1, offset: 1 })).resolves.toMatchObject([
    { event_type: WorkspaceRunEventType.WORKSPACE_ENGINE_BINDING_UPDATED }
  ]);
});

it("queryByType returns only matching event types", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendWorkspaceLifecycleEvent(eventLogRepo, {
    workspaceId: "ws_type",
    name: "type"
  });
  await appendRunCreatedEvent(eventLogRepo, {
    entityId: "run_type",
    workspaceId: "ws_type",
    runMode: RunMode.REVIEW,
    title: "type"
  });

  const events = await eventLogRepo.queryByType(WorkspaceRunEventType.RUN_CREATED);

  expect(events).toHaveLength(1);
  expect(events[0]?.event_type).toBe(WorkspaceRunEventType.RUN_CREATED);
});

it("returns multiple matching events in append order", async () => {
  const { eventLogRepo } = await createEventLogRepos();
  await appendRunMessageEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_1",
    content: "hello"
  });
  await appendEngineResponseEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_2",
    content: "world"
  });

  const events = await eventLogRepo.queryByRun("run_order");

  expect(events).toHaveLength(2);
  expect(events.map((event) => event.event_type)).toEqual([
    WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
    WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED
  ]);
});

it("queryByRunAfterEventId returns only events after the target event ID", async () => {
  const { eventLogRepo } = await createEventLogRepos();

  const first = await appendRunMessageEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_1",
    content: "first"
  });
  await appendRunMessageEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_2",
    content: "second"
  });
  await appendEngineResponseEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_3",
    content: "third"
  });

  const events = await eventLogRepo.queryByRunAfterEventId("run_order", first.event_id);

  expect(events).toHaveLength(2);
  expect(events.map((event) => event.revision)).toEqual([1, 2]);
});

it("queryByRunAfterEventId returns all run events when the target ID is missing", async () => {
  const { eventLogRepo } = await createEventLogRepos();

  await appendRunMessageEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_1",
    content: "hello"
  });
  await appendEngineResponseEvent(eventLogRepo, {
    entityId: "run_order",
    runId: "run_order",
    messageId: "msg_2",
    content: "world"
  });

  const events = await eventLogRepo.queryByRunAfterEventId("run_order", "evt_missing");

  expect(events).toHaveLength(2);
});
