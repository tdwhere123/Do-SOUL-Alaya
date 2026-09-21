import { SourceSemanticResourceLedger, type QueryProgram, type SourceSemanticQuery, type SourceSemanticQueryAlternative,
  type SourceSemanticAlignment, type SourceSemanticInterpretation } from "@do-soul/alaya-protocol";
import { CoreError } from "../../../shared/errors.js";
import { sourceSemanticRelationKey as key, alignmentGroupPhases, alignmentPredicateKey, alignmentSlotKey,
  type SourceSemanticPremisePopulation } from "../../runtime/source-semantic-premises.js";
import { semanticInstanceProof } from "./source-semantic-proof-program.js";

const GUARD = { schema_version: 1 as const, kind: "query_predicate" as const, verdict: "unresolved" as const, time_scope: "none" as const };
type Edge = Readonly<{ from: string; to: string; forward: string; backward: string }>;
type Graph = Readonly<{ edges: readonly Edge[]; properties: ReadonlyMap<string, readonly string[]> }>;

/** Finite graph walk; every conjunct is visited, including reverse and non-tree edges. */
export type SourceSemanticCompilation = Readonly<{
  h: SourceSemanticInterpretation; population: SourceSemanticPremisePopulation; alignment?: SourceSemanticAlignment;
}>;

export function compileSourceSemanticQueryProgram(query: SourceSemanticQuery, meter: SourceSemanticResourceLedger,
  finite?: SourceSemanticCompilation): QueryProgram {
  meter.retain(query, "query compilation");
  let acceptIndex = 0;
  const options = query.alternatives.flatMap((alternative, index) => {
    const frames = alignmentGroupPhases(query, finite?.alignment, index);
    return frames.map((group) => compileSourceSemanticAlternative(query, alternative, index, meter, finite, false, group, acceptIndex++));
  });
  return options.length === 1 ? options[0]! : { schema_version: 1, kind: "alternative", options };
}

/** One jointly constrained walk; callers observe each group separately so kinds do not union. */
export function compileSourceSemanticGroupProgram(query: SourceSemanticQuery, alternative: SourceSemanticQueryAlternative,
  alt: number, meter: SourceSemanticResourceLedger, finite: SourceSemanticCompilation | undefined,
  groupFrame: string | undefined, acceptIndex: number): QueryProgram {
  return compileSourceSemanticAlternative(query, alternative, alt, meter, finite, false, groupFrame, acceptIndex);
}

function rel(predicate: string, from: string, to: string, meter: SourceSemanticResourceLedger): QueryProgram {
  meter.charge(1, 512 + 4 * (predicate.length + from.length + to.length), "query lowering");
  return { schema_version: 1, kind: "relation", relation_kind: predicate, source_variable: from, target_variable: to,
    guard: GUARD, facet_mode: "same_path", threshold_milligrades: 0 };
}

export function compileSourceSemanticAlternative(q: SourceSemanticQuery, alternative: SourceSemanticQueryAlternative, alt: number,
  meter: SourceSemanticResourceLedger, finite?: SourceSemanticCompilation, omitAccept = false, groupFrame?: string,
  acceptIndex?: number): QueryProgram {
  const graph = buildGraph(q, alternative, alt, meter, groupFrame);
  const root = alternative.frames[0]!.variable;
  const seed = groupFrame === undefined ? `@seed:${alt}` : `@seed:${alt}:${groupFrame}`;
  const steps = [rel(key("candidate_route"), seed, root, meter)];
  const adjacency = new Map<string, number[]>();
  graph.edges.forEach((edge, index) => {
    for (const variable of new Set([edge.from, edge.to])) {
      const rows = adjacency.get(variable) ?? []; rows.push(index); adjacency.set(variable, rows);
    }
  });
  const visited = new Set<string>(), edgesSeen = new Set<number>();
  const enter = (variable: string) => {
    visited.add(variable);
    const properties = graph.properties.get(variable) ?? [];
    for (const predicate of properties) {
      if (finite !== undefined && predicate === key("h_entailed_permission")) {
        steps.push(semanticInstanceProof(variable, finite.population, finite.h, meter, true));
      } else {
        steps.push(rel(predicate === key("h_entailed_permission") ? key("h_assertion_permission") : predicate, variable, variable, meter));
      }
    }
    if (finite !== undefined && finite.population.instances.size > 0 && properties.includes(key("h_presence"))
      && !properties.includes(key("h_entailed_permission"))) {
      steps.push(semanticInstanceProof(variable, finite.population, finite.h, meter));
    }
  };
  type Visit = { variable: string; next: number; back?: { predicate: string; target: string } };
  const stack: Visit[] = [{ variable: root, next: 0 }];
  enter(root);
  while (stack.length > 0) {
    meter.charge(1, 0, "query traversal");
    const visit = stack.at(-1)!;
    const neighbors = adjacency.get(visit.variable) ?? [];
    if (visit.next >= neighbors.length) {
      stack.pop();
      if (visit.back !== undefined) steps.push(rel(visit.back.predicate, visit.variable, visit.back.target, meter));
      continue;
    }
    const index = neighbors[visit.next++]!;
    if (edgesSeen.has(index)) continue;
    edgesSeen.add(index);
    const edge = graph.edges[index]!, forward = edge.from === visit.variable;
    const target = forward ? edge.to : edge.from;
    const predicate = forward ? edge.forward : edge.backward, reverse = forward ? edge.backward : edge.forward;
    steps.push(rel(predicate, visit.variable, target, meter));
    if (visited.has(target)) steps.push(rel(reverse, target, visit.variable, meter));
    else { enter(target); stack.push({ variable: target, next: 0, back: { predicate: reverse, target: visit.variable } }); }
  }
  if (edgesSeen.size !== graph.edges.length || [...graph.properties.keys()].some((id) => !visited.has(id))) {
    throw new CoreError("OBLIGATION_VIOLATION", "query lowering omitted an atomic obligation");
  }
  if (!omitAccept) steps.push(rel(key("accept"), root, `@accepted:${acceptIndex ?? alt}`, meter));
  return sequence(steps);
}

function sequence(steps: readonly QueryProgram[]): QueryProgram {
  if (steps.length === 1) return steps[0]!;
  if (steps.length <= 64) return { schema_version: 1, kind: "sequence", steps };
  const groups: QueryProgram[] = [];
  for (let offset = 0; offset < steps.length; offset += 64) groups.push(sequence(steps.slice(offset, offset + 64)));
  return sequence(groups);
}

function buildGraph(query: SourceSemanticQuery, alternative: SourceSemanticQueryAlternative, alt: number,
  meter: SourceSemanticResourceLedger, groupFrame?: string): Graph {
  const edges: Edge[] = [], properties = new Map<string, string[]>();
  const addKey = (variable: string, predicate: string) => {
    meter.charge(1, 512, "query obligation");
    const list = properties.get(variable) ?? []; list.push(predicate); properties.set(variable, list);
  };
  const add = (variable: string, ...parts: readonly (string | number)[]) => addKey(variable, key(...parts));
  const edge = (from: string, to: string, forward: string, backward: string) => {
    meter.charge(1, 1024, "query incidence"); edges.push({ from, to, forward, backward });
  };
  const used = new Set<string>(), byFrame = new Map(alternative.frames.map((frame) => [frame.id, frame]));
  for (const [fi, frame] of alternative.frames.entries()) {
    used.add(frame.variable); add(frame.variable, "h_presence");
    if (frame.operator === undefined) addKey(frame.variable, alignmentPredicateKey(alt, frame.id, groupFrame));
    else add(frame.variable, "h_operator", frame.operator);
    if (frame.source_act !== undefined) add(frame.variable, "source_act", frame.source_act);
    for (const [ri, role] of frame.role_requirements.entries()) {
      used.add(role.target_variable);
      if (frame.operator === "reported") {
        edge(frame.variable, role.target_variable, key("h_content", "operator_operand", "reporter"), key("h_content_inv", "operator_operand", "reporter"));
      } else {
        const slot = groupFrame === undefined ? `@slot:${alt}:${fi}:${ri}` : `@slot:${alt}:${fi}:${ri}:${groupFrame}`;
        edge(frame.variable, slot, alignmentSlotKey("a_slot", alt, frame.id, role.id, groupFrame),
          alignmentSlotKey("a_slot_inv", alt, frame.id, role.id, groupFrame));
        edge(slot, role.target_variable, key("h_binding"), key("h_binding_inv"));
      }
    }
  }
  for (const obligation of alternative.context_obligations) {
    const frame = byFrame.get(obligation.frame)!;
    add(frame.variable, obligation.kind === "asserted_at_source" ? "h_assertion_permission"
      : obligation.kind === "entailed_at_source" ? "h_entailed_permission"
      : obligation.kind === "explicit_embedded_structure" ? "h_embedded" : "open_context");
    if (obligation.incidence !== undefined) {
      const incidence = obligation.incidence;
      edge(byFrame.get(incidence.other_frame)!.variable, frame.variable,
        key("h_content", incidence.kind, incidence.role ?? "content"), key("h_content_inv", incidence.kind, incidence.role ?? "content"));
    }
  }
  for (const variable of query.variables) {
    if (!used.has(variable.id)) continue;
    add(variable.id, "h_sort", variable.sort);
    if (variable.reference !== undefined) add(variable.id, "a_referent", variable.id);
  }
  return { edges, properties };
}
