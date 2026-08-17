import {
  AnswersWithEdgeProducerService
} from "@do-soul/alaya-core";
import type { CreateBenchSeedOpsInput } from "../seed/daemon-seed-ops-types.js";
import type { BenchEdgeFormationMember } from "../daemon-types.js";

// invariant: answers_with accrual consumes already-seeded memory_hq overlap;
// it never reseeds memories or regenerates embeddings.
export async function accrueAnswersWithCoRelevance(
  input: CreateBenchSeedOpsInput,
  members: readonly BenchEdgeFormationMember[],
  options: {
    readonly bar: number;
    readonly capPerNode: number;
    readonly crossSessionOnly: boolean;
  }
): Promise<{ readonly coRelevantPairs: number; readonly keptPairs: number; readonly admitted: number }> {
  const pairSource = input.activeRuntime.services.answersWithPairSource;
  if (members.length < 2) {
    return { coRelevantPairs: 0, keptPairs: 0, admitted: 0 };
  }
  if (pairSource === undefined) {
    throw new Error("answers_with pair source is unavailable");
  }
  return new AnswersWithEdgeProducerService({
    pairSource,
    assertionPort: input.activeRuntime.services.relationAssertionAdmissionPort,
    warn: (message, meta) => console.error(`[answers-with] ${message}`, meta),
    failOnPairSourceError: true
  }).crystallize({
    workspaceId: input.activeContext.workspaceId,
    runId: input.activeContext.runId,
    objects: members.map((member) => ({
      objectId: member.memoryId,
      sessionId: member.sessionId,
      formationKey: member.formationKey
    })),
    bar: options.bar,
    capPerNode: options.capPerNode,
    crossSessionOnly: options.crossSessionOnly
  });
}
