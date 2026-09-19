import type { SourceSemanticResourceLedger } from "./source-semantic-resources.js";

/** Precharge canonical graph refinement's repeated context walks and incidence scans.
 * Input traversal/copies are separately retained by each admission owner. This accepts
 * unparsed input so no graph refinement runs before its work is reserved.
 */
export function chargeSourceSemanticValidation(value: unknown, meter: SourceSemanticResourceLedger): void {
  const graph = record(value), frames = rows(graph.frames), operators = rows(graph.operators);
  const nodes = frames.length + operators.length;
  let edges = 0, variables = 0, quantifiers = 0, restrictions = 0, membershipWork = 0;
  for (const frameValue of frames) {
    const frame = record(frameValue);
    if (record(frame.context_owner).kind === "embedding") edges += 1;
    for (const binding of rows(frame.bindings)) if (record(record(binding).target).kind === "bound_variable") variables += 1;
  }
  for (const operatorValue of operators) {
    const operator = record(operatorValue);
    if (record(operator.context_owner).kind === "embedding") edges += 1;
    if (operator.operator === "forall") quantifiers += 1;
    edges += operator.operator === "conditional" ? 2 : operator.operator === "opaque" ? rows(operator.operands).length
      : 1 + (operator.operator === "forall" && operator.restriction != null ? 1 : 0)
        + (operator.operator === "reported" && operator.reporter !== undefined ? 1 : 0);
  }
  for (const domainValue of rows(graph.domains)) {
    const domain = record(domainValue), members = rows(domain.members);
    membershipWork += (members.length + rows(domain.exclusions).length) ** 2;
    for (const member of members) restrictions += rows(record(member).restrictions).length;
  }
  const measurements = rows(graph.measurements).length;
  const walks = quantifiers * (operators.length + frames.length + 1) + variables + measurements;
  const gapLookups = rows(graph.gaps).length * (rows(graph.mentions).length + rows(graph.referents).length + nodes);
  const work = nodes * (nodes + edges) + walks * (2 * nodes + 8) + restrictions * operators.length
    + membershipWork + measurements * 128 + gapLookups;
  meter.charge(work, (nodes + edges) * 128 + walks * nodes * 64 + gapLookups * 32, "canonical graph refinement");
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function rows(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
