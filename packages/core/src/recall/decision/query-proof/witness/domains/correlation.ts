import { requireNonemptyString, ShadowContractError } from "../../envelope.js";
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

export const CORRELATION_STATES = [
  "same_evidence_unit",
  "same_source_lineage",
  "possibly_correlated",
  "certified_independent"
] as const;

export type CorrelationState = (typeof CORRELATION_STATES)[number];

export type CorrelationPayload = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state: CorrelationState;
}>;

export type CorrelationWitness = TypedWitness<"correlation_partition", CorrelationPayload>;
export type CorrelationInput = WitnessCreateInput<CorrelationPayload>;

const CORRELATION_LEQ: Readonly<Record<CorrelationState, readonly CorrelationState[]>> = {
  possibly_correlated: [
    "possibly_correlated",
    "same_source_lineage",
    "same_evidence_unit",
    "certified_independent"
  ],
  same_source_lineage: ["same_source_lineage", "same_evidence_unit"],
  same_evidence_unit: ["same_evidence_unit"],
  certified_independent: ["certified_independent"]
};

const CORRELATION_OPS: PayloadOps<CorrelationPayload> = Object.freeze({
  leq: correlationLeq,
  equal: correlationEqual,
  meet: correlationMeet,
  join: correlationJoin,
  contradictory: correlationIndependentClash,
  refineConflict: correlationIndependentClash,
  sameCell: samePair,
  conflictPayload
});

export function createCorrelationWitness(input: CorrelationInput): CorrelationWitness {
  return createTypedWitness("correlation_partition", input, [], correlationPayload);
}

export function compareCorrelation(
  left: CorrelationWitness,
  right: CorrelationWitness
): WitnessInformationOrder {
  return compareWitness(CORRELATION_OPS, left, right);
}

export function correlationInformationLeq(
  wide: CorrelationWitness,
  narrow: CorrelationWitness
): boolean {
  return informationLeq(CORRELATION_OPS, wide, narrow);
}

export function refineCorrelation(
  from: CorrelationWitness,
  to: CorrelationWitness
): CorrelationWitness {
  return refineWitness(CORRELATION_OPS, from, to);
}

export function meetCorrelation(
  left: CorrelationWitness,
  right: CorrelationWitness
): CorrelationWitness {
  return meetWitness(CORRELATION_OPS, left, right);
}

export function joinCorrelation(
  left: CorrelationWitness,
  right: CorrelationWitness
): CorrelationWitness {
  return joinWitness(CORRELATION_OPS, left, right);
}

function correlationPayload(
  epistemic: WitnessEpistemic,
  payload: CorrelationPayload | null | undefined
): CorrelationPayload | null {
  if (epistemic.kind === "conflict") return conflictPayload(payload ?? null, payload ?? null);
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact correlation requires a partition state");
  }
  return parseCorrelation(payload);
}

function parseCorrelation(payload: CorrelationPayload): CorrelationPayload {
  if (!CORRELATION_STATES.includes(payload.state)) {
    throw new ShadowContractError("unknown correlation state");
  }
  return Object.freeze({
    left_id: requireNonemptyString(payload.left_id, "left_id"),
    right_id: requireNonemptyString(payload.right_id, "right_id"),
    state: payload.state
  });
}

function correlationLeq(wide: CorrelationPayload, narrow: CorrelationPayload): boolean {
  return samePair(wide, narrow) && CORRELATION_LEQ[wide.state].includes(narrow.state);
}

function correlationEqual(left: CorrelationPayload, right: CorrelationPayload): boolean {
  return samePair(left, right) && left.state === right.state;
}

function correlationMeet(
  left: CorrelationPayload,
  right: CorrelationPayload
): CorrelationPayload | "conflict" {
  if (correlationIndependentClash(left, right)) return "conflict";
  if (correlationLeq(left, right)) return right;
  if (correlationLeq(right, left)) return left;
  return "conflict";
}

function correlationJoin(left: CorrelationPayload, right: CorrelationPayload): CorrelationPayload {
  if (correlationEqual(left, right)) return left;
  if (correlationLeq(left, right)) return left;
  if (correlationLeq(right, left)) return right;
  return Object.freeze({ ...left, state: "possibly_correlated" as const });
}

function correlationIndependentClash(
  left: CorrelationPayload,
  right: CorrelationPayload
): boolean {
  const states = new Set([left.state, right.state]);
  return states.has("certified_independent") &&
    (states.has("same_evidence_unit") || states.has("same_source_lineage"));
}

function samePair(left: CorrelationPayload, right: CorrelationPayload): boolean {
  return left.left_id === right.left_id && left.right_id === right.right_id;
}

function conflictPayload(
  left: CorrelationPayload | null,
  right: CorrelationPayload | null
): CorrelationPayload | null {
  const pair = left ?? right;
  if (pair === null) return null;
  return Object.freeze({ ...pair, state: pair.state });
}
