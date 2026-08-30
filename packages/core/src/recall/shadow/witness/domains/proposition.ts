import { ShadowContractError } from "../../envelope.js";
import { conflictEpistemic, exactEpistemic } from "../shared/epistemic.js";
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

export const FOUR_VALUED_POLARITIES = [
  "supported_only",
  "refuted_only",
  "both",
  "unknown"
] as const;

export type FourValuedPolarity = (typeof FOUR_VALUED_POLARITIES)[number];
export type FourValuedPayload = Readonly<{ readonly polarity: FourValuedPolarity }>;
export type FourValuedWitness = TypedWitness<"four_valued_proposition", FourValuedPayload>;
export type FourValuedInput = WitnessCreateInput<FourValuedPayload>;

const POLARITY_LEQ: Readonly<Record<FourValuedPolarity, readonly FourValuedPolarity[]>> = {
  unknown: ["unknown", "supported_only", "refuted_only", "both"],
  supported_only: ["supported_only", "both"],
  refuted_only: ["refuted_only", "both"],
  both: ["both"]
};

const PROPOSITION_OPS: PayloadOps<FourValuedPayload> = Object.freeze({
  leq: polarityLeq,
  equal: polarityEqual,
  meet: polarityMeet,
  join: polarityJoin,
  contradictory: polarityOpposite,
  refineConflict: polarityOpposite,
  epistemicFor: polarityEpistemic,
  conflictPayload: bothPayload
});

export function createFourValuedWitness(input: FourValuedInput): FourValuedWitness {
  return createTypedWitness(
    "four_valued_proposition",
    input,
    ["proposition_id"],
    fourValuedPayload
  );
}

export function compareFourValued(
  left: FourValuedWitness,
  right: FourValuedWitness
): WitnessInformationOrder {
  return compareWitness(PROPOSITION_OPS, left, right);
}

export function fourValuedInformationLeq(
  wide: FourValuedWitness,
  narrow: FourValuedWitness
): boolean {
  return informationLeq(PROPOSITION_OPS, wide, narrow);
}

export function refineFourValued(
  from: FourValuedWitness,
  to: FourValuedWitness
): FourValuedWitness {
  return refineWitness(PROPOSITION_OPS, from, to);
}

export function meetFourValued(
  left: FourValuedWitness,
  right: FourValuedWitness
): FourValuedWitness {
  return meetWitness(PROPOSITION_OPS, left, right);
}

export function joinFourValued(
  left: FourValuedWitness,
  right: FourValuedWitness
): FourValuedWitness {
  return joinWitness(PROPOSITION_OPS, left, right);
}

function fourValuedPayload(
  epistemic: WitnessEpistemic,
  payload: FourValuedPayload | null | undefined
): FourValuedPayload | null {
  if (epistemic.kind === "conflict") return bothPayload(payload ?? null, payload ?? null);
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact proposition requires a polarity");
  }
  if (payload.polarity === "both") {
    throw new ShadowContractError("both is a conflict polarity");
  }
  return parsePolarity(payload.polarity);
}

function parsePolarity(polarity: FourValuedPolarity): FourValuedPayload {
  if (!FOUR_VALUED_POLARITIES.includes(polarity)) {
    throw new ShadowContractError("unknown four-valued polarity");
  }
  return Object.freeze({ polarity });
}

function polarityLeq(wide: FourValuedPayload, narrow: FourValuedPayload): boolean {
  return POLARITY_LEQ[wide.polarity].includes(narrow.polarity);
}

function polarityEqual(left: FourValuedPayload, right: FourValuedPayload): boolean {
  return left.polarity === right.polarity;
}

function polarityMeet(
  left: FourValuedPayload,
  right: FourValuedPayload
): FourValuedPayload | "conflict" {
  if (polarityOpposite(left, right)) return "conflict";
  if (polarityLeq(left, right)) return right;
  if (polarityLeq(right, left)) return left;
  return "conflict";
}

function polarityJoin(left: FourValuedPayload, right: FourValuedPayload): FourValuedPayload {
  if (polarityEqual(left, right)) return left;
  if (polarityLeq(left, right)) return left;
  if (polarityLeq(right, left)) return right;
  return Object.freeze({ polarity: "unknown" as const });
}

function polarityOpposite(left: FourValuedPayload, right: FourValuedPayload): boolean {
  const polarities = new Set([left.polarity, right.polarity]);
  return polarities.has("supported_only") && polarities.has("refuted_only");
}

function polarityEpistemic(payload: FourValuedPayload): WitnessEpistemic {
  return payload.polarity === "both" ? conflictEpistemic() : exactEpistemic();
}

function bothPayload(
  _left: FourValuedPayload | null,
  _right: FourValuedPayload | null
): FourValuedPayload {
  return Object.freeze({ polarity: "both" as const });
}
