import { CONDITIONAL_FIELD_SCHEMA_VERSION, type CompletenessReport, type CompletenessStatus } from "@do-soul/alaya-protocol";

/** Uniform terminal/refusal reports must retain every completeness axis. */
export function uniformCompleteness(status: CompletenessStatus): CompletenessReport {
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

/** Source bytes cannot discharge a terminal proof refusal carried by the same index. */
export function payloadExpansionCompleteness(prior: CompletenessReport,
  payload: "complete" | "partial" | "interrupted", transport = prior.transport): CompletenessReport {
  return { ...prior, payload: prior.payload === "resource_rejected" ? "resource_rejected" : payload,
    transport: prior.transport === "resource_rejected" ? "resource_rejected" : transport };
}
