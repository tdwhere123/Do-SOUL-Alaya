import type { RecallCandidate } from "@do-soul/alaya-protocol";

export type RecallPacketPlanPath = "legacy" | "snapshot";

export type RecallPacketPlanDecision = Readonly<{
  readonly status: "not_attempted" | "rejected" | "accepted";
  readonly challenger_candidate_key: string | null;
  readonly victim_candidate_key: string | null;
  readonly reason: string | null;
}>;

export type RecallPacketPlanTrace = Readonly<{
  readonly schema_version: 1;
  readonly assessment_path: RecallPacketPlanPath;
  readonly baseline_candidate_keys: readonly string[];
  readonly planned_candidate_keys: readonly string[] | null;
  readonly actual_candidate_keys: readonly string[];
  readonly decision: RecallPacketPlanDecision;
}>;

export function buildObservedPacketPlanTrace(
  assessmentPath: RecallPacketPlanPath,
  baseline: readonly Readonly<RecallCandidate>[],
  actual: readonly Readonly<RecallCandidate>[]
): RecallPacketPlanTrace {
  return Object.freeze({
    schema_version: 1,
    assessment_path: assessmentPath,
    baseline_candidate_keys: buildPacketCandidateKeys(baseline),
    planned_candidate_keys: null,
    actual_candidate_keys: buildPacketCandidateKeys(actual),
    decision: Object.freeze({
      status: "not_attempted",
      challenger_candidate_key: null,
      victim_candidate_key: null,
      reason: null
    })
  });
}

function buildPacketCandidateKeys(
  candidates: readonly Readonly<RecallCandidate>[]
): readonly string[] {
  return Object.freeze(candidates.map((candidate) =>
    `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`
  ));
}
