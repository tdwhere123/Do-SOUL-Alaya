import { afterEach, expect, it, vi } from "vitest";
import { GardenEventType, GardenTaskKind } from "@do-soul/alaya-protocol";
import { createDaemonFieldRepos } from "../../runtime/field/field-repos.js";
import { STATEMENT_SESSION_IDLE_MS } from "../../garden/statement-session/statement-session-closure.js";
import {
  cleanupPostTurnExtractHarnesses, createRoutingHarness, recordedStatementExtract
} from "../mcp-memory/garden/post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("does not extract a claimed statement session after its member root is erased", async () => {
  const extract = recordedStatementExtract();
  const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localExtract: extract });
  const repos = createDaemonFieldRepos({ database: harness.database });
  harness.enqueuePostTurnTask();
  await harness.runScheduler();
  harness.advance(STATEMENT_SESSION_IDLE_MS);
  const rootId = (harness.gardenTaskRepo.findById("post-turn-task-1")!.payload as { admitted_source_root_id: string })
    .admitted_source_root_id;
  const publish = harness.eventPublisher.publish.bind(harness.eventPublisher);
  vi.spyOn(harness.eventPublisher, "publish").mockImplementation(async event => {
    const result = await publish(event);
    if (event.event_type === GardenEventType.SOUL_GARDEN_TASK_DISPATCHED
      && (event.payload_json as { task_kind?: string }).task_kind === GardenTaskKind.SOURCE_STATEMENT_SESSION) {
      repos.erase.apply({ barrier_id: "erase-before-dispatch", workspace_id: "workspace-1", generation_id: null,
        subject_kind: "source_record", subject_id: rootId, erased_at: "2026-05-07T00:05:00.000Z" });
    }
    return result;
  });
  await harness.runScheduler();
  expect(extract).not.toHaveBeenCalled();
  expect(harness.sessionTasks()).toEqual([expect.objectContaining({ status: "failed", claimed_by: null })]);
  expect(harness.gardenTaskRepo.findById("post-turn-task-1")?.payload).not.toHaveProperty("turn_digest");
  expect(harness.database.connection.prepare("SELECT count(*) AS count FROM signals").get()).toEqual({ count: 0 });
});
