import type { SnapshotReadLeaseCapabilityV1, SnapshotReadLeaseV1 } from
  "../../runtime/snapshot-coherence/index.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeShadow, requireNonemptyString, ShadowContractError } from "../envelope.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import { PROPOSITION_STATE_MEASUREMENT_CONTRACT } from "./proposition-state.js";
import type {
  PreparedMeasurementAuthorityEvidenceV1,
  VerifiedMeasurementAuthorityV1
} from "./admission.js";

export const PATH_GRAPH_GENERATION_SOURCE_OWNER = "path_graph_generation" as const;

const sources = new WeakMap<object, Readonly<{
  readonly lease: SnapshotReadLeaseV1;
  readonly capability: SnapshotReadLeaseCapabilityV1;
  readonly graph_digest: RecallFieldDigest;
  readonly source_digest: RecallFieldDigest;
  readonly observation_digest: RecallFieldDigest;
}>>();

export type SupportMeasurementAuthorityEvidenceV1 =
  PreparedMeasurementAuthorityEvidenceV1 & Readonly<{
    readonly support_source_capability: SnapshotReadLeaseCapabilityV1;
    readonly support_graph_digest: RecallFieldDigest;
    readonly support_source_digest: RecallFieldDigest;
    readonly support_observation_digest: RecallFieldDigest;
  }>;

export type VerifiedSupportSourceBinding = Readonly<{
  readonly digest: RecallFieldDigest;
}>;

export function supportMeasurementSourceIdentity(
  evidence: SupportMeasurementAuthorityEvidenceV1
): Readonly<{
  readonly request_digest: string;
  readonly field_prefix: null;
  readonly candidate_key_domain: null;
}> {
  const lease = evidence.snapshot_read_lease;
  const capability = evidence.support_source_capability;
  if (!leaseOwnsCapability(lease, capability) || !isSupportSourceCapability(capability)) {
    throw new ShadowContractError("support measurement source identity mismatch");
  }
  return freezeShadow({
    request_digest: supportSourceRequestDigest(evidence),
    field_prefix: null,
    candidate_key_domain: null
  });
}

export function bindSupportMeasurementAuthoritySource(
  authority: VerifiedMeasurementAuthorityV1,
  evidence: SupportMeasurementAuthorityEvidenceV1
): void {
  sources.set(authority, Object.freeze({
    lease: evidence.snapshot_read_lease,
    capability: evidence.support_source_capability,
    graph_digest: requireDigest(evidence.support_graph_digest, "support_graph_digest"),
    source_digest: requireDigest(evidence.support_source_digest, "support_source_digest"),
    observation_digest: requireDigest(
      evidence.support_observation_digest,
      "support_observation_digest"
    )
  }));
}

export function assertSupportMeasurementSourceObservation(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1
): VerifiedSupportSourceBinding | null {
  if (contract !== PROPOSITION_STATE_MEASUREMENT_CONTRACT) return null;
  const source = sources.get(authority);
  if (source === undefined ||
      !leaseOwnsCapability(source.lease, source.capability) ||
      !isSupportSourceCapability(source.capability)) {
    throw new ShadowContractError("measurement authority lacks source-owned jurisdiction");
  }
  return freezeShadow({
    digest: digestRecallFieldIdentity({
      graph_digest: source.graph_digest,
      source_digest: source.source_digest,
      observation_digest: source.observation_digest,
      lease_id: source.lease.lease_id,
      source_owner: source.capability.source_owner,
      view_kind: source.capability.view_kind
    })
  });
}

function supportSourceRequestDigest(
  evidence: SupportMeasurementAuthorityEvidenceV1
): RecallFieldDigest {
  return digestRecallFieldIdentity({
    lease_id: evidence.snapshot_read_lease.lease_id,
    graph_digest: requireDigest(evidence.support_graph_digest, "support_graph_digest"),
    source_digest: requireDigest(evidence.support_source_digest, "support_source_digest"),
    observation_digest: requireDigest(
      evidence.support_observation_digest,
      "support_observation_digest"
    )
  });
}

function requireDigest(value: string, label: string): RecallFieldDigest {
  const digest = requireNonemptyString(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new ShadowContractError(`${label} is not a sha256 digest`);
  }
  return digest as RecallFieldDigest;
}

function isSupportSourceCapability(
  capability: SnapshotReadLeaseCapabilityV1
): boolean {
  return capability.source_owner === PATH_GRAPH_GENERATION_SOURCE_OWNER &&
    (capability.view_kind === "captured" || capability.view_kind === "pinned");
}

function leaseOwnsCapability(
  lease: SnapshotReadLeaseV1,
  capability: SnapshotReadLeaseCapabilityV1
): boolean {
  return lease.capabilities.some((bound) => bound === capability);
}
