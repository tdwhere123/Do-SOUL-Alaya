import type { CompileSeedExtractionStats } from "../../../compile-seed.js";
import type { LongMemEvalSeedDropReasons } from
  "../../../extraction/seed-fuel/seed-drop-reasons.js";

export interface SeedCounterSnapshot {
  readonly factsProduced: number;
  readonly parseDropped: number;
  readonly compileOverflowDropped: number;
  readonly candidateAbsent: number;
  readonly materializationDrop: number;
}

interface AnswerSeedDropState {
  answerSeedDropReasons: LongMemEvalSeedDropReasons;
}

export function snapshotSeedCounters(stats: CompileSeedExtractionStats): SeedCounterSnapshot {
  return {
    factsProduced: stats.factsProduced,
    parseDropped: stats.parseDropped,
    compileOverflowDropped: stats.compileOverflowDropped,
    candidateAbsent: stats.signalsDroppedByReason.candidate_absent,
    materializationDrop: stats.signalsDroppedByReason.materialization_drop
  };
}

export function recordAnswerSeedDrops(
  state: AnswerSeedDropState,
  roundHasAnswer: boolean,
  before: Readonly<Record<keyof LongMemEvalSeedDropReasons, number>>,
  after: Readonly<Record<keyof LongMemEvalSeedDropReasons, number>>,
  verifiedEmptyAnswerWipe: boolean
): void {
  if (!roundHasAnswer) return;
  const candidateAbsent = Math.max(0, after.candidate_absent - before.candidate_absent);
  state.answerSeedDropReasons = {
    candidate_absent:
      state.answerSeedDropReasons.candidate_absent +
      candidateAbsent +
      (verifiedEmptyAnswerWipe && candidateAbsent === 0 ? 1 : 0),
    materialization_drop:
      state.answerSeedDropReasons.materialization_drop +
      Math.max(0, after.materialization_drop - before.materialization_drop)
  };
}

export function isVerifiedEmptyAnswerWipe(
  stats: CompileSeedExtractionStats,
  before: SeedCounterSnapshot
): boolean {
  if (stats.factsProduced !== before.factsProduced) return false;
  if (stats.signalsDroppedByReason.candidate_absent !== before.candidateAbsent) return false;
  if (stats.signalsDroppedByReason.materialization_drop !== before.materializationDrop) {
    return false;
  }
  if (
    stats.lastExtractionSource !== null &&
    stats.lastTurnRawSignalCount === 0 &&
    stats.lastTurnDraftCount === 0 &&
    stats.parseDropped === before.parseDropped &&
    stats.compileOverflowDropped === before.compileOverflowDropped
  ) {
    return true;
  }
  if (stats.parseDropped > before.parseDropped) return true;
  if (stats.compileOverflowDropped > before.compileOverflowDropped) return true;
  return stats.lastExtractionSource === null;
}
