import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import type { SnapshotCoherenceReceiptV1 } from
  "../../runtime/snapshot-coherence/index.js";
import {
  CANONICAL_QUERY_OPERATOR_ID,
  type CanonicalAnswerProgramV1,
  type CanonicalQueryV1
} from "./types.js";
import {
  compileCanonicalQueryEvidence,
  type CanonicalQueryCompileV1,
  type CanonicalQueryEvidenceV1,
  type CanonicalQueryUnresolvedV1
} from "./compile.js";

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
  readonly operator_id: typeof CANONICAL_QUERY_OPERATOR_ID;
  readonly hypotheses: readonly CanonicalQueryV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
  readonly provenance: readonly string[];
  readonly hypothesis_provenance: CanonicalQueryCompileV1["hypothesis_provenance"];
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
  const compile_status = compileStatus(compiled.hypotheses, holes);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: CANONICAL_QUERY_OPERATOR_ID,
    hypotheses: compiled.hypotheses,
    unresolved: compiled.unresolved,
    provenance: compiled.provenance,
    hypothesis_provenance: compiled.hypothesis_provenance,
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

export function verifyCanonicalQueryCompilationV1(
  compilation: CanonicalQueryCompilationV1
): void {
  const body = {
    schema_version: compilation.schema_version,
    operator_id: compilation.operator_id,
    hypotheses: compilation.hypotheses,
    unresolved: compilation.unresolved,
    provenance: compilation.provenance,
    hypothesis_provenance: compilation.hypothesis_provenance,
    holes: compilation.holes,
    compile_status: compilation.compile_status,
    hypothetical_mode: compilation.hypothetical_mode,
    sensitivities: compilation.sensitivities,
    snapshot_receipt_digest: compilation.snapshot_receipt_digest
  };
  if (digestRecallFieldIdentity(body) !== compilation.digest) {
    throw new Error("canonical query compilation digest mismatch");
  }
}

function snapshotHoles(
  snapshot: Readonly<Pick<SnapshotCoherenceReceiptV1, "coherence_state">>
): readonly CanonicalQueryHoleV1[] {
  if (snapshot.coherence_state === "coherent_exact") return [];
  const impacts = snapshot.coherence_state === "unavailable"
    ? ["blocks_all_delivery", "blocks_certified_delivery"]
    : ["blocks_certified_delivery"];
  return [Object.freeze({
    provenance: "snapshot",
    code: snapshot.coherence_state,
    impacts: Object.freeze([...new Set(impacts)] as QueryHoleImpactV1[])
  })];
}

function collectHoles(compiled: CanonicalQueryCompileV1): CanonicalQueryHoleV1[] {
  const holes = compiled.unresolved.map((item) => holeFromCode(item.code, item.source));
  for (const query of compiled.hypotheses) {
    if (usesAllObservable(query.answer)) {
      holes.push(holeFromCode("blocks_completeness_claim", "completion"));
    }
  }
  return holes;
}

function usesAllObservable(answer: CanonicalAnswerProgramV1): boolean {
  if (answer.kind === "distinct" || answer.kind === "sequence") {
    return answer.completion.kind === "all_observable";
  }
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    return usesAllObservable(answer.inner);
  }
  return false;
}

function holeFromCode(code: string, provenance: string): CanonicalQueryHoleV1 {
  return Object.freeze({
    provenance,
    code,
    impacts: Object.freeze(impactsFor(code))
  });
}

function impactsFor(code: string): QueryHoleImpactV1[] {
  if (code === "unknown_answer_variable") {
    return ["blocks_membership", "blocks_all_delivery"];
  }
  if (code === "count_sum_unsupported" || code === "unsupported_nesting"
    || code === "ambiguous_cjk_segmentation" || code === "latest_without_typed_time_key"
    || code === "unknown_time_basis" || code === "wrong_temporal_domain"
    || code === "unbound_order_key" || code === "limit_overflow") {
    return ["blocks_operator_resolution", "blocks_certified_delivery"];
  }
  if (code === "conflicting_demand_shape" || code === "conflicting_shape"
    || code === "unknown_relation") {
    return ["blocks_pointwise_comparison", "blocks_certified_delivery"];
  }
  if (code === "blocks_completeness_claim" || code === "unknown_scope") {
    return ["blocks_completeness_claim", "blocks_certified_delivery"];
  }
  return ["blocks_certified_delivery"];
}

function compileStatus(
  hypotheses: readonly CanonicalQueryV1[],
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryCompileStatusV1 {
  if (hypotheses.length > 0 && holes.length === 0) return "certified_program";
  if (hypotheses.length > 0) return "partial_program";
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
  const names = new Set<string>(compiled.provenance);
  for (const query of compiled.hypotheses) {
    names.add(query.answer.kind);
    for (const predicate of query.predicates) names.add(predicate.relation);
  }
  return [...names].sort();
}
