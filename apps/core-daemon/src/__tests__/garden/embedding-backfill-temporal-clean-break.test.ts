import { describe, expect, it, vi } from "vitest";
import { GardenTaskKind, GardenTier, type GardenTaskDescriptor } from "@do-soul/alaya-protocol";
import {
  AnswersWithEdgeProducerService,
  CoherenceEdgeProducerService
} from "@do-soul/alaya-core";
import { SqlitePathRelationRepo, initDatabase } from "@do-soul/alaya-storage";

import { createEmbeddingBackfillRuntimeSupport } from "../../garden/scheduler/scheduler-runtime-maintenance.js";
import type { CreateGardenSchedulerRuntimeSupportInput } from "../../garden/scheduler/scheduler-runtime-types.js";
import { createGardenLegacyPathCandidateRejectionPort } from "../../runtime/garden-wiring/garden-legacy-path-admission.js";

const FIXED_ISO = "2026-07-17T00:00:00.000Z";

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
  const answerCoRelevantPairs = vi.fn(async () => [answerWitness()]);
  const admit = vi.fn(async () => ({
    status: "admitted" as const,
    assertion: {} as never,
    activeProjectionCount: 1,
    projectionGeneration: "test-generation"
  }));
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
    pairSource: { answerCoRelevantPairs },
    assertionPort: { admit },
    warn
  } as never);
  const completions: unknown[] = [];
  const support = createEmbeddingBackfillRuntimeSupport({
    now: () => FIXED_ISO,
    embeddingBackfillHandler: {
      handle: vi.fn(async () => ({
        objectsAffected: ["memory-1", "memory-2"],
        auditEntries: ["embedding_backfill:2"]
      }))
    },
    legacyTopologyMutationsEnabled,
    coherenceEdgeProducerPort: {
      crystallizeForBackfill: async ({ workspaceId, runId }: { workspaceId: string; runId: string | null }) => {
        await coherence.crystallize({
          workspaceId,
          runId,
          objects,
          floor: 0.6,
          capPerNode: 3,
          crossSessionOnly: false
        });
      }
    },
    answersWithEdgeProducerPort: {
      crystallizeForBackfill: async ({ workspaceId, runId }: { workspaceId: string; runId: string | null }) => {
        await answersWith.crystallize({
          workspaceId,
          runId,
          objects,
          bar: 0.1,
          capPerNode: 3,
          crossSessionOnly: false
        });
      }
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
    answerCoRelevantPairs,
    admit
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
      expect(harness.answerCoRelevantPairs).toHaveBeenCalledOnce();
      expect(harness.admit).toHaveBeenCalledOnce();
      expect(harness.submitCandidate).not.toHaveBeenCalled();
      expect(harness.warn).not.toHaveBeenCalled();
      expect(outcome.auditEntries).toEqual([
        "embedding_backfill:2",
        "embedding_backfill_coherence_follow_up_deferred:formation_receipt_required"
      ]);
      expect(harness.completions).toContainEqual(expect.objectContaining({
        audit_entries: outcome.auditEntries,
        completed_at: FIXED_ISO
      }));
    } finally {
      database.close();
    }
  });

  it("executes witnessed answers_with plus opted-in legacy coherence", async () => {
    const harness = createHarness(true);

    const outcome = await harness.support.runEmbeddingBackfillTask(BACKFILL_TASK);

    expect(harness.coherentPairKeys).toHaveBeenCalledOnce();
    expect(harness.answerCoRelevantPairs).toHaveBeenCalledOnce();
    expect(harness.admit).toHaveBeenCalledOnce();
    expect(harness.submitCandidate).toHaveBeenCalledOnce();
    expect(harness.warn).toHaveBeenCalledOnce();
    expect(outcome.auditEntries).toEqual(["embedding_backfill:2"]);
  });

  it("fills the vector cache without topology follow-ups in cache-only mode", async () => {
    const harness = createHarness(true);

    const outcome = await harness.support.runEmbeddingBackfillTask(
      BACKFILL_TASK,
      "cache_only"
    );

    expect(outcome.success).toBe(true);
    expect(harness.coherentPairKeys).not.toHaveBeenCalled();
    expect(harness.answerCoRelevantPairs).not.toHaveBeenCalled();
    expect(harness.admit).not.toHaveBeenCalled();
    expect(harness.submitCandidate).not.toHaveBeenCalled();
    expect(harness.warn).not.toHaveBeenCalled();
    expect(outcome.auditEntries).toEqual([
      "embedding_backfill:2",
      "embedding_backfill_topology_follow_up_skipped:cache_only"
    ]);
  });
});

function answerWitness() {
  const observedAt = "2026-07-17T00:00:00.000Z";
  return {
    pair: ["memory-1", "memory-2"] as const,
    evidenceReceipts: [{
      evidence_id: "evidence-1",
      source_event_anchor: {
        event_type: "soul.signal.emitted" as const,
        event_id: "event-1",
        occurred_at: observedAt
      }
    }],
    formationReceipt: {
      operator_id: "test_answers_with_v1",
      operator_sha256: "a".repeat(64),
      parameters: { bar: 1 },
      parameter_sha256: "b".repeat(64),
      source_observations: [{
        source_kind: "memory_hq_observation",
        source_id: "hq-1",
        source_sha256: "c".repeat(64)
      }],
      decision: { shared_token_count: 1 },
      decision_sha256: "d".repeat(64)
    },
    validFrom: observedAt
  };
}
