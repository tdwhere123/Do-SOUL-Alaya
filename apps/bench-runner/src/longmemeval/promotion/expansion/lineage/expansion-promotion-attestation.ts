import type { LongMemEvalExpansionSourceAnchor } from
  "./expansion-source-anchor-schema.js";

type MatrixEvidenceAttestation = Pick<
  LongMemEvalExpansionSourceAnchor,
  "matrix_authorization_sha256" | "matrix_sha256" | "product_default"
>;

export function reissuedMatrixEvidence(
  historical: MatrixEvidenceAttestation,
  current: MatrixEvidenceAttestation
) {
  return {
    matrix_authorization_sha256: current.matrix_authorization_sha256,
    matrix_sha256: current.matrix_sha256,
    product_default: {
      ...historical.product_default,
      bundle_sha256: current.product_default.bundle_sha256
    }
  };
}
