export interface LongMemEvalSeedDropReasons {
  readonly candidate_absent: number;
  readonly materialization_drop: number;
}

export function createEmptyLongMemEvalSeedDropReasons(): LongMemEvalSeedDropReasons {
  return {
    candidate_absent: 0,
    materialization_drop: 0
  };
}

export function hasLongMemEvalSeedDropReasons(
  reasons: LongMemEvalSeedDropReasons | undefined
): reasons is LongMemEvalSeedDropReasons {
  return (
    reasons !== undefined &&
    (reasons.candidate_absent > 0 || reasons.materialization_drop > 0)
  );
}
