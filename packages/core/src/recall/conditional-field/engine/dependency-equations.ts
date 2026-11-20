import {
  productEndpointId,
  type Derivation,
  type SeedActivation,
  type SupportRecord,
  type Transition
} from "@do-soul/alaya-protocol";
import {
  fieldPartitionNodeId,
  hardIdentityCapContractId,
  normalizeFieldPartitionContract
} from "../cap-contract.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import type { RetainedRows } from "./retained-sequence.js";
import { ruleIdentity, transitionKey } from "./path-composition.js";
import { localLeafIds, traceDerivationForest } from "./derivation-provenance.js";
import {
  ruleDerivationIdentity,
  seedActivationDerivationId, derivationRootAt, type DerivationRootLookup
} from "./path-derivation.js";

export type SharedRule = Readonly<{
  readonly rule_id: string;
  readonly from: string;
  readonly to: string;
  readonly cap: number;
  readonly derivation_id: string;
  readonly cap_contract_id: string;
}>;

export function incomingRules(
  transitions: RetainedRows<Transition>,
  transitionRoots: DerivationRootLookup,
  coordinate?: string
): Map<string, SharedRule[]> {
  const incoming = new Map<string, SharedRule[]>();
  for (const transition of transitions) {
    if (!transition.applicable) continue;
    const key = transitionKey(transition);
    const contract = coordinate ?? normalizeFieldPartitionContract(transition.cap_contract_id);
    const to = fieldPartitionNodeId(productStateNodeId(transition.to), contract);
    const rule: SharedRule = {
      rule_id: key,
      from: fieldPartitionNodeId(productStateNodeId(transition.from), contract),
      to,
      cap: transition.strength_milligrades,
      derivation_id: derivationRootAt(transitionRoots, key) ?? ruleDerivationIdentity(key),
      cap_contract_id: contract
    };
    const list = incoming.get(to);
    if (list === undefined) incoming.set(to, [rule]);
    else list.push(rule);
  }
  return incoming;
}

export function productSccs(
  nodeIds: readonly string[],
  edges: readonly { readonly from: string; readonly to: string }[]
): readonly (readonly string[])[] {
  const nodes = [...new Set(nodeIds)];
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) outgoing.set(node, []);
  for (const edge of edges) {
    if (!outgoing.has(edge.from) || !outgoing.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
  }
  let time = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  const visit = (node: string): void => {
    index.set(node, time);
    lowlink.set(node, time);
    time += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (!index.has(next)) {
        visit(next);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(next)!));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!));
      }
    }
    if (lowlink.get(node) === index.get(node)) {
      const scc: string[] = [];
      for (;;) {
        const current = stack.pop();
        if (current === undefined) break;
        onStack.delete(current);
        scc.push(current);
        if (current === node) break;
      }
      sccs.push(scc);
    }
  };
  for (const node of nodes) {
    if (!index.has(node)) visit(node);
  }
  // Tarjan emits sinks first; sources-first order is required for least witnesses.
  sccs.reverse();
  return sccs;
}

export function productsTouchedByLeaf(input: {
  readonly withdrawnLeafId: string;
  readonly seeds: RetainedRows<SeedActivation>;
  readonly transitions: RetainedRows<Transition>;
  readonly derivations: RetainedRows<Derivation>;
  readonly transition_derivations: DerivationRootLookup;
}): Set<string> {
  const touched = new Set<string>();
  const forest = new Map(input.derivations.map((row) => [row.derivation_id, row]));
  const leafHits = (rootId: string | undefined): boolean => {
    if (rootId === undefined) return false;
    const traced = traceDerivationForest({ forest, roots: [rootId] });
    return rootId === input.withdrawnLeafId || traced.traversal.nodes.has(input.withdrawnLeafId)
      || localLeafIds(traced.traversal).has(input.withdrawnLeafId);
  };
  for (const seed of input.seeds) {
    const key = productStateNodeId(seed.state);
    const seedLeaf = seedActivationDerivationId(seed);
    if (
      key === input.withdrawnLeafId
      || seedLeaf === input.withdrawnLeafId
      || leafHits(seedLeaf)
    ) {
      touched.add(key);
    }
  }
  for (const transition of input.transitions) {
    const from = productStateNodeId(transition.from);
    const to = productStateNodeId(transition.to);
    const root = derivationRootAt(input.transition_derivations, transitionKey(transition));
    if (
      transition.relation_kind === input.withdrawnLeafId
      || from === input.withdrawnLeafId
      || to === input.withdrawnLeafId
      || leafHits(root)
    ) {
      touched.add(from);
      touched.add(to);
    }
  }
  return touched;
}

export function sccMembersOf(
  sccs: readonly (readonly string[])[],
  touched: ReadonlySet<string>
): Set<string> {
  const affected = new Set<string>();
  for (const scc of sccs) {
    if (!scc.some((id) => touched.has(id))) continue;
    for (const id of scc) affected.add(id);
  }
  return affected;
}

export function reviseSccSupport(
  support: readonly SupportRecord[],
  withdrawnLeafId: string,
  affectedProductIds: ReadonlySet<string>,
  affectedSubjects: ReadonlySet<string>
): readonly SupportRecord[] {
  const retained: SupportRecord[] = [];
  for (const record of support) {
    if (
      record.proposition_id === withdrawnLeafId
      || affectedProductIds.has(record.proposition_id)
      || affectedSubjects.has(record.proposition_id)
    ) {
      continue;
    }
    const witnesses = record.witnesses.filter((witness) =>
      witness.complete
      && !witness.premises.includes(withdrawnLeafId)
      && !witness.premises.some((premise) => affectedProductIds.has(premise) || affectedSubjects.has(premise))
    );
    if (witnesses.length === 0) continue;
    retained.push({ ...record, witnesses: Object.freeze(witnesses) });
  }
  return Object.freeze(retained);
}

export function affectedSubjectsOf(
  seeds: RetainedRows<SeedActivation>,
  transitions: RetainedRows<Transition>,
  affectedProductIds: ReadonlySet<string>
): Set<string> {
  const subjects = new Set<string>();
  for (const seed of seeds) {
    if (affectedProductIds.has(productStateNodeId(seed.state))) {
      subjects.add(productEndpointId(seed.state));
    }
  }
  for (const transition of transitions) {
    if (affectedProductIds.has(productStateNodeId(transition.from))) {
      subjects.add(productEndpointId(transition.from));
    }
    if (affectedProductIds.has(productStateNodeId(transition.to))) {
      subjects.add(productEndpointId(transition.to));
    }
  }
  return subjects;
}

export function seedTouchesLeaf(seed: SeedActivation, withdrawnLeafId: string): boolean {
  const key = productStateNodeId(seed.state);
  return key === withdrawnLeafId || seedActivationDerivationId(seed) === withdrawnLeafId;
}

export function capOrPermissionRevisions(
  prior: RetainedRows<Transition>,
  next: RetainedRows<Transition>
): readonly Transition[] {
  const hardCoord = hardIdentityCapContractId();
  const nextKeys = new Set(next.map((row) => transitionKey(row)));
  const bestByRuleCoord = new Map<string, Map<string, number>>();
  const bestHardByRule = new Map<string, number>();
  for (const row of next) {
    if (!row.applicable) continue;
    const id = ruleIdentity(row);
    const coord = normalizeFieldPartitionContract(row.cap_contract_id);
    if (coord === hardCoord) {
      bestHardByRule.set(id, Math.max(bestHardByRule.get(id) ?? -1, row.strength_milligrades));
      continue;
    }
    let byCoord = bestByRuleCoord.get(id);
    if (byCoord === undefined) {
      byCoord = new Map<string, number>();
      bestByRuleCoord.set(id, byCoord);
    }
    byCoord.set(coord, Math.max(byCoord.get(coord) ?? -1, row.strength_milligrades));
  }
  const revised: Transition[] = [];
  for (const row of prior) {
    if (!row.applicable || nextKeys.has(transitionKey(row))) continue;
    const id = ruleIdentity(row);
    const coord = normalizeFieldPartitionContract(row.cap_contract_id);
    const effective = coord === hardCoord
      ? bestHardByRule.get(id)
      : maxDefined(bestByRuleCoord.get(id)?.get(coord), bestHardByRule.get(id));
    if (effective === undefined || effective < row.strength_milligrades) {
      revised.push(row);
    }
  }
  return revised;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  const best = Math.max(a ?? -1, b ?? -1);
  return best >= 0 ? best : undefined;
}

export function repairSupportAfterRuleRevision(input: {
  readonly priorTransitions: RetainedRows<Transition>;
  readonly nextTransitions: RetainedRows<Transition>;
  readonly seeds: RetainedRows<SeedActivation>;
  readonly support: readonly SupportRecord[];
}): readonly SupportRecord[] {
  const revised = capOrPermissionRevisions(input.priorTransitions, input.nextTransitions);
  if (revised.length === 0) return input.support;
  const affected = affectedByCoordinateScc(input.seeds, input.priorTransitions, revised);
  const subjects = affectedSubjectsOf(input.seeds, input.priorTransitions, affected);
  return reviseSccSupport(input.support, "", affected, subjects);
}

function affectedByCoordinateScc(
  seeds: RetainedRows<SeedActivation>,
  priorTransitions: RetainedRows<Transition>,
  revised: readonly Transition[]
): Set<string> {
  const hardCoord = hardIdentityCapContractId();
  const softCoords = new Set<string>();
  for (const row of priorTransitions) {
    if (!row.applicable) continue;
    const c = normalizeFieldPartitionContract(row.cap_contract_id);
    if (c !== hardCoord) softCoords.add(c);
  }
  const revisedSoftCoords = new Set<string>();
  let hasHardRevision = false;
  for (const row of revised) {
    const c = normalizeFieldPartitionContract(row.cap_contract_id);
    if (c === hardCoord) hasHardRevision = true;
    else {
      softCoords.add(c);
      revisedSoftCoords.add(c);
    }
  }

  const affected = new Set<string>();
  const collectPartition = (coord: string, includeSoft: boolean): void => {
    const matches = (contract: string | undefined): boolean => {
      const c = normalizeFieldPartitionContract(contract);
      return includeSoft ? c === coord || c === hardCoord : c === hardCoord;
    };
    const touched = new Set<string>();
    for (const row of revised) {
      if (!matches(row.cap_contract_id)) continue;
      touched.add(productStateNodeId(row.from));
      touched.add(productStateNodeId(row.to));
    }
    if (touched.size === 0) return;
    const nodeIds: string[] = [];
    for (const seed of seeds) if (matches(seed.cap_contract_id)) nodeIds.push(productStateNodeId(seed.state));
    const edges: Array<{ readonly from: string; readonly to: string }> = [];
    for (const row of priorTransitions) {
      if (!row.applicable || !matches(row.cap_contract_id)) continue;
      const from = productStateNodeId(row.from);
      const to = productStateNodeId(row.to);
      nodeIds.push(from, to);
      edges.push({ from, to });
    }
    for (const from of touched) nodeIds.push(from);
    for (const id of sccMembersOf(productSccs(nodeIds, edges), touched)) affected.add(id);
  };

  for (const coord of softCoords) {
    if (hasHardRevision || revisedSoftCoords.has(coord)) collectPartition(coord, true);
  }
  if (hasHardRevision) collectPartition(hardCoord, false);
  return affected;
}
