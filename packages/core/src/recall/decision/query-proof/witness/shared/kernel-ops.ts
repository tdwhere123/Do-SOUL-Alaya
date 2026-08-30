import type {
  TypedWitness,
  WitnessDomainKind,
  WitnessEpistemic
} from "./types.js";

export type PayloadOps<P> = Readonly<{
  readonly leq: (wide: P, narrow: P) => boolean;
  readonly equal: (left: P, right: P) => boolean;
  readonly meet: (left: P, right: P) => P | "conflict";
  readonly join: (left: P, right: P) => P;
  readonly contradictory: (left: P, right: P) => boolean;
  readonly sameCell?: (left: P, right: P) => boolean;
  readonly refineConflict?: (from: P, to: P) => boolean;
  readonly epistemicFor?: (payload: P) => WitnessEpistemic;
  readonly conflictPayload?: (left: P | null, right: P | null) => P | null;
}>;

export function samePayloadCell<K extends WitnessDomainKind, P>(
  ops: PayloadOps<P>,
  left: TypedWitness<K, P>,
  right: TypedWitness<K, P>
): boolean {
  if (left.payload === null || right.payload === null) return true;
  return ops.sameCell?.(left.payload, right.payload) ?? true;
}

export function payloadEqual<P>(
  ops: PayloadOps<P>,
  left: P | null,
  right: P | null
): boolean {
  if (left === null || right === null) return left === right;
  return ops.equal(left, right);
}
