import type { SnapshotReadLeaseCapabilityV1, SnapshotReadLeaseV1 } from
  "../../runtime/snapshot-coherence/index.js";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { freezeShadow, ShadowContractError } from "../envelope.js";
import { createFourValuedWitness, type FourValuedWitness, type WitnessIdentityPins } from
  "../witness/index.js";
import { digestSupportHypergraph, type SupportHypergraphReceiptV1 } from
  "../support/receipt.js";
import { issuedSupportSourceBinding } from "../support/index.js";
import type {
  SupportCandidateReceiptV1,
  SupportPropositionObservationV1
} from "../support/adapters/types.js";
import type { MeasurementGroupContractV1 } from "./contract.js";
import { collapsePropositionStateMeasurement, PROPOSITION_STATE_MEASUREMENT_CONTRACT } from
  "./proposition-state.js";
import type {
  AdmissibleMeasurementCollapseV1,
  PreparedMeasurementAuthorityEvidenceV1,
  VerifiedMeasurementAuthorityV1
} from "./admission.js";

export const PATH_GRAPH_GENERATION_SOURCE_OWNER = "path_graph_generation" as const;

const sources = new WeakMap<object, Readonly<{
  readonly lease: SnapshotReadLeaseV1;
  readonly capability: SnapshotReadLeaseCapabilityV1;
  readonly graph: SupportHypergraphReceiptV1;
  readonly receipts: readonly SupportCandidateReceiptV1[];
  readonly observations: readonly SupportPropositionObservationV1[];
}>>();

export type SupportMeasurementAuthorityEvidenceV1 =
  PreparedMeasurementAuthorityEvidenceV1 & Readonly<{
    readonly support_source_capability: SnapshotReadLeaseCapabilityV1;
    readonly support_graph: SupportHypergraphReceiptV1;
    readonly support_source_receipts: readonly SupportCandidateReceiptV1[];
    readonly support_observations: readonly SupportPropositionObservationV1[];
  }>;

export type VerifiedSupportSourceBinding = Readonly<{
  readonly digest: RecallFieldDigest;
}>;

export function supportPropositionComparisonId(
  observation: SupportPropositionObservationV1
): string {
  return `support.proposition:${digestRecallFieldIdentity({
    kind: "support.proposition",
    binding: {
      hypothesis_digest: observation.hypothesis_digest ?? "unbound",
      local_proposition_id: observation.local_proposition_id
    }
  })}`;
}

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
  const issued = requireIssuedSupportSource(evidence);
  return freezeShadow({
    request_digest: digestRecallFieldIdentity({
      lease_id: lease.lease_id,
      graph_digest: issued.graph.digest,
      source_digest: digestRecallFieldIdentity(issued.receipts),
      observation_digest: digestRecallFieldIdentity(issued.observations)
    }),
    field_prefix: null,
    candidate_key_domain: null
  });
}

export function bindSupportMeasurementAuthoritySource(
  authority: VerifiedMeasurementAuthorityV1,
  evidence: SupportMeasurementAuthorityEvidenceV1
): void {
  const issued = requireIssuedSupportSource(evidence);
  if (issued.graph.query_id !== authority.query_id ||
      issued.graph.snapshot_digest !== authority.snapshot_digest) {
    throw new ShadowContractError("support graph is not bound to the verified query snapshot");
  }
  sources.set(authority, Object.freeze({
    lease: evidence.snapshot_read_lease,
    capability: evidence.support_source_capability,
    graph: issued.graph,
    receipts: issued.receipts,
    observations: issued.observations
  }));
}

export function assertSupportMeasurementSourceObservation(
  authority: VerifiedMeasurementAuthorityV1,
  contract: MeasurementGroupContractV1,
  collapse: AdmissibleMeasurementCollapseV1
): VerifiedSupportSourceBinding | null {
  if (contract !== PROPOSITION_STATE_MEASUREMENT_CONTRACT) return null;
  const source = sources.get(authority);
  if (source === undefined ||
      !leaseOwnsCapability(source.lease, source.capability) ||
      !isSupportSourceCapability(source.capability) ||
      source.graph.query_id !== authority.query_id ||
      source.graph.snapshot_digest !== authority.snapshot_digest) {
    throw new ShadowContractError("measurement authority lacks source-owned jurisdiction");
  }
  if (collapse.witness.domain !== "four_valued_proposition") {
    throw new ShadowContractError("support collapse is not bound to issued observations");
  }
  const matching = matchingBoundWitnesses(source.observations, collapse.witness.identity);
  const expected = collapsePropositionStateMeasurement({
    contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    observations: matching
  });
  if (matching.length === 0 || expected.status !== "collapsed" ||
      digestRecallFieldIdentity(expected.witness) !==
        digestRecallFieldIdentity(collapse.witness)) {
    throw new ShadowContractError("collapse is not bound to issued support observations");
  }
  return freezeShadow({
    digest: digestRecallFieldIdentity({
      graph_digest: source.graph.digest,
      source_digest: digestRecallFieldIdentity(source.receipts),
      observation_digest: digestRecallFieldIdentity(source.observations),
      lease_id: source.lease.lease_id,
      source_owner: source.capability.source_owner,
      view_kind: source.capability.view_kind
    })
  });
}

function requireIssuedSupportSource(
  evidence: SupportMeasurementAuthorityEvidenceV1
): Readonly<{
  readonly graph: SupportHypergraphReceiptV1;
  readonly receipts: readonly SupportCandidateReceiptV1[];
  readonly observations: readonly SupportPropositionObservationV1[];
}> {
  const graph = evidence.support_graph;
  const issued = issuedSupportSourceBinding(graph);
  if (issued === undefined) {
    throw new ShadowContractError("support measurement source is not an issued materialization");
  }
  const canonical = digestSupportHypergraph({
    query_id: graph.query_id,
    snapshot_digest: graph.snapshot_digest,
    nodes: graph.nodes,
    edges: graph.edges,
    aliases: graph.aliases,
    correlations: graph.correlations
  });
  if (canonical.digest !== graph.digest ||
      digestRecallFieldIdentity(issued.receipts) !==
        digestRecallFieldIdentity(evidence.support_source_receipts) ||
      digestRecallFieldIdentity(issued.observations) !==
        digestRecallFieldIdentity(evidence.support_observations)) {
    throw new ShadowContractError("support measurement source receipts do not match the issued graph");
  }
  return Object.freeze({
    graph,
    receipts: issued.receipts,
    observations: issued.observations
  });
}

function matchingBoundWitnesses(
  observations: readonly SupportPropositionObservationV1[],
  identity: WitnessIdentityPins
): readonly FourValuedWitness[] {
  const matched: FourValuedWitness[] = [];
  for (const observation of observations) {
    if (observation.candidate_id !== identity.candidate_id) continue;
    const witness = observation.witness;
    if (witness.identity.query_id !== identity.query_id ||
        witness.identity.snapshot_digest !== identity.snapshot_digest) continue;
    if (witness.identity.proposition_id === identity.proposition_id ||
        observation.local_proposition_id === identity.proposition_id) {
      matched.push(witness);
      continue;
    }
    const remapped = boundSupportPropositionWitness(observation);
    if (remapped.identity.proposition_id === identity.proposition_id) {
      matched.push(remapped);
    }
  }
  return matched;
}

export function boundSupportPropositionWitness(
  observation: SupportPropositionObservationV1
): FourValuedWitness {
  const propositionId = supportPropositionComparisonId(observation);
  const witness = observation.witness;
  return createFourValuedWitness({
    identity: {
      coordinate_id: `support.measure:${propositionId}:${observation.candidate_id}`,
      query_id: witness.identity.query_id,
      snapshot_digest: witness.identity.snapshot_digest,
      candidate_id: observation.candidate_id,
      proposition_id: propositionId
    },
    provenance: witness.provenance,
    epistemic: witness.epistemic,
    payload: witness.payload
  });
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
