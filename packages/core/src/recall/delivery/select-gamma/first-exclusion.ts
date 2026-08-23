import type {
  SelectGammaDecisionReceipt,
  SelectGammaFormulaCandidate,
  SelectGammaWalkObjective,
  SelectGammaWalkResult
} from "./types.js";

export type SelectGammaFirstExclusionReason =
  | "quality_displaced"
  | "coverage_displaced"
  | "duplicate_source"
  | "duplicate_object"
  | "dimension_limit"
  | "token_budget"
  | "entry_budget";

export type SelectGammaDisplacementContext = Readonly<{
  readonly candidates: readonly SelectGammaFormulaCandidate[];
  readonly objective: SelectGammaWalkObjective;
}>;

export function mapSelectGammaConstraintReceipt(
  receipt: SelectGammaDecisionReceipt
): SelectGammaFirstExclusionReason | null {
  if (receipt.kind === "duplicate") {
    if (receipt.identity_channel === "source") return "duplicate_source";
    if (receipt.identity_channel === "object") return "duplicate_object";
    return null;
  }
  if (receipt.kind === "dimension_limit") return "dimension_limit";
  if (receipt.kind === "max_total_tokens") return "token_budget";
  if (receipt.kind === "max_entries") return "entry_budget";
  return null;
}

export function firstSelectGammaExclusionReason(
  goldKey: string,
  walk: SelectGammaWalkResult,
  displacement?: SelectGammaDisplacementContext
): SelectGammaFirstExclusionReason | null {
  if (walk.selected_candidate_keys.includes(goldKey)) return null;
  const own = walk.decisions.find((decision) => decision.candidate_key === goldKey);
  const mapped = own === undefined
    ? null
    : mapSelectGammaConstraintReceipt(own.receipt);
  if (mapped !== null) return mapped;
  if (displacement === undefined) {
    throw new Error("Select_Gamma gold was not selected and has no exclusion receipt");
  }
  return displaceUnconstrainedGold(goldKey, walk, displacement);
}

function displaceUnconstrainedGold(
  goldKey: string,
  walk: SelectGammaWalkResult,
  displacement: SelectGammaDisplacementContext
): SelectGammaFirstExclusionReason {
  const byKey = new Map(displacement.candidates.map((candidate) => [
    candidate.candidate_key,
    candidate
  ]));
  const gold = requireCandidate(byKey, goldKey);
  const state = displacement.objective.createState();
  const pending = new Set(walk.decisions.map((decision) => decision.candidate_key));
  pending.add(goldKey);
  for (const decision of walk.decisions) {
    const candidate = requireCandidate(byKey, decision.candidate_key);
    if (decision.receipt.kind !== "retained") {
      pending.delete(decision.candidate_key);
      continue;
    }
    if (pending.has(goldKey) && decision.candidate_key !== goldKey) {
      return coverageOrQualityDisplacement(
        candidate,
        gold,
        state,
        displacement.objective
      );
    }
    displacement.objective.accept(candidate, state);
    pending.delete(decision.candidate_key);
  }
  throw new Error("Select_Gamma gold was not selected and has no exclusion receipt");
}

function coverageOrQualityDisplacement(
  winner: SelectGammaFormulaCandidate,
  gold: SelectGammaFormulaCandidate,
  state: unknown,
  objective: SelectGammaWalkObjective
): SelectGammaFirstExclusionReason {
  const winnerCover = objective.marginalGain(winner, state) - winner.quality;
  const goldCover = objective.marginalGain(gold, state) - gold.quality;
  return winnerCover > goldCover && winner.quality <= gold.quality
    ? "coverage_displaced"
    : "quality_displaced";
}

function requireCandidate(
  byKey: ReadonlyMap<string, SelectGammaFormulaCandidate>,
  candidateKey: string
): SelectGammaFormulaCandidate {
  const candidate = byKey.get(candidateKey);
  if (candidate === undefined) {
    throw new Error("Select_Gamma first-exclusion candidate is absent from the pool");
  }
  return candidate;
}
