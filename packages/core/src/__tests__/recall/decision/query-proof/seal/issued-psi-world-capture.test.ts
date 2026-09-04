import { describe, expect, it } from "vitest";
import { digestCanonicalQueryV1 } from
  "../../../../../recall/query/canonical-query/index.js";
import { compileCanonicalQueryCompilation } from
  "../../../../../recall/query/canonical-query/index.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../../recall/field/open-semantic-factors/composition.js";
import {
  verifySupportMeasurementPreparedAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import {
  PATH_GRAPH_GENERATION_SOURCE_OWNER
} from "../../../../../recall/decision/query-proof/measurement/support-source-admission.js";
import {
  materializeSupportFromReceipts,
  type SupportCandidateReceiptV1
} from "../../../../../recall/decision/query-proof/support/index.js";
import { projectLiveSupportOsf } from
  "../../../../../recall/decision/query-proof/support/live-support-receipts.js";
import { issuePsiV2AuthorityArtifact } from
  "../../../../../recall/decision/query-proof/dominance/authority.js";
import {
  captureSourceOwnedQueryProofDecideWorld
} from "../../../../../recall/decision/query-proof/seal/world-capture.js";
import { emptyWalkUtility } from
  "../../../../../recall/decision/query-proof/seal/decide.js";
import {
  isCapturedWalk,
  readCapturedWalkRuntimeManifest,
  walkShadowCapture
} from "../../../../../recall/decision/prefix-capture/walk.js";
import {
  authorityFrom,
  capturedPathGraphPreparedAuthority,
  certifiedScalarAuthority,
  cleanup
} from "../../../integration/shadow/live-receipt-fixtures.js";

const CAND_1 = "workspace_local:memory_entry:cand-1";
const CAND_2 = "workspace_local:memory_entry:cand-2";

describe("source-owned Decide_Q world follows issued Psi-v2, not live Psi", () => {
  it("keeps live walk Psi distinct from the target world Psi-v2 edges", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    try {
      const bound = bindScalarPreparedQueryCapture(prepared);
      const capability = pathGraphCapability(bound);
      const source = scalarCurrentQueryComposition(bound);
      const query = bound.canonicalQueryCompilation.hypotheses[0];
      if (query === undefined) throw new Error("expected one canonical query hypothesis");
      const receipt = Object.freeze({
        ...projectedReceipt(source.composition),
        hypothesis_digest: digestCanonicalQueryV1(query)
      });
      const payload = materializeSupportFromReceipts({
        query_id: bound.canonicalQueryCompilation.query_identity.condition_identity,
        snapshot_digest: bound.snapshotVector.vector_digest,
        candidates: [receipt]
      });
      const measurementAuthority = verifySupportMeasurementPreparedAuthorityV1({
        evidence: {
          workspace_id: "workspace-1",
          query_condition: bound.queryCondition,
          canonical_query_evidence: bound.canonicalQueryEvidence,
          canonical_query_compilation: bound.canonicalQueryCompilation,
          snapshot_vector: bound.snapshotVector,
          snapshot_coherence_receipt: bound.snapshotCoherenceReceipt,
          snapshot_read_lease: bound.snapshotReadLease,
          support_source_capability: capability,
          support_graph: payload.graph,
          support_source_receipts: [receipt],
          support_observations: payload.proposition_observations,
          osf_composition: source.composition,
          osf_composition_trace: source.trace,
          osf_query_capture: source.query_capture,
          osf_evidence_formations: source.evidence_formations
        }
      });
      const walkCandidates = [
        walkCandidate(CAND_1),
        walkCandidate(CAND_2)
      ];
      const liveWalk = walkShadowCapture({
        candidates: walkCandidates,
        psi: (left, right) => left === CAND_1 && right === CAND_2,
        token_budget: 10,
        per_dimension_limits: null
      });
      if (!isCapturedWalk(liveWalk)) throw new Error("expected captured live walk");
      const liveManifest = readCapturedWalkRuntimeManifest(liveWalk);
      expect(liveManifest?.psi_edges).toEqual([[CAND_1, CAND_2]]);

      const issued = issuePsiV2AuthorityArtifact({
        query_digest: digestCanonicalQueryV1(query),
        snapshot_digest: bound.snapshotVector.vector_digest,
        workspace_id: "workspace-1",
        candidates: [
          { candidate_id: CAND_1, coordinates: Object.freeze([]) },
          { candidate_id: CAND_2, coordinates: Object.freeze([]) }
        ],
        current_authorities: [measurementAuthority]
      });
      expect(issued.psi_edges).not.toEqual(liveManifest?.psi_edges);
      expect(() => captureSourceOwnedQueryProofDecideWorld({
        live_authority: authorityFrom(bound),
        support_measurement_authority: measurementAuthority,
        walk: liveWalk,
        psi_v2_authority: issued
      })).toThrow(/scalar_simple_source_unproved/u);
    } finally {
      cleanup(prepared);
    }
  });
});

function walkCandidate(key: string) {
  return Object.freeze({
    candidate_key: key,
    object_key: key,
    token_cost: 1,
    dimension: "mem",
    h_eligible: true,
    utility: emptyWalkUtility(key, key),
    static_frontier_index: null
  });
}

function pathGraphCapability(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>
) {
  const capability = prepared.snapshotReadLease.capabilities.find((bound) =>
    bound.source_owner === PATH_GRAPH_GENERATION_SOURCE_OWNER);
  if (capability === undefined) throw new Error("path graph capability missing");
  return capability;
}

function bindScalarPreparedQueryCapture(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>
) {
  const scalar = certifiedScalarAuthority(prepared);
  const queryText = scalar.canonical_query_evidence.probes.normalized_query;
  if (queryText === null || queryText.length === 0) {
    throw new Error("prepared authority has no query text");
  }
  const predicateSurface = queryText.slice(0, 1);
  const variableSurface = queryText.slice(1);
  if (variableSurface.length === 0) throw new Error("query text is too short for OSF capture");
  const queryCapture = materializeOpenSemanticFactorFormation({
    source_kind: "query",
    source_text: queryText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "query-proof-source-test-v1",
      source_text: queryText,
      graph: {
        schema_version: 2,
        source_kind: "query",
        factors: [{
          factor_id: "predicate",
          surface: predicateSurface,
          semantic_identity: "buy",
          source_occurrence: 0
        }],
        variables: [{
          variable_id: "x0",
          surface: variableSurface,
          source_occurrence: 0
        }],
        result_variable_ids: ["x0"],
        propositions: [{
          proposition_id: "shape_rel_0",
          predicate_factor_id: "predicate",
          arguments: [{
            position: 0,
            binding_identity: "location",
            reference_kind: "variable",
            reference_id: "x0"
          }]
        }]
      }
    }
  });
  const canonicalQueryEvidence = Object.freeze({
    ...scalar.canonical_query_evidence,
    osfCapture: queryCapture
  });
  const snapshotCoherenceReceipt = scalar.snapshot_coherence_receipt;
  return Object.freeze({
    ...prepared,
    canonicalQueryEvidence,
    canonicalQueryCompilation: compileCanonicalQueryCompilation(
      canonicalQueryEvidence,
      snapshotCoherenceReceipt
    ),
    snapshotVector: scalar.snapshot_vector,
    snapshotCoherenceReceipt,
    snapshotReadLease: scalar.snapshot_read_lease
  });
}

function scalarCurrentQueryComposition(
  prepared: ReturnType<typeof bindScalarPreparedQueryCapture>
) {
  const queryCapture = prepared.canonicalQueryEvidence.osfCapture;
  if (queryCapture == null || !("capture_digest" in queryCapture) ||
      !("operator_id" in queryCapture)) {
    throw new Error("prepared authority has no OSF query capture");
  }
  const evidenceText = "I bought it in Paris.";
  const evidence = materializeOpenSemanticFactorFormation({
    source_kind: "evidence",
    source_text: evidenceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "query-proof-source-test-v1",
      source_text: evidenceText,
      graph: {
        schema_version: 2,
        source_kind: "evidence",
        factors: [{
          factor_id: "predicate",
          surface: "bought",
          semantic_identity: "buy",
          source_occurrence: 0
        }, {
          factor_id: "place",
          surface: "Paris",
          semantic_identity: "x0",
          source_occurrence: 0
        }],
        variables: [],
        result_variable_ids: [],
        propositions: [{
          proposition_id: "buy-evidence",
          predicate_factor_id: "predicate",
          arguments: [{
            position: 0,
            binding_identity: "location",
            reference_kind: "factor",
            reference_id: "place"
          }]
        }]
      }
    }
  });
  const trace = materializeOpenSemanticFactorCompatibilityTrace({
    query_capture: queryCapture,
    evidence_formations: { gold: evidence }
  });
  const composition = materializeOpenSemanticFactorComposition({
    trace,
    query_capture: queryCapture,
    evidence_formations: { gold: evidence }
  });
  return {
    composition,
    trace,
    query_capture: queryCapture,
    evidence_formations: Object.freeze({ gold: evidence })
  };
}

function projectedReceipt(
  composition: ReturnType<typeof scalarCurrentQueryComposition>["composition"]
): SupportCandidateReceiptV1 {
  const evidence_ids = ["gold"];
  const osf = projectLiveSupportOsf(composition, evidence_ids);
  if (osf === undefined) throw new Error("expected OSF projection from composition");
  return {
    candidate_key: CAND_1,
    hypothesis_digest: `sha256:${"1".repeat(64)}`,
    osf,
    evidence_ids
  };
}
