import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import type { SnapshotCoherenceReceiptV1 } from
  "../../runtime/snapshot-coherence/index.js";
import {
  compileCanonicalQueryEvidence,
  type CanonicalQueryCompileV1,
  type CanonicalQueryEvidenceV1,
  type CanonicalQueryUnresolvedV1
} from "./compile.js";
import type { CanonicalQueryUnsupportedCode, CanonicalQueryValidationV1 } from "./types.js";

export const QUERY_HOLE_IMPACTS = [
  "blocks_membership",
  "blocks_pointwise_comparison",
  "blocks_operator_resolution",
  "blocks_completeness_claim",
  "blocks_certified_delivery",
  "blocks_all_delivery"
] as const;

export type QueryHoleImpactV1 = (typeof QUERY_HOLE_IMPACTS)[number];

export type CanonicalQueryHoleV1 = Readonly<{
  readonly provenance: string;
  readonly code: string;
  readonly impacts: readonly QueryHoleImpactV1[];
}>;

export type CanonicalQueryCompileStatusV1 =
  | "certified_program"
  | "partial_program"
  | "unsupported";

export type CanonicalQueryHypotheticalModeV1 =
  | "certified"
  | "best_effort"
  | "abstained"
  | "unsupported";

export type CanonicalQueryCompilationV1 = Readonly<{
  readonly schema_version: 1;
  readonly hypotheses: readonly CanonicalQueryValidationV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
  readonly holes: readonly CanonicalQueryHoleV1[];
  readonly compile_status: CanonicalQueryCompileStatusV1;
  readonly hypothetical_mode: CanonicalQueryHypotheticalModeV1;
  readonly sensitivities: readonly string[];
  readonly snapshot_receipt_digest: RecallFieldDigest;
  readonly digest: RecallFieldDigest;
}>;

export function compileCanonicalQueryCompilation(
  evidence: CanonicalQueryEvidenceV1,
  snapshot: Readonly<Pick<SnapshotCoherenceReceiptV1, "receipt_digest" | "coherence_state">>
): CanonicalQueryCompilationV1 {
  const compiled = compileCanonicalQueryEvidence(evidence);
  const holes = Object.freeze([
    ...collectHoles(compiled),
    ...snapshotHoles(snapshot)
  ]);
  const compile_status = compileStatus(compiled, holes);
  const body = Object.freeze({
    schema_version: 1 as const,
    hypotheses: compiled.hypotheses,
    unresolved: compiled.unresolved,
    holes,
    compile_status,
    hypothetical_mode: hypotheticalMode(compile_status),
    sensitivities: Object.freeze(collectSensitivities(compiled)),
    snapshot_receipt_digest: snapshot.receipt_digest
  });
  return Object.freeze({
    ...body,
    digest: digestRecallFieldIdentity(body)
  });
}

function snapshotHoles(
  snapshot: Readonly<Pick<SnapshotCoherenceReceiptV1, "coherence_state">>
): readonly CanonicalQueryHoleV1[] {
  if (snapshot.coherence_state === "coherent_exact") return [];
  const impact = snapshot.coherence_state === "unavailable"
    ? "blocks_all_delivery"
    : "blocks_certified_delivery";
  return [Object.freeze({
    provenance: "snapshot",
    code: snapshot.coherence_state,
    impacts: Object.freeze([impact, "blocks_certified_delivery"] as QueryHoleImpactV1[])
  })];
}

function collectHoles(compiled: CanonicalQueryCompileV1): CanonicalQueryHoleV1[] {
  const holes: CanonicalQueryHoleV1[] = [];
  for (const hypothesis of compiled.hypotheses) {
    if (hypothesis.status === "unsupported") {
      holes.push(holeFromCode(hypothesis.reason_code, "hypothesis"));
    }
  }
  for (const item of compiled.unresolved) {
    holes.push(holeFromCode(item.code, item.source));
  }
  return holes;
}

function holeFromCode(code: string, provenance: string): CanonicalQueryHoleV1 {
  return Object.freeze({
    provenance,
    code,
    impacts: Object.freeze(impactsFor(code))
  });
}

function impactsFor(code: string): QueryHoleImpactV1[] {
  if (code === "unknown_answer_variable" || code === "blocks_all_delivery") {
    return ["blocks_membership", "blocks_all_delivery"];
  }
  if (code === "count_sum_unsupported") {
    return ["blocks_operator_resolution", "blocks_certified_delivery"];
  }
  if (code === "latest_without_typed_time_key" || code === "unknown_time_basis"
    || code === "wrong_temporal_domain" || code === "unbound_order_key") {
    return ["blocks_operator_resolution"];
  }
  if (code === "conflicting_demand_shape" || code === "conflicting_shape") {
    return ["blocks_pointwise_comparison", "blocks_certified_delivery"];
  }
  if (code === "limit_overflow" || code === "unsupported_nesting") {
    return ["blocks_operator_resolution", "blocks_certified_delivery"];
  }
  if (code === "all_observable" || code === "blocks_completeness_claim") {
    return ["blocks_completeness_claim"];
  }
  return ["blocks_certified_delivery"];
}

function compileStatus(
  compiled: CanonicalQueryCompileV1,
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryCompileStatusV1 {
  const supported = compiled.hypotheses.some((row) => row.status === "supported");
  if (supported && holes.length === 0) return "certified_program";
  if (supported) return "partial_program";
  return "unsupported";
}

function hypotheticalMode(
  status: CanonicalQueryCompileStatusV1
): CanonicalQueryHypotheticalModeV1 {
  if (status === "certified_program") return "certified";
  if (status === "partial_program") return "best_effort";
  return "unsupported";
}

function collectSensitivities(compiled: CanonicalQueryCompileV1): string[] {
  const names = new Set<string>();
  for (const hypothesis of compiled.hypotheses) {
    if (hypothesis.status !== "supported") continue;
    names.add(hypothesis.query.answer.kind);
    for (const predicate of hypothesis.query.predicates) names.add(predicate.relation);
  }
  return [...names].sort();
}

export type { CanonicalQueryUnsupportedCode };
