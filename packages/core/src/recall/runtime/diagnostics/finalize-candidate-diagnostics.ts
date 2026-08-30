import type { CanonicalSelectionReceipt, RecallCandidate } from "@do-soul/alaya-protocol";
import { ShadowContractError } from "../../decision/prefix-capture/envelope.js";
import type {
  CanonicalCandidateDiagnostic,
  RecallCandidateDiagnostic,
  RecallFineAssessmentCandidateDiagnostic
} from "../recall-service-types.js";

export function finalizeRecallCandidateDiagnostics(
  diagnostics: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[],
  deliveredCandidates: readonly Readonly<RecallCandidate>[],
  captureReceipt?: Readonly<CanonicalSelectionReceipt>
): readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[] {
  if (captureReceipt !== undefined) validateCaptureRows(diagnostics, deliveredCandidates, captureReceipt);
  const deliveredRankByCandidateKey = new Map<string, number>(
    deliveredCandidates.map((candidate, index) => [
      `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`,
      index + 1
    ] as const)
  );
  return Object.freeze(diagnostics.map((diagnostic) => finalizeCandidate(
    diagnostic,
    deliveredRankByCandidateKey.get(diagnostic.candidate_key) ?? null
  )));
}

function finalizeCandidate(
  diagnostic: Readonly<RecallFineAssessmentCandidateDiagnostic>,
  deliveredRank: number | null
): Readonly<RecallFineAssessmentCandidateDiagnostic> {
  if (!isLegacyCandidateDiagnostic(diagnostic)) {
    return finalizeCanonicalCandidate(diagnostic, deliveredRank);
  }
  if (deliveredRank !== null) return Object.freeze({
    ...diagnostic,
    final_rank: deliveredRank,
    post_rank: deliveredRank,
    in_final_packet: true,
    eviction_reason: null,
    dropped_reason: null,
    within_budget: true
  });
  if (diagnostic.dropped_reason !== null) return Object.freeze({
    ...diagnostic,
    post_rank: diagnostic.final_rank,
    in_final_packet: false,
    eviction_reason: diagnostic.dropped_reason
  });
  return Object.freeze({
    ...diagnostic,
    final_rank: null,
    post_rank: null,
    in_final_packet: false,
    eviction_reason: "max_entries" as const,
    dropped_reason: "max_entries" as const,
    within_budget: false
  });
}

function finalizeCanonicalCandidate(
  diagnostic: CanonicalCandidateDiagnostic,
  deliveredRank: number | null
): Readonly<RecallFineAssessmentCandidateDiagnostic> {
  const disposition = diagnostic.capture_disposition;
  if (disposition.status === "unavailable") return Object.freeze({
    ...diagnostic, final_rank: null, post_rank: null, in_final_packet: false,
    eviction_reason: null, dropped_reason: null, within_budget: false
  });
  if (deliveredRank === null) return diagnostic;
  if (disposition.status !== "selected") {
    throw new ShadowContractError("delivered candidate contradicts canonical capture disposition");
  }
  return Object.freeze({ ...diagnostic, final_rank: deliveredRank, post_rank: deliveredRank,
    in_final_packet: true, eviction_reason: null, dropped_reason: null, within_budget: true });
}

function validateCaptureRows(
  diagnostics: readonly Readonly<RecallFineAssessmentCandidateDiagnostic>[],
  delivered: readonly Readonly<RecallCandidate>[],
  receipt: Readonly<CanonicalSelectionReceipt>
): void {
  const canonical = diagnostics.filter(isCanonicalCandidateDiagnostic);
  const dispositions = new Map(receipt.dispositions.map((row) => [row.candidate_key, row]));
  if (canonical.length !== receipt.dispositions.length || canonical.some((row) =>
    JSON.stringify(row.capture_disposition) !== JSON.stringify(dispositions.get(row.candidate_key)))) {
    throw new ShadowContractError("canonical diagnostic rows do not match capture receipt");
  }
  const deliveredKeys = delivered.map((candidate) =>
    `${candidate.origin_plane ?? "workspace_local"}:${candidate.object_kind}:${candidate.object_id}`);
  if (deliveredKeys.some((key, index) => key !== receipt.delivery[index]?.candidate_key) ||
      deliveredKeys.length !== receipt.delivery.length) {
    throw new ShadowContractError("delivered candidates do not match capture receipt prefix");
  }
}

function isCanonicalCandidateDiagnostic(
  value: Readonly<RecallFineAssessmentCandidateDiagnostic>
): value is Readonly<CanonicalCandidateDiagnostic> {
  return "legacy_selection" in value;
}

export function isLegacyCandidateDiagnostic(
  value: Readonly<RecallFineAssessmentCandidateDiagnostic>
): value is Readonly<RecallCandidateDiagnostic> {
  return !("legacy_selection" in value);
}
