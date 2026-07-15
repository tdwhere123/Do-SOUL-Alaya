import { validateEvidenceBundle } from "./contract.mjs";

export function resolveSeparabilityEvidenceMode(diagnostics, options) {
  if (options === null || typeof options !== "object") {
    throw new Error("separability requires a current cohort or legacyDiagnostic=true");
  }
  if (options.cohort !== undefined) {
    if (options.legacyDiagnostic === true) {
      throw new Error("separability current cohort and legacyDiagnostic=true are mutually exclusive");
    }
    const contract = validateEvidenceBundle({
      manifest: null,
      diagnostics,
      cohort: options.cohort
    });
    if (contract.diagnostics.questions.length !== contract.cohort.rows.length) {
      throw new Error("diagnostics must cover every current cohort row");
    }
    return indexCohort(options.cohort);
  }
  if (options.legacyDiagnostic !== true) {
    throw new Error("separability requires a current cohort or legacyDiagnostic=true");
  }
  return null;
}

function indexCohort(cohort) {
  if (cohort === null || typeof cohort !== "object" || !Array.isArray(cohort.rows)) {
    throw new Error("cohort.rows is required when cohort is supplied");
  }
  if (cohort.rows.some((row) =>
    row?.measurement_evidence_mode === "legacy_synthesized"
  )) {
    throw new Error("legacy synthesized measurement evidence is not a current cohort");
  }
  return new Map(cohort.rows.map((row) => [row.question_id, row]));
}
