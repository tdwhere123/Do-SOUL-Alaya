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
  const droppedRoots = new Set<string>();
  const transitions = reach.transitions.filter((edge) => {
    if (edge.instance_id === undefined || !assertionIds.has(edge.instance_id)) return true;
    droppedRoots.add(transitionKey(edge));
    return false;
  });
  const roots: Record<string, string> = {};
  for (const [key, value] of Object.entries(reach.roots)) {
    if (droppedRoots.has(key) || namesLeaf(value, assertionIds)) continue;
    roots[key] = value;
  }
  return {
    states: reach.states,
    transitions,
    derivations: reach.derivations.filter((row) => !derivationNamesAssertion(row, assertionIds)),
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

function namesLeaf(derivationId: string, assertionIds: ReadonlySet<string>): boolean {
  for (const id of assertionIds) if (derivationId === `leaf:${id}`) return true;
  return false;
}

function derivationNamesAssertion(row: Derivation, assertionIds: ReadonlySet<string>): boolean {
  if (namesLeaf(row.derivation_id, assertionIds)) return true;
  for (const leaf of row.leaf_ids) if (assertionIds.has(leaf)) return true;
  return false;
}

function reachMentionsAssertion(reach: SequenceReach, assertionId: string): boolean {
  if (reach.transitions.some((edge) => edge.instance_id === assertionId)) return true;
  if (reach.unresolved.some((pair) => pair.row.assertionId === assertionId)) return true;
  return reach.derivations.some((row) => derivationNamesAssertion(row, new Set([assertionId])));
}
