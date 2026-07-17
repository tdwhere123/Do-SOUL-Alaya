import { describe, expect, it, vi } from "vitest";
import {
  GardenTaskKind,
  GardenTier,
  type GardenTaskDescriptor,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import { JANITOR_CONSTANTS, Janitor } from "../../garden/janitor.js";

describe("Janitor GC task kinds", () => {
  it("runs dormant demotion through its port and reports completion", async () => {
    const dormantDemotionPort = {
      findLowActivityActiveMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      setLifecycleDormant: vi.fn(async () => "demoted" as const)
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      dormantDemotionPort,
      scheduler,
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask(GardenTaskKind.DORMANT_DEMOTION));

    expect(dormantDemotionPort.findLowActivityActiveMemories).toHaveBeenCalledWith("workspace-1");
    expect(dormantDemotionPort.setLifecycleDormant).toHaveBeenCalledTimes(2);
    expect(result.audit_entries).toEqual(["dormant_demotion: 2 memories transitioned to lifecycle_state=dormant"]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  // invariant (I-1): the candidate snapshot can go stale before a candidate's
  // turn (concurrent revival / overlapping sweep / Inspector retire). A "skipped"
  // outcome (guarded 0-row, no audit, no throw) must NOT abort the batch and must
  // NOT be counted in objects_affected, so the result stays a truthful success.
  it("dormant demotion tolerates a candidate that is no longer active without aborting the batch", async () => {
    const setLifecycleDormant = vi
      .fn<(memoryId: string, taskId: string) => Promise<"demoted" | "skipped">>()
      .mockResolvedValueOnce("demoted")
      .mockResolvedValueOnce("skipped");
    const dormantDemotionPort = {
      findLowActivityActiveMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      setLifecycleDormant
    };
    const scheduler = {
      reportCompletion: vi.fn(async () => undefined)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      dormantDemotionPort,
      scheduler,
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask(GardenTaskKind.DORMANT_DEMOTION));

    expect(setLifecycleDormant).toHaveBeenCalledTimes(2);
    // The batch COMPLETES as a success: it reports ONLY the demoted candidate in
    // objects_affected, not the racy one, and is not a failure result.
    expect(result.success).toBe(true);
    expect(result.error_message).toBeNull();
    expect(result.objects_affected).toEqual(["memory-1"]);
    expect(result.audit_entries).toEqual([
      "dormant_demotion: 1 memories transitioned to lifecycle_state=dormant (1 skipped: no longer active)"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("runs tombstone gc through its port and respects batch size", async () => {
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(
        async () =>
          Array.from({ length: JANITOR_CONSTANTS.BATCH_SIZE + 3 }, (_, index) => ({
            memory_id: `memory-${index + 1}`
          }))
      ),
      hardDelete: vi.fn(async () => true)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      scheduler: {
        reportCompletion: vi.fn(async () => undefined)
      },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledTimes(JANITOR_CONSTANTS.BATCH_SIZE);
    expect(result.objects_affected).toHaveLength(JANITOR_CONSTANTS.BATCH_SIZE);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] tombstone_gc: disposition sweep port not wired",
      `tombstone_gc: ${JANITOR_CONSTANTS.BATCH_SIZE} tombstoned memories hard-deleted`
    ]);
  });

  it("completes an intentional S4 physical-GC deferral without calling a delete port", async () => {
    const legacyTombstoneGcPort = {
      findTombstonedMemories: vi.fn(async () => [{ memory_id: "memory-legacy" }]),
      hardDelete: vi.fn(async () => true)
    };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcDeferredReason: "temporal_assertion_provenance_required",
      scheduler,
      now: () => "2026-07-17T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask(GardenTaskKind.TOMBSTONE_GC));

    expect(legacyTombstoneGcPort.findTombstonedMemories).not.toHaveBeenCalled();
    expect(legacyTombstoneGcPort.hardDelete).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] tombstone_gc: disposition sweep port not wired",
      "[DEFERRED] tombstone_gc: temporal_assertion_provenance_required"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  it("skips tombstone gc deletions for strong-ref protected memories", async () => {
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      hardDelete: vi.fn(async () => true)
    };
    const strongRefProtectionPort = {
      isProtected: vi.fn(async (_workspaceId: string, _targetEntityType: string, targetEntityId: string) => targetEntityId === "memory-1")
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      strongRefProtectionPort,
      scheduler: {
        reportCompletion: vi.fn(async () => undefined)
      },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(strongRefProtectionPort.isProtected).toHaveBeenCalledTimes(2);
    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledTimes(1);
    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledWith("memory-2", "task-1");
    expect(result.objects_affected).toEqual(["memory-2"]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] tombstone_gc: disposition sweep port not wired",
      "[SKIPPED] tombstone_gc: memory-1 protected by strong ref",
      "tombstone_gc: 1 tombstoned memories hard-deleted"
    ]);
  });

  it("counts only physically-deleted rows; a refused (preservation-revoked) row is excluded and reported", async () => {
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(async () => [{ memory_id: "memory-1" }, { memory_id: "memory-2" }]),
      // memory-2 refuses (B1 preservation_revoked): hardDelete resolves false.
      hardDelete: vi.fn(async (memoryId: string) => memoryId !== "memory-2")
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      scheduler: {
        reportCompletion: vi.fn(async () => undefined)
      },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(tombstoneGcPort.hardDelete).toHaveBeenCalledTimes(2);
    expect(result.objects_affected).toEqual(["memory-1"]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] tombstone_gc: disposition sweep port not wired",
      "tombstone_gc: 1 tombstoned memories hard-deleted (1 refused: preservation revoked)"
    ]);
  });

  it("disposition sweep tombstones only dormant rows the gate cleared, never a null-disposition row", async () => {
    const dispositionSweepPort = {
      findDormantDispositionCandidates: vi.fn(async () => [
        { memory_id: "memory-compressed", disposition: "compressed" as const, disposition_ref: "capsule-1" },
        { memory_id: "memory-useless", disposition: "judged_useless" as const, disposition_ref: null },
        // No disposition: preserved-or-judged gate failed. MUST be retained.
        { memory_id: "memory-kept", disposition: null, disposition_ref: null }
      ]),
      autonomousTombstone: vi.fn(async () => ({ status: "tombstoned" }) as const)
    };
    const tombstoneGcPort = {
      findTombstonedMemories: vi.fn(async () => []),
      hardDelete: vi.fn(async () => true)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort,
      dispositionSweepPort,
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(dispositionSweepPort.autonomousTombstone).toHaveBeenCalledTimes(2);
    expect(dispositionSweepPort.autonomousTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ memory_id: "memory-kept" }),
      expect.anything()
    );
    expect(result.objects_affected).toEqual(["memory-compressed", "memory-useless"]);
    expect(result.audit_entries).toEqual([
      "disposition_sweep: 2 dormant memories autonomously tombstoned (1 retained, no disposition or strong ref)",
      "tombstone_gc: 0 tombstoned memories hard-deleted"
    ]);
  });

  it("disposition sweep tombstones nothing when every dormant candidate failed the gate", async () => {
    const dispositionSweepPort = {
      findDormantDispositionCandidates: vi.fn(async () => [
        { memory_id: "memory-a", disposition: null, disposition_ref: null },
        { memory_id: "memory-b", disposition: null, disposition_ref: null }
      ]),
      autonomousTombstone: vi.fn(async () => ({ status: "tombstoned" }) as const)
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort: {
        findTombstonedMemories: vi.fn(async () => []),
        hardDelete: vi.fn(async () => true)
      },
      dispositionSweepPort,
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(dispositionSweepPort.autonomousTombstone).not.toHaveBeenCalled();
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual([
      "disposition_sweep: 0 dormant memories autonomously tombstoned (2 retained, no disposition or strong ref)",
      "tombstone_gc: 0 tombstoned memories hard-deleted"
    ]);
  });

  it("disposition sweep skips a dormant candidate the strong-ref protection port protects", async () => {
    const dispositionSweepPort = {
      findDormantDispositionCandidates: vi.fn(async () => [
        { memory_id: "memory-protected", disposition: "judged_useless" as const, disposition_ref: null },
        { memory_id: "memory-free", disposition: "judged_useless" as const, disposition_ref: null }
      ]),
      autonomousTombstone: vi.fn(async () => ({ status: "tombstoned" }) as const)
    };
    const strongRefProtectionPort = {
      isProtected: vi.fn(
        async (_workspaceId: string, _targetEntityType: string, targetEntityId: string) =>
          targetEntityId === "memory-protected"
      )
    };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort: {
        findTombstonedMemories: vi.fn(async () => []),
        hardDelete: vi.fn(async () => true)
      },
      dispositionSweepPort,
      strongRefProtectionPort,
      scheduler: { reportCompletion: vi.fn(async () => undefined) },
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    expect(dispositionSweepPort.autonomousTombstone).toHaveBeenCalledTimes(1);
    expect(dispositionSweepPort.autonomousTombstone).not.toHaveBeenCalledWith(
      expect.objectContaining({ memory_id: "memory-protected" }),
      expect.anything()
    );
    expect(result.objects_affected).toEqual(["memory-free"]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] disposition_sweep: memory-protected protected by strong ref",
      "disposition_sweep: 1 dormant memories autonomously tombstoned (1 retained, no disposition or strong ref)",
      "tombstone_gc: 0 tombstoned memories hard-deleted"
    ]);
  });

  // invariant: a disposition candidate can go stale between selection and its turn
  // (concurrent revival / Inspector pin). The tombstone authority refuses such a
  // row as a benign concurrent-mutation race, which the daemon adapter resolves as
  // { status: "skipped" }. The sweep must CONTINUE so one racy candidate cannot
  // abort the batch nor erase the in-batch audit trail of rows already tombstoned.
  it("disposition sweep tolerates a candidate the authority refuses as a benign race without aborting the batch", async () => {
    const autonomousTombstone = vi
      .fn<(candidate: { memory_id: string }, taskId: string) => Promise<{ status: "tombstoned" } | { status: "skipped"; reason: string }>>()
      .mockResolvedValueOnce({ status: "tombstoned" })
      .mockResolvedValueOnce({ status: "skipped", reason: "no longer dormant (concurrent revival)" });
    const dispositionSweepPort = {
      findDormantDispositionCandidates: vi.fn(async () => [
        { memory_id: "memory-1", disposition: "judged_useless" as const, disposition_ref: null },
        { memory_id: "memory-2", disposition: "judged_useless" as const, disposition_ref: null }
      ]),
      autonomousTombstone
    };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort: {
        findTombstonedMemories: vi.fn(async () => []),
        hardDelete: vi.fn(async () => true)
      },
      dispositionSweepPort,
      scheduler,
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    // The batch COMPLETES as a success: the 1st candidate is still tombstoned, the
    // racy 2nd is recorded skipped (its in-batch audit trail survives), and the
    // result is not a failure.
    expect(autonomousTombstone).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.error_message).toBeNull();
    expect(result.objects_affected).toEqual(["memory-1"]);
    expect(result.audit_entries).toEqual([
      "[SKIPPED] disposition_sweep: memory-2 no longer dormant (concurrent revival)",
      "disposition_sweep: 1 dormant memories autonomously tombstoned (1 retained, no disposition or strong ref)",
      "tombstone_gc: 0 tombstoned memories hard-deleted"
    ]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });

  // invariant: a GENUINE (non-TOCTOU) error from the tombstone authority is NOT a
  // skip. It must propagate loud to run()'s failure path, aborting the batch — the
  // skip-and-continue path is strictly the benign concurrent-mutation race.
  it("disposition sweep lets a genuine tombstone error fail the batch loud", async () => {
    const dispositionSweepPort = {
      findDormantDispositionCandidates: vi.fn(async () => [
        { memory_id: "memory-1", disposition: "judged_useless" as const, disposition_ref: null },
        { memory_id: "memory-2", disposition: "judged_useless" as const, disposition_ref: null }
      ]),
      autonomousTombstone: vi
        .fn<(candidate: { memory_id: string }, taskId: string) => Promise<{ status: "tombstoned" }>>()
        .mockResolvedValueOnce({ status: "tombstoned" })
        .mockRejectedValueOnce(new Error("storage write failed"))
    };
    const scheduler = { reportCompletion: vi.fn(async () => undefined) };
    const janitor = new Janitor({
      cleanupPort: {
        findExpiredObjects: vi.fn(async () => []),
        removeExpiredObjects: vi.fn(async () => undefined)
      },
      tieringPort: {
        findHotDemotionCandidates: vi.fn(async () => []),
        demoteToWarm: vi.fn(async () => undefined)
      },
      tombstoneGcPort: {
        findTombstonedMemories: vi.fn(async () => []),
        hardDelete: vi.fn(async () => true)
      },
      dispositionSweepPort,
      scheduler,
      now: () => "2026-03-28T00:00:00.000Z"
    } as ConstructorParameters<typeof Janitor>[0]);

    const result = await janitor.run(createTask("tombstone_gc"));

    // The genuine error aborts the batch: a failure result, empty objects_affected
    // and audit_entries (the partial in-batch audit is discarded on the failure
    // path), and the error surfaced in error_message.
    expect(result.success).toBe(false);
    expect(result.error_message).toBe("storage write failed");
    expect(result.objects_affected).toEqual([]);
    expect(result.audit_entries).toEqual([]);
    expect(scheduler.reportCompletion).toHaveBeenCalledWith(result);
  });
});

function createTask(taskKind: GardenTaskKindValue | "tombstone_gc"): GardenTaskDescriptor {
  return {
    task_id: "task-1",
    task_kind: taskKind as GardenTaskKindValue,
    required_tier: GardenTier.TIER_0,
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: [],
    priority: 10,
    created_at: "2026-03-28T00:00:00.000Z"
  };
}
