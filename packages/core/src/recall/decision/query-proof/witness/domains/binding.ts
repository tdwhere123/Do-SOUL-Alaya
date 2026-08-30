import { requireNonemptyString, ShadowContractError } from "../../../prefix-capture/envelope.js";
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
import {
  verifyBindingRelationEvidenceReceiptV1,
  type BindingRelationEvidenceReceiptV1,
  type BindingRelationEvidenceVerifierV1
} from "./binding-evidence.js";

export const BINDING_RELATION_STATES = [
  "equal",
  "may_equal",
  "distinct",
  "unknown",
  "conflict"
] as const;

export type BindingRelationState = (typeof BINDING_RELATION_STATES)[number];

export type BindingRelationPayload = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state: BindingRelationState;
  readonly relation_evidence_receipt?: BindingRelationEvidenceReceiptV1;
}>;

export type BindingRelationWitness = TypedWitness<"binding_relation", BindingRelationPayload>;
export type BindingRelationInput = WitnessCreateInput<BindingRelationPayload> & Readonly<{
  readonly evidence_verifier?: BindingRelationEvidenceVerifierV1;
}>;

const BINDING_LEQ: Readonly<Record<BindingRelationState, readonly BindingRelationState[]>> = {
  unknown: ["unknown", "may_equal", "equal", "distinct", "conflict"],
  may_equal: ["may_equal", "equal", "distinct", "conflict"],
  equal: ["equal", "conflict"],
  distinct: ["distinct", "conflict"],
  conflict: ["conflict"]
};

const BINDING_OPS: PayloadOps<BindingRelationPayload> = Object.freeze({
  leq: bindingLeq,
  equal: bindingEqual,
  meet: bindingMeet,
  join: bindingJoin,
  contradictory: bindingMeetConflict,
  refineConflict: bindingRefineConflict,
  sameCell: samePair,
  epistemicFor: bindingEpistemic,
  conflictPayload: bindingConflictPayload
});

export function createBindingRelationWitness(
  input: BindingRelationInput
): BindingRelationWitness {
  return createTypedWitness(
    "binding_relation",
    normalizeConcreteRelation(input),
    [],
    bindingPayload
  );
}

export function compareBindingRelation(
  left: BindingRelationWitness,
  right: BindingRelationWitness
): WitnessInformationOrder {
  return compareWitness(BINDING_OPS, left, right);
}

export function bindingInformationLeq(
  wide: BindingRelationWitness,
  narrow: BindingRelationWitness
): boolean {
  return informationLeq(BINDING_OPS, wide, narrow);
}

export function refineBindingRelation(
  from: BindingRelationWitness,
  to: BindingRelationWitness
): BindingRelationWitness {
  return refineWitness(BINDING_OPS, from, to);
}

export function meetBindingRelation(
  left: BindingRelationWitness,
  right: BindingRelationWitness
): BindingRelationWitness {
  return meetWitness(BINDING_OPS, left, right);
}

export function joinBindingRelation(
  left: BindingRelationWitness,
  right: BindingRelationWitness
): BindingRelationWitness {
  return joinWitness(BINDING_OPS, left, right);
}

function bindingPayload(
  epistemic: WitnessEpistemic,
  payload: BindingRelationPayload | null | undefined
): BindingRelationPayload | null {
  if (epistemic.kind === "conflict") return parseBindingPayload(payload, "conflict");
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact binding relation requires a state");
  }
  if (payload.state === "conflict") {
    throw new ShadowContractError("binding conflict is an epistemic conflict");
  }
  return parseBindingPayload(payload, payload.state);
}

function parseBindingPayload(
  payload: BindingRelationPayload | null | undefined,
  state: BindingRelationState
): BindingRelationPayload {
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("binding relation requires pair identity");
  }
  if (!BINDING_RELATION_STATES.includes(state)) {
    throw new ShadowContractError("unknown binding relation state");
  }
  const pair = {
    left_id: requireNonemptyString(payload.left_id, "left_id"),
    right_id: requireNonemptyString(payload.right_id, "right_id"),
    state
  };
  if ((state !== "equal" && state !== "distinct")
      || payload.relation_evidence_receipt === undefined) return Object.freeze(pair);
  return Object.freeze({ ...pair, relation_evidence_receipt: payload.relation_evidence_receipt });
}

function normalizeConcreteRelation(input: BindingRelationInput): BindingRelationInput {
  const payload = input.payload;
  if (payload === null || payload === undefined
      || (payload.state !== "equal" && payload.state !== "distinct")) return input;
  const receipt = payload.relation_evidence_receipt;
  const admitted = receipt !== undefined
    && input.evidence_verifier !== undefined
    && verifyBindingRelationEvidenceReceiptV1(receipt, input.evidence_verifier)
    && receipt.relation === payload.state
    && receipt.query_id === input.identity.query_id
    && receipt.snapshot_digest === input.identity.snapshot_digest
    && sameUnorderedPair(payload, receipt)
    && input.provenance.some((entry) => entry.source_id === receipt.source_observation.source_id
      && entry.producer === receipt.source_observation.producer_operator_id);
  if (admitted) return input;
  return {
    ...input,
    payload: Object.freeze({
      left_id: payload.left_id,
      right_id: payload.right_id,
      state: "may_equal" as const
    })
  };
}

function sameUnorderedPair(
  left: Pick<BindingRelationPayload, "left_id" | "right_id">,
  right: Pick<BindingRelationPayload, "left_id" | "right_id">
): boolean {
  return (left.left_id === right.left_id && left.right_id === right.right_id) ||
    (left.left_id === right.right_id && left.right_id === right.left_id);
}

function bindingLeq(wide: BindingRelationPayload, narrow: BindingRelationPayload): boolean {
  return samePair(wide, narrow) && BINDING_LEQ[wide.state].includes(narrow.state);
}

function bindingEqual(left: BindingRelationPayload, right: BindingRelationPayload): boolean {
  return samePair(left, right) && left.state === right.state;
}

function bindingMeet(
  left: BindingRelationPayload,
  right: BindingRelationPayload
): BindingRelationPayload | "conflict" {
  if (bindingMeetConflict(left, right)) return "conflict";
  if (bindingLeq(left, right)) return right;
  if (bindingLeq(right, left)) return left;
  return "conflict";
}

function bindingJoin(left: BindingRelationPayload, right: BindingRelationPayload): BindingRelationPayload {
  if (bindingEqual(left, right)) return left;
  if (bindingLeq(left, right)) return left;
  if (bindingLeq(right, left)) return right;
  const joinedState = pairStates(left, right, "equal", "distinct")
    ? "may_equal" as const
    : "unknown" as const;
  return Object.freeze({
    left_id: left.left_id,
    right_id: left.right_id,
    state: joinedState
  });
}

function bindingMeetConflict(left: BindingRelationPayload, right: BindingRelationPayload): boolean {
  return pairStates(left, right, "equal", "distinct");
}

function bindingRefineConflict(from: BindingRelationPayload, to: BindingRelationPayload): boolean {
  return pairStates(from, to, "equal", "distinct");
}

function pairStates(
  left: BindingRelationPayload,
  right: BindingRelationPayload,
  first: BindingRelationState,
  second: BindingRelationState
): boolean {
  const states = new Set([left.state, right.state]);
  return states.has(first) && states.has(second);
}

function samePair(left: BindingRelationPayload, right: BindingRelationPayload): boolean {
  return sameUnorderedPair(left, right);
}

function bindingEpistemic(payload: BindingRelationPayload): WitnessEpistemic {
  return payload.state === "conflict" ? conflictEpistemic() : exactEpistemic();
}

function bindingConflictPayload(
  left: BindingRelationPayload | null,
  right: BindingRelationPayload | null
): BindingRelationPayload | null {
  const pair = left ?? right;
  if (pair === null) return null;
  return Object.freeze({
    left_id: pair.left_id,
    right_id: pair.right_id,
    state: "conflict" as const
  });
}
