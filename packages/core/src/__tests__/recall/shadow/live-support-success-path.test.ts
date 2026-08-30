import { describe, expect, it, vi } from "vitest";
import { fineAssess } from "../../../recall/delivery/fine-assessment.js";
import { buildFineAssessParams } from
  "../../../recall/runtime/orchestration/recall-fine-assessment.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../recall/runtime/recall-service-runner-types.js";
import { withFineDeliveryPath } from "../recall-service-test-fixtures.js";
import {
  compositionForValues,
  evidenceCandidate,
  fieldCandidates
} from "./canonical-delivery-fixtures.js";
import {
  authorityFrom,
  captured,
  capturedLexicalPreparedAuthority,
  capturedPathGraphPreparedAuthority,
  cleanup,
  diagnostics,
  legalSupportReceipts,
  lexicalPin,
  params,
  preparedAuthority,
  supplementary,
  supportReceipts,
  withoutPsi
} from "./live-receipt-fixtures.js";

describe("live support success path", () => {
  it("observes Card-09-legal receipts when path_graph generation is captured", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await capturedPathGraphPreparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: legalSupportReceipts()
    });
    const trace = captured(observed.shadowTrace);
    const shadow = diagnostics(trace);

    expect(pathGraphView(prepared)).toBe("captured");
    expect(shadow.producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "observed"
    });
    expect(shadow.support_graph_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(shadow.support_outcome_digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(withoutPsi(trace)).toEqual(withoutPsi(captured(base.shadowTrace)));
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("keeps legal receipts unavailable when prepare leaves path_graph unavailable", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await preparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: legalSupportReceipts()
    });
    const shadow = diagnostics(captured(observed.shadowTrace));

    expect(pathGraphView(prepared)).toBe("unavailable");
    expect(shadow.producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "producer_unavailable",
      reason: "source_unavailable"
    });
    expect(shadow.producer_outcomes).not.toContainEqual(expect.objectContaining({
      producer_id: "support",
      status: "observed"
    }));
    expect(shadow.support_graph_digest).toBeNull();
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("does not treat a captured lexical source as path_graph support", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const prepared = await capturedLexicalPreparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: legalSupportReceipts()
    });
    const shadow = diagnostics(captured(observed.shadowTrace));

    expect(pathGraphView(prepared)).toBe("unavailable");
    expect(shadow.producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "producer_unavailable",
      reason: "source_unavailable"
    });
    expect(shadow.support_graph_digest).toBeNull();
    cleanup(prepared);
  });

  it("rejects injected metadata-only receipts even when path_graph is captured", async () => {
    const candidates = fieldCandidates(["cand-a", "cand-b"]);
    const base = fineAssess(params(candidates));
    const prepared = await capturedPathGraphPreparedAuthority();
    const observed = fineAssess({
      ...params(candidates),
      queryProofAuthority: authorityFrom(prepared),
      supportCandidateReceipts: supportReceipts()
    });
    const shadow = diagnostics(captured(observed.shadowTrace));

    expect(shadow.producer_outcomes).toContainEqual({
      producer_id: "support",
      status: "malformed",
      contract_code: "producer_contract_invalid"
    });
    expect(shadow.support_graph_digest).toBeNull();
    expect(observed.candidates).toEqual(base.candidates);
    expect(observed.capture_receipt).toEqual(base.capture_receipt);
    cleanup(prepared);
  });

  it("omits live OSF metadata so orchestration stays not_observed, not malformed", async () => {
    const candidates = [evidenceCandidate("cand-a", "evidence-a")];
    const prepared = await preparedAuthority();
    const built = buildFineAssessParams(
      { warn: vi.fn() } as unknown as RecallExecutionContext,
      { workspaceId: "workspace-1" } as unknown as RecallExecutionParams,
      {
        ...prepared,
        retrievalFieldBundle: {
          memoryKeywordLanes: () => [],
          memoryLexicalCaptures: () => [],
          memoryLexicalRequestPins: () => [lexicalPin()]
        }
      } as unknown as PreparedRecallRequest,
      {
        ...supplementary(candidates),
        openSemanticFactorComposition: compositionForValues()
      },
      candidates
    );

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
});

function pathGraphView(prepared: PreparedRecallRequest): string | undefined {
  return prepared.snapshotReadLease.capabilities.find((capability) =>
    capability.source_owner === "path_graph_generation")?.view_kind;
}
