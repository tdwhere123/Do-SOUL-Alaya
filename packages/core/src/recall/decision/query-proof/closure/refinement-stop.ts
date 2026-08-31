import {
  verifyRecallFieldRefinementStopCertificate,
  type RecallFieldRefinementStopCertificate
} from "../../../field/refinement/field-refinement-stop-certificate.js";
import {
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope
} from "./contract.js";

export function closeRefinementStopCertificate(params: Readonly<{
  readonly certificate: Readonly<RecallFieldRefinementStopCertificate>;
  readonly scope: ChannelClosureScope;
}>): ChannelClosureResult {
  try {
    verifyRecallFieldRefinementStopCertificate(params.certificate);
  } catch {
    return uncertifiedClosure(params.scope, "source_receipt_invalid");
  }
  return uncertifiedClosure(
    params.scope,
    params.certificate.reason === "all_channels_closed"
      ? "finite_universe_and_scope_binding_required"
      : "legacy_objective_not_query_bound"
  );
}
