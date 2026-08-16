import { EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID } from "../associative-fact-frame.js";
import { OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID } from "../open-semantic-factor-graph.js";
import {
  hashOperatorManifestDigest,
  type FieldContractSha256,
  type FieldOperatorVersionEntry
} from "./canonical-identity.js";

export const ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID = "attributed_coverage_atoms_v1";
export const SOURCE_SPAN_IDENTITY_OPERATOR_ID = "source_span_identity_v1";
export const FACTOR_INCIDENCE_OPERATOR_ID = "factor_incidence_v1";
export const PROJECTION_GENERATION_OPERATOR_ID = "projection_generation_v1";
export const QUERY_CONDITION_OPERATOR_ID = "query_condition_v1";
export const CAUSAL_USAGE_OPERATOR_ID = "causal_usage_v1";
export const PROOF_EFFECT_OPERATOR_ID = "proof_effect_v1";
export const SELECT_GAMMA_OPERATOR_ID = "select_gamma_v1";
export const FIELD_STOP_CERTIFICATE_OPERATOR_ID = "field_stop_certificate_v1";
export const FIELD_CONTRACT_SCHEMA_VERSION = "1";

export const FIELD_OPERATOR_MANIFEST: readonly FieldOperatorVersionEntry[] = Object.freeze([
  Object.freeze({ id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: FACTOR_INCIDENCE_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: PROJECTION_GENERATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: QUERY_CONDITION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: CAUSAL_USAGE_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: PROOF_EFFECT_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: SELECT_GAMMA_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: FIELD_STOP_CERTIFICATE_OPERATOR_ID, version: "1" })
]);

export function fieldOperatorManifestDigest(sha256: FieldContractSha256): string {
  return hashOperatorManifestDigest(FIELD_OPERATOR_MANIFEST, sha256);
}
