import {
  interpretationNodeIdentity, SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type InformationIndex, type SourceSemanticQuery, type SourceSemanticAnswer,
  type SourceSemanticConsumedLeaf, type InterpretationNodeCoordinate
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { parseBindingContext, type BindingContextStore } from "../conditional-field/engine/binding-environment.js";
import type { SourceSemanticPremisePopulation } from "./source-semantic-premises.js";

/** Project actual engine environments, never reconstruct bindings from H/A or a leaf bag. */
export function deliverSourceSemanticProof(input: Readonly<{
  index: InformationIndex;
  query: SourceSemanticQuery;
  population: SourceSemanticPremisePopulation;
  bindings?: BindingContextStore;
  meter: SourceSemanticResourceLedger;
}>) {
  const { index, query, population, meter } = input;
  const coordinates = new Map([...population.coordinates.values()].map((row) => [interpretationNodeIdentity(row), row]));
  const derivations = index.explanations ?? [];
  if (derivations.length > 1000 || index.entries.length > 1000) throw new SourceSemanticResourceExhausted("proof representation");
  meter.retain(derivations, "proof representation");
  const byId = new Map(derivations.map((row) => [row.derivation_id, row]));
  let proofComplete = true;
  const answers: SourceSemanticAnswer[] = [];
  for (const entry of index.entries) {
    meter.charge(1, 1024, "answer projection");
    if (entry.explanation_ids.length === 0 || !closedProof(entry.explanation_ids, byId, meter)) {
      proofComplete = false; continue;
    }
    const env = parseBindingContext(entry.output_binding, input.bindings);
    const accepted = [...env.keys()].filter((key) => key.startsWith("@accepted:"));
    if (accepted.length !== 1) throw new CoreError("OBLIGATION_VIOLATION", "accepting binding lacks its unique alternative marker");
    const alternative = Number(accepted[0]!.slice("@accepted:".length));
    const branch = query.alternatives[alternative];
    if (branch === undefined) throw new CoreError("OBLIGATION_VIOLATION", "accepting alternative is not in Q");
    const used = new Set(branch.frames.flatMap((row) => [row.variable, ...row.role_requirements.map((role) => role.target_variable)]));
    const bindings: Record<string, InterpretationNodeCoordinate> = {};
    const returned: Record<string, InterpretationNodeCoordinate> = {};
    for (const variable of used) {
      const value = env.get(variable), coordinate = value === undefined ? undefined : coordinates.get(value);
      if (coordinate === undefined || coordinate.node_id.startsWith("@")) {
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
  meter.retain([answers, evidence_leaves, consumed_leaves], "proof encoding");
  return { answers, derivations, evidence_leaves, consumed_leaves, proofComplete };
}

function closedProof(
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
