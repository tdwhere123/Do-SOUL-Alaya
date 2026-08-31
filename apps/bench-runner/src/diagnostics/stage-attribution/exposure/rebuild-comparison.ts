import { buildStageAttributionTables } from "../build-tables.js";
import { compareF0F2VsCachedF3 } from "../diagnostic-100q.js";
import { loadRecallEvalQuestionDiagnostics } from "../load-recall-eval-diagnostics.js";
import { buildTreatmentExposureReceipts } from "./build-receipts.js";

export async function rebuildDiagnostic100QComparison(input: {
  readonly controlDiagnosticsPath: string;
  readonly treatmentDiagnosticsPath: string;
}) {
  const [control, treatment] = await Promise.all([
    loadRecallEvalQuestionDiagnostics(input.controlDiagnosticsPath),
    loadRecallEvalQuestionDiagnostics(input.treatmentDiagnosticsPath)
  ]);
  const controlTable = buildStageAttributionTables({
    cell: "A", sourceDiagnostics: input.controlDiagnosticsPath, questions: control
  });
  const treatmentTable = buildStageAttributionTables({
    cell: "B", sourceDiagnostics: input.treatmentDiagnosticsPath, questions: treatment
  });
  return compareF0F2VsCachedF3({
    control: controlTable.questions,
    treatment: treatmentTable.questions,
    treatmentExposure: buildTreatmentExposureReceipts({
      control,
      treatment,
      controlStages: controlTable.questions,
      treatmentStages: treatmentTable.questions
    })
  });
}
