import { describe, expect, it } from "vitest";

import { createBootstrappingRecord, createPathRelation, makeReconcileService } from "./workspace-service.test-support.js";

describe("WorkspaceService.reconcileBootstrapPaths", () => {
  it("returns skipped_no_planner when bootstrapping deps are not wired", async () => {
    const harness = makeReconcileService({ withBootstrapping: false });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");
    expect(result).toEqual({
      status: "skipped_no_planner",
      workspace_id: "ws_alpha"
    });
  });

  it("plants seed paths when the workspace has no record and no relations", async () => {
    const planted: string[] = [];
    const seedRecord = createBootstrappingRecord({ workspace_id: "ws_alpha" });
    const seedRelation = createPathRelation({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      pathRelationCreate: (relation) => {
        planted.push(relation.path_id);
      },
      planBootstrap: async () => ({
        relations: [seedRelation],
        record: seedRecord
      })
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "planted",
      workspace_id: "ws_alpha",
      paths_planted: 1,
      record_id: seedRecord.record_id,
      template_ids: seedRecord.template_ids_used
    });
    expect(harness.planner.planBootstrap).toHaveBeenCalledWith("ws_alpha");
    expect(planted).toEqual([seedRelation.path_id]);
    expect(harness.recordRepo.create).toHaveBeenCalledTimes(1);
    expect(harness.appendManyWithMutation).toHaveBeenCalledTimes(1);
  });

  it("skips reconcile when the bootstrapping planner has no templates", async () => {
    const harness = makeReconcileService({
      planBootstrap: async () => ({
        relations: [],
        record: createBootstrappingRecord({
          workspace_id: "ws_alpha",
          paths_planted: 0,
          template_ids_used: []
        })
      })
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "skipped_no_templates",
      workspace_id: "ws_alpha",
      template_ids: []
    });
    expect(harness.planner.planBootstrap).toHaveBeenCalledWith("ws_alpha");
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
    expect(harness.appendManyWithMutation).not.toHaveBeenCalled();
  });

  it("reports corrupt_partial when a record exists without seed relations", async () => {
    const existingRecord = createBootstrappingRecord({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      recordFindByWorkspace: () => existingRecord
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "corrupt_partial",
      workspace_id: "ws_alpha",
      record_id: existingRecord.record_id,
      relation_count: 0,
      reason: "bootstrapping_record_without_relations"
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
  });

  it("treats non-empty path_relations as already_planted even when record is null", async () => {
    // invariant: corrupted state (relations present, record null) must not
    // trigger a second plant — re-planting would create orphan seeds. Operator
    // recovery: either DELETE the orphan relations OR INSERT a synthetic
    // bootstrapping_record covering them, then reconcile is a no-op either way.
    const existingRelation = createPathRelation({ workspace_id: "ws_alpha" });
    const harness = makeReconcileService({
      pathFindByWorkspace: async () => [existingRelation]
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "already_planted",
      workspace_id: "ws_alpha",
      record_id: null,
      relation_count: 1
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
  });

  it("aborts planting when an in-transaction race writes the record first", async () => {
    // @anchor: race-guard mirrors createWithId in-transaction re-check;
    // throws a sentinel so SQLite rolls back the queued plant event.
    const racedRecord = createBootstrappingRecord({
      workspace_id: "ws_alpha",
      record_id: "bootstrap-record-raced"
    });
    let recordPersisted = false;
    const harness = makeReconcileService({
      recordFindByWorkspace: () => (recordPersisted ? racedRecord : null),
      planBootstrap: async () => ({
        relations: [createPathRelation({ workspace_id: "ws_alpha" })],
        record: createBootstrappingRecord({ workspace_id: "ws_alpha" })
      }),
      appendManyWithMutation: async (_events, mutate) => {
        recordPersisted = true;
        mutate([]);
      }
    });

    const result = await harness.service.reconcileBootstrapPaths("ws_alpha");

    expect(result).toEqual({
      status: "corrupt_partial",
      workspace_id: "ws_alpha",
      record_id: racedRecord.record_id,
      relation_count: 0,
      reason: "bootstrapping_record_without_relations"
    });
    expect(harness.pathRepo.create).not.toHaveBeenCalled();
    expect(harness.recordRepo.create).not.toHaveBeenCalled();
  });

  it("rejects reconcile against a non-existent workspace with CoreError NOT_FOUND", async () => {
    const harness = makeReconcileService({
      getById: async () => null
    });

    await expect(harness.service.reconcileBootstrapPaths("ws_missing")).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
    expect(harness.planner.planBootstrap).not.toHaveBeenCalled();
  });

  it("threads causedBy=user_action through the BOOTSTRAPPING_PATHS_PLANTED event", async () => {
    const seenEvents: ReadonlyArray<{ readonly caused_by: string }>[] = [];
    const harness = makeReconcileService({
      appendManyWithMutation: async (events, mutate) => {
        seenEvents.push(events as ReadonlyArray<{ readonly caused_by: string }>);
        mutate([]);
      }
    });

    await harness.service.reconcileBootstrapPaths("ws_alpha", {
      causedBy: "user_action"
    });

    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]).toHaveLength(1);
    expect(seenEvents[0][0].caused_by).toBe("user_action");
  });
});
