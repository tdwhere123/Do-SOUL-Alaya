import {
  verifyRecallFieldRefinementStopCertificate,
  type RecallFieldRefinementStopCertificate
} from "../../../field/refinement/field-refinement-stop-certificate.js";
import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import {
  createChannelClosureResult,
  type ChannelClosureResult
} from "./contract.js";
import { deriveLiveClosureAuthorityBinding } from "./live-authority-binding.js";

export function closeRefinementStopCertificate(
  authority: LiveQueryProofAuthority,
  certificate: RecallFieldRefinementStopCertificate
): ChannelClosureResult | null {
  try {
    const binding = deriveLiveClosureAuthorityBinding(authority);
    verifyRecallFieldRefinementStopCertificate(certificate);
    const scope = Object.freeze({
      ...binding,
      observer_id: certificate.operator_id,
      channel_id: "legacy-refinement-stop",
      domain_id: "legacy-coverage-selection-objective",
      universe_digest: digestRecallFieldIdentity({
        operator_id: "legacy_refinement_stop_unverified_universe_v1",
        field_seal_digest: certificate.field_seal_digest,
        certificate_digest: certificate.receipt_digest
      })
    });
    return createChannelClosureResult({
      scope,
      status: "uncertified",
      source_kind: "legacy_refinement_stop",
      source_receipt_digests: [certificate.receipt_digest],
      reason: certificate.reason === "all_channels_closed"
        ? "finite_universe_and_query_transfer_required"
        : "legacy_objective_not_query_bound"
    });
  } catch {
    return null;
  }
}
