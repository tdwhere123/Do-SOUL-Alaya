import { createHash } from "node:crypto";
import type { RecallAnswerShape } from "../../../query/recall-answer-shape-plan.js";
import type { RecallFieldDigest } from "../../../field/field-identity.js";

export const SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID =
  "select_gamma_binding_value_coverage_v1";
export const SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID =
  "select_gamma_candidate_binding_coverage_v1";
export const SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID =
  "select_gamma_selected_binding_set_v1";

export const BINDING_COVER_VALUE_WEIGHT = 1;
export const BINDING_COVER_RHO_LINEAGE = 0.25;
export const BINDING_COVER_RHO_CONTENT = 0.25;

export type BindingCoverValue = Readonly<{
  readonly variable_id: string;
  readonly semantic_identity: string;
  readonly surfaces: readonly string[];
  readonly evidence_ids: readonly string[];
}>;

export type CandidateBindingCoverageReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID;
  readonly candidate_key: string;
  readonly values: readonly BindingCoverValue[];
}>;

export type BindingQueryObligation = Readonly<{
  readonly answer_variable_ids: readonly string[];
  readonly obligation_facets: readonly string[];
  readonly answer_shape: RecallAnswerShape | null;
}>;

export type BindingCoverState = {
  covered: Map<string, number>;
  valuesByVariable: Map<string, Set<string>>;
  lineageKeys: Set<string>;
  contentKeys: Set<string>;
};

export type SelectedBindingValue = Readonly<{
  readonly semantic_identity: string;
  readonly surfaces: readonly string[];
  readonly answer_shape?: RecallAnswerShape | null;
}>;

export type SelectedBindingVariable = Readonly<{
  readonly variable_id: string;
  readonly gained_values: readonly SelectedBindingValue[];
}>;

export type BindingObligationFacetCoverage = Readonly<{
  readonly facet_id: string;
  readonly covered: boolean;
}>;

export type SelectedBindingSetReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID;
  readonly answer_shape: RecallAnswerShape | null;
  readonly obligation_facets: readonly BindingObligationFacetCoverage[];
  readonly variables: readonly SelectedBindingVariable[];
}>;

export const BINDING_COVER_CONFIGURATION_DIGEST: RecallFieldDigest =
  `sha256:${createHash("sha256").update(
    `${SELECT_GAMMA_BINDING_COVERAGE_OPERATOR_ID}:value=${BINDING_COVER_VALUE_WEIGHT}:rho_lineage=${BINDING_COVER_RHO_LINEAGE}:rho_content=${BINDING_COVER_RHO_CONTENT}`,
    "utf8"
  ).digest("hex")}`;
