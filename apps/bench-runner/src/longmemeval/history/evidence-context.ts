import {
  type HistoryLayout,
  type KpiPayload,
  type VerifiedLongMemEvalEvidenceContext
} from "@do-soul/alaya-eval";
import {
  loadLongMemEvalReleaseEvidenceFromAuthority,
  type LongMemEvalReleaseEvidenceAuthority
} from "@do-soul/alaya-eval/internal";
import { validateLongMemEvalReleaseDiagnostics } from
  "../diagnostics/release-evidence-validator.js";

export function createLongMemEvalHistoryLayout(input: {
  readonly historyRoot: string;
  readonly authority: LongMemEvalReleaseEvidenceAuthority | null;
}): HistoryLayout {
  if (input.authority === null) return { historyRoot: input.historyRoot };
  return {
    historyRoot: input.historyRoot,
    verifyLongMemEvalEvidence: async ({ entryRoot, payload }) => {
      return loadLongMemEvalReleaseEvidenceFromAuthority({
        entryRoot,
        payload,
        authority: input.authority!,
        validateFullDiagnostics: validateLongMemEvalReleaseDiagnostics
      });
    }
  };
}

export async function resolveLongMemEvalEvidenceContext(
  layout: HistoryLayout,
  entryRoot: string,
  payload: KpiPayload
): Promise<VerifiedLongMemEvalEvidenceContext | null> {
  if (payload.measurement_attribution?.gate_eligible !== true ||
      layout.verifyLongMemEvalEvidence === undefined) {
    return null;
  }
  try {
    return await layout.verifyLongMemEvalEvidence({ entryRoot, payload });
  } catch {
    return null;
  }
}
