import {
  readRecallFieldStopClosureAuthority,
  type RecallFieldStopClosureAuthority
} from "../../../field/refinement/field-refinement-stop-certificate.js";
import {
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope
} from "./contract.js";

export function closeRefinementStopCertificate(
  authority: RecallFieldStopClosureAuthority
): ChannelClosureResult | null {
  let source: ReturnType<typeof readRecallFieldStopClosureAuthority>;
  try {
    source = readRecallFieldStopClosureAuthority(authority);
  } catch {
    return null;
  }
  const scope: ChannelClosureScope = Object.freeze({
    query_digest: source.query_digest,
    request_digest: source.request_digest,
    snapshot_digest: source.snapshot_digest,
    principal_digest: source.principal_digest,
    workspace_id: source.workspace_id,
    observer_id: source.observer_id,
    channel_id: source.channel_id,
    domain_id: source.domain_id,
    universe_digest: source.universe_digest,
    sensitivities: Object.freeze([])
  });
  return uncertifiedClosure(
    scope,
    source.certificate.reason === "all_channels_closed"
      ? "finite_universe_and_query_transfer_required"
      : "legacy_objective_not_query_bound"
  );
}
