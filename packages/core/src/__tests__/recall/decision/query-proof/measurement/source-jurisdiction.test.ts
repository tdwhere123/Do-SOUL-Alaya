import { describe, expect, it } from "vitest";
import { fineAssess } from "../../../../../recall/delivery/fine-assessment.js";
import {
  issueMeasurementGroupAdmission,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  PROPOSITION_STATE_MEASUREMENT_CONTRACT,
  verifySupportMeasurementPreparedAuthorityV1
} from "../../../../../recall/decision/query-proof/measurement/index.js";
import { PATH_GRAPH_GENERATION_SOURCE_OWNER } from
  "../../../../../recall/decision/query-proof/measurement/support-source-admission.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../../recall/decision/query-proof/measurement/lexical-interval-envelope.js";
import { psiV2CandidateFromLexicalEnvelope } from
  "../../../../../recall/decision/query-proof/dominance/index.js";
import { materializeSupportFromReceipts } from
  "../../../../../recall/decision/query-proof/support/index.js";
import { fieldCandidates } from "../../../delivery/canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  capturedPathGraphPreparedAuthority,
  cleanup,
  diagnostics,
  legalSupportReceipts,
  params,
  preparedAuthority
} from "../../../integration/shadow/live-receipt-fixtures.js";
import {
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "./prepared-authority-fixture.js";

describe("measurement source jurisdiction", () => {
  it("binds lexical admission to query, candidate, workspace, principal, snapshot, and source", async () => {
    const prepared = await prepareMeasurementEvidenceFixture();
    try {
      await withCapturedLexicalMeasurementAuthorityFixture(
        prepared,
        [{ candidate_key: "cand-1", normalized_rank: 1 }],
        (authority, source) => {
          if (source.status !== "captured") throw new Error("captured source expected");
          const key = "workspace_local:memory_entry:cand-1";
          const envelope = lexicalIntervalSourceEnvelopes(source, key);
          const coordinate = psiV2CandidateFromLexicalEnvelope(key, envelope, authority)
            .coordinates[0]!;
          expect(coordinate.admission).toMatchObject({
            query_id: authority.query_id,
            snapshot_digest: authority.snapshot_digest,
            workspace_id: authority.workspace_id,
            principal: authority.principal,
            candidate_id: key,
            hypothesis_digest: null,
            jurisdiction: "lexical_relaxed",
            producer_outcome: "observed"
          });
          expect(coordinate.admission?.source_binding_digest).toMatch(/^sha256:/u);
          expect(authority.principal).toBe(prepared.snapshotVector.principal);
        }
      );
    } finally {
      releaseMeasurementEvidenceFixture(prepared);
    }
  });

  it("rejects support evidence when path_graph capability is unavailable", async () => {
    const prepared = await preparedAuthority();
    const capability = prepared.snapshotReadLease.capabilities.find((bound) =>
      bound.source_owner === PATH_GRAPH_GENERATION_SOURCE_OWNER);
    expect(capability?.view_kind).toBe("unavailable");
    const payload = materializeSupportFromReceipts({
      query_id: prepared.canonicalQueryCompilation.query_identity.condition_identity,
      snapshot_digest: prepared.snapshotVector.vector_digest,
      candidates: legalSupportReceipts()
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: {
        workspace_id: "workspace-1",
        query_condition: prepared.queryCondition,
        canonical_query_evidence: prepared.canonicalQueryEvidence,
        canonical_query_compilation: prepared.canonicalQueryCompilation,
        snapshot_vector: prepared.snapshotVector,
        snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
        snapshot_read_lease: prepared.snapshotReadLease,
        support_source_capability: capability!,
        support_graph: payload.graph,
        support_source_receipts: legalSupportReceipts(),
        support_observations: payload.proposition_observations,
        osf_composition: undefined as never,
        osf_composition_trace: undefined as never,
        osf_query_capture: undefined as never
      }
    })).toThrow(/source identity mismatch/u);
    cleanup(prepared);
  });

  it("keeps shape-valid live support unavailable on the default lease", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: legalSupportReceipts()
    });
    expect(diagnostics(captured(observed.shadowTrace)).producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "producer_unavailable",
      reason: "source_unavailable"
    });
    expect(diagnostics(captured(observed.shadowTrace)).producer_outcomes)
      .not.toContainEqual(expect.objectContaining({
        producer_id: "support",
        status: "observed"
      }));
    cleanup(prepared);
  });

  it("rejects a captured lexical capability used as the support source owner", async () => {
    const prepared = await capturedPathGraphPreparedAuthority();
    const lexical = prepared.snapshotReadLease.capabilities.find((bound) =>
      bound.source_owner === "lexical_relaxed");
    expect(lexical).toBeDefined();
    const payload = materializeSupportFromReceipts({
      query_id: prepared.canonicalQueryCompilation.query_identity.condition_identity,
      snapshot_digest: prepared.snapshotVector.vector_digest,
      candidates: legalSupportReceipts()
    });
    expect(() => verifySupportMeasurementPreparedAuthorityV1({
      evidence: {
        workspace_id: "workspace-1",
        query_condition: prepared.queryCondition,
        canonical_query_evidence: prepared.canonicalQueryEvidence,
        canonical_query_compilation: prepared.canonicalQueryCompilation,
        snapshot_vector: prepared.snapshotVector,
        snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
        snapshot_read_lease: prepared.snapshotReadLease,
        support_source_capability: lexical!,
        support_graph: payload.graph,
        support_source_receipts: legalSupportReceipts(),
        support_observations: payload.proposition_observations,
        osf_composition: undefined as never,
        osf_composition_trace: undefined as never,
        osf_query_capture: undefined as never
      }
    })).toThrow(/source identity mismatch/u);
    cleanup(prepared);
  });

  it("fails closed when issued lexical source bytes are swapped after capture", async () => {
    const prepared = await prepareMeasurementEvidenceFixture();
    try {
      await withCapturedLexicalMeasurementAuthorityFixture(
        prepared,
        [{ candidate_key: "cand-1", normalized_rank: 1 }],
        (authority, source) => {
          if (source.status !== "captured") throw new Error("captured source expected");
          const key = "workspace_local:memory_entry:cand-1";
          const envelope = lexicalIntervalSourceEnvelopes(source, key);
          const coordinate = psiV2CandidateFromLexicalEnvelope(key, envelope, authority)
            .coordinates[0]!;
          if (coordinate.collapse.status !== "collapsed" || coordinate.admission === null) {
            throw new Error("admitted lexical coordinate expected");
          }
          const swapped = Object.defineProperty({ ...envelope }, "primary", {
            enumerable: true,
            get: () => {
              throw new Error("planted envelope getter");
            }
          });
          expect(() => issueMeasurementGroupAdmission({
            authority,
            contract: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
            proposition_schema: LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema,
            collapse: coordinate.collapse,
            lexical_source: {
              envelope: swapped as typeof envelope,
              lex_domain: envelope.primary!.domain,
              envelope_identity: envelope.identity!
            }
          })).toThrow();
          expect(coordinate.admission.producer_outcome).toBe("observed");
          expect(PROPOSITION_STATE_MEASUREMENT_CONTRACT).not.toBe(
            LEXICAL_INTERVAL_MEASUREMENT_CONTRACT);
        }
      );
    } finally {
      releaseMeasurementEvidenceFixture(prepared);
    }
  });
});
