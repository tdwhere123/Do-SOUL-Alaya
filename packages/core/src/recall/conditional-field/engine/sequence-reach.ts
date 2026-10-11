import type { Derivation, ProductStateKey, QueryProgram, Transition } from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";
import type { QueryRelation } from "../query/compile-query.js";
import { transitionKey } from "./path-composition.js";
import type { AdjacencyRow } from "./path-matching.js";

/** A hop that already failed for lack of a target revision. */
export type UnresolvedHop = Readonly<{
  /** Binding after locals are removed. Row admission still uses this env. */
  readonly here: ProductStateKey;
  /** Visited state. The stripped binding does not leave the seed graph. */
  readonly node: ProductStateKey;
  readonly row: AdjacencyRow;
  readonly relation: QueryRelation;
  readonly nextStates: readonly string[];
}>;

/** Partial sequence reach from an earlier pass. A later row delta extends it. */
export type SequenceReach = Readonly<{
  readonly states: readonly ProductStateKey[];
  readonly transitions: readonly Transition[];
  readonly derivations: readonly Derivation[];
  readonly roots: Readonly<Record<string, string>>;
  readonly unresolved: readonly UnresolvedHop[];
}>;

const programIds = new WeakMap<QueryProgram, string>();
const structuralIds = new Map<string, string>();
let nextProgramKey = 0;
const reachByOwner = new WeakMap<object, Map<string, SequenceReach>>();

function programStorageId(program: QueryProgram): string {
  let key = programIds.get(program);
  if (key !== undefined) return key;
  const canonical = stableStringify(program);
  key = structuralIds.get(canonical);
  if (key === undefined) {
    nextProgramKey += 1;
    key = String(nextProgramKey);
    structuralIds.set(canonical, key);
  }
  programIds.set(program, key);
  return key;
}

export function sequenceReachKey(program: QueryProgram, fromId: string): string {
  return `${programStorageId(program)}\0${fromId}`;
}

/** True when this owner already remembered some state of the program. */
export function sequenceProgramHasReach(owner: object, program: QueryProgram): boolean {
  const bucket = reachByOwner.get(owner);
  if (bucket === undefined) return false;
  const prefix = `${programStorageId(program)}\0`;
  for (const key of bucket.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * A delta with no stored program reach reads the population. Remember that
 * for the rest of the page so a later product is not flipped by a write.
 */
export function sequenceProgramIsCold(
  owner: object | undefined,
  program: QueryProgram,
  rememberedCold: Set<string> | undefined
): boolean {
  if (owner === undefined) return true;
  const id = programStorageId(program);
  if (rememberedCold?.has(id)) return true;
  if (sequenceProgramHasReach(owner, program)) return false;
  rememberedCold?.add(id);
  return true;
}

export function readSequenceReach(owner: object, key: string): SequenceReach | undefined {
  return reachByOwner.get(owner)?.get(key);
}

export function writeSequenceReach(owner: object, key: string, reach: SequenceReach): void {
  let bucket = reachByOwner.get(owner);
  if (bucket === undefined) {
    bucket = new Map();
    reachByOwner.set(owner, bucket);
  }
  bucket.set(key, reach);
}

/** A revised or withdrawn assertion must not keep the hop it already contributed. */
export function sequenceReachWithoutAssertions(reach: SequenceReach, assertionIds: ReadonlySet<string>): SequenceReach {
  if (assertionIds.size === 0) return reach;
  const forest = derivationForest(reach.derivations);
  const droppedRoots = new Set<string>();
  const transitions = reach.transitions.filter((edge) => {
    if (!transitionCarriesAssertion(edge, reach.roots, forest, assertionIds)) return true;
    droppedRoots.add(transitionKey(edge));
    return false;
  });
  const roots: Record<string, string> = {};
  for (const [key, value] of Object.entries(reach.roots)) {
    if (droppedRoots.has(key) || derivationTreeNamesAssertion(value, forest, assertionIds)) continue;
    roots[key] = value;
  }
  return {
    states: reach.states,
    transitions,
    derivations: reach.derivations.filter((row) => !derivationTreeNamesAssertion(row.derivation_id, forest, assertionIds)),
    roots,
    unresolved: reach.unresolved.filter((pair) => !assertionIds.has(pair.row.assertionId))
  };
}

export function dropSequenceReachAssertion(owner: object | undefined, assertionId: string): void {
  if (owner === undefined) return;
  const bucket = reachByOwner.get(owner);
  if (bucket === undefined) return;
  const ids = new Set([assertionId]);
  for (const [key, reach] of bucket) {
    if (!reachMentionsAssertion(reach, assertionId)) continue;
    bucket.set(key, sequenceReachWithoutAssertions(reach, ids));
  }
}

function derivationForest(rows: readonly Derivation[]): Map<string, Derivation> {
  return new Map(rows.map((row) => [row.derivation_id, row]));
}

function transitionCarriesAssertion(
  edge: Transition,
  roots: Readonly<Record<string, string>>,
  forest: ReadonlyMap<string, Derivation>,
  assertionIds: ReadonlySet<string>
): boolean {
  if (edge.instance_id !== undefined && idNamesAssertion(edge.instance_id, assertionIds)) return true;
  const rootId = roots[transitionKey(edge)];
  if (rootId !== undefined && derivationTreeNamesAssertion(rootId, forest, assertionIds)) return true;
  // A hyperedge step stores the join id. The assertion is only named by a child.
  return edge.instance_id !== undefined && derivationTreeNamesAssertion(edge.instance_id, forest, assertionIds);
}

function derivationTreeNamesAssertion(
  rootId: string,
  forest: ReadonlyMap<string, Derivation>,
  assertionIds: ReadonlySet<string>
): boolean {
  const pending = [rootId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (idNamesAssertion(id, assertionIds)) return true;
    const row = forest.get(id);
    if (row === undefined) continue;
    for (const leaf of row.leaf_ids) if (assertionIds.has(leaf)) return true;
    for (const child of row.children) pending.push(child);
  }
  return false;
}

function idNamesAssertion(id: string, assertionIds: ReadonlySet<string>): boolean {
  if (assertionIds.has(id)) return true;
  for (const assertionId of assertionIds) if (id === `leaf:${assertionId}`) return true;
  return false;
}

function reachMentionsAssertion(reach: SequenceReach, assertionId: string): boolean {
  const ids = new Set([assertionId]);
  const forest = derivationForest(reach.derivations);
  if (reach.transitions.some((edge) => transitionCarriesAssertion(edge, reach.roots, forest, ids))) return true;
  if (reach.unresolved.some((pair) => pair.row.assertionId === assertionId)) return true;
  return reach.derivations.some((row) => derivationTreeNamesAssertion(row.derivation_id, forest, ids));
}
