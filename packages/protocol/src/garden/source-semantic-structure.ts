import type { SourceSemanticGraph, SourceSemanticContextOwner } from "./source-semantic-draft.js";

export type SourceSemanticStructuralEdge = Readonly<{
  kind: "embedding" | "operator_operand";
  from: string;
  to: string;
  role: "content" | "antecedent" | "consequent" | "reporter";
  governing: boolean;
}>;

/** Single structural incidence owner. Reporter participation is not domination. */
export function sourceSemanticStructuralEdges(graph: Pick<SourceSemanticGraph, "frames" | "operators">):
readonly SourceSemanticStructuralEdge[] {
  const edges: SourceSemanticStructuralEdge[] = [];
  for (const row of [...graph.frames, ...graph.operators]) {
    if (row.context_owner.kind === "embedding") edges.push({
      kind: "embedding", from: row.context_owner.parent_frame, to: row.id, role: "content", governing: true
    });
  }
  for (const operator of graph.operators) {
    const add = (to: string, role: SourceSemanticStructuralEdge["role"]) => edges.push({
      kind: "operator_operand", from: operator.id, to, role, governing: role !== "reporter"
    });
    if (operator.operator === "conditional") { add(operator.antecedent, "antecedent"); add(operator.consequent, "consequent"); }
    else if (operator.operator === "opaque") for (const id of operator.operands) add(id, "content");
    else {
      add(operator.content, "content");
      if (operator.operator === "reported" && operator.reporter !== undefined) add(operator.reporter, "reporter");
    }
  }
  return edges;
}

/** Contradictory owners cannot be resolved in favor of assertion permission. */
export function sourceSemanticOwnershipProblems(graph: SourceSemanticGraph): readonly string[] {
  const problems: string[] = [];
  const occurrences = new Map([...graph.frames, ...graph.operators].map((row) => [row.id, row]));
  const incoming = new Map<string, Set<string>>();
  for (const edge of sourceSemanticStructuralEdges(graph)) {
    if (!edge.governing) continue;
    const child = occurrences.get(edge.to);
    const parents = incoming.get(edge.to) ?? new Set<string>();
    parents.add(edge.from); incoming.set(edge.to, parents);
    if (edge.kind === "operator_operand" && (child?.context_owner.kind !== "operator"
        || child.context_owner.operator_handle !== edge.from)) problems.push("operator operand contradicts its context owner");
  }
  for (const row of occurrences.values()) {
    const parents = incoming.get(row.id) ?? new Set<string>();
    if (parents.size > 1) problems.push("an occurrence cannot have multiple governing owners");
    const owner = row.context_owner;
    if (owner.kind === "source_act" && parents.size !== 0) problems.push("a governed occurrence cannot be a source act");
    if (owner.kind === "operator" && !parents.has(owner.operator_handle)) problems.push("operator owner has no governing operand edge");
  }
  return problems;
}

export function sourceSemanticStanceLists(
  occurrences: readonly Readonly<{ id: string; context_owner: SourceSemanticContextOwner }>[]
): Readonly<{ entry_roots: readonly string[]; asserted_at_scope: readonly string[] }> {
  const sourceActs = occurrences.filter((row) => row.context_owner.kind === "source_act");
  return { entry_roots: sourceActs.map((row) => row.id),
    asserted_at_scope: sourceActs.filter((row) => row.context_owner.kind === "source_act"
      && row.context_owner.source_act === "assertion").map((row) => row.id) };
}

export function sourceSemanticContextContains(
  graph: Pick<SourceSemanticGraph, "frames" | "operators">, context: string, occurrence: string
): boolean {
  const rows = new Map([...graph.frames, ...graph.operators].map((row) => [row.id, row]));
  const seen = new Set<string>();
  let current: string | undefined = occurrence;
  while (current !== undefined && !seen.has(current)) {
    if (current === context) return rows.has(context);
    seen.add(current);
    const owner: SourceSemanticContextOwner | undefined = rows.get(current)?.context_owner;
    current = owner?.kind === "embedding" ? owner.parent_frame
      : owner?.kind === "operator" ? owner.operator_handle : undefined;
  }
  return false;
}

/** Reserved local coordinates of the H slot occurrences; model handles cannot use this namespace. */
export function sourceSemanticSlotNodeId(frameIndex: number, slotIndex: number): string {
  return `@slot:${frameIndex}:${slotIndex}`;
}
