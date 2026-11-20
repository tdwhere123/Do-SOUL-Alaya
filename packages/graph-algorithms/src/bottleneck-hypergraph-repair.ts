import {
  assertValidTop,
  collectNormalizedSeeds,
  indexUniqueNodes,
  normalizeRules,
  solveBottleneckHypergraph,
  type BottleneckHyperedge,
  type BottleneckHypergraphInput,
  type BottleneckWitness,
  type NormalizedRule
} from "./bottleneck-hypergraph.js";
import { MonotonicHypergraphMaintainer } from "./bottleneck-hypergraph-maintainer.js";
import { buildConservativeMeet, certifyEqualValueCore, resolvePriorFixedPoint } from "./bottleneck-hypergraph-meet.js";

export interface BottleneckRepairInput {
  readonly prior: BottleneckHypergraphInput & { readonly values?: ReadonlyMap<string, number> };
  readonly next: BottleneckHypergraphInput;
}

export interface BottleneckRepairResult {
  readonly values: ReadonlyMap<string, number>;
  readonly witnesses: ReadonlyMap<string, BottleneckWitness>;
  readonly certifiedCore: ReadonlySet<string>;
  readonly recomputedNodes: ReadonlySet<string>;
  readonly meetValues: ReadonlyMap<string, number>;
  readonly isPureDowngrade: boolean;
  readonly changedNodes: ReadonlySet<string>;
}

/** Algorithm C: two-phase DRed repair from a known fixed point under general revisions (Theorem 4.4). */
export function repairBottleneckHypergraph(input: BottleneckRepairInput): BottleneckRepairResult {
  const top = assertValidTop(input.next.top, input.next.bottom);
  assertValidTop(input.prior.top, input.prior.bottom);
  if (input.prior.top !== top) {
    throw new RangeError("bottleneck repair requires matching top bounds between prior and next");
  }
  const priorNodes = indexUniqueNodes(input.prior.nodeIds);
  const priorSeeds = collectNormalizedSeeds(priorNodes.indexById, input.prior.seeds, top);
  const priorRules = normalizeRules(priorNodes.indexById, input.prior.edges, top);
  const resolvedPrior = resolvePriorFixedPoint(
    input.prior, priorNodes.ids, priorNodes.indexById, priorSeeds, priorRules, top
  );
  const priorValuesMap = resolvedPrior.map;
  const priorValArr = resolvedPrior.arr;

  const nextNodes = indexUniqueNodes(input.next.nodeIds);
  const nextSeeds = collectNormalizedSeeds(nextNodes.indexById, input.next.seeds, top);
  const nextRules = normalizeRules(nextNodes.indexById, input.next.edges, top);

  const meet = buildConservativeMeet(priorNodes.ids, priorNodes.indexById, priorSeeds, priorRules, nextNodes.ids, nextSeeds, nextRules);
  const core = certifyEqualValueCore(priorNodes.ids, priorValArr, meet.seeds, meet.rules);
  const recomputed = recomputeAffectedSubgraph(priorNodes.ids, priorValArr, meet.seeds, meet.rules, core.inCore, top);
  const meetMerged = mergeMeetResult(priorNodes.ids, priorValArr, core, recomputed);

  let finalValues: ReadonlyMap<string, number> = meetMerged.values;
  let finalWitnesses: ReadonlyMap<string, BottleneckWitness> = meetMerged.witnesses;
  if (!meet.isPureDowngrade) {
    const maintainer = new MonotonicHypergraphMaintainer({
      nodeIds: nextNodes.ids, bottom: 0, top,
      initialValues: meetMerged.values, initialWitnesses: meetMerged.witnesses,
      seeds: input.next.seeds, edges: input.next.edges
    });
    finalValues = maintainer.values;
    finalWitnesses = maintainer.witnesses;
  }

  return {
    values: finalValues,
    witnesses: finalWitnesses,
    certifiedCore: core.certifiedCore,
    recomputedNodes: recomputed.affectedSet,
    meetValues: meetMerged.values,
    isPureDowngrade: meet.isPureDowngrade,
    changedNodes: diffValueMaps(priorValuesMap, finalValues)
  };
}

function recomputeAffectedSubgraph(
  nodeIds: readonly string[],
  priorVal: Float64Array,
  meetSeeds: ReadonlyMap<number, number>,
  meetRules: readonly NormalizedRule[],
  inCore: Uint8Array,
  top: number
): {
  readonly affectedSet: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, number>;
  readonly witnesses: ReadonlyMap<string, BottleneckWitness>;
} {
  const affectedIds: string[] = [];
  const affectedSet = new Set<string>();
  const inA = new Uint8Array(nodeIds.length);
  for (let i = 0; i < nodeIds.length; i += 1) {
    if (inCore[i] === 0 && priorVal[i]! >= 0) {
      inA[i] = 1;
      affectedIds.push(nodeIds[i]!);
      affectedSet.add(nodeIds[i]!);
    }
  }
  if (affectedIds.length === 0) return { affectedSet, values: new Map(), witnesses: new Map() };

  const subSeeds = new Map<string, number>();
  const foldedWitness = new Map<string, BottleneckWitness>();
  for (const [idx, val] of meetSeeds) {
    if (inA[idx] === 1) subSeeds.set(nodeIds[idx]!, val);
  }
  const subEdges: BottleneckHyperedge[] = [];
  const subRuleByTag = new Map<string, { readonly folded: boolean; readonly rule: NormalizedRule }>();
  foldMeetRulesIntoSubgraph(nodeIds, priorVal, meetRules, inCore, inA, subSeeds, foldedWitness, subEdges, subRuleByTag);

  const solved = solveBottleneckHypergraph({ nodeIds: affectedIds, seeds: subSeeds, edges: subEdges, bottom: 0, top });
  const restoredWitnesses = restoreSubgraphWitnesses(nodeIds, solved.witnesses, foldedWitness, subRuleByTag);
  return { affectedSet, values: solved.values, witnesses: restoredWitnesses };
}

function foldMeetRulesIntoSubgraph(
  nodeIds: readonly string[],
  priorVal: Float64Array,
  meetRules: readonly NormalizedRule[],
  inCore: Uint8Array,
  inA: Uint8Array,
  subSeeds: Map<string, number>,
  foldedWitness: Map<string, BottleneckWitness>,
  subEdges: BottleneckHyperedge[],
  subRuleByTag: Map<string, { readonly folded: boolean; readonly rule: NormalizedRule }>
): void {
  for (let i = 0; i < meetRules.length; i += 1) {
    const r = meetRules[i]!;
    if (inA[r.head] === 0) continue;
    const headId = nodeIds[r.head]!;
    if (r.kind === "and") {
      foldAndRuleIntoSubgraph(r, nodeIds, priorVal, inCore, inA, subSeeds, foldedWitness, subEdges, subRuleByTag, i);
      continue;
    }
    const internal: string[] = [];
    for (const p of r.premises) {
      if (inCore[p] === 1) {
        const val = Math.min(r.capacity, priorVal[p]!);
        recordSubSeed(headId, val, { kind: "rule", ruleId: r.ruleId, grade: val, premises: [nodeIds[p]!] }, subSeeds, foldedWitness);
      } else if (inA[p] === 1) {
        internal.push(nodeIds[p]!);
      }
    }
    if (internal.length === 0) continue;
    const tag = `orig:${i}`;
    subRuleByTag.set(tag, { folded: false, rule: r });
    subEdges.push(r.kind === "or"
      ? { id: tag, kind: "or", from: internal, to: headId, strength: r.capacity }
      : r.kind === "identity"
        ? { id: tag, kind: "identity", from: internal[0]!, to: headId }
        : { id: tag, kind: "unary", from: internal[0]!, to: headId, strength: r.capacity });
  }
}

function restoreSubgraphWitnesses(
  nodeIds: readonly string[],
  solvedWitnesses: ReadonlyMap<string, BottleneckWitness>,
  foldedWitness: ReadonlyMap<string, BottleneckWitness>,
  subRuleByTag: ReadonlyMap<string, { readonly folded: boolean; readonly rule: NormalizedRule }>
): Map<string, BottleneckWitness> {
  const restored = new Map<string, BottleneckWitness>();
  for (const [id, w] of solvedWitnesses) {
    if (w.kind === "seed") {
      restored.set(id, foldedWitness.get(id) ?? w);
      continue;
    }
    const entry = subRuleByTag.get(w.ruleId)!;
    restored.set(id, entry.folded
      ? { ...w, ruleId: entry.rule.ruleId, premises: entry.rule.premises.map((p) => nodeIds[p]!) }
      : { ...w, ruleId: entry.rule.ruleId });
  }
  return restored;
}

function foldAndRuleIntoSubgraph(
  r: NormalizedRule,
  nodeIds: readonly string[],
  priorVal: Float64Array,
  inCore: Uint8Array,
  inA: Uint8Array,
  subSeeds: Map<string, number>,
  foldedWitness: Map<string, BottleneckWitness>,
  subEdges: BottleneckHyperedge[],
  subRuleByTag: Map<string, { readonly folded: boolean; readonly rule: NormalizedRule }>,
  ruleSlot: number
): void {
  let extCap = r.capacity;
  const internal: string[] = [];
  for (const p of r.premises) {
    if (priorVal[p]! < 0) return;
    if (inCore[p] === 1) extCap = Math.min(extCap, priorVal[p]!);
    else if (inA[p] === 1) internal.push(nodeIds[p]!);
  }
  const headId = nodeIds[r.head]!;
  if (internal.length === 0) {
    const allPremises = r.premises.map((p) => nodeIds[p]!);
    recordSubSeed(headId, extCap, { kind: "rule", ruleId: r.ruleId, grade: extCap, premises: allPremises }, subSeeds, foldedWitness);
    return;
  }
  const tag = `fold:${ruleSlot}`;
  subRuleByTag.set(tag, { folded: true, rule: r });
  subEdges.push({ id: tag, kind: "and", from: internal, to: headId, strength: extCap });
}

function recordSubSeed(
  headId: string,
  val: number,
  witness: BottleneckWitness,
  subSeeds: Map<string, number>,
  foldedWitness: Map<string, BottleneckWitness>
): void {
  const existing = subSeeds.get(headId);
  if (existing === undefined || val > existing) {
    subSeeds.set(headId, val);
    foldedWitness.set(headId, witness);
  }
}

function mergeMeetResult(
  priorIds: readonly string[],
  priorVal: Float64Array,
  core: { readonly inCore: Uint8Array; readonly witnesses: readonly (BottleneckWitness | undefined)[] },
  recomputed: { readonly values: ReadonlyMap<string, number>; readonly witnesses: ReadonlyMap<string, BottleneckWitness> }
): { readonly values: Map<string, number>; readonly witnesses: Map<string, BottleneckWitness> } {
  const values = new Map<string, number>();
  const witnesses = new Map<string, BottleneckWitness>();
  for (let i = 0; i < priorIds.length; i += 1) {
    const id = priorIds[i]!;
    if (core.inCore[i] === 1) {
      values.set(id, priorVal[i]!);
      if (core.witnesses[i] !== undefined) witnesses.set(id, core.witnesses[i]!);
    } else if (recomputed.values.has(id)) {
      values.set(id, recomputed.values.get(id)!);
      const w = recomputed.witnesses.get(id);
      if (w !== undefined) witnesses.set(id, w);
    }
  }
  return { values, witnesses };
}

function diffValueMaps(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): Set<string> {
  const changed = new Set<string>();
  for (const [id, val] of before) if (after.get(id) !== val) changed.add(id);
  for (const [id, val] of after) if (before.get(id) !== val) changed.add(id);
  return changed;
}
