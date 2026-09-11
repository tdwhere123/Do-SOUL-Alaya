export type BooleanHyperedge =
  | UnaryBooleanEdge
  | AndBooleanHyperedge
  | OrBooleanHyperedge
  | IdentityBooleanEdge;

export interface UnaryBooleanEdge {
  readonly kind: "unary";
  readonly from: string;
  readonly to: string;
  readonly strength: number;
}

export interface AndBooleanHyperedge {
  readonly kind: "and";
  readonly from: readonly string[];
  readonly to: string;
  readonly strength: number;
}

export interface OrBooleanHyperedge {
  readonly kind: "or";
  readonly from: readonly string[];
  readonly to: string;
  readonly strength: number;
}

export interface IdentityBooleanEdge {
  readonly kind: "identity";
  readonly from: string;
  readonly to: string;
}

export interface BooleanHypergraphInput {
  readonly nodeIds: readonly string[];
  readonly seeds: ReadonlyMap<string, number>;
  readonly edges: readonly BooleanHyperedge[];
  readonly bottom: 0;
  readonly top: number;
}

/** Per-grade joint closure. Absent keys are unreachable, not a default 0. */
export function evaluateBooleanHypergraph(
  input: BooleanHypergraphInput
): ReadonlyMap<string, number> {
  const top = requireIntegerTop(input.top, input.bottom);
  const nodeSet = new Set(uniqueNodeIds(input.nodeIds));
  const seeds = collectSeeds(nodeSet, input.seeds, input.bottom, top);
  const edges = legalEdges(nodeSet, input.edges, input.bottom, top);
  const byPremise = indexByPremise(edges);
  const values = new Map<string, number>();
  for (const grade of descendingGrades(seeds, edges, top)) {
    for (const nodeId of closureAtGrade(grade, seeds, byPremise)) {
      if (!values.has(nodeId)) values.set(nodeId, grade);
    }
  }
  return values;
}

function requireIntegerTop(top: number, bottom: 0): number {
  if (bottom !== 0 || !Number.isInteger(top) || top < 0) {
    throw new Error("boolean hypergraph top must be a nonnegative integer with bottom 0");
  }
  return top;
}

function uniqueNodeIds(nodeIds: readonly string[]): readonly string[] {
  return [...new Set(nodeIds)];
}

function clampInteger(value: number, bottom: number, top: number): number {
  if (!Number.isFinite(value)) return bottom;
  const integer = Math.trunc(value);
  if (integer < bottom) return bottom;
  if (integer > top) return top;
  return integer;
}

function collectSeeds(
  nodeIds: ReadonlySet<string>,
  seeds: ReadonlyMap<string, number>,
  bottom: 0,
  top: number
): ReadonlyMap<string, number> {
  const collected = new Map<string, number>();
  for (const [nodeId, value] of seeds) {
    if (!nodeIds.has(nodeId)) continue;
    const grade = clampInteger(value, bottom, top);
    const prior = collected.get(nodeId);
    if (prior === undefined || grade > prior) collected.set(nodeId, grade);
  }
  return collected;
}

function legalEdges(
  nodeIds: ReadonlySet<string>,
  edges: readonly BooleanHyperedge[],
  bottom: 0,
  top: number
): readonly BooleanHyperedge[] {
  const legal: BooleanHyperedge[] = [];
  for (const edge of edges) {
    if (!nodeIds.has(edge.to)) continue;
    if (edge.kind === "identity") {
      if (!nodeIds.has(edge.from)) continue;
      legal.push({ kind: "identity", from: edge.from, to: edge.to });
      continue;
    }
    if (edge.kind === "unary") {
      if (!nodeIds.has(edge.from)) continue;
      legal.push({
        kind: "unary",
        from: edge.from,
        to: edge.to,
        strength: clampInteger(edge.strength, bottom, top)
      });
      continue;
    }
    if (edge.from.length === 0 || edge.from.some((nodeId) => !nodeIds.has(nodeId))) continue;
    legal.push({
      kind: edge.kind,
      from: [...edge.from],
      to: edge.to,
      strength: clampInteger(edge.strength, bottom, top)
    });
  }
  return legal;
}

function indexByPremise(
  edges: readonly BooleanHyperedge[]
): ReadonlyMap<string, readonly BooleanHyperedge[]> {
  const index = new Map<string, BooleanHyperedge[]>();
  for (const edge of edges) {
    for (const nodeId of premisesOf(edge)) {
      const list = index.get(nodeId);
      if (list === undefined) index.set(nodeId, [edge]);
      else list.push(edge);
    }
  }
  return index;
}

function descendingGrades(
  seeds: ReadonlyMap<string, number>,
  edges: readonly BooleanHyperedge[],
  top: number
): readonly number[] {
  if (seeds.size === 0) return [];
  const grades = new Set<number>();
  for (const value of seeds.values()) grades.add(value);
  for (const edge of edges) {
    if (edge.kind === "identity") grades.add(top);
    else grades.add(edge.strength);
  }
  return [...grades].sort((left, right) => right - left);
}

function closureAtGrade(
  grade: number,
  seeds: ReadonlyMap<string, number>,
  byPremise: ReadonlyMap<string, readonly BooleanHyperedge[]>
): Set<string> {
  const on = new Set<string>();
  const pending: string[] = [];
  for (const [nodeId, value] of seeds) {
    if (value < grade) continue;
    on.add(nodeId);
    pending.push(nodeId);
  }
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    for (const edge of byPremise.get(nodeId) ?? []) {
      if (on.has(edge.to) || !edgeFires(edge, grade, on)) continue;
      on.add(edge.to);
      pending.push(edge.to);
    }
  }
  return on;
}

function edgeFires(edge: BooleanHyperedge, grade: number, on: ReadonlySet<string>): boolean {
  switch (edge.kind) {
    case "unary":
      return edge.strength >= grade && on.has(edge.from);
    case "and":
      return edge.strength >= grade && edge.from.every((nodeId) => on.has(nodeId));
    case "or":
      return edge.strength >= grade && edge.from.some((nodeId) => on.has(nodeId));
    case "identity":
      // Admitted identity sits at top, so it copies the source grade instead of min-capping it.
      return on.has(edge.from);
  }
}

function premisesOf(edge: BooleanHyperedge): readonly string[] {
  return edge.kind === "and" || edge.kind === "or" ? edge.from : [edge.from];
}
