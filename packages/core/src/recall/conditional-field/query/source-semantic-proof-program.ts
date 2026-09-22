import {
  sourceSemanticStructuralEdges, type SourceSemanticInterpretation, type QueryProgram,
  type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";
import { sourceSemanticRelationKey as key, type SourceSemanticPremisePopulation } from "../../runtime/source-semantic-premises.js";

const GUARD = { schema_version: 1 as const, kind: "query_predicate" as const, verdict: "unresolved" as const, time_scope: "none" as const };
export const emptySemanticProgram: QueryProgram = { schema_version: 1, kind: "empty" };

export function semanticRelation(predicate: string, from: string, to: string, meter: SourceSemanticResourceLedger): QueryProgram {
  meter.charge(1, 512 + 4 * (predicate.length + from.length + to.length), "query lowering");
  return { schema_version: 1, kind: "relation", relation_kind: predicate, source_variable: from, target_variable: to,
    guard: GUARD, facet_mode: "same_path", threshold_milligrades: 0 };
}

export function semanticSequence(steps: readonly QueryProgram[]): QueryProgram {
  if (steps.length === 0) return { schema_version: 1, kind: "epsilon" };
  if (steps.length === 1) return steps[0]!;
  if (steps.length <= 64) return { schema_version: 1, kind: "sequence", steps };
  const groups: QueryProgram[] = [];
  for (let offset = 0; offset < steps.length; offset += 64) groups.push(semanticSequence(steps.slice(offset, offset + 64)));
  return semanticSequence(groups);
}

export function semanticAlternatives(options: readonly QueryProgram[]): QueryProgram {
  if (options.length === 0) return emptySemanticProgram;
  if (options.length === 1) return options[0]!;
  if (options.length <= 64) return { schema_version: 1, kind: "alternative", options };
  const groups: QueryProgram[] = [];
  for (let offset = 0; offset < options.length; offset += 64) groups.push(semanticAlternatives(options.slice(offset, offset + 64)));
  return semanticAlternatives(groups);
}

/** Follow the actual scope path and return. Negative/antecedent content cannot supply positive facts. */
export function semanticOwnerProof(sourceInterpretation: SourceSemanticInterpretation, occurrence: string, variable: string,
  meter: SourceSemanticResourceLedger, preserve: boolean): QueryProgram {
  meter.charge((sourceInterpretation.frames.length + sourceInterpretation.operators.length) * 2, 0, "proof scope indexing");
  const rows = new Map([...sourceInterpretation.frames, ...sourceInterpretation.operators].map((row) => [row.id, row]));
  const incoming = new Map(sourceSemanticStructuralEdges(sourceInterpretation).filter((row) => row.governing).map((row) => [row.to, row]));
  const forward: QueryProgram[] = [], backward: QueryProgram[] = [];
  let id = occurrence, current = variable, depth = 0;
  while (incoming.has(id)) {
    if (!preserve) return emptySemanticProgram;
    const edge = incoming.get(id)!, parent = rows.get(edge.from)!;
    if ("operator" in parent && (parent.operator === "not" || parent.operator === "opaque"
      || parent.operator === "conditional" && edge.role === "antecedent")) return emptySemanticProgram;
    const next = `${variable}:owner${depth++}`;
    forward.push(semanticRelation(key("source_interpretation_content_inverse", edge.kind, edge.role), current, next, meter));
    if ("operator" in parent) forward.push(semanticRelation(key("source_interpretation_operator", parent.operator), next, next, meter));
    backward.unshift(semanticRelation(key("source_interpretation_content", edge.kind, edge.role), next, current, meter));
    current = next; id = edge.from;
  }
  return semanticSequence([...forward, semanticRelation(key("source_interpretation_assertion_permission"), current, current, meter), ...backward]);
}

export function semanticInstanceProof(variable: string, population: SourceSemanticPremisePopulation,
  sourceInterpretation: SourceSemanticInterpretation, meter: SourceSemanticResourceLedger, entailment = false): QueryProgram {
  const options: QueryProgram[] = [semanticRelation(key(entailment ? "source_interpretation_assertion_permission" : "source_interpretation_original"), variable, variable, meter)];
  let ordinal = 0;
  for (const [nodeId, instance] of population.instances) {
    meter.charge(1, 0, "instance proof alternatives");
    if (entailment && !instance.root) continue;
    if (instance.restriction !== null && instance.restrictionEvidence === undefined && !instance.restrictionAssumed) continue;
    const rule = `@gate:${variable}:${ordinal}:rule`, evidence = `@gate:${variable}:${ordinal}:evidence`;
    const restrictionEvidence = `@gate:${variable}:${ordinal}:restriction`;
    ordinal++;
    const steps = [semanticRelation(key("source_interpretation_instance", nodeId), variable, variable, meter),
      semanticRelation(key("instance_rule"), variable, rule, meter),
      semanticRelation(key(entailment ? "source_interpretation_assertion_permission" : "source_interpretation_presence"), rule, rule, meter),
      semanticRelation(key("instance_rule_inv"), rule, variable, meter)];
    if (instance.assumption !== undefined) steps.push(semanticRelation(key("instance_assumption"), variable, variable, meter));
    if (instance.evidence !== undefined) steps.push(
      semanticRelation(key("instance_member"), variable, evidence, meter),
      semanticOwnerProof(sourceInterpretation, instance.evidence, evidence, meter, instance.context !== null),
      semanticRelation(key("instance_member_inv"), evidence, variable, meter));
    else if (instance.assumption === undefined) continue;
    if (instance.restrictionEvidence !== undefined) steps.push(
      semanticRelation(key("instance_restriction"), variable, restrictionEvidence, meter),
      semanticOwnerProof(sourceInterpretation, instance.restrictionEvidence, restrictionEvidence, meter, instance.context !== null),
      semanticRelation(key("instance_restriction_inv"), restrictionEvidence, variable, meter));
    options.push(semanticSequence(steps));
  }
  return semanticAlternatives(options);
}
