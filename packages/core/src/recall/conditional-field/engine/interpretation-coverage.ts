import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type CompletenessReport,
  type CompletenessStatus,
  type QueryHole,
  type QueryHypothesis,
  type QueryInterpretationStatus
} from "@do-soul/alaya-protocol";

export type InterpretationOpenMaterial = Readonly<{
  readonly hypotheses?: readonly QueryHypothesis[];
  readonly holes?: readonly QueryHole[];
}>;

export function interpretationCoverage(
  status: QueryInterpretationStatus,
  open: boolean
): CompletenessStatus {
  if (status === "resource_rejected") return "resource_rejected";
  if (status === "unsupported" || status === "malformed") return "unavailable";
  return open ? "open" : "complete";
}

export function interpretationHasOpenHoles(
  status: QueryInterpretationStatus,
  interpretation?: InterpretationOpenMaterial
): boolean {
  return status === "hypotheses"
    || status === "partial"
    || (interpretation?.hypotheses?.length ?? 0) > 0
    || (interpretation?.holes ?? []).some((hole) => hole.status !== "bound");
}

export function interpretationCoverageFor(
  status: QueryInterpretationStatus,
  interpretation?: InterpretationOpenMaterial
): CompletenessStatus {
  return interpretationCoverage(status, interpretationHasOpenHoles(status, interpretation));
}

export function interpretationCoverageOf(
  status: QueryInterpretationStatus | undefined
): CompletenessStatus | undefined {
  if (status === undefined) return undefined;
  return interpretationCoverage(status, status === "hypotheses" || status === "partial");
}

export function interpretationMayEmitCompleteEmpty(
  status: QueryInterpretationStatus
): boolean {
  return status === "resolved";
}

export function completenessForInterpretationStatus(
  status: QueryInterpretationStatus
): CompletenessReport | undefined {
  // Hypotheses/partial stay undefined here so the engine does not treat them as envelope rejection.
  if (status === "resource_rejected") return uniformCoverage("resource_rejected");
  if (status === "unsupported" || status === "malformed") return uniformCoverage("unavailable");
  return undefined;
}

function uniformCoverage(status: CompletenessStatus): CompletenessReport {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    logical_index: status,
    observed_coverage: status,
    interpretation_coverage: status,
    transport: status,
    payload: status,
    representation: status
  };
}
