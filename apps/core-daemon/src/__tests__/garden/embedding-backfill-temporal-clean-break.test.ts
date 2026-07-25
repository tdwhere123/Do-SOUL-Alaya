import { describe, expect, it, vi } from "vitest";
import { GardenTaskKind, GardenTier, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import {
  AnswersWithEdgeProducerService,
  CoherenceEdgeProducerService
} from "@do-soul/alaya-core";
import { SqlitePathRelationRepo, initDatabase } from "@do-soul/alaya-storage";

import { createEmbeddingBackfillRuntimeSupport } from "../../garden/scheduler-runtime-maintenance.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler-runtime-types.js";
import { createGardenLegacyPathCandidateRejectionPort } from "../../runtime/garden-legacy-path-admission.js";

const BACKFILL_TASK: GardenTaskDescriptor = {
  task_id: "embedding-backfill-s4",
  task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
  required_tier: GardenTier.TIER_2,
  workspace_id: "workspace-1",
  run_id: null,
  target_object_refs: ["workspace-1"],
  priority: 10,
  created_at: "2026-07-17T00:00:00.000Z"
};

function createHarness(legacyTopologyMutationsEnabled: boolean | undefined) {
  const warn = vi.fn();
  const rejectionPort = createGardenLegacyPathCandidateRejectionPort(warn);
  const submitCandidate = vi.fn(rejectionPort.submitCandidate);
  const coherentPairKeys = vi.fn(async () => new Set(["memory-1|memory-2"]));
  const answerCoRelevantPairKeys = vi.fn(async () => new Set(["memory-1|memory-2"]));
  const objects = [
    { objectId: "memory-1", sessionId: "run-1", formationKey: "2026-07-17T00:00:00.000Z" },
    { objectId: "memory-2", sessionId: "run-2", formationKey: "2026-07-17T00:01:00.000Z" }
  ];
  const coherence = new CoherenceEdgeProducerService({
    pairSource: { coherentPairKeys },
    mintPort: { submitCandidate },
    warn
  });
  const answersWith = new AnswersWithEdgeProducerService({
    pairSource: { answerCoRelevantPairKeys },
    mintPort: { submitCandidate },
    warn
  });
  const completions: unknown[] = [];
  const support = createEmbeddingBackfillRuntimeSupport({
    embeddingBackfillHandler: {
      handle: vi.fn(async () => ({
        objectsAffected: ["memory-1", "memory-2"],
        auditEntries: ["embedding_backfill:2"]
      }))
    },
    legacyTopologyMutationsEnabled,
    coherenceEdgeProducerPort: {
      crystallizeForBackfill: async ({ workspaceId, runId }) =>
        await coherence.crystallize({
          workspaceId,
          runId,
          objects,
          floor: 0.6,
          capPerNode: 3,
          crossSessionOnly: false
        })
    },
    answersWithEdgeProducerPort: {
      crystallizeForBackfill: async ({ workspaceId, runId }) =>
        await answersWith.crystallize({
          workspaceId,
          runId,
          objects,
          bar: 0.1,
          capPerNode: 3,
          crossSessionOnly: false
        })
    },
    gardenScheduler: {
      enqueue: vi.fn(),
      reportCompletion: vi.fn(async (result) => {
        completions.push(result);
      })
    },
    warn
  } as unknown as CreateGardenSchedulerRuntimeSupportInput);
  return {
    support,
    completions,
    warn,
    submitCandidate,
    coherentPairKeys,
    answerCoRelevantPairKeys
  };
}

describe("Garden EMBEDDING_BACKFILL temporal clean break", () => {
  it.each([
    ["undefined", undefined],
    ["false", false]
  ] as const)("defers legacy path follow-ups when the opt-in flag is %s", async (_label, flag) => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const harness = createHarness(flag);
      const outcome = await harness.support.runEmbeddingBackfillTask(BACKFILL_TASK);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const relations = await pathRelationRepo.findByAnchors("workspace-1", [
        { kind: "object", object_id: "memory-1" },
        { kind: "object", object_id: "memory-2" }
      ]);

      expect(outcome.success).toBe(true);
      expect(harness.completions).toHaveLength(1);
      expect(relations).toEqual([]);
      expect(harness.coherentPairKeys).not.toHaveBeenCalled();
      expect(harness.answerCoRelevantPairKeys).not.toHaveBeenCalled();
      expect(harness.submitCandidate).not.toHaveBeenCalled();
      expect(harness.warn).not.toHaveBeenCalled();
      expect(outcome.auditEntries).toEqual([
        "embedding_backfill:2",
        "embedding_backfill_path_follow_up_deferred:temporal_assertion_provenance_required"
      ]);
      expect(harness.completions).toContainEqual(expect.objectContaining({
        audit_entries: outcome.auditEntries
      }));
    } finally {
      database.close();
    }
  });

  it("executes both legacy follow-ups only when explicitly enabled", async () => {
    const harness = createHarness(true);

    const outcome = await harness.support.runEmbeddingBackfillTask(BACKFILL_TASK);

    expect(harness.coherentPairKeys).toHaveBeenCalledOnce();
    expect(harness.answerCoRelevantPairKeys).toHaveBeenCalledOnce();
    expect(harness.submitCandidate).toHaveBeenCalledTimes(2);
    expect(harness.warn).toHaveBeenCalledTimes(2);
    expect(outcome.auditEntries).toEqual(["embedding_backfill:2"]);
  });
});
