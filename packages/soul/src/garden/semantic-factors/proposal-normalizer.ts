type UnknownRecord = Readonly<Record<string, unknown>>;

export function pruneUnboundOpenSemanticFactorProposal(value: unknown): unknown {
  const graph = asRecord(value);
  if (graph === null || !Array.isArray(graph.factors) ||
      !Array.isArray(graph.variables) || !Array.isArray(graph.propositions)) {
    return value;
  }
  const referenced = collectReferencedNodeIds(graph.propositions);
  return {
    ...graph,
    factors: graph.factors.filter((factor) =>
      hasReferencedId(factor, "factor_id", referenced.factorIds)),
    variables: graph.variables.filter((variable) =>
      hasReferencedId(variable, "variable_id", referenced.variableIds))
  };
}

function collectReferencedNodeIds(propositions: readonly unknown[]): {
  readonly factorIds: ReadonlySet<string>;
  readonly variableIds: ReadonlySet<string>;
} {
  const factorIds = new Set<string>();
  const variableIds = new Set<string>();
  for (const candidate of propositions) {
    const proposition = asRecord(candidate);
    if (proposition === null) continue;
    if (typeof proposition.predicate_factor_id === "string") {
      factorIds.add(proposition.predicate_factor_id);
    }
    collectArgumentReferences(proposition.arguments, factorIds, variableIds);
  }
  return { factorIds, variableIds };
}

function collectArgumentReferences(
  value: unknown,
  factorIds: Set<string>,
  variableIds: Set<string>
): void {
  if (!Array.isArray(value)) return;
  for (const candidate of value) {
    const argument = asRecord(candidate);
    if (argument === null || typeof argument.reference_id !== "string") continue;
    if (argument.reference_kind === "factor") factorIds.add(argument.reference_id);
    else if (argument.reference_kind === "variable") variableIds.add(argument.reference_id);
  }
}

function hasReferencedId(
  value: unknown,
  field: "factor_id" | "variable_id",
  referencedIds: ReadonlySet<string>
): boolean {
  const record = asRecord(value);
  return record !== null && typeof record[field] === "string" &&
    referencedIds.has(record[field]);
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}
