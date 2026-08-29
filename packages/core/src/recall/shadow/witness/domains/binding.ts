import { requireNonemptyString, ShadowContractError } from "../../envelope.js";
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

export const BINDING_DISTINCTNESS_EVIDENCE_OPERATOR_ID =
  "binding_distinctness_evidence_v1" as const;

export const BINDING_RELATION_STATES = [
  "equal",
  "may_equal",
  "distinct",
  "unknown",
  "conflict"
] as const;

export type BindingRelationState = (typeof BINDING_RELATION_STATES)[number];

export type BindingDistinctnessEvidenceReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof BINDING_DISTINCTNESS_EVIDENCE_OPERATOR_ID;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly left_id: string;
  readonly right_id: string;
  readonly source_id: string;
  readonly producer: string;
}>;

export type BindingRelationPayload = Readonly<{
  readonly left_id: string;
  readonly right_id: string;
  readonly state: BindingRelationState;
  readonly distinctness_receipt?: BindingDistinctnessEvidenceReceiptV1;
}>;

export type BindingRelationWitness = TypedWitness<"binding_relation", BindingRelationPayload>;
export type BindingRelationInput = WitnessCreateInput<BindingRelationPayload>;

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
  const witness = createTypedWitness("binding_relation", input, [], bindingPayload);
  assertDistinctnessEvidence(witness);
  return witness;
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
  if (state !== "distinct") {
    if (payload.distinctness_receipt !== undefined && state !== "conflict") {
      throw new ShadowContractError("distinctness receipt requires distinct state");
    }
    return Object.freeze(pair);
  }
  return Object.freeze({
    ...pair,
    distinctness_receipt: parseDistinctnessEvidence(payload.distinctness_receipt)
  });
}

function parseDistinctnessEvidence(
  receipt: BindingDistinctnessEvidenceReceiptV1 | undefined
): BindingDistinctnessEvidenceReceiptV1 {
  if (receipt === undefined || receipt.schema_version !== 1 ||
      receipt.operator_id !== BINDING_DISTINCTNESS_EVIDENCE_OPERATOR_ID) {
    throw new ShadowContractError("distinct binding requires a typed distinctness receipt");
  }
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: BINDING_DISTINCTNESS_EVIDENCE_OPERATOR_ID,
    query_id: requireNonemptyString(receipt.query_id, "distinctness query_id"),
    snapshot_digest: requireNonemptyString(
      receipt.snapshot_digest,
      "distinctness snapshot_digest"
    ),
    left_id: requireNonemptyString(receipt.left_id, "distinctness left_id"),
    right_id: requireNonemptyString(receipt.right_id, "distinctness right_id"),
    source_id: requireNonemptyString(receipt.source_id, "distinctness source_id"),
    producer: requireNonemptyString(receipt.producer, "distinctness producer")
  });
}

function assertDistinctnessEvidence(witness: BindingRelationWitness): void {
  const payload = witness.payload;
  if (payload?.state !== "distinct") return;
  const receipt = payload.distinctness_receipt!;
  if (receipt.query_id !== witness.identity.query_id ||
      receipt.snapshot_digest !== witness.identity.snapshot_digest ||
      !sameUnorderedPair(payload, receipt)) {
    throw new ShadowContractError("distinctness receipt identity must match the witness");
  }
  const provenanceMatch = witness.provenance.some((entry) =>
    entry.source_id === receipt.source_id && entry.producer === receipt.producer);
  if (!provenanceMatch) {
    throw new ShadowContractError("distinctness receipt must name witness provenance");
  }
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
  return left.left_id === right.left_id && left.right_id === right.right_id;
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
