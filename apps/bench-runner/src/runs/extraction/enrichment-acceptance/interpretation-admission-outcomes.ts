import { createHash } from "node:crypto";
import { locateSourceInterpretation, type SourceLocatedInterpretation } from "@do-soul/alaya-protocol";
import type {
  OfficialApiExtractionRequest,
  OfficialApiInterpretationReceiveReceipt
} from "@do-soul/alaya-soul";
import type { FrozenAssertion } from "./frozen-population.js";
import type { EnrichmentBoundNativeOutcome, PreparationCellState } from "./preparation-report.js";

export type InterpretationAdmissionAttribution = Readonly<{
  readonly annotation_pointer?: FrozenAssertion["annotation_pointer"];
  readonly current_assertion_id: number;
  readonly occurrence_identity?: string;
}>;

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Assertion-local location against packed request members. Not cache admission. */
export function locatePackedRequestInterpretations(input: Readonly<{
  readonly rawJson: string;
  readonly request: OfficialApiExtractionRequest;
  readonly artifactKey?: string;
}>): readonly SourceLocatedInterpretation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.rawJson);
  } catch {
    parsed = {};
  }
  const artifactKey = input.artifactKey ?? "retained-diagnosis";
  return Object.freeze(input.request.source_assertions.map((member) => locateSourceInterpretation({
    source: member.text,
    artifactKey,
    sha256: sha256Utf8,
    assertion: {
      assertion_id: member.assertion_id,
      text: member.text,
      source_span: [0, member.text.length]
    },
    response: { kind: "received", value: parsed }
  })));
}

export function nativeOutcomesFromInterpretationReceive(input: Readonly<{
  readonly requestKey: string;
  readonly receive: OfficialApiInterpretationReceiveReceipt;
  readonly attributions: readonly InterpretationAdmissionAttribution[];
}>): readonly EnrichmentBoundNativeOutcome[] {
  const byAssertion = new Map(
    input.attributions.map((item) => [item.current_assertion_id, item] as const)
  );
  return Object.freeze(input.receive.located.map((located, requestOrdinal) => {
    const attribution = byAssertion.get(located.assertion_binding.assertion_id);
    const diagnostics = located.diagnostics;
    const primary = diagnostics[0];
    const cell = cellState(located.outcome, input.receive.status === "complete");
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
      raw_state: cell,
      machine_admission: cell,
      located_outcome: located.outcome,
      ...(primary === undefined ? {} : { diagnostic_reason: primary.reason }),
      rejected_siblings: Object.freeze(diagnostics.map((item) => Object.freeze({
        candidate_ordinal: item.candidate_index ?? -1,
        reason: item.reason
      })))
    });
  }));
}

function cellState(
  outcome: "candidates" | "empty" | "failed",
  requestComplete: boolean
): PreparationCellState {
  if (outcome === "failed") return "rejected";
  if (outcome === "empty") return "valid-empty";
  return requestComplete ? "unreviewed" : "rejected";
}
