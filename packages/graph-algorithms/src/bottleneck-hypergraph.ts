import { createFrontier, type PriorityFrontier } from "./bottleneck-hypergraph-frontier.js";

export type BottleneckHyperedge =
  | { readonly id?: string; readonly kind: "unary"; readonly from: string; readonly to: string; readonly strength: number }
  | { readonly id?: string; readonly kind: "and"; readonly from: readonly string[]; readonly to: string; readonly strength: number }
  | { readonly id?: string; readonly kind: "or"; readonly from: readonly string[]; readonly to: string; readonly strength: number }
  | { readonly id?: string; readonly kind: "identity"; readonly from: string; readonly to: string };

export interface BottleneckHypergraphInput {
  readonly nodeIds: readonly string[];
  readonly seeds: ReadonlyMap<string, number>;
  readonly edges: readonly BottleneckHyperedge[];
  readonly bottom: 0;
  readonly top: number;
  readonly maxSettledSteps?: number;
}

export type BottleneckWitness =
  | { readonly kind: "seed"; readonly grade: number }
  | {
      readonly kind: "rule";
      readonly ruleId: string;
      readonly grade: number;
      readonly premises: readonly string[];
    };

export interface BottleneckSolveResult {
  readonly values: ReadonlyMap<string, number>;
  readonly tentativeValues: ReadonlyMap<string, number>;
  readonly witnesses: ReadonlyMap<string, BottleneckWitness>;
  readonly settledOrder: readonly string[];
  readonly settledCount: number;
  readonly complete: boolean;
  readonly horizon: number | undefined;
  readonly initialQueuePushes: number;
  readonly initialHeapComparisons: number;
  readonly frontierUpperBound: ReadonlyMap<string, number>;
  openExtensionUpperBound(pendingCap: number | undefined): ReadonlyMap<string, number>;
}

export interface NormalizedRule {
  readonly ruleId: string;
  readonly explicitId: boolean;
  readonly kind: BottleneckHyperedge["kind"];
  readonly premises: readonly number[];
  readonly head: number;
  readonly capacity: number;
}

/** Algorithm A: bucketed/heap best-first bottleneck hypergraph settlement with frontier certificate. */
export function solveBottleneckHypergraph(input: BottleneckHypergraphInput): BottleneckSolveResult {
  const top = assertValidTop(input.top, input.bottom);
  const nodes = indexUniqueNodes(input.nodeIds);
  const n = nodes.ids.length;
  const tentative = new Float64Array(n).fill(-1);
  const settled = new Uint8Array(n);
  const witnesses = new Array<BottleneckWitness | undefined>(n);
  const frontier = createFrontier(top);
  const seedGrades = collectNormalizedSeeds(nodes.indexById, input.seeds, top);
  const rules = normalizeRules(nodes.indexById, input.edges, top);
  const outgoing = buildOutgoingIndex(n, rules);
  const remaining = new Int32Array(rules.length);
  const orEvaluated = new Uint8Array(rules.length);
  const initStats = initializeTentative(seedGrades, rules, tentative, witnesses, remaining, frontier);

  const stepLimit = normalizeStepLimit(input.maxSettledSteps);
  const settledOrder: string[] = [];
  while (settledOrder.length < stepLimit) {
    const next = frontier.popValid(tentative, settled);
    if (next === undefined) break;
    const u = next.node;
    settled[u] = 1;
    relaxNodeOutgoing(u, nodes.ids, rules, outgoing[u]!, remaining, orEvaluated, tentative, settled, witnesses, frontier);
    settledOrder.push(nodes.ids[u]!);
  }

  const horizon = frontier.peekValid(tentative, settled)?.grade;
  const complete = horizon === undefined;
  return buildSolveResult(
    nodes.ids, seedGrades, rules, outgoing, tentative, settled, witnesses, settledOrder, horizon, complete, top, initStats
  );
}

export function assertValidTop(top: number, bottom: 0): number {
  if (bottom !== 0 || !Number.isInteger(top) || top < 0 || top > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("bottleneck hypergraph top must be a safe nonnegative integer with bottom 0");
  }
  return top;
}

export function canonicalRuleStructureKey(
  kind: BottleneckHyperedge["kind"],
  headId: string,
  premiseIds: readonly string[]
): string {
  return JSON.stringify([kind, headId, [...premiseIds].sort()]);
}

export function requireGrade(value: number, top: number): number {
  if (!Number.isFinite(value) || value < 0 || value > top) {
    throw new RangeError(`max-min grade must be finite and within [0, ${top}]`);
  }
  return Math.trunc(value);
}

export function indexUniqueNodes(nodeIds: readonly string[]): {
  readonly ids: readonly string[];
  readonly indexById: ReadonlyMap<string, number>;
} {
  const ids: string[] = [];
  const indexById = new Map<string, number>();
  for (const id of nodeIds) {
    if (indexById.has(id)) continue;
    indexById.set(id, ids.length);
    ids.push(id);
  }
  return { ids, indexById };
}

export function collectNormalizedSeeds(
  indexById: ReadonlyMap<string, number>,
  seeds: ReadonlyMap<string, number>,
  top: number
): Map<number, number> {
  const collected = new Map<number, number>();
  for (const [nodeId, raw] of seeds) {
    const idx = indexById.get(nodeId);
    if (idx === undefined) continue;
    const grade = requireGrade(raw, top);
    const prior = collected.get(idx);
    if (prior === undefined || grade > prior) collected.set(idx, grade);
  }
  return collected;
}

export function normalizeRules(
  indexById: ReadonlyMap<string, number>,
  edges: readonly BottleneckHyperedge[],
  top: number
): NormalizedRule[] {
  const rules: NormalizedRule[] = [];
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]!;
    const head = indexById.get(edge.to);
    if (head === undefined) continue;
    const rawPremises = edge.kind === "and" || edge.kind === "or" ? edge.from : [edge.from];
    const premises: number[] = [];
    const seen = new Set<number>();
    let invalid = false;
    for (const p of rawPremises) {
      const pIdx = indexById.get(p);
      if (pIdx === undefined) {
        invalid = true;
        break;
      }
      if (!seen.has(pIdx)) {
        seen.add(pIdx);
        premises.push(pIdx);
      }
    }
    if (invalid) continue;
    const capacity = edge.kind === "identity" ? top : requireGrade(edge.strength, top);
    rules.push({
      ruleId: edge.id ?? `rule#${i}`,
      explicitId: edge.id !== undefined,
      kind: edge.kind,
      premises,
      head,
      capacity
    });
  }
  return rules;
}

function buildOutgoingIndex(n: number, rules: readonly NormalizedRule[]): number[][] {
  const outgoing = Array.from({ length: n }, () => [] as number[]);
  for (let i = 0; i < rules.length; i += 1) {
    for (const p of rules[i]!.premises) outgoing[p]!.push(i);
  }
  return outgoing;
}

function initializeTentative(
  seeds: ReadonlyMap<number, number>,
  rules: readonly NormalizedRule[],
  tentative: Float64Array,
  witnesses: (BottleneckWitness | undefined)[],
  remaining: Int32Array,
  frontier: PriorityFrontier
): { readonly pushes: number; readonly comparisons: number } {
  for (const [node, grade] of seeds) {
    tentative[node] = grade;
    witnesses[node] = { kind: "seed", grade };
  }
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]!;
    remaining[i] = rule.premises.length;
    if (rule.kind === "and" && rule.premises.length === 0 && rule.capacity > tentative[rule.head]!) {
      tentative[rule.head] = rule.capacity;
      witnesses[rule.head] = { kind: "rule", ruleId: rule.ruleId, grade: rule.capacity, premises: [] };
    }
  }
  return frontier.buildFromTentative(tentative);
}

function relaxNodeOutgoing(
  u: number,
  nodeIds: readonly string[],
  rules: readonly NormalizedRule[],
  edgeIndices: readonly number[],
  remaining: Int32Array,
  orEvaluated: Uint8Array,
  tentative: Float64Array,
  settled: Uint8Array,
  witnesses: (BottleneckWitness | undefined)[],
  frontier: PriorityFrontier
): void {
  const uGrade = tentative[u]!;
  for (const ruleIdx of edgeIndices) {
    const rule = rules[ruleIdx]!;
    if (rule.kind === "and") {
      const rem = remaining[ruleIdx]! - 1;
      remaining[ruleIdx] = rem;
      if (rem !== 0) continue;
    } else if (rule.kind === "or") {
      if (orEvaluated[ruleIdx] === 1) continue;
      orEvaluated[ruleIdx] = 1;
    }
    const candidate = Math.min(rule.capacity, uGrade);
    const head = rule.head;
    if (settled[head] === 1 || candidate <= tentative[head]!) continue;
    tentative[head] = candidate;
    const premiseIds = rule.kind === "or"
      ? [nodeIds[u]!]
      : rule.premises.map((p) => nodeIds[p]!);
    witnesses[head] = { kind: "rule", ruleId: rule.ruleId, grade: candidate, premises: premiseIds };
    frontier.push(head, candidate);
  }
}

function buildSolveResult(
  nodeIds: readonly string[],
  seeds: ReadonlyMap<number, number>,
  rules: readonly NormalizedRule[],
  outgoing: readonly number[][],
  tentative: Float64Array,
  settled: Uint8Array,
  witnessArray: readonly (BottleneckWitness | undefined)[],
  settledOrder: readonly string[],
  horizon: number | undefined,
  complete: boolean,
  top: number,
  initStats: { readonly pushes: number; readonly comparisons: number }
): BottleneckSolveResult {
  const values = new Map<string, number>();
  const tentativeValues = new Map<string, number>();
  const witnesses = new Map<string, BottleneckWitness>();
  for (let i = 0; i < nodeIds.length; i += 1) {
    const id = nodeIds[i]!;
    if (tentative[i]! >= 0) {
      tentativeValues.set(id, tentative[i]!);
      if (settled[i] === 1) {
        values.set(id, tentative[i]!);
        if (witnessArray[i] !== undefined) witnesses.set(id, witnessArray[i]!);
      }
    }
  }
  const frontierUpperBound = complete
    ? values
    : computeFrontierCertificate(nodeIds, seeds, rules, outgoing, tentative, settled, horizon!, top);
  return {
    values,
    tentativeValues,
    witnesses,
    settledOrder,
    settledCount: settledOrder.length,
    complete,
    horizon,
    initialQueuePushes: initStats.pushes,
    initialHeapComparisons: initStats.comparisons,
    frontierUpperBound,
    openExtensionUpperBound(pendingCap: number | undefined): ReadonlyMap<string, number> {
      if (pendingCap === undefined) return frontierUpperBound;
      const cap = requireGrade(pendingCap, top);
      const bounded = new Map<string, number>();
      for (const id of nodeIds) {
        const current = frontierUpperBound.get(id);
        bounded.set(id, current === undefined ? cap : Math.max(current, cap));
      }
      return bounded;
    }
  };
}

function computeFrontierCertificate(
  nodeIds: readonly string[],
  seeds: ReadonlyMap<number, number>,
  rules: readonly NormalizedRule[],
  outgoing: readonly number[][],
  tentative: Float64Array,
  settled: Uint8Array,
  horizon: number,
  top: number
): ReadonlyMap<string, number> {
  const n = nodeIds.length;
  const cIn = new Float64Array(n).fill(-1);
  const reachable = new Uint8Array(n);
  const boolRemaining = new Int32Array(rules.length);
  const bfsQueue: number[] = [];

  for (const [node, grade] of seeds) {
    cIn[node] = Math.max(cIn[node]!, grade);
    if (reachable[node] === 0) {
      reachable[node] = 1;
      bfsQueue.push(node);
    }
  }
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]!;
    boolRemaining[i] = rule.premises.length;
    if (rule.kind !== "or" || rule.premises.length > 0) {
      cIn[rule.head] = Math.max(cIn[rule.head]!, rule.capacity);
    }
    if (rule.kind === "and" && rule.premises.length === 0 && reachable[rule.head] === 0) {
      reachable[rule.head] = 1;
      bfsQueue.push(rule.head);
    }
  }
  propagateBooleanReachability(rules, outgoing, boolRemaining, reachable, bfsQueue);

  const certificate = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    if (reachable[i] === 0 || cIn[i]! < 0) continue;
    const bar = settled[i] === 1 ? tentative[i]! : horizon;
    certificate.set(nodeIds[i]!, Math.min(bar, cIn[i]!, top));
  }
  return certificate;
}

function propagateBooleanReachability(
  rules: readonly NormalizedRule[],
  outgoing: readonly number[][],
  boolRemaining: Int32Array,
  reachable: Uint8Array,
  queue: number[]
): void {
  const orSeen = new Uint8Array(rules.length);
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    for (const ruleIdx of outgoing[u]!) {
      const rule = rules[ruleIdx]!;
      if (rule.kind === "and") {
        const rem = boolRemaining[ruleIdx]! - 1;
        boolRemaining[ruleIdx] = rem;
        if (rem !== 0) continue;
      } else if (rule.kind === "or") {
        if (orSeen[ruleIdx] === 1) continue;
        orSeen[ruleIdx] = 1;
      }
      if (reachable[rule.head] === 0) {
        reachable[rule.head] = 1;
        queue.push(rule.head);
      }
    }
  }
}

function normalizeStepLimit(maxSettledSteps: number | undefined): number {
  if (maxSettledSteps === undefined || !Number.isFinite(maxSettledSteps)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, Math.trunc(maxSettledSteps));
}
