import type { PerScenarioRow } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestionDiagnostic } from "../diagnostics/schema/diagnostics-types.js";
import {
  classifyQuestionMeasurementCohort,
  classifyQuestionMeasurementStatus
} from "./question-validity.js";

export function assertMeasurementCohortBinding(
  rows: readonly PerScenarioRow[],
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): void {
  if (rows.length !== diagnostics.length) {
    throw new Error("Measurement cohort diagnostic evidence must cover every row");
  }
  const evidence = indexDiagnostics(diagnostics);
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`Duplicate measurement row: ${row.id}`);
    seen.add(row.id);
    assertRowBinding(row, evidence.get(row.id));
  }
}

function indexDiagnostics(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): ReadonlyMap<string, LongMemEvalQuestionDiagnostic> {
  const evidence = new Map<string, LongMemEvalQuestionDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (evidence.has(diagnostic.question_id)) {
      throw new Error(`Duplicate measurement diagnostic: ${diagnostic.question_id}`);
    }
    evidence.set(diagnostic.question_id, diagnostic);
  }
  return evidence;
}

function assertRowBinding(
  row: PerScenarioRow,
  diagnostic: LongMemEvalQuestionDiagnostic | undefined
): void {
  if (diagnostic === undefined) {
    throw new Error(`Missing measurement diagnostic evidence for ${row.id}`);
  }
  const expectedCohort = classifyQuestionMeasurementCohort(diagnostic);
  if (row.measurement_cohort !== expectedCohort) {
    throw new Error(`Measurement cohort mismatch for ${row.id}`);
  }
  const derivedStatus = classifyQuestionMeasurementStatus(diagnostic);
  const persistedStatus = diagnostic.cohort_ledger?.measurement_status;
  if (persistedStatus !== undefined && persistedStatus !== derivedStatus) {
    throw new Error(`persisted measurement status contradicts primitive axes for ${row.id}`);
  }
  const expectedScorable = derivedStatus === "scorable";
  if (row.scorable !== expectedScorable) {
    throw new Error(`Measurement scorable state mismatch for ${row.id}`);
  }
}
