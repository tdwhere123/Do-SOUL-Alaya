import type { OfficialApiInterpretationReceiveReceipt } from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "./frozen-population.js";
import type { EnrichmentBoundNativeOutcome, PreparationCellState } from "./preparation-report.js";

export type InterpretationAdmissionAttribution = Readonly<{
  readonly annotation_pointer?: FrozenAssertion["annotation_pointer"];
  readonly current_assertion_id: number;
  readonly occurrence_identity?: string;
}>;

export function nativeOutcomesFromInterpretationReceive(input: Readonly<{
  readonly requestKey: string;
  readonly receive: OfficialApiInterpretationReceiveReceipt;
  readonly attributions: readonly InterpretationAdmissionAttribution[];
}>): readonly EnrichmentBoundNativeOutcome[] {
  const byAssertion = new Map(
    input.attributions.map((item) => [item.current_assertion_id, item] as const)
  );
  const requestComplete = input.receive.status === "complete";
  const fromLocated = input.receive.located.flatMap((located) => {
    const requestOrdinal = input.receive.request_assertion_ids.indexOf(located.assertion_binding.assertion_id);
    const attribution = byAssertion.get(located.assertion_binding.assertion_id);
    const diagnostics = located.diagnostics;
    const successful = located.outcome === "candidates";
    const primary = successful ? undefined : diagnostics[0];
    const base = {
      ...(attribution?.annotation_pointer === undefined
        ? {}
        : { annotation_pointer: attribution.annotation_pointer }),
      request_key: input.requestKey,
      current_assertion_id: located.assertion_binding.assertion_id,
      ...(attribution?.occurrence_identity === undefined
        ? {}
        : { occurrence_identity: attribution.occurrence_identity }),
      request_ordinal: requestOrdinal,
      raw_state: localCellState(located.outcome, primary?.reason),
      machine_admission: machineCellState(located.outcome, requestComplete, primary?.reason),
      located_outcome: located.outcome,
      ...(primary === undefined ? {} : { diagnostic_reason: primary.reason }),
      rejected_siblings: Object.freeze(diagnostics.map((item) => Object.freeze({
        candidate_ordinal: item.candidate_index ?? -1,
        reason: item.reason
      })))
    };
    if (!successful) return [Object.freeze({ ...base, candidate_ordinal: primary?.candidate_index ?? null })];
    // The locator emits either a candidate or a diagnostic for every original relation.
    const rejected = new Set(diagnostics.map((item) => item.candidate_index));
    const ordinals = Array.from({ length: located.candidates.length + rejected.size }, (_, index) => index)
      .filter((index) => !rejected.has(index));
    return ordinals.map((candidate_ordinal) => Object.freeze({ ...base, candidate_ordinal }));
  });
  const locatedAssertionIds = new Set(
    input.receive.located.map((item) => item.assertion_binding.assertion_id)
  );
  const fromRejections = input.receive.rejections.flatMap((rejection) => {
    if (rejection.reason === "candidate_rejected") return [];
    if (
      rejection.assertion_id !== undefined &&
      locatedAssertionIds.has(rejection.assertion_id) &&
      rejection.reason !== "source_assertion_mismatch"
    ) {
      return [];
    }
    const attribution = rejection.assertion_id === undefined
      ? undefined
      : byAssertion.get(rejection.assertion_id);
    return [Object.freeze({
      ...(attribution?.annotation_pointer === undefined
        ? {}
        : { annotation_pointer: attribution.annotation_pointer }),
      request_key: input.requestKey,
      ...(rejection.assertion_id === undefined ? {} : { current_assertion_id: rejection.assertion_id }),
      ...(attribution?.occurrence_identity === undefined
        ? {}
        : { occurrence_identity: attribution.occurrence_identity }),
      request_ordinal: rejection.index_scope === "envelope" ? null : rejection.index,
      candidate_ordinal: rejection.candidate_index ?? null,
      raw_state: localCellState("failed", rejection.reason),
      machine_admission: localCellState("failed", rejection.reason),
      admission_reason: rejection.reason,
      ...(rejection.diagnostic_reason === undefined ? {} : { diagnostic_reason: rejection.diagnostic_reason }),
      rejected_siblings: Object.freeze(rejection.diagnostic_reason === undefined ? [] : [Object.freeze({
        candidate_ordinal: rejection.candidate_index ?? -1,
        reason: rejection.diagnostic_reason
      })])
    })];
  });
  return Object.freeze([...fromLocated, ...fromRejections]);
}

function localCellState(
  outcome: "candidates" | "empty" | "failed",
  reason?: string
): PreparationCellState {
  if (reason === "missing_response") return "missing";
  if (reason === "transport_unknown") return "unknown";
  if (outcome === "failed") return "rejected";
  if (outcome === "empty") return "valid-empty";
  return "unreviewed";
}

function machineCellState(
  outcome: "candidates" | "empty" | "failed",
  requestComplete: boolean,
  reason?: string
): PreparationCellState {
  if (reason === "missing_response") return "missing";
  if (reason === "transport_unknown") return "unknown";
  if (outcome === "failed") return "rejected";
  if (!requestComplete) return "partial";
  if (outcome === "empty") return "valid-empty";
  return "unreviewed";
}
