import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";
import type { BindingValuesStatus } from "./composition.js";
import type { CandidateBindingCoverageReceipt } from "./types.js";
import {
  BINDING_COVER_RHO_CONTENT,
  BINDING_COVER_RHO_LINEAGE,
  BINDING_COVER_VALUE_WEIGHT,
  SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID
} from "./types.js";

export function digestBindingCoverConfiguration(params: Readonly<{
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly answerVariableIds: readonly string[];
  readonly obligationFacets: readonly string[];
  readonly valuesStatus: BindingValuesStatus;
  readonly facilityDigest: string | null;
}>): RecallFieldDigest {
  return digestRecallFieldIdentity({
    operator_id: SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID,
    value_weight: BINDING_COVER_VALUE_WEIGHT,
    rho_lineage: BINDING_COVER_RHO_LINEAGE,
    rho_content: BINDING_COVER_RHO_CONTENT,
    facility_digest: params.facilityDigest,
    values_status: params.valuesStatus,
    answer_variable_ids: params.answerVariableIds,
    obligation_facets: params.obligationFacets,
    receipts: [...params.receiptsByCandidateKey]
      .sort(([left], [right]) => compareText(left, right))
      .map(([candidateKey, receipt]) => Object.freeze({
        candidate_key: candidateKey,
        values: receipt.values.map((value) => Object.freeze({
          variable_id: value.variable_id,
          semantic_identity: value.semantic_identity
        }))
      }))
  });
}
