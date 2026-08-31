import {
  readRecallFiniteFieldClosureAuthority,
  type RecallFiniteFieldClosureAuthority
} from "../../../field/finite-field-seal.js";
import {
  createChannelClosureResult,
  createScopedCompletenessReference,
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope,
  type ChannelRemainingEffect
} from "./contract.js";

export function closeFiniteFieldChannel(
  authority: RecallFiniteFieldClosureAuthority
): ChannelClosureResult | null {
  let source: ReturnType<typeof readRecallFiniteFieldClosureAuthority>;
  try {
    source = readRecallFiniteFieldClosureAuthority(authority);
  } catch {
    return null;
  }
  const scope = sourceScope(source);
  const channel = source.source_channel;
  if (channel.status === "ineligible") {
    return createChannelClosureResult({
      scope,
      status: "not_applicable",
      reason: "source_not_applicable"
    });
  }
  if (channel.status === "unavailable") {
    return uncertifiedClosure(scope, "source_unavailable");
  }
  if (channel.status === "complete") {
    return createChannelClosureResult({
      scope,
      status: "exact_closed",
      completeness_refs: [createScopedCompletenessReference({
        scope,
        source_receipt_digest: channel.channel_digest,
        universe_digest: source.universe_digest,
        coordinate_id: `${channel.channel_id}:eligible-membership`
      })],
      reason: "source_authenticated_finite_universe"
    });
  }
  if (source.remaining_numeric_effect === null) {
    return uncertifiedClosure(scope, "truncated_without_source_bound");
  }
  return createChannelClosureResult({
    scope,
    status: "bounded_open",
    remaining_effects: [source.remaining_numeric_effect as ChannelRemainingEffect],
    reason: "source_authenticated_finite_bound"
  });
}

function sourceScope(
  source: ReturnType<typeof readRecallFiniteFieldClosureAuthority>
): ChannelClosureScope {
  return Object.freeze({
    query_digest: source.query_digest,
    request_digest: source.request_digest,
    snapshot_digest: source.snapshot_digest,
    principal_digest: source.principal_digest,
    workspace_id: source.workspace_id,
    observer_id: source.observer_id,
    channel_id: source.channel_id,
    domain_id: source.domain_id,
    universe_digest: source.universe_digest,
    sensitivities: source.sensitivities
  });
}
