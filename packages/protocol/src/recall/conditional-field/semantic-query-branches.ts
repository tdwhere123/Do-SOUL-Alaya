import type { SourceSemanticQueryAlternative, SourceSemanticQueryTarget } from "./semantic-query.js";

export type SourceSemanticQueryBranchView = Readonly<{
  target: SourceSemanticQueryTarget;
  alternative: SourceSemanticQueryAlternative;
}>;

/** A requested occurrence retains its complete governing scope, including sibling operands. */
export function sourceSemanticQueryScopeView(
  alternative: SourceSemanticQueryAlternative, requested: readonly string[]
): SourceSemanticQueryAlternative {
  const included = new Set(requested);
  let changed = true;
  while (changed) {
    changed = false;
    for (const obligation of alternative.context_obligations) {
      const parent = obligation.incidence?.other_frame;
      if (parent === undefined || !included.has(parent) && !included.has(obligation.frame)) continue;
      for (const id of [parent, obligation.frame]) if (!included.has(id)) { included.add(id); changed = true; }
    }
  }
  return {
    frames: alternative.frames.filter(frame => included.has(frame.id)),
    context_obligations: alternative.context_obligations.filter(row => included.has(row.frame)),
    ...(alternative.purpose === undefined ? {} : { purpose: alternative.purpose })
  };
}

/** Views retain original query semantics endpoints; they never create another query or correspondence identity. */
export function sourceSemanticQueryBranchViews(alternative: SourceSemanticQueryAlternative): SourceSemanticQueryBranchView[] {
  return [
    { target: { kind: "answer" }, alternative: sourceSemanticQueryScopeView(alternative,
      alternative.answer_frames ?? alternative.frames.map(frame => frame.id)) },
    ...(alternative.evidence_inputs ?? []).map((input, index) => ({
      target: { kind: "evidence" as const, input: index },
      alternative: sourceSemanticQueryScopeView(alternative, input.frames)
    }))
  ];
}
