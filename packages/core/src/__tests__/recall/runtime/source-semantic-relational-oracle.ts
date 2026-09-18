import type {
  SourceSemanticAlignment, SourceSemanticConsumedLeaf, SourceSemanticCorrespondence,
  SourceSemanticFrame, SourceSemanticInterpretation, SourceSemanticOperator,
  SourceSemanticQuery, SourceSemanticQueryAlternative
} from "@do-soul/alaya-protocol";

export type SourceSemanticOracleAssignment = Readonly<{
  readonly bindings: Readonly<Record<string, string>>;
  readonly leaves: readonly SourceSemanticConsumedLeaf[];
}>;

export type SourceSemanticOracleResult = Readonly<{
  readonly assignments: readonly SourceSemanticOracleAssignment[];
}>;

/** Independent join oracle. Does not import the production compiler. */
export function oracleSourceSemanticJoin(
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery,
  alignment: SourceSemanticAlignment
): SourceSemanticOracleResult {
  const assignments: SourceSemanticOracleAssignment[] = [];
  for (const [index, alternative] of query.alternatives.entries()) {
    assignments.push(...enumerateAlternative(interpretation, query, alignment, alternative, index));
  }
  return { assignments };
}

function enumerateAlternative(
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery,
  alignment: SourceSemanticAlignment,
  alternative: SourceSemanticQueryAlternative,
  alt: number
): SourceSemanticOracleAssignment[] {
  const used = usedVariables(alternative);
  const vars = query.variables.filter((row) => used.has(row.id));
  const domains = vars.map((variable) => {
    if (variable.sort === "entity") return interpretation.referents.map((row) => row.id);
    if (variable.sort === "proposition") return interpretation.frames.map((row) => row.id);
    return [...interpretation.frames, ...interpretation.operators].map((row) => row.id);
  });
  if (domains.some((domain) => domain.length === 0)) return [];
  const ids = vars.map((row) => row.id);
  const found: SourceSemanticOracleAssignment[] = [];
  for (const values of cartesian(domains)) {
    const bindings: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 1) bindings[ids[i]!] = values[i]!;
    const leaves = alternativeLeaves(interpretation, alignment, alternative, alt, bindings);
    if (leaves !== undefined) found.push({ bindings, leaves });
  }
  return found;
}

function usedVariables(alternative: SourceSemanticQueryAlternative): Set<string> {
  const used = new Set<string>();
  for (const frame of alternative.frames) {
    used.add(frame.variable);
    for (const role of frame.role_requirements) used.add(role.target_variable);
  }
  return used;
}

function alternativeLeaves(
  interpretation: SourceSemanticInterpretation,
  alignment: SourceSemanticAlignment,
  alternative: SourceSemanticQueryAlternative,
  alt: number,
  bindings: Readonly<Record<string, string>>
): SourceSemanticConsumedLeaf[] | undefined {
  const leaves: SourceSemanticConsumedLeaf[] = [];
  const frames = new Map(interpretation.frames.map((row) => [row.id, row]));
  const asserted = new Set(interpretation.asserted_at_scope);
  for (const frame of alternative.frames) {
    const bound = bindings[frame.variable];
    const hFrame = bound === undefined ? undefined : frames.get(bound);
    if (hFrame === undefined) return undefined;
    const predicate = correspondence(alignment, {
      kind: "predicate", alternative: alt, frame: frame.id
    }, { kind: "frame", frame: hFrame.id });
    if (predicate === undefined) return undefined;
    leaves.push({ leaf_kind: "h_presence", occurrence: hFrame.id });
    leaves.push({
      leaf_kind: "a_predicate", occurrence: hFrame.id, correspondence_index: predicate.index
    });
    if (frame.source_act !== undefined) {
      if (hFrame.context_owner.kind !== "source_act" || hFrame.context_owner.source_act !== frame.source_act) {
        return undefined;
      }
    }
    for (const obligation of alternative.context_obligations) {
      if (obligation.frame !== frame.id) continue;
      if (obligation.kind === "asserted_at_source") {
        if (!asserted.has(hFrame.id)) return undefined;
        leaves.push({ leaf_kind: "h_assertion_permission", occurrence: hFrame.id });
      } else if (obligation.kind === "explicit_embedded_structure") {
        if (hFrame.context_owner.kind !== "embedding" && hFrame.context_owner.kind !== "operator") {
          return undefined;
        }
        leaves.push({ leaf_kind: "h_content", occurrence: hFrame.id });
        if (obligation.incidence !== undefined) {
          const parentId = bindings[alternative.frames.find((row) => row.id === obligation.incidence!.other_frame)?.variable ?? ""];
          if (parentId === undefined || !contentEdge(interpretation, parentId, hFrame.id, obligation.incidence.role ?? "content")) {
            return undefined;
          }
        }
      } else if (asserted.has(hFrame.id)) {
        return undefined;
      }
    }
    for (const role of frame.role_requirements) {
      const slot = correspondence(alignment, {
        kind: "slot", alternative: alt, frame: frame.id, slot: role.id
      }, undefined);
      if (slot === undefined || slot.correspondence.source_endpoint.kind !== "slot") return undefined;
      const sourceSlot = slot.correspondence.source_endpoint;
      if (sourceSlot.frame !== hFrame.id) return undefined;
      const target = bindings[role.target_variable];
      const binding = hFrame.bindings.find((row) => row.slot_id === sourceSlot.slot);
      if (target === undefined || binding === undefined || binding.target.kind !== "node" || binding.target.id !== target) {
        return undefined;
      }
      leaves.push({
        leaf_kind: "a_slot", occurrence: hFrame.id, slot_id: sourceSlot.slot,
        correspondence_index: slot.index
      });
      leaves.push({
        leaf_kind: "h_binding", occurrence: hFrame.id, slot_id: sourceSlot.slot
      });
    }
  }
  return dedupLeaves(leaves);
}

function correspondence(
  alignment: SourceSemanticAlignment,
  query: SourceSemanticCorrespondence["query_endpoint"],
  source: SourceSemanticCorrespondence["source_endpoint"] | undefined
): { index: number; correspondence: SourceSemanticCorrespondence } | undefined {
  for (const [index, row] of alignment.correspondences.entries()) {
    if (row.relation !== "contextual_equivalence") continue;
    if (query.kind === "predicate") {
      if (row.query_endpoint.kind !== "predicate" || row.query_endpoint.alternative !== query.alternative ||
          row.query_endpoint.frame !== query.frame) continue;
      if (source !== undefined && (row.source_endpoint.kind !== "frame" || row.source_endpoint.frame !== source.frame)) {
        continue;
      }
      return { index, correspondence: row };
    }
    if (row.query_endpoint.kind !== "slot" || row.query_endpoint.alternative !== query.alternative ||
        row.query_endpoint.frame !== query.frame || row.query_endpoint.slot !== query.slot) continue;
    return { index, correspondence: row };
  }
  return undefined;
}

function contentEdge(
  interpretation: SourceSemanticInterpretation,
  parent: string,
  child: string,
  role: string
): boolean {
  const nested = occurrence(interpretation, child);
  if (nested?.context_owner.kind === "embedding" && nested.context_owner.parent_frame === parent &&
      (role === "content" || nested.context_owner.content_argument === child)) {
    return true;
  }
  const operator = interpretation.operators.find((row) => row.id === parent);
  if (operator === undefined) return false;
  if (operator.operator === "conditional") {
    return role === "antecedent" ? operator.antecedent === child : role === "consequent" && operator.consequent === child;
  }
  if (operator.operator === "opaque") return operator.operands.includes(child);
  return operator.content === child;
}

function occurrence(
  interpretation: SourceSemanticInterpretation,
  id: string
): SourceSemanticFrame | SourceSemanticOperator | undefined {
  return interpretation.frames.find((row) => row.id === id) ??
    interpretation.operators.find((row) => row.id === id);
}

function cartesian(groups: readonly (readonly string[])[]): string[][] {
  return groups.reduce<string[][]>((acc, group) => acc.flatMap((prefix) => group.map((item) => [...prefix, item])), [[]]);
}

function dedupLeaves(leaves: readonly SourceSemanticConsumedLeaf[]): SourceSemanticConsumedLeaf[] {
  const seen = new Set<string>();
  const out: SourceSemanticConsumedLeaf[] = [];
  for (const leaf of leaves) {
    const key = JSON.stringify(leaf);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(leaf);
  }
  return out.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function leafKey(leaf: SourceSemanticConsumedLeaf): string {
  return JSON.stringify({
    leaf_kind: leaf.leaf_kind,
    occurrence: leaf.occurrence,
    slot_id: leaf.slot_id,
    correspondence_index: leaf.correspondence_index
  });
}

export function assignmentBindings(
  assignment: SourceSemanticOracleAssignment,
  variables: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const variable of variables) {
    const value = assignment.bindings[variable];
    if (value !== undefined) out[variable] = value;
  }
  return out;
}

/** Test-only reconstruction from consumed leaves. Does not add a public binding field. */
export function decodeEngineBindings(
  interpretation: SourceSemanticInterpretation,
  query: SourceSemanticQuery,
  alignment: SourceSemanticAlignment,
  leaves: readonly SourceSemanticConsumedLeaf[]
): readonly Readonly<Record<string, string>>[] {
  const found: Record<string, string>[] = [];
  for (const [alt, alternative] of query.alternatives.entries()) {
    const bindings = decodeAlternative(interpretation, alignment, alternative, alt, leaves);
    if (bindings !== undefined) found.push(bindings);
  }
  return found;
}

function decodeAlternative(
  interpretation: SourceSemanticInterpretation,
  alignment: SourceSemanticAlignment,
  alternative: SourceSemanticQueryAlternative,
  alt: number,
  leaves: readonly SourceSemanticConsumedLeaf[]
): Record<string, string> | undefined {
  const frames = new Map(interpretation.frames.map((row) => [row.id, row]));
  const keys = new Set(leaves.map(leafKey));
  const bindings: Record<string, string> = {};
  for (const frame of alternative.frames) {
    const predicate = correspondence(alignment, {
      kind: "predicate", alternative: alt, frame: frame.id
    }, undefined);
    if (predicate === undefined || predicate.correspondence.source_endpoint.kind !== "frame") {
      return undefined;
    }
    const hid = predicate.correspondence.source_endpoint.frame;
    const hFrame = frames.get(hid);
    if (hFrame === undefined) return undefined;
    if (!keys.has(leafKey({ leaf_kind: "h_presence", occurrence: hid })) ||
        !keys.has(leafKey({
          leaf_kind: "a_predicate", occurrence: hid, correspondence_index: predicate.index
        }))) {
      return undefined;
    }
    if (frame.source_act !== undefined) {
      if (hFrame.context_owner.kind !== "source_act" || hFrame.context_owner.source_act !== frame.source_act) {
        return undefined;
      }
    }
    for (const obligation of alternative.context_obligations) {
      if (obligation.frame !== frame.id) continue;
      if (obligation.kind === "asserted_at_source") {
        if (!keys.has(leafKey({ leaf_kind: "h_assertion_permission", occurrence: hid }))) return undefined;
      } else if (obligation.kind === "explicit_embedded_structure") {
        if (!keys.has(leafKey({ leaf_kind: "h_content", occurrence: hid }))) return undefined;
      } else if (interpretation.asserted_at_scope.includes(hid)) {
        return undefined;
      }
    }
    bindings[frame.variable] = hid;
    for (const role of frame.role_requirements) {
      const slot = correspondence(alignment, {
        kind: "slot", alternative: alt, frame: frame.id, slot: role.id
      }, undefined);
      if (slot === undefined || slot.correspondence.source_endpoint.kind !== "slot") return undefined;
      const sourceSlot = slot.correspondence.source_endpoint;
      if (sourceSlot.frame !== hid) return undefined;
      if (!keys.has(leafKey({
            leaf_kind: "a_slot", occurrence: hid, slot_id: sourceSlot.slot,
            correspondence_index: slot.index
          })) ||
          !keys.has(leafKey({ leaf_kind: "h_binding", occurrence: hid, slot_id: sourceSlot.slot }))) {
        return undefined;
      }
      const binding = hFrame.bindings.find((row) => row.slot_id === sourceSlot.slot);
      if (binding === undefined || binding.target.kind !== "node") return undefined;
      bindings[role.target_variable] = binding.target.id;
    }
  }
  return bindings;
}

function bindingKey(bindings: Readonly<Record<string, string>>, variables: readonly string[]): string {
  return variables.map((id) => `${id}=${bindings[id] ?? ""}`).join(";");
}

export function oracleBindingsMatchEngine(
  oracle: SourceSemanticOracleResult,
  decoded: readonly Readonly<Record<string, string>>[],
  variables: readonly string[]
): boolean {
  const left = new Set(oracle.assignments.map((row) => bindingKey(assignmentBindings(row, variables), variables)));
  const right = new Set(decoded.map((row) => bindingKey(assignmentBindings({
    bindings: row, leaves: []
  }, variables), variables)));
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function oracleNecessaryLeavesHeld(
  oracle: SourceSemanticOracleResult,
  engineLeaves: readonly SourceSemanticConsumedLeaf[]
): boolean {
  if (oracle.assignments.length === 0) return engineLeaves.length === 0;
  const engineKeys = new Set(engineLeaves.map(leafKey));
  return oracle.assignments.every((row) => row.leaves.every((leaf) => engineKeys.has(leafKey(leaf))));
}
