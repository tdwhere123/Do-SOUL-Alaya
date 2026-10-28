import { afterEach, expect, it, vi } from "vitest";
import { createSourceAdmissionPort, fieldContractSha256 } from "@do-soul/alaya-core";
import { GardenEventType, renderOfficialApiSourceCorpus } from "@do-soul/alaya-protocol";
import { createDaemonFieldRepos } from "../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../runtime/field/sqlite-field-formation-stores.js";
import { cleanupPostTurnExtractHarnesses, createPostTurnPayload, createRoutingHarness } from "../mcp-memory/garden/post-turn-extract-task-fixture.js";

afterEach(cleanupPostTurnExtractHarnesses);

it("does not dispatch a claimed extraction after its retained source is erased", async () => {
  const compile = vi.fn(async () => []);
  const harness = await createRoutingHarness({ provider_kind: "local_heuristics", localCompile: compile });
  const repos = createDaemonFieldRepos({ database: harness.database });
  const admission = createSourceAdmissionPort({ sha256: fieldContractSha256,
    stores: createSqliteFieldFormationStores({ database: harness.database, repos }) });
  const root = admission.admit({ workspace_id: "workspace-1", source_id: "erased-turn", source_version: "1",
    content_bytes: renderOfficialApiSourceCorpus("", createPostTurnPayload().turn_digest.last_messages.map(message => ({
      role: message.role, content: message.content_excerpt
    }))).content, evidence_object_id: null, recorded_at: "2026-05-07T00:00:00.000Z",
    event_time: null, valid_from: null, valid_to: null, spans: [] }).record;
  harness.enqueuePostTurnTask({ payload: createPostTurnPayload({ admitted_source_root_id: root.identity }) });
  const publish = harness.eventPublisher.publish.bind(harness.eventPublisher);
  vi.spyOn(harness.eventPublisher, "publish").mockImplementation(async event => {
    const result = await publish(event);
    if (event.event_type === GardenEventType.SOUL_GARDEN_TASK_DISPATCHED) {
      repos.erase.apply({ barrier_id: "erase-before-dispatch", workspace_id: "workspace-1", generation_id: null,
        subject_kind: "source_record", subject_id: root.identity, erased_at: "2026-05-07T00:05:00.000Z" });
    }
    return result;
  });
  await harness.runScheduler();
  expect(compile).not.toHaveBeenCalled();
  expect(harness.gardenTaskRepo.findById("post-turn-task-1")).toMatchObject({ status: "failed", claimed_by: null });
  expect(harness.gardenTaskRepo.findById("post-turn-task-1")?.payload).not.toHaveProperty("turn_digest");
});
