import type { FineAssessmentDiagnosticCapture } from
  "@do-soul/alaya-core";
import type { BenchRecallOptions } from "../../../harness/daemon.js";
import type { RecallEvalQuestionResult } from "./recall-eval-contract.js";

export function createCandidateActivationCapture(enabled: boolean): Readonly<{
  observer: BenchRecallOptions["diagnosticObserver"];
  attach(result: RecallEvalQuestionResult): RecallEvalQuestionResult;
}> {
  let entries: readonly (readonly [string, unknown])[] | undefined;
  const observer = enabled ? (capture: FineAssessmentDiagnosticCapture) => {
    entries = capture.supplementaryData
      .openSemanticFactorCandidateActivationsByCandidateKey === undefined
      ? []
      : [...capture.supplementaryData
        .openSemanticFactorCandidateActivationsByCandidateKey.entries()];
    return undefined;
  } : undefined;
  return {
    observer,
    attach: (result) => !enabled || entries === undefined ? result : ({
      ...result,
      diagnostics: {
        ...result.diagnostics,
        open_semantic_factor_candidate_activations: [...entries]
          .sort(([left], [right]) => compareCodeUnits(left, right))
          .map(([candidate_key, receipt]) => ({ candidate_key, receipt }))
      }
    } as RecallEvalQuestionResult)
  };
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function combineSelectionBoundaryObservers(
  first: BenchRecallOptions["selectionBoundaryObserver"],
  second: BenchRecallOptions["selectionBoundaryObserver"]
): BenchRecallOptions["selectionBoundaryObserver"] {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return (capture) => {
    first(capture);
    second(capture);
    return undefined;
  };
}
