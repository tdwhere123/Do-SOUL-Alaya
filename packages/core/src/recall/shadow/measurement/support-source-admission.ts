import type { SnapshotReadLeaseCapabilityV1, SnapshotReadLeaseV1 } from
  "../../runtime/snapshot-coherence/index.js";
import { freezeShadow, ShadowContractError } from "../envelope.js";
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
}>>();

export type SupportMeasurementAuthorityEvidenceV1 =
  PreparedMeasurementAuthorityEvidenceV1 & Readonly<{
    readonly support_source_capability: SnapshotReadLeaseCapabilityV1;
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
    request_digest: lease.lease_id,
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
    capability: evidence.support_source_capability
  }));
}

export function assertSupportMeasurementSourceObservation(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1
): void {
  if (contract !== PROPOSITION_STATE_MEASUREMENT_CONTRACT) return;
  const source = sources.get(authority);
  if (source === undefined ||
      !leaseOwnsCapability(source.lease, source.capability) ||
      !isSupportSourceCapability(source.capability)) {
    throw new ShadowContractError("measurement authority lacks source-owned jurisdiction");
  }
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
