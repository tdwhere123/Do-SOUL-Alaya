import { sourceSemanticQueryBranchViews, type SourceSemanticQuery, type SourceSemanticBindingResult,
  type SourceSemanticQuerySupport } from "@do-soul/alaya-protocol";

/** Call only with execution-owned or verified bindings from this original Q. Input coverage never executes its operation. */
export function projectSourceSemanticQuerySupport(query: SourceSemanticQuery,
  bindings: readonly SourceSemanticBindingResult[]): SourceSemanticQuerySupport {
  const represented = query.evaluation !== undefined || query.alternatives.some(alternative =>
    sourceSemanticQueryBranchViews(alternative)[0]!.alternative.frames.length > 0);
  return {
    answer: bindings.some(binding => binding.kind === "answer" && binding.query_complete) ? "supported"
      : represented ? "open" : "unrepresented",
    evidence_inputs: query.alternatives.flatMap((alternative, index) => (alternative.evidence_inputs ?? []).map((_input, input) => ({
      alternative: index, input, status: bindings.some(binding => binding.kind === "evidence"
        && binding.alternative === index && binding.input === input) ? "supported" as const : "open" as const
    }))),
    operation: query.requested_operation === undefined ? "not_requested" : "not_executed",
    compatibility: "unknown", distinctness: "unknown"
  };
}
