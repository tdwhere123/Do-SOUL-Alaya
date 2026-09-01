import { compareText } from "../../../../shared/compare-text.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import type { CanonicalQueryCompilationV1 } from
  "../../../query/canonical-query/compilation.js";
import type {
  CanonicalAnswerProgramV1,
  CanonicalQueryV1
} from "../../../query/canonical-query/types.js";
import { digestCanonicalQueryV1 } from
  "../../../query/canonical-query/validate.js";
import {
  EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID,
  type ExtremumClosureWitness
} from "../closure/extremum.js";
import type { QueryGammaCandidateEvidenceV1 } from "./contract.js";

export function extremaRequirement(
  answer: CanonicalAnswerProgramV1,
  witness: ExtremumClosureWitness | null,
  compilation: CanonicalQueryCompilationV1,
  query: CanonicalQueryV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): Readonly<{ readonly status: "ok"; readonly binding_ids: readonly string[] }> |
Readonly<{ readonly status: "unsupported"; readonly reason: string }> {
  if (answer.kind !== "argmax" && answer.kind !== "argmin") {
    return { status: "ok", binding_ids: [] };
  }
  if (witness === null) {
    return { status: "unsupported", reason: "missing_extremum_closure_witness" };
  }
  const reason = invalidExtremumWitness(answer, witness, compilation, query, candidates);
  if (reason !== null) return { status: "unsupported", reason };
  return { status: "ok", binding_ids: witness.extremal_binding_ids };
}

function invalidExtremumWitness(
  answer: CanonicalAnswerProgramV1,
  witness: ExtremumClosureWitness,
  compilation: CanonicalQueryCompilationV1,
  query: CanonicalQueryV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): string | null {
  if (answer.kind !== "argmax" && answer.kind !== "argmin") {
    return "invalid_extremum_closure_witness";
  }
  if (witness.operator_id !== EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID) {
    return "invalid_extremum_closure_witness";
  }
  if (witness.operator !== answer.kind) return "extremum_operator_mismatch";
  const { witness_digest: digest, ...body } = witness;
  if (digest !== digestRecallFieldIdentity(body)) return "invalid_extremum_closure_witness";
  if (witness.snapshot_digest !== compilation.snapshot_receipt_digest) {
    return "extremum_witness_snapshot_mismatch";
  }
  if (witness.query_digest !== digestCanonicalQueryV1(query)) {
    return "extremum_witness_query_mismatch";
  }
  if (witness.principal_digest !== extremumPrincipalDigest(compilation)) {
    return "extremum_witness_principal_mismatch";
  }
  if (witness.universe_digest !== extremumUniverseDigest(compilation, candidates)) {
    return "extremum_witness_universe_mismatch";
  }
  if (witness.sensitivity_id !== `extremum:${answer.order_key}`) {
    return "extremum_witness_sensitivity_mismatch";
  }
  if (witness.closure_result_digest !== extremumClosureDigest(witness)) {
    return "extremum_witness_closure_mismatch";
  }
  return null;
}

export function extremumPrincipalDigest(
  compilation: CanonicalQueryCompilationV1
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    snapshot_receipt_digest: compilation.snapshot_receipt_digest,
    query_identity: compilation.query_identity
  });
}

export function extremumUniverseDigest(
  compilation: CanonicalQueryCompilationV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[]
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    snapshot_receipt_digest: compilation.snapshot_receipt_digest,
    candidate_keys: Object.freeze(
      candidates.map((row) => row.candidate_key).sort(compareText)
    )
  });
}

export function extremumClosureDigest(
  witness: Pick<ExtremumClosureWitness,
    "operator" | "query_digest" | "snapshot_digest" | "interval_digest" | "extremal_binding_ids">
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    operator: witness.operator,
    query_digest: witness.query_digest,
    snapshot_digest: witness.snapshot_digest,
    interval_digest: witness.interval_digest,
    extremal_binding_ids: witness.extremal_binding_ids
  });
}
