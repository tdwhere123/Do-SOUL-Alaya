import {
  addDecision,
  errorMessage,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationLlmDecisionPort,
  type ReconciliationServiceMethodOwner
} from "./reconciliation-service-internal.js";
import { reconciliationServiceWarn } from "./reconciliation-service-methods-6.js";

export async function reconciliationServiceDecideWithLlm(owner: ReconciliationServiceMethodOwner, input: ReconciliationInput, incomingContent: string, candidates: readonly { readonly objectId: string; readonly content: string }[], bestSimilarity: number): Promise<ReconciliationDecision> {
    let verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>;
    try {
      verdict = await owner.deps.llmDecision.decide({ incomingContent, candidates });
    } catch (error) {
      reconciliationServiceWarn(owner, "reconciliation LLM decision failed — degrading to ADD", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
      // invariant: a failed semantic judgement must not drop the fact.
      // ADD it and run the conflict scan so a near-duplicate is still
      // reconciled downstream.
      return addDecision(bestSimilarity, true, "LLM decision unavailable — added with conflict scan");
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.objectId));
    switch (verdict.kind) {
      case "update":
        return buildUpdateDecision(owner, input, verdict, candidateIds, bestSimilarity);
      case "noop":
        return buildNoopDecision(owner, input, verdict, candidateIds, bestSimilarity);
      case "add":
        return addDecision(bestSimilarity, false, verdict.reason ?? "LLM judged the fact distinct");
    }
  }

function buildUpdateDecision(
  owner: ReconciliationServiceMethodOwner,
  input: ReconciliationInput,
  verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>,
  candidateIds: ReadonlySet<string>,
  bestSimilarity: number
): ReconciliationDecision {
  const targetId = verdict.targetObjectId;
  if (!isValidTarget(candidateIds, targetId)) {
    warnInvalidTarget(owner, input.signalId, "UPDATE", targetId);
    return addDecision(bestSimilarity, true, "LLM UPDATE target invalid — added with conflict scan");
  }
  return {
    kind: "update",
    survivingObjectId: targetId,
    targetObjectId: targetId,
    runConflictScan: false,
    reason: verdict.reason ?? `LLM judged a refinement of ${targetId}`,
    bestSimilarity
  };
}

function buildNoopDecision(
  owner: ReconciliationServiceMethodOwner,
  input: ReconciliationInput,
  verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>,
  candidateIds: ReadonlySet<string>,
  bestSimilarity: number
): ReconciliationDecision {
  const targetId = verdict.targetObjectId;
  if (!isValidTarget(candidateIds, targetId)) {
    warnInvalidTarget(owner, input.signalId, "NOOP", targetId);
    return addDecision(bestSimilarity, false, "LLM NOOP target invalid — added");
  }
  return {
    kind: "noop",
    survivingObjectId: targetId,
    targetObjectId: targetId,
    runConflictScan: false,
    reason: verdict.reason ?? `LLM judged a duplicate of ${targetId}`,
    bestSimilarity
  };
}

function warnInvalidTarget(
  owner: ReconciliationServiceMethodOwner,
  signalId: string,
  verdictKind: "UPDATE" | "NOOP",
  targetId: string | undefined
): void {
  reconciliationServiceWarn(
    owner,
    `reconciliation LLM returned ${verdictKind} without a valid target — degrading to ADD`,
    {
      signal_id: signalId,
      target_object_id: targetId ?? null
    }
  );
}

function isValidTarget(
  candidateIds: ReadonlySet<string>,
  targetId: string | undefined
): targetId is string {
  return targetId !== undefined && candidateIds.has(targetId);
}
