import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorFormation } from
  "../../../../../semantic/open-semantic-factor-formation.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../../recall/field/open-semantic-factors/composition.js";
import {
  issueMeasurementGroupAdmission,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  verifySupportMeasurementPreparedAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import {
  PATH_GRAPH_GENERATION_SOURCE_OWNER
} from "../../../../../recall/decision/query-proof/measurement/support-source-admission.js";
import {
  projectLiveSupportOsf
} from "../../../../../recall/decision/query-proof/support/live-support-receipts.js";
import {
  createSupportHypergraph,
  materializeSupportFromReceipts,
  type SupportCandidateReceiptV1
} from "../../../../../recall/decision/query-proof/support/index.js";
import { createFourValuedWitness } from "../../../../../recall/decision/query-proof/witness/index.js";
import { compileCanonicalQueryCompilation } from
  "../../../../../recall/query/canonical-query/index.js";
import { compileRecallAnswerShapePlan } from
  "../../../../../recall/query/recall-answer-shape-plan.js";
import { compileRecallQueryDemand } from
  "../../../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import {
  capturedPathGraphPreparedAuthority,
  cleanup
} from "../../../integration/shadow/live-receipt-fixtures.js";

describe("support measurement source binding", () => {
  it("rejects self-reported hashes and unissued graphs", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const source = graduationComposition("BA degree");
    const receipts = [projectedReceipt(source.composition)];
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
      }, source)
    })).toThrow(/not an issued materialization/u);
    cleanup(prepared);
  });

  it("rejects invented OSF without a composition receipt", async () => {
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
    const { osf_composition: _c, osf_composition_trace: _t, osf_query_capture: _q,
      ...withoutComposition } = supportEvidence(prepared, capability, {
      graph: payload.graph,
      receipts,
      observations: payload.proposition_observations
    }, graduationComposition("BA degree"));
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: withoutComposition as Parameters<
        typeof verifySupportMeasurementPreparedAuthorityV1
      >[0]["evidence"]
    })).toThrow(/composition receipt/u);
    cleanup(prepared);
  });

  it("rejects a composition bound to another query capture", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const source = graduationComposition("BA degree");
    const receipts = [projectedReceipt(source.composition)];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(prepared, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    })).toThrow(/current query capture/u);
    cleanup(prepared);
  });

  it("rejects a foreign capture relabeled as canonical query evidence", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const foreignQuery = "What degree did I graduate with?";
    const source = graduationComposition("BA degree");
    const probes = compileRecallQueryProbes(foreignQuery);
    expect(prepared.queryCondition.condition.query_task_factors[0]).not.toBe(foreignQuery);
    const canonicalQueryEvidence = Object.freeze({
      ...prepared.canonicalQueryEvidence,
      probes,
      demand: compileRecallQueryDemand(probes),
      shape: compileRecallAnswerShapePlan(probes),
      osfCapture: source.query_capture
    });
    const relabeled = Object.freeze({
      ...prepared,
      canonicalQueryEvidence,
      canonicalQueryCompilation: compileCanonicalQueryCompilation(
        canonicalQueryEvidence,
        prepared.snapshotCoherenceReceipt
      )
    });
    const receipts = [projectedReceipt(source.composition)];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(relabeled, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    })).toThrow(/current query capture/u);
    cleanup(prepared);
  });

  it("rejects receipt OSF that does not match the composition receipt", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const bound = bindPreparedQueryCapture(prepared);
    const source = currentQueryComposition(bound, "I implemented recall with a BA degree.");
    const receipts = [osfReceipt("eu-forged")];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(bound, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    })).toThrow(/not a projection of the composition receipt/u);
    cleanup(prepared);
  });

  it("does not let invented graphs under one capability authorize", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const source = graduationComposition("BA degree");
    for (const evidenceId of ["eu-a", "eu-b"] as const) {
      const receipts = [osfReceipt(evidenceId)];
      const payload = materializeSupportFromReceipts({
        query_id: queryId,
        snapshot_digest: snapshot,
        candidates: receipts
      });
      expect(() => verifySupportMeasurementPreparedAuthorityV1({
        evidence: supportEvidence(prepared, capability, {
          graph: payload.graph,
          receipts,
          observations: payload.proposition_observations
        }, source)
      })).toThrow(/current query capture/u);
    }
    cleanup(prepared);
  });

  it("lets a composition bound to the current query capture verify", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const bound = bindPreparedQueryCapture(prepared);
    const source = currentQueryComposition(bound, "I implemented recall with a BA degree.");
    const receipts = [projectedReceipt(source.composition)];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    const authority = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(bound, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    });
    expect(source.composition.query_capture_digest).toBe(
      bound.canonicalQueryEvidence.osfCapture?.capture_digest);
    expect(authority.query_id).toBe(queryId);
    cleanup(prepared);
  });

  it("refuses a collapse that is not the bound support observations", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const queryId = prepared.canonicalQueryCompilation.query_identity.condition_identity;
    const snapshot = prepared.snapshotVector.vector_digest;
    const bound = bindPreparedQueryCapture(prepared);
    const source = currentQueryComposition(bound, "I implemented recall with a BA degree.");
    const receipts = [projectedReceipt(source.composition)];
    const payload = materializeSupportFromReceipts({
      query_id: queryId,
      snapshot_digest: snapshot,
      candidates: receipts
    });
    const authority = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(bound, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    });
    const observation = payload.proposition_observations[0];
    const forged = collapseSupportedOnly(
      authority,
      observation?.candidate_id ?? "workspace_local:memory_entry:cand-1",
      observation?.local_proposition_id ?? "prop.works-at");
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
  }>,
  composition: ReturnType<typeof graduationComposition>
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
    support_observations: source.observations,
    osf_composition: composition.composition,
    osf_composition_trace: composition.trace,
    osf_query_capture: composition.query_capture,
    osf_evidence_formations: composition.evidence_formations
  };
}

function bindPreparedQueryCapture(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>
) {
  const queryText = prepared.canonicalQueryEvidence.probes.normalized_query;
  if (queryText === null || queryText.length === 0) {
    throw new Error("prepared authority has no query text");
  }
  const query_capture = formation("query", queryText, [
    factor("predicate", "implement", "implement"),
    factor("person", "I", "i")
  ], [{ variable_id: "answer", surface: queryText }], ["answer"], [
    argument(0, "agent", "factor", "person"),
    argument(1, "obtained", "variable", "answer")
  ]);
  const canonicalQueryEvidence = Object.freeze({
    ...prepared.canonicalQueryEvidence,
    osfCapture: query_capture
  });
  return Object.freeze({
    ...prepared,
    canonicalQueryEvidence,
    canonicalQueryCompilation: compileCanonicalQueryCompilation(
      canonicalQueryEvidence,
      prepared.snapshotCoherenceReceipt
    )
  });
}

function currentQueryComposition(
  prepared: Awaited<ReturnType<typeof capturedPathGraphPreparedAuthority>>,
  evidenceText: string
) {
  const query_capture = prepared.canonicalQueryEvidence.osfCapture;
  if (query_capture == null || !("capture_digest" in query_capture) ||
      !("operator_id" in query_capture)) {
    throw new Error("prepared authority has no OSF query capture");
  }
  return compositionFromQueryCapture(
    query_capture as ReturnType<typeof formation>,
    evidenceText
  );
}

function graduationComposition(degree: "BA degree" | "MA degree") {
  const query_capture = formation("query", "What degree did I graduate with?", [
    factor("predicate", "graduate", "graduate"),
    factor("person", "I", "i")
  ], [{ variable_id: "answer", surface: "What degree" }], ["answer"], [
    argument(0, "agent", "factor", "person"),
    argument(1, "obtained", "variable", "answer")
  ]);
  return compositionFromQueryCapture(query_capture, `I graduated with a ${degree}.`);
}

function compositionFromQueryCapture(
  query_capture: ReturnType<typeof formation>,
  evidenceText: string
) {
  const evidence = formation("evidence", evidenceText, [
    factor("predicate", "graduated", "graduate"),
    factor("person", "I", "i"),
    factor("degree", evidenceText, evidenceText.toLowerCase())
  ], [], [], [
    argument(0, "person", "factor", "person"),
    argument(1, "credential", "factor", "degree")
  ]);
  const trace = materializeOpenSemanticFactorCompatibilityTrace({
    query_capture,
    evidence_formations: { gold: evidence }
  });
  const composition = materializeOpenSemanticFactorComposition({
    trace,
    query_capture,
    evidence_formations: { gold: evidence }
  });
  return {
    composition,
    trace,
    query_capture,
    evidence_formations: Object.freeze({ gold: evidence })
  };
}

function projectedReceipt(
  composition: ReturnType<typeof graduationComposition>["composition"]
): SupportCandidateReceiptV1 {
  const evidence_ids = ["gold"];
  const osf = projectLiveSupportOsf(composition, evidence_ids);
  if (osf === undefined) throw new Error("expected OSF projection from composition");
  return {
    candidate_key: "workspace_local:memory_entry:cand-1",
    hypothesis_digest: `sha256:${"1".repeat(64)}`,
    osf,
    evidence_ids
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

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  factors: unknown[],
  variables: unknown[],
  resultVariableIds: string[],
  argumentsValue: unknown[]
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: "open-factor-result-slot-test-v1",
      source_text: sourceText,
      graph: {
        schema_version: 2,
        source_kind: sourceKind,
        factors,
        variables,
        result_variable_ids: resultVariableIds,
        propositions: [{
          proposition_id: "graduation",
          predicate_factor_id: "predicate",
          arguments: argumentsValue
        }]
      }
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
