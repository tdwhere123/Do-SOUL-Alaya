import { renderPlannedContext, type HostTokenizer } from "./render.js";
import {
  framedByteLength,
  type ClaimDisposition,
  type GovernedContradiction,
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
  readonly contradictions?: readonly GovernedContradiction[];
}): readonly ClaimDisposition[] {
  if (input.spec.deliveryPath !== null) {
    return Object.freeze([{ kind: "unsupported_mode", mode: input.spec.deliveryPath }]);
  }
  const claims: ClaimDisposition[] = [{ kind: "heuristic_evidence" }];
  if (input.spec.unsupportedRelationOperator) claims.push({ kind: "unsupported_relation_operator" });
  if (input.spec.unsupportedTemporalOperator) claims.push({ kind: "unsupported_temporal_operator" });
  if (input.spec.familyCaps.embedding === "unavailable") {
    claims.push({ kind: "capability_unavailable", capability: "embedding" });
  }
  if (!input.spec.unsupportedTemporalOperator && !input.spec.unsupportedRelationOperator && input.spec.obligations.length > 0 && input.decision.satisfiedObligations > 0) {
    claims.push({ kind: "joint_support" });
  }
  if (input.spec.obligations.length > 0 && input.decision.satisfiedObligations < input.spec.obligations.length) {
    claims.push({ kind: "obligation_unsatisfied" });
  }
  const selectedEdges = input.spec.unsupportedTemporalOperator || input.spec.unsupportedRelationOperator ? [] : input.edges.filter((edge) => input.decision.membership.includes(edge.resultObjectId));
  const scope = { sourceObjectIds: Object.freeze([...new Set(selectedEdges.map((edge) => edge.resultObjectId))].sort()),
    evidenceRefs: Object.freeze([...new Set(selectedEdges.flatMap((edge) => edge.evidenceRefs ?? []))].sort()) };
  if (selectedEdges.length > 0) claims.push(Object.freeze({ kind: "observed_scoped_relation", ...scope }));
  if (input.spec.asOf.length > 0 && selectedEdges.length > 0) claims.push(Object.freeze({ kind: "valid_time", ...scope }));
  const contradicted = (input.contradictions ?? []).filter((row) => input.decision.membership.includes(row.sourceObjectId));
  if (contradicted.length) claims.push(Object.freeze({ kind: "conflict_distinct_lineages",
    contradicted: Object.freeze(contradicted.map((row) => Object.freeze({ ...row, evidenceRefs: Object.freeze([...row.evidenceRefs]) }))),
    activeSourceObjectIds: scope.sourceObjectIds }));
  if (input.spec.enumeration) claims.push({ kind: "enumeration_observed_not_all" });
  if (input.spec.exactAggregate) claims.push({ kind: "unsupported_exact_aggregate" });
  if (input.decision.truncated || input.fieldTruncated === true) claims.push({ kind: "truncated" });
  return Object.freeze(claims);
}

export function packDecision(
  decision: DecisionResult,
  units: readonly EvidenceUnit[],
  tokenizer?: HostTokenizer
): PackedRecall {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const results = decision.renderedEntries;
  for (const row of results) {
    const unit = byId.get(row.object_id);
    if (!unit || unit.content !== row.content) throw new Error("stale or missing render input");
    const bytes = framedByteLength(row.object_id, row.content);
    if (unit.framedBytes !== bytes || unit.chargedTokens < bytes) throw new Error("invalid entry byte ceiling");
  }
  const rendered = renderPlannedContext(results, decision.order, tokenizer, decision.envelopeAllowance);
  if (rendered.actualBytes !== decision.actualBytes || rendered.chargedTokens > decision.chargedTokens) {
    throw new Error("delivery byte accounting mismatch");
  }
  return Object.freeze({
    ranking_authority: decision.ranking_authority,
    context: rendered.context,
    accounting: Object.freeze({ actualBytes: rendered.actualBytes, chargedTokens: decision.chargedTokens,
      actualTokens: rendered.actualTokens, tokenizerProfile: rendered.tokenizerProfile }),
    results: Object.freeze(results.map((row) => Object.freeze({ object_id: row.object_id, content: row.content, ...(row.source ? { source: row.source } : {}) }))),
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
