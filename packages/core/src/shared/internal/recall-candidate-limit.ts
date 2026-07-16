export const RECALL_TOTAL_CANDIDATE_CAP = 1000;

export function normalizeRecallCandidateLimit(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return 0;
  if (value === Number.POSITIVE_INFINITY) return RECALL_TOTAL_CANDIDATE_CAP;
  return Math.min(RECALL_TOTAL_CANDIDATE_CAP, Math.max(0, Math.trunc(value)));
}
