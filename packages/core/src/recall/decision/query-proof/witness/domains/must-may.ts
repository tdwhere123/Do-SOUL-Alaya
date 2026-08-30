import { compareText } from "../../../../../shared/compare-text.js";
import { ShadowContractError } from "../../../prefix-capture/envelope.js";
import { createTypedWitness, rejectPayload } from "../shared/create.js";
import { joinWitness, meetWitness, refineWitness } from "../shared/kernel.js";
import { compareWitness, informationLeq } from "../shared/kernel-order.js";
import type { PayloadOps } from "../shared/kernel-ops.js";
import type {
  TypedWitness,
  WitnessCreateInput,
  WitnessEpistemic,
  WitnessInformationOrder
} from "../shared/types.js";

export type MustMayPayload = Readonly<{
  readonly must: readonly string[];
  readonly may: readonly string[];
}>;

export type MustMayWitness = TypedWitness<"must_may_set", MustMayPayload>;
export type MustMayInput = WitnessCreateInput<MustMayPayload>;

const MUST_MAY_OPS: PayloadOps<MustMayPayload> = Object.freeze({
  leq: mustMayLeq,
  equal: mustMayEqual,
  meet: mustMayMeet,
  join: mustMayJoin,
  contradictory: mustMayContradictory
});

export function createMustMayWitness(input: MustMayInput): MustMayWitness {
  return createTypedWitness("must_may_set", input, ["candidate_id"], mustMayPayload);
}

export function compareMustMay(
  left: MustMayWitness,
  right: MustMayWitness
): WitnessInformationOrder {
  return compareWitness(MUST_MAY_OPS, left, right);
}

export function mustMayInformationLeq(wide: MustMayWitness, narrow: MustMayWitness): boolean {
  return informationLeq(MUST_MAY_OPS, wide, narrow);
}

export function refineMustMay(from: MustMayWitness, to: MustMayWitness): MustMayWitness {
  return refineWitness(MUST_MAY_OPS, from, to);
}

export function meetMustMay(left: MustMayWitness, right: MustMayWitness): MustMayWitness {
  return meetWitness(MUST_MAY_OPS, left, right);
}

export function joinMustMay(left: MustMayWitness, right: MustMayWitness): MustMayWitness {
  return joinWitness(MUST_MAY_OPS, left, right);
}

function mustMayPayload(
  epistemic: WitnessEpistemic,
  payload: MustMayPayload | null | undefined
): MustMayPayload | null {
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (payload === null || payload === undefined) {
    if ("known_zero" in epistemic) return null;
    throw new ShadowContractError("exact must/may set requires members");
  }
  return parseMustMay(payload);
}

function parseMustMay(payload: MustMayPayload): MustMayPayload {
  const must = freezeMembers(payload.must, "must");
  const may = freezeMembers(payload.may, "may");
  if (!isSubset(must, may)) {
    throw new ShadowContractError("must must be a subset of may");
  }
  return Object.freeze({ must, may });
}

function mustMayLeq(wide: MustMayPayload, narrow: MustMayPayload): boolean {
  return isSubset(wide.must, narrow.must) && isSubset(narrow.may, wide.may);
}

function mustMayEqual(left: MustMayPayload, right: MustMayPayload): boolean {
  return sameMembers(left.must, right.must) && sameMembers(left.may, right.may);
}

function mustMayMeet(left: MustMayPayload, right: MustMayPayload): MustMayPayload | "conflict" {
  const must = unionMembers(left.must, right.must);
  const may = intersectMembers(left.may, right.may);
  if (!isSubset(must, may)) return "conflict";
  return Object.freeze({ must, may });
}

function mustMayJoin(left: MustMayPayload, right: MustMayPayload): MustMayPayload {
  return Object.freeze({
    must: intersectMembers(left.must, right.must),
    may: unionMembers(left.may, right.may)
  });
}

function mustMayContradictory(left: MustMayPayload, right: MustMayPayload): boolean {
  return mustMayMeet(left, right) === "conflict";
}

function freezeMembers(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ShadowContractError(`${label} must be a nonempty-string list`);
  }
  return Object.freeze([...new Set(values)].sort(compareText));
}

function isSubset(left: readonly string[], right: readonly string[]): boolean {
  const set = new Set(right);
  return left.every((item) => set.has(item));
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function unionMembers(left: readonly string[], right: readonly string[]): readonly string[] {
  return freezeMembers([...left, ...right], "members");
}

function intersectMembers(left: readonly string[], right: readonly string[]): readonly string[] {
  const set = new Set(right);
  return freezeMembers(left.filter((item) => set.has(item)), "members");
}
