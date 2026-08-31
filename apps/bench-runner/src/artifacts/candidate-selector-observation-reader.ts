import { RecallCandidateSelectorObservationSchema } from
  "../harness/recall/candidate-selector-observation-schema.js";
import type { DiagnosticSelectorObservation } from
  "../diagnostics/schema/diagnostics-types.js";

export function readCandidateSelectorObservation(
  value: unknown
): DiagnosticSelectorObservation | null {
  if (value == null) return null;
  const parsed = RecallCandidateSelectorObservationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
