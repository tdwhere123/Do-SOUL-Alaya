import { describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceRunEventType } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo } from "../../../repos/runtime/event-log-repo.js";
import type { EventLogAppendInput } from "../../../repos/runtime/event-log-types.js";
import { createEventLogRepos, registerEventLogRepoCleanup } from "./event-log-repo.test-support.js";

registerEventLogRepoCleanup();
const event: EventLogAppendInput = {
  event_type: WorkspaceRunEventType.WORKSPACE_CREATED,
  entity_type: "workspace", entity_id: "async-workspace", workspace_id: "ws_events",
  run_id: null, caused_by: "user_action",
  payload_json: { workspace_id: "async-workspace", name: "async", workspace_kind: WorkspaceKind.LOCAL_REPO }
};

describe("EventLog synchronous transaction boundary", () => {
  it("rejects native async callbacks before their body starts", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    let started = false;
    expect(() => eventLogRepo.transactional(async () => {
      started = true;
      await Promise.resolve();
      eventLogRepo.append(event);
    })).toThrow(/must be synchronous/);
    await Promise.resolve();
    expect(started).toBe(false);
    expect(await eventLogRepo.queryByEntity("workspace", event.entity_id)).toEqual([]);
  });

  it("rolls back the prefix and denies a Promise-returning callback's late append across repo instances", async () => {
    const { database, eventLogRepo } = await createEventLogRepos();
    const otherRepo = new SqliteEventLogRepo(database);
    let continuation: Promise<unknown> | undefined;
    expect(() => eventLogRepo.transactional(() => {
      eventLogRepo.append(event);
      continuation = Promise.resolve().then(() => otherRepo.append(event));
      return continuation;
    })).toThrow(/must not return a Promise/);
    await expect(continuation).rejects.toThrow(/must not continue asynchronously/);
    expect(await eventLogRepo.queryByEntity("workspace", event.entity_id)).toEqual([]);
    await eventLogRepo.append(event);
    expect(await eventLogRepo.queryByEntity("workspace", event.entity_id)).toHaveLength(1);
  });

  it("prevents delayed deletion and nested transactions from escaping a completed scope", async () => {
    const { eventLogRepo } = await createEventLogRepos();
    const existing = await eventLogRepo.append(event);
    let deletion: Promise<unknown> | undefined;
    let nested: Promise<unknown> | undefined;
    eventLogRepo.transactional(() => {
      deletion = Promise.resolve().then(() => eventLogRepo.deleteById(existing.event_id));
      nested = Promise.resolve().then(() => eventLogRepo.transactional(() => eventLogRepo.append(event)));
    });
    await expect(deletion).rejects.toThrow(/must not continue asynchronously/);
    await expect(nested).rejects.toThrow(/must not continue asynchronously/);
    expect(await eventLogRepo.queryByEntity("workspace", event.entity_id)).toHaveLength(1);
  });
});
