import {
  sourceSemanticQueryBranchViews,
  type SourceSemanticQuery, type SourceSemanticQueryAlternative, type SourceSemanticQueryTarget,
  type SourceSemanticCorrespondence, type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";

export type SourceSemanticBranchPlan = Readonly<{
  alternative: number; target: SourceSemanticQueryTarget; view: SourceSemanticQueryAlternative;
  acceptIndex: number; groupFrame?: string; groupQueryFrame?: string;
  projectedVariables: readonly string[]; returnedVariables: readonly string[];
}>;

export function correspondencePredicateGroups(
  correspondence: SourceSemanticCorrespondence | undefined, alternative: number, queryFrame?: string
): readonly string[] {
  return [...new Set((correspondence?.correspondences ?? []).flatMap(row =>
    row.query_endpoint.kind === "predicate" && row.source_endpoint.kind === "frame"
      && row.query_endpoint.alternative === alternative && (queryFrame === undefined || row.query_endpoint.frame === queryFrame)
      ? [row.source_endpoint.frame] : []))].sort();
}

function groups(view: SourceSemanticQueryAlternative | undefined,
  correspondence: SourceSemanticCorrespondence | undefined, alternative: number): readonly (string | undefined)[] {
  const predicates = view?.frames.filter(frame => frame.operator === undefined) ?? [];
  if (predicates.length !== 1) return [undefined];
  const frames = correspondencePredicateGroups(correspondence, alternative, predicates[0]!.id);
  return frames.length === 0 ? [undefined] : frames;
}

/** One original-Q view determines both adapters and programs; no derived query identity is introduced. */
export function planSourceSemanticBranches(query: SourceSemanticQuery,
  correspondence: SourceSemanticCorrespondence, meter: SourceSemanticResourceLedger): readonly SourceSemanticBranchPlan[] {
  const plans: SourceSemanticBranchPlan[] = [];
  for (const [alternative, body] of query.alternatives.entries()) {
    for (const { target, alternative: view } of sourceSemanticQueryBranchViews(body)) {
      meter.retain(view, "query branch view");
      if (view.frames.length === 0) continue;
      const projectedVariables = [...new Set(view.frames.flatMap(frame =>
        [frame.variable, ...frame.role_requirements.map(role => role.target_variable)]))];
      const returnedVariables = target.kind === "answer" ? query.return_variables
        : projectedVariables.filter(id => query.variables.some(variable => variable.id === id
          && variable.sort === "entity" && variable.reference === undefined));
      for (const groupFrame of groups(view, correspondence, alternative)) {
        meter.charge(1, 256, "query branch plan");
        plans.push({ alternative, target, view, acceptIndex: plans.length, groupFrame,
          groupQueryFrame: view.frames.find(frame => frame.operator === undefined)?.id, projectedVariables, returnedVariables });
      }
    }
  }
  return plans;
}
