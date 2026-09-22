import {
  sourceSemanticContextContains,
  type SourceSemanticCorrespondence, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticFrame, type SourceSemanticOperator, type SourceSemanticContextOwner
} from "@do-soul/alaya-protocol";
import {
  type PremiseBuilder, populateOccurrences, populateStructure, populateBindings, sourceSemanticRelationKey as key,
  sourceSemanticDerivedNodeId as derivedId
} from "./source-semantic-premises.js";

export type SourceSemanticInstance = Readonly<{
  quantifier: string; domain: string; member: string; template: string;
  evidence?: string; assumption?: number; restriction: string | null; restrictionEvidence?: string;
  restrictionAssumed: boolean; context: string | null; root: boolean;
}>;

/** Candidate substitution is structural. Permissions are proved by the query's instance gate. */
export function groundSourceSemanticInstances(builder: PremiseBuilder, h: SourceSemanticInterpretation,
  semantic_correspondence: SourceSemanticCorrespondence, query?: SourceSemanticQuery): void {
  const meter = builder.input.meter, occurrenceCount = h.frames.length + h.operators.length;
  for (const [index, assumption] of (semantic_correspondence.membership_assumptions ?? []).entries()) {
    meter.charge(1 + (query?.variables.length ?? 0) + semantic_correspondence.correspondences.length, 0, "assumed member admission");
    const variable = query?.variables.find((row) => row.id === assumption.query_variable);
    if (variable?.reference === undefined || assumption.status !== "member") continue;
    if (semantic_correspondence.correspondences.some((row) => row.query_endpoint.kind === "referent"
      && row.query_endpoint.variable === variable.id)) continue;
    const id = derivedId("query", variable.id);
    if (!builder.coordinates.has(id)) {
      builder.node(id); builder.derivedNodes.push({ kind: "query_entity", node_id: id,
        query_variable: variable.id, excerpt: variable.reference.excerpt });
      builder.self(id, ["source_interpretation_sort", "entity"], { leaf_kind: "source_interpretation_sort", occurrence: id, value: "entity" });
    }
    builder.self(id, ["semantic_correspondence_referent", variable.id], { leaf_kind: "semantic_correspondence_membership", occurrence: id,
      assumption_index: index, domain: assumption.source_domain });
  }
  for (const operator of h.operators) {
    meter.charge(1, 0, "quantifier enumeration");
    if (operator.operator !== "forall") continue;
    meter.charge(occurrenceCount * 2 + (h.domains?.length ?? 0), 0, "quantifier scope lookup");
    if (nonMonotoneOwner(h, operator.id)) continue;
    const domain = h.domains!.find((row) => row.id === operator.domain)!;
    const members: Omit<SourceSemanticInstance, "template" | "root">[] = domain.members.map((row) => ({
      quantifier: operator.id, domain: domain.id, member: row.referent, evidence: row.evidence,
      restriction: operator.restriction, restrictionEvidence: row.restrictions.find((item) => item.restriction === operator.restriction)?.evidence,
      restrictionAssumed: false, context: domain.context
    }));
    for (const [index, assumption] of (semantic_correspondence.membership_assumptions ?? []).entries()) {
      meter.charge(1 + semantic_correspondence.correspondences.length + members.length, 0, "conditional member enumeration");
      if (assumption.status !== "member" || assumption.source_domain !== domain.id) continue;
      const correspondence = semantic_correspondence.correspondences.find((row) => row.query_endpoint.kind === "referent"
        && row.query_endpoint.variable === assumption.query_variable)?.source_endpoint;
      const member = correspondence?.kind === "referent" ? correspondence.referent : derivedId("query", assumption.query_variable);
      const existing = members.findIndex((row) => row.member === member);
      if (existing >= 0) {
        if (operator.restriction !== null && members[existing]!.restrictionEvidence === undefined
          && assumption.restrictions.includes(operator.restriction)) {
          members[existing] = { ...members[existing]!, assumption: index, restrictionAssumed: true };
        }
        continue;
      }
      members.push({ quantifier: operator.id, domain: domain.id, member, assumption: index,
        restriction: operator.restriction, restrictionAssumed: operator.restriction !== null && assumption.restrictions.includes(operator.restriction),
        context: domain.context });
    }
    const templates = [...h.frames, ...h.operators].filter((row) => {
      meter.charge(occurrenceCount * 2, 0, "quantifier body scope");
      return sourceSemanticContextContains(h, operator.content, row.id);
    });
    for (const member of members) instantiate(builder, h, operator, templates, member);
  }
}

function nonMonotoneOwner(h: SourceSemanticInterpretation, start: string): boolean {
  const occurrences = new Map([...h.frames, ...h.operators].map((row) => [row.id, row]));
  let child = occurrences.get(start);
  while (child !== undefined && child.context_owner.kind !== "source_act") {
    const owner = child.context_owner;
    const parent = occurrences.get(owner.kind === "embedding" ? owner.parent_frame : owner.operator_handle);
    if (parent !== undefined && "operator" in parent && (parent.operator === "not" || parent.operator === "opaque"
      || parent.operator === "conditional" && parent.antecedent === child.id)) return true;
    child = parent;
  }
  return false;
}

function instantiate(builder: PremiseBuilder, h: SourceSemanticInterpretation,
  quantifier: Extract<SourceSemanticOperator, { operator: "forall" }>,
  templates: readonly (SourceSemanticFrame | SourceSemanticOperator)[], member: Omit<SourceSemanticInstance, "template" | "root">): void {
  const ids = new Map(templates.map((row) => [row.id, derivedId("instance", quantifier.id, member.member, row.id)]));
  const id = (value: string) => ids.get(value) ?? value;
  const owner = (value: SourceSemanticContextOwner): SourceSemanticContextOwner => value.kind === "embedding"
    ? { ...value, parent_frame: id(value.parent_frame), content_argument: id(value.content_argument) }
    : value.kind === "operator" ? { ...value, operator_handle: id(value.operator_handle) } : value;
  const frames: SourceSemanticFrame[] = [], operators: SourceSemanticOperator[] = [];
  for (const template of templates) {
    builder.input.meter.charge(1, 2048, "universal substitution");
    const nodeId = id(template.id);
    builder.node(nodeId); builder.aliases.set(nodeId, template.id);
    builder.instances.set(nodeId, { ...member, template: template.id, root: template.id === quantifier.content });
    builder.derivedNodes.push({ kind: "instantiation", node_id: nodeId, template: template.id,
      quantifier: quantifier.id, binder: quantifier.binder, member: member.member });
    if ("operator" in template) {
      const base = { ...template, id: nodeId, context_owner: owner(template.context_owner) };
      if (base.operator === "conditional") operators.push({ ...base, antecedent: id(base.antecedent), consequent: id(base.consequent) });
      else if (base.operator === "opaque") operators.push({ ...base, operands: base.operands.map(id) });
      else operators.push({ ...base, content: id(base.content) });
    } else {
      const frame: SourceSemanticFrame = { ...template, id: nodeId, context_owner: owner(template.context_owner),
        bindings: template.bindings.map((binding) => ({ ...binding, target: binding.target.kind === "bound_variable"
          && binding.target.quantifier === quantifier.id && binding.target.binder === quantifier.binder
          ? { kind: "node" as const, id: member.member } : binding.target.kind === "node"
            ? { kind: "node" as const, id: id(binding.target.id) } : binding.target })) };
      frames.push(frame);
      for (const slot of frame.slots) {
        const slotId = derivedId("slot", nodeId, slot.id);
        builder.node(slotId); builder.slotNodes.set(JSON.stringify([nodeId, slot.id]), slotId);
        builder.derivedNodes.push({ kind: "instance_slot", node_id: slotId, instance: nodeId, slot_id: slot.id });
      }
    }
    builder.self(nodeId, ["source_interpretation_instance", nodeId], { leaf_kind: "source_interpretation_instantiation", occurrence: template.id,
      derived_node: nodeId, quantifier: quantifier.id, binder: quantifier.binder, member: member.member });
    builder.edge(nodeId, quantifier.id, key("instance_rule")); builder.edge(quantifier.id, nodeId, key("instance_rule_inv"));
    const evidence = (target: string, label: string, kind: "source_interpretation_membership" | "source_interpretation_restriction") => {
      const leaf = { leaf_kind: kind, occurrence: target, domain: member.domain, member: member.member };
      builder.edge(nodeId, target, key(label), leaf); builder.edge(target, nodeId, key(`${label}_inv`), leaf);
    };
    if (member.evidence !== undefined) evidence(member.evidence, "instance_member", "source_interpretation_membership");
    if (member.restrictionEvidence !== undefined) evidence(member.restrictionEvidence, "instance_restriction", "source_interpretation_restriction");
    if (member.assumption !== undefined) builder.self(nodeId, ["instance_assumption"], { leaf_kind: "semantic_correspondence_membership",
      occurrence: nodeId, domain: member.domain, member: member.member, assumption_index: member.assumption });
  }
  const virtual = { ...h, frames, operators, referents: [], entry_roots: [], asserted_at_scope: [] };
  populateOccurrences(builder, virtual); populateStructure(builder, virtual); populateBindings(builder, virtual);
  const contentId = id(quantifier.content);
  const contentLeaf = { leaf_kind: "source_interpretation_content" as const, occurrence: contentId, parent: quantifier.id,
    relation_kind: "operator_operand" as const, role: "content" as const };
  builder.edge(quantifier.id, contentId, key("source_interpretation_content", "operator_operand", "content"), contentLeaf);
  builder.edge(contentId, quantifier.id, key("source_interpretation_content_inverse", "operator_operand", "content"), contentLeaf);
  builder.self(contentId, ["source_interpretation_embedded"], contentLeaf);
  for (const root of h.entry_roots) {
    builder.input.meter.charge(h.frames.length + h.operators.length, 0, "instance source routing");
    if (!sourceSemanticContextContains(h, root, quantifier.id)) continue;
    for (const nodeId of ids.values()) builder.edge(root, nodeId, key("candidate_route"));
  }
}
