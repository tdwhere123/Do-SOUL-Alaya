import {
  verifyRecallFiniteFieldSeal,
  type RecallFiniteFieldSeal
} from "../../../field/finite-field-seal.js";
import type { RecallFieldDigest } from "../../../field/field-identity.js";
import {
  closureBindingApplies,
  createChannelClosureResult,
  createScopedCompletenessReference,
  finiteUniverseApplies,
  uncertifiedClosure,
  type ChannelClosureResult,
  type ChannelClosureScope,
  type ChannelRemainingEffect,
  type ClosureReceiptScopeBinding,
  type FiniteClosureUniverseWitness
} from "./contract.js";

export function closeFiniteFieldChannel(params: Readonly<{
  readonly seal: Readonly<RecallFiniteFieldSeal>;
  readonly scope: ChannelClosureScope;
  readonly binding: ClosureReceiptScopeBinding;
  readonly universe?: FiniteClosureUniverseWitness;
  readonly bounded_effects?: readonly ChannelRemainingEffect[];
}>): ChannelClosureResult {
  const receipt = verifiedChannel(params.seal, params.scope.channel_id);
  if (receipt === null || params.seal.upstream_snapshot_digest !==
      params.scope.snapshot_digest) {
    return uncertifiedClosure(params.scope, "source_receipt_invalid");
  }
  if (!closureBindingApplies({
    binding: params.binding,
    scope: params.scope,
    source_receipt_digest: receipt.channel_digest,
    universe_digest: params.scope.universe_digest
  })) return uncertifiedClosure(params.scope, "scope_binding_mismatch");

  if (receipt.status === "ineligible") {
    return createChannelClosureResult({
      scope: params.scope,
      status: "not_applicable",
      reason: "source_not_applicable"
    });
  }
  if (receipt.status === "unavailable") {
    return uncertifiedClosure(params.scope, "source_unavailable");
  }
  if (receipt.status === "complete") {
    return closeCompleteFiniteChannel(params, receipt.channel_digest);
  }
  if ((params.bounded_effects?.length ?? 0) === 0) {
    return uncertifiedClosure(params.scope, "truncated_without_effect_bound");
  }
  return createChannelClosureResult({
    scope: params.scope,
    status: "bounded_open",
    remaining_effects: params.bounded_effects,
    reason: "finite_unseen_bound"
  });
}

function closeCompleteFiniteChannel(
  params: Parameters<typeof closeFiniteFieldChannel>[0],
  sourceReceiptDigest: RecallFieldDigest
): ChannelClosureResult {
  if (params.universe === undefined || !finiteUniverseApplies({
    witness: params.universe,
    scope: params.scope,
    source_receipt_digest: sourceReceiptDigest
  })) return uncertifiedClosure(params.scope, "finite_universe_unproved");
  return createChannelClosureResult({
    scope: params.scope,
    status: "exact_closed",
    completeness_refs: [createScopedCompletenessReference({
      scope: params.scope,
      source_receipt_digest: sourceReceiptDigest,
      universe_digest: params.universe.universe_digest,
      coordinate_id: `${params.scope.channel_id}:eligible-membership`
    })],
    reason: "exact_finite_universe"
  });
}

function verifiedChannel(
  seal: Readonly<RecallFiniteFieldSeal>,
  channelId: string
): RecallFiniteFieldSeal["channels"][number] | null {
  try {
    verifyRecallFiniteFieldSeal(seal);
    return seal.channels.find(({ channel_id }) => channel_id === channelId) ?? null;
  } catch {
    return null;
  }
}
