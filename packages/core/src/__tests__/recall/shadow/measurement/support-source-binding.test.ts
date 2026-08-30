import { describe, expect, it } from "vitest";
import {
  issueMeasurementGroupAdmission,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  verifySupportMeasurementPreparedAuthorityV1
} from "../../../../recall/shadow/measurement/index.js";
import {
  PATH_GRAPH_GENERATION_SOURCE_OWNER
} from "../../../../recall/shadow/measurement/support-source-admission.js";
import {
  createSupportHypergraph,
  materializeSupportFromReceipts,
  type SupportCandidateReceiptV1
} from "../../../../recall/shadow/support/index.js";
import { createFourValuedWitness } from "../../../../recall/shadow/witness/index.js";
import {
  capturedPathGraphPreparedAuthority,
  cleanup
} from "../live-receipt-fixtures.js";

describe("support measurement source binding", () => {
  it("rejects self-reported hashes and unissued graphs", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const receipts = [osfReceipt("eu-a")];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    const forgedGraph = createSupportHypergraph({
      query_id: queryId,
      snapshot_digest: snapshot,
      nodes: payload.graph.nodes,
      edges: payload.graph.edges
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: forgedGraph,
        receipts,
        observations: payload.proposition_observations
      })
    })).toThrow(/not an issued materialization/u);
    cleanup(prepared);
  });

  it("does not let one path_graph capability authorize two issued graphs", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const leftReceipts = [osfReceipt("eu-a")];
    const rightReceipts = [osfReceipt("eu-b")];
    const leftPayload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: leftReceipts
    });
    const rightPayload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: rightReceipts
    });
    const left = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: leftPayload.graph,
        receipts: leftReceipts,
        observations: leftPayload.proposition_observations
      })
    });
    const right = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: rightPayload.graph,
        receipts: rightReceipts,
        observations: rightPayload.proposition_observations
      })
    });
    expect(leftPayload.graph.digest).not.toBe(rightPayload.graph.digest);
    expect(left.authority_digest).not.toBe(right.authority_digest);
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: leftPayload.graph,
        receipts: rightReceipts,
        observations: rightPayload.proposition_observations
      })
    })).toThrow(/do not match the issued graph/u);
    cleanup(prepared);
  });

  it("refuses a collapse that is not the bound support observations", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const receipts = [osfReceipt("eu-a")];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    const authority = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      })
    });
    const observation = payload.proposition_observations[0];
    expect(observation?.witness.payload).toEqual({ polarity: "unknown" });
    const forged = collapseSupportedOnly(authority, observation!.candidate_id, "prop.works-at");
    expect(() => issueMeasurementGroupAdmission({
      authority,
      contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
      proposition_schema: PROPOSITION_STATE_MEASUREMENT_CONTRACT.proposition_schema,
      collapse: forged
    })).toThrow(/not bound to issued support observations/u);
    cleanup(prepared);
  });
});

function pathGraphCapability(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>
) {
  const capability = prepared.snapshotReadLease.capabilities.find((bound) =>
    bound.source_owner === PATH_GRAPH_GENERATION_SOURCE_OWNER);
  expect(capability?.view_kind).toBe("captured");
  return capability!;
}

function supportEvidence(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>,
  capability: ReturnType<typeof pathGraphCapability>,
  source: Readonly<{
    readonly graph: ReturnType<typeof materializeSupportFromReceipts>["graph"];
    readonly receipts: readonly SupportCandidateReceiptV1[];
    readonly observations: ReturnType<typeof materializeSupportFromReceipts>["proposition_observations"];
  }>
) {
  return {
    workspace_id: "workspace-1",
    query_condition: prepared.queryCondition,
    canonical_query_evidence: prepared.canonicalQueryEvidence,
    canonical_query_compilation: prepared.canonicalQueryCompilation,
    snapshot_vector: prepared.snapshotVector,
    snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
    snapshot_read_lease: prepared.snapshotReadLease,
    support_source_capability: capability,
    support_graph: source.graph,
    support_source_receipts: source.receipts,
    support_observations: source.observations
  };
}

function osfReceipt(evidenceId: string): SupportCandidateReceiptV1 {
  return {
    candidate_key: "workspace_local:memory_entry:cand-1",
    hypothesis_digest: `sha256:${"1".repeat(64)}`,
    osf: {
      composition_status: "composed",
      truncated: false,
      bindings: [{
        variable_id: "x",
        binding_identity: "arg.person",
        semantic_identity: "person.alice",
        evidence_id: evidenceId,
        query_proposition_id: "prop.works-at"
      }]
    },
    evidence_ids: [evidenceId]
  };
}

function collapseSupportedOnly(
  authority: ReturnType<typeof verifySupportMeasurementPreparedAuthorityV1>,
  candidateId: string,
  propositionId: string
) {
  const witness = createFourValuedWitness({
    identity: {
      coordinate_id: `measure:${propositionId}`,
      query_id: authority.query_id,
      snapshot_digest: authority.snapshot_digest,
      candidate_id: candidateId,
      proposition_id: propositionId
    },
    provenance: [{ source_id: "eu-a", producer: "support.osf.grounds.v1" }],
    epistemic: { kind: "exact" },
    payload: { polarity: "supported_only" }
  });
  return {
    status: "collapsed" as const,
    contract: PROPOSITION_STATE_MEASUREMENT_CONTRACT,
    witness
  };
}
