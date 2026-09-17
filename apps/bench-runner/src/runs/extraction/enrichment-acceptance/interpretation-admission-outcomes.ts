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
  const fromLocated = input.receive.located.map((located, requestOrdinal) => {
    const attribution = byAssertion.get(located.assertion_binding.assertion_id);
    const diagnostics = located.diagnostics;
    const primary = diagnostics[0];
    return Object.freeze({
      ...(attribution?.annotation_pointer === undefined
        ? {}
        : { annotation_pointer: attribution.annotation_pointer }),
      request_key: input.requestKey,
      current_assertion_id: located.assertion_binding.assertion_id,
      ...(attribution?.occurrence_identity === undefined
        ? {}
        : { occurrence_identity: attribution.occurrence_identity }),
      request_ordinal: requestOrdinal,
      candidate_ordinal: primary?.candidate_index ?? (located.outcome === "candidates" ? 0 : null),
      raw_state: localCellState(located.outcome),
      machine_admission: machineCellState(located.outcome, requestComplete),
      located_outcome: located.outcome,
      ...(primary === undefined ? {} : { diagnostic_reason: primary.reason }),
      rejected_siblings: Object.freeze(diagnostics.map((item) => Object.freeze({
        candidate_ordinal: item.candidate_index ?? -1,
        reason: item.reason
      })))
    });
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
      raw_state: "rejected" as const,
      machine_admission: "rejected" as const,
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
  outcome: "candidates" | "empty" | "failed"
): PreparationCellState {
  if (outcome === "failed") return "rejected";
  if (outcome === "empty") return "valid-empty";
  return "unreviewed";
}

function machineCellState(
  outcome: "candidates" | "empty" | "failed",
  requestComplete: boolean
): PreparationCellState {
  if (outcome === "failed") return "rejected";
  if (outcome === "empty") return requestComplete ? "valid-empty" : "partial";
  return requestComplete ? "unreviewed" : "rejected";
}
