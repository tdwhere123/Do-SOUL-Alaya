import { describe, expect, it, vi } from "vitest";
import { GardenTaskKind } from "@do-soul/alaya-protocol";
import { runBulkEnrichTask } from "../../garden/bulk-enrich/bulk-enrich-runtime-runner.js";

describe("per-source bulk_enrich routing", () => {
  it("does not claim enrich_pending when the task carries source enrichment identity", async () => {
    const claimBatch = vi.fn(() => []);
    const reportCompletion = vi.fn(async () => undefined);
    await runBulkEnrichTask({
      now: () => "2026-05-31T12:00:00.000Z",
      task: {
        task_id: "source_enrich_fixture",
        task_kind: GardenTaskKind.BULK_ENRICH,
        required_tier: "tier_2",
        workspace_id: "workspace-1",
        run_id: "run-1",
        target_object_refs: ["memory-1"],
        priority: 20,
        created_at: "2026-05-31T12:00:00.000Z",
        source_object_id: "memory-1",
        source_revision: 0,
        enrichment_contract: "source_enrichment.v1"
      },
      availability: {
        kind: "ready",
        ports: {
          enrichPendingRepo: {
            claimBatch,
            markProcessed: vi.fn(),
            recordFailedAttempt: vi.fn(),
            delete: vi.fn(),
            countPending: vi.fn(() => 1)
          },
          memoryLookup: { findById: vi.fn() },
          edgeProducer: { produceForNewMemory: vi.fn() },
          conflictDetection: { detectAndLinkConflicts: vi.fn() },
          signalLookup: { getById: vi.fn() },
          signalRefReplay: { replaySignalRefs: vi.fn() }
        }
      },
      reporter: {
        emitEnrichAbandoned: vi.fn(),
        reportCompletion,
        warn: vi.fn()
      }
    });
    expect(claimBatch).not.toHaveBeenCalled();
    expect(reportCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: "source_enrich_fixture" }),
      "2026-05-31T12:00:00.000Z",
      false,
      ["source_enrich_unwired"],
      expect.any(Error)
    );
  });
});
