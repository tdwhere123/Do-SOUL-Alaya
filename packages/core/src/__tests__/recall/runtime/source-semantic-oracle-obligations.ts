import type { SourceSemanticCorrespondence, SourceSemanticConsumedLeaf as Leaf, SourceSemanticInterpretation,
  SourceSemanticQuery, SourceSemanticQueryAlternative } from "@do-soul/alaya-protocol";

/** Independent semantics for one finite assignment. No compiler, normalizer or engine imports. */
export function semanticAssignmentProofs(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence: SourceSemanticCorrespondence,
  branch: SourceSemanticQueryAlternative, alt: number, bindings: Readonly<Record<string, string>>): readonly Leaf[][] {
  const mandatory: Leaf[] = [], choices: Leaf[][][] = [];
  const nodes = new Map([...interpretation.frames, ...interpretation.operators].map((row) => [row.id, row]));
  for (const variable of semantics.variables) {
    const id = bindings[variable.id];
    if (id === undefined) continue;
    mandatory.push({ leaf_kind: "source_interpretation_sort", occurrence: id, value: variable.sort });
    if (variable.reference === undefined) continue;
    const options = correspondence.correspondences.flatMap((row, index) => row.query_endpoint.kind === "referent"
      && row.query_endpoint.variable === variable.id && row.source_endpoint.kind === "referent" && row.source_endpoint.referent === id
      ? [[{ leaf_kind: "semantic_correspondence_referent" as const, occurrence: id, correspondence_index: index }]] : []);
    if (options.length === 0) return [];
    choices.push(options);
  }
  for (const frame of branch.frames) {
    const id = bindings[frame.variable]!, node = nodes.get(id);
    if (node === undefined) return [];
    mandatory.push({ leaf_kind: "source_interpretation_presence", occurrence: id });
    if (frame.operator !== undefined) {
      if (!("operator" in node) || node.operator !== frame.operator) return [];
      mandatory.push({ leaf_kind: "source_interpretation_operator", occurrence: id, value: node.operator });
    } else {
      if ("operator" in node) return [];
      const options = correspondence.correspondences.flatMap((row, index) => row.query_endpoint.kind === "predicate"
        && row.query_endpoint.alternative === alt && row.query_endpoint.frame === frame.id && row.source_endpoint.kind === "frame"
        && row.source_endpoint.frame === id ? [[{ leaf_kind: "semantic_correspondence_predicate" as const, occurrence: id, correspondence_index: index }]] : []);
      if (options.length === 0) return [];
      choices.push(options);
    }
    if (frame.source_act !== undefined) {
      if (node.context_owner.kind !== "source_act" || node.context_owner.source_act !== frame.source_act) return [];
      mandatory.push({ leaf_kind: "source_interpretation_source_act", occurrence: id, value: frame.source_act });
    }
    for (const obligation of branch.context_obligations.filter((row) => row.frame === frame.id)) {
      if (obligation.kind === "asserted_at_source") {
        if (!interpretation.asserted_at_scope.includes(id)) return [];
        mandatory.push({ leaf_kind: "source_interpretation_assertion_permission", occurrence: id });
      } else if (obligation.kind === "explicit_embedded_structure") {
        const owner = node.context_owner;
        if (owner.kind === "source_act") return [];
        const options = contentLeaves(interpretation, owner.kind === "embedding" ? owner.parent_frame : owner.operator_handle, id);
        if (options.length === 0) return [];
        choices.push(options.map((leaf) => [leaf]));
      } else {
        if (interpretation.asserted_at_scope.includes(id)) return [];
        mandatory.push({ leaf_kind: "source_interpretation_context", occurrence: id });
      }
      const edge = obligation.incidence;
      if (edge !== undefined) {
        const parentVar = branch.frames.find((row) => row.id === edge.other_frame)!.variable;
        const options = contentLeaves(interpretation, bindings[parentVar]!, id).filter((row) => row.relation_kind === edge.kind && row.role === (edge.role ?? "content"));
        if (options.length === 0) return [];
        choices.push(options.map((leaf) => [leaf]));
      }
    }
    for (const role of frame.role_requirements) {
      const target = bindings[role.target_variable]!;
      if ("operator" in node) {
        if (node.operator !== "reported" || node.reporter !== target || role.id !== "reporter") return [];
        mandatory.push({ leaf_kind: "source_interpretation_content", occurrence: target, parent: node.id, relation_kind: "operator_operand", role: "reporter" });
        continue;
      }
      const options = correspondence.correspondences.flatMap((row, index): Leaf[][] => {
        if (row.query_endpoint.kind !== "slot" || row.query_endpoint.alternative !== alt || row.query_endpoint.frame !== frame.id
          || row.query_endpoint.slot !== role.id || row.source_endpoint.kind !== "slot" || row.source_endpoint.frame !== id) return [];
        const slot = row.source_endpoint.slot;
        if (!node.bindings.some((binding) => binding.slot_id === slot && binding.target.kind === "node" && binding.target.id === target)) return [];
        return [[{ leaf_kind: "semantic_correspondence_slot", occurrence: id, slot_id: slot, correspondence_index: index },
          { leaf_kind: "source_interpretation_binding", occurrence: id, slot_id: slot, target }]];
      });
      if (options.length === 0) return [];
      choices.push(options);
    }
  }
  let proofs = [mandatory];
  for (const options of choices) {
    if (proofs.length * options.length > 10000) throw new Error("independent oracle proof bound exceeded");
    proofs = proofs.flatMap((proof) => options.map((option) => [...proof, ...option]));
  }
  return [...new Map(proofs.map((proof) => { const leaves = uniqueSemanticLeaves(proof); return [leaves.map(semanticLeafKey).join("|"), leaves]; })).values()];
}

function contentLeaves(interpretation: SourceSemanticInterpretation, parent: string, child: string): Leaf[] {
  const nested = [...interpretation.frames, ...interpretation.operators].find((row) => row.id === child), out: Leaf[] = [];
  if (nested?.context_owner.kind === "embedding" && nested.context_owner.parent_frame === parent) {
    out.push({ leaf_kind: "source_interpretation_content", occurrence: child, parent, relation_kind: "embedding", role: "content" });
  }
  const operator = interpretation.operators.find((row) => row.id === parent);
  if (operator === undefined) return out;
  const roles: (readonly ["content" | "antecedent" | "consequent" | "reporter", string])[] = operator.operator === "conditional"
    ? [["antecedent", operator.antecedent], ["consequent", operator.consequent]]
    : operator.operator === "opaque" ? operator.operands.map((id) => ["content", id])
    : [["content", operator.content], ...(operator.operator === "reported" && operator.reporter !== undefined ? [["reporter", operator.reporter] as const] : [])];
  for (const [role, id] of roles) if (id === child) out.push({ leaf_kind: "source_interpretation_content", occurrence: child, parent, relation_kind: "operator_operand", role });
  return out;
}
export function semanticLeafKey(leaf: Leaf): string {
  return JSON.stringify(Object.fromEntries(Object.entries(leaf).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))));
}
export function uniqueSemanticLeaves(leaves: readonly Leaf[]): Leaf[] {
  return [...new Map(leaves.map((leaf) => [semanticLeafKey(leaf), leaf])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, leaf]) => leaf);
}
