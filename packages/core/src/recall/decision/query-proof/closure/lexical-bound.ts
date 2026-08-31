import type {
  LexicalBoundLaneCapture,
  LexicalBoundLaneId
} from "../../../runtime/diagnostics/lexical-bound-proof.js";
import type { RecallFieldDigest } from "../../../field/field-identity.js";
import { parseLexDomain } from "../observations.js";
import {
  readLexicalClosureAuthority,
  type LexicalClosureAuthority
} from "../adapters/lexical-bound/source-authority.js";
import {
  createChannelClosureResult,
  createScopedCompletenessReference,
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope,
  type ScopedCompletenessReference
} from "./contract.js";

export function closeLexicalBoundChannel(
  authority: LexicalClosureAuthority
): ChannelClosureResult | null {
  let source: ReturnType<typeof readLexicalClosureAuthority>;
  try {
    source = readLexicalClosureAuthority(authority);
  } catch {
    return null;
  }
  const { proof, scope } = source;
  const states = proof.receipt.lanes.map((lane) =>
    classifyLane(lane, scope, proof.proof_digest));
  if (states.some(({ status }) => status === "uncertified")) {
    return uncertifiedClosure(scope, "lexical_lane_unbounded");
  }
  const applicable = states.filter(({ status }) => status !== "not_applicable");
  if (applicable.length === 0) {
    return createChannelClosureResult({
      scope,
      status: "not_applicable",
      reason: "all_lexical_lanes_not_applicable"
    });
  }
  const bounded = applicable.filter(({ status }) => status === "bounded_open");
  if (bounded.length === 0) {
    return createChannelClosureResult({
      scope,
      status: "exact_closed",
      completeness_refs: applicable.flatMap(({ completeness }) => completeness),
      reason: "all_applicable_lexical_lanes_exact"
    });
  }
  const effects = bounded.flatMap(({ lane_id }) =>
    source.effects_by_lane[lane_id] ?? []);
  if (effects.length === 0 || bounded.some(({ lane_id }) =>
    (source.effects_by_lane[lane_id]?.length ?? 0) === 0)) {
    return uncertifiedClosure(scope, "truncated_without_source_bound");
  }
  return createChannelClosureResult({
    scope,
    status: "bounded_open",
    remaining_effects: effects,
    reason: "source_authenticated_lexical_frontier"
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
  sourceReceiptDigest: RecallFieldDigest
): LaneClosure {
  const empty = Object.freeze([]);
  if (!laneDomainValid(lane) || lane.evaluated_universe === undefined ||
      lane.evaluated_universe.scope.workspace_id !== scope.workspace_id) {
    return Object.freeze({ lane_id: lane.lane_id, status: "uncertified", completeness: empty });
  }
  if (!lane.evaluated_universe.applicability.applicable) {
    return Object.freeze({ lane_id: lane.lane_id, status: "not_applicable", completeness: empty });
  }
  if (lane.status === "complete" && lane.unseen_upper_bound === 0) {
    return Object.freeze({
      lane_id: lane.lane_id,
      status: "exact_closed",
      completeness: Object.freeze([createScopedCompletenessReference({
        scope,
        source_receipt_digest: sourceReceiptDigest,
        universe_digest: scope.universe_digest,
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
