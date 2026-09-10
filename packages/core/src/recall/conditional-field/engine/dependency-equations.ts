import {
  productSubjectId,
  type Derivation,
  type SeedActivation,
  type SupportRecord,
  type Transition
} from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { ruleIdentity, transitionKey } from "./path-composition.js";
import {
  joinDerivation,
  ruleDerivationIdentity,
  seedDerivationIdentity
} from "./path-derivation.js";

export type SharedRule = Readonly<{
  readonly rule_id: string;
  readonly from: string;
  readonly to: string;
  readonly cap: number;
  readonly derivation_id: string;
}>;

export function incomingRules(
  transitions: readonly Transition[],
  transitionRoots: Readonly<Record<string, string>>
): Map<string, SharedRule[]> {
  const incoming = new Map<string, SharedRule[]>();
  for (const transition of transitions) {
    if (!transition.applicable) continue;
    const key = transitionKey(transition);
    const to = productStateNodeId(transition.to);
    const rule: SharedRule = {
      rule_id: key,
      from: productStateNodeId(transition.from),
      to,
      cap: transition.strength_milligrades,
      derivation_id: transitionRoots[key] ?? ruleDerivationIdentity(key)
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

export function assembleOrder(
  nodeIds: readonly string[],
  incoming: ReadonlyMap<string, readonly SharedRule[]>,
  seedIds: ReadonlySet<string> = new Set()
): { readonly sccs: readonly (readonly string[])[]; readonly order: readonly string[] } {
  const edges: { from: string; to: string }[] = [];
  for (const rules of incoming.values()) {
    for (const rule of rules) edges.push({ from: rule.from, to: rule.to });
  }
  const sccs = productSccs(nodeIds, edges);
  const order: string[] = [];
  for (const scc of sccs) {
    const withIncoming = scc.filter((id) => (incoming.get(id) ?? []).length > 0);
    const seeded = withIncoming.filter((id) => seedIds.has(id));
    const rest = withIncoming.filter((id) => !seedIds.has(id));
    order.push(...seeded, ...rest);
  }
  return { sccs, order };
}

export function assembleProductEquation(input: {
  readonly seed: Derivation | undefined;
  readonly incoming: readonly SharedRule[];
  readonly forest: ReadonlyMap<string, Derivation>;
  readonly assembled: ReadonlyMap<string, Derivation>;
  readonly scc: ReadonlySet<string>;
  readonly sccSeeds: ReadonlyMap<string, Derivation>;
}): { readonly root: Derivation | undefined; readonly created: readonly Derivation[] } {
  const created: Derivation[] = [];
  const remember = (node: Derivation): Derivation => {
    created.push(node);
    return node;
  };
  const options: Derivation[] = [];
  if (input.seed !== undefined) options.push(input.seed);
  for (const rule of input.incoming) {
    const edge = input.forest.get(rule.derivation_id);
    const premise = input.scc.has(rule.from)
      ? input.sccSeeds.get(rule.from)
      : input.assembled.get(rule.from);
    if (edge === undefined && premise === undefined) continue;
    if (edge === undefined) {
      options.push(premise!);
      continue;
    }
    if (premise === undefined) {
      options.push(edge);
      continue;
    }
    options.push(remember(joinDerivation("serial", [premise, edge])));
  }
  if (options.length === 0) return { root: undefined, created };
  return { root: remember(joinDerivation("or", options)), created };
}

export function productsTouchedByLeaf(input: {
  readonly withdrawnLeafId: string;
  readonly seeds: readonly SeedActivation[];
  readonly transitions: readonly Transition[];
  readonly derivations: readonly Derivation[];
  readonly transition_derivations: Readonly<Record<string, string>>;
}): Set<string> {
  const touched = new Set<string>();
  const forest = new Map(input.derivations.map((row) => [row.derivation_id, row]));
  const leafHits = (rootId: string | undefined): boolean => {
    if (rootId === undefined) return false;
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      const node = forest.get(id);
      if (node === undefined) return id === input.withdrawnLeafId;
      if (node.derivation_id === input.withdrawnLeafId || node.leaf_ids.includes(input.withdrawnLeafId)) {
        return true;
      }
      return node.children.some(visit);
    };
    return visit(rootId);
  };
  for (const seed of input.seeds) {
    const key = productStateNodeId(seed.state);
    if (
      key === input.withdrawnLeafId
      || seedDerivationIdentity(key) === input.withdrawnLeafId
      || leafHits(seedDerivationIdentity(key))
    ) {
      touched.add(key);
    }
  }
  for (const transition of input.transitions) {
    const from = productStateNodeId(transition.from);
    const to = productStateNodeId(transition.to);
    const root = input.transition_derivations[transitionKey(transition)];
    if (
      transition.relation_kind === input.withdrawnLeafId
      || from === input.withdrawnLeafId
      || to === input.withdrawnLeafId
      || seedDerivationIdentity(from) === input.withdrawnLeafId
      || seedDerivationIdentity(to) === input.withdrawnLeafId
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
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[],
  affectedProductIds: ReadonlySet<string>
): Set<string> {
  const subjects = new Set<string>();
  for (const seed of seeds) {
    if (affectedProductIds.has(productStateNodeId(seed.state))) {
      subjects.add(productSubjectId(seed.state));
    }
  }
  for (const transition of transitions) {
    if (affectedProductIds.has(productStateNodeId(transition.from))) {
      subjects.add(productSubjectId(transition.from));
    }
    if (affectedProductIds.has(productStateNodeId(transition.to))) {
      subjects.add(productSubjectId(transition.to));
    }
  }
  return subjects;
}

export function seedTouchesLeaf(seed: SeedActivation, withdrawnLeafId: string): boolean {
  const key = productStateNodeId(seed.state);
  return key === withdrawnLeafId || seedDerivationIdentity(key) === withdrawnLeafId;
}

export function capOrPermissionRevisions(
  prior: readonly Transition[],
  next: readonly Transition[]
): readonly Transition[] {
  const nextKeys = new Set(next.map((row) => transitionKey(row)));
  const nextByRule = new Map<string, Transition[]>();
  for (const row of next) {
    const id = ruleIdentity(row);
    const group = nextByRule.get(id);
    if (group === undefined) nextByRule.set(id, [row]);
    else group.push(row);
  }
  const revised: Transition[] = [];
  for (const row of prior) {
    if (!row.applicable) continue;
    if (nextKeys.has(transitionKey(row))) continue;
    const laters = nextByRule.get(ruleIdentity(row)) ?? [];
    if (laters.length === 1) {
      const later = laters[0]!;
      if (!later.applicable || later.strength_milligrades < row.strength_milligrades) {
        revised.push(later);
      }
      continue;
    }
    if (laters.length === 0) revised.push(row);
  }
  return revised;
}

export function repairSupportAfterRuleRevision(input: {
  readonly priorTransitions: readonly Transition[];
  readonly nextTransitions: readonly Transition[];
  readonly seeds: readonly SeedActivation[];
  readonly support: readonly SupportRecord[];
}): readonly SupportRecord[] {
  const revised = capOrPermissionRevisions(input.priorTransitions, input.nextTransitions);
  if (revised.length === 0) return input.support;
  const nodeIds = [
    ...input.seeds.map((seed) => productStateNodeId(seed.state)),
    ...input.priorTransitions.flatMap((row) => [
      productStateNodeId(row.from),
      productStateNodeId(row.to)
    ])
  ];
  const edges = input.priorTransitions.flatMap((row) => row.applicable
    ? [{ from: productStateNodeId(row.from), to: productStateNodeId(row.to) }]
    : []);
  const touched = new Set<string>();
  for (const row of revised) {
    touched.add(productStateNodeId(row.from));
    touched.add(productStateNodeId(row.to));
  }
  const affected = sccMembersOf(productSccs(nodeIds, edges), touched);
  const subjects = affectedSubjectsOf(input.seeds, input.priorTransitions, affected);
  return reviseSccSupport(input.support, "", affected, subjects);
}
