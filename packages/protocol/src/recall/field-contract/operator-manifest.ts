import { EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID } from "../../evidence/associative-fact-frame.js";
import { OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID } from "../../relations/open-semantic-factor-graph.js";
import {
  FIELD_CONTRACT_SCHEMA_VERSION,
  hashOperatorManifestDigest,
  type FieldContractSha256,
  type FieldOperatorVersionEntry
} from "./canonical-identity.js";

export { FIELD_CONTRACT_SCHEMA_VERSION };

export const ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID = "attributed_coverage_atoms_v1";
export const SOURCE_SPAN_IDENTITY_OPERATOR_ID = "source_span_identity_v1";
export const FACTOR_INCIDENCE_OPERATOR_ID = "factor_incidence_v1";
export const PROJECTION_GENERATION_OPERATOR_ID = "projection_generation_v1";
export const QUERY_CONDITION_OPERATOR_ID = "query_condition_v2";
export const CAUSAL_USAGE_OPERATOR_ID = "causal_usage_v1";
export const PROOF_EFFECT_OPERATOR_ID = "proof_effect_v1";
export const PROOF_EFFECT_OPERATOR_VERSION = "1";
export const SELECT_GAMMA_OPERATOR_ID =
  "select_gamma_relevance_temporal_query_coverage_authority_tiebreak_v3";
export const SELECT_GAMMA_OPERATOR_VERSION = "3";
export const RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID =
  "recall_field_selector_exchange_bound_v1";

export const FIELD_OPERATOR_MANIFEST: readonly FieldOperatorVersionEntry[] = Object.freeze([
  Object.freeze({ id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: ATTRIBUTED_COVERAGE_ATOMS_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: SOURCE_SPAN_IDENTITY_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: FACTOR_INCIDENCE_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: PROJECTION_GENERATION_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: QUERY_CONDITION_OPERATOR_ID, version: "2" }),
  Object.freeze({ id: CAUSAL_USAGE_OPERATOR_ID, version: "1" }),
  Object.freeze({ id: PROOF_EFFECT_OPERATOR_ID, version: PROOF_EFFECT_OPERATOR_VERSION }),
  Object.freeze({
    id: SELECT_GAMMA_OPERATOR_ID,
    version: SELECT_GAMMA_OPERATOR_VERSION
  }),
  Object.freeze({ id: RECALL_FIELD_SELECTOR_EXCHANGE_BOUND_OPERATOR_ID, version: "1" })
]);

export function fieldOperatorManifestDigest(sha256: FieldContractSha256): string {
  return hashOperatorManifestDigest(FIELD_OPERATOR_MANIFEST, sha256);
}

export function assertCanonicalFieldOperatorManifest(
  operators: readonly FieldOperatorVersionEntry[],
  digest: string,
  sha256: FieldContractSha256
): void {
  if (digest !== fieldOperatorManifestDigest(sha256) ||
      operators.length !== FIELD_OPERATOR_MANIFEST.length ||
      operators.some((entry, index) => {
        const expected = FIELD_OPERATOR_MANIFEST[index];
        return expected === undefined || entry.id !== expected.id ||
          entry.version !== expected.version;
      })) {
    throw new Error("field generation requires the canonical operator manifest");
  }
}
