import {
  verifyRecallFiniteFieldSeal,
  type RecallFiniteFieldSeal
} from "../../../field/finite-field-seal.js";
import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import type { LiveQueryProofAuthority } from "../live-query-proof-authority.js";
import {
  createChannelClosureResult,
  type ChannelClosureResult
} from "./contract.js";
import { deriveLiveClosureAuthorityBinding } from "./live-authority-binding.js";

export function closeFiniteFieldChannel(
  authority: LiveQueryProofAuthority,
  seal: RecallFiniteFieldSeal,
  channelId?: string
): ChannelClosureResult | null {
  try {
    const binding = deriveLiveClosureAuthorityBinding(authority);
    verifyRecallFiniteFieldSeal(seal);
    const channel = channelId === undefined && seal.channels.length === 1
      ? seal.channels[0]
      : seal.channels.find(({ channel_id }) => channel_id === channelId);
    if (channel === undefined) return null;
    const scope = Object.freeze({
      ...binding,
      observer_id: seal.operator_id,
      channel_id: channel.channel_id,
      domain_id: `unverified-finite-field:${channel.channel_id}`,
      universe_digest: digestRecallFieldIdentity({
        operator_id: "unverified_finite_field_universe_v1",
        seal_digest: seal.seal_digest,
        channel_digest: channel.channel_digest
      })
    });
    return createChannelClosureResult({
      scope,
      status: "uncertified",
      source_kind: "unverified_finite_field",
      source_receipt_digests: [channel.channel_digest],
      reason: seal.upstream_snapshot_digest === binding.snapshot_digest
        ? "finite_field_source_not_bound_to_live_authority"
        : "finite_field_snapshot_not_bound_to_live_authority"
    });
  } catch {
    return null;
  }
}
