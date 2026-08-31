import {
  verifyLexicalBoundProof,
  type LexicalBoundLaneCapture,
  type LexicalBoundLaneId,
  type LexicalBoundProof
} from "../../../runtime/diagnostics/lexical-bound-proof.js";
import { parseLexDomain } from "../observations.js";
import {
  closureBindingApplies,
  createChannelClosureResult,
  createScopedCompletenessReference,
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope,
  type ChannelRemainingEffect,
  type ClosureReceiptScopeBinding,
  type ScopedCompletenessReference
} from "./contract.js";

type LaneEffects = Readonly<Partial<Record<
  LexicalBoundLaneId,
  readonly ChannelRemainingEffect[]
>>>;

export function closeLexicalBoundChannel(params: Readonly<{
  readonly proof: LexicalBoundProof;
  readonly scope: ChannelClosureScope;
  readonly binding: ClosureReceiptScopeBinding;
  readonly bounded_effects_by_lane?: LaneEffects;
}>): ChannelClosureResult {
  if (!proofApplies(params.proof, params.scope) || !closureBindingApplies({
    binding: params.binding,
    scope: params.scope,
    source_receipt_digest: params.proof.proof_digest,
    universe_digest: params.scope.universe_digest
  })) return uncertifiedClosure(params.scope, "scope_binding_mismatch");
  if (params.proof.status !== "captured") {
    return uncertifiedClosure(params.scope, "source_unavailable");
  }

  const states = params.proof.receipt.lanes.map((lane) =>
    classifyLane(lane, params.scope, params.proof.proof_digest));
  if (states.some(({ status }) => status === "uncertified")) {
    return uncertifiedClosure(params.scope, "lexical_lane_unbounded");
  }
  const applicable = states.filter(({ status }) => status !== "not_applicable");
  if (applicable.length === 0) {
    return createChannelClosureResult({
      scope: params.scope,
      status: "not_applicable",
      reason: "all_lexical_lanes_not_applicable"
    });
  }
  const bounded = applicable.filter(({ status }) => status === "bounded_open");
  if (bounded.length === 0) {
    return createChannelClosureResult({
      scope: params.scope,
      status: "exact_closed",
      completeness_refs: applicable.flatMap(({ completeness }) => completeness),
      reason: "all_applicable_lexical_lanes_exact"
    });
  }
  const effects = bounded.flatMap(({ lane_id }) =>
    params.bounded_effects_by_lane?.[lane_id] ?? []);
  if (effects.length === 0 || bounded.some(({ lane_id }) =>
    (params.bounded_effects_by_lane?.[lane_id]?.length ?? 0) === 0)) {
    return uncertifiedClosure(params.scope, "truncated_without_effect_bound");
  }
  return createChannelClosureResult({
    scope: params.scope,
    status: "bounded_open",
    remaining_effects: effects,
    completeness_refs: applicable.flatMap(({ completeness }) => completeness),
    reason: "lexical_lane_frontier_bounded"
  });
}

type LaneClosure = Readonly<{
  readonly lane_id: LexicalBoundLaneId;
  readonly status: "not_applicable" | "exact_closed" | "bounded_open" | "uncertified";
  readonly completeness: readonly ScopedCompletenessReference[];
}>;

function classifyLane(
  lane: LexicalBoundLaneCapture,
  scope: ChannelClosureScope,
  sourceReceiptDigest: LexicalBoundProof["proof_digest"]
): LaneClosure {
  const empty = Object.freeze([]);
  if (!laneDomainValid(lane) || lane.evaluated_universe === undefined ||
      lane.evaluated_universe.scope.workspace_id !== scope.workspace_id) {
    return Object.freeze({ lane_id: lane.lane_id, status: "uncertified", completeness: empty });
  }
  if (!lane.evaluated_universe.applicability.applicable) {
    return Object.freeze({ lane_id: lane.lane_id, status: "not_applicable", completeness: empty });
  }
  if ((lane.status === "complete" || lane.status === "empty") &&
      lane.unseen_upper_bound === 0) {
    return Object.freeze({
      lane_id: lane.lane_id,
      status: "exact_closed",
      completeness: Object.freeze([createScopedCompletenessReference({
        scope,
        source_receipt_digest: sourceReceiptDigest,
        universe_digest: lane.evaluated_universe.universe_digest,
        coordinate_id: `lexical:${lane.lane_id}`
      })])
    });
  }
  if (lane.status === "truncated" && typeof lane.unseen_upper_bound === "number" &&
      Number.isFinite(lane.unseen_upper_bound) && lane.unseen_upper_bound >= 0) {
    return Object.freeze({ lane_id: lane.lane_id, status: "bounded_open", completeness: empty });
  }
  return Object.freeze({ lane_id: lane.lane_id, status: "uncertified", completeness: empty });
}

function proofApplies(proof: LexicalBoundProof, scope: ChannelClosureScope): boolean {
  try {
    verifyLexicalBoundProof(proof);
    if (proof.status !== "captured") return false;
    return proof.identity.request_digest === scope.request_digest &&
      proof.identity.snapshot_digest === scope.snapshot_digest &&
      proof.identity.workspace_id === scope.workspace_id &&
      proof.field_prefix === scope.channel_id &&
      proof.candidate_key_domain === "memory_object_id";
  } catch {
    return false;
  }
}

function laneDomainValid(lane: LexicalBoundLaneCapture): boolean {
  try {
    parseLexDomain({
      lane_id: lane.lane_id,
      list_n: lane.list_n,
      status: lane.status,
      raw_key_kind: lane.raw_key_kind
    });
    const candidateKeys = lane.rows.map(({ candidate_key }) => candidate_key);
    return new Set(candidateKeys).size === candidateKeys.length;
  } catch {
    return false;
  }
}
