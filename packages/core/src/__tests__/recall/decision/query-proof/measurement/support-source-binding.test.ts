import { describe, expect, it } from "vitest";
import { fineAssess } from "../../../../../recall/delivery/fine-assessment.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
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
  captureVerifiedSupportSourceSnapshot,
  PATH_GRAPH_GENERATION_SOURCE_OWNER,
  readVerifiedSupportSourceSnapshot
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
import { digestCanonicalQueryV1 } from
  "../../../../../recall/query/canonical-query/index.js";
import { compileRecallAnswerShapePlan } from
  "../../../../../recall/query/recall-answer-shape-plan.js";
import { compileRecallQueryDemand } from
  "../../../../../recall/query/recall-query-demand.js";
import { compileRecallQueryProbes } from
  "../../../../../recall/query/recall-query-probes.js";
import {
  authorityFrom,
  captured,
  certifiedScalarAuthority,
  capturedPathGraphPreparedAuthority,
  cleanup,
  params
} from "../../../integration/shadow/live-receipt-fixtures.js";
import { evidenceCandidate } from "../../../delivery/canonical-delivery-fixtures.js";
import { SEAL_UNBOUND_HOLE } from
  "../../../../../recall/decision/query-proof/delivery/contract.js";
import { parseCertifiedDeliveryPack } from
  "../../../../../recall/decision/query-proof/delivery/pack.js";

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
      evidence: withoutComposition as unknown as Parameters<
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

  it("keeps the verified support snapshot unforgeable", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const capability = pathGraphCapability(prepared);
    const bound = bindPreparedQueryCapture(prepared);
    const source = currentQueryComposition(bound, "I implemented recall with a BA degree.");
    const receipts = [projectedReceipt(source.composition)];
    const payload = materializeSupportFromReceipts({
      query_id: bound.canonicalQueryCompilation.query_identity.condition_identity,
      snapshot_digest: bound.snapshotVector.vector_digest,
      candidates: receipts
    });
    const authority = verifySupportMeasurementPreparedAuthorityV1({
      evidence: supportEvidence(bound, capability, {
        graph: payload.graph,
        receipts,
        observations: payload.proposition_observations
      }, source)
    });
    const snapshot = captureVerifiedSupportSourceSnapshot(authority);

    expect(snapshot.lease_digest).toBe(
      digestRecallFieldIdentity(prepared.snapshotReadLease));
    expect(readVerifiedSupportSourceSnapshot(snapshot)).not.toBeNull();
    expect(readVerifiedSupportSourceSnapshot(Object.freeze({ ...snapshot }))).toBeNull();
    expect(() => captureVerifiedSupportSourceSnapshot(Object.freeze({
      ...authority
    }) as typeof authority)).toThrow(/authority is unavailable/u);
    cleanup(prepared);
  });

  it("builds a non-empty query-proof preview from the actual walk and support authority", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
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
      evidence: supportEvidence(bound, capability, {
        graph: payload.graph,
        receipts: [receipt],
        observations: payload.proposition_observations
      }, source)
    });
    const candidates = [evidenceCandidate("cand-1", "gold")];
    const input = params(candidates);
    const supplementaryData = Object.freeze({
      ...input.supplementaryData,
      openSemanticFactorComposition: source.composition,
      openSemanticFactorCompatibilityTrace: source.trace,
      queryOpenSemanticFactorFormation: source.query_capture,
      semanticFactorFormationsByEvidenceId: source.evidence_formations
    });
    const base = fineAssess({ ...input, supplementaryData });
    const observed = fineAssess({
      ...input,
      supplementaryData,
      queryProofAuthority: authorityFrom(bound),
      supportCandidateReceipts: [receipt]
    });
    const trace = captured(observed.shadowTrace);

    if (trace.query_proof_preview?.status !== "captured") {
      throw new Error(JSON.stringify({
        preview: trace.query_proof_preview,
        psi: trace.psi_v2_shadow
      }));
    }
    expect(trace.query_proof_preview).toMatchObject({
      status: "captured",
      semantic_feasibility: [{
        candidate_key: "workspace_local:memory_entry:cand-1",
        semantic: "unresolved"
      }]
    });
    expect(trace.query_proof_preview?.S_infty).toEqual([]);
    expect(trace.query_proof_preview?.contract_digest).toMatch(/^sha256:/u);
    expect(trace.query_proof_preview?.prefix).toEqual(
      trace.query_proof_preview?.candidate_prefix);
    expect(trace.delivery_pack.mode).toBe("best_effort_uncertified");
    expect(trace.delivery_pack.mode).not.toBe("certified");
    expect(trace.delivery_pack.holes).toEqual([SEAL_UNBOUND_HOLE]);
    expect(() => parseCertifiedDeliveryPack(trace.delivery_pack)).toThrow(/certified/u);
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    expect(measurementAuthority.query_id).toBe(
      bound.canonicalQueryCompilation.query_identity.condition_identity);
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
          arguments: [argument(0, "location", "variable", "x0")]
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
          arguments: [argument(0, "location", "factor", "place")]
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
