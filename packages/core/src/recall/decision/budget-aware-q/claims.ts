import {
  type ClaimDisposition,
  type DecisionResult,
  type EvidenceUnit,
  type PackedRecall,
  type QuerySpec,
  type TypedSupportEdge
} from "./types.js";

export function finalizeClaims(input: {
  readonly spec: QuerySpec;
  readonly decision: Omit<DecisionResult, "claims">;
  readonly edges: readonly TypedSupportEdge[];
  readonly fieldTruncated?: boolean;
}): readonly ClaimDisposition[] {
  if (input.spec.deliveryPath === "legacy") {
    return Object.freeze([{ kind: "unsupported_mode", mode: "legacy" }]);
  }
  const claims: ClaimDisposition[] = [{ kind: "heuristic_evidence" }];
  if (input.spec.familyCaps.embedding === "unavailable") {
    claims.push({ kind: "capability_unavailable", capability: "embedding" });
  }
  if (input.spec.obligations.length > 0 && input.decision.satisfiedObligations > 0) {
    claims.push({ kind: "joint_support" });
  }
  if (input.spec.obligations.length > 0 && input.decision.satisfiedObligations === 0) {
    claims.push({ kind: "obligation_unsatisfied" });
  }
  if (input.edges.length > 0) claims.push({ kind: "observed_scoped_relation" });
  if (input.spec.asOf.length > 0 && input.edges.length > 0) claims.push({ kind: "valid_time" });
  if (input.spec.enumeration) claims.push({ kind: "enumeration_observed_not_all" });
  if (input.spec.exactAggregate) claims.push({ kind: "unsupported_exact_aggregate" });
  if (input.decision.truncated || input.fieldTruncated === true) claims.push({ kind: "truncated" });
  return Object.freeze(claims);
}

export function packDecision(
  decision: DecisionResult,
  units: readonly EvidenceUnit[]
): PackedRecall {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const results = decision.order.map((id) => {
    const unit = byId.get(id);
    return Object.freeze({
      object_id: id,
      content: unit?.content ?? ""
    });
  });
  return Object.freeze({
    ranking_authority: decision.ranking_authority,
    results: Object.freeze(results),
    claims: decision.claims,
    truncated: decision.truncated
  });
}

export function withClaims(
  decision: Omit<DecisionResult, "claims">,
  claims: readonly ClaimDisposition[]
): DecisionResult {
  return Object.freeze({ ...decision, claims });
}
