import { ShadowContractError } from "../../envelope.js";
import {
  intervalContradictory,
  intervalEqual,
  intervalJoin,
  intervalLeq,
  intervalMeet,
  parseFiniteInterval,
  type FiniteInterval
} from "../shared/bounds.js";
import { createTypedWitness, rejectPayload } from "../shared/create.js";
import { isKnownZeroEpistemic } from "../shared/epistemic.js";
import { joinWitness, meetWitness, refineWitness } from "../shared/kernel.js";
import { compareWitness, informationLeq } from "../shared/kernel-order.js";
import type { PayloadOps } from "../shared/kernel-ops.js";
import type {
  TypedWitness,
  WitnessCreateInput,
  WitnessEpistemic,
  WitnessInformationOrder
} from "../shared/types.js";

export type MembershipFrontierPayload = FiniteInterval;
export type MembershipFrontierWitness = TypedWitness<
  "membership_frontier",
  MembershipFrontierPayload
>;
export type MembershipFrontierInput = WitnessCreateInput<MembershipFrontierPayload>;

const FRONTIER_OPS: PayloadOps<MembershipFrontierPayload> = Object.freeze({
  leq: intervalLeq,
  equal: intervalEqual,
  meet: intervalMeet,
  join: intervalJoin,
  contradictory: intervalContradictory
});

export function createMembershipFrontierWitness(
  input: MembershipFrontierInput
): MembershipFrontierWitness {
  return createTypedWitness(
    "membership_frontier",
    input,
    ["candidate_id"],
    frontierPayload
  );
}

export function compareMembershipFrontier(
  left: MembershipFrontierWitness,
  right: MembershipFrontierWitness
): WitnessInformationOrder {
  return compareWitness(FRONTIER_OPS, left, right);
}

export function frontierInformationLeq(
  wide: MembershipFrontierWitness,
  narrow: MembershipFrontierWitness
): boolean {
  return informationLeq(FRONTIER_OPS, wide, narrow);
}

export function refineMembershipFrontier(
  from: MembershipFrontierWitness,
  to: MembershipFrontierWitness
): MembershipFrontierWitness {
  return refineWitness(FRONTIER_OPS, from, to);
}

export function meetMembershipFrontier(
  left: MembershipFrontierWitness,
  right: MembershipFrontierWitness
): MembershipFrontierWitness {
  return meetWitness(FRONTIER_OPS, left, right);
}

export function joinMembershipFrontier(
  left: MembershipFrontierWitness,
  right: MembershipFrontierWitness
): MembershipFrontierWitness {
  return joinWitness(FRONTIER_OPS, left, right);
}

function frontierPayload(
  epistemic: WitnessEpistemic,
  payload: MembershipFrontierPayload | null | undefined
): MembershipFrontierPayload | null {
  if (epistemic.kind === "not_applicable") return rejectPayload(payload, "not_applicable");
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (isKnownZeroEpistemic(epistemic)) return knownNonMembership(payload);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact membership frontier requires an index range");
  }
  return parseFrontierInterval(payload);
}

function knownNonMembership(
  payload: MembershipFrontierPayload | null | undefined
): MembershipFrontierPayload | null {
  if (payload !== null && payload !== undefined) {
    throw new ShadowContractError("known non-membership is not an empty index range");
  }
  return null;
}

function parseFrontierInterval(payload: MembershipFrontierPayload): MembershipFrontierPayload {
  return parseFiniteInterval(payload.lower, payload.upper, {
    integer: true,
    nonnegative: true
  });
}
