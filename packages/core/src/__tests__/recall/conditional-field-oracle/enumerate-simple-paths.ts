import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MILLIGRADE_BOTTOM,
  MILLIGRADE_TOP,
  canonicalProductIdentity,
  memoryProductStateKey,
  type FacetMode,
  type FacetVector,
  type FieldValue,
  type ProductStateKey,
  type QueryProgram,
  type Witness
} from "@do-soul/alaya-protocol";

export const ORACLE_NODE_CAP = 40;
export const ORACLE_EDGE_CAP = 48;
export const ORACLE_PATH_CAP = 24;

export type OracleEdge = Readonly<{
  readonly from: ProductStateKey;
  readonly to: ProductStateKey;
  readonly relation_kind: string;
  readonly strength_milligrades: number;
  readonly applicable: boolean;
  readonly cost: number;
}>;

export type OracleSeed = Readonly<{
  readonly state: ProductStateKey;
  readonly milligrades: number;
}>;

export type SimplePathWitness = Readonly<{
  readonly nodes: readonly ProductStateKey[];
  readonly bottleneck: number;
  readonly cost: number;
}>;

export type EnumeratedField = Readonly<{
  readonly kind: "enumerated" | "unsupported";
  readonly reason?: string;
  readonly values: ReadonlyMap<string, number>;
  readonly accepting: readonly FieldValue[];
  readonly witnesses: readonly SimplePathWitness[];
}>;

export type FiniteProgram =
  | { readonly kind: "epsilon" }
  | { readonly kind: "empty" }
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "program"; readonly program: QueryProgram };

export type HyperedgePremise = Readonly<{
  readonly hypothesis_id: string;
  readonly binding_context: string;
  readonly time_state: string;
  readonly present: boolean;
}>;

export function productKey(
  objectId: string,
  hypothesisId = "h0",
  bindingContext = "default",
  programState = "accepting",
  timeState = "as_of"
): ProductStateKey {
  return memoryProductStateKey({
    workspace_id: "ws",
    object_id: objectId,
    source_revision: "rev",
    program_state: programState,
    hypothesis_id: hypothesisId,
    binding_context: bindingContext,
    time_state: timeState
  });
}

export function productStateId(state: ProductStateKey): string {
  return canonicalProductIdentity(state);
}

export function clampMilligrade(value: number): number {
  if (!Number.isFinite(value)) return MILLIGRADE_BOTTOM;
  const integer = Math.trunc(value);
  if (integer < MILLIGRADE_BOTTOM) return MILLIGRADE_BOTTOM;
  if (integer > MILLIGRADE_TOP) return MILLIGRADE_TOP;
  return integer;
}

export function enumerateSimplePaths(
  seeds: readonly OracleSeed[],
  edges: readonly OracleEdge[]
): EnumeratedField {
  const legal = edges.filter((edge) => edge.applicable);
  const nodes = collectNodes(seeds, legal);
  if (nodes.size > ORACLE_NODE_CAP || legal.length > ORACLE_EDGE_CAP) {
    return unsupportedField("finite world exceeds oracle caps");
  }
  const values = new Map<string, number>();
  for (const nodeId of nodes.keys()) values.set(nodeId, MILLIGRADE_BOTTOM);
  for (const seed of seeds) {
    const id = productStateId(seed.state);
    values.set(id, Math.max(values.get(id) ?? MILLIGRADE_BOTTOM, clampMilligrade(seed.milligrades)));
  }
  const outgoing = adjacency(legal);
  const witnesses: SimplePathWitness[] = [];
  for (const seed of seeds) {
    const start = clampMilligrade(seed.milligrades);
    if (start <= MILLIGRADE_BOTTOM) continue;
    walkSimplePaths(seed.state, start, 0, [productStateId(seed.state)], [seed.state], outgoing, values, witnesses);
  }
  return {
    kind: "enumerated",
    values,
    accepting: projectAccepting(nodes, values),
    witnesses
  };
}

export function interpretFiniteProgram(program: QueryProgram): FiniteProgram {
  switch (program.kind) {
    case "epsilon":
      return { kind: "epsilon" };
    case "empty":
      return { kind: "empty" };
    case "relation":
      return { kind: "program", program };
    case "sequence":
      return interpretSequence(program.steps);
    case "alternative":
      return interpretAlternative(program.options);
    case "repeat":
      if (program.count < 1 || program.count > 8) {
        return { kind: "unsupported", reason: "repeat count outside 1..8" };
      }
      return interpretSequence(Array.from({ length: program.count }, () => program.body));
    case "closure":
      return program.product_state_sufficient === true
        ? { kind: "program", program }
        : { kind: "unsupported", reason: "closure requires product_state_sufficient" };
    case "hyperedge":
      return { kind: "program", program };
  }
}

export function evaluateFacets(
  mode: FacetMode,
  vectors: readonly FacetVector[],
  threshold: number
): boolean {
  if (vectors.length === 0) return true;
  if (mode === "same_path") {
    return vectors.some((vector) => vector.coordinates.every((value) => value > threshold));
  }
  const width = Math.max(...vectors.map((vector) => vector.coordinates.length));
  for (let index = 0; index < width; index += 1) {
    let best = MILLIGRADE_BOTTOM;
    for (const vector of vectors) {
      const value = vector.coordinates[index] ?? MILLIGRADE_BOTTOM;
      if (value > best) best = value;
    }
    if (best <= threshold) return false;
  }
  return true;
}

export function joinHyperedgeAnd(premises: readonly HyperedgePremise[]): boolean {
  if (premises.length === 0 || !premises.every((premise) => premise.present)) return false;
  const first = premises[0];
  if (first === undefined) return false;
  return premises.every((premise) =>
    premise.hypothesis_id === first.hypothesis_id
    && premise.binding_context === first.binding_context
    && premise.time_state === first.time_state
  );
}

export function joinHyperedgeOr(witnesses: readonly Witness[]): readonly Witness[] {
  return witnesses.filter((witness) => witness.complete);
}

export function selectFeasibleWitnesses(
  witnesses: readonly Witness[],
  pageBudget: number
): readonly Witness[] {
  return witnesses.filter((witness) => witness.complete && witness.cost <= pageBudget);
}

export function cheapestCompleteWitness(
  witnesses: readonly Witness[],
  pageBudget: number
): Witness | undefined {
  const feasible = selectFeasibleWitnesses(witnesses, pageBudget);
  let best: Witness | undefined;
  for (const witness of feasible) {
    if (best === undefined || witness.cost < best.cost) best = witness;
  }
  return best;
}

function collectNodes(
  seeds: readonly OracleSeed[],
  edges: readonly OracleEdge[]
): Map<string, ProductStateKey> {
  const nodes = new Map<string, ProductStateKey>();
  for (const seed of seeds) nodes.set(productStateId(seed.state), seed.state);
  for (const edge of edges) {
    nodes.set(productStateId(edge.from), edge.from);
    nodes.set(productStateId(edge.to), edge.to);
  }
  return nodes;
}

function adjacency(edges: readonly OracleEdge[]): ReadonlyMap<string, readonly OracleEdge[]> {
  const outgoing = new Map<string, OracleEdge[]>();
  for (const edge of edges) {
    const from = productStateId(edge.from);
    const list = outgoing.get(from);
    if (list === undefined) outgoing.set(from, [edge]);
    else list.push(edge);
  }
  return outgoing;
}

function walkSimplePaths(
  node: ProductStateKey,
  bottleneck: number,
  cost: number,
  seen: readonly string[],
  path: readonly ProductStateKey[],
  outgoing: ReadonlyMap<string, readonly OracleEdge[]>,
  values: Map<string, number>,
  witnesses: SimplePathWitness[]
): void {
  const nodeId = productStateId(node);
  values.set(nodeId, Math.max(values.get(nodeId) ?? MILLIGRADE_BOTTOM, bottleneck));
  witnesses.push({ nodes: path, bottleneck, cost });
  if (path.length >= ORACLE_PATH_CAP) return;
  for (const edge of outgoing.get(nodeId) ?? []) {
    const nextId = productStateId(edge.to);
    if (seen.includes(nextId)) continue;
    walkSimplePaths(
      edge.to,
      Math.min(bottleneck, clampMilligrade(edge.strength_milligrades)),
      cost + edge.cost,
      [...seen, nextId],
      [...path, edge.to],
      outgoing,
      values,
      witnesses
    );
  }
}

function projectAccepting(
  nodes: ReadonlyMap<string, ProductStateKey>,
  values: ReadonlyMap<string, number>
): readonly FieldValue[] {
  const accepting: FieldValue[] = [];
  for (const [nodeId, state] of nodes) {
    const milligrades = values.get(nodeId) ?? MILLIGRADE_BOTTOM;
    accepting.push({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      state,
      milligrades,
      accepting: state.program_state === "accepting"
    });
  }
  return accepting;
}

function unsupportedField(reason: string): EnumeratedField {
  return { kind: "unsupported", reason, values: new Map(), accepting: [], witnesses: [] };
}

function interpretSequence(steps: readonly QueryProgram[]): FiniteProgram {
  const kept: QueryProgram[] = [];
  for (const step of steps) {
    const result = interpretFiniteProgram(step);
    if (result.kind === "unsupported") return result;
    if (result.kind === "empty") return { kind: "empty" };
    if (result.kind === "epsilon") continue;
    kept.push(result.program);
  }
  if (kept.length === 0) return { kind: "epsilon" };
  if (kept.length === 1) {
    const only = kept[0];
    return only === undefined ? { kind: "unsupported", reason: "empty sequence remainder" } : { kind: "program", program: only };
  }
  return { kind: "program", program: { schema_version: 1, kind: "sequence", steps: kept } };
}

function interpretAlternative(options: readonly QueryProgram[]): FiniteProgram {
  const kept: QueryProgram[] = [];
  for (const option of options) {
    const result = interpretFiniteProgram(option);
    if (result.kind === "unsupported") return result;
    if (result.kind === "empty") continue;
    if (result.kind === "epsilon") {
      kept.push({ schema_version: 1, kind: "epsilon" });
      continue;
    }
    kept.push(result.program);
  }
  if (kept.length === 0) return { kind: "empty" };
  if (kept.length === 1) {
    const only = kept[0];
    if (only === undefined) return { kind: "unsupported", reason: "empty alternative remainder" };
    if (only.kind === "epsilon") return { kind: "epsilon" };
    return { kind: "program", program: only };
  }
  return { kind: "program", program: { schema_version: 1, kind: "alternative", options: kept } };
}
