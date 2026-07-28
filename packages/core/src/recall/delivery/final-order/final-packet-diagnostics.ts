import type {
  RecallCandidateDiagnostic
} from "../../runtime/recall-service-types.js";

export function mergeFinalPacketAdmissionDiagnostics(
  baseline: readonly Readonly<RecallCandidateDiagnostic>[],
  replay: readonly Readonly<RecallCandidateDiagnostic>[]
): readonly Readonly<RecallCandidateDiagnostic>[] {
  const replayByKey = new Map(replay.map((row) => [row.candidate_key, row]));
  return Object.freeze(baseline.map((row) => {
    const admission = replayByKey.get(row.candidate_key);
    if (admission === undefined) {
      return Object.freeze({ ...row, final_rank: null, post_rank: null });
    }
    return Object.freeze({
      ...row,
      final_rank: null,
      post_rank: null,
      in_final_packet: admission.in_final_packet,
      eviction_reason: admission.eviction_reason,
      dropped_reason: admission.dropped_reason,
      within_budget: admission.within_budget
    });
  }));
}
