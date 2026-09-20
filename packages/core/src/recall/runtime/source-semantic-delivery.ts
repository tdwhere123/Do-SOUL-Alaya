import {
  interpretationNodeIdentity, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type InformationIndex, type SourceSemanticQuery, type SourceSemanticAnswer,
  type SourceSemanticConsumedLeaf, type InterpretationNodeCoordinate, type SourceSemanticEvaluationReport
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseBindingContext, type BindingContextStore } from "../conditional-field/engine/binding-environment.js";
import type { SourceSemanticPremisePopulation } from "./source-semantic-premises.js";
import type { SourceSemanticExecutionPlan, SourceSemanticProofBranch } from "../conditional-field/query/compile-source-semantic-finite.js";

/** Project actual engine environments, never reconstruct bindings from H/A or a leaf bag. */
export function deliverSourceSemanticProof(input: Readonly<{
  index: InformationIndex;
  query: SourceSemanticQuery;
  population: SourceSemanticPremisePopulation;
  bindings?: BindingContextStore;
  meter: SourceSemanticResourceLedger;
  execution?: SourceSemanticExecutionPlan;
}>) {
  const { index, query, population, meter } = input;
  const coordinates = new Map([...population.coordinates.values()].map((row) => [interpretationNodeIdentity(row), row]));
  const derivations = index.explanations ?? [];
  if (derivations.length > 1000 || index.entries.length > 1000) throw new SourceSemanticResourceExhausted("proof representation");
  meter.retain(derivations, "proof representation");
  const byId = new Map(derivations.map((row) => [row.derivation_id, row]));
  let proofComplete = true;
  const answers: SourceSemanticAnswer[] = [];
  const observed: { branch: SourceSemanticProofBranch; ids: readonly string[] }[] = [];
  const derivedIds = new Set(population.derivedNodes.filter((row) => row.kind === "query_entity" || row.kind === "instantiation").map((row) => row.node_id));
  for (const entry of index.entries) {
    meter.charge(1, 1024, "answer projection");
    if (entry.explanation_ids.length === 0 || !closedProof(entry.explanation_ids, byId, meter)) {
      proofComplete = false; continue;
    }
    const env = parseBindingContext(entry.output_binding, input.bindings);
    const accepted = [...env.keys()].filter((key) => key.startsWith("@accepted:"));
    if (accepted.length !== 1) throw new CoreError("OBLIGATION_VIOLATION", "accepting binding lacks its unique alternative marker");
    const branchIndex = Number(accepted[0]!.slice("@accepted:".length));
    const compiledBranch = input.execution?.branches[branchIndex];
    const alternative = compiledBranch?.alternative ?? branchIndex;
    const branch = query.alternatives[alternative];
    if (branch === undefined) throw new CoreError("OBLIGATION_VIOLATION", "accepting alternative is not in Q");
    if (compiledBranch !== undefined) observed.push({ branch: { ...compiledBranch,
      ...(compiledBranch.candidate_variable === undefined ? {} : {
        candidate: coordinates.get(env.get(compiledBranch.candidate_variable) ?? "")?.node_id
      }) }, ids: entry.explanation_ids });
    if (compiledBranch !== undefined && compiledBranch.purpose !== "support") continue;
    const used = new Set(query.evaluation === undefined
      ? branch.frames.flatMap((row) => [row.variable, ...row.role_requirements.map((role) => role.target_variable)]) : query.return_variables);
    const bindings: Record<string, InterpretationNodeCoordinate> = {};
    const returned: Record<string, InterpretationNodeCoordinate> = {};
    for (const variable of used) {
      const value = env.get(variable), coordinate = value === undefined ? undefined : coordinates.get(value);
      if (coordinate === undefined || coordinate.node_id.startsWith("@") && !derivedIds.has(coordinate.node_id)) {
        throw new CoreError("OBLIGATION_VIOLATION", "accepting binding contains a missing or synthetic user variable");
      }
      bindings[variable] = coordinate;
    }
    for (const variable of query.return_variables) {
      const coordinate = bindings[variable];
      if (coordinate === undefined) throw new CoreError("OBLIGATION_VIOLATION", "return variable is unbound");
      returned[variable] = coordinate;
    }
    answers.push({ binding_id: entry.output_binding, alternative, bindings, returned,
      explanation_ids: entry.explanation_ids, query_complete: query.gaps.length === 0 });
  }
  const consumed = new Set(derivations.flatMap((row) => row.observation_ids));
  const evidence_leaves = [...consumed].flatMap((id) => {
    const leaf = population.origins.get(id);
    return leaf === undefined ? [] : [{ observation_id: id, leaf }];
  });
  if (evidence_leaves.length > 4096) throw new SourceSemanticResourceExhausted("proof leaves");
  const unique = new Map<string, SourceSemanticConsumedLeaf>();
  for (const row of evidence_leaves) unique.set(JSON.stringify(row.leaf), row.leaf);
  const consumed_leaves = [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const usedDerived = new Set([
    ...answers.flatMap((row) => Object.values(row.bindings).map((node) => node.node_id)),
    ...consumed_leaves.flatMap((row) => [row.derived_node, row.derived_parent, row.derived_target, row.member].filter((id): id is string => id !== undefined))
  ]);
  for (const row of population.derivedNodes) if (row.kind === "instantiation" && usedDerived.has(row.node_id)) usedDerived.add(row.member);
  for (const row of population.derivedNodes) if (row.kind === "instance_slot" && usedDerived.has(row.node_id)) usedDerived.add(row.instance);
  const derived_nodes = population.derivedNodes.filter((row) => usedDerived.has(row.node_id));
  if (derived_nodes.length > 4096) throw new SourceSemanticResourceExhausted("derived proof coordinates");
  const evaluation = evaluationReport(query, input.execution, observed, answers.length);
  meter.retain([answers, evidence_leaves, consumed_leaves, derived_nodes, evaluation], "proof encoding");
  return { answers, derivations, evidence_leaves, consumed_leaves, proofComplete, derived_nodes,
    ...(evaluation === undefined ? {} : { evaluation }) };
}

function evaluationReport(query: SourceSemanticQuery, execution: SourceSemanticExecutionPlan | undefined,
  observed: readonly { branch: SourceSemanticProofBranch; ids: readonly string[] }[], answerCount: number): SourceSemanticEvaluationReport | undefined {
  if (query.evaluation === undefined) return undefined;
  const domain = execution?.domain, closed = domain?.closure.kind === "closed";
  const counterexamples = observed.filter((row) => row.branch.purpose === "counterexample");
  const incomparable = observed.some((row) => row.branch.purpose === "incomparable");
  const extreme = query.evaluation.kind === "comparison" && ["minimum", "maximum"].includes(query.evaluation.operation);
  const reasons: SourceSemanticEvaluationReport["reasons"][number][] = [];
  let status: SourceSemanticEvaluationReport["status"] = "unknown";
  if (answerCount > 0) status = counterexamples.length > 0 && !extreme ? "inconsistent" : "supported";
  else if (observed.some((row) => row.branch.purpose === "empty_domain")) { status = "empty_domain"; reasons.push("empty_domain"); }
  else if (counterexamples.length > 0 && (!extreme || closed
    && domain.members.every((member) => counterexamples.some((row) => row.branch.candidate === member.referent)))) {
    status = "refuted"; if (extreme) reasons.push("no_unique_extremum");
  } else if (incomparable) { status = "incomparable"; reasons.push("incompatible_measurement"); }
  else if (execution?.missingOperands) reasons.push("missing_operand");
  else if (execution?.missingMembership) reasons.push("missing_membership");
  if (status === "unknown") reasons.push(domain !== undefined && !closed
    && (query.evaluation.kind === "forall" || extreme) ? "open_domain" : query.evaluation.kind === "forall" ? "missing_body_proof" : "no_proof");
  return { status, domain_closed: closed, vacuous: status === "supported" && query.evaluation.kind === "forall"
    && closed && domain.members.length === 0, reasons,
    counterexample_explanation_ids: [...new Set(counterexamples.flatMap((row) => row.ids))] };
}

export function closedProof(
  roots: readonly string[],
  rows: ReadonlyMap<string, NonNullable<InformationIndex["explanations"]>[number]>,
  meter: SourceSemanticResourceLedger
): boolean {
  const done = new Set<string>(), visiting = new Set<string>();
  const stack = roots.map((id) => ({ id, exit: false }));
  while (stack.length > 0) {
    meter.charge(1, 0, "proof closure");
    const item = stack.pop()!;
    if (item.exit) { visiting.delete(item.id); done.add(item.id); continue; }
    if (done.has(item.id)) continue;
    if (visiting.has(item.id)) return false;
    const row = rows.get(item.id);
    if (row === undefined) return false;
    visiting.add(item.id); stack.push({ id: item.id, exit: true });
    for (const child of row.children) stack.push({ id: child, exit: false });
  }
  return true;
}
