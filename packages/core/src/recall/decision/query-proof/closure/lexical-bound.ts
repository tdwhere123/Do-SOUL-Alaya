import type { LexicalBoundLaneCapture } from
  "../../../runtime/diagnostics/lexical-bound-proof.js";
import { parseLexDomain } from "../observations.js";
import { readLiveLexicalClosureSource } from
  "../adapters/lexical-bound/source-authority.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import {
  createChannelClosureResult,
  createScopedCompletenessReference,
  type ChannelClosureResult,
  type ScopedCompletenessReference
} from "./contract.js";

export function closeLexicalBoundChannel(
  authority: LiveQueryProofAuthority
): ChannelClosureResult | null {
  return closeLexicalSource(readLiveLexicalClosureSource(authority));
}

function closeLexicalSource(
  source: ReturnType<typeof readLiveLexicalClosureSource>
): ChannelClosureResult | null {
  if (source === null) return null;
  if (source.source_lag_kind !== "exact") {
    return createChannelClosureResult({
      scope: source.scope,
      status: "uncertified",
      source_kind: "live_lexical_interval",
      source_receipt_digests: source.source_receipt_digests,
      reason: "lexical_source_bounded_lag_has_no_cq_effect_mapping"
    });
  }
  const receipt = source.receipts[0]!;
  const states = receipt.producer_receipt.lanes.map((lane) =>
    classifyLane(lane, source.scope, receipt.receipt_digest));
  if (states.some(({ status }) => status === "uncertified")) {
    return createChannelClosureResult({
      scope: source.scope,
      status: "uncertified",
      source_kind: "live_lexical_interval",
      source_receipt_digests: source.source_receipt_digests,
      reason: "lexical_lane_unbounded_or_unmapped"
    });
  }
  const applicable = states.filter(({ status }) => status !== "not_applicable");
  if (applicable.length === 0) {
    return createChannelClosureResult({
      scope: source.scope,
      status: "not_applicable",
      source_kind: "live_lexical_interval",
      source_receipt_digests: source.source_receipt_digests,
      reason: "all_lexical_lanes_not_applicable"
    });
  }
  return createChannelClosureResult({
    scope: source.scope,
    status: "exact_closed",
    completeness_refs: applicable.flatMap(({ completeness }) => completeness),
    source_kind: "live_lexical_interval",
    source_receipt_digests: source.source_receipt_digests,
    reason: "live_source_finite_lexical_universe"
  });
}

type LaneClosure = Readonly<{
  readonly status: "not_applicable" | "exact_closed" | "uncertified";
  readonly completeness: readonly ScopedCompletenessReference[];
}>;

function classifyLane(
  lane: LexicalBoundLaneCapture,
  scope: Parameters<typeof createScopedCompletenessReference>[0]["scope"],
  sourceReceiptDigest: Parameters<typeof createScopedCompletenessReference>[0][
    "source_receipt_digest"
  ]
): LaneClosure {
  const empty = Object.freeze([]);
  if (!laneDomainValid(lane) || lane.evaluated_universe === undefined ||
      lane.evaluated_universe.scope.workspace_id !== scope.workspace_id) {
    return Object.freeze({ status: "uncertified", completeness: empty });
  }
  if (!lane.evaluated_universe.applicability.applicable) {
    return Object.freeze({ status: "not_applicable", completeness: empty });
  }
  if (lane.status !== "complete" || lane.unseen_upper_bound !== 0 ||
      lane.evaluated_universe.count !== lane.evaluated_universe.candidate_keys.length) {
    return Object.freeze({ status: "uncertified", completeness: empty });
  }
  return Object.freeze({
    status: "exact_closed",
    completeness: Object.freeze([createScopedCompletenessReference({
      scope,
      source_receipt_digest: sourceReceiptDigest,
      universe_digest: scope.universe_digest,
      coordinate_id: `lexical:${lane.lane_id}`
    })])
  });
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
    const universeKeys = lane.evaluated_universe?.candidate_keys ?? [];
    return new Set(candidateKeys).size === candidateKeys.length &&
      new Set(universeKeys).size === universeKeys.length &&
      candidateKeys.every((key) => universeKeys.includes(key));
  } catch {
    return false;
  }
}
