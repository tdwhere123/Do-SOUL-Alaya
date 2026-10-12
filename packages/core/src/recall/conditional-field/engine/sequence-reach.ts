import type { Derivation, ProductStateKey, QueryProgram, Transition } from "@do-soul/alaya-protocol";
import { stableStringify } from "../../../shared/stable-stringify.js";
import type { QueryRelation } from "../query/compile-query.js";
import { transitionKey } from "./path-composition.js";
import { derivationForest, evaluateDerivation, reviseDerivations } from "./path-derivation.js";
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
const bytesByOwner = new WeakMap<object, number>();

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

export function sequenceReachFootprint(reach: SequenceReach): number {
  return Buffer.byteLength(JSON.stringify(reach), "utf8");
}

export function sequenceReachAccountBytes(owner: object | undefined): number {
  if (owner === undefined) return 0;
  return bytesByOwner.get(owner) ?? 0;
}

export function reserveSequenceReach(owner: object, bytes: number): void {
  if (bytes <= 0) return;
  bytesByOwner.set(owner, sequenceReachAccountBytes(owner) + bytes);
}

export function releaseSequenceReach(owner: object, bytes: number): void {
  if (bytes <= 0) return;
  const next = sequenceReachAccountBytes(owner) - bytes;
  if (next <= 0) bytesByOwner.delete(owner);
  else bytesByOwner.set(owner, next);
}

function reachBucket(owner: object): Map<string, SequenceReach> {
  let bucket = reachByOwner.get(owner);
  if (bucket === undefined) {
    bucket = new Map();
    reachByOwner.set(owner, bucket);
  }
  return bucket;
}

/** Replace one stored frontier and move its bytes onto the persistent owner. */
export function replaceSequenceReach(owner: object, key: string, reach: SequenceReach): void {
  const bucket = reachBucket(owner);
  const prior = bucket.get(key);
  if (prior !== undefined) releaseSequenceReach(owner, sequenceReachFootprint(prior));
  bucket.set(key, reach);
  reserveSequenceReach(owner, sequenceReachFootprint(reach));
}

export function writeSequenceReach(owner: object, key: string, reach: SequenceReach): void {
  replaceSequenceReach(owner, key, reach);
}

export function transferSequenceReachCharge(
  field: Readonly<{ sequence_reach_bytes?: number }>,
  owner: object | undefined
): Readonly<{ sequence_reach_bytes: number; delta: number }> {
  const sequence_reach_bytes = sequenceReachAccountBytes(owner);
  return { sequence_reach_bytes, delta: sequence_reach_bytes - (field.sequence_reach_bytes ?? 0) };
}

/** A revised or withdrawn assertion must not keep the hop it already contributed. */
export function sequenceReachWithoutAssertions(reach: SequenceReach, assertionIds: ReadonlySet<string>): SequenceReach {
  if (assertionIds.size === 0) return reach;
  const revised = reviseStoredDerivations(reach.derivations, assertionIds);
  const kept = transitionsAfterWithdrawal(reach, revised, assertionIds);
  return {
    states: reach.states,
    transitions: kept.transitions,
    derivations: revised.derivations,
    roots: kept.roots,
    unresolved: reach.unresolved.filter((pair) => !assertionIds.has(pair.row.assertionId))
  };
}

export function dropSequenceReachAssertion(owner: object | undefined, assertionId: string): void {
  if (owner === undefined) return;
  const bucket = reachByOwner.get(owner);
  if (bucket === undefined) return;
  const ids = new Set([assertionId]);
  for (const [key, reach] of [...bucket]) {
    if (!reachMentionsAssertion(reach, assertionId)) continue;
    replaceSequenceReach(owner, key, sequenceReachWithoutAssertions(reach, ids));
  }
}

type RevisedDerivations = Readonly<{
  derivations: readonly Derivation[];
  alias: ReadonlyMap<string, string | undefined>;
}>;

function reviseStoredDerivations(rows: readonly Derivation[], assertionIds: ReadonlySet<string>): RevisedDerivations {
  let derivations = rows;
  let alias = new Map<string, string | undefined>(rows.map((row) => [row.derivation_id, row.derivation_id]));
  for (const assertionId of assertionIds) {
    const revised = reviseDerivations(derivations, assertionId);
    const next = new Map<string, string | undefined>();
    for (const [original, current] of alias) {
      if (current === undefined) next.set(original, undefined);
      else next.set(original, revised.roots.has(current) ? revised.roots.get(current) : current);
    }
    alias = next;
    derivations = revised.derivations;
  }
  return { derivations, alias };
}

function transitionsAfterWithdrawal(
  reach: SequenceReach,
  revised: RevisedDerivations,
  assertionIds: ReadonlySet<string>
): {
  readonly transitions: Transition[];
  readonly roots: Record<string, string>;
} {
  const forest = derivationForest(revised.derivations);
  const grades = leafGrades(revised.derivations);
  const transitions: Transition[] = [];
  const roots: Record<string, string> = {};
  const seen = new Set<string>();
  for (const edge of reach.transitions) {
    const next = survivingTransition(edge, reach.roots[transitionKey(edge)], revised.alias, assertionIds, grades, forest);
    if (next === undefined) continue;
    const key = transitionKey(next.edge);
    if (seen.has(key)) continue;
    seen.add(key);
    transitions.push(next.edge);
    if (next.root !== undefined) roots[key] = next.root;
  }
  return { transitions, roots };
}

function leafGrades(rows: readonly Derivation[]): Map<string, number> {
  const grades = new Map<string, number>();
  for (const row of rows) {
    if (row.association_milligrades === undefined) continue;
    grades.set(row.derivation_id, row.association_milligrades);
    for (const id of row.leaf_ids) grades.set(id, row.association_milligrades);
  }
  return grades;
}

function survivingTransition(
  edge: Transition,
  rootId: string | undefined,
  alias: ReadonlyMap<string, string | undefined>,
  assertionIds: ReadonlySet<string>,
  grades: ReadonlyMap<string, number>,
  forest: ReturnType<typeof derivationForest>
): { readonly edge: Transition; readonly root?: string } | undefined {
  const root = rootId === undefined ? undefined : mappedDerivation(rootId, alias);
  // A root that lost every child no longer proves this hop.
  if (rootId !== undefined && root === undefined) return undefined;
  const instance = retargetInstance(edge.instance_id, root, alias, assertionIds);
  if (instance === null) return undefined;
  let next = instance === edge.instance_id ? edge : { ...edge, instance_id: instance };
  if (root !== undefined && root !== rootId) {
    const grade = evaluateDerivation(forest, root, grades);
    if (grade !== undefined && grade !== next.strength_milligrades) next = { ...next, strength_milligrades: grade };
  }
  return root === undefined ? { edge: next } : { edge: next, root };
}

function mappedDerivation(id: string, alias: ReadonlyMap<string, string | undefined>): string | undefined {
  return alias.has(id) ? alias.get(id) : id;
}

function retargetInstance(
  instanceId: string | undefined,
  root: string | undefined,
  alias: ReadonlyMap<string, string | undefined>,
  assertionIds: ReadonlySet<string>
): string | undefined | null {
  if (instanceId === undefined) return undefined;
  const withdrawn = idNamesAssertion(instanceId, assertionIds) || (alias.has(instanceId) && alias.get(instanceId) === undefined);
  if (withdrawn) return root === undefined ? null : root;
  return alias.has(instanceId) ? alias.get(instanceId) : instanceId;
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
