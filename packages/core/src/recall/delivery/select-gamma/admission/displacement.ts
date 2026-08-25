import type {
  SelectGammaDecision,
  SelectGammaDecisionReceipt,
  SelectGammaFormulaCandidate,
  SelectGammaWalkObjective
} from "../types.js";

export type SelectGammaDisplacementKind =
  "coverage_displaced" | "quality_displaced" | "rank_displaced";

export function isSelectGammaDisplacementKind(
  kind: string
): kind is SelectGammaDisplacementKind {
  return kind === "coverage_displaced" ||
    kind === "quality_displaced" ||
    kind === "rank_displaced";
}

export function isSelectGammaDisplacementReceipt(
  receipt: SelectGammaDecisionReceipt
): receipt is Extract<SelectGammaDecisionReceipt, {
  readonly kind: SelectGammaDisplacementKind
}> {
  return isSelectGammaDisplacementKind(receipt.kind);
}

export function lastSlotDisplacementDecisions<State>(
  losers: readonly SelectGammaFormulaCandidate[],
  winner: SelectGammaFormulaCandidate,
  winnerGain: number,
  state: State,
  objective: SelectGammaWalkObjective<State>,
  firstOrder: number
): readonly SelectGammaDecision[] {
  return Object.freeze(losers.map((loser, index) => {
    const loserGain = objective.marginalGain(loser, state);
    return Object.freeze({
      candidate_key: loser.candidate_key,
      selection_order: firstOrder + index,
      selected_rank: null,
      marginal_gain: loserGain,
      receipt: displacementReceipt(
        loser,
        winner,
        winnerGain,
        loserGain,
        state,
        objective
      )
    });
  }));
}

function displacementReceipt<State>(
  loser: SelectGammaFormulaCandidate,
  winner: SelectGammaFormulaCandidate,
  winnerGain: number,
  loserGain: number,
  state: State,
  objective: SelectGammaWalkObjective<State>
): SelectGammaDecisionReceipt {
  return Object.freeze({
    kind: classifyDisplacement(winner, loser, state, objective),
    competing_candidate_key: winner.candidate_key,
    competing_marginal_gain: winnerGain,
    candidate_marginal_gain: loserGain
  });
}

function classifyDisplacement<State>(
  winner: SelectGammaFormulaCandidate,
  loser: SelectGammaFormulaCandidate,
  state: State,
  objective: SelectGammaWalkObjective<State>
): SelectGammaDisplacementKind {
  const decompose = objective.decomposeGain;
  if (decompose === undefined) return "quality_displaced";
  const winnerParts = decompose(winner, state);
  const loserParts = decompose(loser, state);
  // Rank-only admission must not be receipted as quality: quality did not compete.
  if (
    winnerParts.cover_availability !== undefined &&
    winnerParts.cover_availability !== "positive"
  ) {
    return "rank_displaced";
  }
  // Cover wins only when extra cover, not a higher quality term, took the slot.
  return winnerParts.coverage > loserParts.coverage &&
    winnerParts.quality <= loserParts.quality
    ? "coverage_displaced"
    : "quality_displaced";
}
