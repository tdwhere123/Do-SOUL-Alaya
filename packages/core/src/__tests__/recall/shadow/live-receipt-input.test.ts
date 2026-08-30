import { describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { buildFineAssessParams } from
  "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../recall/runtime/recall-service-runner-types.js";
import type { SupportCandidateReceiptV1 } from
  "../../../recall/shadow/support/index.js";
import { absentLexicalBoundProof } from
  "../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import { evidenceCandidate, fieldCandidates } from "./canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  cleanup,
  diagnostics,
  keyOf,
  lexicalPin,
  lexicalProof,
  params,
  policyOf,
  preparedAuthority,
  supplementary,
  supportReceipts,
  withoutPsi
} from "./live-receipt-fixtures.js";

describe("live Band 1 receipt input", () => {
  it("rejects metadata-only support instead of treating it as a proposition", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)],
      supportCandidateReceipts: supportReceipts()
    });
    const baseTrace = captured(base.shadowTrace);
    const observedTrace = captured(observed.shadowTrace);

    expect(baseTrace.psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      producer_outcomes: [
        { producer_id: "lex.interval", status: "not_observed", reason: "input_absent" },
        { producer_id: "support", status: "not_observed", reason: "input_absent" }
      ]
    });
    expect(observedTrace.psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        {
          producer_id: "lex.interval",
          status: "not_observed",
          reason: "applicable_receipt_absent"
        },
        {
          producer_id: "support",
          status: "malformed",
          contract_code: "producer_contract_invalid"
        }
      ]
    });
    expect("support_graph_digest" in observedTrace.psi_v2_shadow &&
      observedTrace.psi_v2_shadow.support_graph_digest).toBeNull();
    expect(withoutPsi(observedTrace)).toEqual(withoutPsi(baseTrace));
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("keeps absent receipts not_observed and legacy delivery unchanged", () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const withoutCapture = fineAssess(params(fieldCandidates(["cand-a", "cand-b"]), "legacy"));
      const withCapture = fineAssess({
        ...params(fieldCandidates(["cand-a", "cand-b"]), "legacy"),
        captureShadowTrace: true
      });
      expect(captured(withCapture.shadowTrace).psi_v2_shadow).toMatchObject({
        observation_status: "not_observed",
        producer_outcomes: [
          { producer_id: "lex.interval", status: "not_observed" },
          { producer_id: "support", status: "not_observed" }
        ]
      });
      expect(withCapture.candidates).toEqual(withoutCapture.candidates);
      expect(withCapture.ranking_authority).toBe("select_gamma");
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("does not admit a planted legacy proof as live lexical authority", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)]
    });

    expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      producer_outcomes: [
        {
          producer_id: "lex.interval",
          status: "not_observed",
          reason: "applicable_receipt_absent"
        },
        {
          producer_id: "support",
          status: "not_observed",
          reason: "applicable_receipt_absent"
        }
      ]
    });
    cleanup(prepared);
  });

  it("exposes planted live receipts on the legacy shadow capture without changing selection", async () => {
    process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY = "1";
    try {
      const candidates = fieldCandidates(["cand-a", "cand-b"]);
      const base = fineAssess(params(candidates, "legacy"));
      const prepared = await preparedAuthority();
      const observed = fineAssess({
        ...params(candidates, "legacy"),
        captureShadowTrace: true,
        queryProofAuthority: authorityFrom(prepared),
        lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)],
        supportCandidateReceipts: supportReceipts()
      });
      expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
        observation_status: "malformed",
        producer_outcomes: expect.arrayContaining([{
          producer_id: "support",
          status: "malformed",
          contract_code: "producer_contract_invalid"
        }])
      });
      expect(observed.candidates).toEqual(base.candidates);
      expect(observed.ranking_authority).toBe("select_gamma");
      cleanup(prepared);
    } finally {
      delete process.env.ALAYA_RECALL_ALLOW_LEGACY_DELIVERY;
    }
  });

  it("rejects support receipts outside the live candidate identity universe", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await preparedAuthority();
    const tampered = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: [{
        candidate_key: keyOf("not-in-field"),
        evidence_ids: ["evidence-trap"]
      }]
    });

    expect(captured(tampered.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      support_graph_digest: null,
      producer_outcomes: expect.arrayContaining([{
        producer_id: "support",
        status: "malformed",
        contract_code: "foreign_candidate_receipt"
      }])
    });
    expect(tampered.candidates).toEqual(base.candidates);
    expect(tampered.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("makes a prepared workspace mismatch unavailable without changing delivery", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const mismatched = fineAssess({
      ...params(candidates),
      workspace_id: "workspace-other",
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)]
    });

    expect(captured(mismatched.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "lex.interval",
        status: "malformed",
        contract_code: "authority_identity_mismatch"
      }])
    });
    expect(mismatched.candidates).toEqual(base.candidates);
    expect(mismatched.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("preserves typed prepared-authority rejection in producer diagnostics", async () => {
    const prepared = await preparedAuthority();
    const authority = authorityFrom(prepared);
    const rejected = fineAssess({
      ...params(fieldCandidates(["cand-a", "cand-b"])),
      queryProofAuthority: {
        ...authority,
        query_condition: { ...authority.query_condition, identity: "untrusted-marker" }
      },
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.vector_digest)]
    });
    expect(diagnostics(captured(rejected.shadowTrace)).producer_outcomes).toContainEqual({
      producer_id: "lex.interval",
      status: "malformed",
      contract_code: "authority_query_condition_invalid"
    });
    cleanup(prepared);
  });

  it("carries prepared authority without a diagnostic flag while support stays absent", async () => {
    const candidates = [evidenceCandidate("cand-a", "evidence-a")];
    const prepared = await preparedAuthority();
    const built = buildFineAssessParams(
      { warn: vi.fn() } as unknown as RecallExecutionContext,
      {
        workspaceId: "workspace-1"
      } as unknown as RecallExecutionParams,
      {
        ...prepared,
        retrievalFieldBundle: {
          memoryKeywordLanes: () => [],
          memoryLexicalCaptures: () => [],
          memoryLexicalRequestPins: () => [lexicalPin()]
        }
      } as unknown as PreparedRecallRequest,
      supplementary(candidates),
      candidates
    );

    expect(built.queryProofAuthority?.canonical_query_compilation.query_identity
      .condition_identity).toBe(prepared.queryCondition.identity);
    expect(built.queryProofAuthority?.snapshot_vector.vector_digest)
      .toBe(prepared.snapshotVector.vector_digest);
    expect(built.lexicalIntervalSources).toBeUndefined();
    expect(built.supportCandidateReceipts).toBeUndefined();
    expect(captured(fineAssess({
      ...built,
      policy: withFineDeliveryPath(built.policy, "canonical")
    }).shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "not_observed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "support",
        status: "not_observed",
        reason: "applicable_receipt_absent"
      }])
    });
    cleanup(prepared);
  });

  it("does not let a stale legacy proof add lexical authority", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const base = fineAssess(params(candidates));
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.base_store_digest)],
      supportCandidateReceipts: supportReceipts()
    });
    expect(captured(observed.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        {
          producer_id: "lex.interval",
          status: "not_observed",
          reason: "applicable_receipt_absent"
        },
        {
          producer_id: "support",
          status: "malformed",
          contract_code: "producer_contract_invalid"
        }
      ]
    });
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("collapses fabricated legacy proof variants to the same explicit absence", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const common = {
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared)
    };
    const absent = fineAssess(common);
    const unavailable = fineAssess({ ...common, lexicalBoundProofs: [lexicalProof(null)] });
    const malformed = fineAssess({
      ...common,
      lexicalBoundProofs: [lexicalProof(prepared.snapshotVector.base_store_digest)]
    });
    const traces = [absent, unavailable, malformed].map((result) => captured(result.shadowTrace));
    expect(traces.map((trace) => diagnostics(trace).producer_outcomes[0])).toEqual([
      { producer_id: "lex.interval", status: "not_observed",
        reason: "applicable_receipt_absent" },
      { producer_id: "lex.interval", status: "not_observed",
        reason: "applicable_receipt_absent" },
      { producer_id: "lex.interval", status: "not_observed",
        reason: "applicable_receipt_absent" }
    ]);
    expect(new Set(traces.map((trace) => diagnostics(trace).digest))).toHaveLength(1);
    expect(unavailable.candidates).toEqual(absent.candidates);
    expect(malformed.candidates).toEqual(absent.candidates);
    expect(unavailable.capture_receipt).toEqual(absent.capture_receipt);
    expect(malformed.capture_receipt).toEqual(absent.capture_receipt);
    cleanup(prepared);
  });

  it("fails a mixed legacy proof collection closed without observing lexical intervals", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      lexicalBoundProofs: [
        lexicalProof(prepared.snapshotVector.vector_digest),
        absentLexicalBoundProof()
      ]
    });

    expect(captured(result.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: expect.arrayContaining([{
        producer_id: "lex.interval",
        status: "malformed",
        contract_code: "producer_contract_invalid"
      }])
    });
    cleanup(prepared);
  });

  it.each([
    ["duplicate_receipt", () => [supportReceipts()[0]!, supportReceipts()[0]!]],
    ["producer_contract_invalid", () => [{
      candidate_key: keyOf("cand-a"),
      osf: { composition_status: "invalid" }
    }]],
    ["producer_contract_invalid", () => [{
      candidate_key: keyOf("cand-a"),
      osf: {
        composition_status: "composed",
        bindings: [{
          variable_id: "x0",
          binding_identity: "binding.operator",
          semantic_identity: null,
          evidence_id: "evidence-a"
        }]
      }
    }]]
  ] as const)("types support %s failures without erasing lexical absence", async (
    expectedCode,
    receipts
  ) => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await preparedAuthority();
    const result = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: receipts() as unknown as readonly SupportCandidateReceiptV1[]
    });
    expect(captured(result.shadowTrace).psi_v2_shadow).toMatchObject({
      observation_status: "malformed",
      producer_outcomes: [
        {
          producer_id: "lex.interval",
          status: "not_observed",
          reason: "applicable_receipt_absent"
        },
        { producer_id: "support", status: "malformed", contract_code: expectedCode }
      ]
    });
    cleanup(prepared);
  });
});
