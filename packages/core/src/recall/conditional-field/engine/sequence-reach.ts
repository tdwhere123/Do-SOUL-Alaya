import type { Derivation, ProductStateKey, QueryProgram, Transition } from "@do-soul/alaya-protocol";
import type { QueryRelation } from "../query/compile-query.js";
import type { AdjacencyRow } from "./path-matching.js";

/** A hop that already failed for lack of a target revision. */
export type UnresolvedHop = Readonly<{
  readonly here: ProductStateKey;
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

const programKeys = new WeakMap<QueryProgram, string>();
let nextProgramKey = 0;
const reachByOwner = new WeakMap<object, Map<string, SequenceReach>>();

export function sequenceReachKey(program: QueryProgram, fromId: string): string {
  let key = programKeys.get(program);
  if (key === undefined) {
    nextProgramKey += 1;
    key = String(nextProgramKey);
    programKeys.set(program, key);
  }
  return `${key}\0${fromId}`;
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
