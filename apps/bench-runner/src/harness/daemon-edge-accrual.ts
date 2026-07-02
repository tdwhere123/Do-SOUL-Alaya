import {
  AnswersWithEdgeProducerService,
  CoherenceEdgeProducerService,
  PATH_RELATION_PROPOSE_THRESHOLD
} from "@do-soul/alaya-core";
import { planSessionCoRecallWarmup } from "./co-recall-warmup.js";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";

export async function accrueSessionCoRecall(
  input: CreateBenchSeedOpsInput,
  memberMemoryIds: readonly string[]
): Promise<{ readonly pairsObserved: number; readonly minted: number; readonly belowThreshold: number }> {
  const plan = planSessionCoRecallWarmup(
    memberMemoryIds,
    PATH_RELATION_PROPOSE_THRESHOLD
  );
  if (plan === null) {
    return { pairsObserved: 0, minted: 0, belowThreshold: 0 };
  }
  const service = input.activeRuntime.services.pathRelationProposalService;
  const beforeCounter = await service.counterSize();
  for (let replay = 0; replay < plan.replayCount; replay += 1) {
    for (const pair of plan.pairs) {
      await service.onCoUsage(
        [pair.lowMemoryId, pair.highMemoryId],
        input.activeContext.workspaceId
      );
    }
  }
  const residualPending = Math.max(0, (await service.counterSize()) - beforeCounter);
  return {
    pairsObserved: plan.pairs.length,
    minted: Math.max(0, plan.pairs.length - residualPending),
    belowThreshold: residualPending
  };
}

export async function accrueCoherenceCoRecall(
  input: CreateBenchSeedOpsInput,
  members: readonly { readonly memoryId: string; readonly sessionId: string }[],
  options: {
    readonly floor: number;
    readonly capPerNode: number;
    readonly crossSessionOnly: boolean;
  }
): Promise<{ readonly coherentPairs: number; readonly keptPairs: number; readonly minted: number }> {
  const embeddingRecallService = input.activeRuntime.services.embeddingRecallService;
  if (embeddingRecallService === undefined || members.length < 2) {
    return { coherentPairs: 0, keptPairs: 0, minted: 0 };
  }
  return new CoherenceEdgeProducerService({
    pairSource: embeddingRecallService,
    mintPort: input.activeRuntime.services.pathRelationProposalService,
    warn: (message, meta) => console.error(`[coherence] ${message}`, meta)
  }).crystallize({
    workspaceId: input.activeContext.workspaceId,
    runId: input.activeContext.runId,
    objects: members.map((member) => ({
      objectId: member.memoryId,
      sessionId: member.sessionId
    })),
    floor: options.floor,
    capPerNode: options.capPerNode,
    crossSessionOnly: options.crossSessionOnly
  });
}

// invariant: answers_with accrual consumes already-seeded memory_hq overlap;
// it never reseeds memories or regenerates embeddings.
export async function accrueAnswersWithCoRelevance(
  input: CreateBenchSeedOpsInput,
  members: readonly { readonly memoryId: string; readonly sessionId: string }[],
  options: {
    readonly bar: number;
    readonly capPerNode: number;
    readonly crossSessionOnly: boolean;
  }
): Promise<{ readonly coRelevantPairs: number; readonly keptPairs: number; readonly minted: number }> {
  const pairSource = input.activeRuntime.services.answersWithPairSource;
  if (pairSource === undefined || members.length < 2) {
    return { coRelevantPairs: 0, keptPairs: 0, minted: 0 };
  }
  return new AnswersWithEdgeProducerService({
    pairSource,
    mintPort: input.activeRuntime.services.pathRelationProposalService,
    warn: (message, meta) => console.error(`[answers-with] ${message}`, meta)
  }).crystallize({
    workspaceId: input.activeContext.workspaceId,
    runId: input.activeContext.runId,
    objects: members.map((member) => ({
      objectId: member.memoryId,
      sessionId: member.sessionId
    })),
    bar: options.bar,
    capPerNode: options.capPerNode,
    crossSessionOnly: options.crossSessionOnly
  });
}
