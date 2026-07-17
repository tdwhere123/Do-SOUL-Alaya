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

describe("Garden EMBEDDING_BACKFILL temporal clean break", () => {
  it("runs coherence and answers-with follow-ups through the rejection authority with zero legacy rows", async () => {
    const database = initDatabase({ filename: ":memory:" });
    try {
      const warn = vi.fn();
      const candidateRejectionPort = createGardenLegacyPathCandidateRejectionPort(warn);
      const objects = [
        { objectId: "memory-1", sessionId: "run-1", formationKey: "2026-07-17T00:00:00.000Z" },
        { objectId: "memory-2", sessionId: "run-2", formationKey: "2026-07-17T00:01:00.000Z" }
      ];
      const coherence = new CoherenceEdgeProducerService({
        pairSource: { coherentPairKeys: vi.fn(async () => new Set(["memory-1|memory-2"])) },
        mintPort: candidateRejectionPort,
        warn
      });
      const answersWith = new AnswersWithEdgeProducerService({
        pairSource: { answerCoRelevantPairKeys: vi.fn(async () => new Set(["memory-1|memory-2"])) },
        mintPort: candidateRejectionPort,
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
        coherenceEdgeProducerPort: {
          crystallizeForBackfill: async ({ workspaceId, runId }: {
            readonly workspaceId: string;
            readonly runId: string | null;
            readonly objectIds: readonly string[];
          }) =>
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
          crystallizeForBackfill: async ({ workspaceId, runId }: {
            readonly workspaceId: string;
            readonly runId: string | null;
            readonly objectIds: readonly string[];
          }) =>
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

      const outcome = await support.runEmbeddingBackfillTask(BACKFILL_TASK);
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const relations = await pathRelationRepo.findByAnchors("workspace-1", [
        { kind: "object", object_id: "memory-1" },
        { kind: "object", object_id: "memory-2" }
      ]);

      expect(outcome.success).toBe(true);
      expect(completions).toHaveLength(1);
      expect(relations).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        "garden legacy path candidate rejected without temporal assertion evidence",
        { workspace_id: "workspace-1", relation_kind: "coheres_with" }
      );
      expect(warn).toHaveBeenCalledWith(
        "garden legacy path candidate rejected without temporal assertion evidence",
        { workspace_id: "workspace-1", relation_kind: "answers_with" }
      );
    } finally {
      database.close();
    }
  });
});
