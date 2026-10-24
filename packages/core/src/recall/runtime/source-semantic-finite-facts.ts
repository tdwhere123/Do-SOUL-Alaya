import {
  compareSourceSemanticDecimals, canonicalJson, type SourceSemanticCorrespondence, type SourceSemanticInterpretation,
  type SourceSemanticMeasurement, type SourceSemanticConsumedLeaf
} from "@do-soul/alaya-protocol";
import { type PremiseBuilder, sourceSemanticRelationKey as key, sourceSemanticDerivedNodeId } from "./source-semantic-premises.js";

function semanticOwnerPath(sourceInterpretation: SourceSemanticInterpretation, ownerId: string): readonly string[] {
  const rows = new Map([...sourceInterpretation.frames, ...sourceInterpretation.operators].map((row) => [row.id, row]));
  const path: string[] = [];
  let row = rows.get(ownerId);
  while (row !== undefined && row.context_owner.kind !== "source_act") {
    const owner = row.context_owner;
    const parent = owner.kind === "embedding" ? owner.parent_frame : owner.operator_handle;
    path.push(parent); row = rows.get(parent);
  }
  return path;
}

/** These are evidence atoms and arithmetic primitives, never selected answers or ranking seeds. */
export function populateSourceSemanticFiniteFacts(builder: PremiseBuilder, sourceInterpretation: SourceSemanticInterpretation,
  semantic_correspondence: SourceSemanticCorrespondence): void {
  for (const domain of sourceInterpretation.domains ?? []) {
    builder.node(domain.id);
    builder.self(domain.id, ["source_interpretation_domain", domain.id], { leaf_kind: "source_interpretation_domain", domain: domain.id });
    builder.self(domain.id, ["accept"]);
    // Domain routing chooses one neutral entry; evidence permission is checked separately.
    if (sourceInterpretation.entry_roots[0] !== undefined) builder.edge(sourceInterpretation.entry_roots[0], domain.id, key("candidate_route"));
    for (const member of domain.members) {
      const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "source_interpretation_membership", occurrence: member.evidence,
        domain: domain.id, member: member.referent };
      builder.edge(domain.id, member.referent, key("domain_member", member.referent), leaf);
      builder.edge(member.referent, member.evidence, key("domain_member_evidence", domain.id), leaf);
      builder.edge(member.evidence, domain.id, key("domain_member_return", domain.id));
    }
    if (domain.closure.kind === "closed") {
      builder.edge(domain.id, domain.closure.evidence, key("domain_closed"), { leaf_kind: "source_interpretation_closure",
        domain: domain.id, occurrence: domain.closure.evidence });
      builder.edge(domain.closure.evidence, domain.id, key("domain_closed_inv"));
    }
    for (const [index, mapping] of (semantic_correspondence.domains ?? []).entries()) if (mapping.source_domain === domain.id) {
      builder.self(domain.id, ["semantic_correspondence_domain", mapping.query_domain], { leaf_kind: "semantic_correspondence_domain", domain: domain.id, correspondence_index: index });
    }
    for (const id of [...sourceInterpretation.frames, ...sourceInterpretation.operators].map((row) => row.id).concat([...builder.instances.keys()])) {
      builder.edge(domain.id, id, key("candidate_route"));
      builder.edge(id, domain.id, key("domain_return", domain.id));
    }
  }
  for (const row of sourceInterpretation.referents) builder.self(row.id, ["source_interpretation_identity", row.id]);
  for (const row of builder.derivedNodes) if (row.kind === "query_entity") builder.self(row.node_id, ["source_interpretation_identity", row.node_id]);
  for (const value of sourceInterpretation.measurements ?? []) {
    builder.node(value.id);
    builder.edge(value.id, value.owner, key("measurement_owner"), measurementLeaf(value));
    builder.edge(value.owner, value.id, key("measurement_owner_inv"), measurementLeaf(value));
    builder.edge(value.id, value.subject, key("measurement_subject"), measurementLeaf(value));
    builder.edge(value.subject, value.id, key("measurement_subject_inv"), measurementLeaf(value));
    builder.self(value.id, ["source_interpretation_measurement", value.id], measurementLeaf(value));
    const domain = sourceInterpretation.domains!.find((row) => row.id === value.population)!;
    builder.input.meter.charge(sourceInterpretation.domains!.length + domain.members.length, 0, "measurement membership lookup");
    const member = domain.members.find((row) => row.referent === value.subject);
    if (member !== undefined) {
      const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "source_interpretation_membership", occurrence: member.evidence,
        domain: domain.id, member: member.referent };
      builder.edge(value.id, member.evidence, key("measurement_membership"), leaf);
      builder.edge(member.evidence, value.id, key("measurement_membership_inv"), leaf);
    }
    for (const [index, assumption] of (semantic_correspondence.membership_assumptions ?? []).entries()) {
      builder.input.meter.charge(1 + semantic_correspondence.correspondences.length, 0, "measurement assumed membership");
      if (assumption.status !== "member" || assumption.source_domain !== domain.id) continue;
      if (!semantic_correspondence.correspondences.some((row) => row.query_endpoint.kind === "referent"
        && row.query_endpoint.variable === assumption.query_variable && row.source_endpoint.kind === "referent"
        && row.source_endpoint.referent === value.subject)) continue;
      builder.edge(value.id, value.subject, key("measurement_assumed_membership", assumption.query_variable),
        { leaf_kind: "semantic_correspondence_membership", domain: domain.id, member: value.subject, assumption_index: index });
      builder.edge(value.subject, value.id, key("measurement_assumed_membership_inv", assumption.query_variable));
    }
  }
  const query = builder.input.query, evaluation = query?.evaluation;
  if (query === undefined || evaluation?.kind !== "comparison") return;
  builder.input.meter.charge(semantic_correspondence.domains?.length ?? 0, 0, "numeric domain demand");
  const population = semantic_correspondence.domains?.find((row) => row.query_domain === evaluation.domain)?.source_domain;
  if (population === undefined) return;
  // Only a named, aligned referent constrains an operand. Free operands and extrema
  // still range over every measurement in the demanded population, including
  // incompatible signatures needed for an incomparable conclusion.
  const referents = (variable: string): ReadonlySet<string> | undefined => {
    if (query.variables.find((row) => row.id === variable)?.reference === undefined) return undefined;
    builder.input.meter.charge(semantic_correspondence.correspondences.length, 0, "numeric operand demand");
    const aligned = new Set<string>();
    for (const row of semantic_correspondence.correspondences) {
      if (row.query_endpoint.kind === "referent" && row.query_endpoint.variable === variable
        && row.source_endpoint.kind === "referent") aligned.add(row.source_endpoint.referent);
    }
    if (aligned.size === 0) return undefined;
    builder.input.meter.retain([...aligned], "numeric operand alignment");
    return aligned;
  };
  const leftSubjects = "right" in evaluation ? referents(evaluation.left) : undefined;
  const rightSubjects = "right" in evaluation ? referents(evaluation.right) : undefined;
  const values = (sourceInterpretation.measurements ?? []).filter((row) => {
    builder.input.meter.charge(1, 0, "numeric comparison demand scan");
    return row.population === population;
  });
  const leftValues = leftSubjects === undefined ? values : values.filter((row) => leftSubjects.has(row.subject));
  const rightValues = rightSubjects === undefined ? values : values.filter((row) => rightSubjects.has(row.subject));
  const ownerPaths = new Map<string, string>();
  for (const value of [...leftValues, ...rightValues]) {
    if (ownerPaths.has(value.owner)) continue;
    builder.input.meter.charge(sourceInterpretation.frames.length + sourceInterpretation.operators.length, 0, "measurement scope indexing");
    ownerPaths.set(value.owner, canonicalJson(semanticOwnerPath(sourceInterpretation, value.owner)));
  }
  for (const left of leftValues) for (const right of rightValues) {
    builder.input.meter.charge(1, 0, "numeric pair preparation");
    const id = comparisonNodeId(left.id, right.id);
    builder.node(id); builder.self(id, ["accept"]);
    builder.self(id, [left.subject === right.subject ? "numeric_same_subject" : "numeric_distinct_subject"]);
    builder.derivedNodes.push({ kind: "comparison", node_id: id, left: left.id, right: right.id });
    const matchesQuery = (row: SourceSemanticMeasurement) => row.metric === evaluation.metric
      && row.unit === evaluation.unit && row.context === evaluation.context;
    const compatible = left.metric === right.metric && left.unit === right.unit && left.context === right.context
      && matchesQuery(left) && matchesQuery(right)
      && ownerPaths.get(left.owner) === ownerPaths.get(right.owner);
    const comparison = compatible ? compareSourceSemanticDecimals(left.value, right.value) : null;
    const order = comparison === null ? "incomparable" : comparison < 0 ? "lt" : comparison > 0 ? "gt" : "eq";
    builder.self(id, ["numeric_order", order], { leaf_kind: "source_interpretation_numeric_order", measurement: left.id,
      other_measurement: right.id, value: order, domain: left.population, derived_node: id });
    builder.edge(id, left.id, key("numeric_left")); builder.edge(left.id, id, key("numeric_left_inv"));
    builder.edge(id, right.id, key("numeric_right")); builder.edge(right.id, id, key("numeric_right_inv"));
    builder.edge(left.population, id, key("candidate_route"));
    builder.edge(id, left.population, key("domain_return", left.population));
  }
}

function comparisonNodeId(left: string, right: string): string { return sourceSemanticDerivedNodeId("compare", left, right); }

function measurementLeaf(value: SourceSemanticMeasurement): SourceSemanticConsumedLeaf {
  return { leaf_kind: "source_interpretation_measurement", occurrence: value.owner, measurement: value.id,
    member: value.subject, domain: value.population,
    decimal_value: value.value, metric: value.metric, unit: value.unit, measurement_context: value.context };
}
